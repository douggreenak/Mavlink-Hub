'use strict';
// End-to-end tests of the hub: HTTP routes, UDP -> SSE relay, settings, tile caching and bulk
// download, all against a fake tile origin on localhost so no internet is needed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), dgram = require('node:dgram'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // just enough to look like a PNG
const hits = {};
const agent = new http.Agent({ keepAlive: false }); // one socket per request keeps tests independent
let origin, originPort, hub, base, S;

before(async () => {
  origin = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    let m;
    if ((m = req.url.match(/^\/redir\/(.+)$/))) { res.writeHead(302, { Location: '/' + m[1] + '.png' }); return res.end(); }
    if (req.url.startsWith('/9/')) { res.writeHead(404); return res.end('no such tile'); }
    if (req.url.startsWith('/8/')) return; // never answers: exercises the timeout path only if asked
    res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG);
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  originPort = origin.address().port;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-e2e-'));
  process.env.TILE_STREET_URL = `http://127.0.0.1:${originPort}/{z}/{x}/{y}.png`;
  process.env.TILE_SAT_URL = `http://127.0.0.1:${originPort}/redir/{z}/{y}/{x}`;
  process.env.MAX_TILES = '40';
  S = require('../server.js');
  hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false });
  base = `http://127.0.0.1:${hub.web.address().port}`;
});
after(async () => { await hub.close(); origin.close(); });

const get = (p, opts = {}) => new Promise((resolve, reject) => {
  const req = http.request(base + p, { method: opts.method || 'GET', headers: opts.headers, agent }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end(opts.body);
});
const getJSON = async (p, opts) => JSON.parse((await get(p, opts)).body.toString());
const post = (p, body) => get(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(25); } };

// Open the SSE stream and give back a buffer that fills up, plus a waiter.
function openStream() {
  const s = { text: '', req: null };
  return new Promise((resolve, reject) => {
    s.req = http.get(base + '/stream', { agent }, (res) => {
      s.status = res.statusCode; s.headers = res.headers;
      res.setEncoding('utf8'); res.on('data', (c) => { s.text += c; });
      s.waitFor = (sub) => until(() => s.text.includes(sub));
      s.close = () => { s.req.destroy(); res.destroy(); };
      resolve(s);
    }).on('error', reject);
  });
}
function sendUDP(buf) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.send(buf, hub.udp.address().port, '127.0.0.1', (e) => { sock.close(); e ? reject(e) : resolve(); });
  });
}

test('serves the dashboard and refuses to cache it', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.ok(r.body.toString().includes('<title>Flight telemetry</title>'));
  assert.equal((await get('/index.html')).status, 200);
});

test('serves vendored assets with the right type and nothing outside vendor/', async () => {
  const css = await get('/vendor/leaflet.css');
  assert.equal(css.status, 200); assert.equal(css.headers['content-type'], 'text/css');
  assert.equal((await get('/vendor/leaflet.js')).headers['content-type'], 'text/javascript');
  assert.equal((await get('/vendor/images/marker-icon.png')).headers['content-type'], 'image/png');
  assert.equal((await get('/vendor/images/missing.png')).status, 404);
  assert.equal((await get('/vendor/../server.js')).status, 404);
  assert.equal((await get('/vendor/..%2Fserver.js')).status, 404);
  assert.equal((await get('/nope')).status, 404);
});

test('/info lists reachable http addresses on the web port', async () => {
  const { urls } = await getJSON('/info');
  assert.ok(Array.isArray(urls));
  for (const u of urls) assert.ok(u.endsWith(':' + hub.web.address().port), u);
});

test('settings: defaults, validation, persistence and broadcast to viewers', async () => {
  assert.deepEqual(await getJSON('/settings'), { units: 'metric', hidden: [] });
  const s = await openStream();
  await s.waitFor('event: settings');

  const r = await post('/settings', JSON.stringify({ units: 'imperial', hidden: ['Pitch', 42, 'x'.repeat(80), 'Roll'] }));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { units: 'imperial', hidden: ['Pitch', 'Roll'] }, 'drops non-strings and over-long names');
  await s.waitFor('"units":"imperial"');

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'settings.json'), 'utf8')).units, 'imperial', 'written to DATA_DIR');
  assert.equal((await post('/settings', JSON.stringify({ units: 'furlongs' }))).status, 200);
  assert.equal((await getJSON('/settings')).units, 'imperial', 'unknown unit ignored');
  assert.equal((await post('/settings', 'not json')).status, 400);
  const big = await post('/settings', JSON.stringify({ hidden: Array(3000).fill('abcdefgh') }));
  assert.equal(big.status, 413);
  s.close();
});

