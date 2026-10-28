import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 「聊天规矩已经注入过了」这张小账本，得落盘。
 *
 * 为什么：`chatPromptInjected` 原来只是 record 上的一个字段，record 活在内存里。
 * 宿主重启、或者闲置回收后再 obtain，record 重建、标记复位 —— 人设 + 协议 + 事实卡
 * （老三这边一次两千多字）又往会话历史里塞一份。叠几次下来，每一轮都要带着好几份
 * 同样的前言，越聊越沉，模型还容易被重复的规矩带偏。
 *
 * ⭐ 2026-10-26 22:45 改：主键从「会话键」换成 **sessionId**。
 * 原来按 `baseKey` / `baseKey#gen` 记，可键本身就会变：`/reset` 换代 +1、换壳换 id、
 * gen 是后补落盘的。键一变账本就认不出 —— 22:33 记在 `@iso`、22:38 记在 `@iso#1`，
 * 同一个 sessionId 还是往历史里塞了两份人设。
 * sessionId 才是历史的容器：**同一个 sessionId = 同一段历史 = 注过就是注过**。
 * `/reset` 换新 id、恢复失败换新壳，都自然落到「没注过 → 注入一次」，这是对的。
 */
export function createInjectState(file, logger) {
  let map = Object.create(null)
  let migrated = false
  try {
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          // 旧格式：{ 会话键: { sessionId, at } } —— 迁移成以 sessionId 为键
          if (v && typeof v === 'object' && typeof v.sessionId === 'string') {
            map[v.sessionId] = { at: v.at ?? new Date().toISOString() }
            migrated = true
          } else if (typeof v === 'string') {
            map[k] = { at: v }
            migrated = true
          } else if (v && typeof v === 'object') {
            map[k] = v
          }
        }
      }
    }
  } catch (err) {
    // 账本坏了就当没注过：宁可在没注过的会话上多注一次，也别让新会话光着。
    logger?.warn?.('[dsh-qq] 读注入账本失败，当作没注入过:', err?.message ?? err)
  }

  // 别只涨不消：留最近 300 条，够覆盖所有还活着的会话
  const prune = () => {
    const ids = Object.keys(map)
    if (ids.length <= 300) return
    ids.sort((a, b) => String(map[a].at).localeCompare(String(map[b].at)))
    for (const id of ids.slice(0, ids.length - 300)) delete map[id]
  }

  const save = () => {
    if (!file) return
    try {
      prune()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(map, null, 2), 'utf8')
    } catch (err) {
      // 写不进去不影响聊天，最多少省一次 token
      logger?.warn?.('[dsh-qq] 写注入账本失败（下次可能重复注入一遍）:', err?.message ?? err)
    }
  }

  // 迁移过就顺手写回，下次读就是新格式了
  if (migrated) save()

  return {
    /** 这个会话是不是已经注过。 */
    has(sessionId) {
      if (!sessionId) return false
      return Boolean(map[String(sessionId)])
    },
    /** 记一笔：这个会话注入过了。 */
    mark(sessionId) {
      if (!sessionId) return
      map[String(sessionId)] = { at: new Date().toISOString() }
      save()
    },
    /** 丢一笔。 */
    forget(sessionId) {
      if (!sessionId || !(String(sessionId) in map)) return
      delete map[String(sessionId)]
      save()
    },
    /** 账本全貌（调试/设置页用）。 */
    all() {
      return { ...map }
    },
  }
}
