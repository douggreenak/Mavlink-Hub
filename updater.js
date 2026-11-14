'use strict';
// Checks GitHub for a newer MAVLink Hub and, when asked, downloads and installs it.
//
//  - Looks at the project's latest GitHub release and compares its version with this one. Nothing is sent but the request.
//  - Installing downloads this computer's own download from that release (MAVLink-Hub-Setup.exe or MAVLink-Hub.dmg, the same files
//    people install from), checks it against the release's SHA256SUMS.txt, and refuses to go on if the checksum is wrong.
//    Only github.com release downloads over https are accepted.
//  - Windows: a small PowerShell helper (written to the saved-data folder) waits for the hub and its window to close, runs the
//    installer silently over the app folder (hub.env and saved data are never touched) and starts the hub again.
//  - Mac: the new MAVLink Hub.app is copied out of the disk image beside the old one and swapped in; the app then reopens itself.
//  - Only the downloaded app can update itself. A Git checkout or `node server.js` just gets a link to the release page.
const fs = require('fs'), path = require('path'), os = require('os'), https = require('https'), http = require('http'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const API = 'https://api.github.com/repos/douggreenak/Mavlink-Hub/releases/latest';
const PAGE = 'https://github.com/douggreenak/Mavlink-Hub/';
const MAC_APP = 'MAVLink Hub.app';
const ASSET = { win32: 'MAVLink-Hub-Setup.exe', darwin: 'MAVLink-Hub.dmg' };
const RELAUNCH_MARKER = path.join(os.tmpdir(), 'mavlink-hub-relaunch');   // the Mac app reads this on its way out (see mac/HubWindow.swift)

const parts = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function parseSums(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) { const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/); if (m) out[m[2]] = m[1].toLowerCase(); }
  return out;
}

// Can this copy of the hub replace itself, and if not, why not?
function installKind({ platform = process.platform, serverDir, exists = fs.existsSync, access = fs.accessSync } = {}) {
  const no = (reason) => ({ kind: null, reason });
  const writable = (p) => { try { access(p, fs.constants.W_OK); return true; } catch (e) { return false; } };
  if (platform === 'win32') {
    if (!exists(path.join(serverDir, 'runtime', 'node.exe'))) return no('Updates install themselves only in the downloaded app. This copy runs from a source folder.');
    if (!writable(serverDir)) return no('The MAVLink Hub folder is read-only, so it cannot update itself. Move it somewhere you can write to (for example C:\\MAVLink Hub).');
    return { kind: 'windows', dir: serverDir };
  }
  if (platform === 'darwin') {
    const m = serverDir.match(/^(.*\.app)\/Contents\/Resources\/app$/);
    if (!m) return no('Updates install themselves only in the downloaded app. This copy runs from a source folder.');
    if (/AppTranslocation/.test(m[1])) return no('macOS is running MAVLink Hub from a temporary read-only copy. Drag MAVLink Hub into your Applications folder, open it from there, and it can update itself.');
    if (!writable(m[1]) || !writable(path.dirname(m[1]))) return no('MAVLink Hub is in a folder you cannot change, so it cannot replace itself. Move it to Applications (or your own folder).');
    return { kind: 'mac', app: m[1] };
  }
  return no('Updates install themselves only in the downloaded Windows and Mac apps.');
}

function get(url, { allowHttp = false, headers = {}, timeout = 30000, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('Bad address')); }
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return reject(new Error('Refusing an address that is not https'));
    const req = (u.protocol === 'http:' ? http : https).get(u, { headers: { 'User-Agent': 'MAVLinkHub-updater', Accept: '*/*', ...headers }, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); if (hops >= 5) return reject(new Error('Too many redirects'));
        return resolve(get(new URL(res.headers.location, u).href, { allowHttp, headers, timeout, hops: hops + 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timed out'))); req.on('error', reject);
  });
}
async function readText(url, o) {
  const res = await get(url, o);
  return new Promise((resolve, reject) => {
    let b = ''; res.setEncoding('utf8');
    res.on('data', (c) => { b += c; if (b.length > 5e6) res.destroy(new Error('answer too large')); });
    res.on('end', () => resolve(b)); res.on('error', reject);
  });
}
// Stream a download to `file`, hashing as it goes. Resolves with the SHA-256 and size.
async function downloadTo(url, file, { onProgress, ...o } = {}) {
  const res = await get(url, o), total = +res.headers['content-length'] || 0, hash = crypto.createHash('sha256'), part = file + '.part';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part); let n = 0;
    res.on('data', (c) => { hash.update(c); n += c.length; if (onProgress) onProgress(n, total); });
    res.on('error', (e) => { out.destroy(); reject(e); }); out.on('error', reject); out.on('finish', resolve);
    res.pipe(out);
  }).catch((e) => { try { fs.unlinkSync(part); } catch (x) { /* nothing to remove */ } throw e; });
  fs.renameSync(part, file);
  return { sha256: hash.digest('hex'), bytes: fs.statSync(file).size };
}

