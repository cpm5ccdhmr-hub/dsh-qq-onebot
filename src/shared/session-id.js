import { createHash } from 'node:crypto'

/**
 * 把任意稳定的会话键折成一个 uuid 形态的字符串。
 *
 * 为什么要有这一步：QQ 侧的 peer 标识里可能带非法字符，而 DSH 的 SessionId
 * 会被用作目录名 / 索引键。用 sha256 折一次，长度固定、字符集安全、且同输入恒同输出。
 */
export function deriveSessionId(key) {
  const hex = createHash('sha256').update(String(key)).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * 会话键：同一个机器人账号下，私聊按 QQ 号、群聊按群号区分。
 * 形如 `qq:123456:private:10001` / `qq:123456:group:20002`。
 */
export function sessionKey(selfId, scope, peerId) {
  return `qq:${selfId}:${scope}:${peerId}`
}
