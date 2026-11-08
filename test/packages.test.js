'use strict';
// The download packages: what goes in, that a packaged copy runs by itself, and that the launchers use the bundled Node.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const B = require('../tools/build-packages.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pkg-'));
const ROOT = path.join(__dirname, '..');
const has = (list, f) => list.includes(f);

test('Node download helpers: checksum list, LTS choice, archive names', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(B.parseShasums(`${hash}  node-v1-win-x64.zip\n${'b'.repeat(64)} *node-v1-darwin-arm64.tar.gz\njunk line\n`), { 'node-v1-win-x64.zip': hash, 'node-v1-darwin-arm64.tar.gz': 'b'.repeat(64) });
  assert.equal(B.pickLts([{ version: 'v27.0.0', lts: false }, { version: 'v26.13.0', lts: 'Lithium' }, { version: 'v24.1.0', lts: 'Krypton' }]), 'v26.13.0');
  assert.throws(() => B.pickLts([{ version: 'v27.0.0', lts: false }]), /no LTS/);
  assert.deepEqual(B.nodeFiles('v26.13.0'), { windows: 'node-v26.13.0-win-x64.zip', 'mac-arm64': 'node-v26.13.0-darwin-arm64.tar.gz', 'mac-x64': 'node-v26.13.0-darwin-x64.tar.gz' });
  assert.equal(B.sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

const MAC_APP = B.MAC_APP, MAC_RES = B.MAC_RES;
const CORE = ['server.js', 'airspace.js', 'launcher.js', 'launcher-api.js', 'launcher.html', 'index.html', 'package.json', 'hub.env.example', 'vendor/leaflet.js', 'vendor/qrcode.js', 'assets/icon.png', 'sim/inav-sim.js', 'sim/mavlink.js'];
const STRAY = (f) => /(^|\/)(test|docs|tools|\.git|\.github|\.claude|dist|node_modules)\//.test(f) || /\.test\.js$|README\.md$|\.DS_Store/.test(f);

test('each package holds the app and its own launchers, and nothing else (no tests, docs, build tools or other system\'s files)', () => {
  const win = B.assemble({ platform: 'windows', outDir: path.join(tmp(), 'w') }), mac = B.assemble({ platform: 'mac', outDir: path.join(tmp(), 'm') });
  for (const f of [...CORE, 'Read me first.txt', 'MAVLink Hub.bat', 'launcher.ps1', 'Create desktop shortcut.bat', 'start.bat', 'assets/hub.ico']) assert.ok(has(win, f), 'Windows is missing ' + f);
  assert.ok(!win.some((f) => f.startsWith('MAVLink Hub.app') || f === 'start.command'), 'no Mac launcher in the Windows package');
  for (const f of CORE) assert.ok(has(mac, MAC_RES + '/app/' + f), 'the Mac app is missing ' + f);
  for (const f of [MAC_APP + '/Contents/Info.plist', MAC_APP + '/Contents/MacOS/MAVLink Hub', MAC_RES + '/hub.icns', 'Read me first.txt']) assert.ok(has(mac, f), 'Mac is missing ' + f);
  assert.ok(!mac.some((f) => /\.(bat|ps1)$/.test(f)), 'no Windows launcher in the Mac package');
  assert.ok(mac.every((f) => f === 'Read me first.txt' || f.startsWith(MAC_APP + '/')), 'on a Mac everything is inside the one app, so nothing can be left behind when macOS runs a copy of it');
  assert.ok(!win.some(STRAY) && !mac.some(STRAY), 'something that should stay out got in');
});

test('the Mac launchers keep their executable bit, and the Windows read-me has Windows line endings', () => {
  const dir = path.join(tmp(), 'm'); B.assemble({ platform: 'mac', outDir: dir });
  assert.deepEqual(B.EXECUTABLE.mac, [MAC_APP + '/Contents/MacOS/MAVLink Hub']);
  for (const f of B.EXECUTABLE.mac) assert.ok(fs.statSync(path.join(dir, f)).mode & 0o100, f + ' must be executable');
  const wdir = path.join(tmp(), 'w'); B.assemble({ platform: 'windows', outDir: wdir });
  assert.match(fs.readFileSync(path.join(wdir, 'Read me first.txt'), 'utf8'), /\r\n/);
  assert.match(fs.readFileSync(path.join(wdir, 'Read me first.txt'), 'utf8'), /Nothing else needs installing/);
  assert.throws(() => B.assemble({ platform: 'windows', outDir: tmp(), root: tmp() }), /missing from the project/);
});

test('every launcher looks for the bundled Node where the build puts it, and still falls back to a system Node', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.deepEqual(B.RUNTIME.windows, ['runtime/node.exe']); assert.deepEqual(B.RUNTIME.mac, [MAC_RES + '/runtime/node-arm64', MAC_RES + '/runtime/node-x64']);
  for (const f of ['launcher.ps1', 'start.bat']) assert.match(read(f), /runtime\\node\.exe/, f);
  assert.match(read('launcher.ps1'), /Get-Command node/, 'falls back to a Node on PATH');
  const app = read(MAC_APP + '/Contents/MacOS/MAVLink Hub');
  assert.match(app, /Contents\/Resources\/runtime|\$APP\/Contents\/Resources\/app/); assert.match(app, /RUNTIME="\$APP\/Contents\/Resources\/runtime"/); assert.match(app, /\$RUNTIME\/node-arm64/); assert.match(app, /\$RUNTIME\/node-x64/);
  assert.match(app, /uname -m/); assert.match(app, /command -v node/); assert.match(app, /com\.apple\.quarantine/); assert.match(app, /MAVLINK_HUB_NO_DIALOG/);
  const sc = read('start.command'); assert.match(sc, /runtime\/node-arm64/); assert.match(sc, /runtime\/node-x64/); assert.match(sc, /command -v node/);
});

const until = async (fn, ms = 8000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
const get = (port, p, headers = {}) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); }).on('error', () => resolve({ status: 0, body: Buffer.alloc(0) })));

