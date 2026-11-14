'use strict';
// The updater: version checks against GitHub (a fake one here), download + checksum, and the Windows / Mac install steps.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upd-'));
process.env.DATA_DIR = DIR; process.env.AIRSPACE = 'off';
const U = require('../updater.js');
const S = require('../server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------- pure helpers ----------
test('versions compare numerically, ignoring a leading v', () => {
  assert.equal(U.compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(U.compareVersions('1.1.0', 'v1.1.0'), 0);
  assert.equal(U.compareVersions('1.0.3', '1.1.0'), -1);
  assert.equal(U.compareVersions('2', '1.9.9'), 1);
  assert.equal(U.compareVersions('1.2.0-beta', '1.2.0'), 0);
});
test('SHA256SUMS lines are read, whatever the spacing or case', () => {
  const h = 'a'.repeat(64), H = 'B'.repeat(64);
  assert.deepEqual(U.parseSums(`${h}  MAVLink-Hub-Windows.zip\n${H} *MAVLink-Hub-Mac.zip\r\nnot a line\n`), { 'MAVLink-Hub-Windows.zip': h, 'MAVLink-Hub-Mac.zip': 'b'.repeat(64) });
});
test('only the downloaded app can update itself, and the reason says what to do otherwise', () => {
  const yes = () => true, no = () => false, fine = () => {}, deny = () => { throw new Error('EACCES'); };
  assert.deepEqual(U.installKind({ platform: 'win32', serverDir: 'C:\\Hub', exists: yes, access: fine }), { kind: 'windows', dir: 'C:\\Hub' });
  assert.match(U.installKind({ platform: 'win32', serverDir: 'C:\\src', exists: no, access: fine }).reason, /downloaded app/);
  assert.match(U.installKind({ platform: 'win32', serverDir: 'C:\\Hub', exists: yes, access: deny }).reason, /read-only/);
  const app = '/Applications/MAVLink Hub.app', dir = app + '/Contents/Resources/app';
  assert.deepEqual(U.installKind({ platform: 'darwin', serverDir: dir, access: fine }), { kind: 'mac', app });
  assert.match(U.installKind({ platform: 'darwin', serverDir: '/Users/x/hub', access: fine }).reason, /downloaded app/);
  assert.match(U.installKind({ platform: 'darwin', serverDir: '/private/var/folders/x/AppTranslocation/ABC/d/MAVLink Hub.app/Contents/Resources/app', access: fine }).reason, /Applications/);
  assert.match(U.installKind({ platform: 'darwin', serverDir: dir, access: deny }).reason, /cannot change/);
  assert.match(U.installKind({ platform: 'linux', serverDir: '/x' }).reason, /Windows and Mac/);
});
test('addresses that are not https are refused', async () => {
  await assert.rejects(U.readText('http://127.0.0.1:1/x'), /not https/);
  await assert.rejects(U.readText('ftp://example.com/x'), /not https/);
});

// ---------- a fake GitHub ----------
let gh, ghUrl, release, zipBytes, sums, hits;
before(async () => {
  zipBytes = crypto.randomBytes(200000);
  gh = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/api') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(release)); }
    if (req.url === '/redirect/zip') { res.writeHead(302, { Location: '/dl/zip' }); return res.end(); }
    if (req.url === '/dl/zip') { res.writeHead(200, { 'Content-Length': zipBytes.length }); return res.end(zipBytes); }
    if (req.url === '/dl/sums') { res.writeHead(200); return res.end(sums); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  ghUrl = `http://127.0.0.1:${gh.address().port}`;
});
after(() => { gh.close(); });
const reset = (tag = 'v9.9.9', over = {}) => {
  hits = {}; sums = `${sha(zipBytes)}  MAVLink-Hub-Windows.zip\n${sha(zipBytes)}  MAVLink-Hub-Mac.zip\n`;
  release = { tag_name: tag, html_url: ghUrl + '/release', body: 'What is new', assets: [
    { name: 'MAVLink-Hub-Windows.zip', browser_download_url: ghUrl + '/redirect/zip' }, { name: 'MAVLink-Hub-Mac.zip', browser_download_url: ghUrl + '/redirect/zip' },
    { name: 'SHA256SUMS.txt', browser_download_url: ghUrl + '/dl/sums' }], ...over };
};
const winDir = () => { const d = fs.mkdtempSync(path.join(DIR, 'win-')); fs.mkdirSync(path.join(d, 'runtime')); fs.writeFileSync(path.join(d, 'runtime', 'node.exe'), ''); return d; };
function make(extra = {}) {
  const log = { quits: 0, spawns: [], changes: 0 };
  const u = U.createUpdater({ version: '1.1.0', dataDir: path.join(DIR, 'data-' + Math.random().toString(36).slice(2)), serverDir: winDir(), platform: 'win32', apiUrl: ghUrl + '/api', allowHttp: true,
    quit: () => { log.quits++; }, onChange: () => { log.changes++; }, pid: 4242, ownerPid: 777,
    spawnFn: (cmd, args, opt) => { log.spawns.push({ cmd, args, opt }); return { on() {}, unref() {} }; }, ...extra });
  return { u, log };
}

test('check: a newer release is reported with its notes; the same or an older one means up to date', async () => {
  reset('v9.9.9'); const { u } = make();
  assert.equal(u.state().status, 'idle');
  const s = await u.check();
  assert.equal(s.status, 'available'); assert.equal(s.latest, '9.9.9'); assert.equal(s.current, '1.1.0'); assert.equal(s.notes, 'What is new'); assert.equal(s.canInstall, true);
  reset('v1.1.0'); assert.equal((await make().u.check()).status, 'uptodate');
  reset('v1.0.3'); assert.equal((await make().u.check()).status, 'uptodate');
});
test('check: an unreachable or nonsense answer is an error that says so, not a crash', async () => {
  const dead = make({ apiUrl: 'http://127.0.0.1:1/api' }).u; const s = await dead.check();
  assert.equal(s.status, 'error'); assert.match(s.error, /Could not check for updates/);
  reset('banana'); assert.match((await make().u.check()).error, /could not read/);
});
test('check: a release without a download for this system cannot be installed, and says why', async () => {
  reset('v9.9.9', { assets: [{ name: 'SHA256SUMS.txt', browser_download_url: ghUrl + '/dl/sums' }] });
  const s = await make().u.check(); assert.equal(s.status, 'available'); assert.equal(s.canInstall, false); assert.match(s.reason, /no download/);
});
test('check: a source checkout is told about the update but offered no install', async () => {
  reset('v9.9.9'); const s = await make({ serverDir: fs.mkdtempSync(path.join(DIR, 'src-')) }).u.check();
  assert.equal(s.status, 'available'); assert.equal(s.canInstall, false); assert.match(s.reason, /downloaded app/);
});

test('Windows install: downloads (through a redirect), checks the checksum, writes the helper, starts it, then stops the hub', async () => {
  reset('v9.9.9'); const { u, log } = make(), dir = u.how.dir;
  await u.check(); await u.install();
  assert.equal(u.state().status, 'restarting');
  assert.equal(log.spawns.length, 1);
  const { cmd, args, opt } = log.spawns[0];
  assert.equal(cmd, 'powershell.exe'); assert.ok(opt.detached && opt.windowsHide);
  const arg = (k) => args[args.indexOf(k) + 1];
  assert.equal(arg('-Dest'), dir); assert.equal(arg('-HubPid'), '4242'); assert.equal(arg('-OwnerPid'), '777');
  assert.ok(fs.readFileSync(arg('-Zip')).equals(zipBytes), 'the verified download is what the helper will unpack');
  assert.equal(fs.readFileSync(arg('-File'), 'utf8'), U.WINDOWS_HELPER);
  assert.match(U.WINDOWS_HELPER, /robocopy/); assert.match(U.WINDOWS_HELPER, /\/XF hub\.env/, 'the user\'s settings file is never overwritten');
  assert.equal(log.quits, 0, 'not yet: the page gets a moment to show it');
  await until(() => log.quits === 1);
});
test('install: a download whose checksum does not match is thrown away and nothing is started', async () => {
  reset('v9.9.9'); sums = `${'0'.repeat(64)}  MAVLink-Hub-Windows.zip\n`;
  const { u, log } = make(); await u.check();
  await assert.rejects(u.install(), /damaged/);
  assert.equal(u.state().status, 'available'); assert.match(u.state().error, /checksum/);
  assert.equal(log.spawns.length, 0); await sleep(1000); assert.equal(log.quits, 0);
});
test('install: no checksum listed for the file means no install; and nothing installs unless an update was found first', async () => {
  reset('v9.9.9'); sums = 'nothing useful\n';
  const { u, log } = make(); await assert.rejects(u.install(), /no update ready/);
  await u.check(); await assert.rejects(u.install(), /no checksum/); assert.equal(log.spawns.length, 0);
});
test('install: while it is downloading the state reports progress, and a second check does nothing', async () => {
  reset('v9.9.9'); const { u } = make(); await u.check();
  const seen = new Set(); const mon = setInterval(() => seen.add(u.state().status), 1); await u.install(); clearInterval(mon);
  assert.ok(seen.has('downloading') || seen.has('installing') || seen.has('restarting'));
});

test('Mac install: the new app is swapped in beside the old one, the old one is kept aside, and the app is told to reopen', async () => {
  reset('v9.9.9');
  const root = fs.mkdtempSync(path.join(DIR, 'mac-')), app = path.join(root, 'MAVLink Hub.app'), res = path.join(app, 'Contents', 'Resources', 'app');
  fs.mkdirSync(res, { recursive: true }); fs.writeFileSync(path.join(res, 'server.js'), 'OLD');
  const marker = path.join(root, 'relaunch');
  const extract = async (zip, dest) => { const f = path.join(dest, 'MAVLink Hub', 'MAVLink Hub.app', 'Contents', 'Resources', 'app'); fs.mkdirSync(f, { recursive: true }); fs.writeFileSync(path.join(f, 'server.js'), 'NEW'); assert.ok(fs.existsSync(zip)); };
  const { u, log } = make({ platform: 'darwin', serverDir: res, extract, marker });
  assert.equal(u.how.kind, 'mac');
  await u.check(); await u.install();
  assert.equal(fs.readFileSync(path.join(res, 'server.js'), 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(marker, 'utf8'), app, 'the app reads this on its way out and opens the new copy');
  const old = fs.readdirSync(root).filter((f) => f.startsWith('MAVLink Hub.app.old-'));
  assert.equal(old.length, 1); assert.equal(fs.readFileSync(path.join(root, old[0], 'Contents', 'Resources', 'app', 'server.js'), 'utf8'), 'OLD');
  assert.ok(!fs.readdirSync(root).some((f) => f.startsWith('.MAVLink Hub update')), 'the staging folder is cleaned up');
  assert.equal(log.spawns.length, 0, 'no helper process on the Mac'); await until(() => log.quits === 1);
  // the new app, on its first start, removes the old copy
  make({ platform: 'darwin', serverDir: res, extract, marker });
  assert.ok(!fs.readdirSync(root).some((f) => f.startsWith('MAVLink Hub.app.old-')));
});
test('Mac install: a download that is not MAVLink Hub is refused and the app is left alone', async () => {
  const root = fs.mkdtempSync(path.join(DIR, 'mac-')), app = path.join(root, 'MAVLink Hub.app'), res = path.join(app, 'Contents', 'Resources', 'app');
  fs.mkdirSync(res, { recursive: true }); fs.writeFileSync(path.join(res, 'server.js'), 'OLD');
  await assert.rejects(U.swapMacApp({ zip: 'z', app, extract: async (z, d) => fs.mkdirSync(path.join(d, 'junk')) }), /does not look like/);
  assert.equal(fs.readFileSync(path.join(res, 'server.js'), 'utf8'), 'OLD'); assert.deepEqual(fs.readdirSync(root), ['MAVLink Hub.app']);
});

// ---------- through the launcher API ----------
test('the launcher window can check for and install an update, and only the hub computer can ask', async () => {
  reset('v9.9.9');
  const log = { quits: 0, spawns: [], opened: [] };
  const hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false, launcherDeps: { onQuit: () => { log.quits++; }, open: (k, t) => log.opened.push([k, t]), graceMs: 60000,
    updater: { apiUrl: ghUrl + '/api', allowHttp: true, platform: 'win32', serverDir: winDir(), spawnFn: (c, a) => { log.spawns.push([c, a]); return { on() {}, unref() {} }; } } } });
  const base = `http://127.0.0.1:${hub.web.address().port}`;
  const call = (method, p, headers = {}) => new Promise((resolve, reject) => { const r = http.request(base + p, { method, agent: false, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Launcher': '1' } : {}), ...headers } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: b.startsWith('{') ? JSON.parse(b) : null })); }); r.on('error', reject); r.end(method === 'POST' ? '{}' : undefined); });
  try {
    assert.equal((await call('POST', '/launcher/update/check', { 'X-Launcher': '' })).status, 403, 'needs the launcher header');
    assert.equal((await call('POST', '/launcher/update/install', { Origin: 'http://evil.example' })).status, 403, 'another web page cannot install anything');
    assert.equal(log.spawns.length, 0);
    const c = await call('POST', '/launcher/update/check'); assert.equal(c.json.update.status, 'available'); assert.equal(c.json.update.latest, '9.9.9');
    assert.equal(hub.launcher.snapshot(hub.web.address().port).update.status, 'available', 'the window sees it in its live stream');
    assert.equal((await call('POST', '/launcher/update/open')).json.ok, true); assert.equal(log.opened[0][0], 'release'); assert.equal(log.opened[0][1], ghUrl + '/release');
    assert.equal((await call('POST', '/launcher/update/install')).json.ok, true);
    await until(() => log.quits === 1); assert.equal(log.spawns.length, 1);
  } finally { await hub.close(); }
});
