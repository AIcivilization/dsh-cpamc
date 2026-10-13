// 经 dsh 网页服务提供的完整管理界面：先过 dsh 登录，写请求要同源，Cookie 不转给引擎
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 模块
import { ENGINE_PREFIXES, PANEL_PREFIX, registerPanelRoutes } from '../../plugin/panel-proxy.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

describe('management interface through the dsh web server', () => {
  const seen: { method?: string; url?: string; auth?: string; cookie?: string; host?: string }[] = []
  let engine: ReturnType<typeof createServer>
  let web: ReturnType<typeof createServer>
  let base = ''
  let allow = true
  let home = ''

  beforeAll(async () => {
    engine = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie, host: req.headers.host })
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'engine=1' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
    })
    await new Promise<void>((r) => engine.listen(0, '127.0.0.1', () => r()))
    home = await mkdtemp(join(tmpdir(), 'dsh-cpamc-panel-'))
    await mkdir(join(home, 'static'))
    await writeFile(join(home, 'static', 'management.html'), '<html>pinned panel</html>')
    await writeFile(join(home, 'config.json'), JSON.stringify({ port: (engine.address() as { port: number }).port }))

    const routes: { path: string; handler: Handler }[] = []
    const ws = { register: (r: { kind: string; path: string; handler: Handler }) => (routes.push(r), () => {}) }
    const connection = { admit: () => (allow ? { peer: {} } : { rejection: 401 }) }
    const r = registerPanelRoutes(ws, connection, () => home)
    expect(r.enginePrefixes).toEqual(ENGINE_PREFIXES)
    web = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const hit = routes.filter((x) => path === x.path || path.startsWith(`${x.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
      if (!hit) return res.writeHead(404).end()
      void hit.handler(req, res)
    })
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(web.address() as { port: number }).port}`
  })

  afterAll(() => {
    engine.close()
    web.close()
  })

  it('refuses everything until dsh admits the request', async () => {
    allow = false
    expect((await fetch(`${base}${PANEL_PREFIX}/management.html`)).status).toBe(401)
    expect((await fetch(`${base}/v0/management/config`)).status).toBe(401)
    expect(seen).toHaveLength(0)
    allow = true
  })

  it('serves the pinned management page', async () => {
    const r = await fetch(`${base}${PANEL_PREFIX}/management.html`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('<html>pinned panel</html>')
    expect((await fetch(`${base}${PANEL_PREFIX}/`)).status).toBe(200)
  })

  it('forwards engine paths with the management key but without dsh cookies', async () => {
    const r = await fetch(`${base}/v0/management/config?x=1`, { headers: { Authorization: 'Bearer mgmt', Cookie: 'dsh-auth-abc=secret' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: '/v0/management/config?x=1', auth: 'Bearer mgmt', cookie: undefined })
    expect(seen.at(-1)?.host).toMatch(/^127\.0\.0\.1:/)
    // 前缀形态：去掉 /dsh-cpamc/panel 再转
    await fetch(`${base}${PANEL_PREFIX}/v8/management/plugins`, { headers: { Authorization: 'Bearer mgmt' } })
    expect(seen.at(-1)?.url).toBe('/v8/management/plugins')
  })

  it('allows same-origin writes with any method and refuses cross-site ones', async () => {
    const put = await fetch(`${base}/v0/management/api-keys`, { method: 'PUT', headers: { 'content-type': 'application/json', Origin: base }, body: '["k"]' })
    expect(put.status).toBe(200)
    expect(seen.at(-1)?.method).toBe('PUT')
    const del = await fetch(`${base}/v0/management/auth-files?name=x`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } })
    expect(del.status).toBe(403)
  })

  it('says so when the model service is down', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ port: 1 }))
    expect((await fetch(`${base}/v0/management/config`)).status).toBe(502)
  })
})
