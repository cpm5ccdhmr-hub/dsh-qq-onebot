/**
 * 群聊「非 @ 叫醒」判定。
 *
 * 由来（2026-10-25 姐姐提的）：
 *   「现在的群聊鲸鲸只会跟艾特的人回复」——@ 只是叫人的一种方式。
 *   群里叫名字、点名提问、催一句「在不在」，都是在叫它，不该因为少个 @ 就装没听见。
 *
 * 逻辑学自前辈 qq-bridge 0.2.1-r1 的 `evaluateWakeTriggerV2`
 * （`参考和对比用/qq-bridge-0.2.1-r1/src/bridge.js:10040`）和 `isDirectedAtAi`（同文件 :10573 附近）。
 * 三处照抄并写进注释的细节：
 *   1. 名字/关键词只匹配「本条消息自己的文字」，不要匹配带 `[引用 某人：原文]` 的拼接文本
 *      —— 引用一条恰好提到昵称的旧消息，不该算成在叫它。
 *   2. 短英文关键词（DS / R1）必须用词边界，否则 ADS、BDSM、DSL 全被当成在叫 DS。
 *   3. 「提问」不等于「有问号」，要看得出是冲 AI 问的（见 isDirectedAtAi）。
 *
 * 概率唤醒不在这里判 —— 那条要允许它看完沉默，由调用方单独掷骰子决定。
 */

/** 提到 AI / 本鲸的说法。命中后还要配一个疑问或挑战才算「在问它」。 */
const AI_WORDS =
  /deepseek|claude|chatgpt|gpt|gemini|qwen|llama|大肥鱼|小鲸鱼|鲸鱼娘|鲸鲸|d指导|d老师|d师傅|深度求索|\bds\b|人工智障|机器人|模型/

/** 挑战 / 比试口气：光提 AI 不够，得在较劲。 */
const CHALLENGE = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/

/** 疑问词。 */
const QUESTION = /[?？吗呢吧]|怎么|为什么|哪|谁/

/**
 * 这句话是不是在问 AI（而不是群里随便聊聊）。
 * 完全照搬前辈的六条，只把 AI 词表换成咱们这边的叫法。
 */
export function isDirectedAtAi(input) {
  const lower = String(input ?? '').toLowerCase()
  if (!lower) return false

  // ① 提到 AI + 疑问/挑战：「deepseek 行不行」「大肥鱼比 claude 强吗」
  if (AI_WORDS.test(lower) && (QUESTION.test(lower) || CHALLENGE.test(lower))) return true

  // ② 「你/您」十来个字内接疑问/比较：「你觉得呢」「你能不能不这么菜」
  if (
    /(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(
      lower,
    )
  ) {
    return true
  }

  // ③ 直接以「你是不是…」开场
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true

  // ④ 「你是 AI 还是真人」「你是真人吗」
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true

  // ⑤ 追问 / 催促：真人没被回应时就是这样喊的，一句 @ 都没有
  //    「在不在」「人呢」「理我」「怎么不说话」「别装死」
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true

  return false
}

/** 名字表里有没有出现在这句话里。太短的名字（1 个字）不算，防误伤。 */
function hasAnyName(lowerText, names) {
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim().toLowerCase()
    if (name.length < 2) continue
    if (lowerText.includes(name)) return true
  }
  return false
}

/** 关键词命中。短英文/数字（≤4 位）用词边界，中文直接 includes。 */
function matchKeyword(lowerText, keywords) {
  for (const raw of keywords ?? []) {
    const kw = String(raw ?? '').trim().toLowerCase()
    if (!kw) continue
    if (/^[a-z0-9]+$/.test(kw) && kw.length <= 4) {
      if (new RegExp(`\\b${kw}\\b`).test(lowerText)) return kw
    } else if (lowerText.includes(kw)) {
      return kw
    }
  }
  return null
}

/**
 * 判断这条消息算不算「在叫它」。
 *
 * @param {object} o
 * @param {string} o.plainText  本条消息自己的文字（不含引用原文、不含历史行）
 * @param {boolean} o.atMe      有没有 @ 我
 * @param {boolean} o.quotedMe  有没有引用我
 * @param {string[]} o.names    我的名字 + 别名（selfName、大肥鱼、鲸鲸…）
 * @param {object} o.triggers   config.groupWakeTriggers
 * @returns {string|null} 'atMention' | 'nameMention' | 'keyword:xx' | 'question' | null
 */
export function evaluateWakeTrigger({ plainText, atMe, quotedMe, names = [], triggers = {} }) {
  if (atMe || quotedMe) return 'atMention'

  const text = String(plainText ?? '').toLowerCase()
  if (!text) return null

  if (triggers.nameMention !== false && hasAnyName(text, names)) return 'nameMention'

  const kw = matchKeyword(text, triggers.keywords)
  if (kw) return `keyword:${kw}`

  if (triggers.question !== false && isDirectedAtAi(text)) return 'question'

  return null
}

/**
 * 概率唤醒：掷一次骰子，决定这条「没人叫它」的消息要不要顺带看一眼。
 * 这种唤醒允许它看完选择沉默（[SILENT]），所以调用方要区别对待。
 */
export function rollWakeProbability(p) {
  const prob = Number(p)
  if (!Number.isFinite(prob) || prob <= 0) return false
  return Math.random() < Math.min(1, prob)
}

/** 这个唤醒理由是不是「有人冲它来了」——是的话必须回，不许 [SILENT] 装死。 */
export function isAddressedWake(reason) {
  return reason === 'atMention' || reason === 'nameMention' || reason === 'question' || Boolean(reason?.startsWith?.('keyword:'))
}
