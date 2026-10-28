# dsh-qq 部署脚本的配置文件（示例）
#
# 用法：把这个文件复制一份，改名成 qqbot.config.ps1，放在同一个目录里，
#       然后改下面你要改的项。脚本会自动读它，没写到的项用脚本里的默认值。
#
# 为什么要这样：脚本本身不带任何人的本机路径，谁都能直接用；
#              需要特事特办的地方，全放进这个文件里。

# ── NapCat ───────────────────────────────────────────────────────────────
# 含 napcat.bat 的那个目录。留空 = 自动在常见位置找（包括 OneKey 下面按版本号分层的情况）。
# 例：$cfg.NapCatDir = 'D:\NapCat.Shell.Windows.OneKey\NapCat.<版本号>.Shell'
$cfg.NapCatDir = ''

# ── dsh ──────────────────────────────────────────────────────────────────
# dsh.cmd 的完整路径。留空 = 自动找（先找 DeepSeek Harness 的安装目录，再看 PATH）。
$cfg.DshCmd = ''

# OneBot 正向 WebSocket 端口，要跟 NapCat 里的配置一致
$cfg.Port = 3001

# ── 数据根 ───────────────────────────────────────────────────────────────
# dsh-qq 的 workspaceRoot（会话、聊天记录、备份都在这下面）。
# 留空 = 按脚本位置推算（tools\ 往上两级）。
# 例：$cfg.DataRoot = 'D:\qqbot-data'
$cfg.DataRoot = ''

# ── 看门狗 ───────────────────────────────────────────────────────────────
# $cfg.PollSeconds   = 30    # 多久巡检一次（秒）
# $cfg.BackupMinutes = 15    # 多久备份一次（分钟）
# $cfg.BackupKeep    = 24    # 备份保留几份
# $cfg.BackupDirs    = @('本地记忆区', 'QQ会话', '协作')   # 备份哪些子目录

# ── 写日记 ───────────────────────────────────────────────────────────────
# $cfg.Profile    = 'headless'      # 用哪个 profile 跑一次性会话
# $cfg.PromptFile = 'diary-prompt.md'
