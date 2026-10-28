@echo off
REM Stop the watchdog (it only stops watchdog.ps1, nothing else).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*watchdog.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Watchdog stopped.
timeout /t 2 >nul
