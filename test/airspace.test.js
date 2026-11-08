'use strict';
// Airspace: normalisation of FAA data, the hub's fetch/cache/offline behaviour against a fake FAA server,
// the user's own GeoJSON files, and the dashboard's inside / will-enter logic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const A = require('../airspace.js');
const { loadDashboard } = require('./helpers/dashboard.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-air-'));
const FAIRBANKS = { w: -148.2, e: -147.2, s: 64.5, n: 65.1 };

// ---------- a fake FAA ----------
let srv, base, hits, mode, T;
const SERVICES = { Class_Airspace: 'faa-class.json', Special_Use_Airspace: 'faa-sua.json', FAA_UAS_FacilityMap_Data: 'faa-uasfm.json', Recreational_Flyer_Fixed_Sites: 'faa-sites.json', National_Defense_Airspace_TFR_Areas: null, Part_Time_National_Security_UAS_Flight_Restrictions: null };
before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), svc = (u.pathname.match(/arcgis\/([^/]+)\/FeatureServer/) || [])[1] || (u.pathname === '/tfr' ? 'TFR' : '?');
    hits[svc] = (hits[svc] || 0) + 1; hits._urls.push(req.url);
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (mode === 'down') { res.writeHead(503); return res.end('unavailable'); }
    if (mode === 'errbody') return json({ error: { code: 400, message: 'Invalid query parameters' } });
    if (svc === 'TFR') return json(fx('tfr-wfs.json'));
    if (!(svc in SERVICES)) return json({ error: { message: 'no such service' } });
    if (mode === 'paged' && svc === 'Special_Use_Airspace') {
      const sua = fx('faa-sua.json').features.filter((f) => /SYNTHETIC TEST [RP]/.test(f.properties.NAME));
      return u.searchParams.get('resultOffset') ? json({ type: 'FeatureCollection', features: [sua[1]] }) : json({ type: 'FeatureCollection', properties: { exceededTransferLimit: true }, features: [sua[0]] });
    }
    return json(SERVICES[svc] ? fx(SERVICES[svc]) : { type: 'FeatureCollection', features: [] });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());
const reset = () => { hits = { _urls: [] }; mode = 'ok'; T = 1.8e12; };
const get = (u) => new Promise((resolve, reject) => http.get(u, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => (r.statusCode === 200 ? resolve(Buffer.concat(c)) : reject(new Error('HTTP ' + r.statusCode)))); }).on('error', reject));
const make = (o = {}) => A.createAirspace({ dir: o.dir || tmp(), fetchJSON: (u) => get(u).then((b) => JSON.parse(b)), now: () => T, faaBase: base + '/arcgis', tfrBase: base + '/tfr', ...o });

// ---------- normalisation ----------
test('controlled airspace: class, name, floor and ceiling; Class A and high-floor Class E are dropped', () => {
  const out = fx('faa-class.json').features.map((f) => A.normalizeFeature('class', f)).filter(Boolean);
  const byName = Object.fromEntries(out.map((f) => [f.properties.name, f.properties]));
  assert.deepEqual(Object.keys(byName).sort(), ['Fairbanks International Airport Class D', 'Fairbanks International Airport Class E4', 'Fairbanks, Eielson AFB Class E2', 'Fairbanks, Ladd AAF Class D']);
  const d = byName['Fairbanks International Airport Class D'];
  assert.equal(d.kind, 'class-d'); assert.equal(d.floorTxt, 'SFC'); assert.equal(d.ceilTxt, '2,900 ft'); assert.equal(d.ceilFt, 2900); assert.match(d.note, /PAFA/);
  assert.equal(byName['Fairbanks International Airport Class E4'].ceilTxt, null, 'a ceiling of -9998 means no published limit');
  assert.equal(byName['Fairbanks, Eielson AFB Class E2'].kind, 'class-e');
  const wide = fx('faa-class.json').features.map((f) => A.normalizeFeature('class', f, { maxFloorFt: 1000 })).filter(Boolean);
  assert.ok(wide.some((f) => /Class E5/.test(f.properties.name)), 'the 700 ft Class E shelf appears when the floor limit is raised');
  assert.ok(!wide.some((f) => /Class A/.test(f.properties.name)), 'Class A never does');
});

