@echo off
rem Sends a simulated INAV flight to the hub on this computer. Start the hub first, then open the dashboard.
rem Close this window to stop. Other flights: node sim\inav-sim.js --list
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node sim\inav-sim.js --profile full
pause
