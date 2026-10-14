import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeReward, loadLedger, localDay, mergeStatus, parseTraeCredits, parseWorkbuddyAccounts, recordCheckin } from '../../src/daemon/checkin.js'

describe('daily check-in', () => {
  it('reads WorkBuddy accounts: any account checked in counts, longest streak shown', () => {
    expect(parseWorkbuddyAccounts({ accounts: [{ checkin: { today_checked_in: false, streak_days: 2 } }, { checkin: { today_checked_in: true, streak_days: 5 } }] })).toEqual({ checkedToday: true, streakDays: 5 })
    expect(parseWorkbuddyAccounts({ accounts: [{ checkin: { today_checked_in: false } }] })).toEqual({ checkedToday: false })
    expect(parseWorkbuddyAccounts({ accounts: [{ email: 'x' }] })).toEqual({ checkedToday: null })
    expect(parseWorkbuddyAccounts('weird')).toEqual({ checkedToday: null })
  })

  it('reads Trae credits', () => {
    expect(parseTraeCredits({ results: [{ checked_in: false }, { checked_in: true }] })).toEqual({ checkedToday: true })
    expect(parseTraeCredits({ results: [{ credits_pool_remain: 3 }] })).toEqual({ checkedToday: null })
  })

  it('a local record of today counts as checked in (the engine caches the status for minutes)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-cpamc-checkin-'))
    await recordCheckin(home, 'qoder', '+50 credits')
    const ledger = await loadLedger(home)
    expect(ledger.days.qoder).toBe(localDay())
    expect(mergeStatus('qoder', { checkedToday: null }, ledger)).toMatchObject({ source: 'qoder', checkedToday: true, lastReward: '+50 credits' })
    expect(mergeStatus('trae', { checkedToday: false }, ledger)).toMatchObject({ checkedToday: false })
    // 昨天的记录不算
    expect(mergeStatus('qoder', { checkedToday: false }, ledger, Date.now() + 2 * 86400_000).checkedToday).toBe(false)
  })

  it('describes what the check-in returned', () => {
    expect(describeReward({ summary: 'checked in 2 accounts, +400 credits' })).toBe('checked in 2 accounts, +400 credits')
    expect(describeReward({ credits: 200 })).toBe('200')
    expect(describeReward(null)).toBeUndefined()
  })
})
