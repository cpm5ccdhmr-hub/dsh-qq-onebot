/**
 * 把「工具要授权」这件事搬到 QQ 上。
 *
 * DSH 的 approval 是 waterfall：`ctx.on('approval/request', (req, next) => ...)`。
 * 我们拦住属于 QQ 会话的请求，发一条消息问用户，然后挂起 Promise 等回复。
 * 用户下一条消息如果是「通过 / 拒绝 / 取消」，就被这里吃掉，不投给 Agent。
 *
 * 注意：审批请求本身不带命令原文，要去 session.events 里按 callId 反查。
 */

const COMMAND_CLIP = 500
const ANSWER_TIMEOUT_MS = 5 * 60 * 1000

const ALLOW_RE = /^(通过|允许|同意|可以|行|好|确认|对|是|yes|y|ok|allow)$/i
const REJECT_RE = /^(拒绝|不行|不要|否|不准|别|no|n|reject|deny)$/i
const CANCEL_RE = /^(取消|cancel|算了)$/i

/**
 * 从会话事件流里按 callId 找回被 gate 的那次调用。
 *
 * 坑：审批请求本身只带 callId，不带工具名和参数，必须回去翻 session.events。
 * 而且不能只认 `command` —— 写文件、访问网络、跑子进程，各自的参数名字都不一样。
 * @returns {{ tool: string, detail: string } | undefined}
 */
function describeOf(req) {
  if (req?.callId === undefined) return undefined
  const events = req?.agent?.session?.events
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || event.type !== 'tool/call') continue
    const data = event.data
    if (String(data?.callId) !== String(req.callId)) continue

    const tool = String(data?.name ?? '未知工具')
    const raw = data?.arguments
    if (typeof raw !== 'string') return { tool, detail: '' }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { tool, detail: clip(raw) }
    }
    if (!parsed || typeof parsed !== 'object') return { tool, detail: clip(raw) }

    // 按常见参数名挑一个最能说明「要干什么」的
    const pick = (key) => (typeof parsed[key] === 'string' ? parsed[key] : '')
    const command = pick('command') || pick('cmd')
    if (command) return { tool, detail: `要执行的命令：${clip(command)}` }

    const file = pick('file_path') || pick('filePath') || pick('path')
    if (file) {
      const content = pick('content')
      const hint = content ? `（写入 ${content.length} 字）` : ''
      return { tool, detail: `要操作的文件：${clip(file)}${hint}` }
    }

    const url = pick('url')
    if (url) return { tool, detail: `要访问的地址：${clip(url)}` }

    // 认不出来的，就把参数原样截一段
    return { tool, detail: `参数：${clip(raw)}` }
  }
  return undefined
}

function clip(s) {
  const str = String(s ?? '')
  return str.length <= COMMAND_CLIP ? str : `${str.slice(0, COMMAND_CLIP)}…`
}

export class ApprovalChannel {
  #pending = new Map() // sessionId -> { resolve, timer, signal, onAbort }

  constructor({ manager, config, logger, send }) {
    this.manager = manager
    this.config = config
    this.logger = logger
    this.send = send
  }

  /** 挂到 Cordis 上；宿主没挂 approval 服务时安静跳过。 */
  install(ctx) {
    let available = false
    try {
      available = ctx.get?.('approval') !== undefined
    } catch {
      available = false
    }
    if (!available) {
      this.logger.info?.('approval 服务不可用，QQ 审批通道未启用（审批仍走 DSH 界面）')
      return
    }
    ctx.on(
      'approval/request',
      (req, next) => {
        const sessionId = req?.agent?.session?.header?.id ?? req?.agent?.id
        const record = sessionId === undefined ? null : this.manager.find(String(sessionId))
        if (!record) return next()
        return this.#park(record, req)
      },
      { prepend: true },
    )
    this.logger.info?.('QQ 审批通道已启用：需要授权的操作会发到 QQ，回「通过」/「拒绝」')
  }

  /**
   * 入站消息先过这里：如果它是在回答一个待审批的请求，就吃掉它。
   * @returns {boolean} true 表示已消化，不要再投给 Agent
   */
  tryResolve(record, text) {
    const entry = this.#pending.get(record.sessionId)
    if (!entry) return false
    const answer = String(text ?? '').trim()
    let decision = null
    if (ALLOW_RE.test(answer)) decision = 'allowed-once'
    else if (REJECT_RE.test(answer)) decision = 'rejected'
    else if (CANCEL_RE.test(answer)) decision = 'cancelled'
    if (!decision) return false

    this.#settle(record.sessionId, decision)
    this.logger.info?.(`[dsh-qq] 审批决定 ${record.label}: ${decision}`)
    return true
  }

  /** 会话被回收 / 插件卸载时，别让 Promise 吊死。 */
  cancelPending(sessionId) {
    if (!this.#pending.has(sessionId)) return
    this.#settle(sessionId, 'cancelled')
  }

  cancelAll() {
    for (const sessionId of [...this.#pending.keys()]) this.#settle(sessionId, 'cancelled')
  }

  #settle(sessionId, decision) {
    const entry = this.#pending.get(sessionId)
    if (!entry) return
    this.#pending.delete(sessionId)
    clearTimeout(entry.timer)
    if (entry.onAbort && entry.signal) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort)
      } catch {
        /* ignore */
      }
    }
    entry.resolve(decision)
  }

  async #park(record, req) {
    if (req?.signal?.aborted) return 'cancelled'

    const command = commandOf(req)
    const lines = ['🔐 有个操作需要你点头：']
    if (command) lines.push(`要执行的命令：${command}`)
    else lines.push('（这条请求没带命令原文）')
    lines.push('', '回「通过」放行这一回，回「拒绝」挡掉，回「取消」作废。')

    try {
      await this.send(record, lines.join('\n'))
    } catch (err) {
      this.logger.error?.(`[dsh-qq] 审批消息发送失败: ${err?.message ?? err}`)
      return 'unavailable' // 发不出去就别放行，fail-closed
    }

    return new Promise((resolve) => {
      const entry = { resolve, timer: null, signal: req.signal, onAbort: null }
      entry.timer = setTimeout(() => {
        this.logger.warn?.(`[dsh-qq] 审批超时 ${record.label}，按取消处理`)
        this.#settle(record.sessionId, 'cancelled')
      }, ANSWER_TIMEOUT_MS)
      entry.timer.unref?.()

      if (req.signal) {
        entry.onAbort = () => this.#settle(record.sessionId, 'cancelled')
        try {
          req.signal.addEventListener('abort', entry.onAbort, { once: true })
        } catch {
          /* ignore */
        }
      }

      this.#pending.set(record.sessionId, entry)
      this.logger.info?.(`[dsh-qq] 审批已发到 QQ，等待回复 ${record.label}`)
    })
  }
}
