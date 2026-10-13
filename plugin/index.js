// plugin/index.js — dsh-cpamc 的 dsh 插件（宿主端）
//
// 只做一件事：把页面的请求转给 dsh-cpamc 守护进程的 /control/*。
// - 路由 /api-dsh-cpamc/call 与 /api-dsh-cpamc/token，挂在 dsh 自己的 webServer 上，所以先过 dsh 的登录校验；
// - 只收同源的 POST JSON，并且要带页面令牌（宿主经 index-inject / tapIndex 注入页面，跨站网页读不到）；
// - 守护进程的地址与控制密钥从 ~/.dsh-cpamc/bridge.json 读（dsh 与守护进程是同一个用户），浏览器永远拿不到；
// - 只转发白名单里的控制接口。

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerPanelRoutes } from './panel-proxy.js'
import { createDeployer, validateRequest as validateDeploy } from './remote-deploy.js'
import { readFileSync } from 'node:fs'

/** 本包根目录：插件就是完整的 dsh-cpamc 包，自带命令行 */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VPS_ROOT = '/opt/dsh-vps'

export const name = 'dsh-cpamc'
export const inject = []

const TOKEN_HEADER = 'x-dsh-cpamc-token'

/** 允许页面调用的守护进程接口：[方法, 路径正则] */
const ALLOWED = [
  ['GET', /^\/status$/],
  ['GET', /^\/sources(\?refresh=1)?$/],
  ['GET', /^\/usage(\?refresh=1)?$/],
  ['GET', /^\/stats$/],
  ['GET', /^\/keys$/],
  ['GET', /^\/keys-info$/],
  ['POST', /^\/keys$/],
  ['DELETE', /^\/keys\/[A-Za-z0-9._-]{1,40}$/],
  ['POST', /^\/keys\/[A-Za-z0-9._-]{1,40}\/rotate$/],
  ['POST', /^\/keys\/[A-Za-z0-9._-]{1,40}\/reveal$/],
  ['GET', /^\/endpoints$/],
  ['GET', /^\/service$/],
  ['POST', /^\/service\/restart$/],
  ['POST', /^\/panel\/(open|key)$/],
  ['GET', /^\/self$/],
  ['POST', /^\/self\/(update|uninstall)$/],
  ['GET', /^\/sources\/[a-z-]{2,20}\/models$/],
  ['POST', /^\/sources\/[a-z-]{2,20}\/models$/],
  ['POST', /^\/sources\/[a-z-]{2,20}\/(show|hide)$/],
]

function home() {
  return process.env.DSH_CPAMC_HOME || join(homedir(), '.dsh-cpamc')
}

async function daemonConfig() {
  return JSON.parse(await readFile(join(home(), 'bridge.json'), 'utf8'))
}

function sameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function check(req, token, needToken = true) {
  if (req.method !== 'POST') return { code: 405, error: 'POST only' }
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) return { code: 415, error: 'application/json only' }
  if (!sameOrigin(req)) return { code: 403, error: 'cross-site request refused' }
  if (needToken && String(req.headers[TOKEN_HEADER] ?? '') !== token) return { code: 403, error: 'wrong token' }
  return null
}

const exists = (p) => access(p).then(() => true, () => false)

/**
 * 从页面一键执行 setup / repair（只在本机模式：VPS 上要 root，页面只给命令）。
 * 后台任务：POST 立刻返回，页面轮询进度（{ action: 'status' }）。下载经代理时要好几分钟，
 * 一个挂着不回的请求会被中途断开，页面就什么都看不到（Windows 实测「准备中…」之后毫无反应）。
 * 同一时间只跑一个；结束后结果保留到下一次开始。
 */
let job = null
const JOB_TIMEOUT_MS = 20 * 60 * 1000
const strip = (t) => t.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r(?!\n)/g, '\n')

function jobView() {
  if (!job) return { job: null }
  const { child, timer, ...rest } = job
  return { job: { ...rest, output: rest.output.slice(-20000) } }
}

