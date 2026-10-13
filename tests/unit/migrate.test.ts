import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dshModelHome, migrate } from '../../src/commands/migrate.js'
import { addKey, loadKeys, saveKeys, type KeyStore } from '../../src/keys.js'
import { tempCtx } from './helpers.js'

describe('migrate from dsh-model', () => {
  it('does nothing when dsh-model is not installed', async () => {
    const { ctx } = await tempCtx()
    expect(await dshModelHome(ctx)).toBeNull()
    expect(await migrate(ctx)).toBe(0)
  })

  it('copies Claude / Codex sign-ins and access keys, leaves dsh-model untouched', async () => {
    const t = await tempCtx()
    const src = join(t.root, 'old-dsh-model')
    t.ctx.env.DSH_MODEL_HOME = src
    await mkdir(join(src, 'auth'), { recursive: true })
    await writeFile(join(src, 'state.json'), '{"engine":{"versions":[]}}')
    await writeFile(join(src, 'auth', 'codex-a@example.com.json'), '{"type":"codex"}')
    await writeFile(join(src, 'auth', 'kimi-x.json'), '{"type":"kimi"}')
    await writeFile(join(src, 'keys.json'), JSON.stringify({ keys: [
      { name: 'dsh', key: 'dshm_old_dsh', createdAt: '2026-10-01T00:00:00Z' },
      { name: 'laptop', key: 'dshm_old_laptop', createdAt: '2026-10-01T00:00:00Z' },
      { name: 'gone', key: 'dshm_old_gone', createdAt: '2026-10-01T00:00:00Z', revokedAt: '2026-10-02T00:00:00Z' },
    ] }))
    const keys: KeyStore = { keys: [] }
    addKey(keys, 'dsh')
    await saveKeys(t.ctx, keys)
    expect(await dshModelHome(t.ctx)).toBe(src)
    expect(await migrate(t.ctx)).toBe(0)
    expect(await readdir(t.ctx.paths.auth)).toEqual(['codex-a@example.com.json'])
    const now = await loadKeys(t.ctx)
    expect(now.keys.map((k) => k.name)).toEqual(['dsh', 'laptop'])
    expect(now.keys.find((k) => k.name === 'laptop')?.key).toBe('dshm_old_laptop')
    expect(now.keys.find((k) => k.name === 'dsh')?.key).not.toBe('dshm_old_dsh')
    // 源目录原样
    expect((await readdir(join(src, 'auth'))).sort()).toEqual(['codex-a@example.com.json', 'kimi-x.json'])
    expect(JSON.parse(await readFile(join(src, 'keys.json'), 'utf8')).keys).toHaveLength(3)
  })
})
