# dsh-qq 看门狗：每 N 秒看一眼机器人还在不在，掉了就拉起来；每隔一段时间备份会话数据。
#
# 为什么要它：桥接进程活着、但 WebSocket 早断了，这种「假活」是最坑的 ——
# 你看进程在、日志也不报错，可群里 @ 它一点反应没有。所以巡检要三样一起看：
#   1) NapCat 的 OneBot 端口有没有在监听
#   2) 有没有 --profile qqbot 的宿主进程
#   3) 端口上有没有一条 Established 连接（这一条最容易被忽略）
#
# 用法：start-watchdog.cmd（后台跑），stop-watchdog.cmd 停。
# 想开机自启：给 start-watchdog.cmd 建个快捷方式丢进「启动」文件夹。
$ErrorActionPreference = 'SilentlyContinue'

$cfg = @{
  Port            = 3001
  PollSeconds     = 30     # 多久巡检一次
  BackupMinutes   = 15     # 多久备份一次
  BackupKeep      = 24     # 备份保留几份
  DataRoot        = ''     # 数据根目录；留空 = 本脚本往上两级
  BackupDirs      = @('本地记忆区', 'QQ会话', '协作')  # 备份哪些子目录（没有的自动跳过）
  StartScript     = 'start-bot.ps1'
  LogFile         = ''     # 留空 = <DataRoot>\QQ会话\watchdog.log
  NapCatDir       = ''
  DshCmd          = ''
}
$cfgFile = Join-Path $PSScriptRoot 'qqbot.config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }

# 数据根：默认认为 tools\ 在数据目录下面两层（<数据根>\tools\）
$root = $cfg.DataRoot
if (-not $root) { $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if (-not $root -or -not (Test-Path $root)) { $root = $PSScriptRoot }

$logFile = $cfg.LogFile
if (-not $logFile) {
  $logDir = Join-Path $root 'QQ会话'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $logFile = Join-Path $logDir 'watchdog.log'
}
$backupRoot = Join-Path $root '备份\会话备份'
$startScript = Join-Path $PSScriptRoot $cfg.StartScript

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  # 日志别无限涨：超过 1MB 只留最后 200 行
  if ((Get-Item $logFile).Length -gt 1MB) {
    $tail = Get-Content $logFile -Tail 200 -Encoding UTF8
    [IO.File]::WriteAllLines($logFile, $tail, (New-Object Text.UTF8Encoding $false))
  }
}

function Test-BotAlive {
  $listen = Get-NetTCPConnection -LocalPort $cfg.Port -State Listen -ErrorAction SilentlyContinue
  if (-not $listen) { Write-Log ('巡检：' + $cfg.Port + ' 没在监听'); return $false }
  $hosts = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
           Where-Object { $_.CommandLine -match '--profile\s+qqbot' }
  if (-not $hosts) { Write-Log '巡检：没有 --profile qqbot 的宿主进程'; return $false }
  $conn = Get-NetTCPConnection -LocalPort $cfg.Port -State Established -ErrorAction SilentlyContinue
  if (-not $conn) { Write-Log '巡检：宿主在，但没有 Established 连接（假活）'; return $false }
  return $true
}

function Invoke-Backup {
  if (-not $cfg.BackupDirs -or $cfg.BackupDirs.Count -eq 0) { return }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  $dest = Join-Path $backupRoot $stamp
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  $copied = 0
  foreach ($sub in $cfg.BackupDirs) {
    $src = Join-Path $root $sub
    if (Test-Path $src) {
      Copy-Item $src (Join-Path $dest $sub) -Recurse -Force
      $copied++
    }
  }
  if ($copied -eq 0) {
    Remove-Item $dest -Recurse -Force
    return
  }
  $all = @(Get-ChildItem $backupRoot -Directory | Sort-Object Name)
  if ($all.Count -gt $cfg.BackupKeep) {
    $all[0..($all.Count - $cfg.BackupKeep - 1)] | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
  }
  Write-Log ("备份完成 {0}（{1} 个目录，保留最近 {2} 份）" -f $stamp, $copied, $cfg.BackupKeep)
}

if (-not (Test-Path $startScript)) {
  Write-Log ("找不到启动脚本：" + $startScript)
  Write-Host ('找不到启动脚本：' + $startScript) -ForegroundColor Red
  exit 1
}

Write-Log ("看门狗启动 PID=$PID  数据根=$root  端口=$($cfg.Port)  巡检=$($cfg.PollSeconds)s  备份=$($cfg.BackupMinutes)min")
Write-Host ('看门狗已启动（PID ' + $PID + '，日志 ' + $logFile + '）') -ForegroundColor Green

$lastBackup = Get-Date
while ($true) {
  if (-not (Test-BotAlive)) {
    Write-Log '   → 尝试拉起'
    $env:QQ_BOT_NO_PAUSE = '1'
    & $startScript 2>&1 | Out-Null
    Start-Sleep -Seconds 20
  }
  if (((Get-Date) - $lastBackup).TotalMinutes -ge $cfg.BackupMinutes) {
    Invoke-Backup
    $lastBackup = Get-Date
  }
  Start-Sleep -Seconds $cfg.PollSeconds
}
