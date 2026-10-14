import { describe, expect, it } from 'vitest'
import { releaseAgeBlocked } from '../../src/integrations/dshplugin.js'

describe('dsh plugin install blocked by pnpm minimumReleaseAge', () => {
  it('names the packages and estimates when they are let through', () => {
    const out = `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
  dshmarket@1.66.21 was published at 2026-10-13T17:22:24.000Z, within the minimumReleaseAge cutoff (2026-10-13T01:20:05.688Z)`
    const now = Date.parse('2026-10-14T01:20:05.688Z') // 规则时长 = 24 小时
    const r = releaseAgeBlocked(out, now)
    expect(r).toHaveLength(1)
    expect(r[0]!.spec).toBe('dshmarket@1.66.21')
    const until = new Date(Date.parse('2026-10-14T17:22:24.000Z'))
    const p = (n: number) => String(n).padStart(2, '0')
    expect(r[0]!.until).toBe(`${until.getFullYear()}-${p(until.getMonth() + 1)}-${p(until.getDate())} ${p(until.getHours())}:${p(until.getMinutes())}`)
    expect(releaseAgeBlocked('all good')).toEqual([])
  })
})
