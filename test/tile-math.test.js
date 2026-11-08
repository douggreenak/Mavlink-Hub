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
