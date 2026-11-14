# MAVLink Hub launcher for Windows. Started (hidden) by "MAVLink Hub.bat".
# It only checks that Node.js is there, runs launcher.js, and shows a plain message box if something is wrong.
# The control window is a web page served by the hub (launcher.html). It is shown in this app's own window (WebView2, from
# runtime\webview2, included in the download); if that is not possible it falls back to an Edge/Chrome app-style window.
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

# Starts the hub (or finds it running). With $noWindow the launcher opens no window of its own; the port is in the output.
function Start-Hub([bool]$noWindow) {
  $out = Join-Path $env:TEMP 'mavlink-hub-launcher.out'
  $err = Join-Path $env:TEMP 'mavlink-hub-launcher.err'
  if ($noWindow) { $env:LAUNCHER_NO_WINDOW = '1' }
  try {
    $p = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $repo 'launcher.js') + '"') -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit(60000)) { return @{ code = -1; text = 'The hub is taking too long to start. Check the log in the saved-maps folder (hub.log).'; port = $null } }
  } finally { Remove-Item Env:\LAUNCHER_NO_WINDOW -ErrorAction SilentlyContinue }
  $port = $null; $o = Get-Content $out -Raw -ErrorAction SilentlyContinue
  if ($o -match 'HUB_PORT=(\d+)') { $port = [int]$Matches[1] }
  $msg = (Get-Content $err -Raw -ErrorAction SilentlyContinue)
  if (-not $msg) { $msg = 'The hub could not start.' }
  return @{ code = $p.ExitCode; text = $msg.Trim(); port = $port }
}

# The app's own window: the control page inside a WebView2 control. Returns $true when it opened and was then closed
# normally, $false when it could not be shown (the caller then falls back to a browser app window).
$webview = Join-Path $repo 'runtime\webview2'
function Show-Window([int]$port) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    Add-Type -Path (Join-Path $webview 'Microsoft.Web.WebView2.Core.dll')
    Add-Type -Path (Join-Path $webview 'Microsoft.Web.WebView2.WinForms.dll')
    $script:hubPort = $port; $script:ready = $false; $script:failed = $false
    $dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $env:APPDATA 'MAVLink Hub' }
    $script:form = New-Object System.Windows.Forms.Form
    $script:form.Text = 'MAVLink Hub'
    $script:form.ClientSize = New-Object System.Drawing.Size(520, 840)
    $script:form.MinimumSize = New-Object System.Drawing.Size(440, 600)
    $script:form.StartPosition = 'CenterScreen'
    $ico = Join-Path $repo 'assets\hub.ico'
    if (Test-Path $ico) { $script:form.Icon = New-Object System.Drawing.Icon($ico) }
    $wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
    $wv.Dock = 'Fill'
    $props = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
    $props.UserDataFolder = Join-Path $dataDir 'webview2-profile'
    $wv.CreationProperties = $props
    $wv.add_CoreWebView2InitializationCompleted({
      param($s, $e)
      if (-not $e.IsSuccess) { $script:failed = $true; $script:form.Close(); return }
      $script:ready = $true
      $core = $s.CoreWebView2
      $core.Settings.AreDevToolsEnabled = $false
      $core.add_NewWindowRequested({ param($a, $b) $b.Handled = $true; if ($b.Uri -match '^https?://') { Start-Process $b.Uri } })
      $core.add_NavigationStarting({
        param($a, $b)
        $u = [uri]$b.Uri
        $mine = ($u.Host -eq 'localhost' -or $u.Host -eq '127.0.0.1') -and $u.Port -eq $script:hubPort -and ($u.AbsolutePath.StartsWith('/launcher') -or $u.AbsolutePath.StartsWith('/assets'))
        if (-not $mine) { $b.Cancel = $true; if ($b.Uri -match '^https?://') { Start-Process $b.Uri } }
      })
    })
    $script:form.Controls.Add($wv)
    $wv.Source = [uri]"http://localhost:$port/launcher"
    # If the web view has not come up in 25 seconds, give up on it (missing WebView2 runtime, blocked profile folder...).
    $script:timer = New-Object System.Windows.Forms.Timer
    $script:timer.Interval = 25000
    $script:timer.add_Tick({ $script:timer.Stop(); if (-not $script:ready) { $script:failed = $true; $script:form.Close() } })
    $script:timer.Start()
    [void]$script:form.ShowDialog()
    $script:timer.Dispose()
    return ($script:ready -and -not $script:failed)
  } catch { return $false }
}

# Closing the window stops the hub, so it is never left running in the background. (If this script is killed instead, the
# window's connection drops and the hub stops itself a few seconds later.)
function Stop-Hub([int]$port) {
  try {
    Invoke-WebRequest -Uri "http://localhost:$port/launcher/stop" -Method Post -UseBasicParsing -TimeoutSec 3 -Body '{}' -ContentType 'application/json' `
      -Headers @{ 'X-Launcher' = '1'; 'Origin' = "http://localhost:$port" } | Out-Null
  } catch { }
}

$native = Test-Path (Join-Path $webview 'Microsoft.Web.WebView2.WinForms.dll')
$r = Start-Hub $native
if ($r.code -ne 0) { Say $r.text; exit 1 }
if ($native -and $r.port -and (Show-Window $r.port)) { Stop-Hub $r.port; exit 0 }
if ($native) { [void](Start-Hub $false) }     # the window could not be shown: open the browser app window instead
