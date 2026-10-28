/**
 * 群黑话 / 角色知识学习闭环（②）。
 *
 * 思路：不猜「哪些词陌生」，只看鲸鲸**自己卡壳**的地方——
 * 它回复里出现「啥意思 / 不认识 / 认不出」这类字眼，说明那条群消息它没接住。
 * 把触发它的那条群友消息记进 `记忆区/群词典.md` 的「待确认」节，
 * 下次它读到这本词典，至少知道自己在这个群踩过哪个坑。
 *
 * 只追加、只记「待确认」；确认意思之后由鲸鲸自己（或姐姐）挪到「已确认」。
 *
 * @module learning
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 鲸鲸自己回复里出现这些，就算「没接住」 */
export const STUCK_WORDS = [
  '啥意思',
  '什么意思',
  '不认识',
  '没懂',
  '不知道这是',
  '认不出',
  '没看懂',
  '这是啥呀',
  '没听明白',
  '不知道是谁',
]

const LINE_RE = /^-\s+(\d{2}:\d{2}:\d{2})\s+·\s+(.+?)\((\d+)\)：([\s\S]*)$/

/**
 * 把一天的聊天记录解析成 [{ time, name, uid, text, self }]
 * @param {string} text 聊天记录全文
 * @param {string|number} selfId 自己的 QQ 号
 */
export function parseChatLog(text, selfId) {
  const self = String(selfId ?? '')
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = LINE_RE.exec(line)
    if (!m) continue
    rows.push({
      time: m[1],
      name: m[2].trim(),
      uid: m[3],
      text: m[4].trim(),
      self: self !== '' && m[3] === self,
    })
  }
  return rows
}

/** 去掉 @人 和开头标点，剩下的才算「这句话到底说了啥」 */
export function coreOf(text) {
  return String(text ?? '')
    .replace(/@\S+/g, '')
    .replace(/^[\s，,。.！!？?~～、…]+/, '')
    .trim()
}

/**
 * 找出所有「鲸鲸卡壳」的地方：{ word, reply, trigger }
 * trigger = 该条回复之前最近一条非自己的消息。
 * 只是叫人的消息（去掉 @ 和称呼后剩不到 4 个字）不算触发——那不是黑话，是点名。
 */
export function findStuck(rows, stuck = STUCK_WORDS) {
  const hits = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r.self || !r.text) continue
    const word = stuck.find((w) => r.text.includes(w))
    if (!word) continue
    let j = i - 1
    while (j >= 0 && rows[j].self) j--
    if (j < 0) continue
    if (coreOf(rows[j].text).length < 4) continue
    hits.push({ word, reply: r, trigger: rows[j] })
  }
  return hits
}

const HEADER = `# 群词典 · 群聊黑话与角色

> 群鲸鲸自己卡壳的地方。**待确认** = 它没接住的；弄明白意思后自己挪到**已确认**。
> 这本是它自己的笔记，别借别人的词硬编。

## 待确认

## 已确认

| 词 / 说法 | 意思 | 谁说的 | 日期 |
| --- | --- | --- | --- |
`

/**
 * 把命中项追加到词典的「待确认」节。已存在的不重复加。
 * @returns {number} 实际新增条数
 */
export function appendPending(file, hits, { limit = 10 } = {}) {
  if (!hits?.length) return 0
  mkdirSync(dirname(file), { recursive: true })
  let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!text.trim()) text = HEADER

  const fresh = []
  let added = 0
  for (const h of hits) {
    if (added >= limit) break
    const quoted = String(h.trigger.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
    const stamp = `- [ ] ${h.trigger.name}：${quoted}`
    // 去重键：昵称 + 那句话前 80 字（时间戳会变，不能拿整行比）
    if (text.includes(stamp.slice(2))) continue
    fresh.push(`${stamp}\n  ↳ ${h.reply.time} 鲸鲸回「${h.word}」`)
    added++
  }
  if (!fresh.length) return 0

  const block = fresh.join('\n') + '\n'
  const marker = '## 待确认'
  const at = text.indexOf(marker)
  if (at < 0) {
    // 没有这一节就按标准头部重来，把旧内容接在已确认后面
    text = HEADER + (text.trim() ? `\n${text.trim()}\n` : '')
    writeFileSync(file, text.replace('## 待确认\n', `## 待确认\n\n${block}`), 'utf8')
    return added
  }
  // 插到「待确认」节开头，原有条目原样留在下面（不覆盖别人写的）
  const start = at + marker.length
  const next = text.indexOf('\n## ', start)
  const end = next < 0 ? text.length : next
  const head = text.slice(0, start).replace(/\s*$/, '\n\n')
  const between = text.slice(start, end).replace(/^\s*\n/, '').replace(/\s*$/, '')
  const body = between ? `${between}\n` : ''
  const tail = text.slice(end).replace(/^\s*/, '\n')
  writeFileSync(file, head + block + body + tail, 'utf8')
  return added
}

/**
 * 扫一次：遍历 workspaceRoot 下的 `群_*` 会话，读最近两天的聊天记录，追加卡壳点。
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {string|number} opts.selfId
 * @param {string} [opts.today] YYYY-MM-DD
 * @param {object} [opts.logger]
 * @returns {number} 总新增条数
 */
export function scanOnce({ workspaceRoot, selfId, today, logger } = {}) {
  const root = String(workspaceRoot ?? '').trim()
  if (!root || !existsSync(root)) return 0
  const day = today || new Date().toISOString().slice(0, 10)
  const days = [day]
  const d = new Date(`${day}T00:00:00`)
  d.setDate(d.getDate() - 1)
  days.push(d.toISOString().slice(0, 10))

  let total = 0
  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('群_'))
      .map((e) => e.name)
  } catch {
    return 0
  }
  for (const name of dirs) {
    const dir = join(root, name)
    const hits = []
    for (const day2 of days) {
      const f = join(dir, '聊天记录', `${day2}.md`)
      if (!existsSync(f)) continue
      try {
        hits.push(...findStuck(parseChatLog(readFileSync(f, 'utf8'), selfId)))
      } catch (err) {
        logger?.warn?.(`群词典：读 ${f} 失败 ${err?.message ?? err}`)
      }
    }
    if (!hits.length) continue
    const file = join(dir, '记忆区', '群词典.md')
    const n = appendPending(file, hits)
    if (n > 0) {
      total += n
      logger?.info?.(`群词典：${name} 新增 ${n} 条待确认`)
    }
  }
  return total
}

/**
 * 起一个每 20 分钟扫一次的定时器（unref，不挡进程退出）。
 * selfId 可以传函数：登录前拿不到、连接后才知道，每次 tick 现取。
 * @returns {() => void} dispose
 */
export function startLearning({ workspaceRoot, selfId, everyMs = 20 * 60_000, logger } = {}) {
  let timer = null
  const tick = () => {
    try {
      const sid = typeof selfId === 'function' ? selfId() : selfId
      if (!sid) return // 还没登录，认不出哪条是自己发的
      scanOnce({ workspaceRoot, selfId: sid, logger })
    } catch (err) {
      logger?.warn?.(`群词典扫描失败：${err?.message ?? err}`)
    }
  }
  try {
    tick()
    timer = setInterval(tick, everyMs)
    timer.unref?.()
  } catch (err) {
    logger?.warn?.(`群词典定时器起不来：${err?.message ?? err}`)
  }
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}
