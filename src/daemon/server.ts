// daemon/server.ts — 守护进程的本机 HTTP 接口：/healthz 与 /control/*（来源、key、统计、更新卸载）
//
// 只绑 127.0.0.1，要求控制密钥；Host / Origin 必须是回环，挡 DNS rebinding。CLI 与 dsh 插件宿主端都经这里调守护进程。

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { initLang } from '../i18n.js'
import { hostIsLoopback, originIsLoopback } from '../util/loopback.js'

export interface ControlServerOptions {
  host?: string
  port: number
  secret: string
  log?: (message: string) => void
  onControl: (method: string, path: string, body: unknown, query: URLSearchParams) => Promise<{ status: number; body: unknown }>
}

const BODY_LIMIT = 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createControlServer(options: ControlServerOptions): { server: Server; ready: Promise<number>; close: () => Promise<void> } {
  const expected = Buffer.from(options.secret)
  const log = options.log ?? (() => {})

  const authorized = (req: IncomingMessage): boolean => {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? '').trim())
    if (!m) return false
    const got = Buffer.from(m[1]!)
    return got.length === expected.length && timingSafeEqual(got, expected)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log(`daemon: unhandled ${String(error)}`)
      if (!res.headersSent) fail(res, 500, 'internal', 'daemon internal error')
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostIsLoopback(req.headers.host)) return fail(res, 403, 'host_not_allowed', 'Host must be loopback')
    if (!originIsLoopback(req.headers.origin)) return fail(res, 403, 'origin_not_allowed', 'Origin must be loopback')
    if (!authorized(req)) return fail(res, 401, 'unauthorized', 'missing or invalid bearer')

    const fullUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const url = fullUrl.pathname.replace(/\/+$/, '') || '/'
    if (req.method === 'GET' && url === '/healthz') return json(res, 200, { ok: true })
    if (!url.startsWith('/control/')) return fail(res, 404, 'not_found', `no such route: ${req.method} ${url}`)

    let body: unknown = undefined
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      const raw = await readBody(req)
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        return fail(res, 400, 'invalid_json', 'request body is not JSON')
      }
    }
    // 提示语跟着调用方的语言（dsh 页面 / CLI 的 --lang）；守护进程自己由系统服务启动时没有 LANG
    const lang = String(req.headers['x-dsh-cpamc-lang'] ?? '')
    if (lang === 'zh' || lang === 'en') initLang(lang)
    const r = await options.onControl(req.method ?? 'GET', url.slice('/control'.length), body, fullUrl.searchParams)
    return json(res, r.status, r.body)
  }

  const ready = new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : options.port)
    })
  })

  return {
    server,
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
