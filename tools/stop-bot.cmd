@echo off
REM Stop the QQ bot: qqbot host + NapCat + the QQ instance NapCat owns.
REM Your own desktop QQ is NOT touched (filtered by executable path).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-bot.ps1"
