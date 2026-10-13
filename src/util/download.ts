// util/download.ts — 下载发布物（引擎、渠道插件包、管理界面），检测到 http 代理时经代理隧道下载
//
// Node 自带的 fetch 不认 HTTPS_PROXY，也不认系统代理：在要靠代理才连得上 GitHub 的网络里，
// 页面上的「一键准备」会直接 fetch failed（Windows 实测）。这里对 http:// 代理用 CONNECT 建隧道，
// 在隧道上走 TLS；socks 代理不支持，退回直连并在报错里说明。最多跟 5 次跳转（GitHub 发布物会跳到存储域名）。

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { redactProxy } from './proxy.js'

const TIMEOUT_MS = 10 * 60 * 1000
const UA = 'dsh-cpamc'

interface Got {
  status: number
  location?: string
  body: Buffer
}

function viaProxy(target: URL, proxy: URL): Promise<Got> {
  return new Promise((resolve, reject) => {
    const auth = proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {}
    const port = target.port || '443'
    const req = httpRequest({ host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${target.hostname}:${port}`, headers: { Host: `${target.hostname}:${port}`, ...auth }, timeout: 30_000 })
    req.once('timeout', () => req.destroy(new Error('proxy connect timeout')))
    req.once('error', reject)
    req.once('connect', (res, socket) => {
      // 30 秒只管建隧道；建好之后由下面的下载超时管，免得慢网速下载到一半被切断
      req.setTimeout(0)
      socket.setTimeout(0)
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT ${res.statusCode}`))
        return
      }
      const tls = tlsConnect({ socket, servername: target.hostname })
      const get = httpsRequest(
        { hostname: target.hostname, port, path: `${target.pathname}${target.search}`, method: 'GET', headers: { 'User-Agent': UA, Host: target.host }, createConnection: () => tls, agent: false, timeout: TIMEOUT_MS },
        (r) =>
          collect(
            r,
            (g) => {
              tls.destroy() // 下载完就关隧道，不留着连接
              resolve(g)
            },
            reject,
          ),
      )
      get.once('timeout', () => get.destroy(new Error('download timeout')))
      get.once('error', reject)
      get.end()
    })
    req.end()
  })
}

function direct(target: URL): Promise<Got> {
  return new Promise((resolve, reject) => {
    const get = httpsRequest(target, { headers: { 'User-Agent': UA }, timeout: TIMEOUT_MS }, (r) => collect(r, resolve, reject))
    get.once('timeout', () => get.destroy(new Error('download timeout')))
    get.once('error', reject)
    get.end()
  })
}

function collect(r: import('node:http').IncomingMessage, resolve: (g: Got) => void, reject: (e: Error) => void): void {
  const chunks: Buffer[] = []
  r.on('data', (c: Buffer) => chunks.push(c))
  r.once('error', reject)
  r.once('end', () => resolve({ status: r.statusCode ?? 0, ...(r.headers.location ? { location: r.headers.location } : {}), body: Buffer.concat(chunks) }))
}

/** 下载整个文件到内存（发布物最大二十来 MB） */
export async function download(url: string, proxy?: string | null, what = ''): Promise<Buffer> {
  const p = proxy && /^https?:\/\//i.test(proxy) ? new URL(proxy) : null
  let target = new URL(url)
  for (let hop = 0; hop < 6; hop++) {
    let got: Got
    try {
      got = p && target.protocol === 'https:' ? await viaProxy(target, p) : await direct(target)
    } catch (error) {
      const how = p ? L(`经代理 ${redactProxy(proxy!)}`, `via proxy ${redactProxy(proxy!)}`) : proxy ? L(`直连（socks 代理暂不支持，未使用 ${redactProxy(proxy)}）`, `directly (socks proxies are not supported; ${redactProxy(proxy)} was not used)`) : L('直连', 'directly')
      throw new DshModelError(
        'download_failed',
        L(`下载${what}失败：${how}连不上 ${target.hostname}（${(error as Error).message}）`, `Failed to download ${what}: could not reach ${target.hostname} ${how} (${(error as Error).message})`),
        L('检查网络或代理软件是否开着；也可以用 dsh-cpamc setup --proxy http://127.0.0.1:<端口> 指定代理后重试', 'Check the network or that the proxy app is running; or retry with dsh-cpamc setup --proxy http://127.0.0.1:<port>'),
      )
    }
    if (got.status >= 300 && got.status < 400 && got.location) {
      target = new URL(got.location, target)
      continue
    }
    if (got.status !== 200) throw new DshModelError('download_failed', L(`下载${what}失败：HTTP ${got.status}`, `Failed to download ${what}: HTTP ${got.status}`), target.toString())
    return got.body
  }
  throw new DshModelError('download_failed', L(`下载${what}失败：跳转次数太多`, `Failed to download ${what}: too many redirects`), url)
}

/** 下载文本（checksums.txt 之类） */
export async function downloadText(url: string, proxy?: string | null): Promise<string> {
  return (await download(url, proxy)).toString('utf8')
}
