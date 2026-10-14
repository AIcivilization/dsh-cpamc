// commands/remote.ts — 让本人其他设备访问引擎。引擎始终只绑 127.0.0.1，入口有四种：
// port（vps 上默认：dsh-cpamc 自己的 HTTPS 端口，见 remote/tls.ts 与 daemon/public-endpoint.ts）/
// ssh（服务端零改动）/ tailscale serve / caddy（往服务器上已有的 Caddy 里加站点，保留给需要的人）

import { readFile, rm } from 'node:fs/promises'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { loadAll, saveAll } from '../ops.js'
import { withLock, type RemoteMode } from '../state.js'
import { run, which } from '../util/exec.js'
import { atomicWrite, exists, timestamp } from '../util/fs.js'
import { bold, info, next, ok, skip, warn } from '../util/output.js'
import { DEFAULT_PUBLIC_PORT, closeFirewall, detectDshHost, openFirewall, publicHost, publicIp, siteBlock } from '../remote/public.js'
import { syncCert } from '../remote/tls.js'
import { findFreePort, isPortFree } from '../util/port.js'
import { PKG_ROOT } from '../util/pkg.js'
import { isIP } from 'node:net'

/** 自己的 HTTPS 端口默认值（9443 留给 dsh-model 的对外端点，避开） */
export const DEFAULT_OWN_PORT = 9444

const CADDYFILE = '/etc/caddy/Caddyfile'
const CADDY_SNIPPET = '/etc/caddy/dsh-cpamc.conf'
const IMPORT_LINE = `import ${CADDY_SNIPPET}`
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

export async function remote(ctx: Ctx, sub: string | undefined, opts: { via?: string; domain?: string }): Promise<number> {
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    if (sub === 'disable') {
      await disable(ctx, all)
      await saveAll(ctx, all)
      return 0
    }
    if (sub !== 'enable') throw new DshModelError('unknown_command', L('用法：dsh-cpamc remote enable --via port|ssh|tailscale|caddy / remote disable', 'Usage: dsh-cpamc remote enable --via port|ssh|tailscale|caddy / remote disable'))

    const via = (opts.via ?? (ctx.mode === 'vps' ? 'port' : 'ssh')) as RemoteMode
    if (all.state.remote && all.state.remote.mode !== 'off' && all.state.remote.mode !== via) await disable(ctx, all)
    const port = all.config.port
    if (via === 'port') {
      await enablePort(ctx, all, { domain: opts.domain })
    } else if (via === 'ssh') {
      all.state.remote = { mode: 'ssh', files: [] }
      const target = `${ctx.env.SUDO_USER || userInfo().username}@${ctx.env.SSH_CONNECTION?.split(' ')[2] || hostname()}`
      info(bold(L('在你自己的设备上执行（保持运行）：', 'On your own device, run (keep it open):')))
      info(`  ssh -N -L ${port}:127.0.0.1:${port} ${target}`)
      info(L(`然后在那台设备的软件里填：Base URL http://127.0.0.1:${port}/v1`, `Then in software on that device use: Base URL http://127.0.0.1:${port}/v1`))
    } else if (via === 'tailscale') {
      if (!(await which('tailscale'))) throw new DshModelError('tailscale_missing', L('没找到 tailscale 命令', 'tailscale command not found'), L('先安装并登录 Tailscale', 'Install and log in to Tailscale first'))
      const r = await run('tailscale', ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`])
      if (r.code !== 0) throw new DshModelError('tailscale_failed', L(`tailscale serve 失败：${r.stderr.trim()}`, `tailscale serve failed: ${r.stderr.trim()}`))
      all.state.remote = { mode: 'tailscale', files: [], tailscaleHttpsPort: port }
      const dns = await run('tailscale', ['status', '--json'])
      const name = (() => {
        try {
          return String((JSON.parse(dns.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName ?? '').replace(/\.$/, '')
        } catch {
          return ''
        }
      })()
      ok(L('已通过 tailscale serve 开放给你的 tailnet', 'Exposed to your tailnet via tailscale serve'))
      info(L(`  Base URL：https://${name || '<本机 tailnet 域名>'}:${port}/v1`, `  Base URL: https://${name || '<this machine tailnet name>'}:${port}/v1`))
    } else if (via === 'caddy') {
      if (ctx.mode !== 'vps') throw new DshModelError('caddy_vps_only', L('caddy 方式只用于 dsh-vps 所在的服务器', 'The caddy method is only for the dsh-vps server'))
      if (opts.domain && !DOMAIN_RE.test(opts.domain)) throw new DshModelError('invalid_domain', L(`域名不合法：${opts.domain}`, `Invalid domain: ${opts.domain}`))
      // 默认用 dsh 自己的域名（只有 IP 时用 <ip>.sslip.io），另开一个端口
      const host = await publicHost(opts.domain ?? all.config.remote.domain)
      const publicPort = all.config.remote.publicPort ?? DEFAULT_PUBLIC_PORT
      await enableCaddy(ctx, all, host, publicPort)
      all.config.remote.domain = host
      all.config.remote.publicPort = publicPort
      ok(L(`对外端点已开通：https://${host}:${publicPort}/v1（只认 dsh-cpamc 的 key）`, `Public endpoint enabled: https://${host}:${publicPort}/v1 (dsh-cpamc keys only)`))
    } else {
      throw new DshModelError('unknown_remote', L(`不支持的方式：${via}`, `Unsupported method: ${via}`))
    }
    all.config.remote.mode = via
    await saveAll(ctx, all)
    next(L('为每台设备单独发一把 key：dsh-cpamc key add <设备名>（丢了就 key revoke）', 'Issue one key per device: dsh-cpamc key add <device> (revoke it if lost)'))
    return 0
  })
}

