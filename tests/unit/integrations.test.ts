import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createControlServer } from '../../src/daemon/server.js'
import { PLUGIN_IDS, SOURCES, credsFor, findSource } from '../../src/sources.js'
import { loadState, saveState, type State } from '../../src/state.js'
import { hostIsLoopback, originIsLoopback } from '../../src/util/loopback.js'
import { findFreePort } from '../../src/util/port.js'
import { tempCtx } from './helpers.js'

describe('state ledger', () => {
  it('fills ownership for old ledgers', async () => {
    const { ctx } = await tempCtx()
    await saveState(ctx, { engine: { versions: [] }, dsh: { dshHome: '/x', profile: 'desktop', patchFile: '/x/p', credFile: '/x/c', patchBackup: null, credBackup: null, patchExisted: true, credExisted: true, createdLlmEntry: false, writtenPatchSha: null, writtenCredSha: null, connectedAt: '' } as unknown as State['dsh'] })
    const st = await loadState(ctx)
    expect(st.dsh?.ownedProviders).toEqual(['dsh-cpamc'])
    expect(st.dsh?.ownedRefs).toEqual(['DSH_CPAMC_API_KEY'])
  })
})

describe('sources', () => {
  it('has the six default sources, four of them engine plugins', () => {
    expect(SOURCES.map((s) => s.id)).toEqual(['workbuddy', 'trae', 'qoder', 'zcode', 'claude', 'codex'])
    expect(PLUGIN_IDS).toEqual(['workbuddy', 'trae', 'qoder', 'zcode'])
  })

  it('maps credentials by provider field, falling back to the file prefix', () => {
    const trae = findSource('trae')!
    const creds = [
      { name: 'trae-a.json', provider: 'trae' },
      { name: 'x.json', type: 'TRAE' },
      { name: 'trae-legacy.json' },
      { name: 'trae-but-qoder.json', provider: 'qoder' },
    ]
    expect(credsFor(creds, trae).map((c) => c.name)).toEqual(['trae-a.json', 'x.json', 'trae-legacy.json'])
    expect(findSource('chatgpt')?.id).toBe('codex')
  })
})

describe('loopback checks', () => {
  it('accepts only loopback hosts and origins', () => {
    expect(hostIsLoopback('127.0.0.1:18327')).toBe(true)
    expect(hostIsLoopback('localhost')).toBe(true)
    expect(hostIsLoopback('[::1]:80')).toBe(true)
    expect(hostIsLoopback('evil.example')).toBe(false)
    expect(hostIsLoopback('127.0.0.1.evil.example')).toBe(false)
    expect(hostIsLoopback(undefined)).toBe(false)
    expect(originIsLoopback(undefined)).toBe(true)
    expect(originIsLoopback('http://127.0.0.1:3000')).toBe(true)
    expect(originIsLoopback('https://evil.example')).toBe(false)
  })
})

describe('daemon control server', () => {
  it('requires the secret and a loopback Host, and only serves /healthz and /control/*', async () => {
    const port = await findFreePort(19400 + Math.floor(Math.random() * 100))
    const calls: string[] = []
    const s = createControlServer({
      port,
      secret: 'dshb_unit_secret',
      onControl: async (method, path) => {
        calls.push(`${method} ${path}`)
        return { status: 200, body: { ok: true } }
      },
    })
    await s.ready
    try {
      const base = `http://127.0.0.1:${port}`
      const auth = { Authorization: 'Bearer dshb_unit_secret' }
      expect((await fetch(`${base}/healthz`)).status).toBe(401)
      expect((await fetch(`${base}/healthz`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
      expect((await fetch(`${base}/healthz`, { headers: auth })).status).toBe(200)
      // fetch 不允许改 Host（会被忽略），用 node:http 才能真正带上伪造的 Host（模拟 DNS rebinding）
      const hostStatus = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/control/status', headers: { ...auth, Host: 'evil.example' } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end()
      })
      expect(hostStatus).toBe(403)
      expect((await fetch(`${base}/control/status`, { headers: { ...auth, Origin: 'https://evil.example' } })).status).toBe(403)
      expect((await fetch(`${base}/v1/models`, { headers: auth })).status).toBe(404)
      expect((await fetch(`${base}/control/sources/trae/hide`, { method: 'POST', headers: auth })).status).toBe(200)
      expect((await fetch(`${base}/control/keys`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{bad' })).status).toBe(400)
      expect(calls).toEqual(['POST /sources/trae/hide'])
    } finally {
      await s.close()
    }
  })
})
