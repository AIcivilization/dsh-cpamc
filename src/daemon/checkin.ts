// daemon/checkin.ts — 每日签到（WorkBuddy、Trae、Qoder），走渠道插件自己的接口（设计 §4.3）
//
// 签到是渠道插件自带的能力，dsh-cpamc 不另做一套：
//   签到        POST /v0/management/plugins/<id>/checkin，请求体 {} = 这个渠道的全部账号（含已停用的：额度照攒）
//   今天签了没  WorkBuddy：账号列表里的 checkin.today_checked_in / streak_days
//              Trae：余额接口 results[].checked_in
//              Qoder：接口不报，只看本地记录
// 引擎会把签到状态缓存几分钟，刚签完立刻查可能还是「没签」，所以本地另记一份「今天签过」（checkin.json）。
// 守护进程每小时看一次：已登录、今天还没签过的渠道自动签到（可在面板上关掉）。
// 返回的字段以渠道插件 v0.8.68 为准、尽量宽松地读：读不出来就当「不知道」，不猜。

import { join } from 'node:path'
import { readJson, writeJson, type Owner } from '../util/fs.js'

export const CHECKIN_SOURCES = ['workbuddy', 'trae', 'qoder'] as const
export type CheckinSource = (typeof CHECKIN_SOURCES)[number]

export interface CheckinStatus {
  source: string
  /** 今天签过没有：true / false；接口和本地记录都说不清时 null */
  checkedToday: boolean | null
  streakDays?: number
  /** 最近一次签到得到的额度描述（插件给什么显示什么） */
  lastReward?: string
  /** 本地记录：最近一次签到的日期（YYYY-MM-DD，本地时区） */
  lastDay?: string
  error?: string
}

export interface CheckinLedger {
  days: Record<string, string>
  rewards?: Record<string, string>
}

export function localDay(t = Date.now()): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function ledgerPath(home: string): string {
  return join(home, 'checkin.json')
}

export async function loadLedger(home: string): Promise<CheckinLedger> {
  return (await readJson<CheckinLedger>(ledgerPath(home)).catch(() => null)) ?? { days: {} }
}

export async function recordCheckin(home: string, source: string, reward: string | undefined, owner?: Owner, now = Date.now()): Promise<void> {
  const l = await loadLedger(home)
  l.days[source] = localDay(now)
  if (reward) l.rewards = { ...l.rewards, [source]: reward }
  await writeJson(ledgerPath(home), l, { owner })
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const list = (v: unknown, ...keys: string[]): Record<string, unknown>[] => {
  const o = obj(v)
  for (const k of keys) if (Array.isArray(o?.[k])) return (o![k] as unknown[]).map((x) => obj(x) ?? {})
  return Array.isArray(v) ? (v as unknown[]).map((x) => obj(x) ?? {}) : []
}

/** WorkBuddy 账号列表 → 今天签了没、连续天数（任一账号签过就算签过） */
export function parseWorkbuddyAccounts(payload: unknown): Pick<CheckinStatus, 'checkedToday' | 'streakDays'> {
  const accounts = list(payload, 'accounts', 'results', 'items')
  const states = accounts.map((a) => obj(a.checkin)).filter((c): c is Record<string, unknown> => Boolean(c))
  if (!states.length) return { checkedToday: null }
  const streak = Math.max(...states.map((c) => Number(c.streak_days ?? 0) || 0))
  return { checkedToday: states.some((c) => c.today_checked_in === true), ...(streak > 0 ? { streakDays: streak } : {}) }
}

/** Trae 余额 → 今天签了没 */
export function parseTraeCredits(payload: unknown): Pick<CheckinStatus, 'checkedToday'> {
  const results = list(payload, 'results', 'accounts')
  const flags = results.map((r) => r.checked_in).filter((x) => typeof x === 'boolean') as boolean[]
  return { checkedToday: flags.length ? flags.some(Boolean) : null }
}

/** 签到接口的返回 → 一句话（插件给 summary / message 就用它，否则按字段拼） */
export function describeReward(payload: unknown): string | undefined {
  const o = obj(payload)
  if (!o) return undefined
  for (const k of ['summary', 'message', 'msg']) if (typeof o[k] === 'string' && o[k]) return String(o[k]).slice(0, 120)
  const n = o.credits ?? o.reward ?? o.checkin_credits ?? o.added
  return typeof n === 'number' || typeof n === 'string' ? String(n) : undefined
}

/** 合并接口读数与本地记录：接口说签了就是签了；接口说没签或不知道，但本地记录今天签过，也算签过（引擎缓存） */
export function mergeStatus(source: string, fromApi: Pick<CheckinStatus, 'checkedToday' | 'streakDays'>, ledger: CheckinLedger, now = Date.now()): CheckinStatus {
  const today = localDay(now)
  const local = ledger.days[source] === today
  return {
    source,
    checkedToday: fromApi.checkedToday === true || local ? true : fromApi.checkedToday,
    ...(fromApi.streakDays ? { streakDays: fromApi.streakDays } : {}),
    ...(ledger.days[source] ? { lastDay: ledger.days[source] } : {}),
    ...(ledger.rewards?.[source] ? { lastReward: ledger.rewards[source] } : {}),
  }
}
