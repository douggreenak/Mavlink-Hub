'use strict';
// The hub's /airspace route, with the FAA replaced by a local fake.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-airhttp-'));
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));
let fake, hub, base, S, calls = 0;
before(async () => {
  fake = http.createServer((req, res) => { calls++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(/Class_Airspace/.test(req.url) ? fx('faa-class.json') : /tfr/.test(req.url) ? fx('tfr-wfs.json') : JSON.stringify({ type: 'FeatureCollection', features: [] })); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.DATA_DIR = dir; process.env.AIRSPACE_FAA_URL = `http://127.0.0.1:${fake.address().port}/arcgis`; process.env.AIRSPACE_TFR_URL = `http://127.0.0.1:${fake.address().port}/tfr`;
  fs.mkdirSync(path.join(dir, 'airspace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'airspace', 'club.geojson'), JSON.stringify({ type: 'Feature', properties: { name: 'Club safety zone', kind: 'restricted' }, geometry: { type: 'Polygon', coordinates: [[[-147.8, 64.8], [-147.7, 64.8], [-147.7, 64.9], [-147.8, 64.9], [-147.8, 64.8]]] } }));
  S = require('../server.js'); hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false }); base = `http://127.0.0.1:${hub.web.address().port}`;
});
after(async () => { await hub.close(); fake.close(); });
const get = (p) => new Promise((resolve, reject) => http.get(base + p, { agent: false }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(c)) })); }).on('error', reject));

test('/airspace answers with layers, data age and the advisory, and saves what it fetched under DATA_DIR', async () => {
  const r = await get('/airspace?layers=controlled,local&w=-148.2&s=64.5&e=-147.2&n=65.1');
  assert.equal(r.status, 200);
  assert.ok(r.body.layers.controlled.features.length >= 3 && r.body.layers.controlled.fetched > 0);
  assert.deepEqual(r.body.layers.local.features.map((f) => f.properties.name), ['Club safety zone']);
  assert.match(r.body.advisory, /Advisory only/);
  assert.ok(fs.existsSync(path.join(dir, 'airspace', 'cache', 'controlled')));
  const n = calls; await get('/airspace?layers=controlled&w=-148.2&s=64.5&e=-147.2&n=65.1'); assert.equal(calls, n, 'second request served from the saved copy');
});

test('bad requests get a plain error, not a crash', async () => {
  for (const q of ['', 'layers=controlled', 'layers=bogus&w=0&s=0&e=1&n=1', 'layers=controlled&w=a&s=0&e=1&n=1', 'layers=controlled&w=5&s=0&e=1&n=1', 'layers=controlled&w=0&s=0&e=1&n=95', 'layers=controlled&w=&s=0&e=1&n=1'])
    assert.deepEqual((await get('/airspace?' + q)).body, { error: 'Bad request' }, q);
});

test('/info tells the dashboard where your own airspace files go', async () => {
  const r = await get('/info'); assert.equal(r.body.airspaceDir, path.join(dir, 'airspace'));
});
