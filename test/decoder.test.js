'use strict';
// Tests the MAVLink decoder that ships inside index.html. The page's inline script is loaded
// into a vm context with a just-enough DOM stub, then fed frames from test/helpers/mavlink.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const M = require('./helpers/mavlink.js');

// A DOM element that accepts any property set, answers any method with a no-op,
// and keeps a real classList so toggles behave.
function fakeElement() {
  const store = {}, classes = new Set();
  const classList = {
    add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
    toggle: (c, f) => { (f === undefined ? !classes.has(c) : f) ? classes.add(c) : classes.delete(c); },
  };
  const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true });
  return new Proxy(store, {
    get(t, p) {
      if (p === 'classList') return classList;
      if (p === 'style' || p === 'dataset') return t[p] || (t[p] = {});
      if (p === 'children' || p === 'options') return [];
      if (p === 'getContext') return () => ctx2d;
      if (p === 'getBoundingClientRect') return () => ({ width: 300, height: 300 });
      if (p in t) return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

let D; // the page's internals, pulled out of the vm context
before(() => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const src = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const els = {};
  const sandbox = {
    console, performance, Date, Math,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; }, clearInterval,
    requestAnimationFrame: () => 0,
    document: {
      getElementById: (id) => els[id] || (els[id] = fakeElement()),
      querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {},
      body: fakeElement(), documentElement: fakeElement(),
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8080' },
    EventSource: class { addEventListener() {} },
    fetch: () => new Promise(() => {}),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    devicePixelRatio: 1,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html#script' });
  D = vm.runInContext('({feed, crc, defs, V, U, P, Z, MX, St, CV, UN, dist, addP, upStats, sm, esc, ok: () => ok, bad: () => bad, snack: $("snack")})', sandbox);
});

const feed = (...bufs) => D.feed(new Uint8Array(Buffer.concat(bufs)));
// Objects born inside the vm have another realm's prototypes, so compare them by value.
const same = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);
const reset = () => { for (const k of Object.keys(D.V)) delete D.V[k]; for (const k of Object.keys(D.U)) delete D.U[k]; D.P.length = 0; };

test('message table: every entry has a CRC_EXTRA and a payload length matching the MAVLink spec', () => {
  const expectLen = { HEARTBEAT: 9, SYS_STATUS: 31, SYSTEM_TIME: 12, GPS_RAW_INT: 30, SCALED_PRESSURE: 14, ATTITUDE: 28, GLOBAL_POSITION_INT: 28, RC_CHANNELS: 42, VFR_HUD: 20, RADIO_STATUS: 9, BATTERY_STATUS: 36, STATUSTEXT: 51 };
  for (const [id, d] of Object.entries(D.defs)) {
    assert.equal(d.len, expectLen[d.name], `${d.name} (${id}) payload length`);
    if (d.name in M.CRC_EXTRA) assert.equal(d.extra, M.CRC_EXTRA[d.name], `${d.name} CRC_EXTRA`);
  }
});

test('CRC agrees with an independent implementation on random data', () => {
  for (let n = 0; n < 50; n++) {
    const len = 1 + Math.floor(Math.random() * 40), buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
    const extra = Math.floor(Math.random() * 256);
    assert.equal(D.crc(new Uint8Array(buf), extra), M.crc16(buf, extra));
  }
});

test('decodes a MAVLink v2 HEARTBEAT', () => {
  reset(); const ok0 = D.ok();
  feed(M.frame('HEARTBEAT', M.heartbeat({ custom_mode: 0x01020304, type: 1, autopilot: 3, base_mode: 0x81, system_status: 4 })));
  assert.equal(D.ok(), ok0 + 1);
  same(D.V.HEARTBEAT.f, { custom_mode: 0x01020304, type: 1, autopilot: 3, base_mode: 0x81, system_status: 4, mavlink_version: 3 });
  assert.equal(D.V.HEARTBEAT.n, 1);
});

test('decodes a MAVLink v1 frame too', () => {
  reset();
  feed(M.frame('VFR_HUD', M.vfrHud({ airspeed: 12.5, groundspeed: 14.25, alt: 120.5, climb: -1.5, heading: 270, throttle: 55 }), { v2: false }));
  const f = D.V.VFR_HUD.f;
  assert.equal(f.airspeed, 12.5); assert.equal(f.groundspeed, 14.25); assert.equal(f.alt, 120.5);
  assert.equal(f.climb, -1.5); assert.equal(f.heading, 270); assert.equal(f.throttle, 55);
});

test('v2 payload with trailing zeros trimmed still decodes with zero defaults', () => {
  reset();
  const fr = M.frame('ATTITUDE', M.attitude({ time_boot_ms: 1000, roll: 0.25, pitch: -0.125 }));
  assert.ok(fr[1] < 28, 'encoder really trimmed the payload');
  feed(fr);
  const f = D.V.ATTITUDE.f;
  assert.equal(f.roll, 0.25); assert.equal(f.pitch, -0.125);
  same([f.yaw, f.rollspeed, f.pitchspeed, f.yawspeed], [0, 0, 0, 0]);
});

test('a signed v2 frame decodes and the 13-byte signature is skipped cleanly', () => {
  reset(); const ok0 = D.ok(), bad0 = D.bad();
  feed(M.frame('HEARTBEAT', M.heartbeat({ custom_mode: 7 }), { signed: true }), M.frame('VFR_HUD', M.vfrHud({ throttle: 33 })));
  assert.equal(D.ok(), ok0 + 2); assert.equal(D.bad(), bad0);
  assert.equal(D.V.HEARTBEAT.f.custom_mode, 7);
  assert.equal(D.V.VFR_HUD.f.throttle, 33);
});

test('a corrupt checksum is counted and not applied', () => {
  reset(); const ok0 = D.ok(), bad0 = D.bad();
  feed(M.frame('HEARTBEAT', M.heartbeat({ custom_mode: 99 }), { corrupt: true }));
  assert.equal(D.bad(), bad0 + 1); assert.equal(D.ok(), ok0);
  assert.equal(D.V.HEARTBEAT, undefined);
});

test('several frames in one datagram all decode, and the decoder resyncs after a bad one', () => {
  reset(); const ok0 = D.ok();
  feed(
    M.frame('HEARTBEAT', M.heartbeat({ custom_mode: 1 })),
    M.frame('VFR_HUD', M.vfrHud({ throttle: 10 }), { corrupt: true }),
    M.frame('RADIO_STATUS', M.radioStatus({ rssi: 200, remrssi: 180, noise: 20 })),
    M.frame('VFR_HUD', M.vfrHud({ throttle: 20 }), { v2: false }),
  );
  assert.equal(D.ok(), ok0 + 3);
  same(D.V.RADIO_STATUS.f, { rxerrors: 0, fixed: 0, rssi: 200, remrssi: 180, txbuf: 0, noise: 20, remnoise: 0 });
  assert.equal(D.V.VFR_HUD.f.throttle, 20);
});

test('unknown message ids are tallied with their length instead of being dropped silently', () => {
  reset();
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const hdr = Buffer.from([0xfd, 5, 0, 0, 0, 1, 1, 0x2a, 0x01, 0x00]); // id 298
  feed(Buffer.concat([hdr, payload, Buffer.from([0, 0])]));
  same(D.U[298], { n: 1, len: 5 });
});

test('a lone start byte at the very end of a datagram is not counted as a CRC failure (regression)', () => {
  reset(); const bad0 = D.bad(), ok0 = D.ok();
  feed(M.frame('HEARTBEAT', M.heartbeat(), { corrupt: true }), Buffer.from([0xfd]));
  assert.equal(D.bad(), bad0 + 1, 'only the genuinely corrupt frame counts');
  feed(Buffer.from([0xfe]));
  feed(Buffer.from([0xfd, 0x09])); // start byte plus length, nothing else
  assert.equal(D.bad(), bad0 + 1);
  assert.equal(D.ok(), ok0);
});

test('GLOBAL_POSITION_INT extends the track and the odometer; a 0,0 fix is ignored', () => {
  reset(); D.St.odo = 0; D.St.t0 = null;
  feed(M.frame('GLOBAL_POSITION_INT', M.globalPosition({ lat: 0, lon: 0 })));
  assert.equal(D.P.length, 0, 'null island is not a position');
  feed(M.frame('GLOBAL_POSITION_INT', M.globalPosition({ lat: 648378000, lon: -1477164000, relative_alt: 50000, hdg: 9000 })));
  feed(M.frame('GLOBAL_POSITION_INT', M.globalPosition({ lat: 648378000 + 900, lon: -1477164000, relative_alt: 60000, hdg: 9000 })));
  assert.equal(D.P.length, 2);
  same(D.P[0], [64.8378, -147.7164]);
  assert.ok(Math.abs(D.St.odo - 10) < 0.5, `about 10 m north, got ${D.St.odo}`);
  assert.equal(D.V.GLOBAL_POSITION_INT.f.hdg, 9000);
  assert.equal(D.V.GLOBAL_POSITION_INT.f.relative_alt, 60000);
});

test('odometer ignores GPS jitter under half a metre and teleports over a kilometre', () => {
  D.P.length = 0; D.St.odo = 0;
  D.addP(60, 10); D.addP(60.000001, 10); // ~0.1 m
  assert.equal(D.St.odo, 0);
  D.addP(60.1, 10); // ~11 km jump
  assert.equal(D.St.odo, 0);
});

test('STATUSTEXT shows the message and stops at the first NUL', () => {
  reset();
  feed(M.frame('STATUSTEXT', M.statustext(6, 'Arming motors')));
  assert.equal(D.V.STATUSTEXT.f.severity, 6);
  assert.equal(D.V.STATUSTEXT.f.text, 'Arming motors');
  assert.equal(D.snack.textContent, 'Arming motors');
});

test('SYS_STATUS battery fields keep their sign and feed the flight statistics', () => {
  reset(); for (const k of Object.keys(D.MX)) delete D.MX[k];
  feed(M.frame('SYS_STATUS', M.sysStatus({ voltage_battery: 16800, current_battery: 1250, battery_remaining: 77 })));
  assert.equal(D.V.SYS_STATUS.f.voltage_battery, 16800);
  assert.equal(D.V.SYS_STATUS.f.current_battery, 1250);
  assert.equal(D.V.SYS_STATUS.f.battery_remaining, 77);
  D.upStats();
  assert.equal(D.MX.cur, 12.5);
  assert.equal(D.MX.vmin, 16.8);
  feed(M.frame('SYS_STATUS', M.sysStatus({ voltage_battery: 15900, current_battery: 800, battery_remaining: -1 })));
  D.upStats();
  assert.equal(D.MX.cur, 12.5, 'max current kept'); assert.equal(D.MX.vmin, 15.9, 'lowest voltage updated');
  assert.equal(D.V.SYS_STATUS.f.battery_remaining, -1);
});

test('unit conversion and distance formatting', () => {
  assert.equal(D.CV.spd(10), 36);            // m/s -> km/h
  same(D.dist(999), ['999', 'm']);
  same(D.dist(1500), ['1.50', 'km']);
  assert.equal(D.UN.len(), 'm');
});

test('smoothing converges on the target and takes the short way round on angles', () => {
  const Z = D.Z;
  delete Z.t; D.sm('t', 10, 0.2, 0.016);
  assert.equal(Z.t, 10, 'first sample is adopted as-is');
  for (let i = 0; i < 400; i++) D.sm('t', 20, 0.2, 0.016);
  assert.ok(Math.abs(Z.t - 20) < 0.01, `converged: ${Z.t}`);
  delete Z.h; D.sm('h', 350, 0.2, 0.016, 360);
  D.sm('h', 10, 0.2, 0.016, 360);
  assert.ok(Z.h > 350 && Z.h < 372, `moved towards 370 (=10 the short way), got ${Z.h}`);
});

test('HTML escaping used by the All data view', () => {
  assert.equal(D.esc('<img src=x onerror=1>&"'), '&lt;img src=x onerror=1&gt;&amp;&quot;');
  assert.equal(D.esc(12.5), '12.5');
});
