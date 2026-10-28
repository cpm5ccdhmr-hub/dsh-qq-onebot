import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { proactiveRule } from './prompts.js'
import { doorLine } from './door.js'

/**
 * 主动说话（冷场冒泡）。
 *
 * 为什么要单独一层：inbound 是「来消息才动」的 —— 没人说话，它就永远不出声。
 * 这里补一个闹钟：会话安静够久、不在静默时段、今天还没说够，就往会话里投一句
 * 「可以主动开口了」。**说不说、说什么仍然由 Agent 自己决定**（不想说就 [SILENT]），
 * 这一层只负责「什么时候给它一次机会」，不替它说话。
 *
 * 防打扰四道闸（全部可配）：
 *   1. 静默时段      proactiveQuietHours（默认 23:00-08:00）
 *   2. 每天配额      proactiveMaxPerDay（默认 6 次／会话）
 *                    **只有真发出去才算一次**；她选 [SILENT] 只是白给一次机会，不扣额度
 *                    （2026-10-26：原来投递时就扣，沉默也扣 —— 她越克制额度烧得越快，
 *                      一天 10 次机会被 6 次沉默吃满，下午最该开口时机制已经哑了）
 *   3. 两次间隔      至少隔 1.5 倍冷场时长；**她自己开口说过话也重新起算**，
 *                    刚聊完不会被隔一会儿又问一次
 *   4. 投递失败就停  连着 3 次投递失败（不是「她选择不说」）才闭嘴 ——
 *                    [SILENT] 是她自己的决定，不该记账（2026-10-25 按她的原话改）
 *
 * 还有一个隐形前提：proactiveSilentMs 必须小于 sessionIdleTimeout。
 * 会话闲置满了是被回收的（agent 一起 dispose），回收之后这一层就够不着它了。
 */

const TICK_MS = 60_000
const FIRE_TIMEOUT_MS = 300_000
const MAX_SILENT_MISSES = 3

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 解析 "23:00-08:00"；格式不对就当没设（不限制）。 */
export function parseQuietHours(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*[-~～—]\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const toMin = (h, mi) => Math.min(23, Number(h)) * 60 + Math.min(59, Number(mi))
  return { from: toMin(m[1], m[2]), to: toMin(m[3], m[4]) }
}

/** 当前是否落在静默时段里；跨零点（23:00-08:00）也算。 */
export function inQuietHours(range, d = new Date()) {
  if (!range) return false
  const cur = d.getHours() * 60 + d.getMinutes()
  return range.from <= range.to
    ? cur >= range.from && cur < range.to
    : cur >= range.from || cur < range.to
}

