# 部署脚本

这些是「让它长期自己跑」的配套脚本。插件本身（`src/`）不需要它们也能用 ——
它们是给「想让它像个小站长一样一直在线」的人准备的。

所有脚本都不带任何人的本机路径：找不到的东西会先自己找一遍，找不到才报错，
需要特殊处理就复制 `qqbot.config.example.ps1` 成 `qqbot.config.ps1` 改几行。

| 脚本 | 干什么 |
|---|---|
| `start-bot.cmd` / `start-bot.ps1` | 拉起 NapCat + `--profile qqbot` 宿主。**会先杀掉旧的 qqbot 宿主**，避免两个宿主抢同一条连接（同一句话回两遍）。 |
| `stop-bot.cmd` / `stop-bot.ps1` | 只停 qqbot 宿主 + NapCat + NapCat 自己那个 QQ。**按可执行文件路径过滤，不碰你桌面上的 QQ**。 |
| `start-watchdog.cmd` / `watchdog.ps1` | 每 30 秒巡检一次：端口在听吗、宿主在吗、**端口上有没有 Established 连接**（这条最容易漏 —— 进程活着但连接断了，就是"假活"）。掉了就拉起来。顺带每 15 分钟备份一次会话数据，留最近 24 份。 |
| `stop-watchdog.cmd` | 停看门狗。 |
| `diary.ps1` + `diary-prompt.md` | 把当天的 `聊天记录\<日期>.md` 交给 `--profile headless` 的一次性会话，整理成每个会话自己的日记。建议挂 Windows 计划任务，每晚跑一次。 |
| `start-qqbot-host.cmd` | 早期只起宿主、不管 NapCat 的版本，保留兼容。新用请用 `start-bot.cmd`。 |

## 装一遍要几步

1. **开机自启**：给 `start-bot.cmd` 建个快捷方式，丢进
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`。
   顺带把 `start-watchdog.cmd` 也丢进去（或者只丢看门狗 —— 它自己会发现机器人在不在，不在就拉）。

2. **每晚写日记**（管理员 PowerShell，路径换成你自己的）：
   ```
   schtasks /create /tn "dsh-qq diary" /sc daily /st 23:30 /tr "powershell -NoProfile -ExecutionPolicy Bypass -File <这个目录>\diary.ps1" /f
   ```
   想确认：`schtasks /query /tn "dsh-qq diary" /v /fo LIST`。

## 踩过的坑（写下来省得再踩）

- **两个宿主 = 每句话回两遍**。日志里每条 `[info]` 出现两次，就是有两个宿主都连着 NapCat。
  起宿主前先按命令行匹配 `--profile qqbot` 把旧的杀掉 —— `start-bot.ps1` 已经这么做了。
- **`Get-Process -Name QQ | Stop-Process` 一把全杀会连你桌面上的 QQ 一起杀掉**。
  一定按路径过滤：NapCat 用的那个 QQ 在 NapCat 目录下面，你的在自己的安装目录。
- **`.ps1` 存 UTF-8 带 BOM**，否则 Windows PowerShell 5.1 读中文会乱码；
  `.cmd` 里如果非要写中文，存 GBK（936）并在开头 `chcp 936`。这些脚本的 `.cmd` 干脆全是英文。
- **headless 会话的沙箱工作区跟着进程 cwd 走**。`diary.ps1` 里必须 `Set-Location` 到数据根，
  不然它连 `QQ会话\` 都写不进去，报 `[sandbox: file access denied under workspace-write mode]`，
  而且 headless 没有批准通道（fail closed），只会静悄悄地卡住。
- **PowerShell 里建 GBK 编码用 `[Text.Encoding]::GetEncoding(936)`**，`New-Object Text.Encoding 936`
  会报「找不到构造函数」。
