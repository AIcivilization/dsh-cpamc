// commands/bridge.ts — dsh-cpamc bridge run（守护进程入口，系统服务调用，常驻）与 bridge status
//
// 守护进程只提供控制接口（来源状态与显示开关、key、统计、更新卸载，设计 §14），不转发模型请求。

import type { Ctx } from '../context.js'
import { Daemon } from '../daemon/core.js'
import { loadBridgeConfig } from '../daemon/runtime.js'
import { createControlServer } from '../daemon/server.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { info, isJsonMode, printJson } from '../util/output.js'

const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`)

export async function bridge(ctx: Ctx, sub: string | undefined): Promise<number> {
  if (sub === 'run') return run(ctx)
  if (!sub || sub === 'status') return status(ctx)
  throw new DshModelError('unknown_command', L(`未知子命令：bridge ${sub}`, `Unknown subcommand: bridge ${sub}`))
}

async function status(ctx: Ctx): Promise<number> {
  const cfg = await loadBridgeConfig(ctx.paths.home)
  if (!cfg) {
    info(L('守护进程未配置（dsh-cpamc setup）', 'Daemon not configured (dsh-cpamc setup)'))
    return 1
  }
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/control/status`, { headers: { Authorization: `Bearer ${cfg.secret}` }, signal: AbortSignal.timeout(5000) })
    const body = await r.json()
    if (isJsonMode()) printJson(body)
    else info(JSON.stringify(body, null, 2))
    return 0
  } catch {
    info(L(`守护进程没在 127.0.0.1:${cfg.port} 上运行`, `Daemon is not running on 127.0.0.1:${cfg.port}`))
    return 1
  }
}

async function run(ctx: Ctx): Promise<number> {
  const cfg = await loadBridgeConfig(ctx.paths.home)
  if (!cfg) throw new DshModelError('bridge_not_configured', L('守护进程未配置，先执行 dsh-cpamc setup', 'Daemon not configured; run dsh-cpamc setup first'))
  const daemon = new Daemon(ctx)
  await daemon.start()

  const server = createControlServer({
    port: cfg.port,
    secret: cfg.secret,
    log,
    onControl: (method, path, body, query) => daemon.handle(method, path, body, query),
  })
  await server.ready
  log(`daemon: listening on 127.0.0.1:${cfg.port}`)

  await new Promise<void>((resolve) => {
    const stop = () => {
      void daemon.stop().then(() => server.close()).then(resolve)
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
  return 0
}
