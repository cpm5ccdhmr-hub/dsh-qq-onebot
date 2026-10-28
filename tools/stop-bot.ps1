# 停止 QQ 机器人：只停 qqbot 宿主 + NapCat + NapCat 专用的那个 QQ。
#
# 绝不碰你桌面上自己登的 QQ —— 这是 2026-10-24 踩过的坑：
# `Get-Process -Name QQ | Stop-Process` 一把全杀，会把自己的 QQ 也杀掉。
# 所以这里按「可执行文件所在目录」过滤。
#
# 用法：双击 stop-bot.cmd，或者 powershell -File stop-bot.ps1
$ErrorActionPreference = 'SilentlyContinue'

$cfg = @{
  NapCatDir = ''    # 含 napcat.bat 的目录；留空自动找
  Port      = 3001
}
$cfgFile = Join-Path $PSScriptRoot 'qqbot.config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }

function Find-NapCatRoot {
  if ($cfg.NapCatDir) { return $cfg.NapCatDir }
  if ($env:QQBOT_NAPCAT) { return $env:QQBOT_NAPCAT }
  $roots = @(
    'D:\NapCat.Shell.Windows.OneKey',
    'C:\NapCat.Shell.Windows.OneKey',
    (Join-Path $env:LOCALAPPDATA 'NapCat.Shell.Windows.OneKey'),
    (Join-Path $env:USERPROFILE 'NapCat.Shell.Windows.OneKey')
  )
  foreach ($r in $roots) { if (Test-Path $r) { return $r } }
  return $null
}

$napcatRoot = Find-NapCatRoot

Write-Host ''
Write-Host '===== 停止 QQ 机器人 =====' -ForegroundColor Cyan
Write-Host '（只停 NapCat 那边，不碰你自己登的 QQ）' -ForegroundColor DarkGray
if ($napcatRoot) { Write-Host ('NapCat 根目录： ' + $napcatRoot) -ForegroundColor DarkGray }
Write-Host ''

$killed = 0
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'DeepSeek Harness.exe' -and $_.CommandLine -match '--profile\s+qqbot') -or
  ($_.Name -eq 'NapCatWinBootMain') -or
  (($_.Name -eq 'QQ' -or $_.Name -eq 'QQEX') -and
   $napcatRoot -and $_.ExecutablePath -and
   $_.ExecutablePath.StartsWith($napcatRoot, 'OrdinalIgnoreCase'))
} | ForEach-Object {
  Write-Host ("  停 " + $_.Name + " (PID " + $_.ProcessId + ")")
  Stop-Process -Id $_.ProcessId -Force
  $killed++
}

Start-Sleep -Seconds 2
$left = Get-NetTCPConnection -LocalPort $cfg.Port -ErrorAction SilentlyContinue
if ($left) { Write-Host ('  ⚠ ' + $cfg.Port + ' 还在，可能有残留进程') -ForegroundColor Yellow }
else { Write-Host ('  已停 ' + $killed + ' 个进程，' + $cfg.Port + ' 已释放') -ForegroundColor Green }

Write-Host ''
Write-Host '你桌面的 QQ 没动，照常用。' -ForegroundColor Cyan
Write-Host ''
if ($env:QQ_BOT_NO_PAUSE -ne '1') { Read-Host '按回车关闭' }