test('special use: type codes map to kinds, flight levels convert, high floors drop out, notes carry times of use', () => {
  const f = fx('faa-sua.json').features;
  const norm = (o) => f.map((x) => A.normalizeFeature('sua', x, o)).filter(Boolean).map((x) => x.properties);
  const low = norm({});
  assert.deepEqual(low.map((p) => [p.kind, p.name]).sort(), [['prohibited', 'Synthetic Test P-9998'], ['restricted', 'Synthetic Test R-9999']]);
  assert.match(low.find((p) => p.kind === 'restricted').note, /Times of use: TEST DATA/);
  const all = norm({ maxFloorFt: 20000 });
  const moa = all.find((p) => p.kind === 'moa'); assert.ok(moa, 'the real Delta 1 MOA appears when floors up to 20,000 ft are wanted'); assert.equal(moa.floorTxt, '10,000 ft'); assert.equal(moa.ceilTxt, 'FL180');
  assert.equal(all.find((p) => /W-1/.test(p.name)).ceilTxt, 'FL500');
});

test('TFRs, drone ceilings and flying sites normalise; TFRs ignore the floor filter', () => {
  const tfr = fx('tfr-wfs.json').features.map((f) => A.normalizeFeature('tfr', f, { maxFloorFt: 0 }).properties);
  assert.ok(tfr.every((p) => p.kind === 'tfr' && p.floorFt === 0)); assert.match(tfr[0].note, /NOTAM \d\/\d+/); assert.match(tfr[0].note, /tfr\.faa\.gov/);
  const ux = fx('faa-uasfm.json').features.map((f) => A.normalizeFeature('uasfm', f).properties);
  assert.ok(ux.length === 14 && ux.every((p) => p.kind === 'uasfm' && Number.isFinite(p.ceilingFt) && p.floorTxt === 'SFC'));
  assert.ok(ux.some((p) => p.ceilingFt === 0) && ux.some((p) => p.ceilingFt > 0));
  const site = A.normalizeFeature('sites', fx('faa-sites.json').features[0]).properties;
  assert.equal(site.kind, 'site'); assert.equal(site.name, 'Midnight Sun RC Inc 1'); assert.match(site.note, /ceiling 400 Feet/);
});

test('bad input is rejected rather than drawn: no geometry, points, impossible coordinates, unknown source', () => {
  const ok = fx('faa-class.json').features[0];
  assert.equal(A.normalizeFeature('class', { ...ok, geometry: null }), null);
  assert.equal(A.normalizeFeature('class', { ...ok, geometry: { type: 'Point', coordinates: [1, 2] } }), null);
  assert.equal(A.normalizeFeature('class', { ...ok, geometry: { type: 'Polygon', coordinates: [[[500, 10], [501, 10], [501, 11], [500, 10]]] } }), null);
  assert.equal(A.normalizeFeature('nonsense', ok), null);
  assert.equal(A.normalizeFeature('uasfm', { ...ok, properties: { CEILING: null } }), null);
  const a = A.normalizeFeature('class', ok), b = A.normalizeFeature('class', JSON.parse(JSON.stringify(ok)));
  assert.equal(a.properties.key, b.properties.key, 'the same feature always gets the same key');
});

test('helpers: feet, altitude text, title case, cells', () => {
  assert.equal(A.feet('600', 'FL'), 60000); assert.equal(A.feet(2900, 'FT'), 2900); assert.equal(A.feet(-9998, 'FT'), null); assert.equal(A.feet('x', 'FT'), null);
  assert.equal(A.altTxt(0), 'SFC'); assert.equal(A.altTxt(1200), '1,200 ft'); assert.equal(A.altTxt(18000), 'FL180'); assert.equal(A.altTxt(null), null);
  assert.equal(A.titleCase('FAIRBANKS, LADD AAF CLASS D'), 'Fairbanks, Ladd AAF Class D'); assert.equal(A.titleCase('R-2205 EIELSON AFB'), 'R-2205 Eielson AFB');
  const c = A.cellsFor(FAIRBANKS, 1); assert.equal(c.length, 4);
  for (const x of c) assert.ok(x.e - x.w === 1 && x.n - x.s === 1);
  assert.ok(c.some((x) => x.w <= -147.9 && x.e >= -147.9 && x.s <= 64.8 && x.n >= 64.8), 'Fairbanks lies in one of them');
});

