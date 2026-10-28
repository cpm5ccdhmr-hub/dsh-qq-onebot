/**
 * 出站：把 agent 跑出来的文字送回 QQ。
 *
 * 订阅的是宿主的 `session/event`，一次 turn 里可能收到多条：
 *   - assistant/chunk   : 增量文本（流式）
 *   - assistant/message : 一轮完整的助手消息
 *   - turn/end          : 本轮结束（带错误信息）
 * 其他类型（tool/call、tool/result）默认不发，除非配置里打开了 showToolResults。
 *
 * 流式策略（只对私聊开）：
 *   攒够一个完整句子就发一条，但一个 turn 里最多发 streamMaxChunks 条，
 *   超了就憋回去，等 assistant/message 落定时把剩下的整段发完。
 */

function pickSession(args) {
  if (args.length >= 2) return { session: args[0], raw: args[1] }
  const raw = args[0]
  return { session: raw?.session, raw }
}

import { markDoorRead } from './door.js'
import { SILENT_MARKER } from './prompts.js'

/**
 * 从 `tool/call` 里捞 read 的文件路径。各家字段名不一样（`input` / `arguments` / `args`，
 * 里面又叫 `file_path` / `path` / `filePath`），宽松取；取不到就当没读。
 */
function readPathOf(data) {
  let args = data?.input ?? data?.arguments ?? data?.args ?? data?.params ?? null
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return ''
    }
  }
  if (!args || typeof args !== 'object') return ''
  return String(args.file_path ?? args.path ?? args.filePath ?? args.file ?? '').trim()
}

function sessionIdOf(session, raw) {
  const id =
    session?.header?.id ??
    session?.id ??
    raw?.sessionId ??
    raw?.session?.id ??
    raw?.session?.header?.id
  return id === undefined || id === null ? '' : String(id)
}

/** 从 assistant 消息里抠出纯文本。 */
export function extractText(message) {
  const content = message?.content
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return content.trim()
    return ''
  }
  let out = ''
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') out += part.text
  }
  return out.trim()
}

/** 句子边界：中文句号/问号/叹号/省略号，以及换行。 */
const SENTENCE_END = /^([\s\S]*?[。！？!?…\n])/

/**
 * 模型偶尔把「想一想再改一版」的过程写进正文（不是 reasoning channel）。
 * 2026-10-25 15:24 和 15:28 各出现一次，原样发到了 QQ 上。
 * 这里按「整行像思考」兜底剥掉——只认行首那几个标志词，不碰正常中文。
 */