for (const platform of ['windows', 'mac']) {
  test(`a ${platform} package on its own is a working hub: dashboard, control window, vendored libraries, icon, simulator`, async () => {
    const pkg = path.join(tmp(), 'pkg'); B.assemble({ platform, outDir: pkg });
    const dir = platform === 'mac' ? path.join(pkg, MAC_RES, 'app') : pkg;
    const port = 25000 + Math.floor(Math.random() * 1500), env = { ...process.env, WEB_PORT: String(port), UDP_PORT: String(port + 4000), DATA_DIR: tmp(), AIRSPACE: 'off' };
    const hub = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: 'ignore' });
    try {
      await until(async () => (await get(port, '/info')).status === 200);
      assert.match((await get(port, '/')).body.toString(), /<title>Flight telemetry<\/title>/);
      assert.equal((await get(port, '/launcher', { Host: `localhost:${port}` })).status, 200);
      assert.equal((await get(port, '/vendor/leaflet.js')).status, 200); assert.equal((await get(port, '/vendor/qrcode.js')).status, 200); assert.equal((await get(port, '/assets/icon.png')).status, 200);
      const sim = spawnSync(process.execPath, [path.join(dir, 'sim', 'inav-sim.js'), '--list'], { encoding: 'utf8' });
      assert.match(sim.stdout, /minimal/);
    } finally { hub.kill(); }
  });
}

