'use strict';
// The launcher: the hub's control API (what the window talks to), who is allowed to use it, and launcher.js itself.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), dgram = require('node:dgram'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-launch-'));
process.env.DATA_DIR = DIR; process.env.AIRSPACE = 'off'; process.env.HUB_LOG = path.join(DIR, 'hub.log');
fs.writeFileSync(process.env.HUB_LOG, Array.from({ length: 300 }, (_, i) => 'log line ' + i).join('\n'));
const S = require('../server.js');
const { guard } = require('../launcher-api.js');
const L = require('../launcher.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20); } };

// ---------- who may use it ----------
const fakeReq = (o = {}) => ({ method: 'GET', headers: { host: 'localhost:8080' }, socket: { remoteAddress: '127.0.0.1' }, ...o });

test('guard: only this computer, only the hub\'s own host name, and POSTs must carry the launcher header', () => {
  assert.equal(guard(fakeReq(), 8080), null);
  for (const h of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'LOCALHOST:8080']) assert.equal(guard(fakeReq({ headers: { host: h } }), 8080), null, h);
  for (const a of ['::1', '::ffff:127.0.0.1']) assert.equal(guard(fakeReq({ socket: { remoteAddress: a } }), 8080), null, a);
  assert.match(guard(fakeReq({ socket: { remoteAddress: '192.168.1.50' } }), 8080), /only works on the hub computer/, 'a phone on the Wi-Fi');
  assert.match(guard(fakeReq({ socket: { remoteAddress: '10.0.0.7' } }), 8080), /only works/);
  for (const h of ['evil.example:8080', 'localhost:9999', 'localhost', '192.168.1.5:8080', '']) assert.match(guard(fakeReq({ headers: { host: h } }), 8080) || '', /host/i, 'DNS rebinding: ' + h);
  assert.equal(guard(fakeReq({ headers: { host: 'localhost' } }), 80), null, 'bare localhost only when the hub is on port 80');
  const post = (headers) => fakeReq({ method: 'POST', headers: { host: 'localhost:8080', ...headers } });
  assert.match(guard(post({}), 8080), /launcher header/);
  assert.equal(guard(post({ 'x-launcher': '1' }), 8080), null);
  assert.equal(guard(post({ 'x-launcher': '1', origin: 'http://localhost:8080' }), 8080), null);
  assert.match(guard(post({ 'x-launcher': '1', origin: 'http://evil.example' }), 8080), /origin/i, 'another web page');
  assert.match(guard(post({ 'x-launcher': '0' }), 8080), /launcher header/);
});

// ---------- the API against a real hub ----------
let hub, base, port, quits = 0, opened = [], sims = [];
const fakeSpawn = (profile, udpPort) => { const child = new EventEmitter(); child.kill = () => { child.killed = true; child.emit('exit'); }; sims.push({ profile, udpPort, child }); return child; };
before(async () => {
  hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false, launcherDeps: { open: (k, t) => opened.push([k, t]), spawnSim: fakeSpawn, onQuit: () => { quits++; }, graceMs: 120 } });
  port = hub.web.address().port; base = `http://127.0.0.1:${port}`;
});
after(async () => { await hub.close(); });

const call = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request(base + p, { method, agent: false, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Launcher': '1' } : {}), ...headers } }, (res) => {
    const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString() }));
  });
  req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
});
const post = async (p, body) => { const r = await call('POST', p, { body }); return { status: r.status, ...(r.text.startsWith('{') ? JSON.parse(r.text) : { text: r.text }) }; };
function stream() {
  const events = []; let buf = '';
  const req = http.get(base + '/launcher/stream', { agent: false }, (res) => { res.setEncoding('utf8'); res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const m = ev.match(/^data: (.*)$/m); if (m) events.push(JSON.parse(m[1])); } }); });
  return { events, last: () => events[events.length - 1], close: () => req.destroy() };
}

