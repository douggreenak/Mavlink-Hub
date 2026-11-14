#!/usr/bin/env node
'use strict';
// Builds the two download packages, each with its own copy of Node.js, so people only download, unzip and double-click.
//
//   node tools/build-packages.js                  both, with the current Node LTS
//   node tools/build-packages.js --only mac       one platform
//   node tools/build-packages.js --node v24.22.2  a specific Node version
//   node tools/build-packages.js --no-runtime     the same folders without Node (fast; used by the tests)
//   node tools/build-packages.js --no-installers  only the folders/ZIPs (no installer or disk image)
//   node tools/build-packages.js --zips           also make a portable ZIP of each (not part of a release)
//   node tools/build-packages.js --build-exe out.exe   compile "MAVLink Hub.exe" (the Windows app); run this on Windows
//   node tools/build-packages.js --exe out.exe    put that compiled app into the Windows package and installer
//   node tools/build-packages.js --require-installers  fail if the Windows installer or Mac disk image cannot be built (used by the release)
//
// Output goes to dist/: MAVLink-Hub-Setup.exe (Windows installer), MAVLink-Hub.dmg (Mac disk image) and SHA256SUMS.txt. These are the
// only two downloads of a release; the in-app updater downloads the same files. With --zips (or --no-installers) it also makes a
// portable MAVLink-Hub-Windows.zip / MAVLink-Hub-Mac.zip for local testing.
// The installer needs NSIS (makensis; brew install makensis) and the disk image needs hdiutil, so they are built on a Mac.
// Node comes straight from nodejs.org and is checked against the SHA-256 list nodejs.org publishes; the official
// binaries are used untouched, so their signatures stay valid. Needs: node, zip, unzip, tar (all standard on a Mac or Linux).
const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..'), DIST = path.join(ROOT, 'dist'), CACHE = path.join(ROOT, '.build-cache');
const TOP = 'MAVLink Hub';                                              // the folder people get when they unzip

// What goes into a package. Tests, docs, screenshots and build tools stay out.
const APP_FILES = ['server.js', 'airspace.js', 'updater.js', 'launcher.js', 'launcher-api.js', 'launcher.html', 'index.html', 'package.json', 'hub.env.example'];
const APP_DIRS = ['vendor', 'assets', 'sim'];
// Windows: the app sits in the folder with the launcher. Mac: everything lives INSIDE MAVLink Hub.app (see MAC_APP), so
// macOS can run it from anywhere, including the random read-only copy it makes of a freshly downloaded app.
const PLATFORM_FILES = {
  windows: ['MAVLink Hub.bat', 'launcher.ps1', 'Create desktop shortcut.bat', 'start.bat'],
  mac: ['MAVLink Hub.app'],
};
const MAC_APP = 'MAVLink Hub.app', MAC_RES = MAC_APP + '/Contents/Resources';
// Where the launchers look for the bundled Node. Keep in step with launcher.ps1, start.bat, start.command and the Mac app (a test checks).
const RUNTIME = { windows: ['runtime/node.exe'], mac: [MAC_RES + '/runtime/node-arm64', MAC_RES + '/runtime/node-x64'] };
const EXECUTABLE = { windows: [], mac: [MAC_APP + '/Contents/MacOS/MAVLink Hub'] };

// Windows: the hub's own window is a WebView2 control (the Edge engine already on Windows 10/11). Its small managed wrapper
// comes from Microsoft's NuGet package, checked against this pinned SHA-256, and goes in runtime/webview2 (launcher.ps1).
const WEBVIEW2 = { version: '1.0.2849.39', sha256: '099ec21f62e0e29ef9d9a991d096421efb256bdfdb64984216395736043560fd',
  files: { 'lib/net462/Microsoft.Web.WebView2.Core.dll': 'Microsoft.Web.WebView2.Core.dll', 'lib/net462/Microsoft.Web.WebView2.WinForms.dll': 'Microsoft.Web.WebView2.WinForms.dll',
           'runtimes/win-x64/native/WebView2Loader.dll': 'WebView2Loader.dll', 'LICENSE.txt': 'LICENSE-webview2.txt' } };

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
Everything is inside the one app, so you can put it anywhere, for example in Applications.

1. Drag "MAVLink Hub.app" wherever you like.
2. Double-click it.
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
  const into = platform === 'mac' ? MAC_RES + '/app' : '.';              // where the app's own files go
  const copy = (rel, dest = rel) => {
    const from = path.join(root, rel), to = path.join(outDir, dest);
    if (!fs.existsSync(from)) throw new Error('missing from the project: ' + rel);
    fs.cpSync(from, to, { recursive: true, filter: (p) => path.basename(p) !== '.DS_Store' });
  };
  for (const f of PLATFORM_FILES[platform]) copy(f);
  for (const f of [...APP_FILES, ...APP_DIRS]) copy(f, path.posix.join(into, f));
  fs.writeFileSync(path.join(outDir, 'Read me first.txt'), platform === 'windows' ? READ_ME.windows.replace(/\n/g, '\r\n') : READ_ME.mac);
  for (const f of EXECUTABLE[platform]) fs.chmodSync(path.join(outDir, f), 0o755);
  const list = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else list.push(path.relative(outDir, p).split(path.sep).join('/')); } })(outDir);
  return list.sort();
}