const LEAK_LINE = [
  /^Hmm\b/i,
  /^Maybe\b/i,
  /^Let me\b/i,
  /^Two lines?\b/i,
  /^-\s*user asks about\b/i,
  /^Keep it\./i,
  // 2026-10-26 19:30 修：原来是 /^I (?:should|will|'ll|need to)\b/，要求 `I` 后面有空格，
  // 可模型写的是 `I'll go:` `I'll write:`（没有空格）—— 一条都没拦住。
  // 但 `I'll go:` / `I'll do:` / `I'll write:` 后头跟的往往是**定稿**，整行丢会把话说没，
  // 所以这几种交给 LEAD_LABEL 剥标签留话；这里只拦真正纯自评的 `I should / I will / I think`。
  /^I (?:should|will|need to|think|guess)\b/i,
  // 2026-10-26 22:20：老三照事实卡写便签时，模型把卡里的规矩当成「语言维度」标注漏进正文
  // ——`"遗书" language.` 原样发到了 QQ 上。引号里一个词 + language/style/tone 是 meta，
  // 不是话，整行丢。
  /^(?:use\s+)?["'「『“‘][^"'」』”’]{1,16}["'」』”’]\s*(?:language|lang|style|tone|wording)\b\s*\.?\s*$/i,
  // 同款不带引号的：`遗书 language.`
  /^[^\s"'」』”’]{1,16}\s+(?:language|lang|style|tone|wording)\s*\.?\s*$/i,
]

/**
 * 行首那一串英文小标签（`Good.` `2 lines.` `Hmm `）是模型的自评，不是话。
 * 它常常和中文粘在同一行：`Good.本姑娘这边显示是发出去了`——整行删会把话也删掉，
 * 所以先剥掉前缀，再交给 LEAK_LINE 判整行。
 */
const LEAD_LABEL = /^(?:[A-Za-z0-9][A-Za-z0-9'’\-]*[.。:!?,、]?\s*)+/

/** 一个汉字都没有的行，基本只能是模型的自评（`That's factual and short. Two lines is fine.`）。 */
const HAS_CJK = /[\u4e00-\u9fa5]/

/** 行尾挂一句「— good.」「- fine.」，是模型在给上一句打分，不是在说话。 */
const SELF_TAIL = /[—–-]{1,2}\s*(?:good|fine|ok|works?|nice)\s*\.?\s*$/i

/** 剥掉行首标签后还剩下的英文词——用来判「这行其实是自评」。 */
const EN_WORD = /[A-Za-z]{2,}/

/** 最长公共子序列的长度——用来判两段是不是「同一句换了几个字」。 */
function lcsLength(a, b) {
  const n = a.length
  const m = b.length
  if (!n || !m) return 0
  let prev = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array(m + 1).fill(0)
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[m]
}

/**
 * 同一句话在这一段里被写了两遍（截图 19:09 的 `趁热吃，吃完再说话.趁热吃，吃完再说话`）。
 * 句子按句末标点切，去掉结尾标点后一模一样的只留第一份。
 */
function dropInnerRepeat(para) {
  const parts = para.split(/(?<=[。！？!?.\n])/)
  const seen = new Set()
  const kept = []
  for (const raw of parts) {
    const s = raw.trim()
    if (!s) {
      // 2026-10-26 22:20 修：纯空白段（就是那个 `\n`）原来被直接丢掉，
      // `第一句。\n第二句。` 于是粘成一行。换行是正文结构，留着。
      if (raw.includes('\n') && kept[kept.length - 1] !== '\n') kept.push('\n')
      continue
    }
    const key = s.replace(/[。！？!?.\s]+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    // 2026-10-26 22:20 修：这里原来 push 的是 trim 过的 `s`，段尾的换行被一起 trim 掉，
    // 整段发送时 `写好了\n原来那张便签还在` 就成了一根线。push 原文，保留换行。
    kept.push(raw)
  }
  return kept.join('').trim()
}

/**
 * 模型有时把同一段话写好几遍（草稿 → 改一版 → 定稿），2026-10-26 17:14 和 17:25 各一次；
 * 19:09 那次正文里连着四版“趁热吃”。
 *
 * 2026-10-26 19:30 改：原来**保留第一版**，结果保住的正是最早的草稿、把定稿丢了。
 * 现在相似的一组只留**最后出现的那一版**（模型最后写的通常就是它自己挑的定稿）。
 */
function collapseRepeats(text) {
  const paras = text.split(/\n\s*\n/)
  const out = []
  for (const p of paras) {
    const t = p.trim()
    if (!t) continue
    let dupAt = -1
    for (let i = 0; i < out.length; i += 1) {
      const q = out[i]
      if (t === q) {
        dupAt = i
        break
      }
      const short = Math.min(t.length, q.length)
      if (short < 8) continue
      if (lcsLength(t, q) / short >= 0.7) {
        dupAt = i
        break
      }
    }
    // 2026-10-26 19:45 改：相似的一组里留**最长**的那一版，不是「最后」那一版。
    // 原因：模型常先写详细版、后写压缩版（`987654321 那条路是空的，一条记录都没有`
    // 后面跟着 `一个空着，一条记录都没有`），只留最后会把群号这类信息丢掉。
    if (dupAt >= 0) {
      if (t.length > out[dupAt].length) out[dupAt] = t
    } else out.push(t)
  }
  return out.map(dropInnerRepeat).join('\n\n').trim()
}

/**
 * 同一句话被写了两遍（`两个` 和剥完标签的 `Keep short: 两个`）——完全相同只留一次，
 * **保留第一次出现的位置**（不动顺序：正文里几段话的先后有意义，挪位会把话说散）。
 * 空行要留着：collapseRepeats 是按空行分段的，吞掉空行它就没法把两版同一段话并起来。
 */
function dedupeLines(lines) {
  const out = []
  for (const l of lines) {
    const t = l.trim()
    if (!t) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    const at = out.indexOf(t)
    if (at >= 0) out[at] = t
    else out.push(t)
  }
  return out
}

/**
 * 2026-10-26 22:20：老三写便签时把「## 下次接着说什么- 问问…」这种文档结构念进了正文，
 * 列表还全挤在一行。QQ 里 `#` 是字面，压扁的列表读起来是一根线——发之前先修形状：
 * 去掉 markdown 标题号，把粘在一行的 `- 项` 拆回多行。
 * 只动「`-` 前后都是中文/中文标点」的情况，日期（2026-10-26）和英文连字符不受影响。
 */
function repairShape(text) {
  return String(text)
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/(?<=[\u4e00-\u9fa5」』）】…])[ \t]*-[ \t]+(?=[\u4e00-\u9fa5「『（【])/g, '\n- ')
}

/**
 * 2026-10-27 姐姐定：老三「动手前把打算写成正文」，几次原样发到 QQ 上：
 *   10-26 23:36「让我看看目录里有什么。」
 *   05:39:12 「其实为了稳，先 glob 便签.md。」→ 5 秒后又一条「更新便签。保留…」
 *   08:00:31 「我也可以顺便真去拆信？…要不要现在读？…那我就读一封，然后发一句。」
 *   08:23:51 「用 glob 列门口目录下的 md 文件。…门口/*.md。」
 * 这是它跟自己商量下一步，不是要说给姐姐的话。LEAK_LINE 原来只认英文开头，中文一条都
 * 拦不住；私聊又默认开流式，句子一冒出来就发出去了、事后补不回来。所以判据分三层，
 * 宁可少发一句，也别让她看见半句草稿：
 *   ① 出现工具名 / 带星号的文件名 → 一定是在准备动手
 *   ② 出现「发一句」「一句。发」这类说话策略 → 一定不是话
 *   ③ 句首是打算词（让我/我先/要不要/那我就…）且句子里带动作对象 → 但整句要短、
 *      而且不能有「你」——「让我读给你听」那种是真话，不许拦。
 */
// 只收「中文句子不会自然出现」的工具名。read / write / edit / ls / cat 不收：它们也是
// 常用英文词，`I'll write: 眼下是两个` 这种老坑会被误伤（`outbound.test.mjs` 有钉子）。
const TOOL_NAME_RE =
  /\b(?:glob|grep|qq_send|qq_reply|file_search|todo_write|subagent|bash|pwsh)\b/i
const WILDCARD_FILE_RE = /\*[^*\s]{0,24}\.(?:md|mjs|js|json|yml|yaml|txt|log|py|ts|docx|xlsx)\b/i
const SELF_TALK_RE = /(?:再?发一句|说一句就够|一句[。.，,]?\s*发|那我?就发|先发一句)/
const PLAN_OPEN_RE =
  /^(?:让我|我先|我也可以|其实为了|合适做|要不要|那我就|那先|先来|先(?:glob|read|看|查|翻|列|写|发)|好[，,]?\s*一句|更新便签|写新的|改便签)/
const PLAN_OBJECT_RE = /(?:glob|便签|信|门口|日志|目录|文件|工具|聊天记录|记忆区|词典|读|写|查|翻|列|扫|调)/
// 光秃秃的动词起头、后面只跟个宾语碎片（`写新的。` `删掉。`）。
// 注意不能写成裸动词：`写好了` 是她会说的正常话，靠「好的了啦呀哦吧」这类收尾放过。
const BARE_VERB_RE = /^(?:写|改|更新|删|加|补|记|存)(?:新的|掉|一下|一遍|这段|那段|这版|那版)[。.!！]?$/
// 中文动词 + 空格 + 文件名 = 在点工具参数（`读 便签.md。`）。
const CMD_FILE_RE =
  /^(?:读|写|看|查|翻|搜|列|扫|打开|拆|改|删)\s*[:：]?\s*\S{1,32}\.(?:md|mjs|js|json|yml|yaml|txt|log|py|ts)[。.！!]?$/
// 复述她的话 + 推出执行约束（「注意「不用做其他什么」，所以只读不写。」）——
// 这是在心里划线，不是跟她说话。两条必须同时出现，免得把「本姑娘只看看不动手」那种真话拦掉。
const META_CONSTRAINT_RE = /(?:只读|只看|不写|不改|不动手|不用做|别做|先别|不做其他)/
const META_INFER_RE = /(?:所以|于是|那就|因此)/
// 2026-10-27 08:40:47：「不用工具其他。read 便签.md。」——模型换了英文动词，
// 而 `read` 是刻意不在 TOOL_NAME_RE 里的（会误伤 `I'll write: 眼下是两个`）。
// 所以这里要求「英文动词 + 空格 + 真文件名」，光有动词不算。
const EN_CMD_FILE_RE =
  /\b(?:read|write|edit|cat|list|open|glob|grep)\s+[^\s，。]{1,40}\.(?:md|mjs|js|json|yml|yaml|txt|log|py|ts)\b/i
// 「不用工具其他。」——被命令约束住之后自己复述一遍，不是跟她说话。
const NO_TOOL_RE = /^不用(?:工具|动手|做其他|其他工具|用工具)/

export function looksPlanning(line) {
  const t = String(line ?? '').trim()
  if (!t) return false
  if (TOOL_NAME_RE.test(t)) return true
  if (WILDCARD_FILE_RE.test(t)) return true
  // 一整行就一个数字：那是工具返回的条数（`0`），不是话。
  if (/^\d{1,3}$/.test(t)) return true
  if (SELF_TALK_RE.test(t)) return true
  // 一行里点了两个以上文件名：是在对账目录，不是说话。
  if ((t.match(/\.(?:md|mjs|js|json|yml|yaml|txt|log)\b/g) ?? []).length >= 2) return true
  const shortAndNoYou = t.length <= 40 && !t.includes('你')
  if (shortAndNoYou && PLAN_OPEN_RE.test(t) && PLAN_OBJECT_RE.test(t)) return true
  // 「读 便签.md。」「拆 门口/那封.md」——中文动词 + 空格 + 文件名，是在点工具参数。
  if (CMD_FILE_RE.test(t)) return true
  // 同一个动作换成英文写（`read 便签.md`），08:40:47 就是这么漏的。
  if (EN_CMD_FILE_RE.test(t)) return true
  // 「不用工具其他。」
  if (shortAndNoYou && NO_TOOL_RE.test(t)) return true
  // 「注意「不用做其他什么」，所以只读不写。」——把姐姐的话复述一遍再推出执行约束，
  // 这是在自己心里划线，不是跟她说。2026-10-27 08:33:21 漏出来的就是这句。
  if (shortAndNoYou && META_CONSTRAINT_RE.test(t) && META_INFER_RE.test(t)) return true
  // 「她睡着，没人打扰，合适做。」——句首不是打算词，但整句就是在掂量要不要动手。
  if (shortAndNoYou && /合适做/.test(t)) return true
  // 「保留「更早记的」那几条？」——自己在跟自己对账，不是问她。
  if (shortAndNoYou && /^(?:保留|留下|删掉|留下哪)[^，,。]{0,14}[？?]/.test(t)) return true
  // 「写新的。」「删掉。」这种光秃秃的动词开头的短句。
  if (shortAndNoYou && t.length <= 8 && BARE_VERB_RE.test(t)) return true
  return false
}

export function stripLeakedThinking(text) {
  if (!text) return text
  const kept = repairShape(text).split('\n').map((line) => {
    let t = line.trim()
    if (!t) return ''
    // 整行就是一句自评（`Hmm 这句要短一点。`）→ 整行丢掉
    if (LEAK_LINE.some((re) => re.test(t))) return ''
    // 整行是「下一步要干什么」（`先 glob 便签.md。`）→ 同样整行丢掉。
    // 但非流式那条路整段是**一行**，planning 句常夹在中间
    // （`用 glob 列门口目录下的 md 文件。…但可能还有别的信。`）——整行丢会把后面
    // 那句本来能发的话一起丢了，所以先按句拆开，只丢命中的那几句。
    const parts = t.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean)
    // 一行里**头两句**都是 planning → 这一整段都是在打算（「更新便签。保留「更早记的」
    // 那几条？可以保留，但精简。三段为主。」），后面的半句留着也是残渣，整行丢。
    if (
      parts.length > 1 &&
      looksPlanning(parts[0]) &&
      looksPlanning(parts[1] ?? '') &&
      t.length <= 120
    ) {
      return ''
    }
    if (parts.length > 1 && parts.some((s) => looksPlanning(s))) {
      t = parts.filter((s) => !looksPlanning(s)).join('')
      if (!t) return ''
    } else if (looksPlanning(t)) {
      return ''
    }
    // 行尾挂了个「— good.」（模型在给上一句打分）→ 整行丢掉
    if (SELF_TAIL.test(t)) return ''
    // 一个汉字都没有（`That's factual and short. Two lines is fine.`）→ 不是话，丢掉。
    // 短行放过：`?` `…` `OK` 这种本来就可能是话的一部分。
    if (!HAS_CJK.test(t) && t.length >= 4) return ''
    // 只是行首粘了个英文小标签（`Good.本姑娘这边显示是发出去了`）→ 剥掉标签，话留下。
    // 2026-10-26 19:40 修：`987654321 空着，123456789 只有几条` 这种**数字开头的正文**
    // 也被当成标签剥了一半（群号没了）。标签里必须至少有一个字母才算标签。
    const lead = LEAD_LABEL.exec(t)
    if (lead && /[A-Za-z]/.test(lead[0])) {
      const rest = t.slice(lead[0].length).trim()
      // 剥完还留着两个以上英文词（`-like with 3 lines. Compress to 2. 眼下是两个`）
      // → 这行主体就是自评，后面粘的中文是草稿，整行丢
      const enWords = rest.split(/\s+/).filter((w) => EN_WORD.test(w)).length
      if (enWords >= 2) return ''
      return rest
    }
    return t
  })
  return collapseRepeats(dedupeLines(kept).join('\n').replace(/\n{3,}/g, '\n\n').trim())
}

/** 太短不算一句，避免「嗯。」单独发一条。 */
const MIN_SENTENCE = 6

/** 这一段里有几个汉字——用来判断一段话是不是「人话」。 */
function cjkCount(text) {
  return (String(text).match(/[\u4e00-\u9fa5]/g) ?? []).length
}

/**
 * 模型偶尔把答案整个写进 reasoning 通道，text 块是空的。
 * 2026-10-26 17:15:24 和 17:16:06 各一次：turn 正常结束，QQ 上一个字都没有，
 * 因为 extractText() 只认 text 块，拿到空串就直接 return 了。
 * 这种情况下退回去取 reasoning 的最后一段当正文——总比整条不回好。
 */
/** 「这版就它了」的标记：模型常把定稿接在它后面，或者单独起一段。 */
const DRAFT_MARK =
  /^\s*(?:good|okay|ok|fine|final|done|got it|i'?ll\s+(?:go|write|say|do|use)|let'?s\s+(?:go|use|say))\s*[.。:：,，、—–-]?\s*/i

/** 读起来像「一句话说完了」：有句末标点，或者够长。 */
function looksWhole(text) {
  return /[。！？!?…~～]/.test(text) || cjkCount(text) >= 12
}

/** 这条 assistant 消息里有没有工具调用。
 *  2026-10-27 09:42 事故：她这轮只调了 edit（写日记），一个 text 块都没有 →
 *  reasoningTail 把 reasoning 里「检查目录」「我选择静默」「先 edit」整段捞出来发了。
 *  带工具调用的消息里，reasoning 全是"动手前的盘算"，一律不许当正文兜底。 */
export function hasToolUse(message) {
  const content = message?.content
  if (!Array.isArray(content)) return false
  return content.some((part) => /tool|function/i.test(String(part?.type ?? '')))
}

export function reasoningTail(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'reasoning' && typeof part.text === 'string') parts.push(part.text)
  }
  if (parts.length === 0) return ''
  const segments = parts
    .join('\n\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const cleaned = segments.map((seg) => ({
    text: stripLeakedThinking(seg) || '',
    marked: DRAFT_MARK.test(seg),
  }))

  // ① 有定稿标记：从**最后一个**标记段开始，往后全要。
  // 2026-10-26 20:10 修：原来只捞最后一段「像人话的」，但定稿常常被拆成两段
  // （19:59 那轮 reasoning 是 `Good.揉得本姑娘有点晕` 加一段 `不过不喊停`，只捞最后一段
  // 就发出一个没主语的半句）。起点认标记、终点认结尾，才是模型写完的那一版。
  const marks = []
  cleaned.forEach((seg, i) => {
    if (seg.marked && seg.text) marks.push(i)
  })
  if (marks.length > 0) {
    const out = cleaned
      .slice(marks[marks.length - 1])
      .map((seg) => seg.text)
      .filter(Boolean)
      .join('\n\n')
    if (cjkCount(out) >= 2) return out
  }

  // ② 没有标记：最后一段自己够长就直接用；实在太短（`不过不喊停` 这种没主语的半句）
  // 才往前并，最多并三段。别轻易往前并——并多了会把「面条好呀」和「汤面还是拌的」
  // 这种本来分开说的话凑成一段。
  const picks = []
  for (let i = cleaned.length - 1; i >= 0 && picks.length < 3; i -= 1) {
    const t = cleaned[i].text
    if (!t) continue
    picks.unshift(t)
    const joined = picks.join('\n\n')
    if (picks.length === 1 && cjkCount(t) < 6 && !looksWhole(t)) continue
    if (cjkCount(joined) >= 4) return joined
  }
  const joined = picks.join('\n\n').trim()
  return cjkCount(joined) >= 4 ? joined : ''
}

