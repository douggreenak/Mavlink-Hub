'use strict';
// The whole receive-and-display path against an INAV-style aircraft, including every kind of missing data:
// no GPS, no GPS fix yet, no airspeed sensor, no battery or current sensing, MAVLink 1, split packets,
// lost and damaged frames, link dropouts, and extra senders on the radio.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDashboard, tileMap } = require('./helpers/dashboard.js');
const { createSim } = require('../sim/inav-sim.js');

function fly(profile, seconds, fps = 30) {
  const h = loadDashboard(), sim = createSim(profile);
  h.run(sim, seconds, { fps, ui: true });
  return { h, D: h.D, sim, tiles: tileMap(h.D.tiles()) };
}
const num = (v) => /^-?\d+(\.\d+)?$/.test(v);

test('a fully equipped plane: every tile shows a real value, with sources labelled', () => {
  const { D, tiles, sim, h } = fly(['full'], 40);
  for (const k of ['Altitude', 'Ground speed', 'Airspeed', 'Climb', 'Heading', 'Throttle', 'Battery', 'Current', 'Battery left', 'GPS', 'Distance from start', 'RSSI', 'Pitch', 'Roll'])
    assert.ok(num(tiles[k].value), `${k} = ${tiles[k].value}`);
  assert.equal(tiles['Flight mode'].value, 'FBW A');
  assert.equal(tiles['Altitude'].unit, 'm above home');
  assert.equal(tiles['Distance from start'].unit, 'm from home');
  assert.match(tiles['GPS'].unit, /3D fix/);
  assert.ok(+tiles['Airspeed'].value > 55 && +tiles['Airspeed'].value < 80, 'airspeed in km/h near 19 m/s');
  assert.ok(+tiles['Battery'].value > 14 && +tiles['Battery'].value < 17, 'a 4S pack');
  assert.ok(D.P.length > 20);
  assert.ok(Math.abs(D.home().lat - 64.8378) < 1e-6 && Math.abs(D.home().lon + 147.7164) < 1e-6, 'home taken from GPS_GLOBAL_ORIGIN');
  assert.ok(D.St.t0 > 0 && !D.St.t1, 'flight timer started at arming');
  assert.ok(D.MX.gs > 15 && D.MX.as > 15 && D.MX.cur > 3 && D.MX.vmin > 14);
  assert.ok(!/NaN|undefined/.test(D.tiles()), 'nothing prints NaN');
  assert.match(D.sens(), /GPS <small>OK/); assert.match(D.sens(), /Airspeed <small>OK/); assert.match(D.sens(), /Battery voltage <small>OK/);
  assert.equal(D.mapMessage(D.P.length), null);
  assert.ok(D.lossPct() === null || D.lossPct() < 1, 'no loss on a clean link');
  assert.match(h.el('cellsub').textContent, /4S · pack average shown on every cell/, 'INAV repeats the pack average, and we say so');
});

