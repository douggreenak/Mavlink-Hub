@echo off
rem MAVLink Hub, plain console version: starts the hub and opens the dashboard in this window.
rem Close the window (or press Ctrl+C) to stop it. "MAVLink Hub.bat" is the nicer windowed one.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
set PORT=8080
if defined WEB_PORT set PORT=%WEB_PORT%
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"
node server.js
pause