// ---------- hub: fetch, cache, offline ----------
test('query returns normalised, de-duplicated features inside the box, with data age, and fetches each cell once', async () => {
  reset(); const air = make(), r = await air.query(['controlled', 'special', 'tfr', 'sites'], FAIRBANKS);
  const c = r.layers.controlled; assert.deepEqual(c.errors, []); assert.equal(c.stale, false); assert.equal(c.fetched, T);
  const names = c.features.map((f) => f.properties.name);
  assert.equal(new Set(names).size, names.length, 'the same feature from four cells appears once');
  assert.ok(names.includes('Fairbanks International Airport Class D') && names.includes('Fairbanks, Ladd AAF Class D'));
  assert.equal(hits.Class_Airspace, 4, 'four 1-degree cells');
  assert.deepEqual(r.layers.special.features.map((f) => f.properties.kind).sort(), ['prohibited', 'restricted']);
  assert.equal(r.layers.sites.features[0].properties.name, 'Midnight Sun RC Inc 1');
  assert.ok(r.advisory.includes('Advisory only'));
  const far = await air.query(['controlled', 'sites', 'tfr'], { w: -98, e: -96, s: 25, n: 27 });
  assert.equal(far.layers.controlled.features.length, 0, 'features from other places are not returned');
  assert.equal(far.layers.sites.features.length, 0);
  assert.ok(far.layers.tfr.features.every((f) => /TX/.test(f.properties.name) || /Padre/.test(f.properties.name)), 'only the Texas TFR is near Texas');
});

test('a second look is served from disk; data older than its lifetime is fetched again', async () => {
  reset(); const dir = tmp(), air = make({ dir });
  await air.query(['controlled'], FAIRBANKS); assert.equal(hits.Class_Airspace, 4);
  await air.query(['controlled'], FAIRBANKS); assert.equal(hits.Class_Airspace, 4, 'cached');
  const reopened = make({ dir }); const r = await reopened.query(['controlled'], FAIRBANKS);
  assert.equal(hits.Class_Airspace, 4, 'and the cache survives a restart'); assert.ok(r.layers.controlled.features.length >= 3);
  T += 15 * 864e5; await air.query(['controlled'], FAIRBANKS); assert.equal(hits.Class_Airspace, 8, 'refreshed after two weeks');
  const files = fs.readdirSync(path.join(dir, 'cache', 'controlled')); assert.ok(files.length === 4 && files.every((f) => f.endsWith('.json')), 'no half-written files left behind');
});

test('TFRs are refreshed every few minutes, not every few weeks', async () => {
  reset(); const air = make(); await air.query(['tfr'], { w: -149.5, e: -148.5, s: 64, n: 65 }); const n = hits.TFR;
  T += 5 * 60e3; await air.query(['tfr'], { w: -149.5, e: -148.5, s: 64, n: 65 }); assert.equal(hits.TFR, n, 'five minutes: still fresh');
  T += 6 * 60e3; await air.query(['tfr'], { w: -149.5, e: -148.5, s: 64, n: 65 }); assert.ok(hits.TFR > n, 'eleven minutes: fetched again');
});

test('when the FAA cannot be reached, the saved copy is used and marked, and the FAA is not hammered', async () => {
  reset(); const air = make(); const first = await air.query(['controlled'], FAIRBANKS);
  T += 15 * 864e5; mode = 'down'; const before = hits.Class_Airspace;
  const r = await air.query(['controlled'], FAIRBANKS);
  assert.equal(r.layers.controlled.stale, true); assert.equal(r.layers.controlled.features.length, first.layers.controlled.features.length);
  assert.match(r.layers.controlled.errors[0], /Could not reach the FAA/); assert.ok(r.layers.controlled.fetched < T);
  const after1 = hits.Class_Airspace; assert.ok(after1 > before);
  await air.query(['controlled'], FAIRBANKS); assert.equal(hits.Class_Airspace, after1, 'a minute of back-off before trying again');
  T += 61e3; mode = 'ok'; const back = await air.query(['controlled'], FAIRBANKS);
  assert.equal(back.layers.controlled.stale, false); assert.deepEqual(back.layers.controlled.errors, []);
});

test('nothing saved and no internet: empty with a plain explanation, never an exception', async () => {
  reset(); mode = 'down'; const r = await make().query(['controlled', 'special', 'uasfm'], { w: -147.8, e: -147.7, s: 64.8, n: 64.9 });
  for (const k of ['controlled', 'special', 'uasfm']) { assert.deepEqual(r.layers[k].features, []); assert.equal(r.layers[k].fetched, null); assert.match(r.layers[k].errors[0], /Could not reach the FAA/); }
});

test('an error reply from the FAA service (HTTP 200 with an error body) counts as a failure', async () => {
  reset(); mode = 'errbody'; const r = await make().query(['controlled'], { w: -147.8, e: -147.7, s: 64.8, n: 64.9 });
  assert.match(r.layers.controlled.errors[0], /Invalid query parameters/);
});

