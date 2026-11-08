'use strict';
// The byte-stream receive path: frames cut by packet boundaries, junk, odd headers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDashboard } = require('./helpers/dashboard.js');
const M = require('../sim/mavlink.js');

const hb = (o = {}) => M.frame('HEARTBEAT', { type: 1, autopilot: 0, base_mode: 65, custom_mode: 5, system_status: 3, mavlink_version: 3 }, o);
const fresh = () => { const h = loadDashboard(); return { h, D: h.D }; };

test('a frame split at every possible byte boundary decodes exactly once (v2, v1 and signed)', () => {
  for (const opts of [{}, { v2: false }, { signed: true }]) {
    const f = M.frame('GLOBAL_POSITION_INT', { lat: 648378000, lon: -1477164000, relative_alt: 1000 }, opts);
    for (let cut = 1; cut < f.length; cut++) {
      const { h, D } = fresh();
      h.feed(f.subarray(0, cut)); h.feed(f.subarray(cut));
      assert.equal(D.ok(), 1, `cut ${cut}/${f.length} ${JSON.stringify(opts)}`); assert.equal(D.bad(), 0);
      assert.equal(D.V.GLOBAL_POSITION_INT.f.lat, 648378000);
    }
  }
});

test('many frames cut at random places, byte by byte, arrive intact', () => {
  const { h, D } = fresh(), frames = [];
  for (let i = 0; i < 40; i++) frames.push(hb({ seq: i }), M.frame('VFR_HUD', { groundspeed: i, throttle: i }, { seq: i }), M.frame('STATUSTEXT', { severity: 6, text: 'n' + i }, { v2: i % 2 === 0, seq: i }));
  const all = Buffer.concat(frames);
  for (let i = 0; i < all.length; i++) h.feed(all.subarray(i, i + 1));
  assert.equal(D.ok(), frames.length); assert.equal(D.bad(), 0);
  assert.equal(D.V.VFR_HUD.n, 40); assert.equal(D.V.VFR_HUD.f.throttle, 39);
});

test('junk bytes between frames are skipped without losing the frames either side', () => {
  const { h, D } = fresh();
  h.feed(Buffer.concat([hb({ seq: 1 }), Buffer.from([0x00, 0x13, 0xff, 0x42]), hb({ seq: 2 }), Buffer.from([0xfd]), hb({ seq: 3 })]));
  assert.equal(D.V.HEARTBEAT.n, 3);
});

test('a stray start byte that claims a long frame does not swallow the frames after it', () => {
  const { h, D } = fresh();
  h.feed(Buffer.concat([Buffer.from([0xfd, 200, 0, 0]), hb({ seq: 1 }), hb({ seq: 2 })]));
  assert.equal(D.V.HEARTBEAT.n, 2);
  assert.equal(D.tail(), null, 'nothing left waiting');
});

test('a half frame that never completes is dropped after a second, and cannot poison what follows', () => {
  const { h, D } = fresh(), f = hb();
  h.feed(f.subarray(0, 6)); assert.ok(D.tail());
  h.clock.t += 1500;
  h.feed(hb({ seq: 9 }));
  assert.equal(D.V.HEARTBEAT.n, 1); assert.equal(D.bad(), 0);
});

test('a lone start byte at the end of a packet is not a CRC failure, and the next packet completes it', () => {
  const { h, D } = fresh(), f = hb();
  h.feed(Buffer.concat([hb({ seq: 1 }), f.subarray(0, 1)]));
  assert.equal(D.bad(), 0); assert.equal(D.V.HEARTBEAT.n, 1);
  h.feed(f.subarray(1)); assert.equal(D.V.HEARTBEAT.n, 2); assert.equal(D.bad(), 0);
});

test('v2 frames with incompatibility flags we do not understand are skipped, not misread', () => {
  const { h, D } = fresh(), f = Buffer.from(hb()); f[2] = 0x02;
  h.feed(Buffer.concat([f, hb({ seq: 5 })]));
  assert.equal(D.V.HEARTBEAT.n, 1);
});

test('frames from interleaved sources keep separate sequence counters', () => {
  // The radio's counter sits 100 away from the aircraft's. One shared counter would see a jump of 100 every other frame.
  const { h, D } = fresh();
  for (let i = 0; i < 60; i++) { h.feed(hb({ seq: i, sysid: 1, compid: 1 })); h.feed(M.frame('RADIO_STATUS', { rssi: 200 }, { seq: (i + 100) & 255, sysid: 1, compid: 68 })); }
  assert.equal(D.lossPct(), 0);
  // ...and a real gap in one source is still seen.
  for (let i = 60; i < 80; i++) { if (i % 4) h.feed(hb({ seq: i })); h.feed(M.frame('RADIO_STATUS', { rssi: 200 }, { seq: (i + 100) & 255, sysid: 1, compid: 68 })); }
  assert.ok(D.lossPct() > 2 && D.lossPct() < 12, `measured ${D.lossPct()}`);
});

test('sequence gaps are counted as loss, wrap-around at 255 is not, and a restart is not a huge loss', () => {
  const { h, D } = fresh();
  for (let i = 250; i < 250 + 60; i++) h.feed(hb({ seq: i & 255 }));
  assert.equal(D.lossPct(), 0, 'wrapping 255 -> 0 is continuous');
  const { h: h2, D: D2 } = fresh();
  for (let i = 0; i < 60; i++) if (i % 5 !== 3) h2.feed(hb({ seq: i }));        // every fifth frame lost
  assert.ok(Math.abs(D2.lossPct() - 20) < 3, `measured ${D2.lossPct()}`);
});

test('GPS_GLOBAL_ORIGIN becomes the home point; zeros mean not set yet', () => {
  const { h, D } = fresh();
  h.feed(M.frame('GPS_GLOBAL_ORIGIN', { latitude: 0, longitude: 0, altitude: 0 })); assert.equal(D.home(), null);
  h.feed(M.frame('GPS_GLOBAL_ORIGIN', { latitude: 648378000, longitude: -1477164000, altitude: 140000 }));
  assert.deepEqual({ ...D.home() }, { lat: 64.8378, lon: -147.7164 });
});
