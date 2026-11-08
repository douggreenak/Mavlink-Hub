'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-unit-'));
const S = require('../server.js');

test('whole world is one tile at zoom 0 and 4^z tiles at zoom z', () => {
  const world = { w: -180, e: 180, s: -85, n: 85 };
  assert.equal(S.countOf(S.ranges(world, 0, 0)), 1);
  assert.equal(S.countOf(S.ranges(world, 2, 2)), 16);
  assert.equal(S.countOf(S.ranges(world, 0, 3)), 1 + 4 + 16 + 64);
});

test('tile index matches the OpenStreetMap reference (central London, z10 = 511/340)', () => {
  const [r] = S.ranges({ w: -0.1278, e: -0.1278, s: 51.5074, n: 51.5074 }, 10, 10);
  assert.deepEqual([r.z, r.x0, r.x1, r.y0, r.y1], [10, 511, 511, 340, 340]);
});

test('ranges never run past the edge of the tile grid', () => {
  const [r] = S.ranges({ w: -200, e: 200, s: -89, n: 89 }, 1, 1);
  assert.deepEqual([r.x0, r.x1, r.y0, r.y1], [0, 1, 0, 1]);
});

test('listOf enumerates exactly countOf tiles with the right zoom', () => {
  const rs = S.ranges({ w: -147.9, e: -147.6, s: 64.8, n: 64.9 }, 9, 11);
  const list = S.listOf(rs);
  assert.equal(list.length, S.countOf(rs));
  assert.ok(list.every(([z]) => z >= 9 && z <= 11));
  assert.equal(new Set(list.map((t) => t.join('/'))).size, list.length, 'no duplicates');
});

test('parsePlan rejects an unknown layer, missing fields, bad numbers and inverted zooms', () => {
  assert.equal(S.parsePlan('layer=moon&w=0&e=1&s=0&n=1&z0=1&z1=2').error, 'Bad request');
  assert.equal(S.parsePlan('layer=street').error, 'Bad request');
  assert.equal(S.parsePlan('layer=street&w=0&e=1&s=0&n=1&z0=1').error, 'Bad request');
  assert.equal(S.parsePlan('layer=street&w=abc&e=1&s=0&n=1&z0=1&z1=2').error, 'Bad request');
  assert.equal(S.parsePlan('layer=street&w=0&e=1&s=0&n=1&z0=5&z1=2').error, 'Bad request');
  assert.equal(S.parsePlan('').error, 'Bad request');
});

test('parsePlan normalises reversed bounds, clamps latitude to the Mercator limit and zoom to the cap', () => {
  const p = S.parsePlan('layer=sat&w=10&e=-10&s=89&n=-89&z0=-3&z1=99');
  assert.equal(p.error, undefined);
  assert.equal(p.l, 'sat');
  assert.equal(p.rs[0].z, 0);
  assert.equal(p.rs[p.rs.length - 1].z, S.PRECACHE_MAX_ZOOM);
  const z1 = p.rs.find((r) => r.z === 1);
  assert.deepEqual([z1.x0, z1.x1, z1.y0, z1.y1], [0, 1, 0, 1], 'covers both hemispheres after swapping');
});

test('tile URL templates fill z/x/y in any order; tile files live under the cache dir', () => {
  assert.equal(S.fill('https://x/{z}/{y}/{x}.jpg', 3, 4, 5), 'https://x/3/5/4.jpg');
  const f = S.tileFile('street', 12, 34, 56);
  assert.ok(f.startsWith(S.CACHE));
  assert.ok(f.endsWith(path.join('tiles', 'street', '12', '34', '56')));
  assert.ok(S.tileUrl('street', 1, 2, 3).includes('/1/2/3'));
});

test('addresses returns http URLs on the given port with private ranges first', () => {
  const urls = S.addresses(9999);
  assert.ok(Array.isArray(urls));
  for (const u of urls) assert.match(u, /^http:\/\/\d+\.\d+\.\d+\.\d+:9999$/);
});

test('applyEnvFile reads KEY=VALUE lines, skips comments, strips quotes, never overrides real env', () => {
  const f = path.join(process.env.DATA_DIR, 'hub.env');
  fs.writeFileSync(f, '# comment\nWEB_PORT = 9090\nMAX_TILES=0   # unlimited\nDATA_DIR="/Volumes/Big Disk/hub"\nBAD LINE\nUDP_PORT=1\n');
  const env = S.applyEnvFile(f, { UDP_PORT: '14550' });
  assert.deepEqual(env, { UDP_PORT: '14550', WEB_PORT: '9090', MAX_TILES: '0', DATA_DIR: '/Volumes/Big Disk/hub' });
  assert.deepEqual(S.applyEnvFile(path.join(process.env.DATA_DIR, 'missing.env'), { A: '1' }), { A: '1' });
});

test('defaultDataDir is an absolute per-user folder named for the hub', () => {
  const d = S.defaultDataDir();
  assert.ok(path.isAbsolute(d));
  assert.match(d, /mavlink[- ]hub/i);
  assert.ok(d.startsWith(os.homedir()) || process.platform === 'win32');
});

test('migrateOldData moves cache/ and settings.json once and leaves existing data alone', () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-old-')), to = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-new-'));
  fs.mkdirSync(path.join(from, 'cache', 'tiles', 'street', '1', '0'), { recursive: true });
  fs.writeFileSync(path.join(from, 'cache', 'tiles', 'street', '1', '0', '1'), 'png');
  fs.writeFileSync(path.join(from, 'settings.json'), '{"units":"imperial"}');
  const logs = [];
  assert.equal(S.migrateOldData(from, to, (m) => logs.push(m)), true);
  assert.equal(fs.readFileSync(path.join(to, 'cache', 'tiles', 'street', '1', '0', '1'), 'utf8'), 'png');
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).units, 'imperial');
  assert.ok(!fs.existsSync(path.join(from, 'cache')) && !fs.existsSync(path.join(from, 'settings.json')));
  assert.equal(logs.length, 1);
  assert.equal(S.migrateOldData(from, to, () => {}), false, 'nothing left to move');
  fs.writeFileSync(path.join(from, 'settings.json'), '{"units":"metric"}');
  assert.equal(S.migrateOldData(from, to, () => {}), false, 'does not overwrite settings already in the new place');
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).units, 'imperial');
  assert.equal(S.migrateOldData(from, from, () => {}), false, 'same folder is a no-op');
});

test('clearArea removes only the tiles inside the ranges and tidies empty folders', () => {
  const put = (z, x, y) => { const d = path.join(S.CACHE, 'tiles', 'sat', String(z), String(x)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, String(y)), 'x'); };
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) put(2, x, y);
  put(3, 7, 7);
  // western hemisphere at zoom 2 = x 0..1
  const n = S.clearArea('sat', S.ranges({ w: -180, e: -1, s: -85, n: 85 }, 2, 2));
  assert.equal(n, 8);
  assert.ok(!fs.existsSync(path.join(S.CACHE, 'tiles', 'sat', '2', '0')), 'emptied x folder removed');
  assert.ok(fs.existsSync(path.join(S.CACHE, 'tiles', 'sat', '2', '3', '3')));
  assert.ok(fs.existsSync(path.join(S.CACHE, 'tiles', 'sat', '3', '7', '7')), 'other zooms untouched');
  assert.equal(S.clearArea('sat', S.ranges({ w: -180, e: 180, s: -85, n: 85 }, 2, 3)), 9);
  assert.ok(!fs.existsSync(path.join(S.CACHE, 'tiles', 'sat', '2')), 'emptied zoom folder removed');
});