test('no GPS fitted (INAV sends no position messages): honest tiles, attitude and altitude still work', () => {
  const { D, tiles, h } = fly(['minimal'], 40);
  assert.equal(D.V.GLOBAL_POSITION_INT, undefined); assert.equal(D.V.GPS_RAW_INT, undefined); assert.equal(D.V.GPS_GLOBAL_ORIGIN, undefined);
  assert.equal(D.gpsState().state, 'absent');
  assert.deepEqual(tiles['Ground speed'], { value: '–', unit: 'no GPS' });
  assert.deepEqual(tiles['GPS'], { value: '–', unit: 'no GPS fitted' });
  assert.equal(tiles['Distance from start'].value, '–');
  assert.deepEqual(tiles['Airspeed'], { value: '–', unit: 'no airspeed sensor' });
  assert.deepEqual(tiles['Battery'], { value: '–', unit: 'no battery sensor' });
  assert.deepEqual(tiles['Current'], { value: '–', unit: 'no current sensor' });
  assert.equal(tiles['Battery left'].value, '–', 'INAV reports 100% with no sensing; we do not');
  assert.ok(num(tiles['Altitude'].value) && /from HUD/.test(tiles['Altitude'].unit), 'altitude comes from the HUD message');
  assert.ok(num(tiles['Roll'].value) && num(tiles['Pitch'].value) && num(tiles['Heading'].value) && num(tiles['Climb'].value) && num(tiles['Throttle'].value));
  assert.equal(tiles['Flight mode'].value, 'FBW A');
  assert.equal(D.P.length, 0); assert.equal(D.Z.lat, undefined);
  assert.match(D.mapMessage(0), /not reporting a GPS position/);
  assert.match(D.mapMessage(0), /mavlink_pos_rate/);
  assert.equal(D.MX.gs, undefined); assert.equal(D.MX.as, undefined); assert.equal(D.MX.cur, undefined); assert.equal(D.MX.vmin, undefined); assert.equal(D.MX.dist, undefined);
  assert.ok(D.MX.alt > 0, 'altitude maximum still recorded from the HUD');
  assert.match(D.sens(), /GPS <small>not fitted/); assert.match(D.sens(), /Airspeed <small>not fitted/); assert.match(D.sens(), /Battery voltage <small>not fitted/); assert.match(D.sens(), /Current <small>not fitted/);
  assert.match(D.sens(), /Gyro <small>OK/);
  assert.match(h.el('cellsub').textContent, /No battery data yet/);
  assert.ok(!/NaN|undefined/.test(D.tiles()));
  assert.ok(D.St.t0 > 0, 'the flight timer runs from arming, not from a GPS fix');
});

test('GPS that has not locked yet: waiting messages, no zero-position track, then a clean start', () => {
  const h = loadDashboard(), sim = createSim(['nofix']), D = h.D;
  h.run(sim, 20, { fps: 30, ui: true });
  let tiles = tileMap(D.tiles());
  assert.equal(D.gpsState().state, 'nofix');
  assert.equal(D.P.length, 0, 'the 0,0 position INAV sends without a fix is never drawn');
  assert.deepEqual(tiles['GPS'], { value: '3', unit: 'sats, no fix' });
  assert.deepEqual(tiles['Ground speed'], { value: '–', unit: 'no GPS fix' });
  assert.match(D.mapMessage(0), /Waiting for a GPS fix \(3 satellites\)/);
  assert.equal(D.home(), null);
  h.run(sim, 20, { fps: 30, ui: true });
  tiles = tileMap(D.tiles());
  assert.equal(D.gpsState().state, 'fix');
  assert.ok(D.P.length > 10);
  const [la, lo] = D.P[0]; assert.ok(Math.abs(la - 64.8378) < 0.01 && Math.abs(lo + 147.7164) < 0.02, `first position is real: ${la},${lo}`);
  assert.ok(num(tiles['Ground speed'].value));
  assert.equal(D.mapMessage(D.P.length), null);
  assert.ok(D.home() && Math.abs(D.home().lat - 64.8378) < 1e-6);
});

test('GPS fix lost mid-flight: keep the last position, say so, stop using stale numbers', () => {
  const h = loadDashboard(), D = h.D, sim = createSim(['full']);
  h.run(sim, 30, { fps: 30, ui: true });
  const n = D.P.length, last = D.P[n - 1].slice();
  assert.ok(n > 10);
  sim.state.fix = 3; Object.defineProperty(sim.profile, 'fixAfter', { value: 1e9 });     // lose the fix from now on
  h.run(sim, 6, { fps: 30, ui: true });
  assert.equal(D.gpsState().state, 'nofix');
  assert.equal(D.P.length, n, 'nothing new is added to the track');
  assert.deepEqual(D.P[D.P.length - 1], last);
  assert.match(D.mapMessage(D.P.length), /GPS fix lost\. Showing the last known position/);
  assert.equal(tileMap(D.tiles())['Ground speed'].unit, 'no GPS fix');
});

