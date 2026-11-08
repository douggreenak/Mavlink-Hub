#!/usr/bin/env node
'use strict';
// Test-flight simulator: sends INAV-style MAVLink over UDP to the hub, so the whole chain
// (radio -> hub -> browser) can be exercised without an aircraft.
//
//   node sim/inav-sim.js                       full plane, default INAV message rates
//   node sim/inav-sim.js --profile minimal     a bare-bones plane: no GPS, pitot or battery sensing
//   node sim/inav-sim.js --profile nofix,split GPS that takes 25 s to lock, frames split across packets
//   node sim/inav-sim.js --list                show every profile
//
// What it copies from INAV's real MAVLink telemetry (src/main/telemetry/mavlink.c):
//   - default stream rates: attitude, airspeed/HUD, position and status all at 2 Hz, RC and battery at 1 Hz
//   - no GPS fitted  -> no GPS_RAW_INT / GLOBAL_POSITION_INT / GPS_GLOBAL_ORIGIN at all, ground speed 0
//   - no pitot       -> airspeed 0, and the differential-pressure bit missing from SYS_STATUS
//   - no battery     -> voltage 0, current -1, battery_remaining 100 (!), BATTERY_STATUS voltage 0
//   - GPS without a fix -> fix_type 1 and zeroed position
//   - ATTITUDE rates are the gyro in deg/s even though MAVLink says rad/s; pitch sign is flipped
//   - flight mode is an ArduPilot-style custom_mode number; MAVLink v2 by default (v1 with RC_CHANNELS_RAW)
const dgram = require('dgram');
const { frame } = require('./mavlink.js');
const { SENSOR } = require('./spec.js');

const D2R = Math.PI / 180, R2D = 180 / Math.PI, G = 9.81;
const DEFAULTS = {
  vehicle: 'plane', v1: false, autopilot: 0,                    // MAV_AUTOPILOT_GENERIC, as INAV sends by default
  gps: true, fixAfter: 0, pitot: true, vbat: true, amp: true, mag: true, baro: true,
  rates: { status: 2, rc: 1, pos: 2, att: 2, hud: 2, batt: 1, hb: 1 },   // INAV defaults, Hz
  drop: 0, corrupt: 0, split: false, dropouts: false, radio: false,
  wind: [-4, 5],                                                // east, north m/s: the aircraft crabs, so course != heading
  home: [64.8378, -147.7164], armAt: 8,
};
const PROFILES = {
  full: {}, nogps: { gps: false }, nofix: { fixAfter: 25 }, nopitot: { pitot: false },
  novbat: { vbat: false, amp: false }, noamp: { amp: false }, nomag: { mag: false },
  minimal: { gps: false, pitot: false, vbat: false, amp: false },
  v1: { v1: true }, fast: { rates: { att: 10, hud: 5, pos: 5, status: 2, rc: 5, batt: 1, hb: 1 } },
  lossy: { drop: 0.1 }, corrupt: { corrupt: 0.05 }, split: { split: true }, dropout: { dropouts: true },
  radio: { radio: true }, copter: { vehicle: 'copter' }, ardupilot: { autopilot: 3 },
};
const DESCRIBE = {
  full: 'plane with every sensor, INAV default rates (2 Hz)', nogps: 'no GPS fitted: no position messages at all', nofix: 'GPS fitted but takes 25 s to get a fix',
  nopitot: 'no airspeed sensor', novbat: 'no battery voltage or current sensing', noamp: 'voltage but no current sensor', nomag: 'no compass',
  minimal: 'no GPS, pitot or battery sensing', v1: 'MAVLink v1 framing (RC_CHANNELS_RAW)', fast: 'faster stream rates (attitude 10 Hz)',
  lossy: '10% of frames lost on the radio', corrupt: '5% of frames arrive damaged', split: 'frames split across UDP packets',
  dropout: 'link goes silent for 4 s every 30 s', radio: 'also sends ELRS-style RADIO_STATUS and a ground-station heartbeat', copter: 'multirotor instead of a plane', ardupilot: 'autopilot field says ArduPilot',
};

