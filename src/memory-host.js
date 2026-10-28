/**
 * 记忆卡引擎的宿主外壳（2026-10-27 移植 surf CORE）。
 *
 * 核心逻辑全在 `memory-card.js`（从 surfcore 原样搬来的纯函数，不碰宿主）。
 * 这里只负责把它接进 QQ 插件：
 *   · 落盘目录：<QQ 根>/记忆卡/ ，一张卡跨所有 QQ 会话共享；
 *   · 入站消息 → inbox 追加（只追加、便宜），定时（10 分钟）+ 启动时跑一次维护；
 *   · 提示词注入：读 memory-card-prompt-qq.md（QQ 裁剪版）交给 prompts.js；
 *   · 给工具用的 add / status。
 *
 * 记忆卡自己会随时间淡化（targetClarity 衰减），重要与「最初」保清；记不清的不编。
 * 维护失败一律静默降级——记忆是加分项，不能因为它把聊天搞挂。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  resolveMemoryCardPaths,
  createEmptyCard,
  loadMemoryCard,
  normalizeMemoryCardConfig,
  maintainMemoryCard,
  saveMemoryCardOutputs,
  readPromptBlock,
  memoryCardStatus,
  appendMemoryInboxEvent,
  addManualMemory,
  ensureFullArchive,
} from './memory-card.js'

const MAINTAIN_INTERVAL_MS = 10 * 60 * 1000
const STARTUP_DELAY_MS = 8 * 1000

/** 记忆卡放哪：显式配置 > <QQ 根>/记忆卡。 */
export function resolveMemoryDir(config) {
  const explicit = String(config?.memoryCardDir ?? '').trim()
  if (explicit) return explicit
  const base =
    String(config?.workspaceRoot ?? '').trim() ||
    join(String(config?.cwd ?? '').trim() || process.cwd(), '会话')
  return join(base, '记忆卡')
}

let singleton = null

/** 工具里拿当前宿主；没初始化就返回 null，工具自己兜底报错。 */
export function getMemoryHost() {
  return singleton
}

/**
 * 建宿主、起维护定时器。返回 host 对象（也登记为模块单例）。
 * @param {{ config:object, logger:object, now?:()=>number }} deps
 */
export function initMemoryHost({ config, logger, now = () => Date.now() }) {
  const memoryDir = resolveMemoryDir(config)
  const paths = resolveMemoryCardPaths(memoryDir)
  const rawConfig = config?.memoryCard ?? {}
  const cardConfig = normalizeMemoryCardConfig(rawConfig)

  // 热重载 / 重放 apply 时，先收掉旧的定时器，别叠着跑两份。
  if (singleton) {
    try {
      singleton.dispose()
    } catch {
      /* ignore */
    }
  }

  const host = {
    dir: memoryDir,
    paths,
    /** 一条入站消息追加到 inbox（便宜，不解析不写卡）。 */
    addInbox(event) {
      try {
        return appendMemoryInboxEvent(paths, event)
      } catch {
        return false
      }
    },
    /** 读 inbox → 维护一次（摄取 + 衰减 + 压缩 + 写盘）。 */
    maintain({ forceDecay = false } = {}) {
      return runMaintain({ paths, config: cardConfig, logger, now, forceDecay })
    },
    /** 给提示词注入的 QQ 裁剪版；没内容返回空串。 */
    prompt() {
      try {
        const text = readPromptBlock(paths, 'qq').trim()
        return text
      } catch {
        return ''
      }
    },
    /** 手动加一条（工具用）。 */
    add({ text, title = '', importance, tags = [] }) {
      const card = loadMemoryCard(paths) || createEmptyCard(now())
      const result = addManualMemory(card, { text, title, importance, scope: 'qq', tags }, cardConfig, now())
      if (result?.added) {
        const saved = saveMemoryCardOutputs(paths, card, cardConfig, now())
        return { added: true, total: card.records.length, status: saved.status }
      }
      return { added: false, total: card?.records?.length ?? 0, reason: '内容重复或为空' }
    },
    /** 当前状态（容量 / 条数 / 各清晰度计数）。 */
    status() {
      const card = loadMemoryCard(paths) || createEmptyCard(now())
      return memoryCardStatus(card, cardConfig, now())
    },
    dispose() {
      if (timer) clearInterval(timer)
      if (startup) clearTimeout(startup)
      timer = null
      startup = null
      if (singleton === host) singleton = null
    },
  }

  // 先把全量档案（JSONL）建好，maintain 里归档才不会缺文件。
  try {
    ensureFullArchive(paths, cardConfig, now())
  } catch (err) {
    logger?.warn?.(`[memory] 初始化全量档案失败：${err?.message ?? err}`)
  }

  let timer = null
  let startup = setTimeout(() => {
    subscribeLoop()
  }, STARTUP_DELAY_MS)
  startup.unref?.()

  function subscribeLoop() {
    try {
      host.maintain()
    } catch (err) {
      logger?.warn?.(`[memory] 启动维护失败：${err?.message ?? err}`)
    }
    timer = setInterval(() => {
      try {
        host.maintain()
      } catch (err) {
        logger?.debug?.(`[memory] 定时维护失败：${err?.message ?? err}`)
      }
    }, MAINTAIN_INTERVAL_MS)
    timer.unref?.()
  }

  singleton = host
  logger?.info?.(`[memory] 记忆卡引擎已挂载：${memoryDir}`)
  return host
}

/**
 * 一次维护：把 inbox 读进来交给 maintainMemoryCard，成功后再把「已消费」的部分从
 * inbox 里裁掉。裁剪用「读到的长度」作界，期间新追加的字节原样留下——不丢并发写入。
 */
function runMaintain({ paths, config, logger, now, forceDecay }) {
  let raw = Buffer.alloc(0)
  try {
    if (existsSync(paths.inbox)) raw = readFileSync(paths.inbox)
  } catch {
    raw = Buffer.alloc(0)
  }
  const lines = raw.length ? raw.toString('utf8').split('\n') : []
  // 最后一段可能是半行（并发 append 写到一半），先不消费。
  const complete = raw.length > 0 && !raw.toString('utf8').endsWith('\n')
  const consume = complete ? lines.slice(0, -1) : lines
  let result
  try {
    result = maintainMemoryCard({
      paths,
      config,
      inboxLines: consume,
      now: now(),
      forceDecay,
      fullPaths: paths, // 同目录的全量档案；maintain 内部按 fullJsonl 等键写
      fullConfig: config,
    })
  } catch (err) {
    logger?.warn?.(`[memory] 维护失败：${err?.message ?? err}`)
    return { ok: false, error: String(err?.message ?? err) }
  }
  // 只裁掉确实消费过的前缀；期间新增的留下。
  try {
    if (raw.length) {
      const after = existsSync(paths.inbox) ? readFileSync(paths.inbox) : Buffer.alloc(0)
      const keep = after.length > raw.length ? after.subarray(raw.length) : Buffer.alloc(0)
      writeFileSync(paths.inbox, keep)
    }
  } catch (err) {
    logger?.debug?.(`[memory] 裁剪 inbox 失败：${err?.message ?? err}`)
  }
  return {
    ok: true,
    changed: Boolean(result?.changed),
    qq: result?.qq ?? 0,
    pet: result?.pet ?? 0,
    fullAdded: result?.full?.added ?? 0,
    level: result?.status?.level ?? 0,
    chars: result?.status?.chars ?? 0,
  }
}
