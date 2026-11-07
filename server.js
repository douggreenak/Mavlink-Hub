// MAVLink hub: listens on UDP as the ONLY client of the ELRS Backpack, serves the dashboard,
// streams raw bytes to browsers, and caches map tiles so viewers need no internet.
// Receive-only toward the plane. Works on any recent Node. No npm install.
//
// Optional environment variables:
//   UDP_PORT (14550)   WEB_PORT (8080)   MAX_TILES (500 tiles per download)
//   TILE_STREET_URL / TILE_SAT_URL  - your own tile source, e.g. https://example.com/{z}/{x}/{y}.png
const dgram = require('dgram'), http = require('http'), https = require('https'), fs = require('fs');
const os = require('os'), path = require('path');
const UDP_PORT = +process.env.UDP_PORT || 14550;
const WEB_PORT = +process.env.WEB_PORT || 8080;
const MAX_TILES = +process.env.MAX_TILES || 500;
const CACHE = path.join(__dirname, 'cache');
const viewers = new Set();

// Settings shared by every connected laptop (units + hidden tiles), saved next to this file.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = { units: 'metric', hidden: [] };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (e) {}
const settingsEvent = () => `event: settings\ndata: ${JSON.stringify(settings)}\n\n`;

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg) => {
  const line = `data: ${msg.toString('base64')}\n\n`;
  for (const v of viewers) v.write(line);
});
udp.on('error', (e) => { console.error('UDP error:', e.message); process.exit(1); });
udp.bind(UDP_PORT, () => console.log(`Node ${process.version} - listening for MAVLink on UDP ${UDP_PORT}`));