test('no airspeed sensor: airspeed is not shown or recorded, everything else is unaffected', () => {
  const { D, tiles } = fly(['nopitot'], 30);
  assert.deepEqual(tiles['Airspeed'], { value: '–', unit: 'no airspeed sensor' });
  assert.equal(D.MX.as, undefined); assert.equal(D.Z.as, undefined);
  assert.ok(num(tiles['Ground speed'].value) && num(tiles['Battery'].value));
  assert.match(D.sens(), /Airspeed <small>not fitted/);
});

test('no battery sensing: voltage, current and percentage are all shown as missing', () => {
  const { D, tiles, h } = fly(['novbat'], 30);
  assert.deepEqual(tiles['Battery'], { value: '–', unit: 'no battery sensor' });
  assert.deepEqual(tiles['Current'], { value: '–', unit: 'no current sensor' });
  assert.equal(tiles['Battery left'].value, '–');
  assert.equal(D.MX.vmin, undefined); assert.equal(D.MX.cur, undefined);
  assert.equal(h.el('cells').innerHTML, '', 'no cell bars from a sensor that is not there');
  assert.ok(num(tiles['Ground speed'].value));
});

test('voltage but no current sensor: only the current is missing', () => {
  const { tiles, D } = fly(['noamp'], 30);
  assert.ok(num(tiles['Battery'].value) && num(tiles['Battery left'].value));
  assert.deepEqual(tiles['Current'], { value: '–', unit: 'no current sensor' });
  assert.equal(D.MX.cur, undefined); assert.ok(D.MX.vmin > 14);
});

test('MAVLink 1 (RC_CHANNELS_RAW, eight channels) is shown like MAVLink 2', () => {
  const { D, h } = fly(['v1'], 20);
  assert.ok(D.V.RC_CHANNELS_RAW && !D.V.RC_CHANNELS);
  assert.equal(D.rcFields().chancount, 8);
  const html = h.el('rc').innerHTML; assert.match(html, /CH8/); assert.ok(!/CH9/.test(html));
  assert.ok(D.rssiRaw() > 100, 'RSSI read from the raw message');
  assert.ok(D.P.length > 5 && D.V.GLOBAL_POSITION_INT.n > 5);
});

test('RC channels that do not exist (0 or 65535) show as missing, not as 0 or a full bar', () => {
  const h = loadDashboard(), D = h.D, M = require('../sim/mavlink.js');
  h.feed(M.frame('RC_CHANNELS', { chancount: 16, rssi: 180, chan1_raw: 1500, chan2_raw: 0, chan3_raw: 65535, chan4_raw: 2000 }));
  D.render(); const html = h.el('rc').innerHTML;
  assert.match(html, /CH1 1500/); assert.match(html, /CH2 –/); assert.match(html, /CH3 –/); assert.match(html, /CH4 2000/);
});

test('frames split across UDP packets decode exactly as if they had arrived whole', () => {
  const a = fly(['full'], 30), b = fly(['full', 'split'], 30);
  assert.equal(b.D.bad(), 0, 'splitting never looks like corruption');
  assert.ok(Math.abs(a.D.ok() - b.D.ok()) <= 2, `${a.D.ok()} vs ${b.D.ok()}`);
  for (const n of Object.keys(a.D.V)) assert.ok(Math.abs(a.D.V[n].n - (b.D.V[n]?.n ?? 0)) <= 1, n);
});

test('10% of frames lost: loss is measured from sequence numbers and the display carries on', () => {
  const { D, tiles } = fly(['lossy'], 40);
  const loss = D.lossPct();
  assert.ok(loss > 3 && loss < 20, `measured loss ${loss}%`);
  assert.ok(num(tiles['Ground speed'].value) && D.P.length > 10);
  assert.ok(!/NaN/.test(D.tiles()));
});

test('damaged frames are counted and discarded; no garbage reaches the display', () => {
  const { D, tiles } = fly(['corrupt'], 40);
  assert.ok(D.bad() > 5 && D.ok() > 100);
  for (const [la, lo] of D.P) assert.ok(Math.abs(la - 64.8378) < 0.05 && Math.abs(lo + 147.7164) < 0.1, `track point ${la},${lo}`);
  assert.ok(num(tiles['Altitude'].value) && !/NaN/.test(D.tiles()));
});

