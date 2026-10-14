// daemon/public-endpoint.ts — 对外的 HTTPS 端口（设计 §9.2）：其他设备上的软件经它调模型
//
// 守护进程自己监听，不碰别的产品的 Caddy / 网关。只转发 /v1 下的请求，没带 API key 的直接 401；
// 鉴权交给引擎（/v1 始终要 key）。流式响应原样透传。证书在 tls/（remote/tls.ts 同步），
// 文件变了就换上新证书，不用重启。配置（开没开、哪个端口）每 30 秒看一次，变了就跟着开 / 关 / 换端口。

import { readFile } from 'node:fs/promises'
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import { join } from 'node:path'
import { tlsDir } from '../remote/tls.js'

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'cookie'])

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: { message, type: status === 401 ? 'unauthorized' : 'not_found' } }))
}

/** 处理一个对外请求（导出给测试） */
export function publicHandler(enginePort: () => number) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'https://x')
    if (url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) return deny(res, 404, 'only /v1 is served here')
    if (!/^Bearer\s+\S+/i.test(String(req.headers.authorization ?? '')) && !req.headers['x-api-key']) return deny(res, 401, 'missing API key (Authorization: Bearer <key>)')
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v
    const port = enginePort()
    headers.host = `127.0.0.1:${port}`
    const up = request({ host: '127.0.0.1', port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (r) => {
      const out: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie' && v !== undefined) out[k] = v
      res.writeHead(r.statusCode ?? 502, out)
      r.pipe(res)
    })
    up.on('error', () => {
      if (!res.headersSent) deny(res, 502, 'the model service is not running')
      else res.destroy()
    })
    req.pipe(up)
  }
}

export interface PublicEndpoint {
  /** 按期望状态开 / 关 / 换端口（幂等） */
  apply(want: { port: number } | null): Promise<void>
  close(): Promise<void>
  readonly port: number | null
}

export function createPublicEndpoint(home: string, enginePort: () => number, log: (m: string) => void): PublicEndpoint {
  let server: Server | null = null
  let port: number | null = null
  let certSig = ''
  let watch: NodeJS.Timeout | null = null
  const files = () => ({ cert: join(tlsDir(home), 'cert.pem'), key: join(tlsDir(home), 'key.pem') })
  const readPair = async () => {
    const f = files()
    return { cert: await readFile(f.cert, 'utf8'), key: await readFile(f.key, 'utf8') }
  }

  async function stop(): Promise<void> {
    if (watch) clearInterval(watch)
    watch = null
    if (!server) return
    const s = server
    server = null
    port = null
    await new Promise<void>((r) => {
      s.close(() => r())
      s.closeAllConnections()
    })
  }

  async function start(p: number): Promise<void> {
    const pair = await readPair()
    const s = createServer({ cert: pair.cert, key: pair.key }, publicHandler(enginePort))
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      // :: 同时接 IPv4 / IPv6（系统不支持 IPv6 时退回 0.0.0.0）
      s.listen(p, '::', () => resolve())
    }).catch(
      () =>
        new Promise<void>((resolve, reject) => {
          s.removeAllListeners('error')
          s.once('error', reject)
          s.listen(p, '0.0.0.0', () => resolve())
        }),
    )
    server = s
    port = p
    certSig = pair.cert
    log(`daemon: public endpoint listening on :${p}`)
    // 证书续期后换上新的（一分钟看一次）
    watch = setInterval(() => {
      void readPair().then(
        (next) => {
          if (next.cert !== certSig && server) {
            server.setSecureContext({ cert: next.cert, key: next.key })
            certSig = next.cert
            log('daemon: public endpoint certificate reloaded')
          }
        },
        () => {},
      )
    }, 60_000)
  }

  return {
    get port() {
      return port
    },
    async apply(want) {
      if (!want) return stop()
      if (server && port === want.port) return
      await stop()
      try {
        await start(want.port)
      } catch (error) {
        log(`daemon: public endpoint could not start on :${want.port}: ${String((error as Error).message ?? error)}`)
      }
    },
    close: stop,
  }
}