const fill = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
const TILES = {
  street: { tpl: process.env.TILE_STREET_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', type: 'image/png' },
  sat: { tpl: process.env.TILE_SAT_URL || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', type: 'image/jpeg' },
};
const tileUrl = (l, z, x, y) => fill(TILES[l].tpl, z, x, y);
const tileFile = (l, z, x, y) => path.join(CACHE, 'tiles', l, String(z), String(x), String(y));

// Download once from the internet and save to disk (no-op if already cached).
function download(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    lib.get(url, { headers: { 'User-Agent': 'MAVLinkHub/1.0 (personal telemetry dashboard)' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) {
        r.resume(); return resolve(download(new URL(r.headers.location, url).href, hops + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
let warned = 0;
async function ensure(file, url) {
  if (fs.existsSync(file)) return;
  let buf;
  try { buf = await download(url); }
  catch (e) { if (warned++ < 3) console.log('Map tile download failed (is this computer online?):', e.message); throw e; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}
async function serveTile(l, z, x, y, res) {
  try {
    const f = tileFile(l, z, x, y);
    await ensure(f, tileUrl(l, z, x, y));
    res.writeHead(200, { 'Content-Type': TILES[l].type, 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.writeHead(404).end(); }
}

// ---- Tile math, download planning, and what is already on disk ----
function ranges(b, z0, z1) {
  const out = [];
  for (let z = z0; z <= z1; z++) {
    const n = 2 ** z, X = (lo) => Math.floor((lo + 180) / 360 * n);
    const Y = (la) => { const r = la * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
    out.push({ z, x0: Math.max(0, X(b.w)), x1: Math.min(n - 1, X(b.e)), y0: Math.max(0, Y(b.n)), y1: Math.min(n - 1, Y(b.s)) });
  }
  return out;
}
const countOf = (rs) => rs.reduce((a, r) => a + Math.max(0, r.x1 - r.x0 + 1) * Math.max(0, r.y1 - r.y0 + 1), 0);
function listOf(rs) {
  const out = [];
  for (const r of rs) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) out.push([r.z, x, y]);
  return out;
}
function parsePlan(qs) {
  const q = new URLSearchParams(qs), l = q.get('layer');
  const a = { w: +q.get('w'), e: +q.get('e'), s: +q.get('s'), n: +q.get('n') };
  const z0 = Math.max(0, Math.floor(+q.get('z0'))), z1 = Math.min(17, Math.floor(+q.get('z1')));
  if (!TILES[l] || Object.values(a).some(isNaN) || isNaN(z0) || isNaN(z1) || z0 > z1) return { error: 'Bad request' };
  const b = { w: Math.min(a.w, a.e), e: Math.max(a.w, a.e), s: Math.max(-85, Math.min(a.s, a.n)), n: Math.min(85, Math.max(a.s, a.n)) };
  return { l, rs: ranges(b, z0, z1) };
}
const ls = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
function summary(l) {
  const zooms = {}; let tiles = 0, bytes = 0; const base = path.join(CACHE, 'tiles', l);
  for (const z of ls(base)) {
    let n = 0, b = 0;
    for (const x of ls(path.join(base, z))) for (const y of ls(path.join(base, z, x))) {
      n++; try { b += fs.statSync(path.join(base, z, x, y)).size; } catch (e) {}
    }
    if (n) { zooms[z] = { tiles: n, bytes: b }; tiles += n; bytes += b; }
  }
  return { layer: l, zooms, avg: tiles ? Math.round(bytes / tiles) : 0 };
}
function coverage(l, z) {
  const out = [], base = path.join(CACHE, 'tiles', l, String(z));
  for (const x of ls(base)) for (const y of ls(path.join(base, x))) { out.push([+x, +y]); if (out.length >= 20000) return out; }
  return out;
}

let job = { done: 0, total: 0, running: false, failed: 0, cancel: false };
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer((req, res) => {
  let m;
  const [url, qs = ''] = req.url.split('?');
  if (url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    res.write(settingsEvent());
    viewers.add(res);
    req.on('close', () => viewers.delete(res));
  } else if ((m = url.match(/^\/tiles\/(street|sat)\/(\d+)\/(\d+)\/(\d+)$/))) {
    serveTile(m[1], m[2], m[3], m[4], res);
  } else if ((m = url.match(/^\/vendor\/(leaflet\.js|leaflet\.css|qrcode\.js|images\/[\w.-]+)$/))) {
    const f = path.join(__dirname, 'vendor', m[1]);
    const types = { js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml' };
    if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[f.split('.').pop()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } else if (url === '/precache/plan') {
    const p = parsePlan(qs);
    if (p.error) return json(res, { error: p.error });
    const total = countOf(p.rs);
    const missing = total <= 5000 ? listOf(p.rs).filter(([z, x, y]) => !fs.existsSync(tileFile(p.l, z, x, y))).length : null;
    json(res, { total, missing, limit: MAX_TILES });
  } else if (url === '/precache') {
    const p = parsePlan(qs);
    if (p.error) return json(res, { error: p.error });
    if (job.running) return json(res, { error: 'A map download is already running' });
    const total = countOf(p.rs);
    if (total > MAX_TILES) return json(res, { error: `That is ${total} tiles; the limit is ${MAX_TILES}. Shrink the area or lower the max detail.` });
    const list = listOf(p.rs);
    job = { done: 0, total: list.length, running: true, failed: 0, cancel: false };
    (async () => {
      for (const [z, x, y] of list) {
        if (job.cancel) break;
        const f = tileFile(p.l, z, x, y), had = fs.existsSync(f);
        try { await ensure(f, tileUrl(p.l, z, x, y)); } catch (e) { job.failed++; }
        job.done++;
        if (!had) await sleep(120);   // be polite to the tile server
      }
      job.running = false;
    })();
    json(res, { total: list.length });
  } else if (url === '/precache/cancel') {
    job.cancel = true; json(res, { ok: true });
  } else if (url === '/precache/status') {
    json(res, job);
  } else if (url === '/cache/summary') {
    const l = new URLSearchParams(qs).get('layer');
    json(res, TILES[l] ? summary(l) : { error: 'Bad layer' });
  } else if (url === '/cache/coverage') {
    const q = new URLSearchParams(qs), l = q.get('layer'), z = Math.floor(+q.get('z'));
    json(res, TILES[l] && z >= 0 && z <= 19 ? { z, tiles: coverage(l, z) } : { error: 'Bad request' });
  } else if (url === '/info') {
    // Addresses a phone on the same network can use; private ranges first.
    const urls = [];
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${WEB_PORT}`);
    const priv = (u) => /\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u) ? 0 : 1;
    json(res, { urls: urls.sort((a, b) => priv(a) - priv(b)) });
  } else if (url === '/settings' && req.method === 'GET') {
    json(res, settings);
  } else if (url === '/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      try {
        const o = JSON.parse(body);
        if (['metric', 'imperial'].includes(o.units)) settings.units = o.units;
        if (Array.isArray(o.hidden)) settings.hidden = o.hidden.filter((x) => typeof x === 'string' && x.length < 60).slice(0, 100);
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        for (const v of viewers) v.write(settingsEvent());
        json(res, settings);
      } catch (e) { res.writeHead(400).end('Bad JSON'); }
    });
  } else if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } else {
    res.writeHead(404).end('Not found');
  }
}).listen(WEB_PORT, '0.0.0.0', () => {
  console.log('Open the dashboard from any laptop on the same network:');
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${WEB_PORT}`);
});
