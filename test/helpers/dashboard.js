'use strict';
// Loads the dashboard's inline script (index.html) into a vm with a stubbed DOM and a virtual clock,
// so tests can feed it real MAVLink bytes and step its animation frame by frame.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// An element that accepts any property, answers any method with a no-op and keeps a real classList.
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

function loadDashboard({ start = Date.UTC(2026, 10, 8, 12, 0, 0), storage = {} } = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const src = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const clock = { t: start };
  class VDate extends Date { static now() { return clock.t; } constructor(...a) { if (a.length) super(...a); else super(clock.t); } }
  const els = {}, el = (id) => els[id] || (els[id] = fakeElement());
  const sandbox = {
    console, performance, Date: VDate, Math,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; }, clearInterval,
    requestAnimationFrame: () => 0,
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {}, body: fakeElement(), documentElement: fakeElement(), createElement: () => fakeElement() },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } },
    location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8080' },
    EventSource: class { addEventListener() {} },
    fetch: () => new Promise(() => {}),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    devicePixelRatio: 1, confirm: () => true,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html#script' });
  const D = vm.runInContext(`({
    feed, crc, defs, V, U, P, Z, ZV, MX, St, CV, UN, dist, addP, upStats, sm, esc, step, render, renderConn, horizon,
    gpsState, gpsUsable, battState, hasSensor, SENSOR, modeName, rcFields, rssiRaw, homeDist, lossPct, sti, mapMessage,
    predictPath, pathPoint, ceilLabels, LIM, ALT, altLimit, altOver, geomHas, AS, busy, trackBusy, setBusyEl: (e) => { busyEl = e; }, busyCount: () => busyN,
    ok: () => ok, bad: () => bad, home: () => Home, tail: () => tail, dropTail: () => { tail = null; },
    setPredT: (v) => { predT = v; }, getPredT: () => predT, snack: $('snack'), tiles: () => $('tiles').innerHTML, sens: () => $('sens').innerHTML,
    last: () => lastRx })`, sandbox);
  // Deliver one datagram "now".
  const feed = (buf) => D.feed(new Uint8Array(buf));
  // Run the dashboard for `seconds` of virtual time at `fps`, delivering each datagram the sim emits when it is due.
  // With ui:true it also runs the stats and render passes about 8 times a second, as the real page does.
  function run(sim, seconds, { fps = 60, onFrame, ui = false } = {}) {
    const dt = 1 / fps, t0 = clock.t, simT0 = sim.state.t; let acc = 0;
    for (let k = 1; k <= Math.round(seconds * fps); k++) {
      const tNext = simT0 + k * dt; clock.t = t0 + Math.round(k * dt * 1000);
      for (const d of sim.advance(tNext)) feed(d.buf);
      D.step(dt);
      if (ui) { acc += dt; if (acc > 0.12) { acc = 0; D.upStats(); D.render(); } }
      if (onFrame) onFrame(tNext, k);
    }
    if (ui) { D.upStats(); D.render(); }
  }
  return { D, clock, el, feed, run, els };
}

// ---- tile helpers: read what the dashboard printed ----
function tileMap(html) {
  const out = {}, re = /data-key="([^"]+)"><span class="lab">.*?<\/span><b[^>]*>(.*?)<\/b><span>(.*?)<\/span>/gs;
  let m; while ((m = re.exec(html))) out[m[1]] = { value: m[2], unit: m[3] };
  return out;
}
module.exports = { loadDashboard, tileMap, fakeElement };
