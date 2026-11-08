'use strict';
// The dashboard's message table, checked against definitions extracted from the official MAVLink XML.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDashboard } = require('./helpers/dashboard.js');
const M = require('../sim/mavlink.js');

const { D } = loadDashboard();
const T = { uint8_t: 'u8', int8_t: 'i8', uint16_t: 'u16', int16_t: 'i16', uint32_t: 'u32', int32_t: 'i32', float: 'f32', uint64_t: 'u64' };

test('the dashboard decodes exactly the messages in the spec table, with matching ids and names', () => {
  const have = Object.entries(D.defs).map(([id, d]) => `${id}:${d.name}`).sort();
  const want = Object.values(M.BY_NAME).map((m) => `${m.id}:${m.name}`).sort();
  assert.deepEqual(have, want);
});

test('every message: CRC_EXTRA, payload length and each field name, type and offset match the spec', () => {
  for (const [id, d] of Object.entries(D.defs)) {
    const m = M.BY_ID[id], lay = m.lay;
    assert.equal(d.extra, m.extra, `${d.name} CRC_EXTRA`);
    assert.equal(d.len, lay.baseLen, `${d.name} payload length`);
    assert.equal(d.fs.length, lay.base.length, `${d.name} field count`);
    lay.base.forEach((f, i) => {
      const x = d.fs[i];
      assert.equal(x.n, f.n, `${d.name} field ${i} name`);
      assert.equal(x.o, f.o, `${d.name}.${f.n} offset`);
      assert.equal(x.sz, f.sz, `${d.name}.${f.n} size`);
      if (f.t === 'char') assert.equal(x.t, 'c' + f.al, `${d.name}.${f.n} type`);
      else if (f.al) assert.equal(x.t, 'a' + f.al, `${d.name}.${f.n} type`);
      else assert.equal(x.t, T[f.t], `${d.name}.${f.n} type`);
    });
  }
});

test('the encoder agrees with the CRC_EXTRA values published for the messages INAV sends', () => {
  const known = { HEARTBEAT: 50, SYS_STATUS: 124, ATTITUDE: 39, GPS_RAW_INT: 24, GLOBAL_POSITION_INT: 104, VFR_HUD: 20, RC_CHANNELS: 118, RC_CHANNELS_RAW: 244, GPS_GLOBAL_ORIGIN: 39, BATTERY_STATUS: 154, STATUSTEXT: 83 };
  for (const [n, e] of Object.entries(known)) assert.equal(M.BY_NAME[n].extra, e, n);
});

test('encoder and reference decoder round-trip every message field, including arrays, text and extensions', () => {
  const vals = { BATTERY_STATUS: { id: 2, battery_function: 3, type: 1, temperature: -300, voltages: [4100, 4090, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535], current_battery: 1234, current_consumed: 555, energy_consumed: 777, battery_remaining: 88, time_remaining: 42, charge_state: 2 },
    STATUSTEXT: { severity: 4, text: 'LOW BATTERY', id: 9, chunk_seq: 1 }, GPS_RAW_INT: { time_usec: 123456789, lat: -648378000, lon: 1477164000, alt: -5000, eph: 90, epv: 65535, vel: 2150, cog: 35999, fix_type: 3, satellites_visible: 255, alt_ellipsoid: -100, yaw: 36000 } };
  for (const [name, v] of Object.entries(vals)) for (const v2 of [true, false]) {
    if (!v2 && name === 'STATUSTEXT') continue;
    const [got] = M.decodeAll(M.frame(name, v, { v2, seq: 9 }));
    assert.equal(got.name, name);
    for (const [k, x] of Object.entries(v)) { if (!v2 && M.BY_NAME[name].lay.ext.some((f) => f.n === k)) continue; assert.deepEqual(got.values[k], x, `${name}.${k} (${v2 ? 'v2' : 'v1'})`); }
  }
});
