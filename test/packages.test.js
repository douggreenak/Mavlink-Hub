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

test('each package holds the app and its own launchers, and nothing else (no tests, docs, build tools or other system\'s files)', () => {
  const win = B.assemble({ platform: 'windows', outDir: path.join(tmp(), 'w') }), mac = B.assemble({ platform: 'mac', outDir: path.join(tmp(), 'm') });
  for (const list of [win, mac]) {
    for (const f of ['server.js', 'airspace.js', 'launcher.js', 'launcher-api.js', 'launcher.html', 'index.html', 'package.json', 'hub.env.example', 'Read me first.txt', 'vendor/leaflet.js', 'vendor/qrcode.js', 'assets/icon.png', 'sim/inav-sim.js', 'sim/mavlink.js'])
      assert.ok(has(list, f), 'missing ' + f);
    assert.ok(!list.some((f) => /^(test|docs|tools|\.git|\.github|\.claude|dist|node_modules)\//.test(f) || /\.test\.js$|README\.md$|\.DS_Store/.test(f)), 'something that should stay out got in');
  }
  for (const f of ['MAVLink Hub.bat', 'launcher.ps1', 'Create desktop shortcut.bat', 'start.bat', 'assets/hub.ico']) assert.ok(has(win, f), 'Windows is missing ' + f);
  assert.ok(!win.some((f) => f.startsWith('MAVLink Hub.app') || f === 'start.command'), 'no Mac launcher in the Windows package');
  for (const f of ['MAVLink Hub.app/Contents/MacOS/MAVLink Hub', 'MAVLink Hub.app/Contents/Info.plist', 'MAVLink Hub.app/Contents/Resources/hub.icns', 'start.command']) assert.ok(has(mac, f), 'Mac is missing ' + f);
  assert.ok(!mac.some((f) => /\.(bat|ps1)$/.test(f)), 'no Windows launcher in the Mac package');
});

test('the Mac launchers keep their executable bit, and the Windows read-me has Windows line endings', () => {
  const dir = path.join(tmp(), 'm'); B.assemble({ platform: 'mac', outDir: dir });
  for (const f of B.EXECUTABLE.mac) assert.ok(fs.statSync(path.join(dir, f)).mode & 0o100, f + ' must be executable');
  const wdir = path.join(tmp(), 'w'); B.assemble({ platform: 'windows', outDir: wdir });
  assert.match(fs.readFileSync(path.join(wdir, 'Read me first.txt'), 'utf8'), /\r\n/);
  assert.match(fs.readFileSync(path.join(wdir, 'Read me first.txt'), 'utf8'), /Nothing else needs installing/);
  assert.throws(() => B.assemble({ platform: 'windows', outDir: tmp(), root: tmp() }), /missing from the project/);
});

test('every launcher looks for the bundled Node where the build puts it, and still falls back to a system Node', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.deepEqual(B.RUNTIME.windows, ['runtime/node.exe']); assert.deepEqual(B.RUNTIME.mac, ['runtime/node-arm64', 'runtime/node-x64']);
  for (const f of ['launcher.ps1', 'start.bat']) assert.match(read(f), /runtime\\node\.exe/, f);
  assert.match(read('launcher.ps1'), /Get-Command node/, 'falls back to a Node on PATH');
  for (const f of ['start.command', 'MAVLink Hub.app/Contents/MacOS/MAVLink Hub']) { const t = read(f); assert.match(t, /runtime\/node-arm64/, f); assert.match(t, /runtime\/node-x64/, f); assert.match(t, /uname -m/, f); assert.match(t, /command -v node/, f + ' falls back to a system Node'); assert.match(t, /com\.apple\.quarantine/, f); }
});

const until = async (fn, ms = 8000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
const get = (port, p, headers = {}) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); }).on('error', () => resolve({ status: 0, body: Buffer.alloc(0) })));

for (const platform of ['windows', 'mac']) {
  test(`a ${platform} package on its own is a working hub: dashboard, control window, vendored libraries, icon, simulator`, async () => {
    const dir = path.join(tmp(), 'pkg'); B.assemble({ platform, outDir: dir });
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

test('the Mac app starts the hub with the bundled Node and no system Node on PATH', { skip: process.platform === 'win32' }, async () => {
  const dir = path.join(tmp(), 'pkg'); B.assemble({ platform: 'mac', outDir: dir });
  fs.mkdirSync(path.join(dir, 'runtime'));
  const marker = path.join(dir, 'used-bundled-node.txt');
  for (const f of ['node-arm64', 'node-x64']) { const p = path.join(dir, 'runtime', f); fs.writeFileSync(p, `#!/bin/sh\necho "${f}" >> "${marker}"\nexec "${process.execPath}" "$@"\n`); fs.chmodSync(p, 0o755); }
  const port = 27000 + Math.floor(Math.random() * 1500), data = tmp();
  const env = { PATH: '/usr/bin:/bin', HOME: os.homedir(), LAUNCHER_NO_WINDOW: '1', WEB_PORT: String(port), UDP_PORT: String(port + 3000), DATA_DIR: data, AIRSPACE: 'off' };
  const run = spawnSync('/bin/bash', [path.join(dir, 'MAVLink Hub.app', 'Contents', 'MacOS', 'MAVLink Hub')], { env, encoding: 'utf8', timeout: 30000 });
  try {
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(fs.existsSync(marker), 'the bundled runtime was used');
    assert.equal((await get(port, '/info')).status, 200, 'and the hub is running');
  } finally {
    await new Promise((r) => { const q = http.request({ host: '127.0.0.1', port, path: '/launcher/stop', method: 'POST', headers: { 'X-Launcher': '1', 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', r); }); q.on('error', r); q.end('{}'); });
  }
});
