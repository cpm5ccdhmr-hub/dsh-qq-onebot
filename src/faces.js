/**
 * 表情包收藏夹。
 *
 * 两种条目：
 *  - `mface`：QQ 商城表情，靠 `emoji_id` + `emoji_package_id` 这一对身份证重发
 *  - `image`：一张本地图片（别人发过来、觉得以后想用的表情包），靠文件路径重发
 *
 * 为什么需要它：发商城表情必须同时给出 id，而 Agent 手上没有这份清单 ——
 * 它连「有哪些表情可发」都不知道，只能干瞪眼。所以在收到别人发表情包时，
 * 顺手把身份证记下来存盘；以后 `qq_mface` 不传 id 就从收藏里随机挑一个发。
 *
 * ⚠️ 收藏是有门槛的：默认什么都不收（faceCollectHint 留空 = 关），因为你希望只收某一类图，
 * 而不是把群里什么都存进来变成垃圾场。图片条目由 Agent 判断后主动调用
 * `qq_keep_face` 才进来，插件自己不自动保存图片。
 *
 * ⚠️ 图片必须复制进来，不能只记原路径：收到的图先落在 `图片缓存/` 里，
 * 那是会被 pruneCache 定时清理的地方（见 inbound.js）。只记路径的收藏，
 * 过几天就变成一堆 404 —— 所以 keepFace 会把文件搬进 `表情包/`。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const MAX_KEEP = 200

/**
 * 收藏文件：放在会话根目录（workspaceRoot）下，所有 QQ 会话共享一份。
 * 表情包是攒出来的资产，不该跟着某一次私聊一起过期。
 */
export function facesPath(config) {
  const base =
    String(config?.workspaceRoot ?? '').trim() ||
    String(config?.cwd ?? '').trim() ||
    process.cwd()
  return join(base, '表情包收藏.json')
}

/** 图片条目的稳定落点：收藏清单旁边的 `表情包/` 目录。 */
export function facesDir(config) {
  return join(dirname(facesPath(config)), '表情包')
}

/**
 * 把图片复制进 `表情包/`，返回稳定路径。
 * 原图多半在 `图片缓存/` 里，那地方会被定时清理，所以收藏必须留自己的副本。
 */
function storeImage(config, file) {
  const target = join(facesDir(config), basename(file))
  if (resolve(file) === resolve(target)) return target
  mkdirSync(facesDir(config), { recursive: true })
  copyFileSync(file, target)
  return target
}

