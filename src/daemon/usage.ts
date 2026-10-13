// daemon/usage.ts — 订阅用量（设计 §14.6）
//
// 用各来源已有的登录令牌，主动去调它们自己的额度接口：
//   Codex   GET chatgpt.com/backend-api/wham/usage            rate_limit.primary_window / secondary_window
//   Claude  GET api.anthropic.com/api/oauth/usage             five_hour / seven_day / seven_day_opus（anthropic-beta: oauth-2025-04-20）
// 四个 IDE 来源（渠道插件）查不了统一的额度接口：登录后实测一次能不能调（见 USAGE_UNSUPPORTED）。
// 令牌来源：引擎 auth-dir 里的凭据文件（引擎会自动续期并写回）。
// 一律只读：不刷新、不改写任何凭据文件。查询失败只在那一行显示"用量暂不可用"。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../context.js'
import type { CredentialEntry } from '../engine/mgmt.js'
import type { SourceDef } from '../sources.js'

export interface UsageWindow {
  /** 窗口名：5h / 7d / 30d / opus-7d … */
  id: string
  label: string
  usedPercent?: number
  used?: number
  limit?: number
  resetAt?: string
}

export interface SourceUsage {
  source: string
  plan?: string
  windows: UsageWindow[]
  credits?: { remaining: number; total?: number; label?: string; unlimited?: boolean }
  fetchedAt: string
  error?: string
  /** 这个来源暂时查不了用量 */
  unsupported?: boolean
  /** 已登录但当前账号没有可用订阅（模型调用会被拒）：dsh 里隐藏它的模型 */
  noAccess?: boolean
  /** 实测调通的模型（查不了用量的来源才有）：默认显示进 dsh 的就是它（设计 §4.2） */
  probedModel?: string
}

const TIMEOUT_MS = 15_000

/** 这几家暂不支持（见设计 §14.6） */
export const USAGE_UNSUPPORTED = new Set(['workbuddy', 'trae', 'qoder', 'zcode'])

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`)
  return text ? JSON.parse(text) : {}
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/** 秒 / 毫秒时间戳或 ISO 字符串 → ISO */
function toIso(v: unknown): string | undefined {
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : new Date(t).toISOString()
  }
  const n = num(v)
  if (n === undefined) return undefined
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

/** 读引擎凭据文件里的访问令牌（字段名各家不同，宽松取） */
async function readEngineToken(ctx: Ctx, cred: CredentialEntry): Promise<{ token: string; doc: Record<string, unknown> }> {
  const doc = JSON.parse(await readFile(join(ctx.paths.auth, cred.name), 'utf8')) as Record<string, unknown>
  const nested = obj(doc.token) ?? obj(doc.tokens) ?? {}
  const token = str(doc.access_token) ?? str(doc.accessToken) ?? str(nested.access_token) ?? str(nested.accessToken)
  if (!token) throw new Error('no access token in credential file')
  return { token, doc }
}

// —— 各家解析（导出给测试）——

export function parseCodexUsage(body: unknown): Pick<SourceUsage, 'plan' | 'windows' | 'credits'> {
  const b = obj(body) ?? {}
  const rl = obj(b.rate_limit) ?? obj(b.rateLimit) ?? {}
  const windows: UsageWindow[] = []
  const win = (w: unknown, id: string, fallbackLabel: string) => {
    const o = obj(w)
    if (!o) return
    const secs = num(o.limit_window_seconds) ?? num(o.window_seconds)
    const label = secs ? humanWindow(secs) : fallbackLabel
    const resetAt = toIso(o.reset_at) ?? (num(o.reset_after_seconds) !== undefined ? new Date(Date.now() + num(o.reset_after_seconds)! * 1000).toISOString() : undefined)
    windows.push({ id, label, ...(num(o.used_percent) !== undefined ? { usedPercent: num(o.used_percent)! } : {}), ...(resetAt ? { resetAt } : {}) })
  }
  win(rl.primary_window, 'primary', '5h')
  win(rl.secondary_window, 'secondary', '7d')
  const c = obj(b.credits)
  const balance = num(c?.balance)
  return {
    ...(str(b.plan_type) ? { plan: str(b.plan_type)! } : {}),
    windows,
    ...(c && (balance !== undefined || c.unlimited === true) ? { credits: { remaining: balance ?? 0, ...(c.unlimited === true ? { unlimited: true } : {}), label: 'credits' } } : {}),
  }
}

export function parseClaudeUsage(body: unknown): Pick<SourceUsage, 'windows'> {
  const b = obj(body) ?? {}
  const windows: UsageWindow[] = []
  const add = (key: string, id: string, label: string) => {
    const o = obj(b[key])
    if (!o) return
    const used = num(o.utilization)
    if (used === undefined && !o.resets_at) return
    const resetAt = toIso(o.resets_at)
    windows.push({ id, label, ...(used !== undefined ? { usedPercent: used } : {}), ...(resetAt ? { resetAt } : {}) })
  }
  add('five_hour', '5h', '5h')
  add('seven_day', '7d', '7d')
  add('seven_day_opus', 'opus-7d', 'Opus 7d')
  add('seven_day_sonnet', 'sonnet-7d', 'Sonnet 7d')
  return { windows }
}



function humanWindow(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400}d`
  if (secs % 3600 === 0) return `${secs / 3600}h`
  return `${Math.round(secs / 60)}m`
}

// —— 取用量 ——

export async function fetchEngineUsage(ctx: Ctx, def: SourceDef, cred: CredentialEntry): Promise<Omit<SourceUsage, 'source' | 'fetchedAt'>> {
  const { token, doc } = await readEngineToken(ctx, cred)
  if (def.id === 'codex') {
    const account = str(doc.account_id) ?? str(doc.accountId) ?? str(obj(doc.tokens)?.account_id)
    const body = await getJson('https://chatgpt.com/backend-api/wham/usage', {
      Authorization: `Bearer ${token}`,
      ...(account ? { 'ChatGPT-Account-Id': account } : {}),
      'User-Agent': 'codex_cli_rs',
    })
    return parseCodexUsage(body)
  }
  if (def.id === 'claude') {
    const body = await getJson('https://api.anthropic.com/api/oauth/usage', { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' })
    return parseClaudeUsage(body)
  }
  return { windows: [], unsupported: true }
}

/** 实测一次能不能调：发一条极短的请求（经引擎，用 dsh 的 key）。
 *  被拒（402/403、insufficient_quota、payment_required、access_terminated）→ noAccess；
 *  其他失败（网络、限流、上游 5xx）不下结论，抛错由调用方保留上次结果。 */
export async function probeEngineSource(port: number, key: string, model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, stream: false }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (res.ok) return { ok: true }
  return classifyProbeFailure(res.status, text)
}

export function classifyProbeFailure(status: number, text: string): { ok: false; reason: string } {
  const denied = status === 402 || status === 403 || /insufficient_quota|payment_required|permission_denied|access_terminated|subscription/i.test(text)
  let msg = text
  try {
    msg = String((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text)
  } catch {
    // 不是 JSON
  }
  if (denied) return { ok: false, reason: msg.slice(0, 160) }
  throw new Error(`HTTP ${status}: ${msg.slice(0, 160)}`)
}

/** 守护进程把用量写到这里，同步模型时（任何进程）据此隐藏没有订阅的来源 */
export function usageFilePath(home: string): string {
  return join(home, 'usage.json')
}
