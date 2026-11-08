@echo off
rem Puts a MAVLink Hub shortcut, with its icon, on your Desktop.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'MAVLink Hub.lnk')); $s.TargetPath='%~dp0MAVLink Hub.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0assets\hub.ico'; $s.WindowStyle=7; $s.Description='Start the MAVLink Hub'; $s.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo A MAVLink Hub shortcut is now on your Desktop.
)
pause
