/**
 * 意图路由：短闲聊走本地 Ollama，复杂活/长消息照旧走云端。
 *
 * 2026-10-29 第一版口径（够用就好，不追求语义分类器）：
 * - 只按“消息长度 + 是否含任务关键词”分；短、没任务味的 → 本地。
 * - 群聊默认不切本地（人多、上下文长，省不了多少还容易答歪），配置可开。
 * - 本地 provider 由 `local-adapter.js` 注册：那个适配器会把长历史裁到最近几轮，
 *   所以本会话历史再长也能安全落到本地；这里只负责“这一轮用谁”。
 * - 本轮本地请求失败，下一轮自动回云端（request-error 监听把 available 拉黑 5 分钟）。
 */
import { installModelSelection } from './model-selection.js'
import { DEFAULT_INTENT_RULES, loadIntentRules } from './intent-rules.js'

export function classifyIntent(
  text,
  { isGroup = false, maxChars, localGroups, rules = DEFAULT_INTENT_RULES } = {},
) {
  const limit = maxChars ?? rules.maxChars
  const allowGroups = localGroups ?? rules.localGroups
  if (isGroup && !allowGroups) return { tier: 'cloud', reason: 'group' }
  let body = String(text ?? '').trim()
  if (!body) return { tier: 'cloud', reason: 'empty' }
  // 语音转写前缀只是标注，不算正文
  body = body.replace(/^\[语音(?:转文字)?\]\s*/u, '').trim()
  if (!body) return { tier: 'cloud', reason: 'empty' }
  if (body.length > limit) return { tier: 'cloud', reason: 'long' }
  if (rules.taskRe.test(body)) return { tier: 'cloud', reason: 'task' }
  if (rules.casualRe.test(body) || rules.faceOnlyRe.test(body)) return { tier: 'local', reason: 'casual' }
  // 短句、没有任务词，默认当闲聊——比“全部走云端”更省，误判成本也低（答歪了能重问）
  return { tier: 'local', reason: 'short' }
}

export function createIntentRouter({ config, logger, getLlm, llm: fixedLlm }) {
  const resolveLlm = typeof getLlm === 'function' ? getLlm : () => fixedLlm ?? null
  const enabled = config?.intentRoutingEnabled !== false
  const rules = loadIntentRules(config)
  const provider = rules.provider
  const model = rules.model
  const maxChars = rules.maxChars
  const localGroups = rules.localGroups

  let available = false
  let checking = null
  let lastCheck = 0
  let timer = null

  async function refresh(force = false) {
    if (!enabled) return false
    if (checking) return checking
    if (!force && Date.now() - lastCheck < 60_000) return available
    checking = (async () => {
      try {
        const llm = resolveLlm()
        if (typeof llm?.listModels !== 'function') {
          available = false
          return
        }
        const models = await llm.listModels(provider)
        const ids = (Array.isArray(models) ? models : []).map((m) =>
          String(typeof m === 'string' ? m : (m?.id ?? m?.model ?? '')),
        )
        const next = ids.includes(model)
        if (next !== available) {
          logger?.info?.(
            next
              ? `[intent] 本地模型已就绪：${provider}/${model}（短闲聊走本地，其余走云端）`
              : `[intent] 本地模型不可用：${provider}/${model}（全部走云端）`,
          )
        }
        available = next
      } catch (err) {
        if (available) logger?.warn?.(`[intent] 查本地模型失败，先全部走云端：${err?.message ?? err}`)
        available = false
      } finally {
        lastCheck = Date.now()
        checking = null
      }
    })()
    return checking
  }

  function ensureSelection(record) {
    if (!record?.agent?.ctx) {
      logger?.warn?.(
        `[intent] 拿不到 agent.ctx，无法安装模型切换：agentKeys=${Object.keys(record?.agent ?? {}).join(',')}` +
          ` ctxType=${typeof record?.agent?.ctx}`,
      )
      return null
    }
    if (record.modelSelection) return record.modelSelection
    const selection = { current: undefined, assembled: undefined }
    try {
      const offSelection = installModelSelection(record.agent.ctx, selection)
      const offError = record.agent.ctx.on('agent/request-error', (payload) => {
        if (payload?.provider !== provider) return
        // 用户主动取消不重试
        if (payload?.signal?.aborted) return
        available = false
        lastCheck = Date.now()
        selection.current = undefined
        selection.assembled = undefined
        logger?.warn?.(
          `[intent] 本地模型请求失败（${payload?.failure?.message ?? payload?.failure?.code ?? 'unknown'}），` +
            '这一轮原地重试云端；之后全部回云端，5 分钟后再探测',
        )
        // agent/request-error 是 waterfall：返回 retry 让宿主用云端重跑这一轮，
        // 不然本地 3B 一旦超长/答崩，用户就会直接收到一条报错。
        return { kind: 'retry' }
      })
      // 一轮结束后把本轮选择清掉：主动说话、定时唤醒等不走 inbound 的 followup
      // 不能继承上一轮“闲聊走本地”的选择，否则会拿 3B 去处理正事。
      const offTurnEnd = record.agent.ctx.on('agent/turn-stopping', () => {
        selection.current = undefined
        selection.assembled = undefined
      })
      record.disposeModelSelection = () => {
        offSelection?.()
        offError?.()
        offTurnEnd?.()
      }
      record.modelSelection = selection
    } catch (err) {
      logger?.warn?.(`[intent] 安装模型切换监听失败，本会话保持云端：${err?.message ?? err}`)
      record.modelSelection = null
      return null
    }
    return record.modelSelection
  }

  function route(record, body, { isGroup = false } = {}) {
    const decision = classifyIntent(body, { isGroup, maxChars, localGroups, rules })
    logger?.info?.(
      `[intent] 路由判定 tier=${decision.tier} reason=${decision.reason} ` +
        `len=${String(body ?? '').trim().length} promptTokens=${record?.promptTokens ?? '?'} ` +
        `available=${available} hasCtx=${Boolean(record?.agent?.ctx)}`,
    )
    const cloud = (why) => {
      const out = { ...decision, tier: 'cloud', reason: why }
      logger?.info?.(
        `[intent] 本轮走云端（${why}；promptTokens=${record?.promptTokens ?? '?'}；` +
          `available=${available}；hasCtx=${Boolean(record?.agent?.ctx)}）：${String(body ?? '').slice(0, 24)}`,
      )
      return out
    }
    if (!enabled) return cloud('disabled')
    if (decision.tier !== 'local') {
      const selection = ensureSelection(record)
      if (selection) selection.current = undefined
      return cloud(decision.reason)
    }
    if (!available) {
      const selection = ensureSelection(record)
      if (selection) selection.current = undefined
      // 插件刚启动时 llm 服务可能还没注册完；每条候选短句都再探一次，
      // 探到就下一轮生效，不用干等两分钟的定时器。
      void refresh(true)
      return cloud('local-unavailable')
    }
    const selection = ensureSelection(record)
    if (!selection) return cloud('no-selection')
    selection.current = { provider, model }
    logger?.info?.(`[intent] 本轮走本地 ${provider}/${model}：${String(body ?? '').slice(0, 24)}`)
    return decision
  }

  function start() {
    if (!enabled) {
      logger?.info?.('[intent] 意图路由关闭（intentRoutingEnabled=false），全部走云端')
      return
    }
    void refresh(true)
    timer = setInterval(() => void refresh(), 120_000)
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    start,
    stop,
    route,
    refresh,
    get available() {
      return available
    },
  }
}