// The Mac app's own window (mac/HubWindow.swift), compiled for Apple Silicon and Intel into one binary. Needs swiftc (Xcode
// command line tools), so it can only be built on a Mac; without it the app falls back to a browser app window.
function buildNative(outDir) {
  const exe = path.join(outDir, MAC_APP, 'Contents', 'MacOS', 'hubwindow'), tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hubwin-'));
  try {
    const parts = ['arm64', 'x86_64'].map((arch) => { const o = path.join(tmp, arch); execFileSync('swiftc', ['-O', '-swift-version', '5', '-target', `${arch}-apple-macos11.0`, '-o', o, path.join(ROOT, 'mac', 'HubWindow.swift')], { stdio: 'inherit' }); return o; });
    execFileSync('lipo', ['-create', ...parts, '-output', exe]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  fs.chmodSync(exe, 0o755); return exe;
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

async function webview2Package() {
  fs.mkdirSync(CACHE, { recursive: true });
  const cached = path.join(CACHE, `webview2-${WEBVIEW2.version}.nupkg`);
  if (!(fs.existsSync(cached) && sha256(fs.readFileSync(cached)) === WEBVIEW2.sha256)) {
    console.log('  downloading WebView2', WEBVIEW2.version);
    const buf = await get(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2.version}/microsoft.web.webview2.${WEBVIEW2.version}.nupkg`);
    if (sha256(buf) !== WEBVIEW2.sha256) throw new Error('Checksum mismatch for the WebView2 package: refusing to use it');
    fs.writeFileSync(cached, buf);
  }
  return cached;
}
async function addWebView2(rt) {
  const cached = await webview2Package();
  const dir = path.join(rt, 'webview2'); fs.mkdirSync(dir, { recursive: true });
  for (const [entry, name] of Object.entries(WEBVIEW2.files)) fs.writeFileSync(path.join(dir, name), extractOne('zip', cached, entry));
}

async function addRuntime(platform, outDir, version) {
  const files = nodeFiles(version), sums = parseShasums((await get(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).toString());
  const rt = path.join(outDir, platform === 'windows' ? 'runtime' : MAC_RES + '/runtime'); fs.mkdirSync(rt, { recursive: true });
  fs.writeFileSync(path.join(rt, 'node-version.txt'), version + '\n');
  if (platform === 'windows') {
    const z = await fetchNode(version, files.windows, sums), dir = files.windows.replace(/\.zip$/, '');
    fs.writeFileSync(path.join(rt, 'node.exe'), extractOne('zip', z, `${dir}/node.exe`));
    fs.writeFileSync(path.join(rt, 'LICENSE-node.txt'), extractOne('zip', z, `${dir}/LICENSE`));
    await addWebView2(rt);
  } else {
    for (const arch of ['arm64', 'x64']) {
      const t = await fetchNode(version, files['mac-' + arch], sums), dir = files['mac-' + arch].replace(/\.tar\.gz$/, '');
      const dest = path.join(rt, 'node-' + arch); fs.writeFileSync(dest, extractOne('tar', t, `${dir}/bin/node`)); fs.chmodSync(dest, 0o755);
      if (arch === 'arm64') fs.writeFileSync(path.join(rt, 'LICENSE-node.txt'), extractOne('tar', t, `${dir}/LICENSE`));
    }
  }
}

// ---------- the Windows app: MAVLink Hub.exe, compiled with the C# compiler that ships with Windows ----------
const EXE_NAME = 'MAVLink Hub.exe';
async function compileExe(outFile) {
  if (process.platform !== 'win32') throw new Error('MAVLink Hub.exe is compiled on Windows (it uses the .NET Framework compiler, csc.exe)');
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error('csc.exe not found: ' + csc);
  const pkg = await webview2Package(), tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hub-exe-'));
  try {
    const refs = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'];
    execFileSync('tar', ['-xf', pkg, '-C', tmp, ...refs.map((r) => 'lib/net462/' + r)]);
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/win32icon:' + path.join(ROOT, 'assets', 'hub.ico'), '/out:' + path.resolve(outFile),
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', ...refs.map((r) => '/r:' + path.join(tmp, 'lib', 'net462', r)), path.join(ROOT, 'windows', 'HubWindow.cs')], { stdio: 'inherit' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('built ' + outFile);
}

// ---------- the Windows installer (NSIS) and the Mac disk image ----------
// A per-user install (no administrator prompt) into %LOCALAPPDATA%\Programs\MAVLink Hub, so the app can update itself there.
// Start menu and Desktop shortcuts start the launcher without a console window; Apps & features gets an uninstall entry.
const PS_EXE = '$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe', PS_ARGS = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\\launcher.ps1"';
const UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MAVLinkHub';
function nsisScript({ version, srcDir, outFile, icon, hasExe = false }) {
  const v = String(version).replace(/^v/, ''), v4 = v.split('.').concat(['0', '0', '0']).slice(0, 4).map((n) => parseInt(n, 10) || 0).join('.');
  const q = (p) => p.replace(/\\/g, '/');     // makensis accepts forward slashes on every system
  // With the compiled app, the shortcuts and "Open MAVLink Hub" run MAVLink Hub.exe (so it can be pinned to the taskbar and has its own
  // icon); without it (a local build) they fall back to the PowerShell launcher.
  const target = hasExe ? '"$INSTDIR\\MAVLink Hub.exe"' : `"${PS_EXE}"`, params = hasExe ? '""' : `'${PS_ARGS}'`, runCmd = hasExe ? '"$INSTDIR\\MAVLink Hub.exe"' : `'"${PS_EXE}" ${PS_ARGS}'`;
  const style = hasExe ? 'SW_SHOWNORMAL' : 'SW_SHOWMINIMIZED';
  const stopHub = `nsExec::Exec \`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $$PID -and ($$_.ExecutablePath -like '$INSTDIR\\*' -or $$_.CommandLine -like '*$INSTDIR\\launcher.ps1*') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"\``;
  return `; Generated by tools/build-packages.js. Builds the MAVLink Hub installer for Windows.
Unicode true
!include "MUI2.nsh"
Name "MAVLink Hub"
OutFile "${q(outFile)}"
InstallDir "$LOCALAPPDATA\\Programs\\MAVLink Hub"
InstallDirRegKey HKCU "Software\\MAVLinkHub" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "MAVLink Hub ${v}"
!define MUI_ICON "${q(icon)}"
!define MUI_UNICON "${q(icon)}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "This installs MAVLink Hub for your Windows account. Nothing else needs installing: Node.js is included.$\\r$\\n$\\r$\\nYour saved maps and settings are kept when you update or reinstall."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchHub
!define MUI_FINISHPAGE_RUN_TEXT "Open MAVLink Hub"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
VIProductVersion "${v4}"
VIAddVersionKey /LANG=${'${LANG_ENGLISH}'} "ProductName" "MAVLink Hub"
VIAddVersionKey /LANG=${'${LANG_ENGLISH}'} "FileDescription" "MAVLink Hub installer"
VIAddVersionKey /LANG=${'${LANG_ENGLISH}'} "FileVersion" "${v}"
VIAddVersionKey /LANG=${'${LANG_ENGLISH}'} "LegalCopyright" "MAVLink Hub"

Function LaunchHub
  Exec ${runCmd}
FunctionEnd

Section "Install"
  ${stopHub}
  SetOutPath "$INSTDIR"
  File /r "${q(srcDir)}/*"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\\MAVLink Hub"
  CreateShortcut "$SMPROGRAMS\\MAVLink Hub\\MAVLink Hub.lnk" ${target} ${params} "$INSTDIR\\assets\\hub.ico" 0 ${style} "" "Start the MAVLink Hub"
  CreateShortcut "$SMPROGRAMS\\MAVLink Hub\\Uninstall MAVLink Hub.lnk" "$INSTDIR\\Uninstall.exe"
  CreateShortcut "$DESKTOP\\MAVLink Hub.lnk" ${target} ${params} "$INSTDIR\\assets\\hub.ico" 0 ${style} "" "Start the MAVLink Hub"
  WriteRegStr HKCU "Software\\MAVLinkHub" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "MAVLink Hub"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${v}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "MAVLink Hub"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\\assets\\hub.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ${stopHub}
  Delete "$DESKTOP\\MAVLink Hub.lnk"
  RMDir /r "$SMPROGRAMS\\MAVLink Hub"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\\MAVLinkHub"
  MessageBox MB_YESNO|MB_DEFBUTTON2 "Also delete your saved maps, airspace data and settings?$\\r$\\n$\\r$\\nChoose No to keep them for a later reinstall." /SD IDNO IDNO keep
  RMDir /r "$APPDATA\\MAVLink Hub"
  keep:
SectionEnd
`;
}
const have = (cmd, args = ['--version']) => { const r = spawnSync(cmd, args, { stdio: 'ignore' }); return !r.error; };
function buildWindowsInstaller(folder, outFile, version, hasExe) {
  const nsi = path.join(path.dirname(outFile), 'installer.nsi');
  fs.writeFileSync(nsi, nsisScript({ version, srcDir: folder, outFile, icon: path.join(folder, 'assets', 'hub.ico'), hasExe }));
  try { execFileSync('makensis', ['-V2', nsi], { stdio: 'inherit' }); } finally { fs.rmSync(nsi, { force: true }); }
}
function buildDmg(folder, outFile) {
  const stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hub-dmg-'));
  try {
    execFileSync('ditto', [path.join(folder, MAC_APP), path.join(stage, MAC_APP)]);     // ditto keeps permissions and the universal helper intact
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));                  // the "drag it here" arrow target
    fs.rmSync(outFile, { force: true });
    execFileSync('hdiutil', ['create', '-volname', 'MAVLink Hub', '-srcfolder', stage, '-ov', '-format', 'UDZO', outFile], { stdio: 'inherit' });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

async function main() {
  const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const only = arg('only'), runtime = !a.includes('--no-runtime'), targets = only ? [only] : ['windows', 'mac'];
  for (const t of targets) if (!PLATFORM_FILES[t]) throw new Error(`unknown platform "${t}" (windows or mac)`);
  let version = arg('node') || process.env.NODE_VERSION;
  if (runtime && !version) version = pickLts(JSON.parse((await get('https://nodejs.org/dist/index.json')).toString()));
  if (version && !version.startsWith('v')) version = 'v' + version;
  fs.mkdirSync(DIST, { recursive: true });
  const buildExe = arg('build-exe'); if (buildExe) return compileExe(buildExe);
  const exePath = arg('exe'), sums = [], pkgVersion = require('../package.json').version;
  if (exePath && !fs.existsSync(exePath)) throw new Error('--exe file not found: ' + exePath);
  for (const t of targets) {
    const name = `MAVLink-Hub-${t === 'windows' ? 'Windows' : 'Mac'}`, stage = path.join(DIST, 'stage-' + t), folder = path.join(stage, TOP), zip = path.join(DIST, name + '.zip');
    console.log(`${name}${runtime ? ' with Node ' + version : ' (no Node)'}`);
    const list = assemble({ platform: t, outDir: folder });
    if (runtime) await addRuntime(t, folder, version);
    if (t === 'windows' && exePath) fs.copyFileSync(exePath, path.join(folder, EXE_NAME));
    if (t === 'windows' && a.includes('--require-installers') && !exePath) throw new Error('the Windows app (MAVLink Hub.exe) is needed: build it first with --build-exe, then pass --exe');
    if (t === 'mac' && !a.includes('--no-native')) { console.log('  compiling the native window'); buildNative(folder); }
    const zipIt = a.includes('--zips') || a.includes('--no-installers');
    if (zipIt) { fs.rmSync(zip, { force: true }); execFileSync('zip', ['-r', '-X', '-q', zip, TOP], { cwd: stage }); }
    if (!a.includes('--no-installers')) { // the app people install: an installer on Windows, a disk image on a Mac
      const need = a.includes('--require-installers'), inst = t === 'windows' ? { out: path.join(DIST, 'MAVLink-Hub-Setup.exe'), tool: 'makensis', build: () => buildWindowsInstaller(folder, path.join(DIST, 'MAVLink-Hub-Setup.exe'), pkgVersion, !!exePath) }
        : { out: path.join(DIST, 'MAVLink-Hub.dmg'), tool: 'hdiutil', build: () => buildDmg(folder, path.join(DIST, 'MAVLink-Hub.dmg')) };
      if (!have(inst.tool, inst.tool === 'hdiutil' ? ['help'] : ['-VERSION'])) { if (need) throw new Error(`${inst.tool} is needed to build ${path.basename(inst.out)}`); console.log(`  (skipping ${path.basename(inst.out)}: ${inst.tool} is not installed)`); }
      else { console.log(`  building ${path.basename(inst.out)}`); inst.build(); sums.push(`${sha256(fs.readFileSync(inst.out))}  ${path.basename(inst.out)}`); console.log(`  ${path.relative(ROOT, inst.out)}  ${(fs.statSync(inst.out).size / 1048576).toFixed(1)} MB`); }
    }
    fs.rmSync(stage, { recursive: true, force: true });
    if (zipIt) { sums.push(`${sha256(fs.readFileSync(zip))}  ${name}.zip`); console.log(`  ${path.relative(ROOT, zip)}  ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB, ${list.length} app files`); }
  }
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
}

if (require.main === module) main().catch((e) => { console.error('Build failed: ' + e.message); process.exit(1); });
module.exports = { nsisScript, EXE_NAME, UNINSTALL_KEY, WEBVIEW2, buildNative, MAC_APP, MAC_RES, assemble, parseShasums, pickLts, sha256, nodeFiles, APP_FILES, APP_DIRS, PLATFORM_FILES, EXECUTABLE, RUNTIME, TOP };
