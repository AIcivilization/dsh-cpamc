// 契约测试：用锁定版本的真引擎二进制，在临时 home / 临时端口下跑，不访问任何上游。
// 首次运行会把发布包下载到 tests/.cache/（之后复用），安装时照常过 sha256 校验。

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli.js'
import { healthy, listModels, unauthStatus, waitHealthy } from '../../src/engine/client.js'
import { currentBinary, loadManifest, probeBinaryVersion } from '../../src/engine/install.js'
import { sha256File } from '../../src/util/fs.js'
import YAML from 'yaml'
import { componentEnv } from './cache.js'
import { loadKeys } from '../../src/keys.js'
import { loadConfig } from '../../src/state.js'
import { tempCtx } from '../unit/helpers.js'

const fixture = (n: string) => readFile(join(__dirname, '../fixtures/dsh', n), 'utf8')

describe('engine contract (real binary)', () => {
  let t: Awaited<ReturnType<typeof tempCtx>>
  let child: ChildProcess | undefined
  let port = 0
  const saved = { ...process.env }

  beforeAll(async () => {
    const env = await componentEnv()
    t = await tempCtx(env)
    Object.assign(process.env, {
      ...env,
      DSH_CPAMC_MODE: 'local',
      DSH_CPAMC_HOME: t.ctx.paths.home,
      DSH_HOME: t.ctx.dshHome,
      DSH_CPAMC_DSH_VERSION: '0.2.0-rc.2',
      DSH_CPAMC_SERVICE: 'none',
      DSH_CPAMC_LANG: 'en',
      DSH_CPAMC_NO_APP_DISCOVERY: '1',
    })
    await writeFile(join(t.profileDir, 'cordis.patch.yml'), await fixture('no-llm.yml'), { mode: 0o600 })
    await writeFile(join(t.ctx.dshHome, '.credentials.yaml'), await fixture('credentials.yml'), { mode: 0o600 })
  }, 120_000)

  afterAll(() => {
    child?.kill('SIGTERM')
    process.env = saved
  })

  it('setup installs and verifies the pinned engine, channel plugins and management interface', async () => {
    const free = 19000 + Math.floor(Math.random() * 500)
    expect(await main(['setup', '--skip-dsh-plugin', '--port', String(free)])).toBe(0)
    port = (await loadConfig(t.ctx)).port
    const v = await probeBinaryVersion(currentBinary(t.ctx))
    const manifest = await loadManifest()
    expect(v).toBe(manifest.version)
    expect(await sha256File(t.ctx.paths.panelFile)).toBe(manifest.panel.sha256)
  }, 120_000)

  it('engine enforces keys, keeps management local, and serves models', async () => {
    child = spawn(currentBinary(t.ctx), ['-config', t.ctx.paths.engineYaml], { cwd: t.ctx.paths.home, stdio: 'ignore' })
    expect(await waitHealthy(port, 15_000)).toBe(true)
    expect(await unauthStatus(port)).toBe(401)
    // 管理接口打开了（设计 §14.4），但不带管理密钥一律 401
    const res = await fetch(`http://127.0.0.1:${port}/v8/management/credentials`)
    expect(res.status).toBe(401)
    const keys = await loadKeys(t.ctx)
    expect(await listModels(port, keys.keys[0]!.key)).toEqual([])
  }, 30_000)

  it('loads the four channel plugins and serves the pinned management interface', async () => {
    const mgmt = JSON.parse(await readFile(join(t.ctx.paths.home, 'mgmt.json'), 'utf8')) as { secret: string }
    const r = await fetch(`http://127.0.0.1:${port}/v0/management/plugins`, { headers: { Authorization: `Bearer ${mgmt.secret}` } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { plugins: { id: string; effective_enabled: boolean; supports_oauth: boolean }[] }
    const on = body.plugins.filter((p) => p.effective_enabled).map((p) => p.id).sort()
    expect(on).toEqual(['qoder', 'trae', 'workbuddy', 'zcode'])
    expect(body.plugins.filter((p) => p.effective_enabled).every((p) => p.supports_oauth)).toBe(true)
    const page = await fetch(`http://127.0.0.1:${port}/management.html`)
    expect(page.status).toBe(200)
    await page.arrayBuffer()
    // 开着 disable-auto-update-panel：引擎不会把锁定版本换掉
    expect(await sha256File(t.ctx.paths.panelFile)).toBe((await loadManifest()).panel.sha256)
  }, 30_000)

  it('keeps settings changed in the management interface when dsh-cpamc rewrites its own keys', async () => {
    const doc = YAML.parseDocument(await readFile(t.ctx.paths.engineYaml, 'utf8'))
    doc.setIn(['routing', 'strategy'], 'round-robin')
    const keys = doc.getIn(['access', 'api-keys']) as { add: (v: unknown) => void }
    keys.add('added-in-management-ui')
    await writeFile(t.ctx.paths.engineYaml, doc.toString())
    expect(await main(['key', 'add', 'tablet'])).toBe(0)
    const after = YAML.parse(await readFile(t.ctx.paths.engineYaml, 'utf8'))
    expect(after.routing.strategy).toBe('round-robin')
    expect(after.access['api-keys']).toContain('added-in-management-ui')
    expect(after.access['api-keys']).toContain((await loadKeys(t.ctx)).keys.find((k) => k.name === 'tablet')!.key)
  }, 30_000)

  it('key add hot-reloads into the engine; revoke removes it', async () => {
    expect(await main(['key', 'add', 'laptop'])).toBe(0)
    const laptop = (await loadKeys(t.ctx)).keys.find((k) => k.name === 'laptop')!.key
    let okAfter = false
    // CI 的机器慢：热重载最多等 15 秒
    for (let i = 0; i < 60 && !okAfter; i++) {
      okAfter = await listModels(port, laptop).then(() => true, () => false)
      if (!okAfter) await new Promise((r) => setTimeout(r, 250))
    }
    expect(okAfter).toBe(true)
    expect(await main(['key', 'revoke', 'laptop'])).toBe(0)
    let rejected = false
    for (let i = 0; i < 60 && !rejected; i++) {
      rejected = await listModels(port, laptop).then(() => false, () => true)
      if (!rejected) await new Promise((r) => setTimeout(r, 250))
    }
    expect(rejected).toBe(true)
  }, 30_000)

  it('connect-dsh with no logins writes the key ref but no provider', async () => {
    expect(await main(['connect-dsh'])).toBe(0)
    const cred = await readFile(join(t.ctx.dshHome, '.credentials.yaml'), 'utf8')
    expect(cred).toContain('DSH_CPAMC_API_KEY: dshc_')
    expect(await readFile(join(t.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(await fixture('no-llm.yml'))
    expect(await main(['doctor', '--json'])).toBe(0)
  }, 30_000)

  it('uninstall restores dsh files byte-for-byte and removes home', async () => {
    expect(await healthy(port)).toBe(true)
    // 测试自己拉起的引擎（没走服务）：先停掉。Windows 上进程的工作目录在 home 里时删不掉 home
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child!.once('exit', r))
      child.kill()
      await exited
    }
    child = undefined
    expect(await main(['uninstall', '--yes'])).toBe(0)
    expect(await readFile(join(t.ctx.dshHome, '.credentials.yaml'), 'utf8')).toBe(await fixture('credentials.yml'))
    expect(await readFile(join(t.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(await fixture('no-llm.yml'))
    expect(existsSync(t.ctx.paths.home)).toBe(false)
  }, 30_000)
})
