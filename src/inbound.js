import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readMessage } from './onebot/segment.js'
import { rememberFaces, facesCount, facesForPrompt } from './faces.js'
import { buildChatPrompt, faceCollectRule, IMAGE_RULES, QUOTE_DIRECTION_HINT, SILENT_HINT } from './prompts.js'
import { evaluateWakeTrigger, rollWakeProbability } from './wake-trigger.js'
import { doorLine } from './door.js'
import {
  factsFileFor,
  glossaryFileFor,
  loadFactsFor,
  loadGlossaryFor,
  loadGroupDigest,
  loadHandoffFor,
} from './settings.js'
import { resolvePeerWorkspace } from './workspace.js'
import { appendChatLog, CHATLOG_DIR, UNAUTHORIZED_LOG_DIR } from './chatlog.js'
import { mkdir, writeFile, readdir, unlink, appendFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 插件自带的 ASR 脚本；配置里没写 asrScript 时用它。 */
const DEFAULT_ASR_SCRIPT = fileURLToPath(new URL('../tools/asr.py', import.meta.url))

/**
 * 跑一次离线 ASR：python asr.py <wav> [model] → {ok, text}
 * 任何异常都吞掉返回空串，绝不让语音把主链路拖死。
 */
function runAsr(config, wavPath) {
  return new Promise((resolve) => {
    const py = config.asrPython || 'python'
    const script = config.asrScript || DEFAULT_ASR_SCRIPT
    if (!script) return resolve('')
    const model = String(config.asrModel ?? '').trim()
    let out = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    let child
    try {
      child = spawn(py, model ? [script, wavPath, model] : [script, wavPath], { windowsHide: true })
    } catch {
      return resolve('')
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish('')
    }, Number(config.asrTimeoutMs) || 60000)
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8')
    })
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      finish('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const line = out.trim().split('\n').filter(Boolean).pop() || ''
        const json = JSON.parse(line)
        finish(json.ok ? String(json.text || '') : '')
      } catch {
        finish('')
      }
    })
  })
}

function allowPrivate(config, userId) {
  if (!config.replyToPrivate) return false
  if (config.privateMode === 'disabled') return false
  if (config.privateMode === 'allowlist') {
    return (config.privateAllow ?? []).map(String).includes(String(userId))
  }
  return true
}

function allowGroup(config, groupId) {
  if (config.groupMode === 'disabled') return false
  if (config.groupMode === 'allowlist') {
    return (config.groupAllow ?? []).map(String).includes(String(groupId))
  }
  return true
}

/**
 * 「@ 之后保活」：有人在群里 @ 过它一次之后，接下来一小段时间里不用每条都 @ 也能接话。
 * 真人在群里也是这样的——被点到名之后，后续那几句话自然会跟着说。
 *
 * 2026-10-24：窗口键从「群号」改成「群号 + 人」。原来按群记，只要有人 @ 一次，
 * 45 秒内群里任何人说话都算数——别人 @ 另一个人、或者跟别人聊天，它也会冲上去接。
 * QLark（src/qlark/chat/keepalive.py）把窗口键做成 (会话, 用户) 元组，注释写得很清楚：
 * 「别人说话既不能续期，也不能蹭用你的窗口」。咱们照抄这一条。
 *
 * 纯内存 Map，进程重启就清空，不落盘。
 */
const groupWakeUntil = new Map()

/** 每个保活窗口里已经回了几次（键同窗口：群:人）。
 *  用户 2026-10-24 转述群友的设计：「@ 之后保活一分钟，发消息刷新保活时间，
 *  群友在限定时间内均匀的拆成固定回几次」—— 光有窗口没有次数上限，就是一被点亮就
 *  每句都插嘴；次数上限让它「均匀地回应几次」而不是复读机。
 *  注意：这条和「窗口内说话续期」会打架（窗口一直续着、额度却固定），默认 0 = 不限。 */
const groupReplies = new Map()

/** 每个「群:人」上次回复的时间。用来做「均匀回应」：两条回复之间至少隔 groupReplyGapMs，
 *  间隔里来的消息不丢，攒进 backlog 等下一次一起看见 —— 比「一个窗口只准回 N 次」温和，
 *  也不会跟「窗口内说话续期」打架（用户 2026-10-24 发现的冲突）。 */
const groupLastReplyAt = new Map()

/** 被 groupReplyGapMs 压住的消息：到点自己醒一次。
 *  没有它，「攒着」就是永久沉默 —— 2026-10-25 群 123456789 实况：
 *  @ 回过一句、下一句在 20 秒内被压进 backlog，姐姐不再开口，就再没动静。 */
const gapReplayTimers = new Map()

/** 距上次回复够不够久。0/负数 = 不限，永远够。 */
function gapReady(config, groupId, userId) {
  const gap = Number(config.groupReplyGapMs) || 0
  if (gap <= 0) return true
  const last = groupLastReplyAt.get(wakeKey(groupId, userId)) ?? 0
  return Date.now() - last >= gap
}

/** 这条消息是不是「同类」（群里另一个机器人）发的。
 *  两条判断：`sender.is_robot`（NapCat 对群机器人会带，但不是每只都带），
 *  以及配置里的 `peerBots` 名单（QQ 号）——名单最可靠，兜底。 */
function isPeerBot(config, senderId, event) {
  const id = String(senderId ?? '')
  if (!id) return false
  if ((config?.peerBots ?? []).map(String).includes(id)) return true
  return event?.sender?.is_robot === true
}

/** 保活窗口的键：群 + 人。别人 @ 我，不该给群里其他人开窗。 */
function wakeKey(groupId, userId) {
  return `${groupId}:${userId}`
}

function wakeAlive(groupId, userId) {
  const until = groupWakeUntil.get(wakeKey(groupId, userId)) ?? 0
  return until > Date.now()
}

/** 每个人上一条消息的时间：判断「连着聊」还是「人已经走开了」。
 *  2026-10-25 姐姐定的：窗里说话跟上一条隔得比 groupWakeIdleMs 久，窗就当场关 ——
 *  不然群里隔三四十秒插一句也会一直续着，「被 @ 了就停不下来」。 */
const groupLastMsgAt = new Map()

/** 距这个人上一条消息超过续期门槛了没（0 = 关掉这个门槛，永远不算超）。 */
function wakeIdleExceeded(config, groupId, userId) {
  const idleMs = Number(config.groupWakeIdleMs) || 0
  if (idleMs <= 0) return false
  const last = groupLastMsgAt.get(wakeKey(groupId, userId)) ?? 0
  if (!last) return false
  return Date.now() - last > idleMs
}