test('results the FAA pages (exceededTransferLimit) are all collected', async () => {
  reset(); mode = 'paged'; const r = await make().query(['special'], { w: -147.95, e: -147.4, s: 64.7, n: 65.0 });
  assert.deepEqual(r.layers.special.features.map((f) => f.properties.kind).sort(), ['prohibited', 'restricted']);
  assert.ok(hits._urls.some((u) => /resultOffset=2000/.test(u)));
});

test('views too wide for a layer are skipped with a reason, instead of fetching a country', async () => {
  reset(); const air = make(), r = await air.query(['uasfm', 'controlled', 'tfr'], { w: -155, e: -145, s: 60, n: 70 });
  assert.match(r.layers.uasfm.skipped, /zoom in/); assert.match(r.layers.controlled.skipped, /zoom in/); assert.equal(r.layers.tfr.skipped, 'zoom in to see this layer');
  assert.equal(hits._urls.length, 0, 'no requests were made');
  const box = { w: -147.70, e: -147.66, s: 64.86, n: 64.88 }, ok = await air.query(['uasfm'], box);
  const want = fx('faa-uasfm.json').features.map((f) => A.normalizeFeature('uasfm', f).properties.bb).filter((b) => b[0] <= box.e && b[2] >= box.w && b[1] <= box.n && b[3] >= box.s).length;
  assert.equal(ok.layers.uasfm.skipped, null); assert.ok(want > 0); assert.equal(ok.layers.uasfm.features.length, want, 'exactly the cells in view');
});

test('with downloading switched off, only what is already saved is used', async () => {
  reset(); const dir = tmp(); await make({ dir }).query(['controlled'], FAIRBANKS); const n = hits.Class_Airspace;
  const off = make({ dir, remote: false });
  assert.ok((await off.query(['controlled'], FAIRBANKS)).layers.controlled.features.length >= 3);
  const none = await off.query(['special'], FAIRBANKS); assert.match(none.layers.special.errors[0], /switched off/); assert.equal(hits.Class_Airspace, n);
  T += 40 * 864e5; const stale = await off.query(['controlled'], FAIRBANKS); assert.equal(stale.layers.controlled.stale, true); assert.equal(hits.Class_Airspace, n, 'old data is still better than none, and nothing is fetched');
});