test('UDP datagrams reach every SSE viewer as base64 lines', async () => {
  const a = await openStream(), b = await openStream();
  assert.equal(a.status, 200); assert.match(a.headers['content-type'], /text\/event-stream/);
  await a.waitFor(': connected'); await b.waitFor(': connected');
  const pkt = Buffer.from([0xfd, 0x01, 0, 0, 7, 1, 1, 0, 0, 0, 0x55, 0xaa, 0xbb]);
  await sendUDP(pkt);
  const line = 'data: ' + pkt.toString('base64') + '\n\n';
  await a.waitFor(line); await b.waitFor(line);
  a.close(); b.close();
});

test('tiles are fetched once, cached on disk and served from cache afterwards', async () => {
  const r1 = await get('/tiles/street/1/0/1');
  assert.equal(r1.status, 200);
  assert.equal(r1.headers['content-type'], 'image/png');
  assert.ok(r1.body.equals(PNG));
  assert.equal(hits['/1/0/1.png'], 1);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'cache', 'tiles', 'street', '1', '0', '1')));
  const r2 = await get('/tiles/street/1/0/1');
  assert.ok(r2.body.equals(PNG));
  assert.equal(hits['/1/0/1.png'], 1, 'second request did not touch the origin');
});

test('tile download follows redirects and uses the layer\'s own content type', async () => {
  const r = await get('/tiles/sat/3/4/5');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.ok(r.body.equals(PNG));
  assert.equal(hits['/redir/3/5/4'], 1, 'sat template swaps x and y');
  assert.equal(hits['/3/5/4.png'], 1);
});

test('a tile the origin does not have is a 404, and silly zooms never leave the building', async () => {
  assert.equal((await get('/tiles/street/9/0/0')).status, 404);
  assert.equal((await get('/tiles/street/99/0/0')).status, 404);
  assert.equal(hits['/99/0/0.png'], undefined);
  assert.equal((await get('/tiles/moon/1/0/0')).status, 404);
});

test('/precache/plan validates input and counts what is missing', async () => {
  assert.deepEqual(await getJSON('/precache/plan?layer=street'), { error: 'Bad request' });
  assert.deepEqual(await getJSON('/precache/plan?layer=street&w=0&e=1&s=0&n=1&z0=3&z1=1'), { error: 'Bad request' });
  // zoom 1 covers 4 tiles; one of them (1/0/1) is already cached above
  const p = await getJSON('/precache/plan?layer=street&w=-180&e=180&s=-85&n=85&z0=1&z1=1');
  assert.deepEqual(p, { total: 4, missing: 3, limit: 40 });
});

test('/precache refuses plans over the limit', async () => {
  const r = await getJSON('/precache?layer=street&w=-180&e=180&s=-85&n=85&z0=0&z1=3');
  assert.match(r.error, /85 tiles; the limit is 40/);
});

test('bulk download: runs, reports progress, refuses a second job, then shows up in summary and coverage', async () => {
  const start = await getJSON('/precache?layer=street&w=-180&e=180&s=-85&n=85&z0=1&z1=1');
  assert.deepEqual(start, { total: 4 });
  const second = await getJSON('/precache?layer=street&w=-180&e=180&s=-85&n=85&z0=0&z1=0');
  assert.equal(second.error, 'A map download is already running');
  await until(async () => !(await getJSON('/precache/status')).running);
  const st = await getJSON('/precache/status');
  assert.deepEqual(st, { done: 4, total: 4, running: false, failed: 0, cancel: false });
  for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'cache', 'tiles', 'street', '1', String(x), String(y))));
  }
  assert.equal(hits['/1/0/1.png'], 1, 'already-cached tile was not downloaded again');

  const sum = await getJSON('/cache/summary?layer=street');
  assert.equal(sum.layer, 'street');
  assert.equal(sum.zooms['1'].tiles, 4);
  assert.equal(sum.zooms['1'].bytes, 4 * PNG.length);
  assert.equal(sum.avg, PNG.length);
  assert.equal(sum.dir, path.join(process.env.DATA_DIR, 'cache'));
  assert.deepEqual(await getJSON('/cache/summary?layer=moon'), { error: 'Bad layer' });

  const cov = await getJSON('/cache/coverage?layer=street&z=1');
  assert.equal(cov.z, 1);
  assert.deepEqual(cov.tiles.map((t) => t.join('/')).sort(), ['0/0', '0/1', '1/0', '1/1']);
  assert.deepEqual(await getJSON('/cache/coverage?layer=street&z=25'), { error: 'Bad request' });
});

