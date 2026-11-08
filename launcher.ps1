# MAVLink Hub launcher for Windows. Started by "MAVLink Hub.bat". Shows a small window with the
# hub's status, the addresses phones can use, map-download progress, and buttons to open the
# dashboard, open the saved-maps folder, and stop. Needs only Windows PowerShell 5.1, which is
# built into Windows 10 and 11. Output from the hub goes to %APPDATA%\MAVLink Hub\hub.log.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

function Fail($msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, 'MAVLink Hub', 'OK', 'Error') | Out-Null
  exit 1
}

# Find Node.js: on PATH first, then the usual install folders.
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node) {
  foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $c) { $node = $c; break }
  }
}
if (-not $node) { Fail "Node.js is not installed.`n`nDownload the LTS version from https://nodejs.org, install it, then run MAVLink Hub again." }
if (-not (Test-Path (Join-Path $repo 'server.js'))) { Fail "server.js was not found next to this launcher.`n`nKeep MAVLink Hub.bat and launcher.ps1 in the same folder as server.js." }

# The dashboard port: environment variable, then hub.env, then the default (same order as the hub).
$port = 8080
if ($env:WEB_PORT) { $port = [int]$env:WEB_PORT }
elseif (Test-Path 'hub.env') {
  $m = Select-String -Path 'hub.env' -Pattern '^\s*WEB_PORT\s*=\s*(\d+)' | Select-Object -Last 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}

$logDir = Join-Path $env:APPDATA 'MAVLink Hub'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'hub.log'
$errLog = Join-Path $logDir 'hub-error.log'
$proc = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $repo -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $errLog

# ---- The window ----
$form = New-Object System.Windows.Forms.Form
$form.Text = 'MAVLink Hub'
$form.ClientSize = New-Object System.Drawing.Size(470, 350)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(16, 14)
$status.Size = New-Object System.Drawing.Size(440, 28)
$status.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$status.Text = 'Starting the hub...'
$form.Controls.Add($status)

$info = New-Object System.Windows.Forms.TextBox
$info.Location = New-Object System.Drawing.Point(16, 50)
$info.Size = New-Object System.Drawing.Size(440, 160)
$info.Multiline = $true
$info.ReadOnly = $true
$info.ScrollBars = 'Vertical'
$info.BackColor = [System.Drawing.Color]::White
$info.Text = "Waiting for the hub to answer..."
$form.Controls.Add($info)

$dl = New-Object System.Windows.Forms.Label
$dl.Location = New-Object System.Drawing.Point(16, 218)
$dl.Size = New-Object System.Drawing.Size(440, 24)
$form.Controls.Add($dl)

function Btn($text, $x, $w) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, 254)
  $b.Size = New-Object System.Drawing.Size($w, 34)
  $form.Controls.Add($b)
  return $b
}
$bOpen = Btn 'Open dashboard' 16 140
$bMaps = Btn 'Saved maps folder' 166 150
$bStop = Btn 'Stop hub' 326 130

$note = New-Object System.Windows.Forms.Label
$note.Location = New-Object System.Drawing.Point(16, 300)
$note.Size = New-Object System.Drawing.Size(440, 40)
$note.ForeColor = [System.Drawing.Color]::Gray
$note.Text = 'Leave this window open while flying. Closing it stops the hub.'
$form.Controls.Add($note)

$script:ready = $false
$script:dataDir = $null

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({
  if ($proc.HasExited) {
    $timer.Stop()
    $status.Text = 'The hub stopped.'
    $status.ForeColor = [System.Drawing.Color]::Firebrick
    $tail = @(Get-Content $errLog -ErrorAction SilentlyContinue | Select-Object -Last 6)
    if ($tail.Count -eq 0) { $tail = @(Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 6) }
    $info.Text = ("It exited with code $($proc.ExitCode). Is another copy already running?`r`n`r`n" + ($tail -join "`r`n"))
    $dl.Text = ''
    $bStop.Text = 'Close'
    return
  }
  try {
    if (-not $script:ready) {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/info" -TimeoutSec 2
      $m = Select-String -Path $log -Pattern '^Saved maps and settings: (.*)$' -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($m) { $script:dataDir = $m.Matches[0].Groups[1].Value.Trim() }
      $lines = @("On this computer:   http://localhost:$port", '', 'On the same Wi-Fi (phones, other laptops):')
      foreach ($u in @($r.urls)) { $lines += "   $u" }
      if (@($r.urls).Count -eq 0) { $lines += '   (no network address found - is Wi-Fi on?)' }
      $lines += ''
      $lines += "Saved maps: $($script:dataDir)"
      $info.Text = ($lines -join "`r`n")
      $status.Text = 'The hub is running.'
      $status.ForeColor = [System.Drawing.Color]::ForestGreen
      $script:ready = $true
      Start-Process "http://localhost:$port"
    }
    $st = Invoke-RestMethod -Uri "http://127.0.0.1:$port/precache/status" -TimeoutSec 2
    if ($st.running) { $dl.Text = "Map download: $($st.done) of $($st.total) tiles" }
    elseif ($dl.Text -and $st.total -gt 0) { $dl.Text = "Map download finished: $($st.done) of $($st.total) tiles" }
  } catch { }
})

$bOpen.Add_Click({ Start-Process "http://localhost:$port" })
$bMaps.Add_Click({
  if ($script:dataDir -and (Test-Path $script:dataDir)) { Start-Process explorer.exe $script:dataDir } else { Start-Process explorer.exe $logDir }
})
$bStop.Add_Click({ $form.Close() })
$form.Add_FormClosing({
  $timer.Stop()
  if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }
})

$timer.Start()
[void]$form.ShowDialog()
