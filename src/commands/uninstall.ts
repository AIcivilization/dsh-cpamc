// commands/uninstall.ts — 按台账逆序拆除（设计 §10.3）：对外访问 → dsh 接线 → 守护进程与引擎服务 → 确认端口释放 → home → dsh 插件。
// 每步失败不中断，最后汇总；有失败就保留 home 以便重试，不报告卸载成功。

import { cp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { disconnectDsh } from '../dsh/connect.js'
import { listAuthFiles } from '../engine/auth.js'
import { L } from '../i18n.js'
import { loadAll, saveAll } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { exists, timestamp } from '../util/fs.js'
import { isPortFree } from '../util/port.js'
import { fail, info, ok, warn } from '../util/output.js'
import { disable as disableRemote } from './remote.js'
import { removeDshPlugin } from '../integrations/dshplugin.js'
import { removeAdmin } from '../service/admin.js'

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^(y|yes|是)$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

export async function uninstall(ctx: Ctx, opts: { yes?: boolean; keepAuth?: boolean; removePlugin?: boolean }): Promise<number> {
  requireRootInVps(ctx)
  if (!(await exists(ctx.paths.home))) {
    info(L('没有安装过 dsh-cpamc（或已卸载）', 'dsh-cpamc is not installed (or already removed)'))
    return 0
  }
  const all = await loadAll(ctx)
  const authCount = (await listAuthFiles(ctx)).length
  if (!opts.yes) {
    info(L('将要：关闭远程访问 → 还原 dsh 配置 → 移除守护进程与引擎服务 → 删除 ' + ctx.paths.home + '（含各来源的登录凭据）', 'This will: disable remote access → restore dsh config → remove the daemon and engine services → delete ' + ctx.paths.home + ' (incl. source sign-in credentials)'))
    if (authCount && !opts.keepAuth) info(L(`其中包括 ${authCount} 个上游登录凭据（加 --keep-auth 可先备份出来）`, `including ${authCount} upstream login credentials (add --keep-auth to back them up first)`))
    if (!(await confirm(L('确认卸载？', 'Proceed with uninstall?')))) {
      info(L('已取消', 'Cancelled'))
      return 1
    }
  }

  const errors: string[] = []
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`)
      fail(`${name}: ${(error as Error).message}`)
    }
  }

  await step('remote', async () => {
    if (all.state.remote && all.state.remote.mode !== 'off') await disableRemote(ctx, all)
  })
  await step('daemon', async () => {
    if (ctx.serviceDisabled || (!all.state.bridgeService && !all.config.bridge)) return
    await serviceFor(ctx, 'bridge', all.config.proxy).uninstall()
    delete all.state.bridgeService
    ok(L('守护进程服务已移除', 'Daemon service removed'))
  })
  await step('dsh', async () => {
    if (!all.state.dsh) return
    const r = await disconnectDsh(ctx, all.state)
    ok(L(`dsh 配置已还原（patch：${r.patch}，凭据：${r.cred}）`, `dsh config restored (patch: ${r.patch}, credentials: ${r.cred})`))
  })
  await saveAll(ctx, all).catch(() => {})
  await step('admin', async () => {
    if (ctx.mode === 'vps') await removeAdmin()
  })
  await step('service', async () => {
    if (ctx.serviceDisabled) return
    await serviceFor(ctx).uninstall()
    ok(L('系统服务已移除', 'Service removed'))
  })
  // 端口要真的放出来才算卸载干净（R11）：只等、不杀——端口上要是别的程序，那不是我们能动的
  await step('ports', async () => {
    const ports = [all.config.port, all.config.bridge?.port].filter((p): p is number => typeof p === 'number' && p > 0)
    const busy = await waitPortsFree(ports, 10_000)
    if (busy.length) throw new Error(L(`端口 ${busy.join('、')} 仍被占用：服务可能还没完全退出，稍后再执行一次卸载`, `Port(s) ${busy.join(', ')} still in use: the service may not have exited yet; run uninstall again shortly`))
    ok(L(`端口 ${ports.join('、')} 已释放`, `Port(s) ${ports.join(', ')} released`))
  })
  await step('auth-backup', async () => {
    if (!opts.keepAuth || !authCount) return
    const dest = join(homedir(), `dsh-cpamc-auth-backup-${timestamp()}`)
    await cp(ctx.paths.auth, dest, { recursive: true, filter: (src) => !src.includes('/logs') })
    ok(L(`登录凭据已备份到 ${dest}`, `Credentials backed up to ${dest}`))
  })
  if (errors.length) {
    warn(L(`有 ${errors.length} 步失败，保留了 ${ctx.paths.home} 以便重试（再次执行 uninstall）`, `${errors.length} step(s) failed; kept ${ctx.paths.home} so you can retry (run uninstall again)`))
    return 1
  }
  // Windows：刚结束的进程可能还没完全退出、还占着目录，删除会短暂报 EBUSY / EPERM，重试一会儿
  await rm(ctx.paths.home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  ok(L(`已删除 ${ctx.paths.home}`, `Deleted ${ctx.paths.home}`))
  // 最后才从 dsh 移除插件本身：前面任何一步没完成，插件页都还在，可以重试
  try {
    if (await removeDshPlugin(ctx, all, { force: opts.removePlugin })) ok(L('已从 dsh 移除 dsh-cpamc 插件', 'Removed the dsh-cpamc plugin from dsh'))
  } catch (error) {
    warn(L(`服务与数据都已清理，但没能从 dsh 移除插件（${(error as Error).message}）：在 dsh 的插件管理里移除 dsh-cpamc 即可`, `Services and data are cleaned up, but the plugin could not be removed from dsh (${(error as Error).message}): remove dsh-cpamc from dsh's plugin manager`))
    return 1
  }
  ok(L('卸载完成', 'Uninstall complete'))
  info(L('最后可执行：npm uninstall -g dsh-cpamc', 'Finally you can run: npm uninstall -g dsh-cpamc'))
  return 0
}

/** 等这些端口都空出来；返回超时后仍被占用的端口 */
async function waitPortsFree(ports: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let busy = ports
  for (;;) {
    const next: number[] = []
    for (const p of busy) if (!(await isPortFree(p))) next.push(p)
    busy = next
    if (!busy.length || Date.now() > deadline) return busy
    await new Promise((r) => setTimeout(r, 300))
  }
}
