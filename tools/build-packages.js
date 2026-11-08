#!/usr/bin/env node
'use strict';
// Builds the two download packages, each with its own copy of Node.js, so people only download, unzip and double-click.
//
//   node tools/build-packages.js                  both, with the current Node LTS
//   node tools/build-packages.js --only mac       one platform
//   node tools/build-packages.js --node v24.22.2  a specific Node version
//   node tools/build-packages.js --no-runtime     the same folders without Node (fast; used by the tests)
//
// Output goes to dist/: MAVLink-Hub-Windows.zip, MAVLink-Hub-Mac.zip and SHA256SUMS.txt.
// Node comes straight from nodejs.org and is checked against the SHA-256 list nodejs.org publishes; the official
// binaries are used untouched, so their signatures stay valid. Needs: node, zip, unzip, tar (all standard on a Mac or Linux).
const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..'), DIST = path.join(ROOT, 'dist'), CACHE = path.join(ROOT, '.build-cache');
const TOP = 'MAVLink Hub';                                              // the folder people get when they unzip

// What goes into a package. Tests, docs, screenshots and build tools stay out.
const APP_FILES = ['server.js', 'airspace.js', 'launcher.js', 'launcher-api.js', 'launcher.html', 'index.html', 'package.json', 'hub.env.example'];
const APP_DIRS = ['vendor', 'assets', 'sim'];
const PLATFORM_FILES = {
  windows: ['MAVLink Hub.bat', 'launcher.ps1', 'Create desktop shortcut.bat', 'start.bat'],
  mac: ['MAVLink Hub.app', 'start.command'],
};
// Where the launchers look for the bundled Node. Keep in step with launcher.ps1, start.bat, start.command and the Mac app (a test checks).
const RUNTIME = { windows: ['runtime/node.exe'], mac: ['runtime/node-arm64', 'runtime/node-x64'] };
const EXECUTABLE = { windows: [], mac: ['MAVLink Hub.app/Contents/MacOS/MAVLink Hub', 'start.command'] };

const READ_ME = {
  windows: `MAVLink Hub for Windows
=======================

Nothing else needs installing: Node.js is included.

1. Keep this whole folder together, somewhere you will keep it (for example C:\\MAVLink Hub).
2. Double-click "MAVLink Hub.bat".
   - If Windows SmartScreen says it protected your PC, click "More info", then "Run anyway".
     The file is a plain script you can open in Notepad.
   - The first time, Windows Firewall asks about Node.js. Tick "Private networks" and click "Allow access".
3. The MAVLink Hub window opens. Click "Open the dashboard".

Optional: double-click "Create desktop shortcut.bat" to put an icon on your Desktop.

Make sure the Wi-Fi you fly on is set to "Private" in Windows, or phones cannot reach the dashboard.
Full instructions and troubleshooting: https://github.com/douggreenak/Mavlink-Hub
`,
  mac: `MAVLink Hub for Mac
===================

Nothing else needs installing: Node.js is included (for both Apple Silicon and Intel Macs).

1. Keep this whole folder together, somewhere you will keep it.
2. Double-click "MAVLink Hub.app".
   - The first time, macOS may refuse because it was downloaded. Right-click the app, choose "Open", then "Open" again.
     If it still refuses: System Settings > Privacy & Security > "Open Anyway".
   - When macOS asks whether to let "node" accept incoming network connections, click "Allow".
3. The MAVLink Hub window opens. Click "Open the dashboard".

Full instructions and troubleshooting: https://github.com/douggreenak/Mavlink-Hub
`,
};

// ---------- pure helpers (tested) ----------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function parseShasums(text) { const out = {}; for (const line of text.split(/\r?\n/)) { const m = line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/i); if (m) out[m[2]] = m[1].toLowerCase(); } return out; }
const pickLts = (index) => { const e = index.find((x) => x.lts); if (!e) throw new Error('no LTS version in the Node index'); return e.version; };
const nodeFiles = (v) => ({ windows: `node-${v}-win-x64.zip`, 'mac-arm64': `node-${v}-darwin-arm64.tar.gz`, 'mac-x64': `node-${v}-darwin-x64.tar.gz` });

// Copy the app (and the right launcher files for `platform`) into outDir. Returns the relative file list.
function assemble({ platform, outDir, root = ROOT }) {
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const copy = (rel) => {
    const from = path.join(root, rel), to = path.join(outDir, rel);
    if (!fs.existsSync(from)) throw new Error('missing from the project: ' + rel);
    fs.cpSync(from, to, { recursive: true, filter: (p) => path.basename(p) !== '.DS_Store' });
  };
  for (const f of [...APP_FILES, ...APP_DIRS, ...PLATFORM_FILES[platform]]) copy(f);
  fs.writeFileSync(path.join(outDir, 'Read me first.txt'), platform === 'windows' ? READ_ME.windows.replace(/\n/g, '\r\n') : READ_ME.mac);
  for (const f of EXECUTABLE[platform]) fs.chmodSync(path.join(outDir, f), 0o755);
  const list = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else list.push(path.relative(outDir, p).split(path.sep).join('/')); } })(outDir);
  return list.sort();
}