test('the control page is served to this computer, and refused for a spoofed host or a missing header', async () => {
  const page = await call('GET', '/launcher');
  assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.match(page.text, /<title>MAVLink Hub<\/title>/);
  assert.equal((await call('GET', '/launcher', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await call('GET', '/launcher/stream', { headers: { Host: 'evil.example:' + port } })).status, 403);
  assert.equal((await call('POST', '/launcher/stop', { headers: { 'X-Launcher': '' }, body: {} })).status, 403);
  assert.equal((await call('POST', '/launcher/stop', { headers: { Origin: 'http://evil.example' }, body: {} })).status, 403);
  assert.equal(quits, 0, 'none of that stopped the hub');
  assert.equal((await call('GET', '/launcher/nonsense')).status, 404);
  assert.equal((await call('GET', '/assets/icon.png')).headers['content-type'], 'image/png');
  assert.equal((await call('GET', '/favicon.ico')).status, 200);
});

test('live status: version, ports, addresses, test-flight profiles, and traffic counted from real UDP', async () => {
  const s = stream(); await until(() => s.events.length);
  const a = s.last();
  assert.equal(a.version, require('../package.json').version); assert.equal(a.webPort, port); assert.equal(a.udpPort, hub.udp.address().port);
  assert.ok(Array.isArray(a.urls) && a.urls.every((u) => u.endsWith(':' + port)));
  assert.equal(a.telemetry.packets, 0); assert.equal(a.telemetry.lastAgoMs, null); assert.equal(a.viewers, 0); assert.equal(a.testFlight.running, false);
  assert.ok(a.profiles.some((p) => p.name === 'full') && a.profiles.some((p) => p.name === 'minimal' && p.description));
  assert.equal(a.dataDir, DIR); assert.equal(a.hasLog, true);
  const sock = dgram.createSocket('udp4');
  for (let i = 0; i < 20; i++) sock.send(Buffer.alloc(40), hub.udp.address().port, '127.0.0.1');
  await sleep(50); sock.close();
  await until(() => s.last().telemetry.packets === 20 && s.last().telemetry.pps > 0, 4000);
  const t = s.last().telemetry; assert.equal(t.bytes, 800); assert.ok(t.lastAgoMs >= 0 && t.lastAgoMs < 3000);
  s.close();
});

test('viewers counts dashboards watching, not the launcher window itself', async () => {
  const s = stream(); await until(() => s.events.length);
  const dash = http.get(base + '/stream', { agent: false }); await sleep(150);
  await until(() => s.last().viewers === 1 || sleep(50).then(() => false), 4000);
  assert.equal(s.last().viewers, 1);
  dash.destroy(); s.close();
});

test('open: dashboard, maps, airspace and log go to the right place; anything else is refused', async () => {
  opened.length = 0;
  for (const k of ['dashboard', 'maps', 'airspace', 'log']) assert.equal((await post('/launcher/open', { target: k })).ok, true, k);
  assert.deepEqual(opened, [['dashboard', `http://localhost:${port}/`], ['maps', DIR], ['airspace', path.join(DIR, 'airspace')], ['log', process.env.HUB_LOG]]);
  assert.ok(fs.existsSync(path.join(DIR, 'airspace')), 'the folder is created so it can be opened');
  for (const bad of ['', 'etc', '../..', 'constructor', undefined]) assert.equal((await post('/launcher/open', { target: bad })).status, 400, String(bad));
  assert.equal((await post('/launcher/open', 'not json')).status, 400);
  assert.equal(opened.length, 4, 'nothing else was opened');
});

test('test flight: starts with a known profile, refuses a second, rejects unknown names, stops, and notices when it ends', async () => {
  sims.length = 0; const s = stream(); await until(() => s.events.length);
  assert.equal((await post('/launcher/testflight', { action: 'start', profile: 'rm -rf /' })).status, 400);
  assert.equal((await post('/launcher/testflight', { action: 'start', profile: 'minimal,;evil' })).status, 400);
  assert.equal((await post('/launcher/testflight', { action: 'jump' })).status, 400);
  assert.equal(sims.length, 0, 'nothing was started by bad requests');
  assert.equal((await post('/launcher/testflight', { action: 'start', profile: ' minimal , split ' })).ok, true);
  assert.deepEqual([sims[0].profile, sims[0].udpPort], ['minimal,split', hub.udp.address().port]);
  await until(() => s.last().testFlight.running); assert.equal(s.last().testFlight.profile, 'minimal,split');
  assert.equal((await post('/launcher/testflight', { action: 'start', profile: 'full' })).status, 409);
  assert.equal((await post('/launcher/testflight', { action: 'stop' })).ok, true);
  assert.equal(sims[0].child.killed, true); await until(() => !s.last().testFlight.running);
  assert.equal((await post('/launcher/testflight', { action: 'start' })).ok, true, 'default profile is the full plane'); assert.equal(sims[1].profile, 'full');
  sims[1].child.emit('exit'); await until(() => !s.last().testFlight.running);
  assert.equal((await post('/launcher/testflight', { action: 'stop' })).ok, true, 'stopping when nothing runs is fine');
  s.close();
});

test('log: the last 200 lines, or a plain note when the hub was not started by the launcher', async () => {
  const r = await call('GET', '/launcher/log'); const lines = r.text.split('\n');
  assert.equal(lines.length, 200); assert.equal(lines[199], 'log line 299'); assert.equal(lines[0], 'log line 100');
  const keep = process.env.HUB_LOG; process.env.HUB_LOG = path.join(DIR, 'missing.log');
  assert.match((await call('GET', '/launcher/log')).text, /empty/); delete process.env.HUB_LOG;
  assert.match((await call('GET', '/launcher/log')).text, /not started by the launcher/); process.env.HUB_LOG = keep;
});

test('stop button: the hub quits, after answering', async () => {
  await sleep(400); quits = 0;                                                                  // earlier tests' closed windows have finished their grace period
  const r = await post('/launcher/stop', {}); assert.equal(r.ok, true);
  await until(() => quits === 1); await sleep(300); assert.equal(quits, 1, 'once');
});

test('closing the window stops the hub after a short grace, and reopening in time cancels it', async () => {
  await sleep(400); quits = 0;                                                                  // let earlier tests' windows finish closing
  const a = stream(); await until(() => a.events.length); a.close(); await sleep(40);
  const b = stream(); await until(() => b.events.length); await sleep(350);                     // reopened inside the grace period
  assert.equal(quits, 0, 'a reload does not stop the hub');
  b.close(); await until(() => quits === 1, 2000); await sleep(300); assert.equal(quits, 1, 'closing the window stopped the hub, once');
  assert.equal((await post('/launcher/prefs', { stopOnClose: false })).status, 404, 'there is no longer a switch to turn this off');
});

test('the launcher page only uses element ids that exist (a typo would silently break a button)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'launcher.html'), 'utf8');
  const used = new Set([...html.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1])), have = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  assert.ok(used.size > 20);
  for (const id of used) assert.ok(have.has(id), `launcher.html uses #${id} but nothing has that id`);
  assert.match(html, /X-Launcher/, 'and it sends the header the API requires');
});

