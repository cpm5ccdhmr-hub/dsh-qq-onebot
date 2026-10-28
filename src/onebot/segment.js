/**
 * OneBot 11 消息段的解析与组装。
 *
 * NapCat 默认 `messagePostFormat: 'array'`，但我们两种都兜住：
 * 万一用户配成了字符串格式（带 CQ 码），也要能读。
 */

const CQ_RE = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g
const CQ_UNESCAPE = [
  ['&#91;', '['],
  ['&#93;', ']'],
  ['&#44;', ','],
  ['&amp;', '&'],
]

function unescapeCQ(value) {
  let out = value
  for (const [from, to] of CQ_UNESCAPE) out = out.split(from).join(to)
  return out
}

/** 把 CQ 码字符串解析成消息段数组。 */
export function parseCQString(source) {
  const text = String(source ?? '')
  const segments = []
  let cursor = 0
  for (const match of text.matchAll(CQ_RE)) {
    if (match.index > cursor) {
      segments.push({ type: 'text', data: { text: text.slice(cursor, match.index) } })
    }
    const data = {}
    for (const pair of (match[2] || '').replace(/^,/, '').split(',')) {
      if (!pair) continue
      const at = pair.indexOf('=')
      if (at < 0) continue
      data[pair.slice(0, at)] = unescapeCQ(pair.slice(at + 1))
    }
    segments.push({ type: match[1], data })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ type: 'text', data: { text: text.slice(cursor) } })
  return segments
}

/** 统一成消息段数组，无论上游给的是数组还是 CQ 码字符串。 */
export /**
 * 从 mface 段里挖出「表情包身份证」：emoji_id + emoji_package_id。
 *
 * 有了这两个 id 才能反过来把同一个表情再发出去（`qq_mface` 要用）。
 * 不同 QQ 版本字段名不一样，CDN 地址里也藏着 id，能挖就挖。
 */
function pickEmoji(data) {
  const url = String(data?.url || data?.file || '')
  let packageId = String(data?.emoji_package_id ?? data?.package_id ?? '')
  let emojiId = String(data?.emoji_id ?? data?.emojiId ?? '')
  if (!emojiId || !packageId) {
    // https://gxh.vip.qq.com/club/item/parcel/item/{packageId}/{emojiId}/raw300.gif
    const matched = url.match(/item\/([^/]+)\/([^/]+)\//)
    if (matched) {
      if (!packageId) packageId = matched[1]
      if (!emojiId) emojiId = matched[2]
    }
  }
  return { emojiId, packageId, key: String(data?.key ?? '') }
}

function toSegments(message) {
  if (Array.isArray(message)) return message
  if (typeof message === 'string') {
    // 不是 CQ 码的裸字符串，直接当文本
    if (!message.includes('[CQ:')) return [{ type: 'text', data: { text: message } }]
    return parseCQString(message)
  }
  if (message && typeof message === 'object' && Array.isArray(message.data)) return message.data
  return []
}

/**
 * 合并转发的 id 是从桥接那头传回来的，不能当可信输入直接塞进 RPC。
 *
 * 只放行一路字符、长度卡死 256（跟前辈 qq-bridge 的 `sanitizeForwardId` 一个口径）。
 */
export function sanitizeForwardId(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s.length > 256) return ''
  return /^[\w:.\-/=+@]+$/.test(s) ? s : ''
}

/**
 * 各家桥接给的转发 id 字段名不一样：`id` / `res_id` / `file_id` / `forward_id`。
 * 挨个试，第一个过了消毒的就算。
 */
export function forwardIdFromData(data) {
  if (!data || typeof data !== 'object') return ''
  for (const key of ['id', 'res_id', 'file_id', 'forward_id']) {
    const v = data[key]
    if (v === undefined || v === null || v === '') continue
    const ok = sanitizeForwardId(v)
    if (ok) return ok
  }
  return ''
}

/**
 * 把入站消息读成「给人看的一句话 + 结构信息」。
 *
 * @param {unknown} message   OneBot 原始 message 字段
 * @param {{selfId: string, selfName?: string}} options
 */
export function readMessage(message, { selfId, selfName = '' } = {}) {
  const segments = toSegments(message)
  const self = String(selfId ?? '')

  let text = ''
  const images = []
  const files = []
  const records = []
  const mfaces = []
  const atNames = []
  let atMe = false
  let atAll = false
  let replyId = null
  let poke = false
  // 合并转发：段里只有个 id，内容得另外调 get_forward_msg 取。
  // 这个函数是同步的，取不了网络，所以只把 id 交出去，由 inbound 那边补。
  const forwards = []

  for (const seg of segments) {
    const type = seg?.type
    const data = seg?.data ?? {}
    switch (type) {
      case 'text':
        text += data.text ?? ''
        break
      case 'at': {
        const qq = String(data.qq ?? '')
        if (qq === 'all') {
          atAll = true
          text += '@全体成员'
        } else if (qq === self) {
          atMe = true
          text += `@${selfName || '机器人'}`
        } else {
          text += `@${data.name || qq}`
          atNames.push(qq)
        }
        break
      }
      case 'image':
        images.push(data.url || data.file || '')
        text += '[图片]'
        break
      case 'face':
        text += `[表情${data.id ?? ''}]`
        break
      case 'mface':
        // 表情包 ≠ 图片：它是"语气"，不是"内容"。单独收起来，别混进 images 让 agent 去描述画面。
        mfaces.push({
          url: data.url || data.file || '',
          summary: data.summary || '',
          ...pickEmoji(data),
        })
        text += '[表情包]'
        break
      case 'record':
        records.push({
          file: data.file || '',
          url: data.url || '',
          path: data.path || '',
          fileSize: data.file_size || '',
          duration: data.duration || '',
        })
        text += '[语音]'
        break
      case 'video':
        text += '[视频]'
        break
      case 'file':
        files.push({ name: data.name || '', file: data.file || '', url: data.url || '' })
        text += `[文件 ${data.name || ''}]`
        break
      case 'reply':
        replyId = data.id === undefined ? null : String(data.id)
        break
      case 'forward':
        forwards.push({ id: forwardIdFromData(data) })
        text += '[合并转发]'
        break
      case 'json':
      case 'xml':
        text += '[卡片消息]'
        break
      case 'poke':
        poke = true
        text += '[戳一戳]'
        break
      case 'dice':
        text += '[骰子]'
        break
      case 'rps':
        text += '[猜拳]'
        break
      case 'shake':
        text += '[窗口抖动]'
        break
      case 'location':
        text += '[位置]'
        break
      case 'music':
        text += '[音乐分享]'
        break
      default:
        if (type) text += `[${type}]`
        break
    }
  }

  return {
    text: text.trim(),
    images,
    files,
    records,
    mfaces,
    atNames,
    atMe,
    atAll,
    replyId,
    poke,
    forwards,
  }
}

/** 文本 → 出站消息段。只做纯文本，图片之类交给工具层。 */
export function textSegments(text) {
  const value = String(text ?? '')
  return value ? [{ type: 'text', data: { text: value } }] : []
}
