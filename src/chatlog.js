import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 聊天流水：把每一句话按时落盘，一天一个文件。
 *
 * 为什么要有这一层：QQ 会话里 agent 是「一问一答」的，它很少会主动去写日记，
 * 于是聊完就忘——第二天问它「昨天说的那个」，它根本不知道。插件层把流水记下来，
 * 不依赖模型自觉，也不多花一轮 token；要总结成日记，之后随时可以从这里提炼。
 *
 * 落点：`<会话目录>/聊天记录/YYYY-MM-DD.md`
 * 每行：`- HH:MM:SS · 谁：说了什么`
 */

/** 流水目录名（在会话目录下）。 */
export const CHATLOG_DIR = '聊天记录'

/**
 * 白名单外那些会话的流水子目录（`聊天记录/_未开通/`）。
 *
 * 2026-10-26 姐姐定的：群/人没开通，话也不投递，但**留一份痕**。
 * 起因是 `群_987654321/聊天记录/` 停在 10-24 就没了，谁也说不清是「没人说话」
 * 还是「被白名单挡了」——原来 `allowGroup` 的 return 在记流水之前，被挡的话一句都不留。
 */
export const UNAUTHORIZED_LOG_DIR = '_未开通'

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 2026-10-24 */
export function dayOf(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 14:05:09 */
export function clockOf(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 往会话目录里的当日流水追加一行。失败只记日志，绝不影响聊天。
 *
 * @param {string|null} dir 会话目录（resolvePeerWorkspace 的结果）
 * @param {{ who?: string, text?: string, time?: Date, msgId?: string|number }} entry
 * @param {*} [logger]
 * @param {string} [sub] 子目录（默认 `聊天记录`；白名单外的传 `聊天记录/_未开通`）
 * @returns {Promise<boolean>} 是否真的写进去了
 */
export async function appendChatLog(dir, entry = {}, logger, sub = CHATLOG_DIR) {
  if (!dir) return false
  const said = String(entry.text ?? '').replace(/\r/g, '').trim()
  if (!said) return false

  const time = entry.time instanceof Date ? entry.time : new Date()
  const who = String(entry.who ?? '').trim() || '（未知）'
  const file = join(dir, sub, `${dayOf(time)}.md`)
  // 多行消息压成一行，保留换行标记，便于之后按行读
  const body = said.replace(/\n+/g, ' ⏎ ')
  // 消息编号留在行尾（`#msg=123456`，2026-10-27 加的）。
  // 图只活在看图那一秒——那一轮没被叫醒，就再也没人知道那条消息里是张什么图；
  // 留着号，事后能让 qq_images 把那条消息的图重新捞回来。
  const msgId = String(entry.msgId ?? '').trim()
  const tail = /^\d+$/.test(msgId) ? ` #msg=${msgId}` : ''
  const line = `- ${clockOf(time)} · ${who}：${body}${tail}\n`

  try {
    await mkdir(join(dir, sub), { recursive: true })
    await appendFile(file, line, 'utf8')
    return true
  } catch (err) {
    logger?.debug?.(`[dsh-qq] 聊天流水写入失败：${err?.message ?? err}`)
    return false
  }
}
