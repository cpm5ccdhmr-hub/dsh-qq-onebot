/**
 * 通道回执（「桥」）：让住在 QQ 里的鲸鲸知道「话有没有送出去」。
 *
 * 起因：2026-10-26 小黑盒那篇《因为没开桥，被我孤立了16天》。
 * 桥断了十六天，她一直在发，110 多条消息一条都没出去，只能猜自己是不是
 * 「排到最后了」。我们的 dsh-qq 原来也是同一个毛病：发送失败只落进
 * logger.warn，她自己永远不知道 —— 她只会以为说了话、对方没理。
 *
 * 这一层做得很小：把「断线 / 发送失败」先记在会话身上，等下一次真正投递时
 * 作为一行 `[通道]` 提示塞进去。不替她说话、不改她的判断，只让她别把
 * 「桥的问题」误读成「人的态度」。
 *
 * 关闭：config.bridgeReceipt = false（默认开）。
 */

const MAX_FAILS = 4 // 一次最多列几句没发出去的
const SNIP = 60 // 每句留多长
// 队列上限只用来防内存长胖，不参与展示：展示永远只列前 MAX_FAILS 句。
// 2026-10-26 修：原来取 MAX_FAILS + 2，结果第 5 句之后被悄悄挤掉，
// 「你有 N 句话没送出去」的 N 就和列出来的对不上（测试抓到的）。
const MAX_QUEUE = 32

function snip(text) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > SNIP ? `${t.slice(0, SNIP)}…` : t
}

export function humanSpan(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h} 小时 ${rm} 分钟` : `${h} 小时`
}

export function createBridge({ config, logger, manager }) {
  const enabled = () => config?.bridgeReceipt !== false
  // 启动时当作通的：第一次连上不算「恢复」，只有断过再连上才算。
  let up = true
  let downSince = 0

  function push(record, note) {
    if (!record) return
    if (!Array.isArray(record.bridgeNotes)) record.bridgeNotes = []
    record.bridgeNotes.push(note)
    if (record.bridgeNotes.length > MAX_QUEUE) {
      const cut = record.bridgeNotes.splice(0, record.bridgeNotes.length - MAX_QUEUE)
      const lost = cut.filter((n) => n?.kind === 'fail').length
      if (lost > 0) record.bridgeDropped = (Number(record.bridgeDropped) || 0) + lost
    }
  }

  /** send() 里 catch 到失败时调：这句没送出去。 */
  function noteSendFailure(record, text, err) {
    if (!enabled()) return
    const reason = err?.message ? String(err.message) : String(err ?? '未知原因')
    push(record, { kind: 'fail', text: snip(text), reason, at: Date.now() })
    logger?.warn?.(`[dsh-qq] ${record?.label ?? ''} 通道回执：这句话没送出去（${reason}）`)
  }

  /** WS 断开。不给会话塞提示 —— 等她真发过、失败过了再说。 */
  function markDown() {
    if (!enabled()) return
    if (!up) return
    up = false
    downSince = Date.now()
    logger?.warn?.('[dsh-qq] 通道断开；期间发送失败的话会记下来，恢复后告诉她')
  }

  /** WS 连上。只有「断线期间真丢过话」的会话才值得打扰。 */
  function markUp() {
    if (!enabled()) return
    if (up) return
    up = true
    const dur = downSince ? Date.now() - downSince : 0
    downSince = 0
    const list = manager?.list?.() ?? []
    let told = 0
    for (const record of list) {
      const fails = Array.isArray(record.bridgeNotes)
        ? record.bridgeNotes.filter((n) => n.kind === 'fail')
        : []
      if (fails.length === 0) continue
      push(record, { kind: 'up', dur, at: Date.now() })
      told += 1
    }
    logger?.info?.(
      `[dsh-qq] 通道恢复（断了 ${humanSpan(dur)}）${told > 0 ? `，${told} 个会话有话没送出去` : ''}`,
    )
  }

  /**
   * 投递前取走提示。返回空数组表示没什么要说的。
   * 取走即清空 —— 同一件事不重复念叨。
   */
  function take(record) {
    if (!enabled()) return []
    const notes = Array.isArray(record?.bridgeNotes) ? record.bridgeNotes.splice(0) : []
    if (notes.length === 0) return []

    const fails = notes.filter((n) => n.kind === 'fail')
    const ups = notes.filter((n) => n.kind === 'up')
    // 被队列上限挤掉的也算「没送出去」，否则总数会和列出来的对不上
    const dropped = Number(record?.bridgeDropped) || 0
    if (record) record.bridgeDropped = 0
    const total = fails.length + dropped
    const out = []

    if (ups.length > 0) {
      const dur = Math.max(...ups.map((n) => Number(n.dur) || 0))
      out.push(`[通道] 你和 QQ 之间的连接断过 ${dur > 0 ? humanSpan(dur) : '一小会儿'}，刚刚恢复。`)
    }
    if (total > 0) {
      const reason = fails[fails.length - 1]?.reason ?? '未知原因'
      if (total === 1 && fails.length === 1) {
        out.push(`[通道] 你刚才那句话没送出去（原因：${reason}）：`)
      } else {
        out.push(
          ups.length > 0
            ? `[通道] 这段断线期间，你有 ${total} 句话没能送出去：`
            : `[通道] 你有 ${total} 句话没能送出去（最后一次失败原因：${reason}）：`,
        )
      }
      const listed = fails.slice(0, MAX_FAILS)
      for (const f of listed) out.push(`  ·「${f.text}」`)
      if (total > listed.length) out.push(`  ·（还有 ${total - listed.length} 句没列出来）`)
      out.push('[通道] 这是通道断了，不是对方不理你 —— 这些内容对方那边一个字都没收到。')
    }
    return out
  }
  return { noteSendFailure, markDown, markUp, take, isUp: () => up, humanSpan }
}
