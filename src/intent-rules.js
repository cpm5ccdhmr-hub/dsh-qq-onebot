/**
 * 意图路由的全部可调参数都放在插件根目录的 `intent-rules.json`，
 * 改规则不用碰代码。这里负责读文件、给默认值、把正则字符串编译成 RegExp。
 *
 * config 里同名 intent* 键（intentLocalProvider / intentLocalModel /
 * intentLocalMaxChars / intentLocalInGroups / intentLocalBaseURL /
 * intentLocalHistoryChars / intentLocalSystemChars / intentLocalMaxUserTurns）
 * 会覆盖 JSON 里的值。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rulesPath = join(here, '..', 'intent-rules.json')

const DEFAULTS = Object.freeze({
  taskPattern: '(帮|查|找|写|改|做|弄|搞|搜|翻译|解释|为什么|怎么|如何|哪个|哪儿|哪里|谁|什么|多少|几点|几号|代码|文件|路径|安装|下载|视频|链接|http|工具|记录|记住|提醒|总结|计划|方案|对比|推荐|买|价格|语音|图片|发我|看一下|打开|运行|测试|更新|B站|b站|QQ|qq|电脑|模型|tok|配置|设置|任务|工作|进度|日报|周报|bug|报错|错误|崩溃|崩了|卡住|卡死)',
  casualPattern:
    '^(在吗|在么|在不在|嗯+|恩+|哦+|噢+|好+|行|可以|对|是的?|不是|哈哈+|嘿嘿+|嘻嘻?|早|早安|早上好|午安|下午好|晚上好|晚安|拜拜|再见|嗨|hi|hello|嘿|想你|抱抱|亲亲|爱你|辛苦|谢谢|谢啦|么么|咋啦|怎么啦|干嘛呢?|吃了吗|睡了吗|醒了|我回来了|我睡了|我去忙了|来了)[呀啊呢嘛哦~～!！。.，,?？…]*$',
  faceOnlyPattern: '^(?:\\[[^\\]]{1,20}\\])+$',
  maxChars: 16,
  localGroups: false,
  localProvider: 'local_ollama',
  localModel: 'qwen2.5:3b-32k',
  localBaseURL: 'http://127.0.0.1:11434',
  historyChars: 14000,
  systemChars: 12000,
  maxUserTurns: 4,
})

let fileRules = {}
try {
  fileRules = JSON.parse(readFileSync(rulesPath, 'utf8'))
} catch {
  // 文件丢了/写坏了也不能让插件起不来，直接用默认值。
}

function compile(source, fallback, flags = 'i') {
  try {
    return new RegExp(String(source ?? fallback), flags)
  } catch {
    return new RegExp(fallback, flags)
  }
}

export function loadIntentRules(config = {}) {
  const pickString = (configKey, jsonKey, fallback) => {
    const fromConfig = String(config?.[configKey] ?? '').trim()
    if (fromConfig) return fromConfig
    const fromFile = String(fileRules?.[jsonKey] ?? '').trim()
    return fromFile || fallback
  }
  const pickNumber = (configKey, jsonKey, fallback) => {
    const n = Number(config?.[configKey] ?? fileRules?.[jsonKey] ?? fallback)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  return {
    taskRe: compile(pickString('intentTaskPattern', 'taskPattern', DEFAULTS.taskPattern), DEFAULTS.taskPattern),
    casualRe: compile(
      pickString('intentCasualPattern', 'casualPattern', DEFAULTS.casualPattern),
      DEFAULTS.casualPattern,
    ),
    faceOnlyRe: compile(
      pickString('intentFaceOnlyPattern', 'faceOnlyPattern', DEFAULTS.faceOnlyPattern),
      DEFAULTS.faceOnlyPattern,
    ),
    maxChars: Math.max(1, Number(config?.intentLocalMaxChars ?? fileRules?.maxChars ?? DEFAULTS.maxChars) || 16),
    localGroups: (config?.intentLocalInGroups ?? fileRules?.localGroups ?? DEFAULTS.localGroups) === true,
    provider: pickString('intentLocalProvider', 'localProvider', DEFAULTS.localProvider),
    model: pickString('intentLocalModel', 'localModel', DEFAULTS.localModel),
    baseURL: pickString('intentLocalBaseURL', 'localBaseURL', DEFAULTS.localBaseURL).replace(/\/+$/, ''),
    historyChars: pickNumber('intentLocalHistoryChars', 'historyChars', DEFAULTS.historyChars),
    systemChars: pickNumber('intentLocalSystemChars', 'systemChars', DEFAULTS.systemChars),
    maxUserTurns: pickNumber('intentLocalMaxUserTurns', 'maxUserTurns', DEFAULTS.maxUserTurns),
  }
}

export const DEFAULT_INTENT_RULES = loadIntentRules()
