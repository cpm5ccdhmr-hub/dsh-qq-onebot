/**
 * 语音条（2026-10-27 移植 surf CORE 的 record 段）。
 *
 * 链路：本地 TTS 合成 24kHz 单声道 WAV 落盘 → 塞进 OneBot `record` 段
 * `{type:'record',data:{file:'base64://...'}}` → 由 NapCat 自带 ffmpeg 转 NT SILK。
 * 不做本地预转码；发完用 get_msg 回读，确认 record 段真在消息里才算发出。
 *
 * TTS 用 Windows 自带的 SAPI（System.Speech），走 powershell 合成，
 * 不额外依赖第三方库；坏处是音色就是系统那几个。要换更好听的音色，
 * 以后接火山/其它 TTS 只要保持 `synthesizeWav` 的返回形状即可。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import {
  existsSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const pexec = promisify(execFile)

/** 从 WAV 头（或第一个 data 块）读时长毫秒；失败返回 0。 */
export function wavDurationMs(buf) {
  try {
    let patched = null
    let best = null
    let fmt = null
    let offset = 12
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4)
      const size = buf.readUInt32LE(offset + 4)
      const start = offset + 8
      if (start + size > buf.length) {
        if (id === 'data' && patched && fmt) return Math.round((patched / fmt.blockAlign / fmt.sampleRate) * 1000)
        break
      }
      if (id === 'fmt ' && size >= 16) {
        const audioFormat = buf.readUInt16LE(start)
        const channels = buf.readUInt16LE(start + 2)
        const sampleRate = buf.readUInt32LE(start + 4)
        const blockAlign = buf.readUInt16LE(start + 12)
        const bitsPerSample = buf.readUInt16LE(start + 14)
        fmt = { audioFormat, channels, sampleRate, blockAlign, bitsPerSample }
      } else if (id === 'data') {
        best = fmt ? Math.round((size / fmt.blockAlign / fmt.sampleRate) * 1000) : null
        break
      }
      offset = start + size + (size % 2)
    }
    return best ?? 0
  } catch {
    return 0
  }
}

/** 语音缓存目录：显式配置 > <QQ 根>/语音缓存。 */
export function voiceCacheDir(config) {
  const explicit = String(config?.voiceCacheDir ?? '').trim()
  if (explicit) return explicit
  const base =
    String(config?.workspaceRoot ?? '').trim() ||
    join(String(config?.cwd ?? '').trim() || process.cwd(), '会话')
  return join(base, '语音缓存')
}

function psQuote(s) {
  return String(s).replace(/'/g, "''")
}

/**
 * 合成一段 24kHz 单声道 WAV。按文本内容寻址缓存，重复句子不重复合成。
 * @returns {Promise<{path:string, durationMs:number, cached:boolean}>}
 */
export async function synthesizeWav({ text, cacheDir, voice = '', rate = 0, timeoutMs = 40000 }) {
  const clean = String(text ?? '').trim()
  if (!clean) throw new Error('语音文本为空')
  if (process.platform !== 'win32') throw new Error('本地 TTS 目前只支持 Windows(SAPI)')
  mkdirSync(cacheDir, { recursive: true })
  const key = createHash('sha1').update(`${voice}|${rate}|${clean}`).digest('hex')
  const wavPath = join(cacheDir, `${key}.wav`)
  if (existsSync(wavPath) && statSync(wavPath).size > 44) {
    return { path: wavPath, durationMs: wavDurationMs(readFileSync(wavPath)), cached: true }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'qqtts-'))
  const txtPath = join(tmp, 'text.txt')
  const psPath = join(tmp, 'tts.ps1')
  writeFileSync(txtPath, clean, 'utf8')
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Speech',
    `$text=[IO.File]::ReadAllText('${psQuote(txtPath)}',[Text.Encoding]::UTF8)`,
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voice ? `try{$s.SelectVoice('${psQuote(voice)}')}catch{}` : '',
    `try{$s.Rate=${Math.max(-10, Math.min(10, Number(rate) || 0))}}catch{}`,
    '$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${psQuote(wavPath)}',$fmt)`,
    '$s.Speak($text)',
    '$s.Dispose()',
  ]
    .filter(Boolean)
    .join('\r\n')
  // powershell -File 读脚本时，带 BOM 才按 UTF-8 解码，中文注释/路径才不会乱。
  writeFileSync(psPath, `\uFEFF${script}`, 'utf8')

  try {
    await pexec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
    )
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  if (!existsSync(wavPath) || statSync(wavPath).size <= 44) throw new Error('TTS 没有生成有效音频')
  return { path: wavPath, durationMs: wavDurationMs(readFileSync(wavPath)), cached: false }
}

/** 只留最新的若干条 wav，别让缓存无限长。 */
export function pruneVoiceCache(cacheDir, keepFiles = 120) {
  try {
    const files = readdirSync(cacheDir)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => {
        const p = join(cacheDir, f)
        let mtime = 0
        try {
          mtime = statSync(p).mtimeMs
        } catch {
          /* ignore */
        }
        return { p, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const item of files.slice(keepFiles)) {
      try {
        rmSync(item.p, { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 把一段 WAV 作为 QQ 语音条发出去，并回读校验。
 * @returns {Promise<{ok:true, messageId:number, verified:boolean}>}
 */
export async function sendVoiceMessage({ client, record, wavPath }) {
  const buf = readFileSync(wavPath)
  const file = `base64://${buf.toString('base64')}`
  const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
  const target =
    record.scope === 'group' ? { group_id: Number(record.peerId) } : { user_id: Number(record.peerId) }
  const res = await client.call(action, { ...target, message: [{ type: 'record', data: { file } }] })
  const messageId = Number(res?.message_id ?? res?.data?.message_id ?? 0)
  let verified = false
  if (messageId) {
    try {
      const got = await client.call('get_msg', { message_id: messageId }, 10000)
      const segs = Array.isArray(got?.message)
        ? got.message
        : Array.isArray(got?.data?.message)
          ? got.data.message
          : []
      const seg = segs.find((s) => s?.type === 'record')
      if (seg) verified = String(seg?.data?.file ?? '').length > 0
      else if (typeof got?.message === 'string') verified = got.message.includes('[CQ:record')
    } catch {
      /* 回读失败不算没发出去，但 verified 保持 false */
    }
  }
  return { ok: true, messageId, verified }
}
