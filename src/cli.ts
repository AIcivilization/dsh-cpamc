// cli.ts — 参数解析与分发；统一错误输出（中英双语）与退出码

import { parseArgs } from 'node:util'
import { connect, disconnect, models } from './commands/connect.js'
import { engine } from './commands/engine.js'
import { key } from './commands/key.js'
import { logs } from './commands/logs.js'
import { remote } from './commands/remote.js'
import { repair, service } from './commands/service.js'
import { setup } from './commands/setup.js'
import { doctor, status } from './commands/status.js'
import { uninstall } from './commands/uninstall.js'
import { adminRun, selfUpdate } from './commands/self.js'
import { supervise } from './service/windows.js'
import { bridge } from './commands/bridge.js'
import { loginInteractive, source, sources, stats } from './commands/sources.js'
import { createContext } from './context.js'
import { isDshModelError } from './errors.js'
import { L, initLang } from './i18n.js'
import { dim, fail, isJsonMode, printJson, setJsonMode } from './util/output.js'
import { pkgVersion } from './util/pkg.js'

const OPTIONS = {
  lang: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  port: { type: 'string' },
  profile: { type: 'string' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'keep-auth': { type: 'boolean' },
  device: { type: 'boolean' },
  replace: { type: 'boolean' },
  'accept-risk': { type: 'boolean' },
  via: { type: 'string' },
  domain: { type: 'string' },
  e2e: { type: 'boolean' },
  all: { type: 'boolean' },
  model: { type: 'string' },
  lines: { type: 'string' },
  proxy: { type: 'string' },
  bridge: { type: 'boolean' },
  'skip-dsh-plugin': { type: 'boolean' },
  to: { type: 'string' },
  'remove-plugin': { type: 'boolean' },
} as const

function help(): string {
  return L(
    `dsh-cpamc ${pkgVersion()} — 为 dsh 提供模型：WorkBuddy、Trae、Qoder、ZCode 与 Claude / Codex 订阅（本机 OpenAI 兼容端点，默认鉴权，可干净卸载）

用法：dsh-cpamc <命令> [选项]

  setup [--profile P] [--proxy URL|none]
                                       一键安装：引擎、渠道插件、完整管理界面，接进 dsh；可重复执行
  sources                              六个来源：登录状态、在 dsh 里显示还是隐藏、账号、模型数
  source show|hide <来源>               在 dsh 里显示 / 隐藏这个来源的模型（不改引擎里的设置）
  login <来源> [--accept-risk] / logout <来源>
                                       命令行登录 / 退出登录（平时请在「全部功能」里登录）
  panel                                打印完整管理界面的地址，并复制登录密钥
  stats                                按 key / 来源 / 模型的成功率、延迟、速度
  status                               一屏总览
  doctor [--e2e] [--all] [--model M]   逐项自检；--e2e 实测流式与工具调用
  connect-dsh [--dry-run] [--force]    写入 / 刷新 dsh 配置
  disconnect-dsh                       还原 dsh 配置
  models [sync]                        列出模型 / 同步到 dsh
  key list|add|revoke|rotate <名称>     管理访问 key（每台设备一把）
  remote enable --via ssh|tailscale|caddy [--domain D] / remote disable
                                       让你自己的其他设备访问
  engine version|upgrade [版本]|rollback 引擎版本管理
  service status|install|start|stop|restart|uninstall
  repair                               按台账修复配置、服务与接线
  logs [--lines N] [--bridge]          引擎 / bridge 日志
  update [--to 版本]                   更新到 npm 上的最新版（程序、dsh 插件、服务一起）
  uninstall [--yes] [--keep-auth]      干净卸载

通用选项：--lang zh|en  --json  --help  --version
环境变量：DSH_HOME、DSH_CPAMC_HOME、DSH_CPAMC_LANG`,
    `dsh-cpamc ${pkgVersion()} — models for dsh: WorkBuddy, Trae, Qoder, ZCode and your Claude / Codex subscriptions (local OpenAI-compatible endpoint, auth by default, clean uninstall)

Usage: dsh-cpamc <command> [options]

  setup [--profile P] [--proxy URL|none]
                                       Install the engine, channel plugins and the full management interface, wire into dsh; idempotent
  sources                              The six sources: sign-in state, shown or hidden in dsh, account, models
  source show|hide <source>            Show / hide this source's models in dsh (engine settings are not touched)
  login <source> [--accept-risk] / logout <source>
                                       Sign in / out from the command line (normally sign in under All features)
  panel                                Print the full management interface address and copy its sign-in key
  stats                                Success rate, latency and speed by key / source / model
  status                               Overview
  doctor [--e2e] [--all] [--model M]   Health checks; --e2e tests streaming and tool calls
  connect-dsh [--dry-run] [--force]    Write / refresh dsh config
  disconnect-dsh                       Restore dsh config
  models [sync]                        List models / sync them to dsh
  key list|add|revoke|rotate <name>    Manage access keys (one per device)
  remote enable --via ssh|tailscale|caddy [--domain D] / remote disable
                                       Access from your other devices
  engine version|upgrade [ver]|rollback  Engine version management
  service status|install|start|stop|restart|uninstall
  repair                               Repair config, service and wiring from the ledger
  logs [--lines N] [--bridge]          Engine / bridge logs
  update [--to ver]                    Update to the latest npm version (program, dsh plugin and services)
  uninstall [--yes] [--keep-auth]      Clean uninstall

Global: --lang zh|en  --json  --help  --version
Env: DSH_HOME, DSH_CPAMC_HOME, DSH_CPAMC_LANG`,
  )
}

export async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    initLang()
    fail(String((error as Error).message))
    return 2
  }
  const { values: o, positionals: [cmd, a1, a2] } = parsed
  initLang(o.lang)
  setJsonMode(Boolean(o.json))
  if (o.version) {
    console.log(pkgVersion())
    return 0
  }
  if (o.help || !cmd || cmd === 'help') {
    console.log(help())
    return 0
  }

  try {
    const ctx = await createContext()
    const port = o.port ? Number(o.port) : undefined
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(L(`端口不合法：${o.port}`, `Invalid port: ${o.port}`))
    switch (cmd) {
      case 'setup':
        return await setup(ctx, { port, profile: o.profile, force: o.force, proxy: o.proxy, skipDshPlugin: o['skip-dsh-plugin'] })
      case 'bridge':
        return await bridge(ctx, a1)
      case 'login':
        // 统一走守护进程：链接 + 码 / 贴回跳转地址，服务器上不需要浏览器（设计 §14.2）
        if (!a1) throw new Error(L('用法：dsh-cpamc login <来源>（dsh-cpamc sources 查看）', 'Usage: dsh-cpamc login <source> (see dsh-cpamc sources)'))
        return await loginInteractive(ctx, a1, { acceptRisk: o['accept-risk'] })
      case 'logout':
        if (!a1) throw new Error(L('用法：dsh-cpamc logout <来源>', 'Usage: dsh-cpamc logout <source>'))
        return await source(ctx, 'logout', a1, {})
      case 'sources':
        return await sources(ctx, { all: o.all })
      case 'source':
        return await source(ctx, a1, a2, { acceptRisk: o['accept-risk'] })
      case 'stats':
        return await stats(ctx)
      case 'status':
        return await status(ctx)
      case 'doctor':
        return await doctor(ctx, { e2e: o.e2e, all: o.all, model: o.model })
      case 'connect-dsh':
        return await connect(ctx, { dryRun: o['dry-run'], profile: o.profile, force: o.force })
      case 'disconnect-dsh':
        return await disconnect(ctx)
      case 'models':
        return await models(ctx, a1)
      case 'key':
        return await key(ctx, a1, a2)
      case 'remote':
        return await remote(ctx, a1, { via: o.via, domain: o.domain })
      case 'engine':
        return await engine(ctx, a1, a2)
      case 'service':
        // Windows 后台服务的常驻进程（由隐藏窗口脚本启动，不是给人用的）
        if (a1 === 'supervise' && a2) return await supervise(a2)
        return await service(ctx, a1)
      case 'repair':
        return await repair(ctx)
      case 'logs':
        return await logs(ctx, o.lines ? Number(o.lines) : undefined, o.bridge ? 'bridge' : 'engine')
      case 'uninstall':
        return await uninstall(ctx, { yes: o.yes, keepAuth: o['keep-auth'], removePlugin: o['remove-plugin'] })
      case 'admin-run':
        return await adminRun(ctx)
      case 'self-update':
      case 'update':
        return await selfUpdate(ctx, { to: o.to })
      default:
        fail(L(`未知命令：${cmd}`, `Unknown command: ${cmd}`))
        console.log(dim(L('查看帮助：dsh-cpamc --help', 'See: dsh-cpamc --help')))
        return 2
    }
  } catch (error) {
    if (isJsonMode()) {
      printJson({ ok: false, code: isDshModelError(error) ? error.code : 'error', message: (error as Error).message, hint: isDshModelError(error) ? error.hint : undefined })
    } else {
      fail((error as Error).message)
      if (isDshModelError(error) && error.hint) console.error(dim(`  ${error.hint}`))
      if (!isDshModelError(error) && process.env.DSH_CPAMC_DEBUG) console.error((error as Error).stack)
    }
    return 1
  }
}
