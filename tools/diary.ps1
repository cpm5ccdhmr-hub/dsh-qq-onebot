# 把当天的 QQ 聊天记录交给 headless 会话，写成日记。
#
# 配合 diary-prompt.md 一起用；建议挂成 Windows 计划任务，每晚跑一次。
# 注册方法（管理员 PowerShell，改时间就改 /st）：
#   schtasks /create /tn "dsh-qq diary" /sc daily /st 23:30 ^
#     /tr "powershell -NoProfile -ExecutionPolicy Bypass -File <这个文件的完整路径>" /f
#
# 两个必须知道的坑（2026-10-24 踩过）：
#   1) headless 会话的沙箱工作区跟着**进程 cwd** 走。不先 Set-Location 到数据根，
#      它连 QQ会话 都写不进去，会报 [sandbox: file access denied under workspace-write mode]，
#      而 headless 没有批准通道（fail closed），只会卡住。
#   2) dsh 会把模型的 reasoning 打到 stdout（`dsh: reasoning:` 行）。整段进日志会让
#      日志每次涨几十 KB，所以这里只留最后的汇报和报错。
$ErrorActionPreference = 'Continue'

$cfg = @{
  DataRoot    = ''                      # 留空 = 本脚本往上两级
  DshCmd      = ''                      # 留空自动找
  PromptFile  = 'diary-prompt.md'
  Profile     = 'headless'
  LogFile     = ''                      # 留空 = <DataRoot>\QQ会话\diary-task.log
  LogMaxKB    = 200
}
$cfgFile = Join-Path $PSScriptRoot 'qqbot.config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }

$root = $cfg.DataRoot
if (-not $root) {
  # 往上找带 QQ会话 的那一级。不能写死「往上两级」—— 这个仓库可能埋在 插件\ 之类的
  # 子目录里，写死会把数据根算成 ...\插件，headless 的沙箱就只覆盖到那儿，日记写不进去。
  $probe = $PSScriptRoot
  for ($i = 0; $i -lt 6; $i++) {
    $probe = Split-Path -Parent $probe
    if (-not $probe) { break }
    if (Test-Path (Join-Path $probe 'QQ会话')) { $root = $probe; break }
  }
}
if (-not $root) { $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if (-not $root -or -not (Test-Path $root)) { $root = $PSScriptRoot }

$logFile = $cfg.LogFile
if (-not $logFile) {
  $logDir = Join-Path $root 'QQ会话'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $logFile = Join-Path $logDir 'diary-task.log'
}

$promptFile = $cfg.PromptFile
if (-not [IO.Path]::IsPathRooted($promptFile)) { $promptFile = Join-Path $PSScriptRoot $promptFile }
$today = Get-Date -Format 'yyyy-MM-dd'

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

# 日志超了只留最后 30 行，每行截到 400 字（reasoning 那几行本来就长）
function Trim-Log {
  if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt ($cfg.LogMaxKB * 1KB)) {
    $tail = Get-Content $logFile -Tail 30 -Encoding UTF8 | ForEach-Object {
      if ($_.Length -gt 400) { $_.Substring(0, 400) + ' …' } else { $_ }
    }
    [IO.File]::WriteAllLines($logFile, $tail, (New-Object Text.UTF8Encoding $false))
  }
}

function Find-DshCmd {
  if ($cfg.DshCmd -and (Test-Path $cfg.DshCmd)) { return $cfg.DshCmd }
  if ($env:QQBOT_DSH -and (Test-Path $env:QQBOT_DSH)) { return $env:QQBOT_DSH }
  $tries = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  )
  foreach ($t in $tries) { if ($t -and (Test-Path $t)) { return $t } }
  $cmd = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command dsh -ErrorAction SilentlyContinue }
  if ($cmd) { return $cmd.Source }
  return $null
}

Write-Log "写日记任务开始（$today）"
if (-not (Test-Path $promptFile)) { Write-Log "找不到提示词文件：$promptFile，退出"; exit 1 }
$bin = Find-DshCmd
if (-not $bin) { Write-Log '找不到 dsh.cmd，退出（在 qqbot.config.ps1 里设 $cfg.DshCmd）'; exit 1 }

# 关键：切到数据根，让 headless 的沙箱工作区覆盖到 QQ会话
Set-Location $root

$prompt = "请读取并严格执行这个文件里的任务说明：$promptFile。今天是 $today。"

try {
  $raw = & $bin --profile $cfg.Profile $prompt 2>&1 | Out-String
  $keep = $raw -split "`r?`n" | Where-Object {
    $_ -notmatch '^dsh: reasoning:' -and
    $_ -notmatch '^\s*\+' -and
    $_ -notmatch 'CategoryInfo|FullyQualifiedErrorId|^\s*At .*\.ps1:' -and
    $_ -notmatch '^\[llm-'
  }
  $clean = ($keep -join "`n").Trim()
  if (-not $clean) { $clean = '(没有可读的汇报)' }
  Write-Log ("汇报：" + ($clean -replace "`r?`n", " / "))
} catch {
  Write-Log ("失败：" + $_.Exception.Message)
}

Trim-Log
Write-Log "写日记任务结束"