// ---------- downloading Node ----------
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mavlink-hub-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
    }).on('error', reject);
  });
}
async function fetchNode(version, file, sums) {
  fs.mkdirSync(CACHE, { recursive: true });
  const cached = path.join(CACHE, file), want = sums[file];
  if (!want) throw new Error(`${file} is not in nodejs.org's checksum list for ${version}`);
  if (fs.existsSync(cached) && sha256(fs.readFileSync(cached)) === want) return cached;
  console.log('  downloading', file);
  const buf = await get(`https://nodejs.org/dist/${version}/${file}`);
  if (sha256(buf) !== want) throw new Error(`Checksum mismatch for ${file}: refusing to use it`);
  fs.writeFileSync(cached, buf); return cached;
}
const extractOne = (kind, archive, entry) => execFileSync(kind === 'zip' ? 'unzip' : 'tar', kind === 'zip' ? ['-p', archive, entry] : ['-xzOf', archive, entry], { maxBuffer: 400 * 1024 * 1024 });

async function addRuntime(platform, outDir, version) {
  const files = nodeFiles(version), sums = parseShasums((await get(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).toString());
  const rt = path.join(outDir, 'runtime'); fs.mkdirSync(rt, { recursive: true });
  fs.writeFileSync(path.join(rt, 'node-version.txt'), version + '\n');
  if (platform === 'windows') {
    const z = await fetchNode(version, files.windows, sums), dir = files.windows.replace(/\.zip$/, '');
    fs.writeFileSync(path.join(rt, 'node.exe'), extractOne('zip', z, `${dir}/node.exe`));
    fs.writeFileSync(path.join(rt, 'LICENSE-node.txt'), extractOne('zip', z, `${dir}/LICENSE`));
  } else {
    for (const arch of ['arm64', 'x64']) {
      const t = await fetchNode(version, files['mac-' + arch], sums), dir = files['mac-' + arch].replace(/\.tar\.gz$/, '');
      const dest = path.join(rt, 'node-' + arch); fs.writeFileSync(dest, extractOne('tar', t, `${dir}/bin/node`)); fs.chmodSync(dest, 0o755);
      if (arch === 'arm64') fs.writeFileSync(path.join(rt, 'LICENSE-node.txt'), extractOne('tar', t, `${dir}/LICENSE`));
    }
  }
}

async function main() {
  const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const only = arg('only'), runtime = !a.includes('--no-runtime'), targets = only ? [only] : ['windows', 'mac'];
  for (const t of targets) if (!PLATFORM_FILES[t]) throw new Error(`unknown platform "${t}" (windows or mac)`);
  let version = arg('node') || process.env.NODE_VERSION;
  if (runtime && !version) version = pickLts(JSON.parse((await get('https://nodejs.org/dist/index.json')).toString()));
  if (version && !version.startsWith('v')) version = 'v' + version;
  fs.mkdirSync(DIST, { recursive: true });
  const sums = [];
  for (const t of targets) {
    const name = `MAVLink-Hub-${t === 'windows' ? 'Windows' : 'Mac'}`, stage = path.join(DIST, 'stage-' + t), folder = path.join(stage, TOP), zip = path.join(DIST, name + '.zip');
    console.log(`${name}${runtime ? ' with Node ' + version : ' (no Node)'}`);
    const list = assemble({ platform: t, outDir: folder });
    if (runtime) await addRuntime(t, folder, version);
    fs.rmSync(zip, { force: true });
    execFileSync('zip', ['-r', '-X', '-q', zip, TOP], { cwd: stage });
    fs.rmSync(stage, { recursive: true, force: true });
    const size = fs.statSync(zip).size; sums.push(`${sha256(fs.readFileSync(zip))}  ${name}.zip`);
    console.log(`  ${path.relative(ROOT, zip)}  ${(size / 1048576).toFixed(1)} MB, ${list.length} app files`);
  }
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
}

if (require.main === module) main().catch((e) => { console.error('Build failed: ' + e.message); process.exit(1); });
module.exports = { assemble, parseShasums, pickLts, sha256, nodeFiles, APP_FILES, APP_DIRS, PLATFORM_FILES, EXECUTABLE, RUNTIME, TOP };