/** 当场关窗：人已经停下来了，别再等着接下一句。 */
function closeWake(groupId, userId) {
  const key = wakeKey(groupId, userId)
  groupWakeUntil.delete(key)
  groupReplies.delete(key)
}

function refreshWake(config, groupId, userId) {
  const key = wakeKey(groupId, userId)
  const ms = Number(config.groupWakeMs) || 0
  if (ms <= 0) {
    groupWakeUntil.delete(key)
    groupReplies.delete(key)
    return
  }
  const now = Date.now()
  const isNewWindow = (groupWakeUntil.get(key) ?? 0) <= now
  if (isNewWindow) groupReplies.set(key, { startedAt: now, count: 0 })
  groupWakeUntil.set(key, now + ms)
  // 顺手清掉过期的，别让 Map 越攒越大
  if (groupWakeUntil.size > 200) {
    for (const [k, v] of groupWakeUntil) {
      if (v <= now) {
        groupWakeUntil.delete(k)
        groupReplies.delete(k)
      }
    }
  }
}

/** 这个窗口里还剩几次回复额度（0 = 不限）。用户 2026-10-24 转述群友方案：
 *  「@ 之后保活一分钟…群友在限定时间内均匀的拆成固定回几次」—— 别一被点亮就连珠炮。 */
function repliesLeft(config, groupId, userId) {
  const max = Number(config.groupRepliesPerWindow) || 0
  if (max <= 0) return Infinity
  const rs = groupReplies.get(wakeKey(groupId, userId))
  if (!rs) return max
  if ((groupWakeUntil.get(wakeKey(groupId, userId)) ?? 0) <= Date.now()) return max
  return Math.max(0, max - rs.count)
}