function resolveProfile(names) {
  const p = JSON.parse(JSON.stringify(DEFAULTS));
  for (const n of [].concat(names)) {
    const o = PROFILES[n]; if (!o) throw new Error(`unknown profile "${n}" (try --list)`);
    for (const [k, v] of Object.entries(o)) p[k] = (k === 'rates') ? { ...p.rates, ...v } : v;
  }
  return p;
}

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const wrap2Pi = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// INAV flight modes as ArduPilot custom_mode numbers (plane map for fixed wing, copter map otherwise).
const MODE = { plane: { manual: 0, fbwa: 5, fbwb: 6, cruise: 7, auto: 10, rtl: 11, loiter: 12 }, copter: { stabilize: 0, althold: 2, auto: 3, loiter: 5, rtl: 6, poshold: 16 } };

function createSim(profileNames = ['full'], opts = {}) {
  const P = resolveProfile(profileNames), rand = rng(opts.seed || 1), DT = 0.02;
  const isPlane = P.vehicle === 'plane';
  const cells = 4, lat0 = P.home[0], lon0 = P.home[1], mPerLon = 111320 * Math.cos(lat0 * D2R);
  const seq = {};                                                // per (sysid,compid) MAVLink sequence counters
  const nextSeq = (k) => (seq[k] = ((seq[k] || 0) + 1) & 255);
  const route = isPlane ? [[0, 300], [500, 300], [500, -300], [0, -300]] : [[150, 0], [0, 150], [-150, 0], [0, -150]];
  const s = { t: 0, x: 0, y: 0, psi: 0, phi: 0, theta: 0, alt: 0, climb: 0, va: 0, thr: 0, wp: 0, armed: false, consumed: 0, cur: 0, homeSet: false, last: { phi: 0, theta: 0, psi: 0 } };
  const next = {}, out = [];
  const period = (r) => (r > 0 ? 1 / r : Infinity);

  function physics() {
    const t = s.t;
    const armed = t >= P.armAt;
    if (armed && !s.armed) { s.armed = true; s.psi = Math.atan2(route[0][0], route[0][1]); }
    const prev = { phi: s.phi, theta: s.theta, psi: s.psi };
    if (!armed) { s.va = 0; s.phi = 0; s.alt = 0; s.climb = 0; s.thr = 0; s.theta = 0; }
    else {
      const flyT = t - P.armAt, vaTarget = isPlane ? 19 : 9;
      s.va += clamp(vaTarget - s.va, -3 * DT, 4 * DT);
      const tgt = route[s.wp], dx = tgt[0] - s.x, dy = tgt[1] - s.y, dist = Math.hypot(dx, dy);
      if (dist < (isPlane ? 75 : 25)) s.wp = (s.wp + 1) % route.length;
      const bearing = Math.atan2(dx, dy), err = wrapPi(bearing - s.psi);
      const bankMax = isPlane ? 0.6 : 0.25, phiCmd = clamp(2.2 * err, -bankMax, bankMax);
      s.phi += clamp(phiCmd - s.phi, -1.0 * DT, 1.0 * DT);       // bank rate limit ~57 deg/s
      const rate = isPlane ? (G * Math.tan(s.phi)) / Math.max(s.va, 5) : clamp(1.2 * err, -0.8, 0.8);
      s.psi = wrap2Pi(s.psi + rate * DT);
      const altT = isPlane ? 80 + 30 * Math.sin(flyT / 40) : 40;
      const climbT = clamp(0.3 * (altT - s.alt), -3, 4);
      s.climb += (climbT - s.climb) * Math.min(1, DT / 1.2);
      s.alt = Math.max(0, s.alt + s.climb * DT);
      s.theta = Math.asin(clamp(s.climb / Math.max(s.va, 5), -0.5, 0.5)) + (isPlane ? 0.04 : -0.1);
      s.thr = clamp(40 + s.climb * 8 + (isPlane ? 0 : 10), 15, 95);
    }
    const vgE = s.va * Math.sin(s.psi) + (armed ? P.wind[0] : 0), vgN = s.va * Math.cos(s.psi) + (armed ? P.wind[1] : 0);
    s.vE = vgE; s.vN = vgN; s.gs = Math.hypot(vgE, vgN); s.course = wrap2Pi(Math.atan2(vgE, vgN));
    s.x += vgE * DT; s.y += vgN * DT;
    s.rollRate = (s.phi - prev.phi) / DT; s.pitchRate = (s.theta - prev.theta) / DT; s.yawRate = wrapPi(s.psi - prev.psi) / DT;
    const dist = Math.hypot(s.x, s.y);
    s.cur = armed ? 3 + s.thr * 0.22 + (isPlane ? 0 : 6) : 0.4;
    s.consumed += s.cur * DT / 3.6;                              // mAh
    s.cellV = clamp(4.15 - 0.0012 * s.t - s.cur * 0.003, 3.2, 4.2);
    s.remaining = Math.round(clamp((s.cellV - 3.3) / 0.85 * 100, 0, 100));
    s.rssi = Math.round(clamp(245 - dist / 8, 40, 254));
    s.fix = !P.gps ? 0 : t < P.fixAfter ? 1 : 3;
    s.sats = P.gps ? (s.fix === 3 ? 13 + Math.round(2 * Math.sin(t * 0.2)) : Math.min(5, Math.floor(t / 6))) : 0;
    if (s.armed && s.fix === 3 && !s.homeSet) s.homeSet = true;
    s.mode = !armed ? (isPlane ? MODE.plane.manual : MODE.copter.stabilize)
      : t - P.armAt < 40 ? (isPlane ? MODE.plane.fbwa : MODE.copter.althold)
      : t - P.armAt < 80 ? (isPlane ? MODE.plane.cruise : MODE.copter.poshold) : (isPlane ? MODE.plane.rtl : MODE.copter.rtl);
    s.lat = lat0 + s.y / 111320; s.lon = lon0 + s.x / mPerLon;
  }

  function sensorMasks() {
    let present = SENSOR.RC | SENSOR.GYRO | SENSOR.ACCEL | SENSOR.LOGGING;
    if (P.mag) present |= SENSOR.MAG; if (P.baro) present |= SENSOR.BARO;
    if (P.pitot) present |= SENSOR.PITOT; if (P.gps) present |= SENSOR.GPS;
    let health = present;
    if (P.gps && s.fix < 2) health &= ~SENSOR.GPS;
    return { present, enabled: present, health };
  }

  // ---- INAV-shaped messages ----
  const gpsOut = () => (s.fix >= 2 || false);
  const msgs = {
    hb: () => [['HEARTBEAT', {
      type: P.vehicle === 'plane' ? 1 : 2, autopilot: P.autopilot,
      base_mode: 64 | 1 | (s.armed ? 128 : 0) | (s.mode !== 0 || !isPlane ? 16 : 0),
      custom_mode: s.mode, system_status: s.armed ? 4 : 3, mavlink_version: 3 }],
      ['SYSTEM_TIME', { time_unix_usec: Date.UTC(2026, 10, 8) * 1000 + s.t * 1e6, time_boot_ms: Math.round(s.t * 1000) }]],
    status: () => { const m = sensorMasks(); return [['SYS_STATUS', {
      onboard_control_sensors_present: m.present, onboard_control_sensors_enabled: m.enabled, onboard_control_sensors_health: m.health,
      load: 120 + Math.round(40 * Math.sin(s.t)), voltage_battery: P.vbat ? Math.round(s.cellV * cells * 1000) : 0,
      current_battery: P.amp ? Math.round(s.cur * 100) : -1, battery_remaining: P.vbat ? s.remaining : 100,
      drop_rate_comm: 0, errors_comm: 0 }]]; },
    rc: () => {
      const ch = [1500 + s.phi * 400, 1500 - s.theta * 300, 1000 + s.thr * 10, 1500, s.armed ? 2000 : 1000, s.mode ? 1500 : 1000, 1000, 1500, 1000, 1000, 1500, 1500, 1000, 1000, 1000, 1000].map(Math.round);
      if (P.v1) { const v = { port: 0, rssi: s.rssi }; ch.slice(0, 8).forEach((c, i) => (v['chan' + (i + 1) + '_raw'] = c)); return [['RC_CHANNELS_RAW', v]]; }
      const v = { chancount: 16, rssi: s.rssi }; ch.forEach((c, i) => (v['chan' + (i + 1) + '_raw'] = c)); return [['RC_CHANNELS', v]];
    },
    pos: () => {
      if (!P.gps) return [];                                      // INAV sends nothing without a GPS sensor
      const fixed = s.fix >= 2, lat = fixed ? s.lat : 0, lon = fixed ? s.lon : 0;
      const out = [['GPS_RAW_INT', { time_usec: Math.round(s.t * 1e6), fix_type: s.fix, lat: Math.round(lat * 1e7), lon: Math.round(lon * 1e7), alt: Math.round((140 + s.alt) * 1000),
        eph: fixed ? 90 : 9999, epv: fixed ? 140 : 9999, vel: fixed ? Math.round(s.gs * 100) : 0, cog: fixed ? Math.round(s.course * R2D * 100) : 0, satellites_visible: s.sats }],
      ['GLOBAL_POSITION_INT', { time_boot_ms: Math.round(s.t * 1000), lat: Math.round(lat * 1e7), lon: Math.round(lon * 1e7), alt: Math.round((140 + s.alt) * 1000), relative_alt: Math.round(s.alt * 1000),
        vx: Math.round(s.vN * 100), vy: Math.round(s.vE * 100), vz: Math.round(-s.climb * 100), hdg: Math.round(s.psi * R2D * 100) % 36000 }]];
      out.push(['GPS_GLOBAL_ORIGIN', s.homeSet ? { latitude: Math.round(lat0 * 1e7), longitude: Math.round(lon0 * 1e7), altitude: 140000 } : { latitude: 0, longitude: 0, altitude: 0 }]);
      return out;
    },
    att: () => [['ATTITUDE', { time_boot_ms: Math.round(s.t * 1000), roll: wrapPi(s.phi), pitch: s.theta, yaw: wrapPi(s.psi),
      rollspeed: s.rollRate * R2D, pitchspeed: s.pitchRate * R2D, yawspeed: s.yawRate * R2D }]],   // INAV puts gyro deg/s here
    hud: () => [['VFR_HUD', { airspeed: P.pitot ? s.va : 0, groundspeed: P.gps && s.fix >= 2 ? s.gs : 0, heading: Math.round(s.psi * R2D) % 360,
      throttle: Math.round(s.thr), alt: s.alt, climb: s.climb }]],
    batt: () => {
      const v = Array(10).fill(65535);
      if (P.vbat) for (let c = 0; c < cells; c++) v[c] = Math.round(s.cellV * 1000);   // INAV repeats the pack average for each cell
      else v[0] = 0;
      const out = [['BATTERY_STATUS', { id: 0, battery_function: 0, type: 0, temperature: 32767, voltages: v, current_battery: P.amp ? Math.round(s.cur * 100) : -1,
        current_consumed: P.amp ? Math.round(s.consumed) : -1, energy_consumed: P.amp ? Math.round(s.consumed * 15) : -1, battery_remaining: P.vbat ? s.remaining : -1 }],
      ['SCALED_PRESSURE', { time_boot_ms: Math.round(s.t * 1000), press_abs: 0, press_diff: 0, temperature: 2150 }]];
      const note = s.t > 2 && s.t < 4 && !s._said1 ? (s._said1 = true, 'SENSORS CALIBRATING') : (s.armed && !s._said2 ? (s._said2 = true, 'ARMED') : null);
      if (note) out.push(['STATUSTEXT', { severity: 5, text: note }]);
      return out;
    },
    radio: () => [['RADIO_STATUS', { rxerrors: 0, fixed: 0, rssi: s.rssi, remrssi: s.rssi - 6, txbuf: 90, noise: 30, remnoise: 28 }]],
  };
  const SOURCE = { RADIO_STATUS: [1, 68] };                       // ELRS-style radio status comes from a different component

  function emit(stream, list) {
    for (const [name, values] of list) {
      const [sysid, compid] = SOURCE[name] || [1, 1];
      const buf = frame(name, values, { v2: !P.v1, seq: nextSeq(sysid + '/' + compid), sysid, compid });
      out.push({ t: s.t, name, buf, stream });
    }
  }

  const streams = [['hb', P.rates.hb, 0], ['status', P.rates.status, 0.1], ['rc', P.rates.rc, 0.2], ['pos', P.rates.pos, 0.3], ['att', P.rates.att, 0.05], ['hud', P.rates.hud, 0.15], ['batt', P.rates.batt, 0.4]];
  if (P.radio) streams.push(['radio', 2, 0.25]);
  for (const [n, , phase] of streams) next[n] = phase;

  function linkSilent(t) { return P.dropouts && t >= 25 && ((t - 25) % 30) < 4; }

  // Advance simulated time to `t` seconds; returns the datagrams that would leave the radio, in order.
  function advance(tEnd) {
    out.length = 0;
    while (s.t + DT <= tEnd + 1e-9) {
      s.t += DT; physics();
      for (const [n, rate] of streams) {
        if (s.t + 1e-9 >= next[n]) {
          next[n] += period(rate);
          if (n === 'radio') emit(n, msgs.radio());
          else emit(n, msgs[n]());
          if (n === 'hb' && P.radio) {                           // a ground-station style heartbeat that must not be mistaken for the aircraft
            const buf = frame('HEARTBEAT', { type: 6, autopilot: 8, base_mode: 0, system_status: 4, mavlink_version: 3 }, { v2: !P.v1, seq: nextSeq('255/190'), sysid: 255, compid: 190 });
            out.push({ t: s.t, name: 'HEARTBEAT', buf, stream: 'hb' });
          }
        }
      }
    }
    // link effects, applied after sequence numbers were assigned so losses show up as gaps
    let frames = out.slice();
    frames = frames.filter((f) => !linkSilent(f.t) && !(P.drop && rand() < P.drop));
    for (const f of frames) if (P.corrupt && rand() < P.corrupt) { const b = Buffer.from(f.buf); const i = 2 + Math.floor(rand() * (b.length - 2)); b[i] ^= 0xff; f.buf = b; }
    if (!P.split) return frames.map((f) => ({ t: f.t, buf: f.buf }));
    const all = Buffer.concat(frames.map((f) => f.buf)), dgrams = [], tAt = frames.length ? frames[frames.length - 1].t : tEnd;
    for (let i = 0; i < all.length;) { const n = 15 + Math.floor(rand() * 90); dgrams.push({ t: tAt, buf: all.subarray(i, i + n) }); i += n; }
    return dgrams;
  }

  return { advance, profile: P, state: s, truth: () => ({ ...s }) };
}

function main() {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : d; };
  if (a.includes('--list') || a.includes('--help') || a.includes('-h')) {
    console.log('Profiles (combine with commas, e.g. --profile minimal,split):');
    for (const n of Object.keys(PROFILES)) console.log('  ' + n.padEnd(10) + DESCRIBE[n]);
    console.log('\nOptions: --host 127.0.0.1  --port 14550  --seconds 0 (0 = until stopped)  --seed 1');
    return;
  }
  const names = arg('profile', 'full').split(',').map((x) => x.trim()).filter(Boolean);
  const host = arg('host', '127.0.0.1'), port = +arg('port', 14550), seconds = +arg('seconds', 0);
  const sim = createSim(names, { seed: +arg('seed', 1) }), sock = dgram.createSocket('udp4'), t0 = Date.now();
  console.log(`Test flight "${names.join(',')}" -> udp://${host}:${port}  (Ctrl+C to stop)`);
  const timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    for (const d of sim.advance(t)) sock.send(d.buf, port, host);
    if (seconds && t >= seconds) { clearInterval(timer); sock.close(); console.log('Done.'); }
  }, 20);
}

if (require.main === module) main();
module.exports = { createSim, resolveProfile, PROFILES, DESCRIBE, MODE };
