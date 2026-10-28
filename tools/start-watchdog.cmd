@echo off
REM Start the watchdog in the background (minimized window).
REM It checks every 30s and restarts the bot if anything is missing,
REM and backs up session data every 15 minutes.
cd /d "%~dp0"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "%~dp0watchdog.ps1"