test('POST /cache/clear with an area removes just that area at those zooms', async () => {
  // zoom 1 has all four tiles saved; the western hemisphere is x=0 -> two of them
  const r = await getJSON('/precache/clear?layer=street&w=-180&e=-1&s=-85&n=85&z0=1&z1=1', { method: 'POST' }).catch(() => null);
  assert.equal(r, null, 'wrong path is not a clear endpoint');
  const del = await getJSON('/cache/clear?layer=street&w=-180&e=-1&s=-85&n=85&z0=1&z1=1', { method: 'POST' });
  assert.deepEqual(del, { ok: true, deleted: 2 });
  const cov = await getJSON('/cache/coverage?layer=street&z=1');
  assert.deepEqual(cov.tiles.map((t) => t.join('/')).sort(), ['1/0', '1/1']);
  assert.deepEqual(await getJSON('/precache/plan?layer=street&w=-180&e=180&s=-85&n=85&z0=1&z1=1'), { total: 4, missing: 2, limit: 40 });
  assert.deepEqual(await getJSON('/cache/clear?layer=street&w=0&e=1&s=0&n=1&z0=9&z1=1', { method: 'POST' }), { error: 'Bad request' });
  // put them back for the tests that follow
  await getJSON('/precache?layer=street&w=-180&e=180&s=-85&n=85&z0=1&z1=1');
  await until(async () => !(await getJSON('/precache/status')).running);
});

test('bulk download counts failures and can be cancelled', async () => {
  // zoom 9 tiles all 404 at the origin: 1 tile, 1 failure
  const one = await getJSON('/precache?layer=street&w=0.1&e=0.1&s=0.1&n=0.1&z0=9&z1=9');
  assert.equal(one.total, 1);
  await until(async () => !(await getJSON('/precache/status')).running);
  assert.equal((await getJSON('/precache/status')).failed, 1);

  // 16 new tiles at zoom 2 take >1.5 s because of the politeness delay; cancel partway
  const big = await getJSON('/precache?layer=street&w=-180&e=180&s=-85&n=85&z0=2&z1=2');
  assert.equal(big.total, 16);
  await sleep(300);
  assert.deepEqual(await getJSON('/precache/cancel'), { ok: true });
  await until(async () => !(await getJSON('/precache/status')).running);
  const st = await getJSON('/precache/status');
  assert.equal(st.cancel, true);
  assert.ok(st.done >= 1 && st.done < 16, `stopped early (done=${st.done})`);
  // Everything that finished before the cancel stays on disk, and a new plan only asks for the rest.
  const onDisk = (await getJSON('/cache/coverage?layer=street&z=2')).tiles.length;
  assert.equal(onDisk, st.done - st.failed, 'finished tiles were kept');
  const again = await getJSON('/precache/plan?layer=street&w=-180&e=180&s=-85&n=85&z0=2&z1=2');
  assert.deepEqual(again, { total: 16, missing: 16 - onDisk, limit: 40 });
});

test('POST /cache/clear deletes one layer\'s saved tiles; GET is not a way to do it', async () => {
  assert.ok(Object.keys((await getJSON('/cache/summary?layer=street')).zooms).length > 0, 'there is something to delete');
  assert.equal((await get('/cache/clear?layer=street')).status, 404);
  assert.deepEqual(await getJSON('/cache/clear?layer=moon', { method: 'POST' }), { error: 'Bad layer' });
  assert.deepEqual(await getJSON('/cache/clear?layer=street', { method: 'POST' }), { ok: true });
  assert.deepEqual((await getJSON('/cache/summary?layer=street')).zooms, {});
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'cache', 'tiles', 'street')));
  assert.deepEqual(await getJSON('/cache/clear?layer=street', { method: 'POST' }), { ok: true }, 'clearing an empty layer is fine');
});

test('saved tiles are still there after the hub is stopped and started again', async () => {
  assert.deepEqual(await getJSON('/precache?layer=street&w=-180&e=180&s=-85&n=85&z0=0&z1=0'), { total: 1 });
  await until(async () => !(await getJSON('/precache/status')).running);
  await hub.close();
  hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false });
  base = `http://127.0.0.1:${hub.web.address().port}`;
  const sum = await getJSON('/cache/summary?layer=street');
  assert.equal(sum.zooms['0'].tiles, 1);
  assert.deepEqual(await getJSON('/precache/plan?layer=street&w=-180&e=180&s=-85&n=85&z0=0&z1=0'), { total: 1, missing: 0, limit: 40 });
  assert.equal(hits['/0/0/0.png'], 1, 'served from disk, not re-downloaded');
});
