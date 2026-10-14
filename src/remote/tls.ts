// remote/tls.ts — 对外端口用的 HTTPS 证书（设计 §9.2）
//
// 免费证书签发要在 80 / 443 端口上验证域名，而服务器上这两个端口通常已被别的程序占用，
// dsh-cpamc 只用自己的端口没法自己申请。所以：
//   B. 只读地复用服务器上已有的、对应这个域名的正规证书（certbot、Caddy 的证书目录），复制一份到 tls/，原文件不动；
//   A. 找不到就用 openssl 生成自签证书，面板上显示指纹，说明怎么让软件信任它。
// 每天由 root 的定时任务重新同步一次（正规证书大约两个月续期）；守护进程发现 tls/ 里的文件变了就换上新证书。

import { X509Certificate, createPrivateKey } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { run } from '../util/exec.js'
import { atomicWrite, ensureDir, exists, readJson, writeJson, type Owner } from '../util/fs.js'

export interface CertInfo {
  /** reuse = 复用服务器上已有的正规证书；self-signed = 自己生成的 */
  source: 'reuse' | 'self-signed'
  /** 复用时证书原来的位置 */
  from?: string
  host: string
  /** SHA-256 指纹（AA:BB:…） */
  fingerprint: string
  notAfter: string
  issuer: string
}

export function tlsDir(home: string): string {
  return join(home, 'tls')
}

/** 证书能不能给这个主机名用：名字对得上、没过期、私钥配对 */
export function certUsable(certPem: string, keyPem: string, host: string, now = Date.now()): X509Certificate | null {
  try {
    const x = new X509Certificate(certPem)
    if (Date.parse(x.validTo) <= now || Date.parse(x.validFrom) > now) return null
    if (!(isIP(host) ? x.checkIP(host) : x.checkHost(host))) return null
    if (!x.checkPrivateKey(createPrivateKey(keyPem))) return null
    return x
  } catch {
    return null
  }
}

/** 服务器上已有证书可能在的位置（只读） */
async function candidates(host: string, letsencrypt = '/etc/letsencrypt'): Promise<{ cert: string; key: string }[]> {
  const out = [{ cert: `${letsencrypt}/live/${host}/fullchain.pem`, key: `${letsencrypt}/live/${host}/privkey.pem` }]
  // Caddy：<数据目录>/caddy/certificates/<签发机构>/<host>/<host>.crt / .key
  const roots = ['/var/lib/caddy/.local/share/caddy/certificates', '/root/.local/share/caddy/certificates', '/home/caddy/.local/share/caddy/certificates']
  for (const r of roots) {
    let issuers: string[] = []
    try {
      issuers = await readdir(r)
    } catch {
      continue
    }
    for (const i of issuers) out.push({ cert: join(r, i, host, `${host}.crt`), key: join(r, i, host, `${host}.key`) })
  }
  return out
}

/** 找一张能用的已有证书；找不到返回 null */
export async function findExistingCert(host: string, letsencrypt?: string): Promise<{ cert: string; key: string; from: string; x: X509Certificate } | null> {
  let best: { cert: string; key: string; from: string; x: X509Certificate } | null = null
  for (const c of await candidates(host, letsencrypt)) {
    if (!(await exists(c.cert)) || !(await exists(c.key))) continue
    const cert = await readFile(c.cert, 'utf8').catch(() => '')
    const key = await readFile(c.key, 'utf8').catch(() => '')
    const x = certUsable(cert, key, host)
    // 同一个域名有好几张时取最晚过期的
    if (x && (!best || Date.parse(x.validTo) > Date.parse(best.x.validTo))) best = { cert, key, from: c.cert, x }
  }
  return best
}

function fingerprintOf(x: X509Certificate): string {
  return x.fingerprint256
}

/** openssl 生成自签证书（P-256，两年） */
export async function selfSigned(host: string): Promise<{ cert: string; key: string }> {
  const dir = await import('node:os').then((os) => os.tmpdir())
  const base = join(dir, `dsh-cpamc-tls-${process.pid}-${Date.now()}`)
  const san = isIP(host) ? `IP:${host}` : `DNS:${host}`
  const r = await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '730', '-subj', `/CN=${host}`, '-addext', `subjectAltName=${san}`, '-keyout', `${base}.key`, '-out', `${base}.crt`])
  if (r.code !== 0) throw new Error(`openssl failed: ${r.stderr.trim().slice(-200)}`)
  const out = { cert: await readFile(`${base}.crt`, 'utf8'), key: await readFile(`${base}.key`, 'utf8') }
  const { rm } = await import('node:fs/promises')
  await rm(`${base}.crt`, { force: true })
  await rm(`${base}.key`, { force: true })
  return out
}

export async function loadCertInfo(home: string): Promise<CertInfo | null> {
  return readJson<CertInfo>(join(tlsDir(home), 'info.json'))
}

/**
 * 同步证书到 tls/：优先复用已有的正规证书；没有就沿用之前的自签证书（主机名没变且没过期），再没有就新生成。
 * 内容没变不写（守护进程据此判断要不要换证书）。返回当前证书信息。
 */
export async function syncCert(home: string, host: string, owner?: Owner, letsencrypt?: string): Promise<CertInfo> {
  const dir = tlsDir(home)
  await ensureDir(dir, { owner })
  const certFile = join(dir, 'cert.pem')
  const keyFile = join(dir, 'key.pem')
  let pair: { cert: string; key: string }
  let info: Omit<CertInfo, 'fingerprint' | 'notAfter' | 'issuer'>
  const found = await findExistingCert(host, letsencrypt)
  if (found) {
    pair = { cert: found.cert, key: found.key }
    info = { source: 'reuse', from: found.from, host }
  } else {
    const prev = await loadCertInfo(home)
    const cur = prev?.source === 'self-signed' && prev.host === host ? { cert: await readFile(certFile, 'utf8').catch(() => ''), key: await readFile(keyFile, 'utf8').catch(() => '') } : null
    pair = cur && certUsable(cur.cert, cur.key, host, Date.now() + 30 * 86400_000) ? cur : await selfSigned(host)
    info = { source: 'self-signed', host }
  }
  const x = new X509Certificate(pair.cert)
  const full: CertInfo = { ...info, fingerprint: fingerprintOf(x), notAfter: new Date(x.validTo).toISOString(), issuer: x.issuer.replace(/\n/g, ', ') }
  if ((await readFile(certFile, 'utf8').catch(() => '')) !== pair.cert || (await readFile(keyFile, 'utf8').catch(() => '')) !== pair.key) {
    await atomicWrite(keyFile, pair.key, { owner, mode: 0o600 })
    await atomicWrite(certFile, pair.cert, { owner, mode: 0o600 })
  }
  await writeJson(join(dir, 'info.json'), full, { owner })
  return full
}

/** 指纹的短形式（面板上方便核对） */
export function shortFingerprint(fp: string): string {
  return `${fp.split(':').slice(0, 8).join(':')}…`
}
