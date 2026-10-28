/**
 * 把「Agent 想问你一句话」搬到 QQ 上。
 *
 * DSH 的 userQuestions 是 waterfall：`ctx.on('user-questions/request', (req, next) => ...)`。
 * 我们拦住属于 QQ 会话的请求，把问题渲染成短文本发到 QQ，等对方回复后
 * 拼成 `{ answers: [{ id, selected: [...], custom? }] }` 交回去。
 *
 * 注意：这是 `ask_user_question` 工具在无界面宿主机（qqbot profile）里唯一的出口——
 * 不接住它，工具会直接报 NO_PROVIDER 或者干等到超时。
 */

const ANSWER_TIMEOUT_MS = 5 * 60 * 1000

/** 「1」/「1,3」/「1 2」这种纯数字回复 */
const NUMERIC_RE = /^\d+(?:\s*[,，、\s]\s*\d+)*$/

/**
 * 把一句回复解析成 answer 片段。
 * @param {string} text 用户原话
 * @param {Array<{label: string}>} options 可选项
 * @returns {{ selected: string[], custom?: string }}
 */
function parseAnswer(text, options) {
  const list = Array.isArray(options) ? options : []
  if (list.length > 0 && NUMERIC_RE.test(text)) {
    const picks = text
      .split(/[,，、\s]+/)
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length)
    if (picks.length > 0) return { selected: picks.map((n) => list[n - 1].label) }
  }
  return { selected: [], custom: text }
}

export class QuestionChannel {
  #pending = new Map() // sessionId -> { question, options, resolve, timer, signal, onAbort }

  constructor({ manager, config, logger, send }) {
    this.manager = manager
    this.config = config
    this.logger = logger
    this.send = send
  }

  /** 挂到 Cordis 上。服务晚注册也照样挂——waterfall 监听器只会被真正 ask 时调用。 */
  install(ctx) {
    try {
      ctx.on(
        'user-questions/request',
        (req, next) => {
          const agent = req?.agent
          const byId = agent?.session?.header?.id ?? agent?.id
          // 先按 sessionId 找；拿不到（或对不上）就按 Agent 实例反查，别让问题漏到宿主那边去
          const record =
            (byId === undefined ? null : this.manager.find(String(byId))) ??
            this.manager.findByAgent?.(agent) ??
            null
          if (!record) return next()
          return this.#ask(record, req)
        },
        { prepend: true },
      )
      this.logger.info?.('QQ 问话通道已挂监听：ask_user_question 会转发到 QQ')
    } catch (err) {
      this.logger.warn?.(`[dsh-qq] 问话通道挂载失败: ${err?.message ?? err}`)
    }
  }

  /** 入站消息先过这里：如果它是在回答一个待答问题，就吃掉它。 */
  tryResolve(record, text) {
    const entry = this.#pending.get(record.sessionId)
    if (!entry) return false
    const answer = String(text ?? '').trim()
    if (!answer) return false

    const parsed = parseAnswer(answer, entry.options)
    this.logger.info?.(`[dsh-qq] 问答已收到 ${record.label}: ${JSON.stringify(parsed)}`)
    this.#settle(record.sessionId, parsed)
    return true
  }

  /** 会话被回收 / 插件卸载时，别让 Promise 吊死。 */
  cancelPending(sessionId) {
    if (!this.#pending.has(sessionId)) return
    this.#settle(sessionId, null)
  }

  cancelAll() {
    for (const sessionId of [...this.#pending.keys()]) this.#settle(sessionId, null)
  }

  #settle(sessionId, answer) {
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
    const id = entry.question.id
    entry.resolve(
      answer ? { id, selected: [...answer.selected], ...(answer.custom !== undefined ? { custom: answer.custom } : {}) } : { id, selected: [] },
    )
  }

  async #ask(record, req) {
    const questions = Array.isArray(req?.questions) ? req.questions : []
    const answers = []
    for (const question of questions) {
      answers.push(await this.#askOne(record, question, req?.signal))
    }
    return { answers }
  }

  async #askOne(record, question, signal) {
    if (signal?.aborted) return { id: question.id, selected: [] }

    const options = Array.isArray(question.options) ? question.options : []
    const lines = []
    if (question.header) lines.push(`❓ ${question.header}`)
    lines.push(String(question.question ?? ''))
    if (options.length > 0) {
      lines.push('')
      options.forEach((option, index) => {
        const desc = option.description ? ` —— ${option.description}` : ''
        lines.push(`${index + 1}) ${option.label}${desc}`)
      })
      lines.push('')
      lines.push(question.multiSelect ? '回数字（多个用逗号，比如 1,3），或者直接说你的想法。' : '回数字，或者直接说你的想法。')
    } else {
      lines.push('')
      lines.push('直接回我一句话就好。')
    }

    try {
      await this.send(record, lines.join('\n'))
    } catch (err) {
      this.logger.error?.(`[dsh-qq] 提问发送失败: ${err?.message ?? err}`)
      return { id: question.id, selected: [] }
    }

    return new Promise((resolve) => {
      const entry = { question, options, resolve, timer: null, signal, onAbort: null }
      entry.timer = setTimeout(() => {
        this.logger.warn?.(`[dsh-qq] 提问超时 ${record.label}，按跳过处理`)
        this.#settle(record.sessionId, null)
      }, ANSWER_TIMEOUT_MS)
      entry.timer.unref?.()

      if (signal) {
        entry.onAbort = () => this.#settle(record.sessionId, null)
        try {
          signal.addEventListener('abort', entry.onAbort, { once: true })
        } catch {
          /* ignore */
        }
      }

      this.#pending.set(record.sessionId, entry)
      this.logger.info?.(`[dsh-qq] 问题已发到 QQ，等待回复 ${record.label}`)
    })
  }
}
