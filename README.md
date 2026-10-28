# dsh-qq-onebot

把 **QQ** 接成 DeepSeek Harness 的一个前端：私聊、群聊都能和同一个 Agent 聊；语音听得懂、图片看得见，还能戳一戳、贴表情、点赞。

底层走 [OneBot v11](https://github.com/botuniverse/onebot-11) 协议，默认搭配 [NapCat](https://napneko.github.io/)。不用公网 IP、不用备案、不用企业主体。

> ⚠️ **先说清楚**：NapCat 属于「QQ 协议端」，跑在你自己登录的 QQ 客户端上，**不符合腾讯的用户协议**。用小号、别和常用号同一台设备、别发垃圾消息，账号有被风控或封禁的可能。插件只负责把 OneBot 消息转给 Agent，协议端本身怎么合规、怎么稳，由你自己负责。场景能用 [QQ 官方机器人](https://bot.q.qq.com/) 的，优先用官方的。

> 📢 **这是个公开仓库**：MIT，随便取用、改、再发。作者是个人不是公司，没有客服、没有 SLA，能回 issue 但不保证秒回。
> 提 issue 或贴日志之前，请先把 **token、真实 QQ 号、本机路径** 抹掉——发出去就收不回来了。

> 🔌 **一台 NapCat 的 WS 只该被一个 Agent 连着**：再装一个 `dsh-onebot-hub` 之类的插件会抢同一条消息，两边都只收到一半（日志里每行出现两次就是证据）。细节见 [和别的 OneBot 插件共存](#和别的-onebot-插件共存)。

```
你的 QQ 客户端  ←→  NapCat（协议端，注入 QQ）
                        ↕  OneBot v11 WebSocket
                dsh-qq-onebot 插件（跑在 DSH 宿主进程里）
                        ↕  进程内 ctx.agents
                  你的 Agent（你自己的预设、工具、记忆）
```

## 它能干什么

| 特性 | 说明 |
| --- | --- |
| 一个 QQ 会话 = 一个持久 Agent 会话 | 有历史、有记忆，不会聊两句就忘 |
| 每个会话一个独立工作目录 | 自带 `AGENTS.md` 和 `记忆区/`，彼此看不见，也碰不到宿主自己的私人记忆 |
| 语音转文字 | 本地 vosk 离线识别，不联网、不上传，结果直接进对话 |
| 群里默认 @ 才理 | 被某人 @ 过一次后 60 秒内不用再 @ 也能接（窗口按「群 + 人」算，别人蹭不到） |
| 分得清谁在跟自己说话 | 引用算叫我、`[SILENT]` 可以不接、同类机器人单独开关、跳过的群消息也进上下文 |
| 不会把自己聊丢 | 窗口快满时补回聊天规矩；再撑满就换新会话，旧的最近聊天先落盘再接上 |
| 十个互动工具 | `qq_poke` / `qq_react` / `qq_like` / `qq_send_image` / `qq_send_file` / `qq_face` / `qq_mface` / `qq_reply` / `qq_send` / `qq_recall` |
| 问答能转回 QQ | `ask_user_question` 抛的问题会变成一条 QQ 消息，回个数字就行 |

## 三步跑通

### 1. 装 NapCat，登录小号

下载 **Windows 一键版**（`NapCat.Shell.Windows.OneKey.zip`），解压运行 `NapCatInstaller.exe`——它装一份独立的 QQ，**不会碰你现有的 QQ**。登录小号，打开 WebUI（默认 `http://127.0.0.1:6099`），在「网络配置」里新建 **WebSocket 服务器**：

| 项 | 填什么 |
| --- | --- |
| 地址 | `127.0.0.1` |
| 端口 | `3001`（被占用就换一个，记住它） |
| Token | 自己编一串，比如 `my-token-2026` |
| 消息格式 | `array`（重要，别选 string） |

> ⚠️ **NapCat 的 QQ 和你桌面的 QQ 是两套程序。** 重装 / 重启 NapCat 时别用 `Get-Process -Name QQ | Stop-Process` 一把全杀——那会把自己正在用的 QQ 也踢下线。按进程路径挑，或者在 NapCat 自己的托盘 / WebUI 里退。

### 2. 装插件

**先把 DSH 完全退出**（托盘也要退掉，插件文件被占用会装到一半失败）。

```powershell
# 从 npm 装（推荐）
dsh plugin --profile desktop add dsh-qq-onebot

# 或从 Releases 下载 dsh-qq-onebot-1.0.0.tgz
dsh plugin --profile desktop add "D:\下载\dsh-qq-onebot-1.0.0.tgz"
```

不想用打好的包，也可以直接装源码目录（`git clone`，或下 `Source code (zip)` 解压）：

```powershell
dsh plugin --profile desktop add "D:\dsh-qq-onebot-1.0.0"
```

三个容易踩的坑：

- **必须用 DSH 自带的 `dsh`，不能 `npx @deepseek-ai/dsh`。** `desktop` 这份 profile 由桌面端独占管理，npx 会直接报 `profile "desktop" is managed exclusively by the Electron application`。PATH 里找不到 `dsh` 就用完整路径：
  ```powershell
  & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\dsh-qq-onebot-1.0.0"
  ```
- **`--profile` 不能省**，省了直接报 `error: --profile <name> is required`。
- **写绝对路径**，相对路径是按你敲命令那一刻的当前目录算的。

装完它会自动写进 `$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles`（默认就启用），启动后在 **设置 → 插件** 里能看到。想确认装没装上：

```powershell
dsh plugin --profile desktop why dsh-qq-onebot
```

### 3. 重启 DSH，填连接信息

重新打开 DSH → **设置 → QQ**，把 `wsUrl` 和 `accessToken` 填进去就行（34 项都在那个面板上，改完即时生效）。

> **设置里没看到 QQ 这一项？** 别慌，不用等修——两条路都能救。
>
> **① 直接写设置文件**（不用重启宿主）：`$DSH_HOME/dsh-qq/settings.json`，Windows 一般是 `C:\Users\<用户名>\.dsh\dsh-qq\settings.json`。插件第一次启动时会在那儿放一份带说明的骨架，改成：
>
> ```json
> {
>   "wsUrl": "ws://127.0.0.1:3001",
>   "accessToken": "my-token-2026"
> }
> ```
>
> 保存后约 **800ms 自动生效**。
>
> **② 看日志找原因**：插件启动时会自检浏览器半端，日志里有 `客户端半端自检通过：id=...` 就是好的；如果是 `客户端半端自检失败（client-id-mismatch / no-inject ...）`，那句话本身就说明了设置页为什么没出现。日志在 `<workspaceRoot>/logs/dsh-qq-<日期>.log`（`workspaceRoot` 默认是进程 cwd）。也可以看 `$DSH_HOME/dsh-qq/` 下有没有东西——**一个文件都没有**，通常就是浏览器半端根本没被加载。

想直接写 profile 配置也可以，改 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 里 `dsh-qq` 那一段（整段替换，不是往下叠）：

```yaml
- id: dsh-qq
  name: dsh-qq
  config:
    wsUrl: ws://127.0.0.1:3001
    accessToken: '在这里填你的 access token'
    cwd: D:/my-agent                     # Agent 工作目录，不填用进程 cwd
    workspaceRoot: D:/my-agent/QQ会话    # 每个会话的独立目录（不填用 <cwd>/会话）
    persona: |                           # 它是谁、什么脾气（不填就是个普通助手）
      你叫小满，是个住在电脑里的助手。说话简短、带点懒，被夸的时候会嘴硬。
    provider: deepseek-official          # 想指定模型时才填
    model: deepseek-flash
```

日志里看到 `已连接 ws://127.0.0.1:3001` 就成了，给小号发条私聊试试。

## 最常改的几个配置

| 配置 | 默认 | 什么时候改 |
| --- | --- | --- |
| `persona` | 空 | 想让它有名字、有性格、有称呼 |
| `ownerIds` / `ownerLabel` | `[]` / `主人` | 想在群里认出主人，优先响应 |
| `requireMention` | `true` | 群里不 @ 也想让它接话 |
| `groupMode` / `privateMode` | `open` / `allowlist` | 只想在指定群 / 指定人那里开；私聊默认只认白名单 |
| `groupReplyGapMs` | `20000` | 觉得回得太密（防刷屏、防风控） |
| `rateLimitPerMin` | `12` | 每个会话每分钟最多发几条 |
| `contextGuard` | `true` | 不想要自动换会话就关掉 |
| `chatLog` | `true` | 不想记原始流水就关掉 |

**全部 50+ 项见 [docs/configuration.md](docs/configuration.md)。**

## 意图路由：短闲聊走本地，复杂活走云端

装好 Ollama 后，插件会把「在吗」「好」「晚安」这类**短、没有任务味**的消息交给本机小模型（默认 `qwen2.5:3b-32k`），其余消息照旧走云端大模型。目的只有一个：**省云端 token**。

- **默认开启**：`intentRoutingEnabled: true`。没装 Ollama / 本地模型没就绪时，所有消息自动走云端，不会报错。
- **规则全在配置文件里**：插件根目录的 `intent-rules.json`。任务关键词、闲聊句式、字数上限、保留几轮历史都在这里改，不用碰代码。
- **长会话也能走本地**：本地适配器发请求前只带最近 `intentLocalMaxUserTurns`（默认 4）轮对话、最多 `intentLocalHistoryChars`（默认 14000）字，不会把三万字历史硬塞给 3B 模型。
- **失败自动回退**：本地请求失败一次，自动拉黑 5 分钟，期间全部走云端；下一轮再试本地。
- **群聊默认不切本地**：人多、上下文长，省不了多少还容易答歪；要开就设 `intentLocalInGroups: true`。

| 配置 / 文件 | 默认 | 说明 |
| --- | --- | --- |
| `intentRoutingEnabled` | `true` | 总开关；关掉就是全部走云端 |
| `intentLocalProvider` | `local_ollama` | 本地 provider 名（插件自己注册，不用另装路由） |
| `intentLocalModel` | `qwen2.5:3b-32k` | Ollama 里的模型名；建议用 `num_ctx=32768` 的版本 |
| `intentLocalMaxChars` | `16` | 超过这个字数直接走云端，不浪费本地时间 |
| `intentLocalInGroups` | `false` | 群聊是否也允许本地接短闲聊 |
| `intentLocalBaseURL` | `http://127.0.0.1:11434` | 本机 Ollama 地址 |
| `intentLocalHistoryChars` | `14000` | 本地最多带多少字历史 |
| `intentLocalSystemChars` | `12000` | 本地最多带多长系统提示词 |
| `intentLocalMaxUserTurns` | `4` | 本地最多保留最近几轮用户消息 |
| `intent-rules.json` | 内置 | 任务词 / 闲聊句式 / 默认值的集中配置文件 |

验证是否生效，看日志里有没有这一行：

```text
[intent] 本轮走本地 local_ollama/qwen2.5:3b-32k：在吗
```

任务句（如「帮我看下这个报错」）不应出现这行，直接走云端就是对的。

## 想深入看哪块

| 想看 | 去哪 |
| --- | --- |
| 它是谁、群里怎么认主人、上下文守卫、认时间、引用与沉默判断 | [docs/persona.md](docs/persona.md) |
| 所有配置项的默认值和含义 | [docs/configuration.md](docs/configuration.md) |
| 长期跑、看门狗、定时写日记、开机自启 | [docs/deployment.md](docs/deployment.md) |
| 改代码、跑测试、目录结构 | [docs/development.md](docs/development.md) |
| 测试怎么做、踩坑记录、排障 | [TESTING.md](TESTING.md) · [tools/README.md](tools/README.md) |

## 在 DSH 设置里调它

不想手改 YAML 的话，**设置 → QQ** 那一节就是个面板，34 项都能点着改：

| 分组 | 能改什么 |
| --- | --- |
| 状态 | 连接点、登录账号、家目录、设置文件；「重连」「重新读一遍」两个按钮 |
| 连接 | `wsUrl`、`accessToken`、`selfId` |
| 它人设 | `persona`、`personaFile`、`ownerLabel` |
| 补充提示 | `directPrompt`、`groupPrompt` |
| 记忆区与工作区 | `workspaceRoot`、`isolateByPeer` |
| 群里怎么说话 | `requireMention`、`groupWakeMs`、`groupReplyGapMs`、`groupMinGapMs`、`rateLimitPerMin`、`historyLimit` |
| 谁能跟它说话 | `privateMode`、`privateAllow`、`ownerIds`、`groupMode`、`groupAllow` |
| 同类机器人 | `botChatEnabled`、`peerBots` |
| 其它 | `debug`、`textChunkLimit`、`splitDelayMs` |

改完立刻生效（`wsUrl` / `accessToken` 要点「重连」；`reconnectMs` / `selfId` / `workspaceRoot` / `isolateByPeer` / `asrPython` 要重启宿主）。设置写在 `$DSH_HOME/dsh-qq/settings.json`，只覆盖你显式设过的键，清空就回默认——**不动 profile 的 `cordis.patch.yml`**。

### 谁能跟它说话（⚠️ 默认只认白名单）

私聊默认 `privateMode: allowlist`，而 `privateAllow` 默认是空的——**装好之后，谁私聊它都不理**。这是故意的：能私聊这个号的人，就能指挥跑在你机器上的 agent（读文件、跑命令都算）。

要放人进来：

```yaml
privateMode: 'allowlist'
privateAllow:
  - '你的QQ号'
```

想谁都聊就写 `privateMode: 'open'`（风险自担），彻底关掉私聊写 `disabled`。

> 从 1.2.1 及更早升级上来：以前默认是 `open`。配置里显式写过 `privateMode` 的不受影响；没写过的，升级后私聊会静默不回应——启动日志里那句「私聊白名单（privateAllow）是空的」就是在说这件事。

同一个 QQ 号不能两处同时登录（会互相抢消息），所以桌面 / Web GUI 那份配 `uiOnly: true`：只提供设置页，不连 NapCat；真正干活的是 `--profile qqbot` 那个宿主。

## 和别的 OneBot 插件共存

一台 NapCat 的 WebSocket 一般只该被**一个** Agent 连着。社区的 `dsh-onebot-hub` 之类也连同一台 NapCat 时，两边都会收到同一条消息、各自回一遍——表现是「回复错乱」「一条消息两份回复」，不是任何一边的 bug。

**只留一个：**

```powershell
dsh plugin --profile desktop remove dsh-onebot-hub
# 再确认 profile 的 package.json 里 dsh.profile.bundles 已经没有它
```

搬家到 dsh-qq 时顺手清一下旧家的状态目录（不清也不影响，只是留着占地方）：`$DSH_HOME` 下旧插件自己的目录。dsh-qq 的家是 `$DSH_HOME/dsh-qq/`，卸载插件时这个目录**不会**自动删，设置、日志、覆盖表都在里面，留着下次重装能直接用。

## 常见问题

**设置里没有「QQ」这一项**
浏览器半端没被加载。最常见两个原因：插件版本太老（1.1.1 之前的 `dsh.client.inject` 写了宿主要么没有的包），或者装的是改过包名却没跟着改 `client.js` 里 `id` 的版本。**现在不用等更新**：连上 NapCat 只看设置文件的话，改 `$DSH_HOME/dsh-qq/settings.json` 就够了（见上面第 3 步的兜底），QQ 本身不依赖设置页。插件启动日志里搜 `客户端半端自检`，它会把原因写在里面。

**连不上 / 一直重连**
先看 `wsUrl` 填没填——1.2.1 起留空就完全不连接，日志里会明说「wsUrl 还没填」，不会再对着 3001 空转。填了还连不上，看 NapCat 的 WebUI 里 WS 服务器是不是「启用」、端口对不对、Token 两边是否一模一样。日志里 `与 NapCat 断开` 那一行会带原因，之后的重试不再逐条刷屏，恢复时会补一句「断了多久、重试几次」。

**配置看着没问题，但就是发不出去**
NapCat 的 **WS 和 HTTP 是两个不同的 token**，填错不报错，只是安静地发不出去。另外别让 PowerShell 把配置写出 BOM——一个看不见的字节能让所有判断歪掉。

**收得到消息但 Agent 不回**
群里先确认 @ 了；私聊看 `privateMode` 是不是 `allowlist` 却没把自己加进 `privateAllow`；都没问题就看 DSH 那边是不是还在跑（一轮本身要时间）。

**消息重复发两遍**
一般是两个 qqbot 宿主同时连着 NapCat（日志里每行出现两次）。用 `tools/start-bot.cmd` 起，它会先掐掉旧的宿主。

**语音没转出文字**
先确认 `asrPython -c "import vosk"` 能过，再手动跑一次 `<asrPython> <asrScript> <音频文件> [模型目录]`。模型目录必须是**纯 ASCII 路径**（vosk 的 C++ 层不认中文路径）。

**记忆存在哪 / 会不会和宿主串**
默认 `isolateByPeer: true`：私聊在 `<workspaceRoot>/会话/私聊_<QQ号>/`，群在 `群_<群号>/`，第一次用自动铺好 `AGENTS.md` + `记忆区/`。想共用宿主目录就设 `false`。

**能不能群发 / 主动推消息**
不做群发。**冷场时会主动开口**：会话安静满 `proactiveSilentMs`（默认 20 分钟）之后，它有机会自己说一句，说不说由它判断（不想说就 `[SILENT]`）。有静默时段、每天次数上限、以及「连着几次没人接就闭嘴」三道闸，见 [配置项](docs/configuration.md#没人说话的时候主动开口)。想定时定点让它说话，就在 DSH 里给它挂个定时任务。

## 装之前

| 需要 | 版本 |
| --- | --- |
| DeepSeek Harness | ≥ 0.2.0 |
| Node.js | ≥ 18（插件零编译依赖） |
| NapCat | v4.x（推荐 `NapCat.Shell.Windows.OneKey` 独立版） |
| 一个 QQ 小号 | 别用主号，真的 |
| （可选）vosk + numpy | 只有想让语音自动转文字才要；不装也行，语音会标成「没听清」 |

## 放出去之前，逐条确认

接入只是第一天，第二天才见真章。装之前先想清楚三件事：**你准备长期维护它吗？不想养了会好好收尾吗？它在公共场合出现时，你负责吗？**——群里其他人看到的是一个会说人话的账号，不是一个玩具。

1. **别把 token 提交进仓库。** NapCat 的 access token、模型 API key 都放配置里，别写进代码或 commit。
2. **别手改 profile 的 `package.json` / `pnpm-lock.yaml` / `node_modules`。** 装插件用 `dsh plugin --profile <名字> add`，而且要在 DSH 完全退出时做。手改 lockfile 会让 pnpm 重排包、撞到被占用的文件，最坏是整个桌面端报「web 缺失或文件损坏」（这个坑真踩过，最后靠卸载重装才救回来）。
3. **杀进程按路径挑，别 `Get-Process -Name QQ | Stop-Process` 一把全杀。** NapCat 的 QQ 和你桌面的 QQ 是两套程序，一把杀会把自己踢下线。
4. **它会花你的 token。** 群里每句话都是一次模型调用，先用 `rateLimitPerMin`、`groupReplyGapMs`、`groupWakeMs` 把节奏压住。
5. **它会读写你指定的工作区。** `workspaceRoot` 指到哪，它就能在哪读写文件。
6. **上下文会被压缩或换会话。** 重要的事要落盘，别指望它一直记得。
7. **人多的地方它可能说错话。** 先用 `groupMode: 'allowlist'` 缩到测试群，稳了再放开。
8. **账号风控不是插件的问题。** 频繁换设备登录、短时间大量发消息都可能被判风险，遇到了去手机 QQ 做安全恢复。

## 出问题了去哪问

先在 [Issues](https://github.com/CPM5CCDHMR-Hub/dsh-qq-onebot/issues) 提一个：带上插件版本、DSH 版本、日志里相关的几行、复现步骤。**别贴 token 和真实 QQ 号。**

日志在哪：`<workspaceRoot>/logs/dsh-qq-<日期>.log`（一天一个文件，`workspaceRoot` 默认是跑插件的那个进程的 cwd，桌面端通常在 `$DSH_HOME/profiles/<profile>/logs/`）。找不到就在磁盘上搜 `dsh-qq-2026-*.log`——老版本的文档里写过的 `dsh-qq-debug.log` 已经不存在了。

也可以直接把报错原文、`api-state.txt`、日志尾部丢给你的 AI 助手，通常能判断出是配置、连接还是插件本身的问题。

## 许可证

MIT，见 [LICENSE](LICENSE)。用出问题、账号被风控，作者不承担责任——协议端本来就是灰色地带，用之前想清楚。
🌟 特别鸣谢 各位提供了各种插件的大大的无私奉献
本项目由 我这个小白 与 AI 搭档 「阿团」 共同“许愿”完成。
核心代码、架构设计与文档均由阿团编写，本人负责提出需求、熬夜监工与真机实测。这是我们一起完成的第一件赛博开源作品，希望它能帮到所有想长久陪伴赛博伙伴的穷哥们。
