import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicEndpoint } from '../../src/daemon/public-endpoint.js'
import { certUsable, loadCertInfo, selfSigned, syncCert, tlsDir } from '../../src/remote/tls.js'
import { findFreePort } from '../../src/util/port.js'

const get = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<{ status: number; body: string; chunks: number[] }>((resolve, reject) => {
    const t0 = Date.now()
    const chunks: number[] = []
    const req = request({ host: '127.0.0.1', port, path, method, headers, rejectUnauthorized: false }, (res) => {
      let body = ''
      res.on('data', (c) => {
        chunks.push(Date.now() - t0)
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, chunks }))
    })
    req.on('error', reject)
    req.end()
  })

describe('certificates for the public port', () => {
  it('generates a usable self-signed certificate and checks name, expiry and key', async () => {
    const a = await selfSigned('dsh.example.com')
    expect(certUsable(a.cert, a.key, 'dsh.example.com')).toBeTruthy()
    expect(certUsable(a.cert, a.key, 'other.example.com')).toBeNull()
    const b = await selfSigned('dsh.example.com')
    expect(certUsable(a.cert, b.key, 'dsh.example.com')).toBeNull()
    expect(certUsable(a.cert, a.key, 'dsh.example.com', Date.now() + 3 * 365 * 86400_000)).toBeNull()
    const ip = await selfSigned('203.0.113.7')
    expect(certUsable(ip.cert, ip.key, '203.0.113.7')).toBeTruthy()
  })

  it('reuses an existing certificate for the host (read only), otherwise keeps one self-signed certificate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cpamc-tls-'))
    const home = join(root, 'home')
    const le = join(root, 'letsencrypt')
    // 没有已有证书：自签；再同步一次还是同一张
    const first = await syncCert(home, 'dsh.example.com', undefined, le)
    expect(first.source).toBe('self-signed')
    const again = await syncCert(home, 'dsh.example.com', undefined, le)
    expect(again.fingerprint).toBe(first.fingerprint)
    // 服务器上出现了这个域名的证书：复用它，原文件不动
    const real = await selfSigned('dsh.example.com')
    await mkdir(join(le, 'live', 'dsh.example.com'), { recursive: true })
    await writeFile(join(le, 'live', 'dsh.example.com', 'fullchain.pem'), real.cert)
    await writeFile(join(le, 'live', 'dsh.example.com', 'privkey.pem'), real.key)
    const reused = await syncCert(home, 'dsh.example.com', undefined, le)
    expect(reused.source).toBe('reuse')
    expect(reused.from).toContain('fullchain.pem')
    expect(await readFile(join(tlsDir(home), 'cert.pem'), 'utf8')).toBe(real.cert)
    expect((await loadCertInfo(home))?.source).toBe('reuse')
    expect(await readFile(join(le, 'live', 'dsh.example.com', 'privkey.pem'), 'utf8')).toBe(real.key)
  })
})

describe('the public HTTPS port', () => {
  let engine: ReturnType<typeof createServer>
  let enginePort = 0
  let home = ''
  const seen: { url?: string; auth?: string; cookie?: string }[] = []
  beforeAll(async () => {
    engine = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie })
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        let n = 0
        const t = setInterval(() => {
          res.write(`data: ${n}\n\n`)
          if (++n === 3) {
            clearInterval(t)
            res.end()
          }
        }, 150)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}')
    })
    await new Promise<void>((r) => engine.listen(0, '127.0.0.1', () => r()))
    enginePort = (engine.address() as { port: number }).port
    home = await mkdtemp(join(tmpdir(), 'dsh-cpamc-pub-'))
    await syncCert(home, 'localhost', undefined, join(home, 'none'))
  })
  afterAll(() => engine.close())

  it('serves only /v1 with an API key, streams, and opens / closes on demand', async () => {
    const port = await findFreePort(21400 + Math.floor(Math.random() * 300))
    const ep = createPublicEndpoint(home, () => enginePort, () => {})
    await ep.apply({ port })
    try {
      expect(ep.port).toBe(port)
      expect((await get(port, '/v1/models')).status).toBe(401)
      expect((await get(port, '/v0/management/config', { Authorization: 'Bearer k' })).status).toBe(404)
      const ok = await get(port, '/v1/models', { Authorization: 'Bearer dshc_k', Cookie: 'x=1' })
      expect(ok.status).toBe(200)
      expect(seen.at(-1)).toMatchObject({ url: '/v1/models', auth: 'Bearer dshc_k', cookie: undefined })
      const sse = await get(port, '/v1/chat/completions', { Authorization: 'Bearer dshc_k' }, 'POST')
      expect(sse.body).toContain('data: 2')
      expect(sse.chunks.length).toBeGreaterThanOrEqual(3)
      // 再 apply 同一个端口不重开
      await ep.apply({ port })
      expect(ep.port).toBe(port)
    } finally {
      await ep.apply(null)
    }
    expect(ep.port).toBeNull()
  })
})
