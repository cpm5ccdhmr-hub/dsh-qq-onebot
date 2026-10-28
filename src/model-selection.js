/**
 * 单 Agent 的模型切换（从 @deepseek-ai/dsh-agent/lib/model-selection.js 抄的最小版）。
 *
 * 为什么抄：宿主插件加载器不一定给插件解析 `@deepseek-ai/dsh-agent` 的子路径导出，
 * 而且我们只想用到“按轮覆盖请求路由”这一点，不需要官方那套“切换时插一条提醒”的
 * 额外行为（QQ 场景下那条提醒会白白吃掉上下文）。
 *
 * 用法：在 Agent 创建后、第一次 prompt 之前调用
 *   const selection = { current: undefined }
 *   const off = installModelSelection(agent.ctx, selection)
 *   selection.current = { provider: 'local_ollama', model: 'qwen2.5:3b-32k' } // 本轮走本地
 *   selection.current = undefined                                              // 本轮走默认
 *
 * `current = undefined` 时不拦截，照宿主默认（云端）走。
 */
export function installModelSelection(agentCtx, selection) {
  const take = () => {
    const chosen = selection.current
    selection.assembled =
      chosen === undefined ? undefined : { provider: chosen.provider, model: chosen.model }
    return selection.assembled
  }

  const offAssemble = agentCtx.on(
    'system-prompt/assemble',
    async (assembled, _context, next) => {
      // 注意：system-prompt/assemble 是 (assembly, context, next) 三段式；
      // 少写 context 会把 next 当成第二参拿到 undefined。
      const chosen = take()
      const base = await next()
      if (chosen === undefined) return base
      return {
        ...base,
        variables: {
          ...(assembled.variables ?? {}),
          ...(base.variables ?? {}),
          provider: chosen.provider,
          model: chosen.model,
        },
      }
    },
  )

  const offRequest = agentCtx.on(
    'agent/request',
    async (_payload, next) => {
      const resolved = await next()
      const chosen = selection.assembled
      if (chosen === undefined) return resolved
      const { reasoningEffort: _inherited, ...rest } = resolved
      return {
        ...rest,
        provider: chosen.provider,
        model: chosen.model,
        ...(chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort }),
      }
    },
  )

  return () => {
    try {
      offAssemble?.()
    } catch {
      /* ignore */
    }
    try {
      offRequest?.()
    } catch {
      /* ignore */
    }
  }
}