/**
 * port：dsh-cpamc 自己的 HTTPS 端口（默认 9444）。要 root：放行防火墙、装每天同步证书的定时任务。
 * 主机名：--domain → 之前用过的 → 服务器上已有站点的域名（只读）→ 公网 IP（只能用自签证书）。
 */
export async function enablePort(ctx: Ctx, all: Awaited<ReturnType<typeof loadAll>>, opts: { domain?: string } = {}): Promise<void> {
  if (ctx.mode !== 'vps') throw new DshModelError('port_vps_only', L('对外端口目前只用于服务器（需要 root 放行防火墙）', 'The public port is currently for servers only (needs root to open the firewall)'))
  if (opts.domain && !DOMAIN_RE.test(opts.domain) && !isIP(opts.domain)) throw new DshModelError('invalid_domain', L(`域名不合法：${opts.domain}`, `Invalid domain: ${opts.domain}`))
  const site = await detectDshHost()
  const host = opts.domain ?? all.config.remote.domain ?? (site?.host && !site.host.endsWith('.sslip.io') ? site.host : null) ?? (await publicIp())
  if (!host) throw new DshModelError('no_public_ip', L('查不到这台服务器的公网地址', 'Cannot determine the public address of this server'), L('用 --domain 指定：dsh-cpamc remote enable --via port --domain 你的域名', 'Pass it explicitly: dsh-cpamc remote enable --via port --domain your.domain'))
  let publicPort = all.config.remote.publicPort && all.config.remote.mode === 'port' ? all.config.remote.publicPort : DEFAULT_OWN_PORT
  if (all.state.remote?.mode !== 'port' && !(await isPortFree(publicPort, '0.0.0.0'))) publicPort = await findFreePort(publicPort + 1, '0.0.0.0')
  const cert = await syncCert(ctx.paths.home, host, ctx.owner)
  await openFirewall(publicPort)
  const units = await installCertTimer(ctx)
  all.state.remote = { mode: 'port', files: [], publicUrl: `https://${host}:${publicPort}/v1`, firewallPort: publicPort, certTimer: units }
  all.config.remote = { ...all.config.remote, mode: 'port', domain: host, publicPort }
  ok(L(`对外端点：https://${host}:${publicPort}/v1（只认 dsh-cpamc 的 key；守护进程半分钟内开始监听）`, `Public endpoint: https://${host}:${publicPort}/v1 (dsh-cpamc keys only; the daemon starts listening within half a minute)`))
  if (cert.source === 'reuse') ok(L(`证书：复用服务器上已有的正规证书（${cert.issuer.split(',')[0]}，${cert.notAfter.slice(0, 10)} 到期，每天自动同步）`, `Certificate: reusing the server's existing certificate (${cert.issuer.split(',')[0]}, expires ${cert.notAfter.slice(0, 10)}, synced daily)`))
  else warn(L(`证书：服务器上没有 ${host} 的正规证书，用了自签证书。其他软件要信任它，指纹：${cert.fingerprint}`, `Certificate: no regular certificate for ${host} on this server, using a self-signed one. Other software must trust it; fingerprint: ${cert.fingerprint}`))
  info(L('  云服务器的安全组 / 防火墙面板里也要放行这个端口', '  Also allow this port in your cloud provider\'s security group / firewall panel'))
}

const CERT_SERVICE = '/etc/systemd/system/dsh-cpamc-cert.service'
const CERT_TIMER = '/etc/systemd/system/dsh-cpamc-cert.timer'

/** 每天同步一次证书（正规证书大约两个月续期一次）：root 运行 dsh-cpamc cert sync */
async function installCertTimer(ctx: Ctx): Promise<string[]> {
  const exec = `${process.execPath} ${join(PKG_ROOT, 'bin', 'dsh-cpamc.js')} cert sync`
  await atomicWrite(CERT_SERVICE, ['# Generated by dsh-cpamc. 由 dsh-cpamc 生成：同步对外端口的 HTTPS 证书', '[Unit]', 'Description=dsh-cpamc public endpoint certificate sync', '', '[Service]', 'Type=oneshot', `Environment=DSH_CPAMC_HOME=${ctx.paths.home}`, `ExecStart=${exec}`, ''].join('\n'), { mode: 0o644 })
  await atomicWrite(CERT_TIMER, ['# Generated by dsh-cpamc. 由 dsh-cpamc 生成', '[Unit]', 'Description=dsh-cpamc daily certificate sync', '', '[Timer]', 'OnBootSec=5min', 'OnUnitActiveSec=1d', 'Persistent=true', '', '[Install]', 'WantedBy=timers.target', ''].join('\n'), { mode: 0o644 })
  await run('systemctl', ['daemon-reload'])
  await run('systemctl', ['enable', '--now', 'dsh-cpamc-cert.timer'])
  return [CERT_TIMER, CERT_SERVICE]
}

