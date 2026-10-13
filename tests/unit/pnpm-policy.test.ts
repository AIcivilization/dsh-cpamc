import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixReleaseAgeExcludes, mergeExcludes } from '../../src/dsh/pnpm-policy.js'

describe('pnpm release-age exclude list', () => {
  it('merges entries for the same package into one line (pnpm only honours the first)', () => {
    const r = mergeExcludes(['dsh-vps@1.15.0 || 1.15.1', 'dshmarket@1.66.18', 'dshmarket@1.66.20', '@scope/pkg@1.0.0', '@scope/pkg@1.0.1', 'weird-*'])
    expect(r.changed).toBe(true)
    expect(r.list).toEqual(['dsh-vps@1.15.0 || 1.15.1', 'dshmarket@1.66.18 || 1.66.20', '@scope/pkg@1.0.0 || 1.0.1', 'weird-*'])
    expect(mergeExcludes(['a@1.0.0', 'b@2.0.0']).changed).toBe(false)
  })

  it('rewrites the profile file with a backup, leaving everything else as it was', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cpamc-pnpm-'))
    const profile = join(root, 'profile')
    const backups = join(root, 'backups')
    await mkdir(profile)
    await mkdir(backups)
    const original = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nminimumReleaseAgeExclude:\n  - dsh-vpn@0.1.6 || 0.1.7\n  - dshmarket@1.66.18\n  - dshmarket@1.66.20\n'
    await writeFile(join(profile, 'pnpm-workspace.yaml'), original)
    const backup = await fixReleaseAgeExcludes(profile, backups)
    expect(backup).toBeTruthy()
    expect(await readFile(backup!, 'utf8')).toBe(original)
    const now = await readFile(join(profile, 'pnpm-workspace.yaml'), 'utf8')
    expect(now).toContain('nodeLinker: hoisted')
    expect(now).toContain('- dshmarket@1.66.18 || 1.66.20')
    expect(now).not.toMatch(/- dshmarket@1\.66\.20\n/)
    expect(await fixReleaseAgeExcludes(profile, backups)).toBeNull()
    expect(await readdir(backups)).toHaveLength(1)
  })
})