// ---------- the user's own files ----------
test('your own GeoJSON files appear as a layer: polygons, circles from a point and radius, odd kinds; bad files are reported', async () => {
  reset(); const dir = tmp();
  const poly = { type: 'Feature', properties: { name: 'My field', kind: 'restricted', floor: 0, ceiling: 400, note: 'Neighbour asked us not to' }, geometry: { type: 'Polygon', coordinates: [[[-147.80, 64.80], [-147.75, 64.80], [-147.75, 64.83], [-147.80, 64.83], [-147.80, 64.80]]] } };
  const circ = { type: 'Feature', properties: { name: 'School', kind: 'made-up', radius_m: 500 }, geometry: { type: 'Point', coordinates: [-147.70, 64.85] } };
  fs.writeFileSync(path.join(dir, 'mine.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [poly, circ, { type: 'Feature', properties: {}, geometry: null }] }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'ignored');
  const air = make({ dir }), r = (await air.query(['local'], FAIRBANKS)).layers.local;
  assert.equal(r.features.length, 2); assert.equal(r.local, true);
  const f = Object.fromEntries(r.features.map((x) => [x.properties.name, x.properties]));
  assert.equal(f['My field'].kind, 'restricted'); assert.equal(f['My field'].floorTxt, 'SFC'); assert.equal(f['My field'].ceilTxt, '400 ft'); assert.equal(f['My field'].note, 'Neighbour asked us not to');
  assert.equal(f['School'].kind, 'custom', 'unknown kinds are drawn as your own area');
  const bb = r.features.find((x) => x.properties.name === 'School').properties.bb; assert.ok(Math.abs((bb[2] - bb[0]) * 111320 * Math.cos(64.85 * Math.PI / 180) - 1000) < 20, 'a 500 m radius makes a circle about 1 km across');
  assert.equal(r.errors.length, 1); assert.match(r.errors[0], /broken\.json/);
  assert.equal((await air.query(['local'], { w: -120, e: -119, s: 30, n: 31 })).layers.local.features.length, 0, 'only what is in view');
  fs.writeFileSync(path.join(dir, 'mine.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [poly] })); const t = Date.now() / 1000 + 5; fs.utimesSync(path.join(dir, 'mine.geojson'), t, t);
  assert.equal((await air.query(['local'], FAIRBANKS)).layers.local.features.length, 1, 'edited files are re-read');
});

// ---------- the dashboard: inside / will enter ----------
test('point in polygon: holes, multipolygons, edges of the world', () => {
  const { D } = loadDashboard(), sq = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
  const donut = { type: 'Polygon', coordinates: [sq(0, 0, 10, 10), sq(4, 4, 6, 6)] };
  assert.equal(D.geomHas(donut, 2, 2), true); assert.equal(D.geomHas(donut, 5, 5), false, 'inside the hole'); assert.equal(D.geomHas(donut, 11, 5), false);
  const multi = { type: 'MultiPolygon', coordinates: [[sq(0, 0, 1, 1)], [sq(5, 5, 6, 6)]] };
  assert.equal(D.geomHas(multi, 5.5, 5.5), true); assert.equal(D.geomHas(multi, 3, 3), false);
  assert.equal(D.geomHas(null, 0, 0), false); assert.equal(D.geomHas({ type: 'Point', coordinates: [0, 0] }, 0, 0), false);
});

const feat = (kind, name, w, s, e, n, extra = {}) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: { key: name, kind, name, floorFt: 0, ceilFt: 2900, bb: [w, s, e, n], ...extra } });

test('what is the aircraft inside? low floors only; the worst severity wins; sites and MOAs never warn', () => {
  const { D } = loadDashboard();
  const data = { controlled: [feat('class-d', 'Class D', -147.80, 64.80, -147.70, 64.90), feat('class-e', 'High shelf', -147.80, 64.80, -147.70, 64.90, { floorFt: 700 })],
    special: [feat('restricted', 'R-1', -147.76, 64.84, -147.72, 64.88), feat('moa', 'MOA', -148, 64, -147, 65)], sites: [feat('site', 'Club', -147.78, 64.82, -147.74, 64.86)],
    uasfm: [feat('uasfm', 'Grid 0', -147.79, 64.81, -147.71, 64.89, { ceilingFt: 0 }), feat('uasfm', 'Grid 400', -147.79, 64.81, -147.71, 64.89, { ceilingFt: 400 })] };
  const here = [...D.asAt(64.855, -147.745, data).map((f) => f.properties.name)].sort();
  assert.deepEqual(here, ['Class D', 'Club', 'Grid 0', 'Grid 400', 'MOA', 'R-1'], 'the 700 ft shelf is above 400 ft and ignored');
  assert.deepEqual([D.asSev(data.special[0].properties), D.asSev(data.controlled[0].properties), D.asSev(data.special[1].properties), D.asSev(data.sites[0].properties), D.asSev(data.uasfm[0].properties), D.asSev(data.uasfm[1].properties)], [3, 2, 0, 0, 2, 0]);
  assert.equal(D.asAt(64.5, -147.5, data).length, 1, 'only the MOA there');
  assert.equal(D.asAt(10, 10, data).length, 0);
});

test('path warnings: first new area on the way, with the time; areas already inside do not repeat', () => {
  const { D } = loadDashboard(), lat = 64.85, lon = -147.80, dLon = (m) => m / (111320 * Math.cos(lat * Math.PI / 180));
  const R = feat('restricted', 'R-1', lon + dLon(300), 64.80, lon + dLon(500), 64.90);
  const data = { special: [R, feat('moa', 'MOA', lon - 1, 64, lon + 1, 65), feat('class-d', 'Inside D', lon - dLon(100), 64.80, lon + dLon(100), 64.90)] };
  const pr = D.predictPath(lat, lon, 90, 20, 0, 30), hit = D.asPathHit(pr, data);
  assert.equal(hit.f.properties.name, 'R-1'); assert.equal(hit.s, 3);
  assert.ok(hit.t > 14 && hit.t < 16.5, `300 m at 20 m/s is 15 s, said ${hit.t.toFixed(1)}`);
  assert.equal(D.asPathHit(D.predictPath(lat, lon, 270, 20, 0, 30), data), null, 'flying away');
  assert.equal(D.asPathHit(D.predictPath(lat, lon, 90, 20, 0, 10), data), null, 'too short to reach it');
  const turning = D.asPathHit(D.predictPath(lat, lon, 90, 20, 15, 30), data);
  assert.equal(turning, null, 'a right-hand turn curls away from it');
});