// ---- the Mac app, run the way macOS runs a downloaded one ----
const fakeRuntime = (appDir, marker) => {            // stand-ins for the two bundled Node builds: they note that they ran, then use this machine's Node
  const rt = path.join(appDir, 'Contents', 'Resources', 'runtime'); fs.mkdirSync(rt, { recursive: true });
  for (const f of ['node-arm64', 'node-x64']) { const p = path.join(rt, f); fs.writeFileSync(p, `#!/bin/sh\necho "${f}" >> "${marker}"\nexec "${process.execPath}" "$@"\n`); fs.chmodSync(p, 0o755); }
};
const stopHub = (port) => new Promise((r) => { const q = http.request({ host: '127.0.0.1', port, path: '/launcher/stop', method: 'POST', headers: { 'X-Launcher': '1', 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', r); }); q.on('error', r); q.end('{}'); });
const runApp = (appDir, port, extra = {}) => spawnSync('/bin/bash', [path.join(appDir, 'Contents', 'MacOS', 'MAVLink Hub')], { env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LAUNCHER_NO_WINDOW: '1', MAVLINK_HUB_NO_DIALOG: '1', MAVLINK_HUB_NO_WAIT: '1', WEB_PORT: String(port), UDP_PORT: String(port + 3000), DATA_DIR: tmp(), AIRSPACE: 'off', ...extra }, encoding: 'utf8', timeout: 30000 });
const macOnly = { skip: process.platform === 'win32' };
const portFor = () => 27000 + Math.floor(Math.random() * 1500);

test('the Mac app starts the hub with the bundled Node and no system Node on PATH', macOnly, async () => {
  const root = tmp(); B.assemble({ platform: 'mac', outDir: path.join(root, 'pkg') });
  const app = path.join(root, 'pkg', MAC_APP), marker = path.join(root, 'used.txt'); fakeRuntime(app, marker);
  const port = portFor(), run = runApp(app, port);
  try { assert.equal(run.status, 0, run.stdout + run.stderr); assert.ok(fs.existsSync(marker), 'the bundled runtime was used'); assert.equal((await get(port, '/info')).status, 200, 'and the hub is running'); }
  finally { await stopHub(port); }
});

test('the Mac app works from anywhere: copied on its own into a folder with nothing else (what app translocation does)', macOnly, async () => {
  const root = tmp(); B.assemble({ platform: 'mac', outDir: path.join(root, 'pkg') });
  const alone = path.join(root, 'somewhere else entirely'); fs.mkdirSync(alone); fs.cpSync(path.join(root, 'pkg', MAC_APP), path.join(alone, MAC_APP), { recursive: true });
  assert.deepEqual(fs.readdirSync(alone), [MAC_APP], 'the app really is on its own');
  const app = path.join(alone, MAC_APP); fakeRuntime(app, path.join(root, 'used.txt'));
  const port = portFor(), run = runApp(app, port);
  try { assert.equal(run.status, 0, 'it used to say "server.js was not found" here: ' + run.stdout + run.stderr); assert.equal((await get(port, '/info')).status, 200); }
  finally { await stopHub(port); }
});

test('the Mac app works when the whole app is read-only, as macOS makes a downloaded copy', macOnly, async () => {
  const root = tmp(); B.assemble({ platform: 'mac', outDir: path.join(root, 'pkg') });
  const app = path.join(root, 'pkg', MAC_APP); fakeRuntime(app, path.join(root, 'used.txt'));
  spawnSync('chmod', ['-R', 'a-w', app]);
  const port = portFor(); let run;
  try { run = runApp(app, port); assert.equal(run.status, 0, run.stdout + run.stderr); assert.equal((await get(port, '/info')).status, 200, 'saved data goes to the data folder, not into the app'); }
  finally { await stopHub(port); spawnSync('chmod', ['-R', 'u+w', app]); }
});

test('the Git-checkout layout still works: the repo\'s own app uses the files beside it and a Node on the computer', macOnly, async () => {
  const port = portFor(), run = runApp(path.join(ROOT, MAC_APP), port, { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' });
  try { assert.equal(run.status, 0, run.stdout + run.stderr); assert.equal((await get(port, '/info')).status, 200); } finally { await stopHub(port); }
});

test('a Mac app with no hub files and no Node says what is wrong, instead of failing quietly', macOnly, () => {
  const root = tmp(); B.assemble({ platform: 'mac', outDir: path.join(root, 'pkg') });
  const app = path.join(root, 'pkg', MAC_APP); fs.rmSync(path.join(app, 'Contents', 'Resources', 'app'), { recursive: true });
  const run = runApp(app, portFor(), { PATH: '/usr/bin:/bin' });       // note: the script adds Homebrew paths itself, so a real Node may still be found
  assert.equal(run.status, 1); assert.match(run.stderr, /Node\.js is not installed|hub's files were not found/);
});

test('hub.env can live in the saved-data folder, which is where a Mac app user puts it', () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'hub.env'), 'MAX_TILES=7\nAIRSPACE_MAX_FLOOR_FT=123\n');
  const r = spawnSync(process.execPath, ['-e', "const S=require('./server.js');console.log(S.MAX_TILES, process.env.AIRSPACE_MAX_FLOOR_FT)"], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '7 123', r.stderr);
});

// ---- user data lives outside the app, so replacing the app (an update) never takes it away ----
const treeOf = (dir) => { const out = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p) + ':' + fs.statSync(p).size); } })(dir); return out.sort(); };
const fetchJSON = async (port, p, opts = {}) => new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port, path: p, method: opts.method || 'GET', agent: false, headers: opts.headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() })); }); r.on('error', () => resolve({ status: 0, text: '' })); r.end(opts.body); });

