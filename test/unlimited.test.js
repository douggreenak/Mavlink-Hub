'use strict';
// MAX_TILES=0 means no cap on bulk downloads (for people using their own tile server).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');

let origin, hub, base, S;
const agent = new http.Agent({ keepAlive: false });
const getJSON = (p) => new Promise((resolve, reject) => {
  http.get(base + p, { agent }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  origin = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('89504e47', 'hex')); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-unl-'));
  process.env.TILE_STREET_URL = `http://127.0.0.1:${origin.address().port}/{z}/{x}/{y}.png`;
  process.env.MAX_TILES = '0';
  S = require('../server.js');
  hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false });
  base = `http://127.0.0.1:${hub.web.address().port}`;
});
after(async () => { await hub.close(); origin.close(); });

test('MAX_TILES=0 reports no limit and accepts a plan far above the default cap', async () => {
  assert.equal(S.MAX_TILES, 0);
  const plan = await getJSON('/precache/plan?layer=street&w=-180&e=180&s=-85&n=85&z0=0&z1=5');
  assert.equal(plan.limit, 0);
  assert.equal(plan.total, 1 + 4 + 16 + 64 + 256 + 1024);
  const job = await getJSON('/precache?layer=street&w=-180&e=180&s=-85&n=85&z0=0&z1=5');
  assert.deepEqual(job, { total: 1365 });
  await sleep(200);
  await getJSON('/precache/cancel');
  const t = Date.now();
  while ((await getJSON('/precache/status')).running) { if (Date.now() - t > 5000) throw new Error('did not stop'); await sleep(25); }
  assert.ok((await getJSON('/precache/status')).done >= 1);
});
