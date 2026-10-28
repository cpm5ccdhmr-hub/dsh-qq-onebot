@echo off
REM Start the QQ bot: NapCat + a dsh-qq host process (profile "qqbot").
REM Double-click this file. A black window for NapCat will appear - keep it open.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bot.ps1"
