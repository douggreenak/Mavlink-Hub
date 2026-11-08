'use strict';
// Smoothness and prediction, measured frame by frame at 60 fps against INAV's real (slow) message rates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDashboard } = require('./helpers/dashboard.js');
const { createSim } = require('../sim/inav-sim.js');

const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const M = (lat, la, lo, la2, lo2) => Math.hypot((lo - lo2) * 111320 * Math.cos(lat * Math.PI / 180), (la - la2) * 111320);

// Fly `seconds` after a warm-up; collect per-frame position, step and turn-rate, and truth for comparison.
function record(profile, seconds = 90, warm = 25) {
  const h = loadDashboard(), D = h.D, sim = createSim(profile), rows = []; let prev = null, prevStep = null;
  h.run(sim, warm);
  h.run(sim, seconds, { onFrame: (t) => {
    if (D.Z.lat == null) return;
    if (prev) { const step = M(D.Z.lat, D.Z.lat, D.Z.lon, prev.lat, prev.lon);
      rows.push({ t, step, dstep: prevStep == null ? 0 : Math.abs(step - prevStep), err: M(D.Z.lat, D.Z.lat, D.Z.lon, sim.state.lat, sim.state.lon), rate: D.Z.trate || 0, roll: D.Z.roll, truth: { lat: sim.state.lat, lon: sim.state.lon }, snap: { lat: D.Z.lat, lon: D.Z.lon, crs: D.Z.crs, spd: Math.hypot(D.Z.vn, D.Z.ve), rate: D.Z.trate || 0 } });
      prevStep = step; }
    prev = { lat: D.Z.lat, lon: D.Z.lon };
  } });
  return { rows, h, D, sim };
}

test('2 Hz position reports (INAV default) still move the icon smoothly: no stalls, no jumps', () => {
  const { rows } = record(['full']);
  const med = q(rows.map((r) => r.step), .5), ds = rows.map((r) => r.dstep);
  assert.ok(rows.length > 5000);
  assert.ok(med > 0.15 && med < 0.35, `typical step ${med.toFixed(3)} m at 60 fps for ~20 m/s`);
  assert.ok(q(ds, .99) < 0.08, `99th percentile change in step ${q(ds, .99).toFixed(3)} m`);
  assert.ok(Math.max(...ds) < 0.2, `worst change in step ${Math.max(...ds).toFixed(3)} m (a stall would be ~${med.toFixed(2)})`);
});

test('the icon sits on the aircraft, not behind it', () => {
  const { rows } = record(['full']), err = rows.map((r) => r.err);
  assert.ok(q(err, .5) < 1.0, `median error ${q(err, .5).toFixed(2)} m`);
  assert.ok(q(err, .95) < 3.0, `95th percentile error ${q(err, .95).toFixed(2)} m`);
});

test('the same holds at faster rates and with a flaky link', () => {
  for (const prof of [['fast'], ['lossy'], ['split']]) {
    const { rows } = record(prof), ds = rows.map((r) => r.dstep);
    assert.ok(q(ds, .99) < 0.1, `${prof}: p99 step change ${q(ds, .99).toFixed(3)}`);
    assert.ok(q(rows.map((r) => r.err), .95) < 4, `${prof}: p95 error ${q(rows.map((r) => r.err), .95).toFixed(2)}`);
  }
});

test('turn rate, and so the predicted path, changes gradually from frame to frame', () => {
  for (const prof of [['full'], ['fast']]) {
    const { rows } = record(prof); let worst = 0;
    for (let i = 1; i < rows.length; i++) worst = Math.max(worst, Math.abs(rows[i].rate - rows[i - 1].rate));
    assert.ok(worst < 1.5, `${prof}: largest frame-to-frame change in turn rate ${worst.toFixed(2)} deg/s`);
    assert.ok(Math.max(...rows.map((r) => Math.abs(r.rate))) > 8, 'and it does see the turns (about 20 deg/s in this flight)');
  }
});

test('the attitude indicator glides between 2 Hz reports instead of stepping', () => {
  const h = loadDashboard(), D = h.D, sim = createSim(['full']); h.run(sim, 20);
  const d = []; let prev = null;
  h.run(sim, 60, { onFrame: () => { if (prev != null) d.push(Math.abs(D.Z.roll - prev) * 57.2958); prev = D.Z.roll; } });
  assert.ok(Math.max(...d) < 1.5, `largest roll change in one frame ${Math.max(...d).toFixed(2)} deg`);
  assert.ok(q(d, .5) > 0, 'it keeps moving rather than holding between reports');
});

