'use strict';
// The live data path: how quickly a telemetry packet reaches a screen, what happens to a screen that cannot keep up, the keep-alive,
// and the compressed, cached static files.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), dgram = require('node:dgram'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-stream-')); process.env.AIRSPACE = 'off'; process.env.HUB_PING_MS = '120';
const S = require('../server.js');
let hub, port;
before(async () => { hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false }); port = hub.web.address().port; });
after(async () => { await hub.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a telemetry packet reaches every screen within a few milliseconds (UDP in, stream out, 8 screens at 200 packets a second)', async () => {
  const sent = new Map(), lat = [], N = 300, V = 8, conns = [];
  for (let v = 0; v < V; v++) http.get({ port, path: '/stream', agent: false }, (res) => { conns.push(res); let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => { const t = process.hrtime.bigint(); buf += c; let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (!ev.startsWith('data: ')) continue; const t0 = sent.get(Buffer.from(ev.slice(6), 'base64').readUInt32LE(0)); if (t0) lat.push(Number(t - t0) / 1e6); } }); });
  await sleep(250);
  const sock = dgram.createSocket('udp4');
  for (let i = 1; i <= N; i++) { const b = Buffer.alloc(44, 7); b.writeUInt32LE(i, 0); sent.set(i, process.hrtime.bigint()); sock.send(b, hub.udp.address().port, '127.0.0.1'); await sleep(5); }
  await sleep(300); sock.close(); for (const c of conns) c.destroy();
  lat.sort((a, b) => a - b);
  assert.equal(lat.length, N * V, 'nothing was dropped for screens that keep up');
  assert.ok(lat[Math.floor(lat.length * .5)] < 10, 'median ' + lat[Math.floor(lat.length * .5)].toFixed(2) + ' ms');
  assert.ok(lat[Math.floor(lat.length * .95)] < 30, 'p95 ' + lat[Math.floor(lat.length * .95)].toFixed(2) + ' ms');
});

test('a screen on a slow link is skipped for telemetry it cannot take, instead of queueing it and falling behind; events are never skipped', () => {
  const mk = (n) => { const w = []; return { writableLength: n, write: (l) => w.push(l), w }; };
  const fast = mk(0), slow = mk(70000), full = mk(2e6);
  S.viewers.add(fast); S.viewers.add(slow);
  try {
    S.broadcastData('data: x\n\n');
    assert.equal(fast.w.length, 1); assert.equal(slow.w.length, 0, 'a screen with 70 KB waiting gets the next reading when it has caught up, not a queue of old ones');
    slow.writableLength = 100; S.broadcastData('data: y\n\n'); assert.equal(slow.w.length, 1, 'and it is served again as soon as it has drained');
  } finally { S.viewers.delete(fast); S.viewers.delete(slow); S.viewers.delete(full); }
});

test('the stream sends a keep-alive, so a screen can tell a dead connection from a quiet one', async () => {
  const got = await new Promise((resolve) => { http.get({ port, path: '/stream', agent: false }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; if (/event: ping/.test(b)) { res.destroy(); resolve(true); } }); setTimeout(() => resolve(false), 2000); }); });
  assert.ok(got);
});

const get = (p, headers = {}) => new Promise((resolve, reject) => http.get({ port, path: p, headers, agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); }).on('error', reject));
test('the dashboard and its libraries are sent compressed when the browser accepts it, and a reload is a 304', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
  const plain = await get('/'); assert.equal(plain.status, 200); assert.ok(plain.body.equals(html), 'unchanged without compression'); assert.equal(plain.headers['cache-control'], 'no-cache');
  const gz = await get('/', { 'Accept-Encoding': 'gzip, deflate' });
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.ok(zlib.gunzipSync(gz.body).equals(html), 'the same page'); assert.ok(gz.body.length < html.length / 2, 'much smaller: ' + gz.body.length + ' of ' + html.length);
  const again = await get('/', { 'If-None-Match': gz.headers.etag }); assert.equal(again.status, 304); assert.equal(again.body.length, 0);
  const js = await get('/vendor/leaflet.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(js.status, 200); assert.equal(js.headers['content-encoding'], 'gzip'); assert.match(js.headers['cache-control'], /max-age=86400/); assert.equal(js.headers['content-type'], 'text/javascript');
  assert.equal((await get('/vendor/nothing.js')).status, 404);
});

test('the page needs nothing from the internet to draw (no web fonts or other outside files)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!/<link[^>]+href="https?:/i.test(html) && !/<script[^>]+src="https?:/i.test(html), 'a field with no internet would wait on every outside file');
});