function load(config) {
  const file = facesPath(config)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function save(config, list) {
  const file = facesPath(config)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(list.slice(-MAX_KEEP), null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** mface 的稳定去重键 */
function mfaceKey(f) {
  return `m:${f.packageId}/${f.emojiId}`
}

/** image 的稳定去重键（按路径） */
function imageKey(f) {
  return `i:${f.path}`
}

/**
 * 收到商城表情时调用：把能用的 id 记下来。
 * 缺 emojiId 或 packageId 的一律丢弃 —— 存着也发不出去。
 * @returns {number} 这次新增了几条
 */
export function rememberFaces(config, mfacesLog) {
  if (!Array.isArray(mfacesLog) || mfacesLog.length === 0) return 0
  const usable = mfacesLog.filter((f) => f?.emojiId && f?.packageId)
  if (usable.length === 0) return 0

  const list = load(config)
  const seen = new Set(list.map((f) => (f.kind === 'image' ? imageKey(f) : mfaceKey(f))))
  let added = 0
  for (const f of usable) {
    const entry = {
      kind: 'mface',
      emojiId: String(f.emojiId),
      packageId: String(f.packageId),
      key: String(f.key ?? ''),
      summary: String(f.summary ?? ''),
      at: new Date().toISOString(),
    }
    const k = mfaceKey(entry)
    if (seen.has(k)) continue
    seen.add(k)
    list.push(entry)
    added += 1
  }
  if (added > 0) save(config, list)
  return added
}

/**
 * 把一张本地图片收进收藏（Agent 判断值得收、或 faceCollectHint 命中后主动调用）。
 * @param {{ path: string, summary?: string }} input
 * @returns {{ ok: boolean, added: boolean, total: number, reason?: string }}
 */
export function keepFace(config, input) {
  const file = String(input?.path ?? '').trim()
  if (!file) return { ok: false, added: false, total: facesCount(config), reason: 'path 是空的' }
  if (!existsSync(file)) return { ok: false, added: false, total: facesCount(config), reason: `文件不存在：${file}` }

  const list = load(config)

  // 先搬进表情包目录再登记：只记缓存路径的话，缓存一清就全废
  let stored
  try {
    stored = storeImage(config, file)
  } catch (err) {
    return { ok: false, added: false, total: list.length, reason: `复制到表情包目录失败：${err?.message ?? err}` }
  }

  const entry = {
    kind: 'image',
    path: stored,
    summary: String(input?.summary ?? '').trim(),
    at: new Date().toISOString(),
  }
  const k = imageKey(entry)
  if (list.some((f) => f.kind === 'image' && imageKey(f) === k)) {
    return { ok: true, added: false, total: list.length }
  }
  if (list.length >= MAX_KEEP) list.shift()
  list.push(entry)
  const saved = save(config, list)
  return { ok: saved, added: saved, total: saved ? list.length : list.length - 1, reason: saved ? undefined : '写盘失败' }
}

/** 比对名字时把标点、空白、大小写都抹平：「求求了…」和「求求了」得算同一张。 */
function normName(value) {
  return String(value ?? '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

/**
 * 按名字挑一张收藏；挑不到就随机。
 *
 * 四级匹配，从严到松（旧版只有「收藏名包含关键词」这一级，于是
 * 「求求了」会命中「求你们别再嘲笑这些回复了」，而「发个求求了那种」这种说法
 * 一个都命中不了 —— 模型只好盲挑，最后变成随机发图）：
 *   ① 完全同名（忽略标点）
 *   ② 收藏名包含想要的关键词
 *   ③ 想要的那句话里包含某个收藏名（同上，都按去掉标点后比）
 *   ④ 都没中 → 随机（保证有图可发）
 */
export function pickFace(config, summary) {
  const list = load(config)
  if (list.length === 0) return undefined
  const wanted = normName(summary)
  if (wanted) {
    const named = list.filter((f) => normName(f.summary))
    const exact = named.find((f) => normName(f.summary) === wanted)
    if (exact) return exact
    const contains = named.find((f) => normName(f.summary).includes(wanted))
    if (contains) return contains
    // 反向：想要的话里提到了某张的名字（「发个求求了那种」→「求求了…」）；
    // 命中多张时取名字最长的那个，越具体越靠谱
    const hitBack = named
      .filter((f) => wanted.includes(normName(f.summary)))
      .sort((a, b) => normName(b.summary).length - normName(a.summary).length)[0]
    if (hitBack) return hitBack
  }
  return list[Math.floor(Math.random() * list.length)]
}

/**
 * 最近发过的图片/表情时间戳（只存内存）。
 *
 * 进程重启就清零 —— 这是防刷屏的软闸，不是计费账本，没必要落盘。
 * 姐姐的原话：「不能频繁使用这个，偶尔用用」。
 */
const sentAt = []

function pruneSent(now) {
  while (sentAt.length > 0 && now - sentAt[0] > 3600_000) sentAt.shift()
}

/**
 * 现在能不能再发一张图/表情。
 * @returns {{ allowed: boolean, reason?: string, sentLastHour: number }}
 */
export function faceSendState(config) {
  const now = Date.now()
  pruneSent(now)
  const gapMs = Math.max(0, Number(config?.faceSendGapMs ?? 0))
  const maxPerHour = Math.max(0, Number(config?.faceSendMaxPerHour ?? 0))
  const sentLastHour = sentAt.length

  if (gapMs > 0 && sentAt.length > 0) {
    const last = sentAt[sentAt.length - 1]
    if (now - last < gapMs) {
      const waitSec = Math.ceil((gapMs - (now - last)) / 1000)
      return {
        allowed: false,
        sentLastHour,
        reason: `刚发过一张了，${waitSec} 秒后才能再发（表情是点缀，不是刷屏用的）`,
      }
    }
  }
  if (maxPerHour > 0 && sentLastHour >= maxPerHour) {
    return {
      allowed: false,
      sentLastHour,
      reason: `这一小时已经发了 ${sentLastHour} 张，歇会儿 —— 这次先用文字说`,
    }
  }
  return { allowed: true, sentLastHour }
}

/** 记一次「发出去了」。 */
export function markFaceSent() {
  sentAt.push(Date.now())
  pruneSent(Date.now())
}

/**
 * 给提示词用的收藏摘要：只给名字，不给路径/id。
 * 模型得先知道有哪些图可选，才谈得上「按场景挑」。
 * @returns {{ total: number, names: string[] }}
 */
export function facesForPrompt(config, max = 10) {
  const list = load(config).filter((f) => String(f.summary ?? '').trim())
  const names = list.slice(-Math.max(1, max)).map((f) => String(f.summary).trim())
  return { total: load(config).length, names }
}

/** 列出收藏（给工具描述/命令用）。 */
export function listFaces(config, limit = 30) {
  return load(config).slice(-limit)
}

export function facesCount(config) {
  return load(config).length
}