test('smoothing time follows the real message rate (never snappier than the base value)', () => {
  const slow = loadDashboard(), fast = loadDashboard();
  slow.run(createSim(['full']), 20); fast.run(createSim(['fast']), 20);
  assert.ok(slow.D.sti('ATTITUDE', .15) > .25 && slow.D.sti('ATTITUDE', .15) < .31, '2 Hz attitude: about one interval');
  assert.equal(fast.D.sti('ATTITUDE', .15), .15, '10 Hz attitude: the base value');
  assert.equal(slow.D.sti('NOT_RECEIVED', .15), .15);
  assert.ok(slow.D.sti('ATTITUDE', .15) <= .6);
});

test('the turn-aware path is closer to where the aircraft goes than a straight line, 3 and 5 s out', () => {
  const { rows, D } = record(['full'], 140, 25);
  const bySec = rows.filter((_, i) => i % 15 === 0);
  for (const horizon of [3, 5]) {
    let a = 0, b = 0, n = 0;
    for (const r of bySec) {
      const f = rows.reduce((x, y) => Math.abs(y.t - (r.t + horizon)) < Math.abs(x.t - (r.t + horizon)) ? y : x);
      if (Math.abs(f.t - (r.t + horizon)) > 0.05) continue;
      const p = D.pathPoint(r.snap.lat, r.snap.lon, r.snap.crs, r.snap.spd, r.snap.rate, horizon), s = D.pathPoint(r.snap.lat, r.snap.lon, r.snap.crs, r.snap.spd, 0, horizon);
      a += M(r.snap.lat, p[0], p[1], f.truth.lat, f.truth.lon); b += M(r.snap.lat, s[0], s[1], f.truth.lat, f.truth.lon); n++;
    }
    assert.ok(n > 50);
    assert.ok(a / n < 0.8 * (b / n), `+${horizon}s: turn-aware ${(a / n).toFixed(1)} m vs straight ${(b / n).toFixed(1)} m`);
  }
});

test('when reports stop, the icon coasts a little then holds still instead of running away', () => {
  const h = loadDashboard(), D = h.D, sim = createSim(['full']); h.run(sim, 30);
  const at = () => [D.Z.lat, D.Z.lon];
  h.clock.t += 3000; D.step(1 / 60); const a = at();
  h.clock.t += 7000; D.step(1 / 60); const b = at();
  assert.ok(M(a[0], a[0], a[1], b[0], b[1]) < 1.0, 'no drift between 3 s and 10 s of silence');
  const spd = Math.hypot(D.Z.vn, D.Z.ve);
  assert.ok(M(a[0], a[0], a[1], sim.state.lat, sim.state.lon) < spd * 3, 'and it never coasts further than ~1.5 s of travel');
});

test('predictPath: straight line, circle geometry, direction of turn and the one-circle limit', () => {
  const { D } = loadDashboard(), lat = 64.85, lon = -147.7;
  const k = (p) => [(p[1] - lon) * 111320 * Math.cos(lat * Math.PI / 180), (p[0] - lat) * 111320];     // [east, north] metres
  let [e, n] = k(D.pathPoint(lat, lon, 90, 20, 0, 10)); assert.ok(Math.abs(e - 200) < 0.1 && Math.abs(n) < 0.1, 'east at 20 m/s for 10 s');
  [e, n] = k(D.pathPoint(lat, lon, 0, 20, 0, 5)); assert.ok(Math.abs(n - 100) < 0.1 && Math.abs(e) < 0.1);
  const w = 20, r = 20 / (w * Math.PI / 180);                                                          // 57.3 m radius
  [e, n] = k(D.pathPoint(lat, lon, 0, 20, w, 9));                                                      // half a circle, turning right
  assert.ok(Math.abs(e - 2 * r) < 0.2 && Math.abs(n) < 0.3, `diametrically opposite: ${e.toFixed(1)}, ${n.toFixed(1)} (expected ${2 * r.toFixed(1)}, 0)`);
  [e, n] = k(D.pathPoint(lat, lon, 0, 20, -w, 9)); assert.ok(e < -100, 'negative rate turns left (west)');
  const pr = D.predictPath(lat, lon, 0, 20, w, 60), end = pr.pts[pr.pts.length - 1];
  assert.ok(Math.abs(pr.maxT - 18) < 1e-9, 'stops after one full circle');
  [e, n] = k(end); assert.ok(Math.hypot(e, n) < 0.5, 'back where it started');
  assert.equal(pr.pts.length, 37); assert.ok(Math.abs(pr.radius - r) < 0.01);
  assert.equal(D.predictPath(lat, lon, 45, 15, 0, 20).maxT, 20);
});
