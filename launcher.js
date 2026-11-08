#!/usr/bin/env node
'use strict';
// Starts the hub (if it is not already running) and opens its control window.
// Used by "MAVLink Hub.bat" on Windows and "MAVLink Hub.app" on a Mac; also fine to run by hand: node launcher.js
//
// - If a hub is already answering on the port, it just opens the window again, so double-clicking twice is harmless.
// - Otherwise it starts the hub in the background (no console window) with its output going to hub.log.
// - The window is opened in "app mode" (no address bar) in Edge, Chrome, Brave or Chromium, with its own small profile
//   so it never touches your normal browser. With none of those installed it falls back to your default browser.
// On failure it prints a plain message to stderr and exits 1; the Windows and Mac wrappers show that in a dialog.
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;

// Where Chromium-based browsers usually live, best first.
function browserCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', la = env.LOCALAPPDATA || '';
    return [path.win32.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.win32.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
      path.win32.join(pf, 'Google/Chrome/Application/chrome.exe'), path.win32.join(pf86, 'Google/Chrome/Application/chrome.exe'), la && path.win32.join(la, 'Google/Chrome/Application/chrome.exe'),
      path.win32.join(pf, 'BraveSoftware/Brave-Browser/Application/brave.exe')].filter(Boolean);
  }
  if (platform === 'darwin') {
    const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];
    return apps.flatMap((a) => [`/Applications/${a}.app/Contents/MacOS/${a}`, path.join(home, `Applications/${a}.app/Contents/MacOS/${a}`)]);
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].map((b) => '/usr/bin/' + b);
}
const findBrowser = (platform, env, exists = fs.existsSync, home) => browserCandidates(platform, env, home).find((p) => exists(p)) || null;

// The command line that makes a Chromium browser show a page as a small standalone window.
const appArgs = (url, profileDir, width = 520, height = 840) => [`--app=${url}`, `--window-size=${width},${height}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'];

function openDefault(url) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref();
}
function openWindow(url, dataDir) {
  if (process.env.LAUNCHER_NO_WINDOW) return;          // for tests and headless machines
  const browser = findBrowser();
  if (!browser) return openDefault(url);
  const c = spawn(browser, appArgs(url, path.join(dataDir, 'launcher-profile')), { detached: true, stdio: 'ignore' });
  c.on('error', () => openDefault(url)); c.unref();
}

// Is one of our hubs answering on this port?
function hubRunning(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/info', timeout }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(Array.isArray(JSON.parse(b).urls)); } catch (e) { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The plain-English reason, taken from the last lines of the hub's log.
function explainFailure(log, port) {
  if (/EADDRINUSE/i.test(log) || /already in use/i.test(log)) return `Port ${port} is already in use by another program, so the hub could not start.\n\nClose the other program (another copy of the hub, or a ground station), or choose a different WEB_PORT in hub.env.`;
  const last = log.trim().split(/\r?\n/).slice(-4).join('\n');
  return 'The hub could not start.' + (last ? '\n\n' + last : '');
}

async function main() {
  const S = require('./server.js');                           // also reads hub.env into the environment
  const port = +process.env.WEB_PORT || 8080, url = `http://localhost:${port}/launcher`, dataDir = S.DATA_DIR;
  fs.mkdirSync(dataDir, { recursive: true });
  if (await hubRunning(port)) { openWindow(url, dataDir); return 0; }
  const logFile = path.join(dataDir, 'hub.log'), fd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [path.join(HERE, 'server.js')], { cwd: HERE, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, HUB_LOG: logFile } });
  let exited = false; child.on('exit', () => { exited = true; }); child.on('error', () => { exited = true; });
  for (let i = 0; i < 75; i++) {
    if (await hubRunning(port, 600)) { child.unref(); openWindow(url, dataDir); return 0; }
    if (exited) break;
    await sleep(200);
  }
  let log = ''; try { log = fs.readFileSync(logFile, 'utf8'); } catch (e) { /* none */ }
  try { child.kill(); } catch (e) { /* already gone */ }
  console.error(explainFailure(log, port));
  return 1;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error('The launcher hit a problem: ' + e.message); process.exit(1); });
module.exports = { browserCandidates, findBrowser, appArgs, hubRunning, explainFailure, main };
