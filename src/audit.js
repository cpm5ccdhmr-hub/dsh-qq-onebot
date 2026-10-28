// 外发文字审计：本机路径 / 凭据特征，命中就整条拦下。
//
// 这是启发式闸，不是保险柜：它认得出常见的路径写法与密钥前缀，
// 但认不出「刚刚好没带前缀」的秘密。真正的边界仍然是 QQ 会话那只
// 本身没有本地工具（见 preset 工具限制）。
//
// 设计取舍：
// - 命中了就整条不发，不做「打码后再发」——半句话比不说更糟，打码还可能漏。
// - 只写日志，不往群里回提示：让群里知道「有东西被拦了」等于告诉所有人这里有闸。
// - 误杀风险主要来自英文技术讨论（`C:\`、`/home/`、`token: xxx` 在正常聊天里极少出现）。

const PATH_PATTERNS = [
  // Windows 盘符路径：C:\... / D:/...
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|，。；）)]{2,}/,
  // Unix 常见系统目录
  /(?:^|[\s"'(`])\/(?:home|Users|root|etc|var|opt|srv)\/[^\s"'<>|，。；）)]{2,}/,
  // file:// 链接
  /\bfile:\/\/[^\s"'<>)]+/i,
]

const SECRET_PATTERNS = [
  // OpenAI / DeepSeek 风格的 key
  /\bsk-[A-Za-z0-9_-]{16,}/,
  // GitHub token
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // Authorization 头
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  // key: value 形式的凭据
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=：]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
]

function firstHit(patterns, value) {
  for (const re of patterns) {
    const m = re.exec(value)
    if (m) return m[0].slice(0, 120)
  }
  return ''
}

/**
 * 检查一段要发出去的文字。
 * @param {string} text
 * @param {{ extraPatterns?: string[] }} [options]
 * @returns {{ ok: true } | { ok: false, kind: 'path'|'credential'|'custom', hit: string }}
 */
export function auditOutbound(text, options = {}) {
  const value = String(text ?? '')
  if (!value) return { ok: true }

  const path = firstHit(PATH_PATTERNS, value)
  if (path) return { ok: false, kind: 'path', hit: path }

  const credential = firstHit(SECRET_PATTERNS, value)
  if (credential) return { ok: false, kind: 'credential', hit: credential }

  for (const source of options.extraPatterns ?? []) {
    try {
      const re = new RegExp(source, 'i')
      const m = re.exec(value)
      if (m) return { ok: false, kind: 'custom', hit: m[0].slice(0, 120) }
    } catch {
      // 配错了的正则不该让整个发送卡死：跳过它，继续用内置规则
    }
  }

  return { ok: true }
}
