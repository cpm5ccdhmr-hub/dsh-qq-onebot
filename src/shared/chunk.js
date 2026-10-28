/**
 * 把长回复切成适合 QQ 单条发送的几块。
 *
 * 优先按段落切，其次按换行，再按句末标点，最后才硬切——
 * 尽量不让一句话被拦腰砍断，看着像人说话，而不是断流的机器。
 */
export function splitText(text, limit = 1500) {
  const source = String(text ?? '')
  const max = Math.max(200, Number(limit) || 1500)
  if (source.length <= max) return source ? [source] : []

  const chunks = []
  let rest = source

  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = -1
    for (const sep of ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', '，']) {
      const at = window.lastIndexOf(sep)
      if (at > max * 0.4) {
        cut = at + sep.length
        break
      }
    }
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.trim()) chunks.push(rest.trim())
  return chunks.filter(Boolean)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
