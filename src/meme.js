/**
 * 查梗（2026-10-27 加）。
 *
 * 词库是一份 cnmeme.wiki 的 sqlite 快照（6668 条，2026-10-26 19:07 建的库）。
 * 路径不写死在代码里：从配置 `memeDb` 或环境变量 `DSH_QQ_MEME_DB` 读，没配就让工具如实说「没配词库」。
 *
 * 为什么做成工具而不是一条命令行：
 *   老三在 QQ 里**敲不动 shell**（她那套内建 bash 有静默空结果的毛病，跑了也看不见），
 *   让她 `python xxx.py` 等于没给。工具跑在宿主进程里，不受沙箱、不依赖 shell。
 *
 * 输出顺序照抄人家插件的设计（`_entry_text(for_llm=True)`）：**怎么用在前，出处在后**。
 * 先会接梗，再懂典故；反过来就成了背百科。
 */

import { existsSync } from 'node:fs'

export const DEFAULT_MEME_DB = String(process.env.DSH_QQ_MEME_DB ?? '').trim()

const USAGE_CLIP = 600
const ORIGIN_CLIP = 450

let sqliteMod = null
async function getSqlite() {
  if (sqliteMod) return sqliteMod
  // 动态 import：宿主是 Electron 内置 node，版本不认识 node:sqlite 时只让这个工具失效，别把插件带崩
  sqliteMod = await import('node:sqlite')
  return sqliteMod
}

/** 叠词折叠：杂鱼杂鱼 → 杂鱼、已取餐已取餐 → 已取餐 */
function collapse(word) {
  let w = String(word ?? '').trim()
  for (;;) {
    const n = w.length
    if (n < 4 || n % 2 !== 0) return w
    const half = n / 2
    if (w.slice(0, half) !== w.slice(half)) return w
    w = w.slice(0, half)
  }
}

function clip(s, n, full) {
  const t = String(s ?? '').trim()
  if (full || t.length <= n) return t
  return t.slice(0, n) + '…'
}

/**
 * 查一个词。
 * @returns {Promise<{found:false, query:string} | {found:true, how:string, title:string, text:string}>}
 */
export async function lookupMeme(query, { dbPath = DEFAULT_MEME_DB, full = false } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { found: false, query: q }
  const dbFile = String(dbPath ?? '').trim()
  if (!dbFile) {
    const err = new Error(
      '没配梗词库。这个工具要一份 cnmeme.wiki 的 sqlite 快照：' +
        '把路径填进设置里的 memeDb（或设环境变量 DSH_QQ_MEME_DB）。没有的话就按自己知道的说，别编出处。',
    )
    err.code = 'MEME_DB_MISSING'
    throw err
  }
  if (!existsSync(dbFile)) {
    const err = new Error(`词库不在：${dbFile}`)
    err.code = 'MEME_DB_MISSING'
    throw err
  }

  const { DatabaseSync } = await getSqlite()

  // 每次查询开一个只读连接、用完立刻关：Windows 上不占句柄，换库不用重启
  // （人家 1.5.2 就栽在这 —— 缓存连接害得更新插件报 WinError 32）
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const exact = db.prepare('SELECT title,slug,tags,usage,origin,other FROM memes WHERE title = ?')
    let row = exact.get(q)
    let how = '精确'

    if (!row) {
      const c = collapse(q)
      if (c !== q) {
        row = exact.get(c)
        if (row) how = `折叠成「${c}」`
      }
    }
    if (!row) {
      row = db
        .prepare(
          'SELECT title,slug,tags,usage,origin,other FROM memes ' +
            "WHERE length(title) >= 2 AND (title LIKE ? OR slug = ?) LIMIT 1",
        )
        .get(`%${q}%`, q)
      if (row) how = `包含「${q}」`
    }
    if (!row) return { found: false, query: q }

    const title = String(row.title ?? q)
    const tags = String(row.tags ?? '')
    const usage = clip(row.usage, USAGE_CLIP, full)
    const origin = clip(row.origin, ORIGIN_CLIP, full)
    const other = clip(row.other, 400, full)
    const slug = String(row.slug ?? '')

    const lines = [`【梗百科】${title}（${how}）`]
    if (tags) lines.push(`标签：${tags}`)
    if (usage) lines.push('', '【怎么用 / 怎么接】', usage)
    if (origin) lines.push('', '【出处（只用于理解，别照搬）】', origin)
    if (other) lines.push('', '【补充】', other)
    if (slug) lines.push('', `— cnmeme.wiki/词条/${slug}`)

    return { found: true, how, title, tags, usage, origin, other, slug, text: lines.join('\n') }
  } finally {
    try {
      db.close()
    } catch {
      /* 关不掉也不影响这次结果 */
    }
  }
}
