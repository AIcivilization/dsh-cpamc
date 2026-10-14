// commands/setup.ts — 一条命令：引擎 + 渠道插件 + 完整管理界面 → 守护进程 → 接进 dsh。可重复执行
//
// 所有模型都从引擎 127.0.0.1:8317/v1 出去；六个来源都由引擎提供，用户在「全部功能」里登录（设计 §10.1）。

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { locateDsh } from '../dsh/locate.js'
import { listModels, unauthStatus, waitHealthy } from '../engine/client.js'
import { installPanel, installPlugins } from '../engine/components.js'
import { activateVersion, currentVersion, fetchUpstreamAsset, installVersion, loadManifest, platformTarget } from '../engine/install.js'
import { DshModelError, isDshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { ensureDshKey, saveKeys, type KeyStore } from '../keys.js'
import { applyEngineConfig, dshKey, loadAll, saveAll, syncAll, type All } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { withLock } from '../state.js'
import { ensureDir } from '../util/fs.js'
import { bold, info, next, ok, skip, warn } from '../util/output.js'
import { findFreePort, isPortFree } from '../util/port.js'
import { detectProxy, normalizeProxyUrl, redactProxy } from '../util/proxy.js'
import { ensureDaemon } from '../daemon/service.js'
import { enablePort } from './remote.js'
import { dshModelHome, dshModelPorts, freePortAvoiding } from './migrate.js'
import { installDshPlugin } from '../integrations/dshplugin.js'
import { installAdmin } from '../service/admin.js'

export interface SetupOptions {
  port?: number
  profile?: string
  force?: boolean
  /** 代理地址；'none' = 不用代理 */
  proxy?: string
  skipDshPlugin?: boolean
}

export async function setup(ctx: Ctx, opts: SetupOptions): Promise<number> {
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    await ensureDir(ctx.paths.home, { owner: ctx.owner })
    resolveProxy(all, opts, await detectProxy(ctx.env, ctx.platform))
    if (opts.profile) all.config.dsh.profile = opts.profile

    const loc = await locateDsh(ctx, all.config.dsh.profile)
    all.config.dsh.profile = loc.profile
    ok(L(`dsh ${loc.version ?? ''}（profile：${loc.profile}）`, `dsh ${loc.version ?? ''} (profile: ${loc.profile})`))
    await saveAll(ctx, all)

    const failures: string[] = []
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (error) {
        if (!isDshModelError(error)) throw error
        failures.push(name)
        warn(`${error.message}${error.hint ? `\n  ${error.hint}` : ''}`)
      }
      await saveAll(ctx, all)
    }

    if (await dshModelHome(ctx)) {
      warn(L('这台机器上也装着 dsh-model：两者可以并存，但 dsh 里会有两组模型。可执行 dsh-cpamc migrate 迁移 Claude / Codex 登录与 key，确认正常后再卸载 dsh-model', 'dsh-model is also installed here: both can run, but dsh will show two model groups. Run dsh-cpamc migrate to bring over Claude / Codex sign-ins and keys, then uninstall dsh-model once everything works'))
    }

    info('')
    info(bold(L('模型服务（引擎）', 'Model service (engine)')))
    let engineRunning = false
    await step('engine', async () => {
      engineRunning = await ensureEngine(ctx, all, { port: opts.port })
    })
    if (failures.includes('engine')) {
      warn(L('引擎没装好，后面的步骤都依赖它，先停在这里', 'The engine is not ready and everything else depends on it; stopping here'))
      return 1
    }

    info('')
    info(bold(L('守护进程', 'Daemon')))
    await step('daemon', () => ensureDaemon(ctx, all))

    info('')
    info(bold(L('dsh 插件页', 'dsh plugin page')))
    if (opts.skipDshPlugin) skip(L('已跳过（--skip-dsh-plugin）', 'Skipped (--skip-dsh-plugin)'))
    else await step('dsh-plugin', () => installDshPlugin(ctx, all))

    // vps：让 dsh 管理页能直接点「更新 / 卸载」（root 执行，只认这两件事）
    if (ctx.mode === 'vps' && !ctx.serviceDisabled) await step('admin', () => installAdmin(ctx))

    // 服务器上：开 dsh-cpamc 自己的 HTTPS 端口给其他设备用（证书复用服务器上已有的，没有就自签；见 remote/tls.ts）。
    // <dsh 网址>/dsh-cpamc/v1 也照样提供，但 dsh 前面若有要求登录的网关，外部软件过不去
    if (ctx.mode === 'vps') {
      info('')
      info(bold(L('对外端口', 'Public port')))
      if (all.state.remote?.mode && all.state.remote.mode !== 'off' && all.state.remote.mode !== 'port') skip(L(`已用 ${all.state.remote.mode} 方式开放，保持不变`, `Already exposed via ${all.state.remote.mode}; unchanged`))
      else await step('public-port', () => enablePort(ctx, all))
    }

    info('')
    info(bold(L('同步到 dsh', 'Sync to dsh')))
    let ids: string[] = []
    if (engineRunning) {
      await step('sync', async () => {
        ids = await syncAll(ctx, all)
      })
    } else {
      await applyEngineConfig(ctx, all)
      skip(L('引擎没在运行，跳过同步到 dsh（启动后执行 dsh-cpamc models sync）', 'Engine not running; skipped syncing to dsh (run dsh-cpamc models sync once it is up)'))
    }
    const groups = new Map<string, number>()
    for (const id of ids) {
      const g = id.includes('/') ? id.split('/')[0]! : L('订阅', 'subscription')
      groups.set(g, (groups.get(g) ?? 0) + 1)
    }
    if (groups.size) info(`  ${[...groups].map(([g, n]) => `${g} ${n}`).join(' · ')}`)

    info('')
    if (failures.length) warn(L(`有 ${failures.length} 项没完成：${failures.join('、')}。修好后重新执行 dsh-cpamc setup 即可`, `${failures.length} item(s) not done: ${failures.join(', ')}. Fix them and re-run dsh-cpamc setup`))
    const base = all.state.remote?.mode === 'caddy' && all.state.remote.publicUrl ? all.state.remote.publicUrl : `http://127.0.0.1:${all.config.port}/v1`
    next(L(`在 dsh 的模型列表里选 dsh-cpamc 下的模型。本机其他软件：Base URL ${base}；其他设备：<你的 dsh 网址>/dsh-cpamc/v1。key 用 dsh-cpamc key add <名称> 领取`, `Pick a dsh-cpamc model in dsh. Software on this machine: Base URL ${base}; other devices: <your dsh address>/dsh-cpamc/v1. Get a key with dsh-cpamc key add <name>`))
    info(L('  登录来源：在 dsh 的「设置 → dsh-cpamc」里点「全部功能」，或执行 dsh-cpamc panel', '  Sign in to sources: Settings → dsh-cpamc → All features in dsh, or run dsh-cpamc panel'))
    return failures.length ? 1 : 0
  })
}

