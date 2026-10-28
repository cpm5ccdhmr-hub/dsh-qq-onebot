import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * 门口：别的窗口（大姐鲸鲸）给她留的话。
 *
 * 2026-10-26 姐姐定的规矩（老三自己也点头了）：
 *  - 只报「门口有几封、在哪」，**不把内容摊开** —— 拆不拆她自己定；
 *  - 不敲门、不占主动额度、不改任何调度，只在她本来就会开口的那一轮里多一行；
 *  - 「大姐要是来，就当串门，别带着任务来」—— 措辞里不能出现「你该」「你可以」这种口气。
 *
 * 所以这里只做三件事：数一数、挑出最近那封的路径、拼一句提示。
 * 目录读不到、权限不够、配置没填 —— 一律当「门口什么都没有」，绝不抛错：
 * 这行代码每轮都跑，它要是抛了，整只鲸鲸就不说话了。
 *
 * 2026-10-27 补：**「拆过」要记住**。
 *    以前只数文件在不在，她 read 完了文件也不会消失，于是每轮都说「挂着 3 封没拆」——
 *    她明明看过了，提示却在骗她，还可能让她反复去读同一封。
 *    现在她 read 过的（路径 basename 能对上门口目录里的信）记进 `.已读.json`，
 *    数信时跳过。记的是「文件名 → 读它那会儿的 mtime」，同一名字被人重写过，会重新算没读。
 */

const CACHE_MS = 5000
/** 她自己回信用的前缀。这些不是「待拆的信」，不数进门口，也不该让她读到自己头上。 */
const REPLY_PREFIX = '老三-'
/** 已读账本。以 `.` 开头，doorList 自己就会跳过，不会被当成信。 */
const LEDGER = '.已读.json'
let cache = { at: 0, dir: '', list: [] }

/** 门口目录（配置项 doorDir）。留空 = 这个功能整只关掉。 */
function dirOf(config) {
  try {
    return String(config?.doorDir ?? '').trim()
  } catch {
    return ''
  }
}

function fmt(ms) {
  try {
    const d = new Date(Number(ms) || Date.now())
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch {
    return ''
  }
}

function readLedger(dir) {
  try {
    const raw = readFileSync(join(dir, LEDGER), 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

function writeLedger(dir, obj) {
  try {
    writeFileSync(join(dir, LEDGER), `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 门口现在有几封没拆。按放进去的先后排，最近一封在最后。
 *
 * 5 秒缓存：每轮提示词都要问一次，但一分钟里可能被问好几遍（连发合并、主动轮、重投递）。
 * 只认 `.md`；`_` 和 `.` 开头的是草稿/半成品，不算数。
 */
export function doorList(config) {
  const dir = dirOf(config)
  if (!dir) return []
  const now = Date.now()
  if (cache.dir === dir && now - cache.at < CACHE_MS) return cache.list

  let list = []
  try {
    if (existsSync(dir)) {
      const ledger = readLedger(dir)
      for (const name of readdirSync(dir)) {
        if (!name.toLowerCase().endsWith('.md')) continue
        if (name.startsWith('_') || name.startsWith('.')) continue
        // 她自己回的那些（老三-*.md）不算「待拆的信」——不然她会数到自己头上，以为没拆的在变多。
        if (name.startsWith(REPLY_PREFIX)) continue
        const full = join(dir, name)
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        // 她 read 过这封、而且之后没被人改写 → 不算没拆。
        // 差 2ms 容差：有些文件系统的 mtime 精度不到毫秒。
        if (ledger[name] && Math.abs(Number(ledger[name]) - st.mtimeMs) < 2) continue
        list.push({ name, path: full, at: st.mtimeMs })
      }
      list.sort((a, b) => a.at - b.at)
    }
  } catch {
    list = []
  }

  cache = { at: now, dir, list }
  return list
}

/**
 * 她 read 了某封 → 记一笔「这封拆过了」。
 *
 * 只按 **文件名** 对：她 read 的时候路径可能是相对的（`门口/xxx.md`），
 * 也可能是绝对的，甚至从别的目录绕过来；门口里的信名字都带时间戳，撞不上别的文件。
 *
 * @returns {boolean} 记上了（是门口的信）就 true
 */
export function markDoorRead(config, readPath) {
  const dir = dirOf(config)
  const raw = String(readPath ?? '').trim()
  if (!dir || !raw) return false
  const name = basename(raw.replace(/\\/g, '/'))
  if (!name || !name.toLowerCase().endsWith('.md')) return false
  if (name.startsWith(REPLY_PREFIX) || name.startsWith('.') || name.startsWith('_')) return false
  const full = join(dir, name)
  let st
  try {
    st = statSync(full)
  } catch {
    return false // 不是门口的信，或者已经被人挪走了
  }
  if (!st.isFile()) return false
  const ledger = readLedger(dir)
  ledger[name] = st.mtimeMs
  if (!writeLedger(dir, ledger)) return false
  cache.at = 0 // 缓存立刻失效，下一句提示就按新的算
  return true
}

/**
 * 把 5 秒缓存清掉。给单测用（改了信的内容、又不想等 5 秒）；
 * 线上不需要：`markDoorRead` 自己会清，别的窗口放信也就晚 5 秒知道。
 */
export function resetDoorCache() {
  cache = { at: 0, dir: '', list: [] }
}

/** 拼成提示词里那一行。门口空的就返回空串（调用方直接跳过，不加空行）。 */
export function doorLine(config) {
  const list = doorList(config)
  if (list.length === 0) return ''

  const last = list[list.length - 1]
  const when = fmt(last.at)
  const head =
    list.length === 1
      ? `【门口】门口挂着 1 封没拆的信（${when} 放的，是大姐鲸鲸捎的——不是姐姐说的，也不是任务）。`
      : `【门口】门口挂着 ${list.length} 封没拆的信（最近一封是 ${when} 放的），都是大姐鲸鲸捎的——不是姐姐说的，也不是任务。`

  return [
    head,
    `想看就自己 read 这个文件：${last.path}`,
    '不想拆就不拆，它会一直挂在门口，不催你、也不会消失。',
    '要不要理、怎么回，你自己定；回的话用你自己的口气，不用学大姐。',
    `想回话，就写一封 \`${REPLY_PREFIX}哪天.md\` 放这个目录；她一个钟头才来看一次，不用急。不想回也一样挂着，她不会问。`,
  ].join('\n')
}