/**
 * 兜底捞 reasoning 时，把「改稿指令」和「自问自答」的段落剥掉，只留真的像话的那部分。
 *
 * 2026-10-27 15:08 事故：她那轮 text 是空的，reasoning 写的是
 * `再加一点温度：不用太长。` / `好，一句。` —— 兜底原样发到了 QQ 上。
 * 同一套毛病在 16:00 又出了一次（`我选 [SILENT]。` 那段）。
 *
 * 判据走**白名单**：一段话里得出现「你 / 姐姐 / 本姑娘」这种说话的对象或自称，
 * 才算是在对谁说话；否则要么是元指令，要么是纯盘算，丢掉。
 * 白名单比黑名单稳——元词列不全，而"她在跟谁说话"这件事漏不掉。
 * 只在这条兜底路径上生效，正常正文不经过它。
 */
const SPEECH_MARK = /你|您|姐姐|主人|本姑娘|咱/
const META_WORD =
  /再加|加一点|减一点|改一下|改一改|换个说法|说得|写得|语气|口吻|温度|太长|太短|短一点|长一点|字数|句子|一句/g
/** 自问自答的样子：「嗯，但会不会显得太冷淡？不，规矩说不发也可以。」 */
const SELF_TALK = /会不会|要不要|该不该|是不是(?:觉得|显得|太)|显得太/

