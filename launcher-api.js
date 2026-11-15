'use strict';
// The hub's control API, used by the launcher window (launcher.html).
//
// It can stop the hub, open folders and start a test flight, so it is deliberately narrow:
//   - it only answers requests that come from this computer (loopback), never phones or other laptops;
//   - the Host header must be localhost / 127.0.0.1 / [::1] on the hub's own port, which defeats DNS rebinding,
//     where a hostile web page points its own name at 127.0.0.1;
//   - every POST must carry an "X-Launcher: 1" header and, if the browser sends an Origin, it must be the hub
//     itself. A header like that forces a cross-origin pre-flight that the hub never approves, so another web page
//     cannot make your browser press Stop.
const fs = require('fs'), path = require('path'), { spawn, execFile } = require('child_process');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Returns a reason to refuse the request, or null if it is fine.
function guard(req, port) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return 'This page only works on the hub computer itself.';
  const host = String(req.headers.host || '').toLowerCase();
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].concat(port === 80 ? ['localhost', '127.0.0.1', '[::1]'] : []);
  if (!hosts.includes(host)) return 'Unexpected host name.';
  if (req.method === 'POST') {
    if (req.headers['x-launcher'] !== '1') return 'Missing launcher header.';
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return 'Unexpected origin.';
  }
  return null;
}

// Open a folder, file or web address in the computer's usual app. `kind` is only used to pick Notepad for the log on Windows.
function osOpen(kind, target) {
  let cmd, args;
  if (process.platform === 'win32') { [cmd, args] = kind === 'log' ? ['notepad.exe', [target]] : ['explorer.exe', [target]]; }
  else if (process.platform === 'darwin') [cmd, args] = ['open', [target]];
  else [cmd, args] = ['xdg-open', [target]];
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  c.on('error', () => {}); c.unref();
}

