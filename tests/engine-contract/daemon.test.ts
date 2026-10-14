// 契约测试：真引擎（管理接口打开）+ 守护进程核心
// 六个来源的列表、显示 / 隐藏、命令行备用登录会话（拿链接后取消）、key 热生效。

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Daemon } from '../../src/daemon/core.js'
import { listModels, waitHealthy } from '../../src/engine/client.js'
import { installPanel, installPlugins } from '../../src/engine/components.js'
import { writeEngineConfig } from '../../src/engine/config.js'
import { componentEnv } from './cache.js'
import { activateVersion, currentBinary, installVersion, loadManifest, platformTarget } from '../../src/engine/install.js'
import { addKey, saveKeys, type KeyStore } from '../../src/keys.js'
import { defaultConfig, saveConfig, saveState } from '../../src/state.js'
import { findFreePort } from '../../src/util/port.js'
import { tempCtx } from '../unit/helpers.js'

describe('daemon core against a real engine', () => {
  let engine: ChildProcess | undefined
  let daemon: Daemon
  let port = 0
  let dshKey = ''
  const saved = { ...process.env }

  beforeAll(async () => {
    process.env.DSH_CPAMC_NO_APP_DISCOVERY = '1'
    const t = await tempCtx()
    process.env.DSH_CPAMC_HOME = t.ctx.paths.home
    const manifest = await loadManifest()
    Object.assign(t.ctx.env, await componentEnv())
    await installVersion(t.ctx, manifest.version, manifest.assets[platformTarget()]!)
    await activateVersion(t.ctx, manifest.version)
    await installPlugins(t.ctx, manifest.plugins)
    await installPanel(t.ctx, manifest.panel)

    port = await findFreePort(20100 + Math.floor(Math.random() * 300))
    const config = { ...defaultConfig(), port }
    const keys: KeyStore = { keys: [] }
    dshKey = addKey(keys, 'dsh').key
    await saveConfig(t.ctx, config)
    await saveKeys(t.ctx, keys)
    await saveState(t.ctx, { engine: { versions: [manifest.version] } })

    await mkdir(t.ctx.paths.auth, { recursive: true })
    await writeEngineConfig(t.ctx, config, keys, { engine: { versions: [] } })
    engine = spawn(currentBinary(t.ctx), ['-config', t.ctx.paths.engineYaml], { cwd: t.ctx.paths.home, stdio: 'ignore' })
    expect(await waitHealthy(port, 15_000)).toBe(true)
    daemon = new Daemon(t.ctx)
    await daemon.start()
  }, 120_000)

  afterAll(async () => {
    await daemon?.stop()
    engine?.kill('SIGTERM')
    process.env = saved
  })

  it('lists the six sources, all signed out and shown by default', async () => {
    const list = await daemon.sources()
    expect(list.map((s) => s.id)).toEqual(['workbuddy', 'trae', 'qoder', 'zcode', 'claude', 'codex'])
    for (const s of list) expect(s).toMatchObject({ loggedIn: false, active: false, shown: true, models: 0 })
    expect(list.filter((s) => s.plugin).map((s) => s.id)).toEqual(['workbuddy', 'trae', 'qoder', 'zcode'])
  })

  it('check-in: nothing signed in yet means nothing to check in; auto check-in is on by default', async () => {
    expect(await daemon.checkinStatus()).toEqual({ auto: true, sources: [] })
    await expect(daemon.checkin('zcode')).rejects.toThrow()
    expect(await daemon.setAutoCheckin(false)).toEqual({ auto: false })
    expect((await daemon.checkinStatus()).auto).toBe(false)
    await daemon.setAutoCheckin(true)
  }, 30_000)

  it('「测一下」reports a model that cannot be served, with a reason', async () => {
    const r = await daemon.testModel('no-such-model-xyz')
    expect(r.ok).toBe(false)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.advice).toBeTruthy()
    await expect(daemon.testModel('')).rejects.toThrow()
  }, 60_000)

  it('show / hide only changes what dsh sees', async () => {
    expect(await daemon.setShown('trae', false)).toEqual({ shown: false })
    expect((await daemon.sources()).find((s) => s.id === 'trae')?.shown).toBe(false)
    await daemon.setShown('trae', true)
    expect((await daemon.sources()).find((s) => s.id === 'trae')?.shown).toBe(true)
  }, 30_000)

  it('command-line login: Claude needs acknowledgement first, then asks for a pasted callback', async () => {
    const first = await daemon.login('claude')
    expect(first.riskNotice).toBeTruthy()
    const r = await daemon.login('claude', { acceptRisk: true })
    expect(r.login).toMatchObject({ source: 'claude', status: 'pending', needsPaste: true })
    expect(r.login!.url).toMatch(/^https:\/\//)
    expect(daemon.cancelSession(r.login!.id)).toBe(true)
    expect(daemon.session(r.login!.id)?.status).toBe('cancelled')
  }, 30_000)

  it('a key added through the daemon works immediately (hot reload)', async () => {
    const { key } = await daemon.addKey('laptop')
    let okNow = false
    for (let i = 0; i < 20 && !okNow; i++) {
      okNow = await listModels(port, key).then(() => true, () => false)
      if (!okNow) await new Promise((r) => setTimeout(r, 250))
    }
    expect(okNow).toBe(true)
  }, 30_000)
})