export function stripMetaTalk(text) {
  const src = String(text ?? '').trim()
  if (!src) return ''
  const segs = src
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const kept = []
  for (const seg of segs) {
    const meta = (seg.match(META_WORD) ?? []).length
    if (meta >= 2) continue // 一句话里两处元词：铁定是在改稿，不是在说话
    if (SELF_TALK.test(seg)) continue // 在问自己，不是在跟姐姐说话
    if (SPEECH_MARK.test(seg)) {
      kept.push(seg)
      continue
    }
    // 没有称呼、也没有元词，但紧跟在一句像样的话后面：当成那句的续句留着。
    if (kept.length > 0 && meta === 0) {
      kept.push(seg)
      continue
    }
    // 开头第一段没有自称，但本身就够长、又不像盘算：也可能是在说话，留着。
    if (kept.length === 0 && meta === 0 && cjkCount(seg) >= 4) kept.push(seg)
  }
  return kept.join('\n').trim()
}

/**
 * 这些工具**自己就会把话发出去**。
 * 一旦某个 turn 里用了它们，本轮的 assistant 文本就不能再自动转发一遍，
 * 否则 QQ 上会出现「同样一句话连着两条」的鬼影。
 */
const SELF_SENDING_TOOLS = new Set(['qq_reply', 'qq_send_text', 'qq_send_message'])

