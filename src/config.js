import Schema from '@deepseek-ai/schemastery'

/**
 * dsh-qq 配置。
 *
 * 设计原则：
 *  - 所有跟「连谁、允许谁说话、放开到什么程度」有关的键，默认都是保守的；
 *  - provider / model / preset / cwd 一律留空跟随宿主，避免把某个人的环境写死。
 */
export const ConfigSchema = Schema.object({
  // ── 连接 ──
  wsUrl: Schema.string()
    .default('')
    .description(
      'NapCat（或其它 OneBot 11 实现）的正向 WebSocket 地址，例如 ws://127.0.0.1:3001。' +
        '留空就不连接——不会偷偷去连 3001，启动时会在日志里提示去哪配',
    ),
  accessToken: Schema.string()
    .default('')
    .description('与 NapCat 配置里一致的 access token，留空表示不鉴权（仅建议在本机回环场景）'),
  selfId: Schema.string()
    .default('')
    .description('机器人自己的 QQ 号。留空时启动会向 NapCat 查询 get_login_info'),
  reconnectMs: Schema.number()
    .default(5000)
    .description('断线重连间隔，单位毫秒'),

  // ── Agent ──
  provider: Schema.string().description('LLM provider 名称；留空跟随宿主默认'),
  model: Schema.string().description('模型名；留空跟随宿主默认'),
  intentRoutingEnabled: Schema.boolean()
    .default(true)
    .description(
      '意图路由：短闲聊走本地 Ollama，省云端 token；复杂活/长消息仍走默认云端模型。本地 provider 没注册时自动全部走云端',
    ),
  intentLocalProvider: Schema.string()
    .default('local_ollama')
    .description('本地模型在宿主 llm 服务里注册的 provider 名（默认 local_ollama）'),
  intentLocalModel: Schema.string()
    .default('qwen2.5:3b-32k')
    .description('本地模型名（默认 qwen2.5:3b-32k，Ollama 里 32K 上下文的 qwen2.5:3b）'),
  intentLocalMaxChars: Schema.number()
    .default(16)
    .description('正文不超过多少个字才考虑走本地；超了直接走云端'),
  intentLocalInGroups: Schema.boolean()
    .default(false)
    .description('群聊里是否也允许本地模型接短闲聊；默认关，群聊上下文长且人多，省不了多少还容易答歪'),
  intentLocalBaseURL: Schema.string()
    .default('http://127.0.0.1:11434')
    .description('本地 Ollama 地址；默认本机 11434'),
  intentLocalHistoryChars: Schema.number()
    .default(14000)
    .description('本地模型最多带多少字的历史（按字数粗暴估），超出就丢最老的轮次'),
  intentLocalSystemChars: Schema.number()
    .default(12000)
    .description('本地模型最多带多长的系统提示词，超出截断'),
  intentLocalMaxUserTurns: Schema.number()
    .default(4)
    .description('本地模型最多保留最近几轮用户消息'),
  preset: Schema.string().description('Agent preset id；留空使用宿主默认组合（unset = 跟随宿主）'),
  cwd: Schema.string().description('Agent 工作目录；留空使用宿主默认'),
  uiOnly: Schema.boolean()
    .default(false)
    .description(
      '只提供 DSH 设置界面里的那一页，不连接 NapCat、不起会话。桌面 / Web 那份装一份、配成 true，就是纯设置面板；QQ 本体跑在另一个 profile 里，不然同一个号两处登录会抢消息',
    ),
  workspaceRoot: Schema.string()
    .default('')
    .description('每个 QQ 会话的独立工作目录放在哪里；留空用 <cwd>/会话'),
  doorDir: Schema.string()
    .default('')
    .description(
      '「门口」信箱目录：别的窗口（比如大姐）给它留的话，每封一个 .md 文件。留空则关闭。填了以后每轮提示词里会多一行「门口有 N 封」，但**不给内容** —— 它自己 read 才看得到，拆不拆随它，不催不推',
    ),
  isolateByPeer: Schema.boolean()
    .default(true)
    .description('每个私聊/每个群各自一个工作目录与记忆区（互不可见，也不碰宿主的私人记忆区）'),
  memoryCardDir: Schema.string()
    .default('')
    .description('记忆卡（角色长期经历记忆）放哪个目录；留空用 <workspaceRoot>/记忆卡，跨所有 QQ 会话共享一张'),
  voiceName: Schema.string()
    .default('')
    .description('发语音条用哪个系统音色（SAPI 音色名，如 Microsoft Huihui Desktop）；留空用系统默认'),
  voiceRate: Schema.number()
    .default(0)
    .description('语音语速，-10~10，0 为正常'),
  voiceCacheDir: Schema.string()
    .default('')
    .description('语音条 wav 缓存目录；留空用 <workspaceRoot>/语音缓存'),
  persona: Schema.string()
    .default('')
    .description(
      '角色设定：它是谁、什么性格、怎么称呼对方。留空则是一只没有名字、说话正常的普通助手——插件不会自带任何人的私人设定',
    ),
  personaFile: Schema.string()
    .default('')
    .description(
      '人设文件路径（比如 D:/某个角色.md）。填了就从这个文件读人设，覆盖上面的 persona；文件读不到时保留 persona，不会把角色弄丢',
    ),
  personaInSystem: Schema.boolean()
    .default(false)
    .description(
      '人设已经由宿主的系统提示（profile 里 system-prompt 的 personaPrefix）带着时设 true：插件不再把 persona 拼进每条消息。人设放对话历史里会被模型当成「上一轮说过的话」、还会被压缩器当聊天搅进去；放系统提示里只说一次、不进历史。留 false 维持旧行为',
    ),
  ownerIds: Schema.array(Schema.string())
    .default([])
    .description(
      '「主人」的 QQ 号，可多个。群聊里这些人的发言会标上主人称呼，Agent 会优先响应、问本机的事也正常答；不在名单里的群友一律按陌生人对待。留空则不区分任何人',
    ),
  ownerLabel: Schema.string()
    .default('主人')
    .description('群聊里怎么称呼这位主人，例如「老板」「老大」；默认「主人」'),
  directPrompt: Schema.string()
    .default('')
    .description('私聊时追加到每条投递文字最前面的补充指令（内置聊天规矩在 preset 里，这里放你自己的）'),
  groupPrompt: Schema.string()
    .default('')
    .description('群聊时追加到每条投递文字最前面的补充指令（内置聊天规矩在 preset 里，这里放你自己的）'),
  aiGirls: Schema.boolean()
    .default(true)
    .description(
      '把「AI 娘图鉴」夹进提示词：群友说到 DeepSeek 娘、龙娘、通义娘这些同人角色时认得出来，不会当成真人或瞎猜。大约多几百字，嫌占地方可以关掉',
    ),
  historyLimit: Schema.number()
    .default(20)
    .description('群聊时额外带入的最近消息条数（0 = 不带历史）'),
  quoteReply: Schema.boolean()
    .default(true)
    .description('收到的消息带引用时，把「被引用的人 + 原文」一并交给 Agent'),
  maxTurnMs: Schema.number()
    .default(600000)
    .description('单轮回复最长等待时间，单位毫秒（默认 10 分钟；超时只提示，不打断 Agent）'),

  // ── 触发策略 ──
  requireMention: Schema.boolean()
    .default(true)
    .description('群聊里是否必须 @ 机器人才回复'),
  groupWakeMs: Schema.number()
    .default(60000)
    .description('群里被 @ 过一次之后，多久内不用再 @ 也能接话，单位毫秒（0 = 关闭；2026-10-24 按群友的建议从 5 分钟改成 1 分钟）'),
  groupWakeIdleMs: Schema.number()
    .default(5000)
    .description(
      '保活窗的续期门槛，单位毫秒（0 = 关闭，退回「窗内每句都续期」）。窗里说话跟上一条隔得比这更久，窗就当场关掉——连着聊才续，一停顿就散场，2026-10-25 姐姐定的',
    ),
  groupRepliesPerWindow: Schema.number()
    .default(0)
    .description(
      '一个保活窗口里最多回几次（默认 0 = 不限）。注意：它和「窗口内说话续期」会打架——窗口一直续着、额度却固定，聊几句就哑了。想防连珠炮请用 groupReplyGapMs',
    ),
  groupReplyGapMs: Schema.number()
    .default(20000)
    .description(
      '群里两次回复之间至少隔多久，单位毫秒（默认 20000，0 = 不限）。间隔内的消息不丢，攒进 backlog，下一次回复时一起看见 —— 这就是「均匀地回应几次」的实现方式',
    ),
  // ── 群聊「非 @ 叫醒」（2026-10-25 姐姐提的：只会跟 @ 的人回复太死板）──
  // 判定逻辑在 src/wake-trigger.js，学自 qq-bridge 的 evaluateWakeTriggerV2。
  // 发布默认保守：叫名字、被问话都听得见（这两样不会乱插话），关键词表留空、概率关着。
  // 想让它在群里活络一点，把 groupWakeKeywords 填上、groupWakeProbability 开成 0.05 就行。
  groupWakeNameMention: Schema.boolean()
    .default(true)
    .description('群里叫鲸鲸的名字（含 groupWakeNames 里的别名）就算在叫它，不用 @'),
  groupWakeQuestion: Schema.boolean()
    .default(true)
    .description('明显在问它（「你行不行」「在不在」「理我」这类）就算在叫它，不用 @'),
  groupWakeKeywords: Schema.array(Schema.string())
    .default([])
    .description('自定义关键词，消息里出现就算在叫它（如 白毛、DS）。短英文自动按词边界匹配，不会误伤 ADS'),
  groupWakeProbability: Schema.number()
    .default(0)
    .description(
      '没人叫它时，每条群消息有这么大的比例顺带看一眼（0 = 关闭；这种唤醒允许它看完不说话）',
    ),
  groupWakeNames: Schema.array(Schema.string())
    .default([])
    .description('额外的称呼，除了 QQ 昵称以外还算作叫它（如 大肥鱼、鲸鲸、鲸鱼娘）'),
  addressedMaySilent: Schema.boolean()
    .default(false)
    .description(
      '群里被 @ / 被引用 / 被点名时，允许它看完不说话（默认 false = 被叫必须回）。开了以后消息照样进上下文，只是不再强制开口',
    ),
  replyToPrivate: Schema.boolean()
    .default(true)
    .description('是否响应私聊'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled'])
    .default('open')
    .description('群聊访问控制：open 全部 / allowlist 仅白名单 / disabled 关闭群聊'),
  groupAllow: Schema.array(Schema.string())
    .default([])
    .description('groupMode=allowlist 时生效的群号列表'),

  // ── 同类机器人（机器人和机器人之间）──
  // 用户 2026-10-24：「吵架功能单独做个开关，这个开关控制它要不要和同类聊天，以及对比较冲的同类回怼」。
  botChatEnabled: Schema.boolean()
    .default(false)
    .description('群里另一个机器人说话时要不要接（关着 = 同类说啥都不理，连 @ 也不接）'),
  peerBots: Schema.array(Schema.string())
    .default([])
    .description('已知的同类机器人 QQ 号；填了才认得出「这句是别的机器人发的」（NapCat 也带 is_robot 时同样认）'),
  privateMode: Schema.union(['open', 'allowlist', 'disabled'])
    .default('allowlist')
    .description(
      '私聊访问控制：allowlist 仅白名单（默认；白名单空着 = 谁都不理）/ open 谁都能聊 / disabled 关闭私聊。' +
        '默认不再放行陌生人：能私聊这个号的人，就能指挥跑在你机器上的 agent',
    ),
  privateAllow: Schema.array(Schema.string())
    .default([])
    .description('privateMode=allowlist 时生效的 QQ 号列表；空着就谁都不理'),

  // ── 好友请求（2026-10-28 加：不用再外挂一个监听脚本）──
  friendRequestMode: Schema.union(['off', 'open', 'allowlist'])
    .default('off')
    .description(
      '好友请求怎么处理：off 不理会（默认，请求原样留在 NapCat 待处理）/' +
        ' open 自动通过所有请求 / allowlist 只自动通过 friendRequestAllow 里的人。' +
        '通过后会把这条请求记进 <workspaceRoot>/friend-requests.jsonl，并按 friendRequestNotify 知会主人',
    ),
  friendRequestAllow: Schema.array(Schema.string())
    .default([])
    .description('friendRequestMode=allowlist 时，自动通过哪些 QQ 号'),
  friendRequestNotify: Schema.boolean()
    .default(true)
    .description('自动通过好友后，给 ownerIds 的第一个人发一条 QQ 知会（说一句「刚加了谁」）'),

  // ── 主动说话的「冷会话拉回」（2026-10-25 加）──
  // 会话闲置太久会被回收出内存；主动说话轮只看得见内存里的会话，
  // 冷掉之后就永远不会主动开口了。开着 = 每轮先把它拉回来。
  wakeColdSessions: Schema.boolean()
    .default(false)
    .description(
      '主动说话前把白名单里的私聊会话拉回内存（关着 = 只有对方先说话，这个会话才会被主动说话轮看见）',
    ),
  wakeColdMax: Schema.number()
    .default(3)
    .description('每次最多拉回几个冷会话（防止一次唤醒太多、吃内存和 token）'),

  // ── 回收（2026-10-25 修）──
  // 私聊的「安静 20 分钟」和「闲置 30 分钟回收」只差 10 分钟，
  // 姐姐一忙、会话一回收，主动说话轮就够不着它，一整天等不到一次主动开口。
  // 群聊保持 sessionIdleTimeout 原值（人多、会话便宜回收）。
  privateIdleTimeout: Schema.number()
    .default(12 * 3_600_000)
    .description('私聊会话闲置多久回收出内存，单位毫秒，默认 12 小时；群聊仍用 sessionIdleTimeout'),

  // ── 图片 ──
  faceCollectHint: Schema.string()
    .default('')
    .description(
      '什么样的图值得收进表情包收藏（qq_keep_face），例如「猫猫梗图」。留空表示不收藏任何图片，只让 Agent 看图说话',
    ),
  faceSendGapMs: Schema.number()
    .default(90000)
    .description('两次发图片/表情之间至少隔多少毫秒（防止刷屏）；0 = 不限制'),
  faceSendMaxPerHour: Schema.number()
    .default(6)
    .description('一小时内最多发多少张图片/表情（qq_mface / qq_send_image 合计）；0 = 不限制'),
  imageCacheDir: Schema.string()
    .default('')
    .description('收到的图片下载到哪个目录；留空用 <cwd>/图片缓存'),
  imageMaxMB: Schema.number()
    .default(8)
    .description('单张图片最大体积（MB），超过就丢弃不下载'),

  // ── 工具：查梗 ──
  memeDb: Schema.string()
    .default('')
    .description(
      '查梗用的词库（cnmeme.wiki 的 sqlite 快照）放在哪；留空则读环境变量 DSH_QQ_MEME_DB。' +
        '两个都空时 qq_meme 会说明「没配词库」，不会瞎猜出处',
    ),

  // ── 语音转文字（离线 vosk） ──
  asrEnabled: Schema.boolean()
    .default(true)
    .description('收到语音时用本地 vosk 离线转成文字（不需要联网）'),
  asrPython: Schema.string()
    .default('python')
    .description('运行 ASR 脚本的 python 可执行文件；默认要求 python 在 PATH 里，且装过 vosk + numpy'),
  asrScript: Schema.string()
    .default('')
    .description('ASR 脚本路径；留空使用插件自带的 tools/asr.py'),
  asrModel: Schema.string()
    .default('')
    .description('vosk 模型目录（必须是纯 ASCII 路径）；留空由 asr.py 自己找，也可用环境变量 VOSK_MODEL'),
  asrTimeoutMs: Schema.number()
    .default(60000)
    .description('单条语音转文字的超时时间，单位毫秒'),

  // ── 输出 ──
  textChunkLimit: Schema.number()
    .default(1500)
    .description('单条消息最大字数，超出会按段落/句号切成多条发'),
  showToolResults: Schema.boolean()
    .default(false)
    .description('是否把工具调用结果也发到 QQ（默认关闭，只发文字回复）'),
  splitDelayMs: Schema.number()
    .default(400)
    .description('分条发送之间的间隔，单位毫秒'),
  rateLimitPerMin: Schema.number()
    .default(12)
    .description('每个会话每分钟最多发几条（0 = 关闭）。QQ 对高频回复很敏感，被限流甚至被封往往不是因为说了什么，而是因为回得太多'),
  auditOutbound: Schema.boolean()
    .default(true)
    .description('外发前审计：回复里带本机路径（C:\\…、/home/…）或凭据特征（sk-…、ghp_…、Bearer …）就整条拦下不发，只记日志'),
  auditExtraPatterns: Schema.array(Schema.string())
    .default([])
    .description('额外要拦的正则（字符串形式），命中同样整条不发；配错的正则会跳过'),
  groupMinGapMs: Schema.number()
    .default(4000)
    .description('群聊里两条回复之间至少隔多久，单位毫秒（0 = 不限制）。群里连着追问时，隔开一点比一口气说完安全得多'),
  streamReply: Schema.boolean()
    .default(true)
    .description('私聊是否边生成边发（群聊始终整段发）'),
  streamMaxChunks: Schema.number()
    .default(3)
    .description('一个回合里最多流式发几条，超出就攒起来一起发'),

  // ── 主动说话 ──
  proactiveEnabled: Schema.boolean()
    .default(true)
    .description('没人说话、安静了一段时间之后，主动开口一次（冷场冒泡）'),
  proactiveSilentMs: Schema.number()
    .default(1200000)
    .description(
      '会话安静多久算「冷场」，单位毫秒，默认 20 分钟。要小于 sessionIdleTimeout（默认 30 分钟），否则会话先被回收、根本没机会开口',
    ),
  proactiveMaxPerDay: Schema.number()
    .default(6)
    .description('每个会话每天最多主动开口几次；0 = 不主动'),
  proactiveQuietHours: Schema.string()
    .default('23:00-08:00')
    .description('静默时段：这段时间不主动开口。格式 HH:MM-HH:MM，留空 = 不限'),

  // ── 作息（睡前提醒 / 晚安静默 / 夜里消息留到早上） ──
  sleepMode: Schema.boolean()
    .default(true)
    .description('作息总开关：到点提醒睡觉、说晚安就休息、休息时段的消息留到早上一起回'),
  bedtimeAt: Schema.string()
    .default('23:30')
    .description('几点提醒她该睡了（HH:MM）。留空 = 不提醒'),
  sleepFrom: Schema.string()
    .default('00:00')
    .description('休息时段从几点开始（HH:MM）：这时候起收到的私聊不立刻回'),
  sleepTo: Schema.string()
    .default('08:00')
    .description('休息时段到几点结束（HH:MM）：这时候把夜里攒的消息一次交出去'),
  goodnightWords: Schema.string()
    .default('晚安,睡了,睡觉,去睡,我先睡,困了,睡啦')
    .description('说到这些词就当她说晚安了，之后不再回消息直到睡醒。逗号分隔'),
  // ⭐ 2026-10-25：默认不按住——姐姐半夜说话通常就是她醒了，正常回。
  // 想让她「夜里真的静音、消息留到早上」的话，把这个打开。
  holdNightMessages: Schema.boolean()
    .default(false)
    .description(
      '休息时段（sleepFrom~sleepTo）和说完晚安后，私聊消息先捂着、早上再一起回；关着 = 照常回（姐姐半夜说话说明她醒了）',
    ),

  // ── 连发合并 ──
  mergeWindowMs: Schema.number()
    .default(5000)
    .description(
      '连发合并：收到一条私聊消息后等这么久（毫秒），期间再接到的消息并成同一轮再回；0 = 关掉，来一条回一条',
    ),

  // ── 上下文管理 ──
  contextGuard: Schema.boolean()
    .default(true)
    .description('上下文守卫：DSH 自动压缩后补回聊天规矩；接近窗口上限时主动换新会话'),
  contextSwapRatio: Schema.number()
    .default(0.7)
    .description(
      '最近一次请求的 token 数超过窗口的这个比例就主动换新会话（0 = 不主动换，交给 DSH 自己的压缩）；DSH 默认在 0.8 自动压缩',
    ),
  contextSwapMinTokens: Schema.number()
    .default(200000)
    .description('主动换会话的绝对下限：请求 token 没到这个数就不换，免得小窗口模型刚聊两句就换'),
  contextMemoryKeep: Schema.number()
    .default(30)
    .description('换会话前把最近多少条聊天记进 记忆区/压缩记忆/，给新会话接话用'),

  // ── 聊天流水 ──
  chatLog: Schema.boolean()
    .default(true)
    .description(
      '把收到的消息和它自己说的话记进会话目录的 聊天记录/<日期>.md。关掉也能用，但那就会「聊完就忘」',
    ),

  // ── 生命周期 ──
  sessionIdleTimeout: Schema.number()
    .default(1800000)
    .description('会话闲置多久后回收，单位毫秒（默认 30 分钟）'),
  debug: Schema.boolean()
    .default(false)
    .description('输出调试日志'),
})
