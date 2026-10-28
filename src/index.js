import { appendFileSync, mkdirSync, statSync, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from './config.js'
import { OneBotClient } from './onebot/client.js'
import { textSegments } from './onebot/segment.js'
import { SessionManager } from './session.js'
import { createInbound, historyLine, pushHistory } from './inbound.js'
import { appendChatLog } from './chatlog.js'
import { SILENT_MARKER, personaLeaks } from './prompts.js'
import { createOutbound } from './outbound.js'
import { createBridge } from './bridge.js'
import { createPin } from './pin.js'
import { createWake } from './wake.js'
import { createSleep } from './sleep.js'
import { startLearning } from './learning.js'
import { createContextGuard } from './context-guard.js'
import { auditOutbound } from './audit.js'
import { splitText, sleep } from './shared/chunk.js'
import { registerTools } from './tools.js'
import { initMemoryHost } from './memory-host.js'
import { createIntentRouter } from './intent-router.js'
import { createLocalOllamaAdapter } from './local-adapter.js'
import { ApprovalChannel } from './approval.js'
import { QuestionChannel } from './questions.js'
import {
  applyOverrides,
  ensureSettingsFile,
  homeDirOf,
  installSettingsApi,
  loadOverrides,
  resolvePersonaFile,
  settingsFileOf,
} from './settings.js'
import { selfCheckClient } from './client-selfcheck.js'

export const name = 'dsh-qq'
export const inject = ['agents']
export const Config = ConfigSchema

const ensuredLogDirs = new Set()

function formatArg(a) {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack ?? a.message
  return safeJson(a)
}

/** 日志时间戳用**本地时间**（带偏移），不用 toISOString()。
 * 用 UTC 的话，北京时间晚上 9 点会写成 13:22Z —— 翻日志的人（和模型自己）
 * 一眼看过去就是「下午一点」，判断全乱（2026-10-24 姐姐指出来过）。 */
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

function makeLogger(ctx, config) {
  const base = ctx?.logger ?? console
  const prefix = '[dsh-qq]'
  // 日志一定要落盘。宿主是 Electron 的 GUI 子进程，启动脚本那边就算做了
  // -RedirectStandardOutput，拿到的也是 0 字节——「它为什么不说话」这种问题
  // 只能靠插件自己写文件。按天一个，放 <workspaceRoot>/logs/，和部署脚本的 logs 同一个家。
  const dir = join(config?.workspaceRoot ?? process.cwd(), 'logs')
  const fileLog = (level, args) => {
    try {
      if (!ensuredLogDirs.has(dir)) {
        mkdirSync(dir, { recursive: true })
        ensuredLogDirs.add(dir)
      }
      const now = new Date()
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      appendFileSync(join(dir, `dsh-qq-${day}.log`), `${localStamp(now)} [${level}] ${args.map(formatArg).join(' ')}\n`, 'utf8')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
  const wrap = (level) => (fn) => (...args) => {
    fileLog(level, args)
    return typeof fn === 'function' ? fn(prefix, ...args) : undefined
  }
  return {
    info: wrap('info')(base.info?.bind(base)),
    warn: wrap('warn')(base.warn?.bind(base)),
    error: wrap('error')(base.error?.bind(base)),
    debug: config?.debug ? wrap('debug')((base.debug ?? base.info)?.bind(base)) : () => {},
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 分离部署下的热生效：盯着 `settings.json`。
 *
 * 为什么需要（2026-10-25 姐姐发现）：
 * 设置页保存走的是 `POST /api/dsh-qq/settings`，`applyOverrides` 就地改的是
 * **处理那次请求的那个进程**里的 config。可这套部署是分开的——
 * desktop profile 里 dsh-qq 只有 `uiOnly: true`（设置面板），真正跑 QQ 的是
 * 另一个 `--profile qqbot` 的进程。面板改完，跑 QQ 那边根本收不到那次请求。
 *
 * 表现：用户在设置里改了群白名单 / 触发方式，机器人在线、却还是老规矩，
 * 必须手动重启 qqbot 宿主才生效。发布出去这一条会被当成「设置不生效」。
 *
 * 解法就是盯文件：另一个进程写盘 → 这里轮询到 mtime 变了 → 重读覆盖表 → 就地应用。
 * 用 `watchFile`（轮询）而不是 `fs.watch`，因为它**容忍文件不存在**（首次还没有
 * settings.json 时 watch 会直接报错），而且跨进程写盘在 Windows 上事件不可靠。
 */
export function watchSettingsFile(ctx, config, overridesRef, personaRef, logger, clientRef = null) {
  let file = ''
  try {
    file = settingsFileOf(ctx, logger)
  } catch (err) {
    logger?.warn?.('拿不到 settings.json 路径，跳过热加载:', err?.message ?? err)
    return
  }
  let lastMtimeMs = 0
  try {
    lastMtimeMs = statSync(file).mtimeMs
  } catch {
    /* 文件还不存在，正常 */
  }

  const reload = () => {
    try {
      const next = loadOverrides(ctx, logger)
      const applied = applyOverrides(config, next, logger)
      if (overridesRef?.current) {
        for (const key of Object.keys(overridesRef.current)) delete overridesRef.current[key]
        Object.assign(overridesRef.current, next)
      }
      if (personaRef) {
        personaRef.current = resolvePersonaFile(config, logger, { home: homeDirOf(ctx, logger) })
        try {
          const leak = personaLeaks(config?.persona)
          if (!leak.ok) {
            logger.warn(`人设里出现了工具用法（${leak.hits.join('、')}）——这些属于行为层，人设只该写「我是谁」。`)
          }
        } catch {
          /* ignore */
        }
      }
      logger.info(
        applied.length > 0
          ? `settings.json 变了，已就地应用: ${applied.join(', ')}（不用重启）`
          : 'settings.json 变了，但没有可覆盖的键',
      )

      // wsUrl 是唯一「填上之后必须立刻接上」的键：之前没配就没有 client 在连，
      // 这里得把它拉起来。已经连着同一个地址时不动，免得把好好的连接打断。
      const client = clientRef?.current
      if (client) {
        const want = String(config.wsUrl ?? '').trim()
        if (want && !client.connected && client.url !== want) {
          client.url = want
          client.start()
          logger.info(`wsUrl 改成了 ${want}，开始连接 NapCat`)
        }
      }
    } catch (err) {
      logger?.warn?.('重读 settings.json 失败:', err?.message ?? err)
    }
  }

  try {
    watchFile(file, { interval: 800 }, (cur) => {
      if (!cur || !cur.mtimeMs) return
      if (cur.mtimeMs === lastMtimeMs) return
      lastMtimeMs = cur.mtimeMs
      reload()
    })
  } catch (err) {
    logger?.warn?.('盯 settings.json 失败（热加载不可用）:', err?.message ?? err)
    return
  }

  // 插件卸载时把轮询停掉，别在宿主里留一个永远转的定时器
  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', () => {
      try {
        unwatchFile(file)
      } catch {
        /* 已经没了就算了 */
      }
    })
  } catch {
    /* 没有 dispose 语义的极简宿主，忽略 */
  }
}

/**
 * 把 QQ（OneBot 11 / NapCat）当成 DSH 的一个前端：
 * 私聊 / 群聊各对应一个持久 Agent 会话，消息进来 followup，回复走 session/event 出去。
 */
export function apply(ctx, config) {
  // ⭐ 设置页存下来的覆盖**先于**其它一切生效：logger 的 debug 开关也吃这一层。
  //    这样「在设置里改人设 / 改记忆区路径」不用去碰 profile 的 cordis.patch.yml。
  const savedOverrides = loadOverrides(ctx)
  const appliedOverrides = applyOverrides(config, savedOverrides)
  const logger = makeLogger(ctx, config)
  if (appliedOverrides.length > 0) logger.info(`已应用设置页覆盖: ${appliedOverrides.join(', ')}`)

  // 第一次启动就落一份骨架 settings.json（设置页没上场时，用户手里唯一的入口）
  ensureSettingsFile(ctx, logger)
  // 客户端半端自检：id 对不上 / inject 为空时，宿主会**静默跳过整条 client bundle**，
  // 设置里就看不到 QQ（2026-10-25 踩过两次，issue #2 第 1 条）
  selfCheckClient(logger)
  // 设置页保存后要就地刷新这两份状态：persona 可能换了文件，覆盖表可能变了
  const overridesRef = { current: savedOverrides }
  const personaRef = { current: resolvePersonaFile(config, logger, { home: homeDirOf(ctx, logger) }) }

  // 两层提示词的边界检查：人设里混进工具名，日志留痕但不阻止（怎么写是人家的自由）。
  try {
    const leak = personaLeaks(config?.persona)
    if (!leak.ok) {
      logger.warn(
        `人设里出现了工具用法（${leak.hits.join('、')}）——这些属于行为层，人设只该写「我是谁」。` +
          '工具改名或换宿主时这段会变成错的指引。',
      )
    }
  } catch {
    /* ignore */
  }
  const agents = ctx?.agents

  // 另一个进程（设置面板）改了 settings.json 时，这边自己跟上，不用重启宿主。
  // clientRef 先占位：client 要到下面才建，热更新回调得能拿到它（填 wsUrl 后要自动接上）。
  const clientRef = { current: null }
  watchSettingsFile(ctx, config, overridesRef, personaRef, logger, clientRef)

  // 设置页接口：**运行时注入** webServer，而不是写进顶层 `export const inject`。
  // 有网页服务的宿主（Desktop / Web GUI）才会回调进来；headless 的 qqbot 永远不回调，
  // 于是插件照常激活、QQ 照常在线。顶层声明的话，headless 会一直等 provider →
  // 整个插件不激活 → 机器人直接掉线（2026-10-24 踩过）。
  //
  // 注意：把**父 ctx** 传下去，只借注入回调拿到的 webServer 实例。
  // 路由的 effect 必须挂在父 ctx 上；挂在注入回调那个子 ctx 上，回调一结束就被收走
  // —— 现象是 api-state 写 ok=true、前端却一直 404（2026-10-24 第二次踩）。
  const mountSettingsApi = (extra = {}) => {
    // 测试桩 / 极简宿主可能没有 ctx.inject，这时候跳过就好，别让整个插件崩
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (sub) =>
      installSettingsApi({ ctx, webServer: sub.webServer, config, logger, ...extra }),
    )
  }

  // 只当「设置面板」用：桌面 / Web GUI 那份只提供这一页，不去连 NapCat。
  // 不然同一个 QQ 号在两处同时登录，消息会互相抢。
  if (config.uiOnly) {
    mountSettingsApi({ personaRef, overridesRef })
    logger.info('uiOnly：只提供设置页，不连接 NapCat')
    return
  }

  if (!agents) {
    logger.warn('宿主没有 agents 服务，dsh-qq 不启动')
    return
  }

  // 没配地址就别去连——空 url 会让 `new WebSocket('')` 抛 Invalid URL，然后静默重连到天荒地老；
  // 也不偷偷套一个 3001：那等于替用户做主，连不上还说不出为什么（issue #2 实测反馈）。
  const wsUrl = String(config.wsUrl ?? '').trim()
  if (!wsUrl) {
    logger.warn(
      `还没配 NapCat 的 WebSocket 地址（wsUrl），QQ 不会连上。` +
        `去设置 → QQ 里填，或改 ${settingsFileOf(ctx, logger)}（常见值 ws://127.0.0.1:3001）；` +
        `保存后约 800ms 自动接上，不用重启宿主。`,
    )
  }

  const client = new OneBotClient({
    url: wsUrl,
    token: config.accessToken,
    reconnectMs: config.reconnectMs,
    logger,
  })
  clientRef.current = client

  let selfId = String(config.selfId ?? '')
  const manager = new SessionManager({ agents, selfId, config, logger, home: homeDirOf(ctx, logger) })
  manager.start()

  // 通道回执：断线 / 发送失败要让她知道（见 bridge.js 顶部那段起因）
  const bridge = createBridge({ config, logger, manager })
const pin = createPin({ config, logger })

  // 每个会话最近 60 秒的发消息时间戳 —— 防「回得太快」被风控
  const sentLog = new Map()

  function rateOk(key, limit) {
    const n = Number(limit) || 0
    if (n <= 0) return true // 0 = 关闭限流
    const now = Date.now()
    const arr = (sentLog.get(key) ?? []).filter((t) => now - t < 60_000)
    if (arr.length >= n) {
      sentLog.set(key, arr)
      return false
    }
    arr.push(now)
    sentLog.set(key, arr)
    return true
  }

  const lastSentAt = new Map() // 群聊里上一条发出去的毫秒时间，用来拉开间隔

  /**
   * 自己发出去的话进历史 + 落聊天流水。正文（send）和工具出口（qq_send / qq_reply / 发图…）共用。
   *
   * 2026-10-27 补：以前只有正文这条记账，工具发出去的话既不进流水、也不进 history，
   * 结果她说过的话在记录里缺一句，下一轮自己也看不见，翻记录还会对不上。
   */
  function noteSelfSaid(record, said) {
    const text = String(said ?? '').trim()
    if (!record || !text) return
    const selfName = manager.selfName || '机器人'
    const entry = historyLine(null, text, { isSelf: true, selfName })
    pushHistory(record, entry, config.historyLimit)
    record.recent.push(entry)
    const recentKeep = Math.max(80, (Number(config.contextMemoryKeep) || 30) * 3)
    if (record.recent.length > recentKeep) record.recent.splice(0, record.recent.length - recentKeep)

    // 聊天流水：自己说的话也落盘，不然翻记录时只有对方在自言自语
    if (config.chatLog !== false) {
      const myId = manager.selfId || config.selfId || ''
      const who = myId ? `${selfName}(${myId})` : selfName
      appendChatLog(record.dir, { who, text }, logger).catch(() => {})
    }
  }

  async function send(record, text) {
    // 「这次不接话」：模型只输出 [SILENT] 就当作它选择潜水 —— 不发、不进历史、不报错。
    // 出口只在「这条不一定是在叫它」时给（见 inbound.js 的 mustReply），
    // 被 @、被引用、私聊都不会走到这里。
    const trimmed = String(text ?? '').trim()
    if (trimmed === SILENT_MARKER) {
      logger.info(`[dsh-qq] ${record.label} 选择不接话（${SILENT_MARKER}）`)
      // 沉默不该扣主动开口的额度：机会白给，她想开口的话下次还有（2026-10-26）
      wake.noteProactiveSilent(record)
      return
    }
    const chunks = splitText(text, config.textChunkLimit)
    if (chunks.length === 0) return

    // 外发审计：本机路径 / 凭据整条拦下。流式、整段、报错提示都从这里出去，
    // 所以闸放在 split 之后、真正调 OneBot 之前，一处堵死。
    if (config.auditOutbound !== false) {
      const verdict = auditOutbound(trimmed, {
        extraPatterns: config.auditExtraPatterns ?? [],
      })
      if (!verdict.ok) {
        logger.warn(
          `[dsh-qq] ${record.label} 外发被审计拦下（${verdict.kind}）：${verdict.hit}`,
        )
        return
      }
    }
    const isGroup = record.scope === 'group'
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const target = isGroup ? { group_id: Number(record.peerId) } : { user_id: Number(record.peerId) }
    const rateKey = `${record.scope}:${record.peerId}`
    let sentAny = false

    // 群聊：两条回复之间拉开一点。一群人追着问的时候，
    // 连着往外吐最容易被人当成刷屏，也最容易被风控。
    const gapMs = record.scope === 'group' ? Math.max(0, Number(config.groupMinGapMs) || 0) : 0
    if (gapMs > 0) {
      const last = lastSentAt.get(rateKey) ?? 0
      const wait = last + gapMs - Date.now()
      if (wait > 0 && wait <= 30000) await sleep(wait)
    }
    lastSentAt.set(rateKey, Date.now())

    for (let index = 0; index < chunks.length; index += 1) {
      // 限流优先于一切：宁可不回，也不要在被围攻时跟着刷屏
      if (!rateOk(rateKey, config.rateLimitPerMin)) {
        logger.warn(`[dsh-qq] ${record.label} 触到每分钟上限，本条不再发（剩 ${chunks.length - index} 段）`)
        break
      }
      try {
        const result = await client.call(action, { ...target, message: textSegments(chunks[index]) })
        // 记下自己发的消息 id，撤回工具要用
        const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
        if (sentId > 0) record.lastSentMessageId = sentId
        sentAny = true
        // 真发出去了才算用掉一次主动开口的额度（回复不受影响：pending 只在主动轮有）
        wake.noteProactiveDelivered(record)
        logger.info(`→ ${record.label}: ${chunks[index].slice(0, 60)}`)
      } catch (err) {
        logger.warn(`发送到 ${record.label} 失败:`, err?.message ?? err)
        // 回执：这句没送出去。下一轮投递时会告诉她「是通道断了，不是对方不理你」。
        bridge.noteSendFailure(record, chunks[index], err)
        break
      }
      if (index < chunks.length - 1) await sleep(config.splitDelayMs)
    }

    // 自己发出去的话也要进历史：不然下一轮它看不见「我说过什么」，
    // 群里口吻相近的别的机器人一开口，就会当成自己说的去道歉、去撤回。
    if (sentAny) noteSelfSaid(record, trimmed)

    // 发完了，取消「正在输入」
    if (!isGroup) {
      client.call('set_input_status', { user_id: Number(record.peerId), event_type: 0 }, 5000).catch(() => {})
    }
  }

  const approval = new ApprovalChannel({ manager, config, logger, send })
  approval.install(ctx)

  const questions = new QuestionChannel({ manager, config, logger, send })
  questions.install(ctx)

  const contextGuard = createContextGuard({ manager, config, logger })
  const wake = createWake({ config, manager, logger, bridge, pin })
  const bedtime = createSleep({ config, manager, logger })
  // 睡着的会话不回收：回收后 tick/wake 都遍历不到它，早上攒的消息就交不出去
  manager.keeper = (record) => bedtime.isHolding(record)
  // 记忆卡引擎（surf CORE 移植）：跨所有 QQ 会话共享一张卡，10 分钟维护一次。
  const memory = initMemoryHost({ config, logger })
  // 意图路由：短闲聊切本地 Ollama，复杂活保持云端。拿不到 llm 服务就全部走云端。
  // 不在 apply 时把服务抓死：插件加载顺序不保证 llm 已经注册，晚到也要能等到。
  const getLlm = () => {
    try {
      return ctx.get?.('llm') ?? null
    } catch {
      return null
    }
  }
  const intentRouter = createIntentRouter({ config, logger, getLlm })
  intentRouter.start()
  // 本地 Ollama 由插件自己注册，不用 pi-ai 的 openai-completions 路由：
  // 前者能在发请求前裁掉长历史，后者会把整段 3 万多 token 直接塞给 3B 模型。
  const localProvider = String(config?.intentLocalProvider ?? '').trim() || 'local_ollama'
  ctx.inject(['llm'], (sub) => {
    try {
      if (typeof sub.llm?.registerAdapter !== 'function') return
      const handle = sub.llm.registerAdapter([localProvider], createLocalOllamaAdapter({ config, logger }))
      sub.effect(() => handle)
      logger.info(`[intent] 本地 Ollama 适配器已注册：${localProvider}`)
      void intentRouter.refresh(true)
    } catch (err) {
      logger.warn(`[intent] 本地 Ollama 适配器注册失败，继续全部走云端：${err?.message ?? err}`)
    }
  })
  const inbound = createInbound({
    config,
    manager,
    logger,
    client,
    send,
    approval,
    questions,
    contextGuard,
    wake,
    sleep: bedtime,
    bridge,
    pin,
    memory,
    intentRouter,
  })
  const outbound = createOutbound({ manager, config, logger, send, wake })

  // 群黑话 / 角色知识学习：每 20 分钟扫一次群聊记录，把「鲸鲸自己卡壳」的地方
  // 记进该群 记忆区/群词典.md 的「待确认」节（只追加、去重）。
  const disposeLearning = startLearning({
    workspaceRoot: config.workspaceRoot ?? process.cwd(),
    selfId: () => manager.selfId || config.selfId || '',
    logger,
  })

  const offSessionEvent = ctx.on('session/event', outbound)
  const offGuardEvent = ctx.on('session/event', contextGuard.onSessionEvent)

  client.on('event', (event) => {
    inbound(event).catch((err) => logger.warn('处理入站消息失败:', err?.message ?? err))
  })

  client.on('open', async () => {
    logger.info(`已连接 ${config.wsUrl}`)
    // 断过又连回来：只有「断线期间真丢过话」的会话才记一笔，等下一轮投递告知
    bridge.markUp()
    try {
      // 就算配置里写死了 selfId，也要问一次昵称：历史行里「你（昵称）」得写对，
      // 不然它认不出哪个是自己发的。
      const info = await client.call('get_login_info', {}, 10_000)
      if (info?.user_id) {
        if (!selfId) {
          selfId = String(info.user_id)
          manager.selfId = selfId
        }
        if (info.nickname) manager.selfName = String(info.nickname)
        logger.info(`登录账号 ${info.nickname ?? ''} (${info.user_id})`)
      }
    } catch (err) {
      logger.warn('获取登录账号失败，请手动填 selfId:', err?.message ?? err)
    }
  })

  // 断开日志用状态机：第一次断打一行带原因，之后只累计；持续断开时每小时最多一句汇总。
  // 逐条打的话，退避重连（5s→10s→20s→40s→60s）一小时能刷出约 120 行 warn，
  // 把真正重要的行全埋了（issue #2 实测反馈）。
  let downSince = 0
  let dropCount = 0
  let lastSummaryAt = 0
  const noteDown = (reason) => {
    const now = Date.now()
    dropCount += 1
    if (!downSince) downSince = now
    if (dropCount === 1) {
      lastSummaryAt = now
      logger.warn(
        `与 NapCat 断开${reason ? `（${reason}）` : ''}，稍后自动重连；后续重试不再逐条报，恢复时会通知`,
      )
      return
    }
    if (now - lastSummaryAt >= 3600_000) {
      lastSummaryAt = now
      const mins = Math.max(1, Math.round((now - downSince) / 60000))
      logger.warn(
        `与 NapCat 断开已持续约 ${mins} 分钟，累计重试 ${dropCount} 次，最近一次：${reason || '无详情'}`,
      )
    }
  }

  client.on('open', () => {
    if (downSince > 0) {
      const mins = Math.max(1, Math.round((Date.now() - downSince) / 60000))
      logger.info(`NapCat 连回来了（断了约 ${mins} 分钟，累计重试 ${dropCount} 次）`)
    }
    downSince = 0
    dropCount = 0
    lastSummaryAt = 0
  })
  client.on('close', () => {
    bridge.markDown()
    noteDown('')
  })
  client.on('error', (err) => {
    noteDown(String(err?.message ?? err ?? ''))
  })

  // 地址没配就别 start：OneBotClient 会对空 url 无限重试，日志刷屏还没结果。
  // 填上地址后由 watchSettingsFile 那个 clientRef 回调把它拉起来。
  if (wsUrl) {
    client.start()
  } else {
    logger.info('wsUrl 还没填，先不连接 NapCat（填好并保存后会自动接上）')
  }
  // 私聊门控：默认 allowlist，白名单空着 = 谁都不理。不说清楚，用户会以为「加了好友怎么没反应」。
  const privateAllow = (config.privateAllow ?? []).map(String).filter(Boolean)
  if (config.replyToPrivate && config.privateMode === 'allowlist' && privateAllow.length === 0) {
    logger.warn(
      '私聊白名单（privateAllow）是空的：现在任何人私聊都不会被回应。' +
        '要把谁放进来，去设置 → QQ 里填他的 QQ 号；想谁都聊就把 privateMode 改成 open。',
    )
  }
  wake.start()
  bedtime.start()

  try {
    registerTools(ctx, { client, manager, config, logger, pin, wake, noteSelfSaid })
  } catch (err) {
    logger.warn('QQ 互动工具注册失败（聊天本身不受影响）:', err?.message ?? err)
  }

  // ── 设置页接口：/api/dsh-qq/* ─────────────────────────────────────────────
  // DSH 设置界面里那一页（client.js）打的就是这几个口。
  mountSettingsApi({ client, manager, personaRef, overridesRef })


  ctx.on('dispose', () => {
    try {
      offSessionEvent?.()
      offGuardEvent?.()
      disposeLearning?.()
    } catch {
      /* ignore */
    }
    try {
      memory?.dispose?.()
    } catch {
      /* ignore */
    }
    intentRouter.stop()
    client.stop()
    wake.stop()
    bedtime.stop()
    manager.stop()
    approval.cancelAll()
    questions.cancelAll()
  })
}
