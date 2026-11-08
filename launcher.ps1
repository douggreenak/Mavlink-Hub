# MAVLink Hub launcher for Windows. Started (hidden) by "MAVLink Hub.bat".
# It only checks that Node.js is there, runs launcher.js, and shows a plain message box if something is wrong.
# The control window itself is a web page served by the hub (launcher.html), opened in an app-style window.
Add-Type -AssemblyName System.Windows.Forms
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

function Say($msg) { [System.Windows.Forms.MessageBox]::Show($msg, 'MAVLink Hub', 'OK', 'Warning') | Out-Null }

if (-not (Test-Path (Join-Path $repo 'server.js'))) {
  Say "server.js was not found next to this launcher.`n`nKeep MAVLink Hub.bat, launcher.ps1 and launcher.js in the same folder as server.js."
  exit 1
}

# Node.js: the copy bundled in runtime\ first (the downloadable package includes one), then PATH, then the usual install folders.
$node = $null
$bundled = Join-Path $repo 'runtime\node.exe'
if (Test-Path $bundled) { $node = $bundled }
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
  foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $c) { $node = $c; break }
  }
}
if (-not $node) {
  $r = [System.Windows.Forms.MessageBox]::Show("Node.js is not installed, and the hub needs it.`n`nOpen the download page now? Choose the LTS version, install it with the defaults, then open MAVLink Hub again.", 'MAVLink Hub', 'YesNo', 'Warning')
  if ($r -eq 'Yes') { Start-Process 'https://nodejs.org' }
  exit 1
}

$out = Join-Path $env:TEMP 'mavlink-hub-launcher.out'
$err = Join-Path $env:TEMP 'mavlink-hub-launcher.err'
$p = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $repo 'launcher.js') + '"') -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
if (-not $p.WaitForExit(60000)) { Say 'The hub is taking too long to start. Check the log in the saved-maps folder (hub.log).'; exit 1 }
if ($p.ExitCode -ne 0) {
  $msg = (Get-Content $err -Raw -ErrorAction SilentlyContinue)
  if (-not $msg) { $msg = 'The hub could not start.' }
  Say $msg.Trim()
  exit 1
}
