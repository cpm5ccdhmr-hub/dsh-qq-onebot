import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bedtimeRule, morningRule } from './prompts.js'

/**
 * 作息：睡前提醒、说晚安就休息、夜里的消息留到早上一起回。
 *
 * 三件事其实是一件事的三个时刻：
 *   1. bedtimeAt（默认 23:30）到点 → 投一句「该睡了」，它自己组织话说。
 *   2. 她在私聊里说「晚安/睡了」→ 这个会话进入休息，直到 sleepTo（默认 08:00）。
 *   3. sleepFrom–sleepTo 之间（默认 00:00–08:00）收到的消息**不立刻回**，
 *      只记下来；等出窗口了，一次性交给 Agent：「昨晚她发来这些」。
 *
 * 为什么不在 inbound 里直接 if：这些都需要一个时钟（tick），
 * 而 inbound 是「来消息才动」的，没消息就永远不会有人去叫醒它。
 */

const TICK_MS = 60_000
const FIRE_TIMEOUT_MS = 300_000
/**
 * 到点那一分钟没送出去（会话正忙 / 内存里刚好没会话），还能补发多久。
 * 过了这段就不补——半夜一点再去催睡没意义。
 */
const LATE_BED_WINDOW_MIN = 30

/** "23:30" → 1410；写错了给 null（当没设）。 */
export function parseHm(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

function minutesOf(d) {
  return d.getHours() * 60 + d.getMinutes()
}

/** from <= cur < to；跨零点（00:00-08:00 不跨，但 23:00-08:00 会）也支持。 */
export function inRange(from, to, cur) {
  if (from === null || to === null) return false
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function hmText(at) {
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`
}

/** 这句话像不像「我要去睡了」。只认短句，免得把「昨晚那个我没睡着」也算进去。 */
export function looksLikeGoodnight(text, words = []) {
  const s = String(text ?? '').trim()
  if (!s || s.length > 20) return false
  // ⭐ 2026-10-24 修：「睡了嘛鲸鲸?」被当成晚安，直接把会话按到明早。
  //   晚安是「告知」，问句是「问她睡没睡」——差一个问号，方向完全相反。
  if (/[?？]\s*$/.test(s)) return false
  // 带疑问词的也不算（吗/嘛/么/呢 在句末或跟「睡」连用）；「我睡了」「困了」「晚安」不受影响。
  if (/(吗|嘛|么|呢)[\s。.!！~～]*$/.test(s)) return false
  if (/(睡了吗|睡了没|睡着了吗|还没睡|没睡|睡不着|醒着吗)/.test(s)) return false
  if (/(不睡|不想睡|还不困|再玩会|再看会)/.test(s)) return false
  return words.some((w) => w && s.includes(w))
}

export function createSleep({ config, manager, logger }) {
  const states = new Map() // sessionId -> { sleeping, wakeAt, pending, pendingSince, remindedOn }
  let timer = null
  let stopped = true

  const enabled = () => config?.sleepMode !== false
  // ⭐ 2026-10-25 姐姐定的：**姐姐说话就醒，不强制作息**。
  //   原来 00:00–08:00 收到的私聊一律按住、早上再交；现在默认不再按住——
  //   她夜里找人，就是她醒了，得有人应。想要回旧行为就把这个开成 true。
  const holdNight = () => config?.holdNightMessages === true
  const fromAt = () => parseHm(config?.sleepFrom) ?? 0
  const toAt = () => parseHm(config?.sleepTo) ?? 480
  const bedtimeAt = () => parseHm(config?.bedtimeAt)
  const goodWords = () =>
    String(config?.goodnightWords ?? '晚安,睡了,睡觉,去睡,我先睡,困了,睡啦')
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)

  function stateOf(record) {
    let st = states.get(record.sessionId)
    if (!st) {
      st = { sleeping: false, wakeAt: 0, pending: [], pendingSince: 0, remindedOn: '' }
      states.set(record.sessionId, st)
    }
    return st
  }

  /** 下一个 sleepTo 的时间戳（今天的还没到就今天，过了就明天）。 */
  function nextWakeAt(now = new Date()) {
    const to = toAt()
    const d = new Date(now)
    d.setHours(Math.floor(to / 60), to % 60, 0, 0)
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }

  function inSleepWindow(now = new Date()) {
    return inRange(fromAt(), toAt(), minutesOf(now))
  }

  /** inbound 用它判断：这条消息现在该不该装作没看见。 */
  function shouldHold(record, now = new Date()) {
    if (!enabled() || !record?.sessionId) return false
    if (record.scope === 'group') return false
    // ⭐ 2026-10-25：默认不按住了——姐姐说话就是姐姐醒了，正常回。
    if (!holdNight()) return false
    const st = stateOf(record)
    if (st.sleeping && now.getTime() < st.wakeAt) return true
    return inSleepWindow(now)
  }

  /** 把消息留在队列里，等早上一起交出去。 */
  function hold(record, text, now = new Date()) {
    if (!record?.sessionId) return false
    const st = stateOf(record)
    if (!st.pending.length) st.pendingSince = now.getTime()
    st.pending.push({
      at: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      text: String(text ?? '').slice(0, 500),
    })
    logger.info?.(`[dsh-qq] ${record.label} 休息中，先记着（第 ${st.pending.length} 条，早上再说）`)
    return true
  }

  /**
   * 见过一条消息之后调一次。命中「晚安」就把这个会话按下去，直到明早。
   * 注意：调用方仍然要把这条**正常投递**（她说了晚安，得有人应一句）。
   */
  function noteText(record, text, now = new Date()) {
    if (!enabled() || !record?.sessionId) return false
    if (record.scope === 'group') return false
    if (inSleepWindow(now)) return false // 凌晨才说的晚安，就当普通消息排队
    if (!looksLikeGoodnight(text, goodWords())) return false
    const st = stateOf(record)
    if (st.sleeping) return false
    st.sleeping = true
    st.wakeAt = nextWakeAt(now)
    logger.info?.(
      `[dsh-qq] ${record.label} 说了晚安，进入休息到 ${new Date(st.wakeAt).toLocaleString('zh-CN')}`,
    )
    return true
  }

  /**
   * ⭐ 2026-10-25：到点提醒会「整个跳过」的补刀。
   *
   * tick 里的睡前提醒是**遍历内存里的现有会话**发的，而会话是有人说话才建的。
   * 所以只要提醒那一刻内存里一个会话都没有（最常见的就是刚重启过），
   * `for (const record of manager.list())` 空转一圈，今天的提醒就白丢了——
   * 23:30 没提醒 ≠ 提醒被吞，是根本没对象可发。
   *
   * 这里改成「等人真说话了再补一句」：返回一段提示词前缀，让这一轮的回复
   * 顺带把话说了，不额外多开一轮。
   */
  function takeLateBedtime(record, now = new Date()) {
    if (!enabled() || !record?.sessionId) return ''
    if (record.scope === 'group') return '' // 群里不催睡
    const bed = bedtimeAt()
    if (bed === null) return ''
    if (inSleepWindow(now)) return '' // 已经进休息时段了，别半夜说「该睡了」
    const cur = minutesOf(now)
    if (cur <= bed) return '' // 还没到点
    const st = stateOf(record)
    const dk = dayKey(now)
    if (st.remindedOn === dk) return ''
    st.remindedOn = dk
    logger.info?.(`[dsh-qq] ${record.label} 补一句睡前提醒（错过了 ${hmText(bed)} 那个点）`)
    return `[提醒] 已经 ${hmText(cur)} 了，${hmText(bed)} 就该睡了。回她的时候顺口催一句早点休息，一句就够，别说教。`
  }

  function forget(record) {
    if (!record?.sessionId) return
    states.delete(record.sessionId)
  }

  /** 往会话里投一段（跟 wake.js 同一套：必须是完整的消息对象）。 */
  function fire(record, text, tag) {
    manager.enqueue(record, async () => {
      try {
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
        logger.warn?.(`[dsh-qq] ${tag}投递失败 ${record.label}:`, err)
      }
    })
  }

  /**
   * ⭐ 2026-10-25 加：这会话正在睡 / 攒着待交的消息 ⇒ 别让 SessionManager 回收。
   * 回收之后 record 不在了，tick 遍历 list() 拿不到它，早上那几条就永远交不出去。
   */
  function isHolding(record) {
    const st = states.get(record.sessionId)
    if (!st) return false
    // 不按住消息之后，只有「真的攒着待交的话」才需要保会话；
    // 光 sleeping 不再拦回收（夜里不攒东西了）。
    return (st.pending?.length ?? 0) > 0
  }

  function tick(now = new Date()) {
    if (stopped || !enabled()) return
    const asleep = inSleepWindow(now)

    for (const record of manager.list()) {
      const st = stateOf(record)

      // ① 出了休息时段：夜里攒下的，一次性交出去
      //    ⭐ 2026-10-24 修：以前只看「现在不在全局睡眠窗口」——比如 23:50 说了晚安、
      //    00:00 才进窗口，23:51 那次 tick 就算「早上了」，把刚攒的 2 条交出去还道了早安 ✗。
      //    现在被晚安按下的会话必须等**自己的 wakeAt**，只有「纯窗口排队」才看出窗口。
      const wakeReady = !st.sleeping || now.getTime() >= st.wakeAt
      if (!asleep && wakeReady && st.pending.length > 0 && record.busy === 0) {
        const items = st.pending.slice()
        st.pending = []
        st.pendingSince = 0
        st.sleeping = false
        st.wakeAt = 0
        logger.info?.(`[dsh-qq] ${record.label} 早上了，把夜里攒的 ${items.length} 条交出去`)
        fire(record, morningRule(config, { label: record.label, items, now }), '早安汇总')
        continue
      }

      // ② 到点提醒睡觉（每个会话每天一次，休息中不提醒）
      //    ⭐ 2026-10-26 夜：群里不催睡。tick 遍历的是全部会话，群也走到这儿，
      //    23:30 那句「提醒她一句」原样丢进群聊、接的是陌生群友的话，
      //    她于是对着人家喊「姐姐，快十一点半啦，收摊睡觉吧」。跟 takeLateBedtime 的「群里不催睡」对齐。
      if (record.scope === 'group') continue
      const bed = bedtimeAt()
      if (bed === null || asleep) continue
      if (st.sleeping && now.getTime() < st.wakeAt) continue
      // ⭐ 2026-10-26 修（两处）：
      //   ① 原来要求「刚好这一分钟」（minutesOf(now) !== bed），会话忙 / 内存里还没建会话
      //      就整分钟跳过去，今天再也不提醒；现在给 30 分钟补发窗口（跨午夜用模运算）。
      //   ② 原来先把 remindedOn 记上再判 busy——忙的时候等于「标成提醒过却没发」。
      //      现在忙就先不记账，等它空下来补。
      const late = (minutesOf(now) - bed + 1440) % 1440
      if (late >= LATE_BED_WINDOW_MIN) continue
      const dk = dayKey(now)
      if (st.remindedOn === dk) continue
      if (record.busy > 0) continue
      st.remindedOn = dk
      logger.info?.(`[dsh-qq] ${record.label} 到 ${hmText(bed)} 了，提醒她去睡`)
      fire(record, bedtimeRule(config, { label: record.label, now, clock: hmText(bed) }), '睡前提醒')
    }
  }

  function start() {
    if (!stopped) return
    stopped = false
    timer = setInterval(() => tick(), TICK_MS)
    timer.unref?.()
    logger.info?.(
      holdNight()
        ? `[dsh-qq] 作息已启动：${hmText(bedtimeAt() ?? 0)} 提醒睡觉，${hmText(fromAt())}–${hmText(toAt())} 的消息留到早上`
        : `[dsh-qq] 作息已启动：${hmText(bedtimeAt() ?? 0)} 提醒睡觉；不按住夜里的消息——姐姐说话就醒`,
    )
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    states.clear()
  }

  return { start, stop, tick, shouldHold, hold, noteText, takeLateBedtime, forget, inSleepWindow, isHolding }
}