// ---- Windows: the helper that does the swap once nothing is using the files ----
const WINDOWS_HELPER = `# Applies a MAVLink Hub update. Started (hidden) by the hub itself; it waits for the hub and its window to close first,
# then runs the same installer people install from, silently, over this copy.
param([string]$Setup, [string]$Dest, [int]$HubPid, [int]$OwnerPid)
Add-Type -AssemblyName System.Windows.Forms
function Fail([string]$m) { [System.Windows.Forms.MessageBox]::Show($m, 'MAVLink Hub update', 'OK', 'Warning') | Out-Null; exit 1 }
function Wait-Gone([int]$p, [int]$sec) { if ($p -le 0) { return }; try { Wait-Process -Id $p -Timeout $sec -ErrorAction Stop } catch { } }
Wait-Gone $HubPid 30
if ($OwnerPid -gt 0) { Start-Sleep -Milliseconds 800; Stop-Process -Id $OwnerPid -Force -ErrorAction SilentlyContinue; Wait-Gone $OwnerPid 15 }
# /S = silent, /D= = install into this very folder (it must be the last argument and is not quoted)
$p = Start-Process -FilePath $Setup -ArgumentList "/S /D=$Dest" -Wait -PassThru
if ($null -ne $p.ExitCode -and $p.ExitCode -ne 0) { Fail 'The update could not be installed (is another program using the MAVLink Hub folder?). Close it and try again from the MAVLink Hub window.' }
Remove-Item -Force $Setup -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -WorkingDirectory $Dest -WindowStyle Hidden -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Dest 'launcher.ps1') + '"')
`;

