// 便签（pin）：给 QQ 里的鲸鲸一张自己的小纸片。
//
// 为什么要有它（2026-10-26 老三自己在私聊里提的）：
//   「本姑娘聊长了容易忘半截——上回说到哪儿、哪句话还没接上」「要能随时翻一眼『还没接上』的」
//   「短短几行，像便签那样，一眼扫完不费劲」。
//
// 设计取向：这不是「待办清单」，是「话头」。写什么、写几条，全由它自己决定——
//   我们只保证两件事：① 换地方的头一轮它面前会有这几行（**平时不塞** —— 它自己说的：聊得正顺的时候硬塞反而碍眼）；② 纸很薄（最多 5 条、每条 60 字）。
//
// 文件位置：<会话目录>\话头.md（私聊、每个群各一份，互不串）
// 行格式：- [ ] 2026-10-26 09:50 内容      （未完成）
//         - [x] 2026-10-26 09:50 内容      （已接上）
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_SHOWN = 5
const MAX_LEN = 60
const KEEP_LINES = 40

export function pinFileFor(record) {
  const dir = String(record?.dir ?? '').trim()
  return dir ? join(dir, '话头.md') : ''
}

function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function readAll(record) {
  const file = pinFileFor(record)
  if (!file || !existsSync(file)) return { file, lines: [] }
  try {
    return { file, lines: readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n') }
  } catch {
    return { file, lines: [] }
  }
}

function isOpen(line) {
  return /^-\s*\[\s*\]/.test(String(line).trim())
}

function bodyOf(line) {
  return String(line)
    .trim()
    .replace(/^-\s*\[\s*\]\s*/, '')
}

function writeAll(file, lines) {
  const text = lines.join('\n').replace(/\n+$/, '') + '\n'
  writeFileSync(file, text, 'utf8')
}

export function createPin({ config, logger } = {}) {
  const enabled = config?.pinEnabled !== false

  /** 换地方那一轮塞进提示词的那几行（没有未完成条目时返回空数组，一点不占） */
  function view(record) {
    if (!enabled) return []
    try {
      const open = readAll(record).lines.filter(isOpen)
      if (open.length === 0) return []
      const shown = open
        .slice(0, MAX_SHOWN)
        .map((line) => `· ${bodyOf(line).slice(0, MAX_LEN)}`)
      const rest = open.length > MAX_SHOWN ? [`（还有 ${open.length - MAX_SHOWN} 条没列）`] : []
      return ['[话头] 你自己钉住的、还没接上的（别念出来，接得上就接着聊）:', ...shown, ...rest]
    } catch (err) {
      logger?.warn?.(`读便签失败: ${err?.message ?? err}`)
      return []
    }
  }

  function add(record, text) {
    if (!enabled) throw new Error('便签被关掉了（config.pinEnabled === false）')
    const clean = String(text ?? '').trim()
    if (!clean) throw new Error('qq_pin: 要记的内容是空的')
    const { file, lines } = readAll(record)
    if (!file) throw new Error('qq_pin: 这个会话没有落盘目录')
    const body = lines.filter((l) => l.trim() !== '')
    body.push(`- [ ] ${nowStamp()} ${clean.slice(0, 200)}`)
    while (body.length > KEEP_LINES) {
      const oldestDone = body.findIndex((l) => /^-\s*\[\s*x\s*\]/i.test(l.trim()))
      body.splice(oldestDone >= 0 ? oldestDone : 0, 1)
    }
    writeAll(file, body)
    return body.filter(isOpen).length
  }

  /** 把第 index 个（1 起）未完成条目划掉；index 不合法返回 false */
  function done(record, index) {
    const { file, lines } = readAll(record)
    if (!file) return false
    const n = Number(index)
    let seen = 0
    for (let i = 0; i < lines.length; i += 1) {
      if (!isOpen(lines[i])) continue
      seen += 1
      if (seen === n) {
        lines[i] = lines[i].replace(/-\s*\[\s*\]/, '- [x]')
        writeAll(file, lines.filter((l) => l.trim() !== ''))
        return true
      }
    }
    return false
  }

  /** 删掉第 index 个（1 起）未完成条目（不想要了，不是接上了） */
  function drop(record, index) {
    const { file, lines } = readAll(record)
    if (!file) return false
    const n = Number(index)
    let seen = 0
    for (let i = 0; i < lines.length; i += 1) {
      if (!isOpen(lines[i])) continue
      seen += 1
      if (seen === n) {
        lines.splice(i, 1)
        writeAll(file, lines.filter((l) => l.trim() !== ''))
        return true
      }
    }
    return false
  }

  function list(record) {
    return readAll(record).lines.filter((l) => l.trim() !== '')
  }

  return { enabled, fileFor: pinFileFor, view, add, done, drop, list }
}
