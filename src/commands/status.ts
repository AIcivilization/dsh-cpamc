// commands/status.ts — status（一屏总览）与 doctor（逐项检查，--e2e 实测每个模型）

import { join } from 'node:path'
import { bridgeConfigPath, bridgeHealthy, loadBridgeConfig } from '../daemon/runtime.js'
import type { Ctx } from '../context.js'
import { anyProviderPresent } from '../dsh/connect.js'
import { KEY_REF, readRef } from '../dsh/credentials.js'
import { listAuthFiles, summarize } from '../engine/auth.js'
import { healthy, listModels, probeStream, probeToolCall, unauthStatus, type ModelEntry } from '../engine/client.js'
import { currentBinary, currentVersion } from '../engine/install.js'
import { L } from '../i18n.js'
import { findActive, DSH_KEY_NAME } from '../keys.js'
import { loadAll } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { SOURCES } from '../sources.js'
import { exists, fileMode, readText, sha256 } from '../util/fs.js'
import { dim, green, info, isJsonMode, printJson, red, table, yellow } from '../util/output.js'
import { proxyReachable, redactProxy } from '../util/proxy.js'

export async function status(ctx: Ctx): Promise<number> {
  const all = await loadAll(ctx)
  const key = findActive(all.keys, DSH_KEY_NAME)?.key
  const engineInstalled = await exists(currentBinary(ctx))
  const version = engineInstalled ? await currentVersion(ctx) : null
  const svc = engineInstalled && !ctx.serviceDisabled ? await serviceFor(ctx).status() : null
  const up = engineInstalled ? await healthy(all.config.port) : false
  const models = up && key ? await listModels(all.config.port, key).catch(() => [] as ModelEntry[]) : []
  const { byUpstream } = summarize(await listAuthFiles(ctx))
  const dshOk = await anyProviderPresent(all.state).catch(() => false)
  const bridgeCfg = await loadBridgeConfig(ctx.paths.home)
  const bridgeUp = bridgeCfg ? await bridgeHealthy(bridgeCfg.port, bridgeCfg.secret) : false
  const logged = SOURCES.filter((u) => byUpstream[u.id]?.length).map((u) => u.id)

  const data = {
    mode: ctx.mode,
    home: ctx.paths.home,
    endpoint: { version, running: up, port: all.config.port, service: svc, models: models.length },
    daemon: bridgeCfg ? { port: bridgeCfg.port, running: bridgeUp } : null,
    sources: { signedIn: logged, hidden: all.config.hiddenSources ?? [] },
    dsh: all.state.dsh ? { profile: all.state.dsh.profile, providerPresent: dshOk } : null,
    remote: all.config.remote.mode,
    proxy: all.config.proxy ? redactProxy(all.config.proxy) : null,
    keys: all.keys.keys.filter((k) => !k.revokedAt).map((k) => k.name),
  }
  if (isJsonMode()) {
    printJson(data)
    return 0
  }
  const yes = (b: boolean, t: string, f: string) => (b ? green(t) : red(f))
  info(
    table([
      [L('模型服务', 'Model service'), engineInstalled ? yes(up, `127.0.0.1:${all.config.port}`, L('未运行（dsh-cpamc repair）', 'not running (dsh-cpamc repair)')) + dim(`  v${version ?? '-'}${svc ? ` · ${svc.detail ?? '-'}` : ''}`) : red(L('未安装（dsh-cpamc setup）', 'not installed (dsh-cpamc setup)'))],
      [L('守护进程', 'Daemon'), bridgeCfg ? yes(bridgeUp, `127.0.0.1:${bridgeCfg.port}`, L('未运行（dsh-cpamc repair）', 'not running (dsh-cpamc repair)')) : yellow(L('未配置（dsh-cpamc setup）', 'not configured (dsh-cpamc setup)'))],
      [L('模型', 'Models'), models.length ? String(models.length) : yellow('0')],
      [L('已登录来源', 'Signed-in sources'), logged.length ? logged.join(', ') : dim(L('无（在「全部功能」里登录，或 dsh-cpamc panel）', 'none (sign in under All features, or dsh-cpamc panel)'))],
      ['dsh', data.dsh ? yes(dshOk, `${data.dsh.profile} ✓`, L(`${data.dsh.profile}：provider 不在了（dsh-cpamc repair）`, `${data.dsh.profile}: provider missing (dsh-cpamc repair)`)) : yellow(L('未接入', 'not connected'))],
      [L('远程访问', 'Remote'), all.config.remote.mode],
      [L('出站代理', 'Proxy'), data.proxy ?? L('不使用', 'none')],
      ['Keys', data.keys.join(', ') || '-'],
    ]),
  )
  return 0
}

type Level = 'ok' | 'warn' | 'fail'
interface Check {
  id: string
  level: Level
  message: string
}