// ---------- launcher.js ----------
test('browser lookup: right places per system, first installed one wins, none gives null', () => {
  const w = L.browserCandidates('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.match(w[0], /Edge.*msedge\.exe$/); assert.ok(w.some((p) => /Google.*chrome\.exe$/.test(p)) && w.some((p) => /Brave/.test(p)));
  assert.equal(L.findBrowser('win32', {}, (p) => /Google/.test(p) && /Program Files \(x86\)|Program Files/.test(p)).includes('chrome.exe'), true);
  const m = L.browserCandidates('darwin', {}, '/Users/me');
  assert.equal(m[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'); assert.ok(m.includes('/Users/me/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
  assert.equal(L.findBrowser('darwin', {}, (p) => p.includes('Microsoft Edge') && p.startsWith('/Applications'), '/Users/me'), '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  assert.equal(L.findBrowser('darwin', {}, () => false, '/Users/me'), null);
  assert.ok(L.browserCandidates('linux').some((p) => p.endsWith('chromium')));
});

test('app window command line: standalone window, its own profile, fixed size, no first-run prompts', () => {
  const a = L.appArgs('http://localhost:8080/launcher', '/data/launcher-profile');
  assert.ok(a.includes('--app=http://localhost:8080/launcher')); assert.ok(a.includes('--user-data-dir=/data/launcher-profile')); assert.ok(a.includes('--window-size=520,840'));
  assert.ok(a.includes('--no-first-run') && a.includes('--no-default-browser-check'));
});

test('failure messages say what to do', () => {
  assert.match(L.explainFailure('Error: listen EADDRINUSE: address already in use :::8080', 8080), /Port 8080 is already in use[\s\S]*hub\.env/);
  assert.match(L.explainFailure('Port 8080 is already in use. Is another copy of the hub running?', 8080), /already in use/);
  assert.match(L.explainFailure('something odd\nin the log', 8080), /could not start[\s\S]*in the log/);
  assert.equal(L.explainFailure('', 8080), 'The hub could not start.');
});

const runLauncher = (env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'launcher.js')], { env: { ...process.env, LAUNCHER_NO_WINDOW: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d)); c.on('exit', (code) => resolve({ code, out, err }));
});

test('launcher.js end to end: starts a hidden hub, a second run reuses it, and the hub can be stopped from the API', async () => {
  const p = 21000 + Math.floor(Math.random() * 2000), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-l2-')), env = { WEB_PORT: String(p), UDP_PORT: String(p + 5000), DATA_DIR: dir, HUB_LOG: undefined };
  delete env.HUB_LOG;
  try {
    assert.equal(await L.hubRunning(p, 300), false, 'nothing there yet');
    const first = await runLauncher(env); assert.equal(first.code, 0, first.err);
    assert.equal(await L.hubRunning(p), true, 'the hub is running after the launcher has exited');
    const page = await new Promise((r) => http.get({ host: '127.0.0.1', port: p, path: '/launcher' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => r({ s: res.statusCode, b })); }));
    assert.equal(page.s, 200); assert.match(page.b, /MAVLink Hub/);
    const log1 = fs.readFileSync(path.join(dir, 'hub.log'), 'utf8'); assert.match(log1, new RegExp('listening for MAVLink on UDP ' + (p + 5000)));
    const second = await runLauncher(env); assert.equal(second.code, 0, second.err);
    assert.equal(fs.readFileSync(path.join(dir, 'hub.log'), 'utf8'), log1, 'the second run did not start another hub (it would have rewritten the log)');
    const stop = await new Promise((r) => { const q = http.request({ host: '127.0.0.1', port: p, path: '/launcher/stop', method: 'POST', headers: { 'X-Launcher': '1', 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => r(res.statusCode)); }); q.end('{}'); });
    assert.equal(stop, 200); await until(async () => !(await L.hubRunning(p, 300)), 5000);
  } finally {
    await new Promise((r) => { const q = http.request({ host: '127.0.0.1', port: p, path: '/launcher/stop', method: 'POST', headers: { 'X-Launcher': '1' } }, (res) => { res.resume(); res.on('end', r); }); q.on('error', r); q.end('{}'); });
  }
});

test('launcher.js: when something else already holds the port it says so and exits with an error', async () => {
  const blocker = http.createServer((q, s) => s.end('not a hub')); await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
  const p = blocker.address().port, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-l3-'));
  try {
    const r = await runLauncher({ WEB_PORT: String(p), UDP_PORT: String(p + 1000), DATA_DIR: dir });
    assert.equal(r.code, 1); assert.match(r.err, new RegExp(`Port ${p} is already in use`)); assert.match(r.err, /hub\.env/);
    assert.equal(await L.hubRunning(p, 300), false, 'and a plain web server is not mistaken for a hub');
  } finally { blocker.close(); }
});