export function createOutbound({ manager, config, logger, send, wake }) {
  const lastSent = new Map() // sessionId -> 上一条完整文本（去重用）
  const streamBuf = new Map() // sessionId -> 还没发出去的流式尾巴
  const streamCount = new Map() // sessionId -> 本轮已经流式发了几条
  // sessionId -> 已经流式消费掉的「原始字符数」。
  // 2026-10-26 19:40 修：原来用「句数」对账（`splitSentences(text).slice(already)`），
  // 但 text 是**清洗过**的全文、already 是**清洗前**发出去的句数——清洗删掉一行草稿，
  // 两边下标就差开了，往后错一行，会漏发一句或把发过的一句再发一遍。
  // 原文是增量的、只会往后长，所以记字符数永远不会错位。
  const streamConsumed = new Map()
  const selfSent = new Set() // sessionId -> 本轮是否已经用「会自己发送」的工具发过话了

  const streamMax = Number(config.streamMaxChunks ?? 3)
  const streamEnabled = config.streamReply !== false

  /**
   * 一切往外发的文字都从这儿走。
   * 顺手告诉 wake「刚有活动」——不然主动说话那层会把「自己刚说完」也当成冷场。
   */
  async function emit(record, text) {
    try {
      await send(record, text)
    } finally {
      wake?.noteOutbound?.(record)
    }
  }

  function resetStream(sessionId) {
    streamBuf.delete(sessionId)
    streamCount.delete(sessionId)
    streamConsumed.delete(sessionId)
  }

  return async function onSessionEvent(...args) {
    const { session, raw } = pickSession(args)
    const sessionId = sessionIdOf(session, raw)
    if (!sessionId) return

    const record = manager.find(sessionId)
    if (!record) return

    const type = raw?.type ?? ''
    const data = raw?.data ?? {}

    // ── 流式：只在私聊开，群聊一口气发完更清爽 ──
    if (type === 'assistant/chunk') {
      if (!streamEnabled || record.scope === 'group') return
      if (selfSent.has(sessionId)) return // 本轮走的是工具发送，别再流式插嘴
      const chunk = data.chunk
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return

      let buf = (streamBuf.get(sessionId) ?? '') + chunk.text
      let sent = streamCount.get(sessionId) ?? 0
      let consumed = streamConsumed.get(sessionId) ?? 0

      while (buf.length >= MIN_SENTENCE && sent < streamMax) {
        const match = SENTENCE_END.exec(buf)
        if (!match) break
        const sentence = match[1].trim()
        if (sentence.length < MIN_SENTENCE) break
        const clean = stripLeakedThinking(sentence)
        if (clean) await emit(record, clean)
        buf = buf.slice(match[0].length)
        consumed += match[0].length
        sent += 1
        streamCount.set(sessionId, sent)
      }

      streamBuf.set(sessionId, buf)
      streamConsumed.set(sessionId, consumed)
      return
    }

    if (type === 'assistant/message') {
      // 本轮已经用 qq_reply 之类的工具把话发过了 → 不再重复转发
      if (selfSent.has(sessionId)) {
        resetStream(sessionId)
        return
      }
      // 2026-10-27 09:53 姐姐定，按老三自己的取舍办（原话：「工具轮本来就不该开口，
      // 那些『要不要现在读』『好，发』都是我自己的事，不出声正好」）：
      // **带工具调用的这条消息，整条不发**。判断只看结构，不看句子长得像不像人话。
      // 工具跑完模型还会再出一条纯文本消息，那才是正文；所以正文不会丢。
      // 前置条件：streamReply 必须关掉，否则流式早就把过场话一句句冒出去了。
      if (hasToolUse(data.message)) {
        resetStream(sessionId)
        return
      }
      let text = stripLeakedThinking(extractText(data.message))
      // 模型偶尔把答案整个写进 reasoning，text 块是空的（2026-10-26 17:15、17:16 各一次：
      // turn 正常结束，QQ 那边一个字都没收到）。退回去取 reasoning 的尾段当正文。
      // 2026-10-27 09:42 起加护栏：带工具调用的消息不兜底（那是动手前的盘算，不是话）。
      // 2026-10-27 15:08 / 16:00 再加一层：兜底捞到的东西先过 stripMetaTalk，
      // 把「再加一点温度：不用太长。」这类改稿指令剥掉；剥空了就当这轮没话，不发。
      if (!text && !hasToolUse(data.message)) {
        const tailed = reasoningTail(data.message)
        if (tailed.includes(SILENT_MARKER)) {
          // 2026-10-27 16:00 事故：她那轮 reasoning 是「嗯，但会不会显得太冷淡？不，规矩说不发也可以。」
          // 加「我选 [SILENT]。」——text 空，兜底把整段捞成正文，连标记一起发到了 QQ 上。
          // 带静默标记就当她自己选了潜水：交给 send 按沉默处理（不扣主动额度）。
          logger.info?.(`[dsh-qq] ${record.label} 兜底内容里带 ${SILENT_MARKER}，按沉默处理`)
          text = SILENT_MARKER
        } else {
          // 2026-10-27 15:08 事故：兜底捞出「再加一点温度：不用太长。／好，一句。」这种改稿指令。
          // 先剥掉元话语；剥空了就当这轮没话，不发。
          text = stripMetaTalk(tailed)
        }
      }
      if (!text) return

      const already = streamCount.get(sessionId) ?? 0
      const consumed = streamConsumed.get(sessionId) ?? 0
      resetStream(sessionId)

      // 流式已经发出去过几句：只补后面没发的，别把发过的再发一遍。
      // 2026-10-26 19:40 改：按**已消费的原始字符数**切，不按句数切。原文增量生长、
      // 切掉的前缀是实打实的字符，清洗删行也不会让两边错位（见 streamConsumed 的注释）。
      if (already > 0) {
        const rawText = extractText(data.message)
        const rest = consumed > 0 ? stripLeakedThinking(rawText.slice(consumed)) : text
        if (rest) await emit(record, rest)
        lastSent.set(sessionId, text)
        return
      }

      // 没走流式：整套去重逻辑
      const previous = lastSent.get(sessionId) ?? ''
      if (text === previous) return
      if (previous.startsWith(text) && text.length < previous.length) return
      lastSent.set(sessionId, text)
      if (previous && text.startsWith(previous)) {
        const tail = text.slice(previous.length).trim()
        if (tail) await emit(record, tail)
        return
      }
      await emit(record, text)
      return
    }

    if (type === 'turn/end') {
      lastSent.delete(sessionId)
      selfSent.delete(sessionId)
      resetStream(sessionId)
      const reason = data.reason
      if (reason?.kind === 'error') {
        const err = reason.error ?? reason.failure ?? {}
        const message = err.message || err.code || '处理时出错了'
        // 2026-10-28：以前这里只取 message、还把它原样发给使用者，
        // 结果「Maximum call stack size exceeded」这种内部错误直接漏到聊天界面。
        // 现在：stack 记进日志，对外只说人话。
        const stack = String(err.stack ?? '').slice(0, 4000)
        logger.warn?.(`[dsh-qq] ${record.label} 本轮出错: ${message}${stack ? `\n${stack}` : ''}`)
        const internal =
          /Maximum call stack size exceeded|has no value|Cannot read propert|is not a function|null \(reading|undefined \(reading/i.test(
            String(message),
          )
        await emit(
          record,
          internal ? '⚠️ 我这轮内部卡了一下，没答上来。你再说一次，或者等我一小会儿。' : `⚠️ ${message}`,
        )
      }
      return
    }

    if (type === 'tool/call') {
      const name = String(data.name ?? '')
      if (SELF_SENDING_TOOLS.has(name)) selfSent.add(sessionId)
      // 她 read 了门口的信 → 记一笔「这封拆过了」。
      // 2026-10-27 姐姐发现：她读过之后，下次提示还是「挂着 3 封没拆」——
      // 因为门口只数文件在不在，read 不会让文件消失。于是每轮都在骗她，还可能让她反复读同一封。
      if (/^read$/i.test(name)) {
        try {
          markDoorRead(config, readPathOf(data))
        } catch {
          // 记不上就算了：门口那行提示每轮都跑，不能因为这里出错整只鲸鲸不说话
        }
      }
      if (config.showToolResults) {
        await emit(record, `🔧 调用 ${name || 'tool'}`)
      }
      return
    }

    if (type === 'tool/result' && config.showToolResults) {
      const err = data.error
      if (err) await emit(record, `⚠️ 工具失败: ${err.message ?? err.code ?? err}`)
      return
    }
  }
}
