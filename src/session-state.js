import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 会话键这本账：`/reset` 跳到第几代、这一代真正落在哪个 sessionId。
 *
 * 为什么非要落盘（2026-10-26 姐姐问「不能每次都发那么长一截」时一起揪出来的）：
 * 原来 `#gens`（reset 次数）和「实际 sessionId」都只在内存里。宿主一重启：
 *   1. gen 归零 → 又回去找 reset 之前那个老会话，姐姐刚 reset 掉的东西全回来了；
 *   2. 老会话因为上一任宿主被强杀而带着写句柄，resume 被拒、create 也被拒，
 *      只好临时换个新 id —— 于是每重启一次就多一个空壳，今晚攒了 8 个。
 *
 * 所以两样都记下来：
 *   - `gens[baseKey]`     → 这一路 reset 到第几代（决定 key 是 baseKey 还是 baseKey#n）；
 *   - `sessions[key]`     → 这一代真正用的 sessionId（换壳兜底时跟 hash 推出来的不一致）。
 * 键在、id 对，重启才不会退回老会话，也不用每次都重开一个空壳。
 */
export function createSessionState(file, logger) {
  let data = { gens: {}, sessions: {} }
  try {
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.gens && typeof raw.gens === 'object') data.gens = raw.gens
        if (raw.sessions && typeof raw.sessions === 'object') data.sessions = raw.sessions
      }
    }
  } catch (err) {
    // 账本坏了就当全新的：gen 回 0、id 走 hash。宁可重来一次，也别把人钉在坏账上。
    logger?.warn?.('[dsh-qq] 读会话账本失败，重置为初始状态:', err?.message ?? err)
    data = { gens: {}, sessions: {} }
  }

  const save = () => {
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      logger?.warn?.('[dsh-qq] 写会话账本失败（重启后可能退回老会话）:', err?.message ?? err)
    }
  }

  return {
    /** 这一路 reset 到第几代；0 表示没 reset 过。 */
    gen(baseKey) {
      const n = Number(data.gens[baseKey])
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    },
    setGen(baseKey, gen) {
      if (!baseKey) return
      const n = Number(gen)
      if (!Number.isFinite(n) || n <= 0) delete data.gens[baseKey]
      else data.gens[baseKey] = Math.floor(n)
      save()
    },
    /** 这一代真正用的 sessionId（没有就返回空串，调用方退回 hash）。 */
    sessionId(key) {
      const v = data.sessions[key]
      return v ? String(v) : ''
    },
    setSessionId(key, sessionId) {
      if (!key || !sessionId) return
      if (data.sessions[key] === String(sessionId)) return
      data.sessions[key] = String(sessionId)
      save()
    },
    /** 键换代时把上一代的 id 划掉，别让账本一直涨。 */
    forgetSession(key) {
      if (!key || !(key in data.sessions)) return
      delete data.sessions[key]
      save()
    },
    all() {
      return { gens: { ...data.gens }, sessions: { ...data.sessions } }
    },
  }
}