test('a ground-station heartbeat and a radio component on the same link do not hijack the aircraft', () => {
  const { D } = fly(['full', 'radio'], 30);
  assert.equal(D.V.HEARTBEAT.f.type, 1, 'still the aircraft');
  assert.equal(D.V.HEARTBEAT.f.autopilot, 0);
  assert.ok(D.V.RADIO_STATUS.n > 10);
  assert.ok(D.rssiRaw() > 100);
  assert.ok(D.lossPct() === null || D.lossPct() < 1, 'three interleaved senders are not mistaken for loss');
  assert.match(tileMap(D.tiles())['Flight mode'].value, /FBW A|Cruise/);
});

test('link dropouts: the map says so while silent and recovers when frames return', () => {
  const h = loadDashboard(), D = h.D, sim = createSim(['full', 'dropout']);
  h.run(sim, 28, { fps: 30, ui: true });            // silent from 25 s to 29 s
  assert.ok(h.clock.t - D.last() > 2000, 'no frames for over 2 s');
  assert.match(D.mapMessage(D.P.length), /No telemetry for \d+ s\. Showing the last known position/);
  h.run(sim, 5, { fps: 30, ui: true });
  assert.equal(D.mapMessage(D.P.length), null);
  assert.ok(h.clock.t - D.last() < 1000);
});

test('multirotor: copter mode names, and the same missing-data rules apply', () => {
  const h = loadDashboard(), D = h.D, sim = createSim(['copter', 'minimal']);
  h.run(sim, 20, { fps: 30, ui: true });
  assert.equal(D.V.HEARTBEAT.f.type, 2);
  assert.equal(tileMap(D.tiles())['Flight mode'].value, 'Alt hold');
  h.run(sim, 40, { fps: 30, ui: true });
  assert.equal(tileMap(D.tiles())['Flight mode'].value, 'Pos hold');
});

test('flight mode names come from the right table for the vehicle, and unknown numbers stay visible', () => {
  const { D } = loadDashboard();
  assert.equal(D.modeName({ type: 1, custom_mode: 12 }), 'Loiter');
  assert.equal(D.modeName({ type: 2, custom_mode: 6 }), 'RTL');
  assert.equal(D.modeName({ type: 1, custom_mode: 99 }), 'mode 99');
  assert.equal(D.modeName(undefined), null);
});

test('the flight timer follows arming and stops at disarming', () => {
  const h = loadDashboard(), D = h.D, M = require('../sim/mavlink.js');
  const hb = (armed) => M.frame('HEARTBEAT', { type: 1, autopilot: 0, base_mode: armed ? 129 : 1, custom_mode: 5, system_status: 4, mavlink_version: 3 });
  h.feed(hb(false)); assert.ok(!D.St.t0);
  h.clock.t += 5000; h.feed(hb(true)); const t0 = D.St.t0; assert.equal(t0, h.clock.t);
  h.clock.t += 60000; h.feed(hb(true)); assert.equal(D.St.t0, t0, 'staying armed does not restart it');
  h.feed(hb(false)); assert.equal(D.St.t1, h.clock.t);
  h.clock.t += 5000; h.feed(hb(true)); assert.equal(D.St.t0, h.clock.t, 're-arming starts a new flight'); assert.equal(D.St.t1, null);
});

test('nothing in a messy mix of missing sensors and bad links ever prints NaN or undefined', () => {
  for (const prof of [['minimal', 'lossy', 'split'], ['nofix', 'corrupt'], ['novbat', 'v1', 'dropout'], ['nopitot', 'nomag', 'radio', 'fast']]) {
    const { D } = fly(prof, 45);
    assert.ok(!/NaN|undefined|Infinity/.test(D.tiles()), prof.join(',') + ': ' + (D.tiles().match(/.{30}(NaN|undefined|Infinity).{10}/) || [''])[0]);
  }
});
