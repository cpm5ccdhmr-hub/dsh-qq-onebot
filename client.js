/**
 * dsh-qq —— 浏览器半端（**「设置」里的一页**）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（DSH 的约定，抄 dsh-bili-scroll）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                    // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 怎么进「设置」：往 `settings.section` 槽里注册一节，
 *    第一个参数的 `label` 就是设置页左侧导航里那一项。
 *
 * ⭐ 数据都走 `/api/dsh-qq/*`（后端在 src/index.js 里注册）：
 *    后端把改动写进 `$DSH_HOME/dsh-qq/settings.json`（**不动 profile 的 cordis.patch.yml**），
 *    并就地改运行中的 config，所以大部分项保存即生效。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  // ⚠️ 这里的 id 必须等于 package.json 的 name（浏览器模块身份 = manifest 包名）。
  // 1.0.0 起包名从 dsh-qq 改成 dsh-qq-onebot，这里漏改，0.2.x 上整条 client row
  // 就对不上、设置页不出现。别再手滑。
  id: 'dsh-qq-onebot',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    // 数据来源两条路（自动选第一个通的）：
    //   1) DSH 自己的 /api/dsh-qq —— 宿主 webServer 愿意把路由挂出来时用这条
    //   2) 插件自己在 127.0.0.1:34569 起的小服务 —— 2026-10-24 加的兜底：
    //      DSH 那边的路由表会「注册成功但请求 404」，实测绕不过去，
    //      所以插件自己做一块本地工作台（这也是官方教程里说的插件形态）。
    const API = '/api/dsh-qq'
    const LOCAL_API = 'http://127.0.0.1:34569/api/dsh-qq'
    let apiBase = null

    const resolveBase = async () => {
      if (apiBase) return apiBase
      const probe = async (base) => {
        try {
          const r = await fetch(base + '/status', { credentials: 'same-origin' })
          return r.ok ? base : null
        } catch {
          return null // 网络错 / 跨域 / 没起来，都算这条不通
        }
      }
      apiBase = (await probe(API)) || (await probe(LOCAL_API)) || API
      return apiBase
    }

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      // 把响应体也带上：404 时能分清「路由没挂上」和「路径写错了」
      let extra = ''
      try {
        const text = await res.text()
        if (text) extra = ' · ' + text.replace(/\s+/g, ' ').slice(0, 180)
      } catch { /* 读不出来就算了 */ }
      throw new Error('HTTP ' + res.status + why + extra)
    }
    const jget = async (p) => asJson(await fetch((await resolveBase()) + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch((await resolveBase()) + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-qq-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:680px;}
[data-qq-sec]{display:flex;flex-direction:column;gap:8px;}
[data-qq-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-row]{display:flex;align-items:center;gap:10px;}
[data-qq-col]{display:flex;flex-direction:column;gap:6px;}
[data-qq-grow]{flex:1;min-width:0;}
[data-qq-label]{font-size:13px;flex:none;min-width:168px;white-space:nowrap;}
@media (max-width:560px){[data-qq-row]{flex-wrap:wrap;}[data-qq-label]{min-width:100%;}}
[data-qq-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-qq-sw][data-on]{background:#3b82f6;}
[data-qq-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-qq-sw][data-on] i{left:19px;}
[data-qq-sw][disabled]{opacity:.45;cursor:default;}
[data-qq-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-qq-input]:focus{outline:none;border-color:#3b82f6;}
[data-qq-input][data-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}
[data-qq-area]{width:100%;box-sizing:border-box;min-height:90px;resize:vertical;padding:8px 9px;border-radius:8px;
  font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-qq-area]:focus{outline:none;border-color:#3b82f6;}
[data-qq-num]{width:104px;text-align:center;}
[data-qq-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-qq-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-qq-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-qq-btn][disabled]{opacity:.5;cursor:default;}
[data-qq-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-msg][data-warn]{color:#f59e0b;}
[data-qq-msg][data-good]{color:#22c55e;}
[data-qq-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-qq-dot]{flex:none;width:8px;height:8px;border-radius:50%;background:#9aa0a6;}
[data-qq-dot][data-on]{background:#22c55e;}
[data-qq-pill]{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
`

    /** 逗号 / 换行 / 空格分隔 → 数组；空串 → [] */
    const toList = (text) => String(text ?? '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const fromList = (arr) => (Array.isArray(arr) ? arr.join(', ') : '')

    function Switch({ on, disabled, title, onToggle }) {
      return h('button', {
        'data-qq-sw': '', 'data-on': on ? '' : undefined, disabled: disabled ? '' : undefined,
        title: title || '', type: 'button',
        onClick: () => !disabled && onToggle(!on),
      }, h('i'))
    }

    function Row({ label, hint, children }) {
      return h('div', { 'data-qq-col': '' },
        h('div', { 'data-qq-row': '' },
          h('div', { 'data-qq-label': '' }, label),
          h('div', { 'data-qq-grow': '' }, children)),
        hint ? h('div', { 'data-qq-note': '' }, hint) : null)
    }

    // 人设文件读没读到要常驻显示：读不到最容易「悄悄变普通助手」，
    // 只留一句日志 warn 的话，人在设置页上是看不见的。
    function personaNote(p) {
      if (!p || !p.file) return null
      return h('div', { 'data-qq-note': '' },
        p.ok
          ? `✓ 当前从 ${p.file} 读入 ${p.chars} 字（上面的文本框不生效）`
          : p.fromCache
            ? `⚠️ 这个文件读不到（${p.error || '文件不存在'}），用的是上次读到的那份缓存（${p.chars} 字）`
            : `⚠️ 这个文件读不到（${p.error || '文件不存在'}），现在用的是上面的文本框`)
    }

    function Panel() {
      const [st, setSt] = useState(null)
      const [val, setVal] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [draft, setDraft] = useState({})
      const [persona, setPersona] = useState(null)

      const load = useCallback(async () => {
        try {
          const [s, cfg] = await Promise.all([jget('/status'), jget('/settings')])
          setSt(s)
          setVal(cfg.values)
          setDraft({})
          setPersona(cfg.persona ?? null)
        } catch (e) {
          setMsg({ text: '读设置失败：' + e.message, tone: 'warn' })
        }
      }, [])

      useEffect(() => { load() }, [load])

      // 每 15 秒刷一次连接状态（别太勤，设置页不需要实时）
      useEffect(() => {
        const t = setInterval(async () => {
          try { setSt(await jget('/status')) } catch { /* 忽略 */ }
        }, 15000)
        return () => clearInterval(t)
      }, [])

      const patch = async (body, label) => {
        setBusy('save')
        setMsg(null)
        try {
          const r = await jpost('/settings', { patch: body })
          setVal(r.values)
          setDraft({})
          if (r.persona) setPersona({ ...r.persona })
          const tail = r.needReconnect ? '（点右边「重连」生效）' : r.needRestart ? '（有几项要重启宿主才生效）' : ''
          let text = `${label} 已保存${tail}`
          if (r.persona && r.persona.file) {
            text += r.persona.ok ? `，人设从文件读入 ${r.persona.chars} 字` : `，人设文件读不到（${r.persona.error}），先用着原来的`
          }
          setMsg({ text, tone: r.persona && r.persona.file && !r.persona.ok ? 'warn' : 'good' })
          setSt(await jget('/status'))
        } catch (e) {
          setMsg({ text: '保存失败：' + e.message, tone: 'warn' })
        } finally {
          setBusy('')
        }
      }

      const reconnect = async () => {
        setBusy('reconnect')
        setMsg(null)
        try {
          const r = await jpost('/reconnect')
          setMsg({ text: '已按 ' + r.wsUrl + ' 重连', tone: 'good' })
          setTimeout(load, 1200)
        } catch (e) {
          setMsg({ text: '重连失败：' + e.message, tone: 'warn' })
        } finally {
          setBusy('')
        }
      }

      if (!val) {
        return h('div', { 'data-qq-page': '' },
          h('div', { 'data-qq-note': '' }, msg ? msg.text : '读取中…'))
      }

      const v = (key) => (draft[key] !== undefined ? draft[key] : val[key])
      const setV = (key, value) => setDraft((d) => ({ ...d, [key]: value }))
      const num = (key, fallback = 0) => {
        const n = Number(v(key))
        return Number.isFinite(n) ? n : fallback
      }

      /** 文本 / 数字：失焦才存（边打边存会把半截词写进去） */
      const textField = (key, label, { hint, placeholder, mono, type = 'text', wrap }) => Row({
        label, hint,
        children: wrap
          ? null
          : h('input', {
            'data-qq-input': '', 'data-mono': mono ? '' : undefined, type: type === 'number' ? 'number' : 'text',
            'data-qq-num': type === 'number' ? '' : undefined,
            value: v(key) ?? '',
            placeholder: placeholder || '',
            onChange: (e) => setV(key, e.target.value),
            onBlur: (e) => {
              const raw = e.target.value
              const next = type === 'number' ? (raw === '' ? 0 : Number(raw)) : raw
              if (String(next) !== String(val[key] ?? '')) patch({ [key]: next }, label)
              else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
            },
          }),
      })

      const areaField = (key, label, { hint, rows = 4, mono } = {}) => h('div', { 'data-qq-col': '' },
        h('div', { 'data-qq-label': '' }, label),
        hint ? h('div', { 'data-qq-note': '' }, hint) : null,
        h('textarea', {
          'data-qq-area': '', 'data-mono': mono ? '' : undefined,
          rows,
          value: v(key) ?? '',
          onChange: (e) => setV(key, e.target.value),
          onBlur: (e) => {
            if (String(e.target.value) !== String(val[key] ?? '')) patch({ [key]: e.target.value }, label)
            else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
          },
        }))

      const listField = (key, label, { hint, placeholder } = {}) => Row({
        label, hint,
        children: h('input', {
          'data-qq-input': '', value: draft[key] !== undefined ? draft[key] : fromList(val[key]),
          placeholder: placeholder || '用逗号分隔',
          onChange: (e) => setV(key, e.target.value),
          onBlur: (e) => {
            const list = toList(e.target.value)
            if (toList(fromList(val[key])).join(',') !== list.join(',')) patch({ [key]: list }, label)
            else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
          },
        }),
      })

      const boolField = (key, label, hint) => h('div', { 'data-qq-row': '' },
        h('div', { 'data-qq-grow': '' },
          h('div', { 'data-qq-label': '' }, label),
          hint ? h('div', { 'data-qq-note': '' }, hint) : null),
        h(Switch, { on: Boolean(val[key]), onToggle: (next) => patch({ [key]: next }, label) }))

      const modeField = (key, label, hint) => Row({
        label, hint,
        children: h('select', {
          'data-qq-input': '', style: { width: 150, flex: 'none' },
          value: v(key) ?? 'open',
          onChange: (e) => patch({ [key]: e.target.value }, label),
        },
        h('option', { value: 'open' }, '全都接'),
        h('option', { value: 'allowlist' }, '只接名单里的'),
        h('option', { value: 'disabled' }, '关掉')),
      })

      const connected = Boolean(st && st.connected)

      return h('div', { 'data-qq-page': '' },
        /* ── 状态 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-row': '' },
            h('div', { 'data-qq-dot': '', 'data-on': connected ? '' : undefined }),
            h('div', { 'data-qq-label': '', 'data-qq-grow': '' },
              connected ? '已连上 NapCat' : '没连上 NapCat'),
            st ? h('span', { 'data-qq-pill': '' }, st.selfName ? `${st.selfName} (${st.selfId})` : (st.selfId || '未登录')) : null),
          h('div', { 'data-qq-kv': '' },
            '地址：', st ? st.wsUrl : '',
            st && st.home ? h('span', null, h('br'), '家目录：', st.home) : null,
            st && st.settingsFile ? h('span', null, h('br'), '设置文件：', st.settingsFile, '（', st.overrides, ' 条覆盖）') : null),
          h('div', { 'data-qq-row': '' },
            h('button', { 'data-qq-btn': '', disabled: busy === 'reconnect', onClick: reconnect }, '重连'),
            h('button', { 'data-qq-btn': '', onClick: load }, '重新读一遍')),
          msg ? h('div', { 'data-qq-msg': '', 'data-warn': msg.tone === 'warn' ? '' : undefined, 'data-good': msg.tone === 'good' ? '' : undefined }, msg.text) : null),

        /* ── 连接 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '连接'),
          textField('wsUrl', 'NapCat 的 WebSocket 地址', {
            hint: 'OneBot 11 正向 WebSocket。NapCat 里开的「正向 WS」默认是 ws://127.0.0.1:3001。改完点上面的「重连」。',
            mono: true,
          }),
          textField('accessToken', 'access token', {
            hint: '跟 NapCat 配置里那一串要一致。只在本机回环可以留空。',
            mono: true,
          }),
          textField('selfId', '机器人自己的 QQ 号', {
            hint: '留空就启动时自动问 NapCat 要（一般不用填）。',
          })),

        /* ── 它是谁 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '它是谁（人设）'),
          areaField('persona', '人设', {
            hint: '名字、性格、怎么称呼对方、有什么小习惯，都写这儿。留空 = 一个没名字、说话正常的普通助手（插件不自带任何角色）。',
            rows: 6,
          }),
          textField('personaFile', '人设文件（地址）', {
            hint: '填了就从文件读人设，盖掉上面的文本框 —— 想让人设跟某个 .md 一起改就填这里。文件读不到时不会把角色弄没，会继续用文本框里的。',
            mono: true,
            placeholder: 'D:/某个角色.md（留空 = 只用上面的文本框）',
          }),
          personaNote(persona),
          textField('ownerLabel', '在群里怎么称呼主人', { hint: '例如「老板」「老大」。', placeholder: '主人' })),

        /* ── 补充提示词 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '补充提示词（追加在内置聊天规矩后面）'),
          areaField('directPrompt', '私聊补充', { rows: 4 }),
          areaField('groupPrompt', '群聊补充', { rows: 6 })),

        /* ── 记忆区 / 工作区 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '记忆区与工作区'),
          textField('workspaceRoot', '会话目录根（记忆区在这儿）', {
            hint: '每个私聊 / 每个群在这里各有一个子目录（群_123456 / 私聊_10001），里面的「记忆区/」就是这个会话自己的日记和大纲。留空 = <工作目录>/会话。改完要重启宿主。',
            mono: true,
            placeholder: 'D:/QQ会话（留空就用默认）',
          }),
          boolField('isolateByPeer', '每个会话各自一个目录与记忆区', '关掉的话所有群聊共用宿主的工作目录，别关。改完要重启宿主。')),

        /* ── 群里怎么说话 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '群里怎么说话'),
          boolField('requireMention', '必须 @ 才接话', '关掉的话，群里每句话它都想接——除非你就是要这个效果。'),
          textField('groupWakeMs', '被 @ 之后多久内不用再 @（毫秒）', {
            hint: '默认 60000（1 分钟）。窗口按「群 + 人」算：只有当初 @ 它的那个人能续，别人说话不蹭。',
            type: 'number',
          }),
          textField('groupReplyGapMs', '同一个人两次回复至少隔多久（毫秒）', {
            hint: '默认 20000。中间来的消息不丢，攒着下次一起看见——这就是「均匀地回几次」。0 = 不限。',
            type: 'number',
          }),
          textField('groupMinGapMs', '群里两条消息之间至少隔多久（毫秒）', {
            hint: '默认 4000，防风控。',
            type: 'number',
          }),
          textField('rateLimitPerMin', '每分钟最多发几条', { hint: '默认 12。0 = 不限。被风控往往不是说了什么，是回得太多。', type: 'number' }),
          textField('historyLimit', '每次带多少条群历史', { hint: '默认 20。0 = 不带历史（它会不知道刚才在聊什么）。', type: 'number' })),

        /* ── 谁能跟它说话 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '谁能跟它说话'),
          modeField('privateMode', '私聊', '「只接名单里的」时要填下面的私聊白名单。'),
          listField('privateAllow', '私聊白名单', { hint: 'QQ 号，用逗号分隔。' }),
          modeField('groupMode', '群聊', '「关掉」= 群里完全不理它。'),
          listField('groupAllow', '群聊白名单', { hint: '群号，用逗号分隔。' }),
          listField('ownerIds', '谁是主人（QQ 号）', {
            hint: '这些人在群里说话会标上「主人」的称呼，问本机的事也正常答；其他人一律当陌生人。留空 = 不区分。',
          })),

        /* ── 同类机器人 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '同类机器人（另一个 bot）'),
          boolField('botChatEnabled', '允许它和同类聊天 / 回怼', '默认关：同类说啥都不理，连 @ 也不接。打开之后才会顶嘴——被骂了先看是不是在说它自己。'),
          listField('peerBots', '同类机器人的 QQ 号', { hint: '填了才认得出「这句是别的机器人发的」。' })),

        /* ── 主动说话 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '主动说话（冷场时给一次开口的机会）'),
          boolField('proactiveEnabled', '安静久了允许它主动说一句', '默认开。打开后，会话安静到「安静多久」那个时长，给它一次主动开口的机会——说不说自己判断，不想说就零成本跳过。'),
          textField('proactiveSilentMs', '安静多久之后给机会（毫秒）', {
            hint: '默认 1200000（20 分钟）。说完一句话会重新计时，不会隔几分钟又问一遍。',
            type: 'number',
          }),
          textField('proactiveMaxPerDay', '每天最多主动几次', { hint: '默认 6。连着 3 次没人接就当天闭嘴。', type: 'number' }),
          textField('proactiveQuietHours', '静默时段（这期间不主动）', {
            hint: '默认 23:00-08:00。格式「开始-结束」，24 小时制。',
            mono: true,
          }),
          textField('mergeWindowMs', '连发合并窗口（毫秒）', {
            hint: '默认 5000。同一个人一口气发三条，等这么一会儿并成一轮再回，别回三遍。只在私聊生效。',
            type: 'number',
          })),

        /* ── 作息 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '作息（几点犯困、几点睡）'),
          boolField('sleepMode', '启用作息', '关掉 = 它不分白天黑夜，什么时候都正常回。'),
          textField('bedtimeAt', '几点提醒它去睡', { hint: '默认 23:30。每个会话每天只提醒一次。', mono: true }),
          textField('sleepFrom', '夜里从几点开始不按住消息', {
            hint: '默认 00:00。这段里收到的私聊先攒着，出时段时一次性交出去（附「昨晚你发来这几条」）。',
            mono: true,
          }),
          textField('sleepTo', '攒到几点交出去', { hint: '默认 08:00。', mono: true })),

        /* ── 其它 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '其它'),
          boolField('debug', '输出调试日志', '日志落在会话目录根的 dsh-qq-debug.log（带 UTC 时间戳）。'),
          textField('textChunkLimit', '单条消息最大字数', { hint: '超出按段落/句号切成多条发。', type: 'number' }),
          textField('splitDelayMs', '分条之间的间隔（毫秒）', { type: 'number' })),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-qq')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-qq: 设置页样式')

        // 0.2.1 里服务直接挂在 ctx 上（官方插件写的就是 ctx.slots）；ctx.get 只作旧式兜底。
        const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        if (!slots) {
          console.error('[dsh-qq] slots 服务不可用，设置页挂不上去')
          return
        }
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-qq', order: 40, label: 'QQ' },
          () => h(Panel),
        ))
      },
    }
  },
})
