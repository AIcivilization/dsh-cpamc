import { describe, expect, it } from 'vitest'
import { parseClaudeUsage, parseCodexUsage } from '../../src/daemon/usage.js'

describe('subscription usage parsers', () => {
  it('codex: primary/secondary windows, plan and credits', () => {
    const r = parseCodexUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 68, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 31, limit_window_seconds: 604800, reset_at: 1793462400 },
      },
      credits: { has_credits: true, balance: 12.5, unlimited: false },
    })
    expect(r.plan).toBe('plus')
    expect(r.windows.map((w) => [w.label, w.usedPercent])).toEqual([['5h', 68], ['7d', 31]])
    expect(Date.parse(r.windows[0]!.resetAt!)).toBeGreaterThan(Date.now())
    expect(r.windows[1]!.resetAt).toBe(new Date(1793462400 * 1000).toISOString())
    expect(r.credits).toEqual({ remaining: 12.5, label: 'credits' })
  })

  it('claude: five_hour / seven_day / opus windows', () => {
    const r = parseClaudeUsage({ five_hour: { utilization: 12, resets_at: '2026-10-09T12:00:00Z' }, seven_day: { utilization: 40.5, resets_at: '2026-10-14T00:00:00Z' }, seven_day_opus: { utilization: 3 } })
    expect(r.windows.map((w) => [w.id, w.usedPercent])).toEqual([['5h', 12], ['7d', 40.5], ['opus-7d', 3]])
  })
})

describe('probe classification', () => {
  it('treats quota / payment refusals as no access', async () => {
    const { classifyProbeFailure } = await import('../../src/daemon/usage.js')
    expect(classifyProbeFailure(403, '{"error":{"message":"devin upstream error (permission_denied)","code":"insufficient_quota"}}')).toEqual({ ok: false, reason: 'devin upstream error (permission_denied)' })
    expect(classifyProbeFailure(400, 'access_terminated_error').ok).toBe(false)
    expect(() => classifyProbeFailure(429, '{"error":{"message":"rate limited"}}')).toThrow(/429/)
    expect(() => classifyProbeFailure(502, 'bad gateway')).toThrow(/502/)
  })
})

describe('probe classification (engine cooldown)', () => {
  it('503 carrying the upstream permission_denied is no access', async () => {
    const { classifyProbeFailure } = await import('../../src/daemon/usage.js')
    expect(classifyProbeFailure(503, '{"error":{"message":"auth_unavailable: no auth available (last upstream error: devin upstream error (permission_denied))"}}').ok).toBe(false)
  })
})