function startCli(action, args) {
  if (job && job.state === 'running') return jobView()
  job = { action, state: 'running', startedAt: Date.now(), endedAt: null, code: null, output: '' }
  const current = job
  let child
  try {
    child = spawn(process.execPath, [join(PKG_ROOT, 'bin/dsh-cpamc.js'), ...args], {
      windowsHide: true,
      // dsh 桌面版跑在 Electron 里：让它当普通 Node 用
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0', DSH_CPAMC_PROGRESS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    Object.assign(current, { state: 'failed', code: -1, endedAt: Date.now(), output: `could not start: ${e.message}` })
    return jobView()
  }
  current.child = child
  const add = (b) => { current.output = (current.output + strip(b.toString())).slice(-60000) }
  child.stdout.on('data', add)
  child.stderr.on('data', add)
  current.timer = setTimeout(() => {
    add('\n[dsh-cpamc] timed out after 20 minutes; stopped\n')
    child.kill('SIGTERM')
  }, JOB_TIMEOUT_MS)
  const done = (code, extra) => {
    if (current.endedAt) return
    clearTimeout(current.timer)
    if (extra) add(`\n${extra}\n`)
    Object.assign(current, { state: code === 0 ? 'success' : 'failed', code: code ?? -1, endedAt: Date.now() })
  }
  child.on('error', (e) => done(-1, e.message))
  child.on('exit', (code) => done(code))
  return jobView()
}

const DEPLOY_PATH = '/api/dsh-cpamc.deploy'

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export function apply(ctx) {
  const token = randomBytes(24).toString('hex')

  // 部署到服务器（设计 §9.1）：挂在 dsh 的 /api 通道，dsh 自己做同源与登录校验。没有 connection.fetch 的旧版 dsh 不注册
  ctx.inject(['connection'], (connCtx) => {
    const fetchApi = connCtx.connection?.fetch
    const version = pkgVersion()
    if (!fetchApi || typeof fetchApi.register !== 'function' || !version) return
    const deployer = createDeployer({ version })
    connCtx.effect?.(() => () => deployer.dispose(), 'dsh-cpamc: deployer')
    try {
      fetchApi.register({
        path: DEPLOY_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method === 'GET') return jsonResponse({ ...deployer.snapshot(), version })
          let body
          try {
            body = await request.json()
          } catch {
            return jsonResponse({ error: 'bad request' }, 400)
          }
          const lang = body?.lang === 'en' ? 'en' : 'zh'
          const checked = validateDeploy(body, lang)
          if (checked.error) return jsonResponse({ error: checked.error }, 400)
          const result = await deployer.start(checked.value, lang)
          if (result.error) return jsonResponse({ error: result.error }, result.status || 400)
          return jsonResponse(result, 202)
        },
      })
    } catch (error) {
      console.warn('[dsh-cpamc] deploy route not registered', error)
    }
  })

  // 原版完整管理界面经 dsh 自己的网页服务提供，先过 dsh 的登录校验（panel-proxy.js）。
  // 单独一个 inject：这个 dsh 版本没有 connection 服务时，下面的设置页照常可用
  ctx.inject(['webServer', 'connection'], (panelCtx) => {
    const ws = panelCtx.webServer
    const connection = panelCtx.connection
    if (!ws || typeof ws.register !== 'function' || !connection || typeof connection.admit !== 'function') return
    let disposers = []
    try {
      disposers = registerPanelRoutes(ws, connection, home, (m) => console.warn(m)).disposers
    } catch (error) {
      console.warn('[dsh-cpamc] management interface routes not registered', error)
    }
    try {
      panelCtx.effect?.(() => () => {
        for (const d of disposers.reverse()) {
          try {
            d?.()
          } catch {
            // 反注册失败不影响卸载
          }
        }
      }, 'dsh-cpamc: management interface routes')
    } catch {
      // 宿主不支持就算了
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    const ws = webCtx.webServer
    if (!ws || typeof ws.register !== 'function') return
    const disposers = []
    const track = (d) => disposers.push(d)

    track(
      ws.register({
        kind: 'exact',
        path: '/api-dsh-cpamc/call',
        handler: async (req, res) => {
          const bad = check(req, token)
          if (bad) return json(res, bad.code, { error: { code: 'refused', message: bad.error } })
          let call
          try {
            call = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return json(res, 400, { error: { code: 'invalid_json', message: 'invalid JSON' } })
          }
          const method = String(call.method ?? 'GET').toUpperCase()
          const path = String(call.path ?? '')
          if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) {
            return json(res, 403, { error: { code: 'not_allowed', message: `${method} ${path}` } })
          }
          let cfg
          try {
            cfg = await daemonConfig()
          } catch {
            return json(res, 503, { error: { code: 'daemon_not_configured', message: 'dsh-cpamc daemon not configured (run dsh-cpamc setup)' } })
          }
          try {
            const r = await fetch(`http://127.0.0.1:${cfg.port}/control${path}`, {
              method,
              headers: { Authorization: `Bearer ${cfg.secret}`, 'x-dsh-cpamc-lang': call.lang === 'en' ? 'en' : 'zh', ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
              body: call.body !== undefined && method !== 'GET' ? JSON.stringify(call.body) : undefined,
              signal: AbortSignal.timeout(90_000),
            })
            const text = await r.text()
            res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(text || '{}')
          } catch {
            return json(res, 503, { error: { code: 'daemon_unreachable', message: 'dsh-cpamc daemon is not running (run dsh-cpamc repair)' } })
          }
        },
      }),
    )

    // 页面上的「一键安装 / 修复」
    track(
      ws.register({
        kind: 'exact',
        path: '/api-dsh-cpamc/setup',
        handler: async (req, res) => {
          const bad = check(req, token)
          if (bad) return json(res, bad.code, { error: { code: 'refused', message: bad.error } })
          let body
          try {
            body = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return json(res, 400, { error: { code: 'invalid_json', message: 'invalid JSON' } })
          }
          if (body.action === 'status') return json(res, 200, jobView())
          if (await exists(VPS_ROOT)) return json(res, 200, { vps: true })
          const action = body.action === 'repair' ? 'repair' : 'setup'
          const lang = body.lang === 'en' ? 'en' : 'zh'
          return json(res, 202, startCli(action, action === 'repair' ? ['repair', '--lang', lang] : ['setup', '--skip-dsh-plugin', '--lang', lang]))
        },
      }),
    )

    // 令牌对不上时（dsh 重启、插件热更新）页面悄悄来换：只认同源 JSON，并且先过 dsh 自己的登录
    track(
      ws.register({
        kind: 'exact',
        path: '/api-dsh-cpamc/token',
        handler: (req, res) => {
          const bad = check(req, token, false)
          if (bad) return json(res, bad.code, { error: { code: 'refused', message: bad.error } })
          return json(res, 200, { token })
        },
      }),
    )

    if (typeof webCtx.on === 'function') {
      track(webCtx.on('webserver/index-inject', (table) => {
        if (Array.isArray(table)) table.push({ kind: 'global', name: '__DSH_CPAMC_TOKEN__', value: token })
      }))
    }
    if (typeof ws.tapIndex === 'function') {
      track(ws.tapIndex((html) => html.replace('</head>', `<script>window.__DSH_CPAMC_TOKEN__=${JSON.stringify(token)}</script></head>`)))
    }

    try {
      webCtx.effect?.(() => () => {
        for (const d of disposers.reverse()) {
          try {
            d?.()
          } catch {
            // 反注册失败不影响卸载
          }
        }
      }, 'dsh-cpamc: routes')
    } catch {
      // 宿主不支持就算了
    }
  })
}

export default { name, inject, apply }