// ---- Mac: unpack beside the app, then swap the bundles. Running programs keep the files they already opened. ----
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, out) => (e ? reject(e) : resolve(out))));
// Copy MAVLink Hub.app out of the disk image into `dest` (the image is opened read-only, without a Finder window, and closed again).
async function dmgExtract(dmg, dest) {
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dmg-'));
  await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-noautoopen', '-mountpoint', mnt, dmg]);
  try { await run('/usr/bin/ditto', [path.join(mnt, MAC_APP), path.join(dest, MAC_APP)]); }
  finally { await run('/usr/bin/hdiutil', ['detach', '-force', mnt]).catch(() => {}); try { fs.rmdirSync(mnt); } catch (e) { /* still mounted: leave it */ } }
}
async function swapMacApp({ dmg, app, extract = dmgExtract, now = Date.now }) {
  const parent = path.dirname(app), stage = path.join(parent, '.MAVLink Hub update ' + now());
  try {
    fs.mkdirSync(stage, { recursive: true });
    await extract(dmg, stage);
    const fresh = path.join(stage, MAC_APP);
    if (!fs.existsSync(path.join(fresh, 'Contents', 'Resources', 'app', 'server.js'))) throw new Error('The downloaded update does not look like MAVLink Hub, so it was not installed.');
    const old = app + '.old-' + now();
    fs.renameSync(app, old);
    try { fs.renameSync(fresh, app); } catch (e) { fs.renameSync(old, app); throw e; }
    return old;
  } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* leftover temp folder */ } }
}
// The new app removes the previous copy on its first start (the old one is still running from it until then).
function removeOldCopies(app) {
  try { const base = path.basename(app) + '.old-'; for (const f of fs.readdirSync(path.dirname(app))) if (f.startsWith(base)) fs.rmSync(path.join(path.dirname(app), f), { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

function createUpdater(o) {
  const { version, dataDir, serverDir, quit, onChange = () => {}, platform = process.platform, apiUrl = API, allowHttp = false,
    extract, spawnFn = spawn, pid = process.pid, ownerPid = +process.env.HUB_OWNER_PID || 0, now = Date.now, marker = RELAUNCH_MARKER } = o;
  const how = installKind({ platform, serverDir });
  if (how.kind === 'mac') removeOldCopies(how.app);
  const disabled = String(process.env.UPDATE_CHECK || '').toLowerCase() === 'off';
  const state = { status: disabled ? 'disabled' : 'idle', current: version, latest: null, url: PAGE + 'releases/latest', notes: '', pct: 0, error: null, canInstall: !!how.kind, reason: how.reason || null, checkedAt: 0 };
  let assets = null, last = 0;
  const change = (patch) => { Object.assign(state, patch); onChange(); };
  const ok = (url) => allowHttp || String(url).startsWith(PAGE + 'releases/download/');

  async function check() {
    if (disabled || ['checking', 'downloading', 'installing'].includes(state.status)) return { ...state };
    change({ status: 'checking', error: null });
    try {
      const rel = JSON.parse(await readText(apiUrl, { allowHttp, headers: { Accept: 'application/vnd.github+json' } }));
      const tag = String(rel.tag_name || '');
      if (!/^v?\d+\.\d+(\.\d+)?/.test(tag)) throw new Error('GitHub sent an answer I could not read');
      const latest = tag.replace(/^v/i, ''), list = Array.isArray(rel.assets) ? rel.assets : [];
      const find = (n) => list.find((a) => a && a.name === n && typeof a.browser_download_url === 'string');
      assets = { pkg: find(ASSET[platform]), sums: find('SHA256SUMS.txt') };
      const newer = compareVersions(latest, version) > 0, html = String(rel.html_url || '');
      const missing = newer && how.kind && !(assets.pkg && assets.sums);
      last = now();
      change({ status: newer ? 'available' : 'uptodate', latest, url: html.startsWith(PAGE) || allowHttp ? html : PAGE + 'releases/latest', notes: String(rel.body || '').slice(0, 800),
        checkedAt: last, pct: 0, canInstall: !!how.kind && !missing, reason: missing ? 'This release has no download for your computer yet. Try again later.' : how.reason || null });
    } catch (e) { change({ status: 'error', error: 'Could not check for updates (' + e.message + '). Is this computer online?', checkedAt: now() }); }
    return { ...state };
  }
  const checkIfStale = () => { if (!disabled && (!last || now() - last > 6 * 3600e3) && state.status !== 'checking') return check(); };

  async function install() {
    if (state.status !== 'available' || !state.canInstall || !assets || !assets.pkg || !assets.sums) throw new Error('There is no update ready to install.');
    if (!ok(assets.pkg.browser_download_url) || !ok(assets.sums.browser_download_url)) throw new Error('The download address is not one this app trusts.');
    const file = path.join(dataDir, 'updates', assets.pkg.name);
    try {
      change({ status: 'downloading', pct: 0, error: null });
      const want = parseSums(await readText(assets.sums.browser_download_url, { allowHttp }))[assets.pkg.name];
      if (!want) throw new Error('The release has no checksum for ' + assets.pkg.name);
      let tick = 0;
      const got = await downloadTo(assets.pkg.browser_download_url, file, { allowHttp, onProgress: (n, t) => { if (t && now() - tick > 250) { tick = now(); change({ pct: Math.min(99, Math.round(n / t * 100)) }); } } });
      if (got.sha256 !== want) { try { fs.unlinkSync(file); } catch (e) { /* gone */ } throw new Error('The download is damaged (its checksum does not match), so it was not installed.'); }
      change({ status: 'installing', pct: 100 });
      if (how.kind === 'windows') {
        const script = path.join(dataDir, 'updates', 'apply-update.ps1');
        fs.writeFileSync(script, WINDOWS_HELPER);
        const c = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Setup', file, '-Dest', how.dir, '-HubPid', String(pid), '-OwnerPid', String(ownerPid)],
          { detached: true, stdio: 'ignore', windowsHide: true });
        if (c.on) c.on('error', () => {}); if (c.unref) c.unref();
      } else {
        await swapMacApp({ dmg: file, app: how.app, extract, now });
        try { fs.unlinkSync(file); } catch (e) { /* kept for the next try */ }
        fs.writeFileSync(marker, how.app);
      }
      change({ status: 'restarting' });
      setTimeout(quit, 800);                       // the hub stops; the helper (Windows) or the Mac app brings the new version up
    } catch (e) { change({ status: 'available', pct: 0, error: e.message }); throw e; }
  }
  return { state: () => ({ ...state }), check, checkIfStale, install, how };
}

module.exports = { createUpdater, installKind, compareVersions, parseSums, downloadTo, readText, swapMacApp, dmgExtract, removeOldCopies, WINDOWS_HELPER, RELAUNCH_MARKER, API, PAGE, ASSET };