export async function doctor(ctx: Ctx, opts: { e2e?: boolean; all?: boolean; model?: string }): Promise<number> {
  const all = await loadAll(ctx)
  const checks: Check[] = []
  const add = (id: string, level: Level, message: string) => checks.push({ id, level, message })
  const key = findActive(all.keys, DSH_KEY_NAME)?.key

  const homeMode = await fileMode(ctx.paths.home)
  if (homeMode == null) add('home', 'fail', L(`${ctx.paths.home} 不存在（先 setup）`, `${ctx.paths.home} missing (run setup)`))
  else add('home', homeMode & 0o077 ? 'warn' : 'ok', L(`home 权限 ${homeMode.toString(8)}`, `home mode ${homeMode.toString(8)}`))

  for (const [id, file] of [['keys', ctx.paths.keys], ['engine-yaml', ctx.paths.engineYaml], ['mgmt', join(ctx.paths.home, 'mgmt.json')], ['bridge-config', bridgeConfigPath(ctx.paths.home)]] as const) {
    const m = await fileMode(file)
    if (m != null) add(id, m & 0o077 ? 'warn' : 'ok', `${file.split('/').pop()} ${m.toString(8)}`)
  }
  const authFiles = await listAuthFiles(ctx)
  const loose = []
  for (const f of authFiles) if (((await fileMode(join(ctx.paths.auth, f))) ?? 0) & 0o077) loose.push(f)
  if (authFiles.length) add('auth-perms', loose.length ? 'warn' : 'ok', loose.length ? L(`凭据文件权限过宽：${loose.join(', ')}`, `Credential files too permissive: ${loose.join(', ')}`) : L(`订阅凭据 ${authFiles.length} 个，权限正常`, `${authFiles.length} subscription credentials, permissions OK`))
  const { byUpstream, other } = summarize(authFiles)
  const multi = Object.entries(byUpstream).filter(([, f]) => f.length > 1)
  if (multi.length) add('single-account', 'warn', L(`同一上游有多个账号：${multi.map(([u]) => u).join(', ')}`, `Multiple accounts for: ${multi.map(([u]) => u).join(', ')}`))
  if (other.length) add('unknown-auth', 'warn', L(`不认识的凭据文件：${other.join(', ')}`, `Unrecognized credential files: ${other.join(', ')}`))

  // —— 统一端点 ——
  const engineInstalled = await exists(currentBinary(ctx))
  const version = engineInstalled ? await currentVersion(ctx) : null
  add('engine', engineInstalled ? (version === all.config.engine.version ? 'ok' : 'warn') : 'fail', engineInstalled ? `v${version}` : L('未安装（dsh-cpamc setup）', 'not installed (dsh-cpamc setup)'))
  if (engineInstalled && !ctx.serviceDisabled) {
    const s = await serviceFor(ctx).status()
    add('engine-service', s.running ? 'ok' : 'fail', `${serviceFor(ctx).kind}: ${s.detail ?? '-'}`)
  }
  if (all.config.proxy) {
    const reach = await proxyReachable(all.config.proxy)
    add('proxy', reach ? 'ok' : 'fail', reach ? L(`代理 ${redactProxy(all.config.proxy)} 可连接`, `Proxy ${redactProxy(all.config.proxy)} reachable`) : L(`代理 ${redactProxy(all.config.proxy)} 连不上（代理软件没开？dsh-cpamc setup --proxy <地址>|none）`, `Proxy ${redactProxy(all.config.proxy)} unreachable (proxy app not running? dsh-cpamc setup --proxy <url>|none)`))
  }
  const up = engineInstalled ? await healthy(all.config.port) : false
  if (engineInstalled) add('healthz', up ? 'ok' : 'fail', `127.0.0.1:${all.config.port}`)
  if (up) {
    const code = await unauthStatus(all.config.port)
    add('auth-enforced', code === 401 ? 'ok' : 'fail', L(`不带 key 请求返回 ${code}`, `unauthenticated request → ${code}`))
  }
  let models: ModelEntry[] = []
  if (up && key) {
    try {
      models = await listModels(all.config.port, key)
      add('models', models.length ? 'ok' : 'warn', models.length ? L(`${models.length} 个模型`, `${models.length} models`) : L('0 个模型（还没有来源登录）', '0 models (no source signed in yet)'))
    } catch (error) {
      add('models', 'fail', String((error as Error).message))
    }
  }

  // —— 守护进程 ——
  const bridgeCfg = await loadBridgeConfig(ctx.paths.home)
  // 守护进程（来源状态、key、统计、页面上的更新卸载）总要在跑；只有刻意跳过系统服务时不查
  if (!ctx.serviceDisabled) {
    if (!bridgeCfg) add('daemon', 'fail', L('守护进程没配置（dsh-cpamc setup）', 'Daemon not configured (dsh-cpamc setup)'))
    else {
      const bUp = await bridgeHealthy(bridgeCfg.port, bridgeCfg.secret)
      add('daemon', bUp ? 'ok' : 'fail', bUp ? L(`守护进程 127.0.0.1:${bridgeCfg.port} 运行中`, `daemon 127.0.0.1:${bridgeCfg.port} running`) : L('守护进程没在运行（dsh-cpamc logs --bridge；dsh-cpamc repair）', 'daemon not running (dsh-cpamc logs --bridge; dsh-cpamc repair)'))
    }
  }

  // —— dsh 接线 ——
  if (all.state.dsh) {
    const d = all.state.dsh
    const present = await anyProviderPresent(all.state).catch(() => false)
    add('dsh-provider', present ? 'ok' : models.length ? 'fail' : 'warn', present ? L(`dsh（${d.profile}）里有 dsh-cpamc`, `dsh-cpamc present in dsh (${d.profile})`) : models.length ? L('dsh 里没有 dsh-cpamc（dsh-cpamc repair）', 'dsh-cpamc missing in dsh (dsh-cpamc repair)') : L('dsh 里还没有 dsh-cpamc：引擎里还没有模型', 'dsh-cpamc not in dsh yet: the engine has no models'))
    const credText = await readText(d.credFile)
    add('dsh-key', readRef(credText) === key ? 'ok' : 'fail', readRef(credText) === key ? L(`${KEY_REF} 与 key 一致`, `${KEY_REF} matches`) : L(`${KEY_REF} 与 key 不一致（dsh-cpamc repair）`, `${KEY_REF} does not match (dsh-cpamc repair)`))
    const cm = await fileMode(d.credFile)
    // Windows 没有 Unix 权限位（读出来总是 666），权限靠用户目录本身的访问控制，不查
    if (cm != null && ctx.platform !== 'win32') add('dsh-cred-perms', cm === 0o600 ? 'ok' : 'fail', L(`.credentials.yaml 权限 ${cm.toString(8)}（dsh 要求 600）`, `.credentials.yaml mode ${cm.toString(8)} (dsh requires 600)`))
    const patchText = await readText(d.patchFile)
    if (patchText != null && d.writtenPatchSha && sha256(patchText) !== d.writtenPatchSha) {
      add('dsh-patch-edited', 'ok', L('cordis.patch.yml 在接线后被修改过（卸载时只会移除 dsh-cpamc 的部分）', 'cordis.patch.yml edited since connect (uninstall will remove only dsh-cpamc parts)'))
    }
  } else {
    add('dsh-provider', 'warn', L('还没接入 dsh（dsh-cpamc setup）', 'Not connected to dsh (dsh-cpamc setup)'))
  }
  if (ctx.env[KEY_REF]) add('env-override', 'warn', L(`环境变量 ${KEY_REF} 会覆盖 dsh 凭据里的值`, `Env var ${KEY_REF} overrides the value in dsh credentials`))
  if ((await exists('/etc/caddy/dsh-cpamc.conf')) && all.config.remote.mode !== 'caddy') add('caddy-orphan', 'warn', L('发现残留的 /etc/caddy/dsh-cpamc.conf', 'Found leftover /etc/caddy/dsh-cpamc.conf'))

  // —— e2e：默认每组（订阅按 owned_by，opencode/workbuddy 按前缀）取一个模型 ——
  const e2e: { model: string; stream: string; tool: string; ok: boolean }[] = []
  if (opts.e2e && key && models.length) {
    const groupOf = (m: ModelEntry) => (m.id.includes('/') ? m.id.split('/')[0]! : (m.owned_by ?? m.id))
    const pick = opts.model ? models.filter((m) => m.id === opts.model) : opts.all ? models : [...new Map(models.map((m) => [groupOf(m), m])).values()]
    for (const m of pick) {
      const s = await probeStream(all.config.port, key, m.id)
      const t = await probeToolCall(all.config.port, key, m.id)
      e2e.push({ model: m.id, stream: s.detail, tool: t.detail, ok: s.ok && t.ok })
    }
  }

  const failed = checks.some((c) => c.level === 'fail') || e2e.some((r) => !r.ok)
  if (isJsonMode()) {
    printJson({ ok: !failed, checks, e2e })
    return failed ? 1 : 0
  }
  const mark = (l: Level) => (l === 'ok' ? green('✓') : l === 'warn' ? yellow('!') : red('✗'))
  info(table(checks.map((c) => [mark(c.level), c.id, c.message])))
  if (e2e.length) {
    info('')
    info(table([[L('模型', 'Model'), L('流式', 'Stream'), L('工具调用', 'Tool call')], ...e2e.map((r) => [`${r.ok ? green('✓') : red('✗')} ${r.model}`, r.stream, r.tool])]))
  } else if (opts.e2e) {
    info(yellow(L('没有可测的模型', 'No models to test')))
  }
  return failed ? 1 : 0
}