export function createWake({ config, manager, logger, bridge }) {
  const states = new Map() // sessionId -> { lastAt, lastProactiveAt, dayKey, count, misses }
  let timer = null
  let stopped = true

  const silentMs = () => Math.max(60_000, Number(config?.proactiveSilentMs) || 1_200_000)
  const maxPerDay = () => Math.max(0, Number(config?.proactiveMaxPerDay) || 0)

  function stateOf(record) {
    let st = states.get(record.sessionId)
    if (!st) {
      // 首次见到这个会话时别拿「现在」当起点 —— 用队列层记的上次活动时间，
      // 否则插件刚启动、会话已经安静半小时了也要白等一轮。
      st = {
        lastAt: Number(record.lastActive) || Date.now(),
        lastProactiveAt: 0,
        dayKey: dayKey(),
        count: 0,
        misses: 0,
        // 这一轮主动机会还在等结果：她说了一句（算数）还是选了 [SILENT]（白给）
        pending: 0,
      }
      states.set(record.sessionId, st)
    }
    return st
  }

  /** 收到消息：重置安静计时，也说明「上几次主动没白发」。 */
  function noteInbound(record) {
    if (!record?.sessionId) return
    const st = stateOf(record)
    st.lastAt = Date.now()
    st.misses = 0
  }

  /** 自己发了消息：也算一次活动（不然刚说完就被判冷场）。 */
  function noteOutbound(record) {
    if (!record?.sessionId) return
    const st = stateOf(record)
    st.lastAt = Date.now()
    // 注意：这里**不能**动 lastProactiveAt。
    // 她回姐姐一句话不等于「她主动开口过」——只有 fire() 真给了机会才算。
    // 2026-10-25 修：原来这里把每次回复都当成主动说话，导致
    // 「安静 20 分钟该开口」被「说完话要等 30 分钟」顶掉，而会话 30 分钟就被回收，
    // 三个阈值刚好卡死，整天都等不到一次机会。
  }

  /** 会话被回收/重置时把状态一起丢掉。 */
  function forget(record) {
    if (!record?.sessionId) return
    states.delete(record.sessionId)
  }

  /**
   * 主动轮真的发出去了：这才算用掉一次额度。
   *
   * 为什么不在 fire() 里直接算：投出去之后她可能说「没什么想说的」就直接 [SILENT]，
   * 那是她的决定，不该算成「今天已经主动说过 6 次」。
   * 2026-10-26 之前就是那样，结果一天 10 次机会里有 6 次沉默，额度到 13:20 就满了，
   * 下午两次机会连带被吞掉 —— 越克制越不敢开口，机制反过来惩罚她。
   */
  function noteProactiveDelivered(record) {
    if (!record?.sessionId) return
    const st = states.get(record.sessionId)
    if (!st?.pending) return
    st.pending = 0
    st.dayKey = dayKey()
    st.count += 1
  }

  /** 主动轮她自己选了沉默（[SILENT]）：机会白给，不算数、也不记 miss。 */
  function noteProactiveSilent(record) {
    if (!record?.sessionId) return
    const st = states.get(record.sessionId)
    if (st) st.pending = 0
  }

  async function fire(record, st, silentMin, now) {
    const base = proactiveRule(config, {
      label: record.label,
      silentMin,
      isGroup: record.scope === 'group',
      now,
    })
    // 通道回执：断线期间丢过话就先摆在她眼前，别让她对着空气继续说
    const bridgeLines = bridge?.take?.(record) ?? []
    // 门口：大姐鲸鲸捎的信。只报「有几封、在哪」，不摊内容 —— 拆不拆她自己定。
    const doorNotice = doorLine(config)
    const extra = [doorNotice, ...bridgeLines].filter(Boolean)
    const text = extra.length > 0 ? `${base}\n\n${extra.join('\n')}` : base
    st.lastProactiveAt = Date.now()
    // 先记「这次机会还没兑现」：真发出去才算用掉额度（见 noteProactiveDelivered）。
    // 2026-10-26 修：这里原来直接 st.count += 1，[SILENT] 也扣 —— 沉默把配额吃光。
    st.pending = Date.now()
    // [SILENT] 是她自己的决定，不记 miss；只有投递真的失败才算（见 catch）
    logger.info?.(`[dsh-qq] ${record.label} 安静 ${silentMin} 分钟，给一次主动开口的机会`)
    manager.enqueue(record, async () => {
      try {
        // 必须是完整的用户消息对象：直接传字符串的话，DSH 内部按消息结构去读
        // content[0].kind 会拿到 undefined，整轮直接抛 Cannot read properties of undefined。
        record.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }),
        )
        await Promise.race([
          Promise.resolve(record.agent.whenIdle?.()).then(() => 'idle'),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), FIRE_TIMEOUT_MS)
            t.unref?.()
          }),
        ])
      } catch (err) {
        st.pending = 0
        st.misses += 1
        logger.warn?.(`[dsh-qq] 主动开口失败 ${record.label}:`, err)
      }
    })
  }

  /**
   * 冷会话拉回（2026-10-25 加）。
   * 会话闲置久了会被回收出内存，主动说话轮只遍历 manager.list()，
   * 冷掉之后就永远轮不到它 —— 变成「对方不说话，它就不主动」。
   * 默认关；本地在 config 里把 wakeColdSessions 打开，发布版留给用户自己选。
   */
  let reviving = false
  async function reviveCold() {
    if (config?.wakeColdSessions !== true) return
    if (reviving) return
    reviving = true
    try {
      const peers = Array.isArray(config?.privateAllow) ? config.privateAllow : []
      const max = Math.max(1, Number(config?.wakeColdMax) || 3)
      const hot = new Set(manager.list().map((r) => `${r.scope}:${String(r.peerId)}`))
      let n = 0
      for (const raw of peers) {
        if (n >= max) break
        const peerId = String(raw)
        if (hot.has(`private:${peerId}`)) continue
        try {
          await manager.obtain({ scope: 'private', peerId, label: `私聊 ${peerId}` })
          n += 1
          logger.info?.(`[dsh-qq] 拉回冷会话 私聊 ${peerId}（主动说话要用）`)
        } catch (err) {
          logger.warn?.(`[dsh-qq] 拉回冷会话失败 ${peerId}:`, err)
        }
      }
    } finally {
      reviving = false
    }
  }

  /** 一分钟看一遍：谁安静够久了、能不能开口。 */
  async function tick(now = new Date()) {
    if (stopped) return
    if (config?.proactiveEnabled === false) return
    // 桥断了就别自说自话：说了也发不出去，白烧一轮
    if (bridge?.isUp?.() === false) return
    const quota = maxPerDay()
    if (quota === 0) return
    if (inQuietHours(parseQuietHours(config?.proactiveQuietHours), now)) return

    await reviveCold()

    const limit = silentMs()
    for (const record of manager.list()) {
      const st = stateOf(record)
      // 上一轮机会投出去，却既没发话也没给 [SILENT]（那一轮报错退出了）：
      // 过了投递超时就当没发生过，别让 pending 一直挂着。
      if (st.pending && now.getTime() - st.pending > FIRE_TIMEOUT_MS * 2) st.pending = 0
      if (record.busy > 0) continue
      // record.lastActive 是队列层的活动时间：工具直接发消息（qq_reply 之类）也走任务，
      // 任务结束就会刷新它，所以拿它兜底比只靠 noteOutbound 更准。
      const lastAt = Math.max(st.lastAt, Number(record.lastActive) || 0)
      const idleMs = now.getTime() - lastAt
      if (idleMs < limit) continue
      // 刚主动过一次：隔开一点，别连珠炮
      if (st.lastProactiveAt && now.getTime() - st.lastProactiveAt < limit * 1.5) continue
      const dk = dayKey(now)
      if (st.dayKey !== dk) {
        st.dayKey = dk
        st.count = 0
      }
      if (st.count >= quota) continue
      // 连着几次主动都没人接，就别自说自话了
      if (st.misses >= MAX_SILENT_MISSES) continue
      void fire(record, st, Math.round(idleMs / 60000), now)
    }
  }

  function start() {
    if (!stopped) return
    stopped = false
    timer = setInterval(() => tick(), TICK_MS)
    timer.unref?.()
    logger.info?.(
      `[dsh-qq] 主动说话已启动：安静 ${Math.round(silentMs() / 60000)} 分钟起，每天最多 ${maxPerDay()} 次，静默时段 ${config?.proactiveQuietHours || '（不限）'}`,
    )
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    states.clear()
  }

  return {
    start,
    stop,
    tick,
    noteInbound,
    noteOutbound,
    noteProactiveDelivered,
    noteProactiveSilent,
    forget,
    silentMs,
    maxPerDay,
  }
}