// Windows Firewall blocks other devices from reaching the hub unless this program is allowed in. The rule is named after the path of the
// bundled node.exe (the installer adds the same one). `status()` says whether it exists (netsh's exit code, so it works in any language);
// `allow()` asks Windows for permission (a UAC prompt) to add it for every network type, public Wi-Fi included.
const ruleName = (exe) => 'MAVLink Hub (' + exe + ')';
function windowsFirewall(exe = process.execPath, { run = execFile, launch = spawn } = {}) {
  const name = ruleName(exe);
  return {
    status: () => new Promise((resolve) => run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + name], { windowsHide: true, timeout: 8000 }, (e) => resolve(!e))),
    allow: () => {
      const q = (s) => String(s).replace(/'/g, "''");
      const args = `advfirewall firewall add rule name="${name}" dir=in action=allow program="${exe}" enable=yes profile=any`;
      const c = launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath netsh.exe -ArgumentList '${q(args)}' -Verb RunAs -WindowStyle Hidden`], { detached: true, stdio: 'ignore', windowsHide: true });
      if (c && c.on) c.on('error', () => {}); if (c && c.unref) c.unref();
    },
  };
}

function createLauncherApi(o) {
  const { dir, page, info, quit, now = Date.now, graceMs = 8000, open = osOpen, profiles = [] } = o;
  const clients = new Set();
  let timer = null, graceT = null, everConnected = false, flight = null;
  const rate = { t: now(), packets: 0, bytes: 0, pps: 0, bps: 0 };
  const spawnSim = o.spawnSim || ((profile, udpPort) => spawn(process.execPath, [path.join(__dirname, 'sim', 'inav-sim.js'), '--profile', profile, '--port', String(udpPort)], { stdio: 'ignore', windowsHide: true }));

  function snapshot(port) {
    const i = info(port), t = now(), s = i.stats, dt = (t - rate.t) / 1000;
    if (dt >= 0.5) { rate.pps = (s.packets - rate.packets) / dt; rate.bps = (s.bytes - rate.bytes) / dt; rate.packets = s.packets; rate.bytes = s.bytes; rate.t = t; }
    return {
      version: i.version, uptimeS: Math.round((t - i.startedAt) / 1000), webPort: i.webPort, udpPort: i.udpPort, urls: i.urls,
      telemetry: { packets: s.packets, bytes: s.bytes, pps: +rate.pps.toFixed(1), bps: Math.round(rate.bps), lastAgoMs: s.last ? t - s.last : null },
      units: i.units, viewers: i.viewers, dataDir: i.dataDir, airspaceDir: i.airspaceDir, hasLog: !!i.logFile,
      testFlight: { running: !!flight, profile: flight ? flight.profile : null }, profiles, update: updater ? updater.state() : null, firewall: { ...fwState },
    };
  }
  const json = (res, code, o2) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o2)); };
  function readJSON(req, cb) {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 4000) req.destroy(); });
    req.on('end', () => { let v = {}; try { v = b ? JSON.parse(b) : {}; } catch (e) { return cb(null); } cb(v && typeof v === 'object' ? v : {}); });
  }
  const push = () => { for (const c of clients) c.write(`data: ${JSON.stringify(snapshot(c._port))}\n\n`); };
  // Windows only (or a test double): is this program allowed through the firewall? Refreshed while the window is open.
  const fw = o.firewall !== undefined ? o.firewall : (process.platform === 'win32' ? windowsFirewall() : null);
  const fwState = { supported: !!fw, allowed: null }; let fwTimer = null;
  const fwRefresh = () => { if (!fw) return Promise.resolve(); return Promise.resolve(fw.status()).then((a) => { if (fwState.allowed !== a) { fwState.allowed = a; push(); } }, () => {}); };
  const updater = o.updater ? o.updater({ onChange: push, quit }) : null;   // checks GitHub for a newer version, installs it on request
  function maybeQuit() {
    // Closing the window stops the hub (after a short grace so a reload or a second window opening does not). A hub that no
    // window has ever connected to (started by hand, or with LAUNCHER_NO_WINDOW) is left alone.
    if (!everConnected || clients.size) return;
    clearTimeout(graceT); graceT = setTimeout(() => { if (!clients.size) quit(); }, graceMs);
  }

  function handle(req, res, url, qs) {
    if (!url.startsWith('/launcher')) return false;
    const port = req.socket.localPort, why = guard(req, port);
    if (why) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end(why); return true; }
    if (url === '/launcher' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); fs.createReadStream(page).pipe(res); return true;
    }
    if (url === '/launcher/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res._port = port; clients.add(res); everConnected = true; clearTimeout(graceT);
      if (updater) updater.checkIfStale();
      fwRefresh(); if (fw && !fwTimer) { fwTimer = setInterval(fwRefresh, 15000); fwTimer.unref(); }
      res.write(`data: ${JSON.stringify(snapshot(port))}\n\n`);
      if (!timer) { timer = setInterval(push, 1000); timer.unref(); }
      req.on('close', () => { clients.delete(res); if (!clients.size) { clearInterval(timer); timer = null; } maybeQuit(); });
      return true;
    }
    if (url === '/launcher/log' && req.method === 'GET') {
      const f = info(port).logFile; let text = '';
      try { text = fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(-200).join('\n'); } catch (e) { text = f ? 'The log is empty.' : 'This hub was not started by the launcher, so there is no log file.'; }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); return true;
    }
    if (req.method !== 'POST') { res.writeHead(404); res.end('Not found'); return true; }
    readJSON(req, (body) => {
      if (!body) return json(res, 400, { error: 'Bad JSON' });
      const i = info(port);
      if (url === '/launcher/open') {
        const targets = { dashboard: `http://localhost:${port}/`, maps: i.dataDir, airspace: i.airspaceDir, log: i.logFile };
        if (!Object.prototype.hasOwnProperty.call(targets, body.target) || !targets[body.target]) return json(res, 400, { error: 'Unknown target' });
        if (body.target === 'maps' || body.target === 'airspace') { try { fs.mkdirSync(targets[body.target], { recursive: true }); } catch (e) { /* opened anyway */ } }
        open(body.target, targets[body.target]); return json(res, 200, { ok: true });
      }
      if (url === '/launcher/testflight') {
        if (body.action === 'stop') { if (flight) { try { flight.child.kill(); } catch (e) { /* already gone */ } flight = null; push(); } return json(res, 200, { ok: true }); }
        if (body.action !== 'start') return json(res, 400, { error: 'Unknown action' });
        if (flight) return json(res, 409, { error: 'A test flight is already running' });
        const names = String(body.profile || 'full').split(',').map((x) => x.trim()).filter(Boolean), known = new Set(profiles.map((p) => p.name));
        if (!names.length || names.some((n) => !known.has(n))) return json(res, 400, { error: 'Unknown profile' });
        const profile = names.join(','), child = spawnSim(profile, i.udpPort);
        flight = { child, profile };
        child.on('exit', () => { if (flight && flight.child === child) { flight = null; push(); } });
        child.on('error', () => { if (flight && flight.child === child) { flight = null; push(); } });
        push(); return json(res, 200, { ok: true });
      }
      if (url === '/launcher/update/check' && updater) { updater.check().then((s) => json(res, 200, { ok: true, update: s })); return; }
      if (url === '/launcher/update/install' && updater) {
        updater.install().then(() => {}, () => {});                     // progress and any error arrive in the stream
        return json(res, 200, { ok: true });
      }
      if (url === '/launcher/update/open' && updater) { open('release', updater.state().url); return json(res, 200, { ok: true }); }
      if (url === '/launcher/units') {
        if (!o.setUnits || !o.setUnits(body.units)) return json(res, 400, { error: 'Unknown units' });
        push(); return json(res, 200, { ok: true, units: body.units });
      }
      if (url === '/launcher/firewall') {
        if (!fw) return json(res, 400, { error: 'Not needed on this computer' });
        fw.allow(); let n = 0; const t = setInterval(() => { fwRefresh(); if (fwState.allowed || ++n > 20) clearInterval(t); }, 2000); t.unref();   // watch for the answer to the prompt
        return json(res, 200, { ok: true });
      }
      if (url === '/launcher/stop') { json(res, 200, { ok: true }); setTimeout(quit, 150); return; }
      json(res, 404, { error: 'Not found' });
    });
    return true;
  }

  function shutdown() {
    clearInterval(fwTimer); fwTimer = null;
    clearInterval(timer); clearTimeout(graceT); timer = null;
    for (const c of clients) c.destroy(); clients.clear();
    if (flight) { try { flight.child.kill(); } catch (e) { /* already gone */ } flight = null; }
  }
  return { handle, shutdown, snapshot, testFlightRunning: () => !!flight };
}

module.exports = { createLauncherApi, guard, osOpen, windowsFirewall, ruleName, LOOPBACK };
