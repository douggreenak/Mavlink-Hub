'use strict';
// The demo flight runs on the hub: one simulated flight, the same on every screen connected to it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), dgram = require('node:dgram'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-demo-'));
process.env.DATA_DIR = DIR; process.env.AIRSPACE = 'off';
const S = require('../server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20); } };

let hub, base, port;
before(async () => { hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false }); port = hub.web.address().port; base = 'http://127.0.0.1:' + port; });
after(async () => { await hub.close(); });

const call = (method, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request(base + p, { method, agent: false, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: b.startsWith('{') ? JSON.parse(b) : null })); });
  r.on('error', reject); r.end();
});
const start = (h = { 'X-Hub': '1' }) => call('POST', '/demo/start', h), stop = (h = { 'X-Hub': '1' }) => call('POST', '/demo/stop', h);
function screen() { // one connected dashboard: counts telemetry lines and keeps the demo events it was told about
  const o = { demo: [], data: 0, close: () => req.destroy() }; let buf = '';
  const req = http.get(base + '/stream', { agent: false }, (res) => { res.setEncoding('utf8'); res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2);
    if (ev.startsWith('event: demo')) o.demo.push(JSON.parse(ev.split('data: ')[1]).running); else if (ev.startsWith('data: ')) o.data++; } }); });
  return o;
}

test('starting the demo from one screen shows the same flight on every screen connected to the hub, and stopping it stops it for all', async () => {
  const a = screen(), b = screen();
  await until(() => a.demo.length && b.demo.length); assert.deepEqual([a.demo, b.demo], [[false], [false]], 'a new screen is told the demo is off');
  assert.equal((await call('GET', '/demo')).json.running, false);
  const r = await start(); assert.equal(r.json.running, true);
  await until(() => a.demo.at(-1) === true && b.demo.at(-1) === true);
  await until(() => a.data > 20 && b.data > 20);
  assert.ok(Math.abs(a.data - b.data) < 15, 'both screens receive the same stream');
  const late = screen(); await until(() => late.demo.length); assert.deepEqual(late.demo, [true], 'a screen that joins later is told it is running');
  assert.equal((await call('GET', '/demo')).json.running, true);
  assert.equal((await start()).json.running, true, 'starting twice is harmless');
  await stop(); await until(() => a.demo.at(-1) === false && b.demo.at(-1) === false && late.demo.at(-1) === false);
  const n = a.data; await sleep(300); assert.equal(a.data, n, 'no more data once stopped');
  a.close(); b.close(); late.close();
});
test('only a request from the hub\'s own pages can start or stop the demo', async () => {
  assert.equal((await call('POST', '/demo/start', {})).status, 403, 'no custom header');
  assert.equal((await call('GET', '/demo/start', { 'X-Hub': '1' })).status, 403, 'not a POST');
  assert.equal((await start({ 'X-Hub': '1', Origin: 'http://evil.example' })).status, 403, 'a page on another website');
  assert.equal((await call('GET', '/demo')).json.running, false);
  assert.equal((await start({ 'X-Hub': '1', Origin: base })).json.running, true, 'the hub\'s own page');
  assert.equal((await stop({})).status, 403);
  assert.equal((await call('GET', '/demo')).json.running, true, 'a refused stop changed nothing');
  await stop();
});
test('real telemetry always wins: the demo stops when an aircraft starts sending, and will not start while one is', async () => {
  const s = screen(); await until(() => s.demo.length);
  await start(); await until(() => s.demo.at(-1) === true);
  const sock = dgram.createSocket('udp4'), pkt = Buffer.from([0xfd, 0x01, 0, 0, 7, 1, 1, 0, 0, 0, 0x55, 0xaa, 0xbb]);
  await new Promise((r) => sock.send(pkt, hub.udp.address().port, '127.0.0.1', r));
  await until(() => s.demo.at(-1) === false); assert.equal((await call('GET', '/demo')).json.running, false);
  const refused = await start(); assert.equal(refused.status, 409); assert.match(refused.json.error, /aircraft is sending/);
  sock.close(); s.close();
});
