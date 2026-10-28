# 让它自己长期跑

关掉窗口它就没了，掉线了也没人知道——这是接进 QQ 之后最先遇到的两个问题。`tools/` 里的脚本就是为这两件事准备的。

| 脚本 | 干什么 |
| --- | --- |
| `start-bot.cmd` | 起 NapCat + qqbot 宿主。**会先掐掉旧的 qqbot 宿主**，避免两个宿主抢同一条连接（同一句话回两遍）。 |
| `stop-bot.cmd` | 只停 NapCat 那边的进程，**不碰你桌面上的 QQ**（按可执行文件路径过滤）。 |
| `start-watchdog.cmd` | 看门狗：每 30 秒确认端口在听、宿主在、**端口上还有 Established 连接**，缺一样就拉起来；顺带每 15 分钟备份一次会话数据，留最近 24 份。 |
| `diary.ps1` + `diary-prompt.md` | 把当天的 `聊天记录\<日期>.md` 交给 `--profile headless` 的一次性会话，整理成日记。挂个计划任务每晚跑一次就行。 |

脚本里**没有写死任何人的路径**：找不到就自己去找；需要特事特办，就复制 `tools/qqbot.config.example.ps1` 成 `tools/qqbot.config.ps1` 改几行。

## 宿主日志在哪

`start-bot.ps1` 会把宿主的 stdout / stderr 重定向到 `logs\qqbot-<启动时间>.log` 和 `.err.log`，每次启动一个文件，只留最近 10 个（`logs/` 不进仓库）。

想看「它到底为什么没反应」，先翻这个：

```powershell
Get-Content (Get-ChildItem logs\qqbot-*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1) -Tail 80
```

插件里 `logger.info` 打的东西都在这（连上 NapCat、主动说话已启动、工具调用失败的原因…）。`debug: true` 时细节会更多。

## 为什么看门狗要检查「Established 连接」

进程活着、日志也不报错、但 WebSocket 早就断了——这是最难发现的一种**假活**：群里 @ 它一点反应都没有，翻日志却一片安静。

所以看门狗查的不是「进程在不在」，而是三件事一起查：端口在听、宿主进程在、端口上还有一条 Established 连接。缺一样就重启。

## 定时写日记

`diary.ps1` 的套路是：只读 `<会话目录>/聊天记录/<今天>.md`，写 `<会话目录>/记忆区/日记/<日期>.md`（**一天一篇**；一天里跑多次就往末尾追加小节，已经写过的时段不重写），**绝不碰宿主自己的 `本地记忆区`**——QQ 会话的记忆和主人的私人记忆是两回事。

挂计划任务（管理员 PowerShell）：

```powershell
schtasks /create /tn "QQ日记" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File D:\path\to\dsh-qq\tools\diary.ps1" /sc daily /st 23:30
```

## 踩过的雷

- **PowerShell 写文件会顺手塞一个 BOM**：一个看不见的字节能让配置文件里所有判断都歪掉。写 JSON / YAML 时显式用 `UTF8Encoding($false)`。
- **PowerShell 5.1 读输出默认按 GBK 解码**：跑外部命令收中文输出要 `[Text.Encoding]::GetEncoding(936)` 显式解。
- **headless 的沙箱工作区跟着进程 cwd 走**：脚本开头不 `Set-Location` 到工作区，就会出现 `[sandbox: file access denied]`，而且 headless 没有批准通道，直接 fail closed。
- **`.NET` 的 `[IO.File]::WriteAllText` 用进程 cwd**，不跟 PowerShell 的 `Set-Location`——路径要自己拼绝对路径。

更多细节和排障记录见 [`tools/README.md`](../tools/README.md)。
