@echo off
rem MAVLink Hub: double-click to start the hub and open its control window.
rem Settings go in hub.env next to server.js (see hub.env.example).
cd /d "%~dp0"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher.ps1"