async function useHub(appDir, port, dataDir, origin) {
  const env = { ...process.env, WEB_PORT: String(port), UDP_PORT: String(port + 4000), DATA_DIR: dataDir, TILE_STREET_URL: `${origin}/tile/{z}/{x}/{y}.png`, AIRSPACE_FAA_URL: `${origin}/arcgis`, AIRSPACE_TFR_URL: `${origin}/tfr` };
  const hub = spawn(process.execPath, ['server.js'], { cwd: appDir, env, stdio: 'ignore' });
  await until(async () => (await fetchJSON(port, '/info')).status === 200);
  return hub;
}

test('saved maps, airspace and settings go to the data folder and nothing is written inside the app; replacing the app keeps them', async () => {
  const fixture = (n) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', n));
  const origin = http.createServer((req, res) => { if (req.url.startsWith('/tile/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from('89504e470d0a1a0a', 'hex')); } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(/Class_Airspace/.test(req.url) ? fixture('faa-class.json') : JSON.stringify({ type: 'FeatureCollection', features: [] })); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r)); const o = `http://127.0.0.1:${origin.address().port}`;
  const root = tmp(), dataDir = path.join(root, 'saved data'), port = 28000 + Math.floor(Math.random() * 1500);
  const appDir = path.join(root, 'app'); B.assemble({ platform: 'mac', outDir: appDir });
  const serverDir = path.join(appDir, MAC_RES, 'app'), before = treeOf(appDir);
  let hub = await useHub(serverDir, port, dataDir, o);
  try {
    assert.equal((await fetchJSON(port, '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: 'imperial', hidden: ['Pitch'] }) })).status, 200);
    assert.equal((await fetchJSON(port, '/tiles/street/3/4/2')).status, 200);
    const air = JSON.parse((await fetchJSON(port, '/airspace?layers=controlled&w=-148.2&s=64.5&e=-147.2&n=65.1')).text);
    assert.ok(air.layers.controlled.features.length >= 3, 'airspace was fetched');
    assert.equal((await fetchJSON(port, '/launcher/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Launcher': '1' }, body: JSON.stringify({ stopOnClose: true }) })).status, 200);
  } finally { hub.kill(); }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')), 'settings saved in the data folder');
  assert.ok(fs.existsSync(path.join(dataDir, 'cache', 'tiles', 'street', '3', '4', '2')), 'map tile saved in the data folder');
  assert.ok(fs.readdirSync(path.join(dataDir, 'airspace', 'cache', 'controlled')).length >= 1, 'airspace saved in the data folder');
  assert.ok(fs.existsSync(path.join(dataDir, 'launcher.json')), 'launcher preferences saved in the data folder');
  assert.deepEqual(treeOf(appDir), before, 'not one file was added or changed inside the app');
  // an update: throw the old app away completely and install a fresh copy
  fs.rmSync(appDir, { recursive: true }); B.assemble({ platform: 'mac', outDir: appDir });
  hub = await useHub(path.join(appDir, MAC_RES, 'app'), port, dataDir, o);
  try {
    assert.equal(JSON.parse((await fetchJSON(port, '/settings')).text).units, 'imperial', 'settings survived the update');
    assert.equal(JSON.parse((await fetchJSON(port, '/cache/summary?layer=street')).text).zooms['3'].tiles, 1, 'saved maps survived the update');
    const hitsBefore = origin._hits || 0; const again = JSON.parse((await fetchJSON(port, '/airspace?layers=controlled&w=-148.2&s=64.5&e=-147.2&n=65.1')).text);
    assert.ok(again.layers.controlled.features.length >= 3 && again.layers.controlled.errors.length === 0, 'airspace survived the update');
    origin.close(); await new Promise((r) => setTimeout(r, 50));
    const offline = JSON.parse((await fetchJSON(port, '/airspace?layers=controlled&w=-148.2&s=64.5&e=-147.2&n=65.1')).text);
    assert.ok(offline.layers.controlled.features.length >= 3 && offline.layers.controlled.errors.length === 0, 'and it is served from disk, with no internet needed, after the update');
    void hitsBefore;
  } finally { hub.kill(); try { origin.close(); } catch (e) { /* closed */ } }
});

test('by default the data folder is the per-user app-data folder, never anywhere inside an app or install folder', () => {
  const home = os.homedir(), mac = spawnSync(process.execPath, ['-e', "console.log(require('./server.js').DATA_DIR)"], { cwd: ROOT, env: { ...process.env, DATA_DIR: '' }, encoding: 'utf8' });
  const dir = mac.stdout.trim().split('\n').pop();
  assert.ok(dir.startsWith(home), dir + ' should be under the home folder');
  assert.ok(!/\.app(\/|$)/.test(dir) && !dir.startsWith(ROOT), 'and not inside an app or this project folder');
  assert.match(dir, /MAVLink Hub|mavlink-hub/);
});

test('the Mac app stays running while the hub runs (macOS removes what an app started once the app ends) and ends with it', async () => {
  const root = tmp(), appDir = path.join(root, 'app'); B.assemble({ platform: 'mac', outDir: appDir });
  const port = 29500 + Math.floor(Math.random() * 400), data = path.join(root, 'd');
  const nodeBin = path.join(root, 'bin'); fs.mkdirSync(nodeBin); fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  const app = spawn('/bin/bash', [path.join(appDir, MAC_APP, 'Contents', 'MacOS', 'MAVLink Hub')], { env: { PATH: nodeBin + ':/usr/bin:/bin', HOME: os.homedir(), LAUNCHER_NO_WINDOW: '1', MAVLINK_HUB_NO_DIALOG: '1', WEB_PORT: String(port), UDP_PORT: String(port + 3000), DATA_DIR: data, AIRSPACE: 'off' }, stdio: 'ignore' });
  let ended = false; app.on('exit', () => { ended = true; });
  try {
    await until(async () => (await fetchJSON(port, '/info')).status === 200);
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(ended, false, 'the app is still running after the hub came up');
    await fetchJSON(port, '/launcher/stop', { method: 'POST', headers: { 'X-Launcher': '1', Origin: `http://localhost:${port}`, Host: `localhost:${port}` } });
    await until(async () => ended, 20000);
    assert.equal(ended, true, 'and it ends when the hub is stopped');
  } finally { app.kill(); try { const pid = fs.readFileSync(path.join(data, 'hub.pid'), 'utf8'); process.kill(+pid); } catch (e) { /* none */ } }
});

test('the Mac app gets its own native window: compiled for both Mac types, and the app script hands over to it', { skip: spawnSync('which', ['swiftc']).status !== 0 }, () => {
  const root = tmp(); B.assemble({ platform: 'mac', outDir: root });
  const exe = B.buildNative(root), info = spawnSync('lipo', ['-info', exe], { encoding: 'utf8' }).stdout;
  assert.match(info, /arm64/); assert.match(info, /x86_64/);
  assert.ok(fs.statSync(exe).mode & 0o100, 'executable');
  const script = fs.readFileSync(path.join(root, MAC_APP, 'Contents', 'MacOS', 'MAVLink Hub'), 'utf8');
  assert.match(script, /exec "\$HELPER" "\$PORT"/); assert.match(script, /hubwindow/);
  assert.match(fs.readFileSync(path.join(root, MAC_APP, 'Contents', 'Info.plist'), 'utf8'), /NSAllowsLocalNetworking/);
});

test('the Windows launcher uses the app window (WebView2) from runtime\\webview2, with the files the build puts there, and still falls back to a browser window', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'launcher.ps1'), 'utf8');
  assert.match(ps, /runtime\\webview2/);
  for (const name of Object.values(B.WEBVIEW2.files)) if (name.endsWith('.dll') && !name.startsWith('WebView2Loader')) assert.ok(ps.includes(name), name + ' is loaded by launcher.ps1');
  assert.match(ps, /Start-Hub \$false/, 'falls back to the browser app window');
  assert.match(ps, /HUB_PORT=/);
  assert.match(B.WEBVIEW2.sha256, /^[0-9a-f]{64}$/);
  const l = fs.readFileSync(path.join(ROOT, 'launcher.js'), 'utf8'); assert.match(l, /HUB_PORT=/);
});