function countReply(groupId, userId) {
  const key = wakeKey(groupId, userId)
  const rs = groupReplies.get(key)
  if (rs) rs.count += 1
  else groupReplies.set(key, { startedAt: Date.now(), count: 1 })
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 一天里的大概时段，用来说「下午/晚上」时不用模型自己换算。 */
function periodOf(hour) {
  if (hour < 5) return '凌晨'
  if (hour < 8) return '早上'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '晚上'
  return '深夜'
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地时区的今天 YYYY-MM-DD。
 *  ⚠️ 别用 `toISOString().slice(0,10)` —— 那是 UTC，+08 时区凌晨 0–8 点会算成昨天。 */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 人话时间（完整版）：2026-10-24 周六 13:05（下午）。
 *  直接给模型一句能照念的话，别让它拿 ISO 时间戳自己换算白天晚上。 */
function humanTime(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${periodOf(d.getHours())}）`
}

/** 历史行里的短时间：10-24 周六 13:05（下午）。一条消息只占一行，别太长。 */
function historyTime(d = new Date()) {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${periodOf(d.getHours())}）`
}

/** 群聊里把一条消息压成一行，进历史缓冲。带时间 —— 模型才知道「隔了两小时才回」。
 *  sender 在 ownerIds 里时额外标上主人称呼，Agent 才分得清自己人和群友。
 *  isSelf=true 时写成「你（机器人名）」—— 自己发出去的话也必须进历史，
 *  否则它看不到自己说过什么，群里另一个口吻相近的机器人一说话，就会被认领成「我说的」。 */
/**
 * 这一轮「必须回」还是「可以沉默」。
 *
 * - 私聊、补发（replay）：必须回 —— 那是冲它来的正经话，别装死。
 * - 群里被 @ / 被引用 / 被叫名字点名（addressedBy）：默认必须回；
 *   2026-10-27 姐姐定「群里主动 @ 一直不开」，`addressedMaySilent` 打开后
 *   被叫照样叫得醒（消息进上下文、能看能开口），但回不回它自己定。
 * - 群里没被叫（概率唤醒 / 保活窗路过）：可以沉默。
 */
export function mustReplyFor({
  isGroup,
  atMe = false,
  quotedMe = false,
  isReplay = false,
  addressedBy = null,
  addressedMaySilent = false,
} = {}) {
  if (!isGroup || isReplay) return true
  const addressed = Boolean(atMe || quotedMe || addressedBy)
  return addressed && addressedMaySilent !== true
}

export function historyLine(sender, text, { isOwner = false, ownerLabel = '主人', isSelf = false, selfName = '机器人', isBot = false } = {}) {
  if (isSelf) return `[你（${selfName || '机器人'}） ${historyTime()}] ${text}`
  const name = sender?.card || sender?.nickname || String(sender?.user_id ?? '')
  // 同类机器人单独标一下：不标的话，它跟群友的话在历史里长得一样，
  // 「这句是在跟我说，还是跟它说」就永远分不清（用户 2026-10-24 的原话）。
  const tag = isOwner ? ` · ${ownerLabel}` : isBot ? ' · 同类机器人' : ''
  return `[${name} (${sender?.user_id ?? ''})${tag} ${historyTime()}] ${text}`
}

/** 往会话历史里塞一条，顺手按 historyLimit 截断（留两倍余量给「我」和「别人」混排）。 */
export function pushHistory(record, entry, limit) {
  if (!record || !entry) return
  if (!Array.isArray(record.history)) record.history = []
  record.history.push(entry)
  const keep = Math.max(0, Number(limit) || 0) * 2
  if (keep > 0 && record.history.length > keep) {
    record.history.splice(0, record.history.length - keep)
  }
}

/**
 * 没叫我们的群消息也留个底，等下次真接的时候补进上下文。
 *
 * 2026-10-24 实况：群友 A 说了个梗，这句没 @ 我们 → 直接 return 掉；
 * 两分钟后群友 B 接了这个梗 → 它却顺着 B 那句话编，因为它根本不知道梗是谁说的、什么意思。
 * 跳过归跳过（不叫醒它），但这些话得让它看得见 —— 不然接话全靠猜。
 */
const groupBacklog = new Map()
const BACKLOG_MAX = 30

export function keepBacklog(groupId, entry) {
  if (!groupId || !entry) return
  const arr = groupBacklog.get(groupId) ?? []
  arr.push(entry)
  if (arr.length > BACKLOG_MAX) arr.splice(0, arr.length - BACKLOG_MAX)
  groupBacklog.set(groupId, arr)
}

/** 取走并清空：补进上下文一次就够，别每次都倒一遍陈年旧账。 */
export function drainBacklog(groupId) {
  const arr = groupBacklog.get(groupId) ?? []
  groupBacklog.delete(groupId)
  return arr
}

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

function guessExt(url, mime) {
  const byMime = EXT_BY_MIME[mime]
  if (byMime) return byMime
  const fromUrl = extname(new URL(url, 'http://x').pathname || '').toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(fromUrl) ? fromUrl : '.png'
}

const FORWARD_MAX_ITEMS = 30
const FORWARD_MAX_CHARS = 2000

/**
 * 合并转发（群里那张「聊天记录」卡片）展开成纯文本。
 *
 * OneBot 的 forward 段只带一个 id，内容要另外调 get_forward_msg 取。
 * 不展开的话，agent 在群里只看得见「[合并转发]」四个字——等于那段话没说过。
 * 取不到就如实标出来，别装成看见了。
 */
export async function expandForwards(client, forwards, { logger } = {}) {
  if (!Array.isArray(forwards) || forwards.length === 0) return ''
  const out = []

  for (const f of forwards) {
    if (!f?.id) {
      out.push('[合并转发·拿不到 id]')
      continue
    }

    let res
    try {
      // NapCat 认 message_id，标准 OneBot 写 id——两个都递过去，谁认谁接
      res = await client.call('get_forward_msg', { message_id: f.id, id: f.id })
    } catch (err) {
      logger?.debug?.(`[dsh-qq] 合并转发取不到（${f.id}）：${err?.message || err}`)
      out.push('[合并转发·展开失败]')
      continue
    }

    const list = Array.isArray(res?.messages) ? res.messages : res?.message ? [res] : []
    if (list.length === 0) {
      out.push('[合并转发·空的]')
      continue
    }

    const lines = []
    let used = 0
    for (const item of list) {
      if (lines.length >= FORWARD_MAX_ITEMS || used >= FORWARD_MAX_CHARS) {
        lines.push(`…（还差 ${list.length - lines.length} 条没放进来，太长了）`)
        break
      }
      const who = String(item?.sender?.card || item?.sender?.nickname || item?.sender?.user_id || '?')
      const body = readMessage(item?.message, {}).text || '[无文字]'
      const line = `${who}：${body}`
      used += line.length
      lines.push(line)
    }
    out.push(`[合并转发 ${list.length} 条]\n${lines.join('\n')}`)
  }

  return out.join('\n')
}

/**
 * 下载一张图到本地缓存，返回绝对路径；失败返回 null。
 * 只接受 http(s) 和 base64:// 两种来源。
 *
 * export 出去是因为 `qq_images`（tools.js）也要用同一条下载路径：
 * 按消息 id 现取图的时候，落到跟收消息一样的缓存目录里，用完能一起被清。
 */
export async function downloadImage(url, cacheDir, maxMB) {
  try {
    if (!url) return null

    // base64:// 直接落盘
    if (url.startsWith('base64://')) {
      const buf = Buffer.from(url.slice('base64://'.length), 'base64')
      if (buf.length > maxMB * 1024 * 1024) return null
      const p = join(cacheDir, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
      await writeFile(p, buf)
      return p
    }

    if (!/^https?:\/\//i.test(url)) return null

    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxMB * 1024 * 1024) return null

    const ext = guessExt(url, res.headers.get('content-type') ?? '')
    const p = join(cacheDir, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    await writeFile(p, buf)
    return p
  } catch {
    return null
  }
}

/** 清掉缓存里太老的图，避免堆成垃圾场。 */
async function pruneCache(cacheDir, keepFiles = 200) {
  try {
    const names = (await readdir(cacheDir)).filter((n) => n.startsWith('qq-'))
    if (names.length <= keepFiles) return
    const stats = await Promise.all(
      names.slice(0, names.length - keepFiles).map(async (n) => {
        const p = join(cacheDir, n)
        try {
          const { stat } = await import('node:fs/promises')
          const s = await stat(p)
          return { p, mtime: s.mtimeMs }
        } catch {
          return null
        }
      }),
    )
    for (const item of stats.filter(Boolean).slice(0, 20)) {
      await unlink(item.p).catch(() => {})
    }
  } catch {
    /* 清缓存失败不影响主链路 */
  }
}

/**
 * 入站：OneBot 消息事件 → agent.followup()。
 *
 * 触发规则全部走配置，插件自己不做「猜你还想聊」这种自作聪明的事。
 */
export function createInbound({ config, manager, logger, client, send, approval, questions, contextGuard, wake, sleep, bridge, pin, memory, intentRouter }) {
  // 没配 imageCacheDir 时落在工作目录下的「图片缓存」；每个会话再各占一层子目录（见下）
  const baseCacheDir =
    String(config.imageCacheDir ?? '').trim() ||
    join(String(config.cwd ?? '').trim() || process.cwd(), '图片缓存')
  const maxMB = Number(config.imageMaxMB) || 8
  // 谁是主人：群聊里用 QQ 号打标，私聊不影响（私聊本来就在白名单里）
  const ownerIds = new Set((Array.isArray(config.ownerIds) ? config.ownerIds : []).map(String))
  const ownerLabel = String(config.ownerLabel ?? '').trim() || '主人'

  // 连发合并：同一个 peer 的几条消息攒在一起回。
  // 键是「谁发的」，值是正在等的这一批（bodies 是各自已经拼好的正文）。
  const mergeBatches = new Map()

  /**
   * 投递一轮。单条消息和「连发合并」后的整段，走的是同一条路。
   */
  function runTurn({ record, label, peerId, isGroup, client, body, maxTurnMs }) {
    const message = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' },
    })
    const startedAt = Date.now()

    manager.enqueue(record, async () => {
      let timer = null
      try {
        // 意图路由：只决定这一轮用哪个模型，失败不影响正常投递
        try {
          logger.info?.(
            `[intent] 进入路由 label=${label} bodyLen=${String(body ?? '').length} ` +
              `hasAgent=${Boolean(record?.agent)} hasCtx=${Boolean(record?.agent?.ctx)} ` +
              `router=${Boolean(intentRouter?.route)}`,
          )
          intentRouter?.route?.(record, body, { isGroup })
        } catch (err) {
          logger.warn?.(`[intent] 路由失败，本轮按云端走：${err?.message ?? err}`)
        }
        // 私聊回一句「正在输入」，让对方知道这边在敲字（群聊没有这个概念，跳过）
        if (!isGroup && client) {
          client
            .call('set_input_status', { user_id: Number(peerId), event_type: 1 }, 5000)
            .catch(() => {})
        }
        record.agent.followup(message)

        const outcome = await Promise.race([
          Promise.resolve(record.agent.whenIdle?.()).then(() => 'idle'),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('timeout'), maxTurnMs)
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })

        if (outcome === 'timeout') {
          // 只放开队列，不打断 Agent —— 它跑完的回复照样会从 outbound 发出去
          const seconds = Math.round((Date.now() - startedAt) / 1000)
          logger.warn(`[dsh-qq] ${label} 本轮已跑 ${seconds}s 仍未结束，先放开队列`)
          if (typeof send === 'function') {
            await send(
              record,
              `（这轮我还在弄，已经跑了 ${seconds} 秒，你先忙别的，好了我叫你）`,
            ).catch(() => {})
          }
        }
      } catch (err) {
        logger.warn?.(`[dsh-qq] 投递给 ${label} 失败:`, err)
      }
    })
  }

  /**
   * 好友请求：NapCat 的事件长这样
   *   { post_type:'request', request_type:'friend', user_id, comment, flag }
   * 以前靠外挂一个 ws 监听脚本接；现在插件自己接，少一个常驻进程。
   * 默认 off —— 不擅自替主人加人；开了才按 open / allowlist 处理。
   */
  async function handleFriendRequest(event) {
    const uid = String(event.user_id ?? '')
    if (!uid) return
    const mode = config.friendRequestMode ?? 'off'
    if (mode === 'off') {
      logger.info?.(`[dsh-qq] 收到好友请求 ${uid}（friendRequestMode=off，不处理）`)
      return
    }
    const allow = (config.friendRequestAllow ?? []).map(String)
    const approve = mode === 'open' || allow.includes(uid)
    if (mode === 'allowlist' && !approve) {
      logger.info?.(`[dsh-qq] 好友请求 ${uid} 不在 friendRequestAllow，跳过`)
      return
    }
    const nickname = String(event.sender?.nickname ?? event.nickname ?? '')
    try {
      await client.call('set_friend_add_request', { flag: event.flag, approve })
      logger.info?.(`[dsh-qq] 好友请求 ${uid}(${nickname || '无昵称'}) 已${approve ? '通过' : '拒绝'}`)
    } catch (err) {
      logger.warn?.(`[dsh-qq] 处理好友请求 ${uid} 失败: ${err?.message || err}`)
      return
    }
    if (!approve) return

    // 记一条流水，事后能查「什么时候谁加的我」（qq_list_friend_requests 也读它）
    try {
      const root = config.workspaceRoot || join(process.cwd(), '会话')
      await mkdir(root, { recursive: true })
      const line =
        JSON.stringify({
          at: new Date().toISOString(),
          userId: uid,
          nickname,
          comment: String(event.comment ?? ''),
          approved: true,
        }) + '\n'
      await appendFile(join(root, 'friend-requests.jsonl'), line, 'utf8')
    } catch (err) {
      logger.debug?.(`[dsh-qq] 记好友请求流水失败: ${err?.message || err}`)
    }

    // 知会主人：从老大那边看，就是「阿团自己加了个好友」
    if (config.friendRequestNotify !== false) {
      const to = (config.ownerIds ?? []).map(String).filter(Boolean)[0]
      if (to) {
        try {
          const who = nickname ? `${nickname}(${uid})` : uid
          const comment = String(event.comment ?? '').trim()
          await client.call('send_private_msg', {
            user_id: Number(to),
            message: `刚有人加我好友：${who}${comment ? `，留言「${comment}」` : ''}。已经自动通过，跟你说一声。`,
          })
        } catch (err) {
          logger.debug?.(`[dsh-qq] 好友请求知会失败: ${err?.message || err}`)
        }
      }
    }
  }

  return async function onEvent(event) {
    // 加好友 / 群邀请都是 post_type='request'；只接加好友，群邀请一概不理
    if (event?.post_type === 'request') {
      if (event.request_type === 'friend') {
        try {
          await handleFriendRequest(event)
        } catch (err) {
          logger.warn?.(`[dsh-qq] 好友请求处理异常: ${err?.message || err}`)
        }
      }
      return
    }
    if (event?.post_type !== 'message') return
    // 补回：这条是「被间隔压住、到点自己醒过来」的重放，不是新消息。
    // 重放要跳过所有前置闸（@/保活/间隔/额度），否则又会被压一轮，永远出不来。
    const isReplay = event?.__replay === true

    // 到点自己醒一次：间隔一过就把压住的那句补回去（否则就是永久沉默）。
    const scheduleGapReplay = (evt, gid, uid) => {
      const key = wakeKey(gid, uid)
      const gap = Number(config.groupReplyGapMs) || 0
      const last = groupLastReplyAt.get(key) ?? 0
      const wait = Math.max(800, gap - (Date.now() - last) + 400)
      const prev = gapReplayTimers.get(key)
      if (prev) clearTimeout(prev)
      const timer = setTimeout(() => {
        gapReplayTimers.delete(key)
        // 这期间要是有新消息把 backlog 取走了，重放自己会 no-op（拿不到正文）。
        Promise.resolve(onEvent({ ...evt, __replay: true })).catch((err) => {
          logger.debug?.(`[dsh-qq] 补回被压住的消息失败: ${err?.message || err}`)
        })
      }, wait)
      timer.unref?.()
      gapReplayTimers.set(key, timer)
    }

    const selfId = String(event.self_id ?? manager.selfId ?? '')
    if (event.self_name) manager.selfName = String(event.self_name)
    if (event.user_id !== undefined && String(event.user_id) === selfId) return

    const isGroup = event.message_type === 'group'
    const scope = isGroup ? 'group' : 'private'
    const peerId = String(isGroup ? event.group_id : event.user_id)
    const sender = event.sender ?? {}
    const senderName = sender.card || sender.nickname || peerId
    const label = isGroup ? `群 ${peerId}` : `私聊 ${senderName}(${peerId})`
    const ownerInfo = { isOwner: ownerIds.has(String(event.user_id ?? '')), ownerLabel }
    const peerBot = isGroup && isPeerBot(config, event.user_id, event)
    if (peerBot) ownerInfo.isBot = true

    const allowed = isGroup ? allowGroup(config, peerId) : allowPrivate(config, peerId)
    const info = readMessage(event.message, { selfId, selfName: event.self_name ?? '机器人' })

    // 合并转发：卡片里的内容真的取出来，摆进正文，别只留一个「[合并转发]」。
    // 取不到就保留占位——至少让人知道这里本来有东西。
    if (info.forwards.length > 0) {
      const expanded = await expandForwards(client, info.forwards, { logger })
      if (expanded) info.text = info.text ? `${info.text}\n${expanded}` : expanded
    }

    // 聊天流水：跳过的消息也先记下来——「它怎么突然接不上话」全靠这段回查。
    // 只落盘、不参与投递，写失败也不影响聊天。
    // 白名单外的落到 `聊天记录/_未开通/`（2026-10-26 姐姐定的）：留痕，不投递。
    if (config.chatLog !== false) {
      const logDir = resolvePeerWorkspace(config, scope, peerId)
      const who = `${senderName}(${event.user_id})`
      appendChatLog(
        logDir,
        { who, text: info.text || '[图片]', msgId: event.message_id },
        logger,
        allowed ? undefined : join(CHATLOG_DIR, UNAUTHORIZED_LOG_DIR),
      ).catch(() => {})
    }

    if (!allowed) {
      logger.debug?.(`[dsh-qq] 忽略未授权 ${label}`)
      return
    }

    // 纯图 / 纯语音 / 纯文件 / 纯表情包（没有文字）也要处理
    if (
      !info.text &&
      info.images.length === 0 &&
      info.records.length === 0 &&
      info.files.length === 0 &&
      info.mfaces.length === 0
    ) {
      return
    }

    const senderId = String(event.user_id ?? '')

    // 先用「上一条的时间」判断停没停，再把这条记进去 —— 连着聊才续期。
    const idleExceeded = isGroup && wakeIdleExceeded(config, peerId, senderId)
    if (isGroup) groupLastMsgAt.set(wakeKey(peerId, senderId), Date.now())

    // ── 引用：先查一次「这句在接谁的话」。
    // 一次 get_msg 同时干两件事：判断这条是不是在跟我说话（下面），以及给正文加引用提示（再下面）。
    // 只有真带引用才发请求，群里引用不常见，不会拖慢平时。
    let quoteInfo = null
    if (info.replyId && client) {
      try {
        const quoted = await client.call('get_msg', { message_id: Number(info.replyId) }, 8000)
        const quotedUserId = String(quoted?.sender?.user_id ?? '')
        const quotedName =
          quoted?.sender?.card || quoted?.sender?.nickname || quotedUserId || '某人'
        const quotedInfo = readMessage(quoted?.message, {
          selfId,
          selfName: event.self_name ?? '机器人',
        })
        quoteInfo = {
          userId: quotedUserId,
          name: quotedName,
          text: (quotedInfo.text || '[非文字内容]').replace(/\s+/g, ' ').slice(0, 80),
          ok: true,
        }
      } catch (err) {
        logger.debug?.(`[dsh-qq] 取引用原文失败: ${err?.message || err}`)
        // 取不到就当没有引用：不知道该接谁的话，宁可不接，也别猜。
        quoteInfo = { userId: '', name: '', text: '', ok: false }
      }
    }
    // 引用的是我自己 → 等于在叫我（qq-bridge 的 quoteTargetIsSelf）
    const quotedMe = Boolean(quoteInfo?.ok && quoteInfo.userId && quoteInfo.userId === selfId)

    // 记忆卡：把这条（以及接下来被过滤掉不回的群消息）也记进 inbox，维护时再消化。
    //    只追加一行 JSON，便宜；真正摄取/衰减/压缩交给 10 分钟一次的 maintain。
    if (memory?.addInbox && info.text) {
      try {
        memory.addInbox({
          kind: isGroup ? 'group' : 'private',
          sender: senderName,
          senderId,
          groupId: isGroup ? peerId : '',
          isOwner: ownerInfo.isOwner,
          isSelf: false,
          conversationKey: `${scope}:${peerId}`,
          private: !isGroup,
          direct: Boolean(quotedMe || ownerInfo.isOwner),
          quoteSelf: quotedMe,
          text: info.text,
        })
      } catch {
        /* 记忆是加分项，写不进去不影响聊天 */
      }
    }

    // 补回时：这一句自己还躺在 backlog 里，先摘掉，免得同一句在上下文里出现两次。
    // 按「结尾正文」匹配，不按整行 —— 行首带秒级时间戳，重放时早就对不上了。
    if (isReplay) {
      const myText = `] ${info.text || '[图片]'}`
      const arr = drainBacklog(peerId)
      const idx = arr.findLastIndex((line) => line.endsWith(myText))
      if (idx >= 0) arr.splice(idx, 1)
      for (const line of arr) keepBacklog(peerId, line)
    }

    // 同类机器人（群里另一个机器人）：开关关着就完全不接，连 @ 也不接。
    // 用户 2026-10-24：「吵架功能单独做个开关，这个开关控制它要不要和同类聊天，以及对比较冲的同类回怼」。
    // 关着的时候它说什么都跟我们无关 —— 同类之间的帐先不算。
    if (peerBot && !config.botChatEnabled) {
      logger.debug?.(`[dsh-qq] 群 ${peerId} 是同类机器人发言，「和同类聊天」没开，跳过`)
      // 不接它的话，但它说了什么得留下 —— 下次真接的时候，得知道它刚讲过什么。
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
      return
    }

    // 群聊：默认要 @ 才理；@ 过一次之后有一小段「保活期」，不用再 @
    // addressedBy：没 @ 但被「叫名字 / 点名提问 / 关键词」叫住的理由（2026-10-25）。
    // 这种算「有人冲它来了」，必须回，不给 [SILENT] 出口。
    let addressedBy = null
    if (isGroup && config.requireMention && !info.atMe && !isReplay) {
      // 没 @ 我、却 @ 了别人（包括群里另一个机器人）：那明显不是跟我说话，
      // 保活期也不算 —— 否则别人一句「@ 那个谁 来帮我测一下」它也会冲上去接。
      if (info.atNames.length > 0) {
        logger.debug?.(`[dsh-qq] 群 ${peerId} @ 的是别人，跳过`)
        keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
        return
      }

      // ── 非 @ 叫醒（学 qq-bridge 的 evaluateWakeTriggerV2）──
      // 「@」只是叫人的一种方式：群里叫名字、点名问它、催一句「在不在」，
      // 都是在叫它，不该因为少个 @ 就装没听见。
      // 只拿本条消息自己的文字判，不拿带引用原文的拼接文本 —— 否则引用一条
      // 恰好提到昵称的旧消息，也会被当成在叫它。
      addressedBy = evaluateWakeTrigger({
        plainText: info.text || '',
        atMe: info.atMe,
        quotedMe,
        names: [manager.selfName, event?.self_name, ...(config.groupWakeNames ?? [])].filter(Boolean),
        triggers: {
          nameMention: config.groupWakeNameMention,
          question: config.groupWakeQuestion,
          keywords: config.groupWakeKeywords,
        },
      })
      if (addressedBy) {
        logger.debug?.(`[dsh-qq] 群 ${peerId} 没 @ 但命中 ${addressedBy}，按叫我处理`)
      }

      // 保活窗口只认「当初 @ 我的那个人」：别人说话既不能续期、也不能蹭用。
      // 2026-10-24 取消了「主人永久免 @」—— 试完反馈「只回我确实看着怪」：
      // 群友要 @ 才理，主人却随时都接，一是不公平，二是「唤醒一次后超时也没停」。
      // 现在主人也走窗口，只是窗口是 60 秒（群友提的方案），窗口内说话照样续期。
      if (!quotedMe && !addressedBy) {
        // 停太久：窗里也当没窗了 —— 「5 秒内没接话就关」（2026-10-25 姐姐定）。
        if (idleExceeded) {
          closeWake(peerId, senderId)
          logger.debug?.(`[dsh-qq] 群 ${peerId} 保活窗里停太久（>${config.groupWakeIdleMs}ms），窗关掉，跳过`)
          keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
          return
        }
        if (!wakeAlive(peerId, senderId)) {
          // 概率唤醒：没人叫它，但有很小概率顺带看一眼。
          // 这种「路过」不强制回 —— 下面 mustReply 会是 false，自动带上 [SILENT] 出口。
          if (rollWakeProbability(config.groupWakeProbability)) {
            logger.debug?.(
              `[dsh-qq] 群 ${peerId} 概率唤醒（${config.groupWakeProbability}），顺带看一眼`,
            )
          } else {
            logger.debug?.(`[dsh-qq] 群 ${peerId} 未 @ 且不在保活期，跳过`)
            // 这句没叫我们，但它是上下文的一部分：下一句很可能就在接它。
            keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
            return
          }
        }
      }
      if (quotedMe) logger.debug?.(`[dsh-qq] 群 ${peerId} 引用了我，按叫我处理`)
    }
    // 窗口续期（QLark 的 touch()）：@ 我、引用我、或者本来就在窗口里接着说话，都续上。
    // 但只有窗口的「正主」能续 —— 别人说话不续期也不蹭用，这条一松就变成群里谁说话都接。
    if (isGroup && (info.atMe || quotedMe || addressedBy || wakeAlive(peerId, senderId))) {
      refreshWake(config, peerId, senderId)
    }

    // 均匀回应：距上次回复太近就先攒着（消息进 backlog，下次一起看见），别连珠炮。
    // 但「攒着」得有兜底：间隔一过就自己醒一次，不然这句就永远躺在 backlog 里。
    if (isGroup && !isReplay && !gapReady(config, peerId, senderId)) {
      logger.debug?.(
        `[dsh-qq] 群 ${peerId} 距上次回复不到 ${config.groupReplyGapMs}ms，先攒着（到点补回）`,
      )
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
      scheduleGapReplay(event, peerId, senderId)
      return
    }

    // 窗口内回复额度（可选，默认 0 = 不限；和「续期」一起用要注意，别设太小）
    if (isGroup && !isReplay && repliesLeft(config, peerId, senderId) <= 0) {
      logger.debug?.(
        `[dsh-qq] 群 ${peerId} 这个保活窗口已经回过 ${config.groupRepliesPerWindow} 次，先歇着`,
      )
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
      return
    }

    let record = await manager.obtain({ scope, peerId, label })
    // 有人说话了：冷场计时要清零，主动说话那层也知道「这会儿不缺人」
    wake?.noteInbound?.(record)

    // 这个会话自己的缓存目录（隔离模式下一会话一目录；关掉隔离就共用 baseCacheDir）
    const cacheDir = record.dir ? join(record.dir, '图片缓存') : baseCacheDir

    // ── 先看这句是不是在回答一条待审批的请求；是的话就吃掉，不投给 Agent ──
    const rawText = (info.text || '').trim()
    if (rawText && approval?.tryResolve?.(record, rawText)) {
      logger.info?.(`[dsh-qq] 已消化审批回复 ${label}`)
      return
    }

    // ── 再看是不是在回答一条待答的问题 ──
    if (rawText && questions?.tryResolve?.(record, rawText)) {
      logger.info?.(`[dsh-qq] 已消化问答回复 ${label}`)
      return
    }

    // ── 斜杠命令不打搅 Agent（全角斜杠「／」、前后空格都认）──
    const cmd = rawText.toLowerCase().replace(/[／]/g, '/').trim()
    if (cmd === '/reset' || cmd === '#reset' || cmd === '/new' || cmd === '#new') {
      // ⭐ 2026-10-25 P2：/reset 也带上交接，别让「重新来过」真把刚才聊的忘干净。
      const handoff = loadHandoffFor(record)
      const seed = handoff
        ? ['[这是你刚才自己留的便签（不是姐姐说的话）——接着聊就行，不用从头解释]', handoff]
        : null
      const ok = manager.reset(record, seed)
      logger.info?.(`[dsh-qq] 收到 /reset（${label}），reset=${ok}，交接=${handoff ? '有' : '无'}`)
      await send(record, handoff ? '好，刚才聊到哪我记下了。重新来过吧。' : '好，之前聊的我不记得了。重新来过吧。')
      return
    }
    if (cmd === '/status' || cmd === '#status') {
      await send(
        record,
        [
          `会话：${record.label}`,
          `id：${record.sessionId}`,
          `群历史：${record.history.length} 条`,
          `我这边：${record.busy > 0 ? '还在忙' : '空闲'}`,
        ].join('\n'),
      )
      return
    }
    if (cmd === '/cwd' || cmd === '#cwd') {
      await send(
        record,
        [`id：${record.sessionId}`, `目录：${record.dir || '(未隔离，仍用公共 cwd)'}`, `群历史：${record.history.length} 条`].join(
          '\n',
        ),
      )
      return
    }
    if (cmd === '/help' || cmd === '#help') {
      await send(
        record,
        [
          '能用的命令：',
          '/reset 清空上下文重新开始',
          '/status 看看当前会话',
          '/cwd 看这个会话的目录',
          '/help 就是这份说明',
        ].join('\n'),
      )
      return
    }

    // 给互动工具留线索：戳谁、给哪条消息贴表情、撤回哪条
    record.lastSenderId = Number(event.user_id) || record.lastSenderId || null
    record.lastSenderName = senderName
    record.lastMessageId = Number(event.message_id) || record.lastMessageId || null
    record.lastMessageAt = Date.now()
    if (record.lastSenderName) record.label = label

    // ── 图片：下载到本地，把路径交给 agent ──
    let imagePaths = []
    if (info.images.length > 0) {
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      imagePaths = (await Promise.all(info.images.slice(0, 4).map((u) => downloadImage(u, cacheDir, maxMB)))).filter(Boolean)
      if (imagePaths.length > 0) pruneCache(cacheDir)
      else logger.warn?.(`[dsh-qq] 图片下载失败（${info.images.length} 张）`)
    }

    // ── 文件：下载到本地，把路径交给 agent ──
    let filePaths = []
    if (info.files.length > 0) {
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      for (const f of info.files.slice(0, 3)) {
        const src = f.url || f.file || ''
        if (!src) continue
        const p = await downloadImage(src, cacheDir, 64)
        if (p) filePaths.push({ path: p, name: f.name || p.split(/[\\/]/).pop() })
      }
      if (filePaths.length === 0) logger.warn?.(`[dsh-qq] 文件下载失败（${info.files.length} 个）`)
    }

    // ── 语音：转 wav → 本地 vosk 离线识别 ──
    let voiceTexts = []
    if (info.records.length > 0) {
      if (!config.asrEnabled) {
        voiceTexts.push('[语音]')
      } else {
        for (const rec of info.records.slice(0, 2)) {
          const file = rec.file || rec.path || ''
          if (!file) {
            voiceTexts.push('[语音，但拿不到文件]')
            continue
          }
          try {
            const res = await client.call('get_record', { file, out_format: 'wav' }, 20000)
            let wavPath = ''
            if (res?.file && /^[A-Za-z]:[\\/]/.test(String(res.file))) {
              wavPath = String(res.file)
            } else if (res?.base64) {
              await mkdir(cacheDir, { recursive: true }).catch(() => {})
              wavPath = join(cacheDir, `voice-${Date.now()}.wav`)
              await writeFile(wavPath, Buffer.from(String(res.base64), 'base64'))
            } else if (res?.url) {
              wavPath = (await downloadImage(String(res.url), cacheDir, 32)) || ''
            }
            if (!wavPath) {
              voiceTexts.push('[语音，转码失败]')
              continue
            }
            const text = await runAsr(config, wavPath)
            voiceTexts.push(text ? `[语音转文字] ${text}` : '[语音，没听清]')
          } catch (err) {
            logger.warn?.(`[dsh-qq] 语音识别失败: ${err?.message || err}`)
            voiceTexts.push('[语音，识别失败]')
          }
        }
      }
    }

    // ── 引用提示：让 agent 知道这句话在接谁的话（被引用的原文上面已经查过了，这里不再请求）──
    let quoteLine = ''
    if (info.replyId && config.quoteReply && client) {
      if (!quoteInfo || !quoteInfo.ok) {
        quoteLine = '[引用了一条消息，但没查到原文]'
      } else if (quoteInfo.userId === selfId) {
        quoteLine = `[引用 我自己：${quoteInfo.text}]`
      } else {
        quoteLine = `[引用 ${quoteInfo.name} (${quoteInfo.userId})：${quoteInfo.text}]`
      }
    }

    // ── 上下文压力太大就先换新会话：把最近聊天记进记忆区，新会话带 seed 接话 ──
    if (contextGuard) {
      const seed = await contextGuard.maybeSwap(record)
      if (seed) {
        const prev = record
        record = await manager.obtain({ scope, peerId, label })
        wake?.forget?.(prev)
        wake?.noteInbound?.(record)
        record.swapSeed = seed.length > 0 ? seed : null
        // 工具靠这些字段认「给谁回、撤回哪条」，换会话不能丢
        record.lastSenderId = prev.lastSenderId ?? null
        record.lastSenderName = prev.lastSenderName ?? null
        record.lastMessageId = prev.lastMessageId ?? null
        record.lastMessageAt = prev.lastMessageAt ?? null
      }
    }

    // ── 组装交给 agent 的那段文字 ──
    const parts = []
    // 当前时间：每条消息都带在最前面，跟着正文走 —— 会话压缩、历史被裁掉，这行也不会丢
    parts.push(`[现在是 ${humanTime()}]`)
    if (quoteLine) {
      parts.push(quoteLine, QUOTE_DIRECTION_HINT)
    }
    let head = info.text || ''
    if (isGroup) head = historyLine(sender, info.text || '[图片]', ownerInfo)
    else if (ownerInfo.isOwner && head) head = `[${ownerLabel}] ${head}`
    if (head) parts.push(head)

    // 群聊里没被 @、也不是引用着我的：给一个「可以不接」的出口。
    // 私聊、被 @、被引用回复这三种情况必须回，就不给出口 —— 该说话的时候别装死。
    // 2026-10-25 补：被叫名字 / 点名提问 / 关键词叫住的（addressedBy）也算被点名，同样必须回；
    // 只有「概率唤醒」那种路过看一眼的，才留 [SILENT] 出口。
    // 2026-10-27 姐姐定：群里「主动 @ 一直不开」——`addressedMaySilent` 打开后，
    // 被叫照样叫得醒（消息进上下文、能看能开口），但不再非答不可，回不回它自己定。
    // 规则本体在 mustReplyFor()，这里只负责把当前这一条的实况递进去。
    const mustReply = mustReplyFor({
      isGroup,
      atMe: info.atMe,
      quotedMe,
      isReplay,
      addressedBy,
      addressedMaySilent: config.addressedMaySilent,
    })
    if (!mustReply) parts.push(SILENT_HINT)

    if (imagePaths.length > 0) {
      parts.push(
        `[用户发了 ${imagePaths.length} 张图片，已存到本机，可以直接用 read_image 打开：]`,
        ...imagePaths.map((p) => `  ${p}`),
        IMAGE_RULES,
      )
      const hint = faceCollectRule(config)
      if (hint) parts.push(hint)
    } else if (info.images.length > 0) {
      parts.push('[用户发了图片，但没能下载下来]')
    }

    if (voiceTexts.length > 0) parts.push(...voiceTexts)

    if (info.mfaces.length > 0) {
      // 顺手把表情包的身份证存进收藏夹，以后 qq_mface 就能拿来用
      const added = rememberFaces(config, info.mfaces)
      const total = facesCount(config)
      parts.push(
        '[对方发来表情包。表情包是说话的语气，不是让你鉴赏的画面——顺着这个情绪接话就好，不要描述图里画了什么，也不要问"这是谁"。]',
      )
      if (added > 0) parts.push(`[已顺手收进表情包收藏，现在一共 ${total} 个；想发就用 qq_mface，不填 id 会从收藏里随机挑一个。]`)
    }

    if (filePaths.length > 0) {
      parts.push(
        `[用户发了 ${filePaths.length} 个文件，已存到本机：]`,
        ...filePaths.map((f) => `  ${f.name} -> ${f.path}`),
      )
    }

    // 之前跳过的群消息补进来（只说给它听，不叫醒它）：
    // 这一句是在接前一句，不补的话它只能凭空接。
    if (isGroup) {
      const backlog = drainBacklog(peerId)
      for (const line of backlog) pushHistory(record, line, config.historyLimit)
    }

    if (isGroup && config.historyLimit > 0 && record.history.length > 0) {
      const recent = record.history.slice(-config.historyLimit)
      parts.unshift(
        '[群聊最近消息]',
        ...recent.map((line) => line),
        '[群聊最近消息结束]',
      )
    }

    // 聊天规矩（内置中性版 + 可选 persona + directPrompt/groupPrompt）只在本会话第一次投递时
    // 注入一次，别每条都重复占 token；会话被回收或 /reset 后会重新注入一遍。
    if (!record.chatPromptInjected) {
      // 话头：它自己钉住的、还没接上的。**不每轮硬塞** —— 老三自己说的：「每轮开头硬塞五条，
      // 聊得正顺的时候反倒碍眼；真到换地方的时候，开头给一次就够。」平时想翻用 qq_pin list。
      const pinLines = pin?.view?.(record) ?? []
      if (pinLines.length > 0) parts.unshift(...pinLines, '')
      const chatPrompt = buildChatPrompt(config, {
        isGroup,
        isOwner: ownerInfo.isOwner,
        faces: facesForPrompt(config, 12),
        facts: loadFactsFor(record),
        factsFile: factsFileFor(record),
        // 群词典：这个群自己的黑话。私聊传空串，别把某个群的词带进私聊。
        glossary: isGroup ? loadGlossaryFor(record) : '',
        glossaryFile: glossaryFileFor(record),
        // 纸条：私聊时告诉她「别的群今天的尾巴」——最后谁说了话、有没有人点她名没应。
        //    群聊不传——她在那个群里，用不着有人替她讲。正文字一个字都不给。
        groupDigest: isGroup
          ? ''
          : loadGroupDigest({
              workspaceRoot:
                String(config.workspaceRoot ?? '').trim() ||
                join(String(config.cwd ?? '').trim() || process.cwd(), '会话'),
              today: localDay(),
              // 判断「哪条不是她发的」「有没有人 @ 她」，都要她自己的号
              selfId: String(config.selfId ?? '').trim(),
            }),
        // 记忆卡：角色自己的长期经历记忆（QQ 裁剪版，容量有上限）。
        memory: memory?.prompt?.() ?? '',
      })
      if (chatPrompt) parts.unshift(chatPrompt, '')
      // 主动换过会话：把上一段聊天的尾巴放最前面，让它知道刚聊到哪
      if (Array.isArray(record.swapSeed) && record.swapSeed.length > 0) {
        parts.unshift(
          '[你刚才自己留的便签 / 最近几句话——还是你，换了个地方接着聊，不是死了，是换个海洋接着游，不用从头解释]',
          ...record.swapSeed,
          '[刚才那段聊到这里]',
          '',
        )
      }
      record.swapSeed = null
      // ⭐ 2026-10-26 姐姐说「不能每次都发那么长一截」：标记也记到盘上。
      // 宿主重启 / 闲置回收后 record 重建，靠 manager 的账本记住「这个会话注过了」。
      if (typeof manager?.markChatPromptInjected === 'function') manager.markChatPromptInjected(record)
      else record.chatPromptInjected = true
    }

    // 错过睡前提醒的补刀：会话是有人说话才建的，23:30 那一刻内存里可能一个会话都没有，
    // tick 的提醒就白丢了。等真的有人说话时补一句，塞进这一轮的提示词里，不多开一轮。
    const lateBed = sleep?.takeLateBedtime?.(record)
    if (lateBed) parts.unshift(lateBed, '')

    // 通道回执：桥断过 / 上一句话没送出去，得让她知道。
    // 放在最前面 —— 不然她会把「没收到回应」读成对方的态度。
    const bridgeLines = bridge?.take?.(record) ?? []
    if (bridgeLines.length > 0) parts.unshift(...bridgeLines, '')

    // 门口：大姐鲸鲸捎的话。只报「有几封、在哪」，内容她自己 read 才看。
    // 2026-10-26 姐姐定的：不敲门、不占主动额度，只在她本来就要开口的这一轮里多一行。
    const doorNotice = doorLine(config)
    if (doorNotice) parts.unshift(doorNotice, '')

    const body = parts.join('\n')

    logger.info?.(`[dsh-qq] ← ${label}: ${(info.text || '[图片]').slice(0, 60)}`)

    // 先记历史（下一条能看到这一条），再投递
    const historyEntry = historyLine(sender, info.text || '[图片]', ownerInfo)
    if (isGroup) pushHistory(record, historyEntry, config.historyLimit)
    // 记一笔「这个窗口回过一次」，额度用完就停（见上面 repliesLeft）
    if (isGroup) {
      countReply(peerId, senderId)
      groupLastReplyAt.set(wakeKey(peerId, senderId), Date.now())
    }
    // 私聊也留一份最近聊天：换会话时靠它给新会话接话
    record.recent.push(historyEntry)
    const recentKeep = Math.max(80, (Number(config.contextMemoryKeep) || 30) * 3)
    if (record.recent.length > recentKeep) {
      record.recent.splice(0, record.recent.length - recentKeep)
    }

    const maxTurnMs = Number(config.maxTurnMs) || 600000
    const windowMs = Math.max(0, Number(config.mergeWindowMs ?? 5000))

    // 作息：休息时段（或在说了晚安之后）收到的私聊先记着，不回 —— 早上一起交出去。
    // 放在合并之前，因为「等待 5 秒」对一条要等到明早的消息没有意义。
    if (sleep?.shouldHold?.(record)) {
      sleep.hold(record, info.text || '[图片]')
      return
    }
    // 说了晚安：这条仍然正常回（得有人应一句），但之后不再回。
    sleep?.noteText?.(record, info.text || '')

    // 私聊连发：她一句一句发过来，别一条一条回（那样像接线员）。
    // 收下之后等一小会儿，期间再来就并进同一轮；窗口一过，整段一次性投递。
    if (windowMs > 0 && !isGroup) {
      const key = `${scope}:${peerId}`
      let batch = mergeBatches.get(key)
      if (!batch) {
        batch = { bodies: [], meta: null, timer: null }
        mergeBatches.set(key, batch)
      }
      batch.bodies.push(body)
      // 用最新的 record（上下文换过会话的话，投给新那个）
      batch.meta = { record, label, peerId, isGroup, client }
      if (batch.timer) clearTimeout(batch.timer)
      batch.timer = setTimeout(() => {
        mergeBatches.delete(key)
        const count = batch.bodies.length
        if (count > 1) logger.info?.(`[dsh-qq] ${label} 连发 ${count} 条，合并成一轮回`)
        runTurn({ ...batch.meta, body: batch.bodies.join('\n\n'), maxTurnMs })
      }, windowMs)
      return
    }

    runTurn({ record, label, peerId, isGroup, client, body, maxTurnMs })
  }
}
