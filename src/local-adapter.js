/**
 * 本地 Ollama 适配器（意图路由专用）。
 *
 * 为什么不直接用 pi-ai 的 openai-completions 路由：
 *  - Agent 每轮交给 llm 的 `options.messages` 是**完整会话历史**，而且
 *    `llm/stream` 拿到的是深冻结对象，监听器无法裁剪。长会话动辄 3 万 token，
 *    3B 本地模型的 32K 窗口根本塞不下，路由只能一直退回云端，等于没省到钱。
 *  - 这个适配器在发请求前自己把历史裁到最后几轮用户消息，并限制系统提示词长度，
 *    让“短闲聊”在长会话里也真的能落到本地。
 *
 * 只处理纯文本；图片/文件/工具调用不转发给本地模型——闲聊用不上。
 */

import { loadIntentRules } from './intent-rules.js'

const DEFAULT_SYSTEM_CHARS = 12000
const DEFAULT_HISTORY_CHARS = 14000
const DEFAULT_MAX_USER_TURNS = 4

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }
  return ''
}

/**
 * 把完整 DSH 历史裁成 Ollama 能吃的短上下文。
 * 从最后一条用户消息往前保留最多 `maxUserTurns` 轮；超出字符预算就继续丢最老的轮次。
 */
export function selectLocalMessages(options, { systemChars = DEFAULT_SYSTEM_CHARS, historyChars = DEFAULT_HISTORY_CHARS, maxUserTurns = DEFAULT_MAX_USER_TURNS } = {}) {
  const system = String(options?.system ?? '').slice(0, systemChars)
  const all = (Array.isArray(options?.messages) ? options.messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role, content: textOf(message.content).trim() }))
    .filter((message) => message.content.length > 0)

  const userPositions = []
  for (let i = 0; i < all.length; i += 1) if (all[i].role === 'user') userPositions.push(i)
  if (userPositions.length === 0) return { system, messages: [] }

  let start = userPositions[Math.max(0, userPositions.length - Math.max(1, maxUserTurns))]
  let chosen = all.slice(start)
  const size = () => chosen.reduce((sum, message) => sum + message.content.length, 0)

  // 每丢一轮，就把起点推进到下一个用户消息；至少保留最后一轮。
  while (size() > historyChars && start < userPositions[userPositions.length - 1]) {
    const nextUser = userPositions.find((position) => position > start)
    if (nextUser === undefined) break
    start = nextUser
    chosen = all.slice(start)
  }

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  for (const message of chosen) messages.push(message)
  return { system, messages }
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 1.6))
}

/**
 * 结构化适配器：不依赖 `@deepseek-ai/dsh-llm` 的 class（宿主注册只做鸭子类型检查），
 * 这样该文件也能脱离宿主单独跑测试。
 */
export function createLocalOllamaAdapter({ config, logger, fetchImpl } = {}) {
  const rules = loadIntentRules(config)
  const baseURL = rules.baseURL
  const defaultModel = rules.model
  const call = fetchImpl ?? globalThis.fetch

  return {
    providerInfo(provider) {
      return { id: provider, name: 'Local Ollama (dsh-qq)' }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget() {
      return { width: 0, height: 0, maxBytes: 0 }
    },
    async listModels(provider) {
      return [{ provider, id: defaultModel, name: `${defaultModel} · local`, inputModalities: ['text'] }]
    },
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: `${model} · local`,
        inputModalities: ['text'],
        context: { contextWindow: 32768 },
        defaultMaxTokens: 2048,
      }
    },
    async prepareCall(provider, model) {
      const resolved = await this.resolveModel(provider, model)
      return { model: resolved, stream: (options) => this.stream(options) }
    },
    async *stream(options) {
      const { messages } = selectLocalMessages(options, {
        systemChars: rules.systemChars,
        historyChars: rules.historyChars,
        maxUserTurns: rules.maxUserTurns,
      })
      if (messages.length === 0) throw new Error('local_ollama: 没有可发送的文本消息')
      const body = {
        model: options?.model || defaultModel,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: Math.min(Number(options?.maxTokens) || 2048, 2048),
        options: { num_ctx: 32768 },
      }
      const response = await call(`${baseURL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options?.signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`local_ollama HTTP ${response.status}: ${String(detail).slice(0, 300)}`)
      }

      yield { type: 'block-start', index: 0, blockType: 'text' }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let text = ''
      let usage = null
      let finishReason = 'stop'

      const handleLine = (line) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) return { piece: '', done: false }
        const data = trimmed.slice(5).trim()
        if (!data) return { piece: '', done: false }
        if (data === '[DONE]') return { piece: '', done: true }
        let event
        try {
          event = JSON.parse(data)
        } catch {
          return { piece: '', done: false }
        }
        const delta = event?.choices?.[0]?.delta
        const piece = typeof delta?.content === 'string' ? delta.content : ''
        if (piece) text += piece
        if (event?.choices?.[0]?.finish_reason) finishReason = String(event.choices[0].finish_reason)
        if (event?.usage) usage = event.usage
        return { piece, done: false }
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const { piece, done: streamDone } = handleLine(line)
          if (piece) yield { type: 'text-delta', index: 0, text: piece }
          if (streamDone) {
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'usage', usage: usage ?? { inputTokens: estimateTokens(messages.map((m) => m.content).join('')), outputTokens: estimateTokens(text) } }
            yield { type: 'finish', reason: { kind: finishReason === 'length' ? 'max-tokens' : 'stop' } }
            return
          }
        }
      }
      const tail = handleLine(buffer)
      if (tail.piece) yield { type: 'text-delta', index: 0, text: tail.piece }
      if (!text.trim()) throw new Error('local_ollama 返回空内容')
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield {
        type: 'usage',
        usage: usage ?? {
          inputTokens: estimateTokens(messages.map((m) => m.content).join('')),
          outputTokens: estimateTokens(text),
        },
      }
      yield { type: 'finish', reason: { kind: finishReason === 'length' ? 'max-tokens' : 'stop' } }
    },
  }
}