function resolveProxy(all: All, opts: SetupOptions, found: { url: string; source: string } | null): void {
  if (opts.proxy !== undefined) {
    all.config.proxy = opts.proxy === 'none' ? null : normalizeProxyUrl(opts.proxy)
  } else if (all.config.proxy === undefined) {
    all.config.proxy = found?.url ?? null
    if (found) ok(L(`检测到代理 ${redactProxy(found.url)}（来自 ${found.source}）`, `Detected proxy ${redactProxy(found.url)} (from ${found.source})`))
  }
  if (all.config.proxy) skip(L(`出站代理：${redactProxy(all.config.proxy)}（改用 --proxy <地址> 或 --proxy none）`, `Outbound proxy: ${redactProxy(all.config.proxy)} (change with --proxy <url> or --proxy none)`))
}

/** 订阅引擎：下载校验 → key → 端口 → engine.yaml → 服务 → 鉴权自检 → 同步模型到 dsh。setup --engine 与首次 login 共用 */
/** 返回引擎是否在运行（DSH_CPAMC_SERVICE=none 时可能没跑） */
export async function ensureEngine(ctx: Ctx, all: All, opts: { port?: number } = {}): Promise<boolean> {
  const { config, state, keys } = all
  if (config.proxy === undefined) {
    const found = await detectProxy(ctx.env, ctx.platform)
    config.proxy = found?.url ?? null
  }
  await ensureDir(ctx.paths.auth, { owner: ctx.owner })

  const manifest = await loadManifest()
  const target = platformTarget()
  const version = config.engine.version ?? manifest.version
  const asset = version === manifest.version ? manifest.assets[target] : await fetchUpstreamAsset(manifest, version, target, config.proxy)
  if (!asset) throw new DshModelError('unsupported_platform', L(`引擎没有 ${target} 的发布包`, `No engine build for ${target}`))
  const installed = await installVersion(ctx, version, asset, config.proxy)
  if ((await currentVersion(ctx)) !== version) await activateVersion(ctx, version)
  config.engine.version = version
  if (!state.engine.versions.includes(version)) state.engine.versions.push(version)
  ;(installed ? ok : skip)(L(`引擎 v${version}${installed ? ' 已下载并校验' : ' 已安装'}`, `Engine v${version} ${installed ? 'downloaded and verified' : 'already installed'}`))

  // 渠道插件包（四个 IDE 来源）与完整管理界面：和引擎一样锁版本、校验 sha256
  const pluginsNew = await installPlugins(ctx, manifest.plugins, config.proxy)
  ;(pluginsNew ? ok : skip)(L(`渠道插件包 v${manifest.plugins.version}（WorkBuddy、Trae、Qoder、ZCode）${pluginsNew ? '已下载并校验' : '已安装'}`, `Channel plugins v${manifest.plugins.version} (WorkBuddy, Trae, Qoder, ZCode) ${pluginsNew ? 'downloaded and verified' : 'already installed'}`))
  const panelNew = await installPanel(ctx, manifest.panel, config.proxy)
  ;(panelNew ? ok : skip)(L(`完整管理界面 v${manifest.panel.version}${panelNew ? ' 已下载并校验' : ' 已安装'}`, `Full management interface v${manifest.panel.version} ${panelNew ? 'downloaded and verified' : 'already installed'}`))
  state.components = { plugins: manifest.plugins.version, panel: manifest.panel.version }

  const { created } = ensureDshKey(keys)
  if (created) await saveKeys(ctx, keys)

  if (opts.port) config.port = opts.port
  // dsh-model 的端口即使现在空着也要避开：它的系统服务开机会起来抢（--port 明确指定时尊重用户）
  const avoid = opts.port ? [] : await dshModelPorts(ctx)
  if (avoid.includes(config.port)) {
    const free = await freePortAvoiding(config.port + 10, avoid, isPortFree)
    warn(L(`端口 ${config.port} 是 dsh-model 的，避开它，改用 ${free}`, `Port ${config.port} belongs to dsh-model; using ${free} instead`))
    config.port = free
  } else if (!(await isPortFree(config.port)) && !(await portIsOurs(config.port, keys))) {
    const free = await freePortAvoiding(config.port + 1, avoid, isPortFree)
    warn(L(`端口 ${config.port} 被其他程序占用，改用 ${free}`, `Port ${config.port} is taken by another program; using ${free}`))
    config.port = free
  }

  await saveAll(ctx, all)
  await applyEngineConfig(ctx, all)
  if (ctx.serviceDisabled) {
    skip(L('已跳过系统服务（DSH_CPAMC_SERVICE=none）', 'Skipped system service (DSH_CPAMC_SERVICE=none)'))
  } else {
    const svc = serviceFor(ctx)
    await svc.install()
    state.service = { kind: svc.kind, file: svc.spec.file, label: svc.spec.label }
    await saveAll(ctx, all)
    // 引擎只在启动时加载渠道插件：引擎或插件包换了版本都要重启
    if (installed || pluginsNew) await svc.restart()
  }
  if (!(await waitHealthy(config.port, ctx.serviceDisabled ? 1500 : 15_000))) {
    if (ctx.serviceDisabled) {
      warn(L('引擎未运行（服务已跳过）', 'Engine not running (service skipped)'))
      return false
    }
    throw new DshModelError('engine_unhealthy', L(`引擎没有在 127.0.0.1:${config.port} 上启动`, `Engine did not come up on 127.0.0.1:${config.port}`), L('查看日志：dsh-cpamc logs', 'Check logs: dsh-cpamc logs'))
  }
  const unauth = await unauthStatus(config.port)
  if (unauth !== 401) throw new DshModelError('auth_not_enforced', L(`不带 key 的请求返回了 ${unauth}（应为 401），已停止`, `Unauthenticated request returned ${unauth} (expected 401); stopping`))
  ok(L(`引擎已在 127.0.0.1:${config.port} 运行，鉴权已生效`, `Engine running on 127.0.0.1:${config.port} with auth enforced`))
  return true
}

async function portIsOurs(port: number, keys: KeyStore): Promise<boolean> {
  for (const k of keys.keys.filter((x) => !x.revokedAt)) {
    try {
      await listModels(port, k.key)
      return true
    } catch {
      // 不是我们
    }
  }
  return false
}
