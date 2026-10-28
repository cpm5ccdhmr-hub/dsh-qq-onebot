# 启动 QQ 机器人：NapCat + dsh-qq 宿主
#
# 特点：两个都脱离 DSH 独立跑；宿主启动前先清掉旧的，避免「两个宿主抢一条连接、
#       同一句话回两遍」。
#
# 用法：双击 start-bot.cmd，或者 powershell -File start-bot.ps1
#
# 需要改路径的话：把 qqbot.config.example.ps1 复制成同目录的 qqbot.config.ps1，
# 改里面的 $cfg 就行，不用动这个文件。
$ErrorActionPreference = 'SilentlyContinue'

$cfg = @{
  NapCatDir   = ''    # 含 napcat.bat 的目录；留空自动找
  DshCmd      = ''    # dsh.cmd 完整路径；留空自动找
  Port        = 3001  # NapCat 的 OneBot 正向 WS 端口
  WakeSeconds = 90    # 等 3001 最多多少秒
}
$cfgFile = Join-Path $PSScriptRoot 'qqbot.config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }

# ---------- 自动找 dsh.cmd ----------
function Find-DshCmd {
  if ($cfg.DshCmd -and (Test-Path $cfg.DshCmd)) { return $cfg.DshCmd }
  if ($env:QQBOT_DSH -and (Test-Path $env:QQBOT_DSH)) { return $env:QQBOT_DSH }
  $tries = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  )
  foreach ($t in $tries) { if ($t -and (Test-Path $t)) { return $t } }
  $cmd = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command dsh -ErrorAction SilentlyContinue }
  if ($cmd) { return $cmd.Source }
  return $null
}

# ---------- 自动找 NapCat ----------
function Find-NapCatDir {
  if ($cfg.NapCatDir -and (Test-Path (Join-Path $cfg.NapCatDir 'napcat.bat'))) { return $cfg.NapCatDir }
  if ($env:QQBOT_NAPCAT -and (Test-Path (Join-Path $env:QQBOT_NAPCAT 'napcat.bat'))) { return $env:QQBOT_NAPCAT }
  $roots = @(
    'D:\NapCat.Shell.Windows.OneKey',
    'C:\NapCat.Shell.Windows.OneKey',
    (Join-Path $env:LOCALAPPDATA 'NapCat.Shell.Windows.OneKey'),
    (Join-Path $env:USERPROFILE 'NapCat.Shell.Windows.OneKey')
  )
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    if (Test-Path (Join-Path $r 'napcat.bat')) { return $r }
    # OneKey 下面按版本号分层（NapCat.<版本号>.Shell 之类），往里找一层的 napcat.bat
    $bat = Get-ChildItem -Path $r -Filter 'napcat.bat' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if ($bat) { return $bat.DirectoryName }
  }
  return $null
}

Write-Host ''
Write-Host '===== QQ 机器人启动器 =====' -ForegroundColor Cyan
Write-Host ''

$dsh = Find-DshCmd
if (-not $dsh) {
  Write-Host '找不到 dsh.cmd。' -ForegroundColor Red
  Write-Host '  修法：把 qqbot.config.example.ps1 复制成 qqbot.config.ps1，' -ForegroundColor Yellow
  Write-Host '        把 $cfg.DshCmd 改成你的 dsh.cmd 完整路径。' -ForegroundColor Yellow
  Write-Host ''
  if ($env:QQ_BOT_NO_PAUSE -ne '1') { Read-Host '按回车关闭' }
  exit 1
}
Write-Host ("dsh.cmd： " + $dsh) -ForegroundColor DarkGray

$napcat = Find-NapCatDir
if ($napcat) { Write-Host ("NapCat： " + $napcat) -ForegroundColor DarkGray }
else { Write-Host 'NapCat： 没自动找到（如果你那边已经在跑，可以不管）' -ForegroundColor DarkGray }

Write-Host ''
Write-Host '[1/3] 关掉旧的 qqbot 宿主（只认 --profile qqbot，不动你正在用的 DSH）...' -ForegroundColor Yellow
$old = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
       Where-Object { $_.CommandLine -match '--profile\s+qqbot' }
if ($old) {
  $old | ForEach-Object { Write-Host ("      停 " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }
} else {
  Write-Host '      没有旧宿主'
}

$listening = Get-NetTCPConnection -LocalPort $cfg.Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host ('[2/3] NapCat 已经在线（' + $cfg.Port + ' 在监听），跳过启动') -ForegroundColor Green
} else {
  if (-not $napcat) {
    Write-Host '[2/3] 找不到 NapCat，也没人监听端口 —— 先手动启动 NapCat 再来' -ForegroundColor Red
    if ($env:QQ_BOT_NO_PAUSE -ne '1') { Read-Host '按回车关闭' }
    exit 1
  }
  Write-Host '[2/3] 启动 NapCat（会开一个新的黑窗口，别关它）...' -ForegroundColor Yellow
  # 只清 NapCat 自己的 QQ，别碰你桌面上那个
  Get-Process -Name QQ,QQEX -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($napcat, 'OrdinalIgnoreCase') } |
    ForEach-Object { Write-Host ("      清残留 " + $_.Id); $_.Kill() }
  Get-Process -Name NapCatWinBootMain -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill() }
  Start-Sleep -Seconds 2
  Start-Process -FilePath (Join-Path $napcat 'napcat.bat') -WorkingDirectory $napcat

  Write-Host ('      等 ' + $cfg.Port + ' 端口（最多 ' + $cfg.WakeSeconds + ' 秒；第一次或换机器可能要扫码）...') -ForegroundColor Yellow
  $ok = $false
  $loops = [Math]::Ceiling($cfg.WakeSeconds / 2)
  for ($i = 0; $i -lt $loops; $i++) {
    if (Get-NetTCPConnection -LocalPort $cfg.Port -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }
    Start-Sleep -Seconds 2
  }
  if ($ok) { Write-Host '      OK：NapCat 已就绪（自动快速登录，不用扫码）' -ForegroundColor Green }
  else { Write-Host '      注意：没等到端口。宿主照样起、会自己重连；如果黑窗口里在要二维码，扫一下就好' -ForegroundColor Yellow }
}

Write-Host '[3/3] 启动 dsh-qq 宿主...' -ForegroundColor Yellow
# 注意：宿主是 Electron 的 GUI 子进程，stdout 重定向过去拿到的也是 0 字节空文件，
# 所以这里不做重定向。插件日志由插件自己写：<workspaceRoot>\logs\dsh-qq-<日期>.log
Start-Process -FilePath $dsh -ArgumentList '--profile','qqbot' -WorkingDirectory (Split-Path $dsh) -WindowStyle Hidden

Start-Sleep -Seconds 8
$conn = Get-NetTCPConnection -LocalPort $cfg.Port -State Established -ErrorAction SilentlyContinue
if ($conn) { Write-Host '      完成：宿主已经连上 NapCat' -ForegroundColor Green }
else { Write-Host '      宿主已起，还在重试（一般 10-60 秒内连上）' -ForegroundColor Yellow }

Write-Host ''
Write-Host '搞定了。' -ForegroundColor Cyan
Write-Host '  · NapCat 那个黑窗口别关（关了机器人就下线）'
Write-Host '  · 这个窗口可以关'
Write-Host ''
if ($env:QQ_BOT_NO_PAUSE -ne '1') { Read-Host '按回车关闭' }