async function removeCertTimer(units: string[] | undefined): Promise<void> {
  if (!units?.length) return
  await run('systemctl', ['disable', '--now', 'dsh-cpamc-cert.timer'])
  for (const f of units) await rm(f, { force: true })
  await run('systemctl', ['daemon-reload'])
}

/** 定时任务调用：按已开的对外端口同步证书 */
export async function certSync(ctx: Ctx): Promise<number> {
  const all = await loadAll(ctx)
  if (all.state.remote?.mode !== 'port' || !all.config.remote.domain) {
    skip(L('没有开对外端口，不需要同步证书', 'No public port enabled; nothing to sync'))
    return 0
  }
  const c = await syncCert(ctx.paths.home, all.config.remote.domain, ctx.owner)
  ok(L(`证书已同步（${c.source === 'reuse' ? '复用已有证书' : '自签'}，${c.notAfter.slice(0, 10)} 到期）`, `Certificate synced (${c.source === 'reuse' ? 'reused' : 'self-signed'}, expires ${c.notAfter.slice(0, 10)})`))
  return 0
}

export async function enableCaddy(ctx: Ctx, all: Awaited<ReturnType<typeof loadAll>>, domain: string, publicPort = DEFAULT_PUBLIC_PORT): Promise<void> {
  if (!(await exists(CADDYFILE))) throw new DshModelError('caddy_missing', L(`没找到 ${CADDYFILE}`, `${CADDYFILE} not found`))
  const original = await readFile(CADDYFILE, 'utf8')
  const backup = join(ctx.paths.backups, `Caddyfile.${timestamp()}`)
  await atomicWrite(backup, original)
  await atomicWrite(CADDY_SNIPPET, siteBlock(domain, publicPort, all.config.port), { mode: 0o644 })
  const hasImport = original.split('\n').some((l) => l.trim() === IMPORT_LINE)
  if (!hasImport) await atomicWrite(CADDYFILE, original.replace(/\n*$/, '\n') + IMPORT_LINE + '\n', { mode: 0o644 })
  const v = await run('caddy', ['validate', '--config', CADDYFILE, '--adapter', 'caddyfile'])
  if (v.code !== 0) {
    await atomicWrite(CADDYFILE, original, { mode: 0o644 })
    await rm(CADDY_SNIPPET, { force: true })
    throw new DshModelError('caddy_invalid', L(`Caddy 配置校验失败，已回滚：${v.stderr.trim().slice(-300)}`, `Caddy config validation failed; rolled back: ${v.stderr.trim().slice(-300)}`))
  }
  const r = await run('systemctl', ['reload', 'caddy'])
  if (r.code !== 0) throw new DshModelError('caddy_reload_failed', L(`Caddy 重载失败：${r.stderr.trim()}`, `Caddy reload failed: ${r.stderr.trim()}`))
  await openFirewall(publicPort)
  all.state.remote = { mode: 'caddy', files: [CADDY_SNIPPET], caddyImportLine: hasImport ? undefined : IMPORT_LINE, caddyfile: CADDYFILE, publicUrl: `https://${domain}:${publicPort}/v1`, firewallPort: publicPort }
  all.config.remote.mode = 'caddy'
}

export async function disable(ctx: Ctx, all: Awaited<ReturnType<typeof loadAll>>): Promise<void> {
  const r = all.state.remote
  if (!r || r.mode === 'off') {
    skip(L('远程访问本来就是关闭的', 'Remote access is already off'))
    return
  }
  if (r.mode === 'tailscale' && r.tailscaleHttpsPort) {
    await run('tailscale', ['serve', `--https=${r.tailscaleHttpsPort}`, 'off'])
  }
  if (r.mode === 'port') {
    if (r.firewallPort) await closeFirewall(r.firewallPort)
    await removeCertTimer(r.certTimer)
  }
  if (r.mode === 'caddy') {
    for (const f of r.files) await rm(f, { force: true })
    if (r.caddyImportLine && r.caddyfile && (await exists(r.caddyfile))) {
      const text = await readFile(r.caddyfile, 'utf8')
      const kept = text.split('\n').filter((l) => l.trim() !== r.caddyImportLine).join('\n')
      await atomicWrite(r.caddyfile, kept, { mode: 0o644 })
    }
    await run('systemctl', ['reload', 'caddy'])
    if (r.firewallPort) await closeFirewall(r.firewallPort)
  }
  all.state.remote = { mode: 'off', files: [] }
  all.config.remote.mode = 'off'
  ok(L('已关闭远程访问', 'Remote access disabled'))
}
