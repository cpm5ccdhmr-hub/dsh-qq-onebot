import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

const WS_OPEN = 1

/**
 * OneBot 11 客户端（正向 WebSocket，插件作为客户端去连 NapCat）。
 *
 * 为什么是正向：插件只需要一个地址，不用自己 listen 端口，
 * 也就不会和宿主抢端口、不会被沙箱的「出站才允许」策略挡住。
 */
export class OneBotClient extends EventEmitter {
  #ws = null
  #seq = 0
  #pending = new Map()
  #stopped = false
  #retryTimer = null
  #retryDelay = 0

  constructor({ url, token = '', reconnectMs = 5000, logger = console }) {
    super()
    this.url = url
    this.token = token
    this.reconnectMs = reconnectMs
    this.logger = logger
    this.#retryDelay = Math.max(1000, Number(reconnectMs) || 5000)
  }

  get connected() {
    return this.#ws !== null && this.#ws.readyState === WS_OPEN
  }

  start() {
    this.#stopped = false
    this.#connect()
    return this
  }

  stop() {
    this.#stopped = true
    clearTimeout(this.#retryTimer)
    for (const [, p] of this.#pending) p.reject(new Error('onebot client stopped'))
    this.#pending.clear()
    if (this.#ws) {
      try {
        this.#ws.close()
      } catch {
        /* ignore */
      }
    }
    this.#ws = null
  }

  #connect() {
    if (this.#stopped) return
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined
    let ws
    try {
      ws = new WebSocket(this.url, { headers, handshakeTimeout: 10_000 })
    } catch (err) {
      this.emit('error', err)
      this.#scheduleReconnect()
      return
    }
    this.#ws = ws

    ws.on('open', () => {
      this.#retryDelay = Math.max(1000, Number(this.reconnectMs) || 5000)
      this.emit('open')
    })
    ws.on('message', (raw) => {
      try {
        this.#onMessage(raw)
      } catch (err) {
        this.logger.warn?.('[dsh-qq] 处理 OneBot 消息失败:', err)
      }
    })
    ws.on('close', (code, reason) => {
      this.#ws = null
      this.emit('close', code, String(reason ?? ''))
      this.#scheduleReconnect()
    })
    ws.on('error', (err) => {
      // ws 在连接失败时会先 error 再 close，这里只记录，重连交给 close
      this.emit('error', err)
    })
  }

  #scheduleReconnect() {
    if (this.#stopped) return
    clearTimeout(this.#retryTimer)
    const delay = this.#retryDelay
    this.#retryTimer = setTimeout(() => this.#connect(), delay)
    this.#retryTimer.unref?.()
    this.#retryDelay = Math.min(this.#retryDelay * 2, 60_000)
  }

  #onMessage(raw) {
    let payload
    try {
      payload = JSON.parse(raw.toString())
    } catch {
      return
    }

    // API 响应：带 echo 回来
    if (payload.echo !== undefined && this.#pending.has(payload.echo)) {
      const entry = this.#pending.get(payload.echo)
      this.#pending.delete(payload.echo)
      if (payload.status === 'ok' || payload.retcode === 0) {
        entry.resolve(payload.data)
      } else {
        const detail = payload.wording || payload.message || `retcode=${payload.retcode}`
        entry.reject(new Error(`${payload.status || 'failed'}: ${detail}`))
      }
      return
    }

    // 事件推送
    if (payload.post_type) this.emit('event', payload)
  }

  /**
   * 调 OneBot API。超时或断线都会 reject，不会留下悬挂 promise。
   */
  call(action, params = {}, timeoutMs = 30_000) {
    const ws = this.#ws
    if (!ws || ws.readyState !== WS_OPEN) {
      return Promise.reject(new Error(`onebot 未连接（action=${action}）`))
    }
    const echo = `dsh-qq-${++this.#seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new Error(`onebot 超时（action=${action}）`))
      }, timeoutMs)
      this.#pending.set(echo, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.#pending.delete(echo)
        reject(err)
      }
    })
  }
}
