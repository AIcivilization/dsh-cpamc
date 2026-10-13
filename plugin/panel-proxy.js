// plugin/panel-proxy.js — 经 dsh 自己的网页服务提供原版完整管理界面（设计 §7.4）
//
// 远程浏览器（VPS 上的 dsh）打不开 127.0.0.1 上的管理界面，也不该为它另开端口。这里把管理界面挂在 dsh 的网页服务下：
//   /dsh-cpamc/panel/management.html      锁定版本的管理界面（~/.dsh-cpamc/static/management.html）
//   /dsh-cpamc/panel/<其余路径>            去掉前缀转给本机引擎（填「自定义连接地址」时用）
//   /v0/management/* /v0/resource/* /v8/management/*   原样转给本机引擎：管理界面默认连页面所在的域名，不用改地址
// 每个请求先过 dsh 自己的登录校验（ctx.connection.admit：信任围栏 + 认证，dsh 的 /api 也用它），写请求还要同源；
// dsh 的登录 Cookie 不转给引擎。管理接口照样要管理密钥——这里多加的一层是 dsh 登录。
// 不依赖 dsh-vps 或任何别的产品：dsh 前面是什么反向代理都一样。

import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PANEL_PREFIX = '/dsh-cpamc/panel'
/** 管理界面直接请求的引擎路径（默认连接地址 = 页面所在的域名） */
export const ENGINE_PREFIXES = ['/v0/management', '/v0/resource', '/v8/management']

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'cookie', 'origin', 'referer'])

function sameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function deny(res, code, message) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(message)
}

async function enginePort(home) {
  const cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  if (!Number.isInteger(cfg.port)) throw new Error('no engine port')
  return cfg.port
}

/** 转给本机引擎：只带必要的头，不带 dsh 的 Cookie / Origin */
function forward(req, res, port, path) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v
  headers.host = `127.0.0.1:${port}`
  const up = request({ host: '127.0.0.1', port, method: req.method, path, headers }, (r) => {
    const out = {}
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie' && v !== undefined) out[k] = v
    out['cache-control'] = out['cache-control'] ?? 'no-store'
    res.writeHead(r.statusCode ?? 502, out)
    r.pipe(res)
  })
  up.on('error', () => {
    if (!res.headersSent) deny(res, 502, 'dsh-cpamc: the model service is not running (run dsh-cpamc repair)')
    else res.destroy()
  })
  req.pipe(up)
}

/**
 * @param {{ admit: (req: unknown) => { rejection?: number } }} connection dsh 的连接服务
 * @param {() => string} home dsh-cpamc 的数据目录
 * @returns 一个 (req, res) 处理函数；kind 由调用方按注册的前缀给
 */
export function panelHandler(connection, home, kind) {
  return async (req, res) => {
    let admission
    try {
      admission = connection.admit(req)
    } catch {
      return deny(res, 403, 'forbidden')
    }
    if (!admission || 'rejection' in admission) {
      const code = admission?.rejection ?? 401
      return deny(res, code, code === 401 ? 'unauthorized: sign in to dsh first' : 'forbidden')
    }
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) return deny(res, 403, 'cross-site request refused')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let port
    try {
      port = await enginePort(home())
    } catch {
      return deny(res, 503, 'dsh-cpamc is not set up yet (run dsh-cpamc setup)')
    }
    if (kind === 'panel') {
      const rest = url.pathname.slice(PANEL_PREFIX.length) || '/'
      if (rest === '/' || rest === '/management.html') {
        if (method !== 'GET' && method !== 'HEAD') return deny(res, 405, 'method not allowed')
        let html
        try {
          html = await readFile(join(home(), 'static', 'management.html'))
        } catch {
          return deny(res, 503, 'the full management interface is not installed (run dsh-cpamc setup)')
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
        return res.end(method === 'HEAD' ? undefined : html)
      }
      return forward(req, res, port, `${rest}${url.search}`)
    }
    return forward(req, res, port, `${url.pathname}${url.search}`)
  }
}

/**
 * 注册全部路由；返回反注册函数列表。某个引擎前缀被别的插件占了就跳过（管理界面里填自定义地址也能用）。
 * @returns {{ disposers: (() => void)[]; enginePrefixes: string[] }}
 */
export function registerPanelRoutes(ws, connection, home, log = () => {}) {
  const disposers = []
  const enginePrefixes = []
  disposers.push(ws.register({ kind: 'prefix', path: PANEL_PREFIX, handler: panelHandler(connection, home, 'panel') }))
  for (const p of ENGINE_PREFIXES) {
    try {
      disposers.push(ws.register({ kind: 'prefix', path: p, handler: panelHandler(connection, home, 'engine') }))
      enginePrefixes.push(p)
    } catch (error) {
      log(`dsh-cpamc: route ${p} not registered (${error?.message ?? error}); the management interface will need a custom address`)
    }
  }
  return { disposers, enginePrefixes }
}
