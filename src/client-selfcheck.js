/**
 * 客户端半端自检（issue #2 第 1 条：别静默地消失）
 * ============================================================================
 * 起因：2026-10-25 的设置页失踪——`dsh.client.inject` 里写了一个宿主没有的包，
 * 宿主把**整条 client bundle** 静默跳过：宿主侧照常跑、QQ 照常在线，
 * 只有浏览器侧那一页没上场。用户看到的是「设置里根本没有 QQ」，
 * 而 `$DSH_HOME` 下一个字都没有。同一个坑我们自己也踩过一次（包名对不上）。
 *
 * 这里能查的、且只有插件自己查得到的两件事：
 *   1. `client.js` 里 `__ModuleLoader__.load({ id })` 的 id 必须等于 `package.json.name`
 *      ——对不上，宿主认不出这条 bundle，设置页同样不出现。
 *   2. `dsh.client.inject` 是否为空——空的话浏览器半端没有可依赖的宿主模块。
 *
 * ⚠️ 不查「inject 里的包 Node 侧能不能 resolve」：实测
 *    `import.meta.resolve('@deepseek-ai/dsh-api-remotes')` 在 profile 目录和插件目录
 *    **都失败**（这些包打进 app.asar，由宿主浏览器的模块加载器处理）。
 *    拿它当判据只会每次都误报，把真问题淹掉。
 *
 * 3. inject 里出现已知的**废弃包名**（老文档抄来的那种，如裸的 `dsh-client-runtime`）
 *    ——不 resolve，只按名字比对，所以不会误报。这类名字宿主同样会静默跳过。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 已知的废弃 inject 包名 → 正确写法。只比对名字，不 resolve，所以不会有「本机没装就误报」。
 *
 * ⚠️ 只认**不带 scope 的裸名**：正确写法 `@deepseek-ai/dsh-client-runtime` 剥掉 scope 后
 * 和废弃的裸名一模一样，按包名剥 scope 比对会把正确写法也判错（第一版就这么写了，测试抓住的）。
 */
const DEPRECATED_INJECT = new Map([
  ['dsh-client-runtime', '@deepseek-ai/dsh-client-runtime'],
  ['dsh-client', '@deepseek-ai/dsh-client'],
])

/** 带 scope 的是新写法，不进废弃名单比对；只有裸名才去查。 */
function bareName(spec) {
  const name = String(spec ?? '').trim()
  return name.startsWith('@') ? null : name
}

/**
 * 从 client.js 源码里抠出 `__ModuleLoader__.load({ id: '...' })` 的 id。取不到返回 null。
 * 先把块注释剥掉——文件顶部的用法说明里就写着 `id: '<包名>'`，
 * 不剥的话第一个匹配到的是注释（第一次写这函数就撞了）。
 * 只剥 `/* *\/`，不剥 `//`：源码里到处是 `http://`，行注释一剥就误伤字符串。
 */
export function parseClientId(source) {
  if (typeof source !== 'string') return null
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = code.match(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]*?\bid\s*:\s*['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

/**
 * 纯函数：给两份文本，返回自检结果。拆出来是为了能单测（不碰文件系统）。
 * @returns {{ ok: boolean, problems: Array<{code:string,message:string}>, info: object }}
 */
export function inspectBundle({ pkgText, clientText } = {}) {
  const problems = []
  const info = { name: '', version: '', inject: [], clientId: null }

  let pkg = null
  try {
    pkg = JSON.parse(pkgText)
  } catch (err) {
    problems.push({ code: 'bad-package-json', message: `package.json 读不成 JSON：${err?.message ?? err}` })
  }

  if (pkg) {
    info.name = String(pkg.name ?? '')
    info.version = String(pkg.version ?? '')
    info.inject = Array.isArray(pkg?.dsh?.client?.inject) ? pkg.dsh.client.inject.map(String) : []
    info.clientId = parseClientId(clientText)

    if (!info.clientId) {
      problems.push({
        code: 'no-client-id',
        message: 'client.js 里找不到 __ModuleLoader__.load({ id }) —— 浏览器半端不会上场，设置页里看不到 QQ',
      })
    } else if (info.name && info.clientId !== info.name) {
      problems.push({
        code: 'client-id-mismatch',
        message:
          `client.js 的模块 id 是「${info.clientId}」，package.json 的 name 是「${info.name}」——` +
          '两者不一致时宿主会跳过整条 client bundle，设置页里看不到 QQ',
      })
    }

    if (info.inject.length === 0) {
      problems.push({
        code: 'no-inject',
        message: 'dsh.client.inject 是空的 —— 浏览器半端没有可依赖的宿主模块，装不上设置页',
      })
    }

    for (const spec of info.inject) {
      const good = DEPRECATED_INJECT.get(bareName(spec))
      if (good) {
        problems.push({
          code: 'deprecated-inject',
          message:
            `dsh.client.inject 里有废弃的包名「${spec}」——宿主认不出，会整条跳过 client bundle；` +
            `换成「${good}」`,
        })
      }
    }
  }

  return { ok: problems.length === 0, problems, info }
}

/**
 * 读包根目录里的 package.json / client.js 做一次自检，把结论写进日志。
 * 任何 IO 失败都只 warn，绝不阻塞插件启动（QQ 聊天本身不依赖设置页）。
 * @param {{warn?:Function, info?:Function}} logger
 * @param {string} [root] 包根目录（默认从本文件往上退一级）
 */
export function selfCheckClient(logger, root = fileURLToPath(new URL('..', import.meta.url))) {
  let pkgText = ''
  let clientText = ''
  try {
    pkgText = readFileSync(join(root, 'package.json'), 'utf8')
    clientText = readFileSync(join(root, 'client.js'), 'utf8')
  } catch (err) {
    logger?.warn?.(`客户端半端自检跳过（读不到自己的文件）: ${err?.message ?? err}`)
    return { ok: false, skipped: true, problems: [], info: {} }
  }

  const result = inspectBundle({ pkgText, clientText })
  if (!result.ok) {
    for (const p of result.problems) {
      logger?.warn?.(`客户端半端自检失败（${p.code}）：${p.message}`)
    }
    logger?.warn?.(
      '设置页不出现时先看这条日志；Node 侧解析不到 inject 里的包是正常的（由宿主浏览器端提供），别当错误。',
    )
    return result
  }
  logger?.info?.(
    `客户端半端自检通过：id=${result.info.name} v${result.info.version}，inject=[${result.info.inject.join(', ')}]`,
  )
  return result
}
