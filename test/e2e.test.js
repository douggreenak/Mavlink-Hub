'use strict';
// The whole chain with nothing stubbed except the aircraft: simulator -> real UDP socket -> hub -> real
// SSE stream -> dashboard code. Checks the bytes survive untouched and the dashboard shows the right thing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), dgram = require('node:dgram'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-e2e2-')); process.env.AIRSPACE = 'off';
const S = require('../server.js');
const M = require('../sim/mavlink.js');
const { createSim } = require('../sim/inav-sim.js');
const { loadDashboard, tileMap } = require('./helpers/dashboard.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(10); } };

async function through(profile, seconds) {
  const hub = await S.start({ udpPort: 0, webPort: 0, host: '127.0.0.1', migrate: false });
  const got = []; let buf = '';
  const req = http.get(`http://127.0.0.1:${hub.web.address().port}/stream`, { agent: false }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const m = ev.match(/^data: (.*)$/m); if (m && !/^event:/m.test(ev)) got.push(Buffer.from(m[1], 'base64')); } });
  });
  await sleep(150);
  const sim = createSim(profile), sent = sim.advance(seconds), sock = dgram.createSocket('udp4');
  for (let i = 0; i < sent.length; i++) { sock.send(sent[i].buf, hub.udp.address().port, '127.0.0.1'); if (i % 25 === 24) await sleep(3); }
  await until(() => got.length >= sent.length).catch(() => {});
  sock.close(); req.destroy(); await hub.close();
  // Hand what the browser would have received to the dashboard, spaced as the aircraft sent it.
  const h = loadDashboard(); let prev = 0;
  for (let i = 0; i < got.length; i++) { const t = sent[Math.min(i, sent.length - 1)].t; h.clock.t += Math.round((t - prev) * 1000); prev = t; h.feed(got[i]); h.D.step(0.05); }
  h.D.upStats(); h.D.render();
  return { h, D: h.D, sent, got, sim };
}
const counts = (buf) => { const c = {}; for (const m of M.decodeAll(buf)) c[m.name] = (c[m.name] || 0) + 1; return c; };

for (const profile of [['full'], ['minimal'], ['full', 'v1'], ['full', 'split'], ['nofix', 'radio']]) {
  test(`${profile.join('+')}: every byte the aircraft sends reaches the dashboard, in order, and is understood`, async () => {
    const { D, sent, got } = await through(profile, 30);
    assert.ok(sent.length > 200);
    const a = Buffer.concat(sent.map((d) => d.buf)), b = Buffer.concat(got);
    assert.equal(got.length, sent.length, 'every datagram arrived');
    assert.ok(a.equals(b), 'identical bytes in identical order: the hub does not alter or reorder anything');
    const want = counts(a);
    for (const [name, n] of Object.entries(want)) {
      const recv = name === 'HEARTBEAT' && profile.includes('radio') ? D.V.HEARTBEAT.n : (D.V[name]?.n ?? 0);
      if (name === 'HEARTBEAT' && profile.includes('radio')) { assert.ok(recv > 0); continue; }         // the ground-station beat is deliberately not counted
      assert.ok(Math.abs(recv - n) <= (profile.includes('split') ? 1 : 0), `${name}: sent ${n}, dashboard decoded ${recv}`);
    }
    assert.equal(D.bad(), 0);
    assert.ok(!/NaN|undefined/.test(D.tiles()));
  });
}

test('a bare-bones plane through the whole chain: the tiles say what is missing, the rest works', async () => {
  const { D } = await through(['minimal'], 30), t = tileMap(D.tiles());
  assert.equal(t['GPS'].unit, 'no GPS fitted'); assert.equal(t['Airspeed'].unit, 'no airspeed sensor'); assert.equal(t['Battery'].unit, 'no battery sensor');
  assert.ok(+t['Roll'].value !== undefined && /^-?\d+$/.test(t['Heading'].value) && /^\d+$/.test(t['Throttle'].value));
  assert.equal(D.P.length, 0);
});

test('a plane with everything through the whole chain: values agree with what the simulator flew', async () => {
  const { D, sim } = await through(['full'], 40), t = tileMap(D.tiles()), truth = sim.truth();
  assert.ok(D.P.length > 20);
  const last = D.P[D.P.length - 1], kx = 111320 * Math.cos(truth.lat * Math.PI / 180);
  assert.ok(Math.hypot((last[1] - truth.lon) * kx, (last[0] - truth.lat) * 111320) < 40, 'last reported position within two reports of the truth');
  assert.ok(Math.abs(+t['Altitude'].value - truth.alt) < 8, `altitude ${t['Altitude'].value} vs ${truth.alt.toFixed(1)}`);
  assert.ok(Math.abs(+t['Airspeed'].value / 3.6 - truth.va) < 2);
  assert.equal(t['Flight mode'].value, 'FBW A');
});
