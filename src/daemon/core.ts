// daemon/core.ts — dsh-cpamc 守护进程的核心（设计 §14）
//
// 跑在 bridge 服务进程里（com.dsh-cpamc.bridge / dsh-cpamc-bridge.service），所有操作都不需要 root：
// 引擎配置与 dsh 配置在 vps 模式下归 dsh 用户，引擎热重载，dsh 热加载。
// 职责：六个来源的状态与「在 dsh 里显示 / 隐藏」、命令行备用登录（引擎 OAuth）、key 管理、用量统计、页面上的更新卸载。
// 显示 / 隐藏只影响 dsh 的模型清单，不改引擎里的凭据；登录与完整设置在原版管理界面里做。
// CLI 与 dsh 插件都只通过 /control/* 调这里，逻辑只有一份。

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { latestVersion, selfJobLog } from '../commands/self.js'
import { adminInstalled, adminRequestPath, type AdminRequest } from '../service/admin.js'
import { atomicWrite } from '../util/fs.js'
import { lang } from '../i18n.js'
import { which } from '../util/exec.js'
import { spawnDetached } from '../util/detach.js'
import { PKG_ROOT, pkgVersion } from '../util/pkg.js'
import { randomBytes } from 'node:crypto'
import type { Ctx } from '../context.js'
import { tightenAuthPerms } from '../engine/auth.js'
import { Mgmt, loadMgmt, type CredentialEntry } from '../engine/mgmt.js'
import { engineApiKeys } from '../engine/config.js'
import { healthy, waitHealthy } from '../engine/client.js'
import { currentBinary, currentVersion } from '../engine/install.js'
import { serviceFor, type ServiceStatus } from '../service/index.js'
import { loadBridgeConfig } from './runtime.js'
import YAML from 'yaml'
import { DshModelError, isDshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { DSH_KEY_NAME, addKey, loadKeys, revokeKey, rotateKey, saveKeys } from '../keys.js'
import { applyEngineConfig, defaultSelection, dshCandidates, dshKey, loadAll, saveAll, syncAll } from '../ops.js'
import { isChatModel, pickedFor } from '../dsh/pick.js'
import { SOURCES, credsFor, findSource, paymentRequired, type SourceDef } from '../sources.js'
import { withLock } from '../state.js'
import { riskNotice as upstreamRiskNotice } from '../upstreams.js'
import { getUpstream } from '../upstreams.js'
import { redactKey } from '../util/redact.js'
import { Stats, type StatsSnapshot } from './stats.js'
import { CHECKIN_SOURCES, describeReward, loadLedger, mergeStatus, parseTraeCredits, parseWorkbuddyAccounts, recordCheckin, type CheckinStatus } from './checkin.js'
import { USAGE_UNSUPPORTED, probeEngineSource, fetchEngineUsage, usageFilePath, type SourceUsage } from './usage.js'
import { writeJson } from '../util/fs.js'

const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const USAGE_POLL_MS = 5000
const STATS_SAVE_MS = 60_000
const RESYNC_RETRY_MS = 60_000
/** 多久比对一次引擎凭据（原版管理界面里登录 / 停用后，dsh 跟着变） */
const CRED_WATCH_MS = 20_000
const USAGE_REFRESH_MS = 5 * 60 * 1000
/** 查不了用量的来源多久重新实测一次 */
const PROBE_MS = 6 * 60 * 60 * 1000

export interface SourceState {
  id: string
  label: string
  /** 引擎的渠道插件（IDE 来源）；false = 引擎原生订阅 */
  plugin: boolean
  login: SourceDef['login']
  riskAck: boolean
  subscribeUrl?: string
  pricing: SourceDef['pricing']
  loggedIn: boolean
  /** 引擎里还有没停用的凭据（停用是在原版管理界面里做的，这里只读） */
  active: boolean
  /** 在 dsh 里显示（显示 / 隐藏开关） */
  shown: boolean
  account?: string
  detail?: string
  models: number
  /** 订阅用量（已登录且已打开的来源才查） */
  usage?: SourceUsage
}

export interface LoginSession {
  id: string
  source: string
  kind: SourceDef['login']
  status: 'pending' | 'ok' | 'error' | 'cancelled'
  url?: string
  userCode?: string
  expiresAt?: string
  /** 回调式：用户要把浏览器跳转到的地址贴回来 */
  needsPaste: boolean
  error?: string
  startedAt: string
}

interface SessionInternal extends LoginSession {
  engineState?: string
  provider?: string
  before?: string[]
  abort?: AbortController
}

const log_ = (m: string) => log(m)
/** 进程还在不在（signal 0 只做检查） */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`)

export class Daemon {
  private sessions = new Map<string, SessionInternal>()
  private stats: Stats
  private timers: NodeJS.Timeout[] = []
  private resyncTimer?: NodeJS.Timeout
  private keyNames = new Map<string, string>()
  private usageCache = new Map<string, SourceUsage>()
  private usageInflight?: Promise<void>
  /** 上次同步进 dsh 时引擎凭据的指纹：在原版管理界面里登录 / 退出 / 停用之后，据此自动重新同步 */
  private credSig = ''

  constructor(private readonly ctx: Ctx) {
    this.stats = new Stats(Stats.path(ctx.paths.home), ctx.owner)
  }

  // —— 生命周期 ——

  async start(): Promise<void> {
    await this.stats.load()
    await this.reloadKeyNames()
    void this.watchCredentials()
    this.timers.push(setInterval(() => void this.watchCredentials(), CRED_WATCH_MS))
    this.timers.push(setInterval(() => void this.pollUsage(), USAGE_POLL_MS))
    this.timers.push(setInterval(() => void this.stats.save().catch(() => {}), STATS_SAVE_MS))
    this.timers.push(setInterval(() => void this.reloadKeyNames(), STATS_SAVE_MS))
    this.timers.push(setInterval(() => void this.refreshUsage(), USAGE_REFRESH_MS))
    // 每日签到：启动一分钟后看一次，之后每小时一次（今天已签过的跳过）
    setTimeout(() => void this.autoCheckin(), 60_000)
    this.timers.push(setInterval(() => void this.autoCheckin(), 60 * 60 * 1000))
    setTimeout(() => void this.refreshUsage(), 3000)
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    clearTimeout(this.resyncTimer)
    for (const s of this.sessions.values()) s.abort?.abort()
    await this.stats.save().catch(() => {})
  }

  private async mgmt(): Promise<Mgmt> {
    const all = await loadAll(this.ctx)
    return Mgmt.forCtx(this.ctx, all.config.port)
  }

  /** 全量同步（引擎配置 + dsh）。CLI 正持锁时稍后重试 */
  async resync(): Promise<void> {
    try {
      await withLock(this.ctx, async () => {
        const all = await loadAll(this.ctx)
        await syncAll(this.ctx, all, { quiet: true })
      })
      log('daemon: engine + dsh synced')
    } catch (error) {
      log(`daemon: sync deferred: ${isDshModelError(error) ? error.code : String(error)}`)
      clearTimeout(this.resyncTimer)
      this.resyncTimer = setTimeout(() => void this.resync(), RESYNC_RETRY_MS)
    }
  }

  /**
   * 登录、退出、停用凭据大多在原版管理界面里做，守护进程不会收到通知：
   * 定期比对引擎凭据（名字 + 停用状态），变了就重新同步 dsh 的模型清单。
   */
  private async watchCredentials(): Promise<void> {
    let creds: CredentialEntry[]
    try {
      creds = await (await this.mgmt()).credentials()
    } catch {
      return // 引擎没起来
    }
    const sig = creds.map((c) => `${c.name}:${c.disabled ? 0 : 1}`).sort().join(',')
    if (sig === this.credSig) return
    const first = this.credSig === ''
    this.credSig = sig
    if (!first) {
      log('daemon: engine credentials changed; resyncing')
      void this.refreshUsage()
    }
    void this.resync()
  }

  // —— 用量统计 ——

  private async reloadKeyNames(): Promise<void> {
    const keys = await loadKeys(this.ctx).catch(() => ({ keys: [] }))
    this.keyNames = new Map(keys.keys.map((k) => [k.key, k.name]))
  }

  private async pollUsage(): Promise<void> {
    try {
      const batch = await (await this.mgmt()).usageQueue(1000)
      if (batch.length) this.stats.add(batch, (k) => (k ? (this.keyNames.get(k) ?? 'unknown') : 'unknown'))
    } catch {
      // 引擎重启中 / 还没配管理接口：下一轮再取
    }
  }

  statsSnapshot(): StatsSnapshot {
    return this.stats.snapshot()
  }

  // —— 来源 ——

  async sources(): Promise<SourceState[]> {
    const list = (await this.sourcesRaw()).map((s) => {
      const u = this.usageCache.get(s.id)
      return u && s.loggedIn ? { ...s, usage: u } : s
    })
    // 排序：可用 → 已登录但没有可用额度 / 已停用 → 未登录；同档保持注册顺序
    const rank = (s: SourceState) => (s.loggedIn && s.active && !s.usage?.noAccess ? 0 : s.loggedIn ? 1 : 2)
    return list.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s)
  }

  private async sourcesRaw(): Promise<SourceState[]> {
    const all = await loadAll(this.ctx)
    const hidden = new Set(all.config.hiddenSources ?? [])
    let creds: CredentialEntry[] = []
    const models = new Map<string, number>()
    try {
      const m = await this.mgmt()
      creds = await m.credentials()
      // 每个来源能服务的模型数：管理接口按凭据列模型（只数没停用的）
      for (const def of SOURCES) {
        const ids = new Set<string>()
        for (const c of credsFor(creds, def).filter((x) => !x.disabled)) for (const mm of await m.credentialModels(c.name).catch(() => [])) ids.add(mm.id)
        if (ids.size) models.set(def.id, ids.size)
      }
    } catch {
      // 引擎没起来：一律显示未登录
    }
    return SOURCES.map((def): SourceState => {
      const mine = credsFor(creds, def)
      const active = mine.filter((c) => !c.disabled)
      const first = mine[0]
      return {
        id: def.id,
        label: def.label,
        plugin: Boolean(def.plugin),
        login: def.login,
        riskAck: Boolean(def.riskAck),
        pricing: def.pricing,
        ...(def.subscribeUrl ? { subscribeUrl: def.subscribeUrl } : {}),
        loggedIn: mine.length > 0,
        active: active.length > 0,
        shown: !hidden.has(def.id),
        ...(first ? { account: accountOf(first) } : {}),
        ...(first?.status_message ? { detail: String(first.status_message) } : {}),
        ...(active.length && active.every(paymentRequired) ? { detail: L('引擎收到 403 payment_required：当前账号没有可用额度', 'Engine got 403 payment_required: this account has no usable quota') } : {}),
        models: models.get(def.id) ?? 0,
      }
    })
  }

  /** 显示 / 隐藏：只改 dsh 里的模型清单，引擎里的凭据与设置不动 */
  async setShown(id: string, shown: boolean): Promise<{ shown: boolean }> {
    const def = mustSource(id)
    await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      const set = new Set(all.config.hiddenSources ?? [])
      if (shown) set.delete(def.id)
      else set.add(def.id)
      all.config.hiddenSources = [...set]
      await saveAll(this.ctx, all)
    })
    await this.resync()
    return { shown }
  }

  /**
   * 命令行备用登录（平时在原版管理界面里登录）：已登录就直接返回；没登录就开始登录，返回登录会话。
   * acceptRisk：claude 首次登录要确认风险。
   */
  async login(id: string, opts: { acceptRisk?: boolean } = {}): Promise<{ loggedIn: boolean; login?: LoginSession; riskNotice?: string }> {
    const def = mustSource(id)
    const state = (await this.sourcesRaw()).find((s) => s.id === def.id)!
    if (state.loggedIn) return { loggedIn: true }
    if (def.riskAck && !opts.acceptRisk) return { loggedIn: false, riskNotice: upstreamRiskNotice(getUpstream(def.id)) }
    return { loggedIn: false, login: await this.startLogin(def) }
  }

  /** 退出登录：删掉引擎里这个来源的凭据 */
  async logout(id: string): Promise<void> {
    const def = mustSource(id)
    const m = await this.mgmt()
    for (const c of credsFor(await m.credentials(), def)) await m.deleteCredential(c.name)
    await this.resync()
  }

  // —— 每日签到（daemon/checkin.ts）——

  /** 已登录的、支持签到的渠道 */
  private async checkinTargets(): Promise<string[]> {
    const states = await this.sourcesRaw().catch(() => [] as SourceState[])
    return CHECKIN_SOURCES.filter((id) => states.some((s) => s.id === id && s.loggedIn))
  }

  async checkinStatus(): Promise<{ auto: boolean; sources: CheckinStatus[] }> {
    const all = await loadAll(this.ctx)
    const ledger = await loadLedger(this.ctx.paths.home)
    const out: CheckinStatus[] = []
    let m: Mgmt | null = null
    try {
      m = await this.mgmt()
    } catch {
      // 引擎没起来：只看本地记录
    }
    for (const id of await this.checkinTargets()) {
      let api: Pick<CheckinStatus, 'checkedToday' | 'streakDays'> = { checkedToday: null }
      let error: string | undefined
      try {
        if (m && id === 'workbuddy') api = parseWorkbuddyAccounts(await m.plugin('GET', id, 'accounts'))
        if (m && id === 'trae') api = parseTraeCredits(await m.plugin('GET', id, 'credits'))
      } catch (e) {
        error = String((e as Error).message ?? e).slice(0, 160)
      }
      out.push({ ...mergeStatus(id, api, ledger), ...(error ? { error } : {}) })
    }
    return { auto: all.config.autoCheckin !== false, sources: out }
  }

  /** 签到一个渠道（全部账号）；成功记进本地记录 */
  async checkin(id: string): Promise<{ source: string; ok: true; reward?: string }> {
    if (!(CHECKIN_SOURCES as readonly string[]).includes(id)) throw new DshModelError('no_checkin', L(`${id} 不支持签到`, `${id} has no check-in`))
    const r = await (await this.mgmt()).plugin('POST', id, 'checkin', {})
    const reward = describeReward(r)
    await recordCheckin(this.ctx.paths.home, id, reward, this.ctx.owner)
    log(`daemon: checked in ${id}${reward ? ` (${reward})` : ''}`)
    void this.refreshUsage()
    return { source: id, ok: true, ...(reward ? { reward } : {}) }
  }

  async setAutoCheckin(on: boolean): Promise<{ auto: boolean }> {
    await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      all.config.autoCheckin = on
      await saveAll(this.ctx, all)
    })
    if (on) void this.autoCheckin()
    return { auto: on }
  }

  private autoRunning = false
  /** 自动签到：已登录、今天还没签过的渠道（以本地记录为准，接口说签过也跳过） */
  async autoCheckin(): Promise<void> {
    if (this.autoRunning) return
    this.autoRunning = true
    try {
      const all = await loadAll(this.ctx)
      if (all.config.autoCheckin === false) return
      const status = await this.checkinStatus()
      for (const s of status.sources) {
        if (s.checkedToday === true) continue
        try {
          await this.checkin(s.source)
        } catch (e) {
          log(`daemon: auto check-in ${s.source} failed: ${String((e as Error).message ?? e)}`)
        }
      }
    } catch {
      // 下个小时再试
    } finally {
      this.autoRunning = false
    }
  }

  // —— 订阅用量 ——

  /** 刷新所有已登录来源的用量（单飞：并发调用共用一次） */
  refreshUsage(): Promise<void> {
    this.usageInflight ??= this.doRefreshUsage().finally(() => (this.usageInflight = undefined))
    return this.usageInflight
  }

  private async doRefreshUsage(): Promise<void> {
    // 影响 dsh 模型清单的两件事：有没有可用额度、实测调通的是哪个模型（默认显示的就是它）
    const sig = () => [...this.usageCache.values()].map((u) => `${u.source}:${u.noAccess ? 0 : 1}:${u.probedModel ?? ''}`).sort().join(',')
    const before = sig()
    await this.doRefreshUsageInner()
    await writeJson(usageFilePath(this.ctx.paths.home), [...this.usageCache.values()], { owner: this.ctx.owner }).catch(() => {})
    const after = sig()
    // 变了：重新同步，dsh 里相应地隐藏 / 恢复 / 默认显示它的模型
    if (before !== after) void this.resync()
  }

  private async doRefreshUsageInner(): Promise<void> {
    const states = await this.sourcesRaw().catch(() => [] as SourceState[])
    let creds: CredentialEntry[] = []
    try {
      creds = await (await this.mgmt()).credentials()
    } catch {
      // 引擎没起来
    }
    await Promise.all(
      states.map(async (s) => {
        const def = findSource(s.id)!
        if (!s.loggedIn) {
          this.usageCache.delete(s.id)
          return
        }
        if (USAGE_UNSUPPORTED.has(s.id)) {
          await this.probe(s, def, creds)
          return
        }
        const fetchedAt = new Date().toISOString()
        try {
          const cred = credsFor(creds, def)[0]
          if (!cred) return
          const u = await fetchEngineUsage(this.ctx, def, cred)
          this.usageCache.set(s.id, { source: s.id, fetchedAt, ...u })
        } catch (error) {
          const prev = this.usageCache.get(s.id)
          // 失败保留上次的读数，标上错误
          this.usageCache.set(s.id, { ...(prev ?? { windows: [] }), source: s.id, fetchedAt: prev?.fetchedAt ?? fetchedAt, error: String((error as Error).message ?? error).slice(0, 200) })
        }
      }),
    )
  }

  /** 查不了用量的来源：实测一次能不能调（每 6 小时；登录后立即） */
  private async probe(s: SourceState, def: SourceDef, creds: CredentialEntry[]): Promise<void> {
    const prev = this.usageCache.get(s.id)
    if (!s.active) return
    if (prev && Date.now() - Date.parse(prev.fetchedAt) < PROBE_MS) return
    const fetchedAt = new Date().toISOString()
    try {
      const cred = credsFor(creds, def).find((c) => !c.disabled)
      if (!cred) return
      // 引擎已经因 403 payment_required 冷却了它：不用再发请求（冷却期内引擎只回 503 auth_unavailable）
      if (paymentRequired(cred)) {
        this.usageCache.set(s.id, { source: s.id, windows: [], fetchedAt, unsupported: true, noAccess: true, plan: 'none', error: 'payment_required' })
        log(`daemon: probe ${def.id} → denied (engine cooldown: payment_required)`)
        return
      }
      // 挑一个对话模型实测（跳过画图、向量这类）
      const model = def.probeModel ?? (await (await this.mgmt()).credentialModels(cred.name)).map((m) => m.id).find(isChatModel)
      if (!model) return
      const all = await loadAll(this.ctx)
      const r = await probeEngineSource(all.config.port, dshKey(all.keys), model)
      this.usageCache.set(s.id, { source: s.id, windows: [], fetchedAt, unsupported: true, ...(r.ok ? { probedModel: model } : { noAccess: true, plan: 'none', error: r.reason }) })
      log(`daemon: probe ${def.id} (${model}) → ${r.ok ? 'ok' : `denied: ${r.reason}`}`)
    } catch (error) {
      // 网络 / 限流：不下结论，下一轮再试
      if (prev) this.usageCache.set(s.id, { ...prev, fetchedAt: new Date(Date.now() - PROBE_MS + 10 * 60 * 1000).toISOString() })
      log(`daemon: probe ${def.id} inconclusive: ${String((error as Error).message ?? error)}`)
    }
  }

  /** 让某个来源下一轮重新实测 */
  private forgetProbe(id: string): void {
    if (USAGE_UNSUPPORTED.has(id)) this.usageCache.delete(id)
  }

  async usage(refresh = false): Promise<SourceUsage[]> {
    if (refresh) await this.refreshUsage()
    return [...this.usageCache.values()]
  }

  // —— 登录会话 ——

  session(id: string): LoginSession | undefined {
    const s = this.sessions.get(id)
    return s ? publicSession(s) : undefined
  }

  private async startLogin(def: SourceDef): Promise<LoginSession> {
    // 同一来源只留一个进行中的会话
    for (const s of this.sessions.values()) if (s.source === def.id && s.status === 'pending') this.cancelSession(s.id)
    return this.startEngineLogin(def)
  }

  /** 用引擎自带的 device code 登录（如 -codex-device-login）：打印网址和码，引擎自己轮询并写凭据 */
  private async startCliDeviceLogin(def: SourceDef): Promise<LoginSession> {
    const m = await this.mgmt()
    const before = credsFor(await m.credentials(), def).map((c) => c.name)
    const abort = new AbortController()
    const child = spawn(currentBinary(this.ctx), ['-config', this.ctx.paths.engineYaml, def.deviceCliFlag!, '-no-browser'], { cwd: this.ctx.paths.home, stdio: ['ignore', 'pipe', 'pipe'], signal: abort.signal, windowsHide: true })
    let out = ''
    const s: SessionInternal = {
      id: randomBytes(12).toString('hex'),
      source: def.id,
      kind: 'device',
      status: 'pending',
      expiresAt: new Date(Date.now() + LOGIN_TIMEOUT_MS).toISOString(),
      needsPaste: false,
      startedAt: new Date().toISOString(),
      provider: def.engineProvider,
      before,
      abort,
    }
    const ready = new Promise<void>((resolve, reject) => {
      const onData = (b: Buffer) => {
        out = (out + b.toString()).slice(-4000)
        const url = /device URL:\s*(\S+)/i.exec(out)?.[1]
        const code = /device code:\s*(\S+)/i.exec(out)?.[1]
        if (url && code) {
          s.url = url
          s.userCode = code
          resolve()
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (e) => reject(e))
      child.on('exit', () => reject(new Error(out.trim().split('\n').slice(-3).join(' ') || 'login process exited')))
      setTimeout(() => reject(new Error(L('30 秒内没拿到登录码', 'No device code within 30s'))), 30_000)
    })
    child.on('exit', (code) => {
      if (s.status !== 'pending') return
      if (code === 0) void this.finishEngineLogin(s, def)
      else {
        s.status = 'error'
        s.error = out.trim().split('\n').filter((l) => !/^CLIProxyAPI Version/.test(l)).slice(-2).join(' ') || `exit ${code}`
      }
    })
    try {
      await ready
    } catch (error) {
      abort.abort()
      throw new DshModelError('login_failed', L(`${def.label} 登录没能开始：${(error as Error).message}`, `Could not start ${def.label} sign-in: ${(error as Error).message}`))
    }
    this.sessions.set(s.id, s)
    return publicSession(s)
  }

  private async startEngineLogin(def: SourceDef): Promise<LoginSession> {
    if (def.deviceCliFlag) return this.startCliDeviceLogin(def)
    const m = await this.mgmt()
    const before = credsFor(await m.credentials(), def).map((c) => c.name)
    const r = await m.authUrl(def.engineProvider)
    const device = r.flow === 'device'
    const s: SessionInternal = {
      id: r.state,
      source: def.id,
      kind: device ? 'device' : def.login,
      status: 'pending',
      url: r.url,
      ...(r.user_code ? { userCode: r.user_code } : {}),
      expiresAt: new Date(Date.now() + (r.expires_in ? r.expires_in * 1000 : LOGIN_TIMEOUT_MS)).toISOString(),
      needsPaste: !device,
      startedAt: new Date().toISOString(),
      engineState: r.state,
      provider: def.engineProvider,
      before,
    }
    this.sessions.set(s.id, s)
    void this.pollEngineLogin(s, def)
    return publicSession(s)
  }

  private async pollEngineLogin(s: SessionInternal, def: SourceDef): Promise<void> {
    const deadline = Date.parse(s.expiresAt ?? '') || Date.now() + LOGIN_TIMEOUT_MS
    while (s.status === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
      if (s.status !== 'pending') return
      try {
        const st = await (await this.mgmt()).oauthStatus(s.engineState!)
        if (st.status === 'ok') {
          await this.finishEngineLogin(s, def)
          return
        }
        if (st.status === 'error' && st.error && !/unknown or expired state/i.test(st.error)) {
          s.status = 'error'
          s.error = st.error
          return
        }
      } catch {
        // 引擎抖动：继续等
      }
    }
    if (s.status === 'pending') {
      s.status = 'error'
      s.error = L('等待授权超时', 'Timed out waiting for authorization')
    }
  }

  /** 登录成功：只留新账号（单账号原则），收紧权限，确保启用，同步 */
  private async finishEngineLogin(s: SessionInternal, def: SourceDef): Promise<void> {
    try {
      const m = await this.mgmt()
      const now = credsFor(await m.credentials(), def)
      const fresh = now.filter((c) => !(s.before ?? []).includes(c.name))
      if (fresh.length) for (const c of now) if (!fresh.includes(c)) await m.deleteCredential(c.name)
      for (const c of fresh.length ? fresh : now) if (c.disabled) await m.setDisabled(c.name, false)
      await tightenAuthPerms(this.ctx)
      s.status = 'ok'
      log(`daemon: ${def.label} signed in`)
      this.forgetProbe(def.id)
      await this.resync()
      void this.refreshUsage()
    } catch (error) {
      s.status = 'error'
      s.error = String((error as Error).message ?? error)
    }
  }

  /** 回调式登录：用户贴回浏览器跳转到的地址 */
  async submitPaste(sessionId: string, redirectUrl: string): Promise<LoginSession> {
    const s = this.sessions.get(sessionId)
    if (!s || !s.provider) throw new DshModelError('no_session', L('登录会话不存在或已结束', 'Login session not found or finished'))
    const r = await (await this.mgmt()).oauthCallback(s.provider, redirectUrl.trim())
    if (r.status !== 'ok') throw new DshModelError('callback_rejected', r.error ?? 'callback rejected')
    return publicSession(s)
  }

  cancelSession(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s || s.status !== 'pending') return false
    s.status = 'cancelled'
    s.abort?.abort()
    if (s.engineState) void this.mgmt().then((m) => m.cancel(s.engineState!)).catch(() => {})
    return true
  }

  // —— key ——

  async keysInfo(): Promise<{ keys: Awaited<ReturnType<Daemon['keys']>>; foreign: number }> {
    return { keys: await this.keys(), foreign: await this.foreignKeyCount() }
  }

  async keys(): Promise<{ name: string; key: string; createdAt: string; stats?: StatsSnapshot['byKey'][string] }[]> {
    const store = await loadKeys(this.ctx)
    const snap = this.stats.snapshot()
    return store.keys
      .filter((k) => !k.revokedAt)
      .map((k) => ({ name: k.name, key: redactKey(k.key), createdAt: k.createdAt, ...(snap.byKey[k.name] ? { stats: snap.byKey[k.name] } : {}) }))
  }

  // —— 更新 / 卸载（管理页的按钮）——

  private selfJob?: { action: 'update' | 'uninstall'; startedAt: string; log: string; pid?: number }

  /** 版本与能不能在页面上自管理（VPS 上要 root，只给命令） */
  async selfInfo(): Promise<{ version: string; latest: string | null; canManage: boolean; job?: { action: string; startedAt: string; log: string }; commands: { update: string; uninstall: string } }> {
    const vps = this.ctx.mode === 'vps'
    let log = ''
    if (this.selfJob) log = await readFile(this.selfJob.log, 'utf8').catch(() => '')
    return {
      version: pkgVersion(),
      latest: await latestVersion((await loadAll(this.ctx)).config.proxy),
      canManage: !vps || (await adminInstalled()),
      ...(this.selfJob ? { job: { action: this.selfJob.action, startedAt: this.selfJob.startedAt, log: log.replace(/\x1b\[[0-9;]*m/g, '').slice(-6000) } } : {}),
      commands: vps
        ? { update: 'sudo npm install -g dsh-cpamc@latest && sudo dsh-cpamc setup', uninstall: 'sudo dsh-cpamc uninstall' }
        : { update: 'dsh-cpamc update', uninstall: 'dsh-cpamc uninstall' },
    }
  }

  /**
   * 在独立进程里跑 update / uninstall：两者都会重启或移除守护进程本身，所以不能在守护进程里做。
   * 用 detached 让它脱离守护进程的进程组（launchd 重启服务时不会被一起杀掉）。
   */
  async startSelfJob(action: 'update' | 'uninstall', opts: { keepAuth?: boolean } = {}): Promise<{ started: boolean; log: string }> {
    // 同一时间只跑一个（实测：连点两次会起两个更新、日志互相覆盖）
    if (this.selfJob && Date.now() - Date.parse(this.selfJob.startedAt) < 10 * 60 * 1000) {
      if (this.selfJob.pid && !alive(this.selfJob.pid)) this.selfJob = undefined
      else return { started: false, log: this.selfJob.log }
    }
    const log = selfJobLog(this.ctx, action)
    if (this.ctx.mode === 'vps') {
      // 守护进程是 dsh 用户：写请求单，由 dsh-cpamc-admin（root）执行
      if (!(await adminInstalled())) throw new DshModelError('needs_root', L('服务器上要 root 权限，请在终端里执行命令（重跑一次 sudo dsh-cpamc setup 之后就能在页面上点）', 'On the server this needs root; run the command in a terminal (after re-running sudo dsh-cpamc setup, the buttons work here)'))
      const req: AdminRequest = { action, keepAuth: opts.keepAuth === true, lang: lang() }
      await atomicWrite(adminRequestPath(this.ctx), JSON.stringify(req), { mode: 0o600 })
      this.selfJob = { action, startedAt: new Date().toISOString(), log }
      log_(`daemon: requested ${action} from dsh-cpamc-admin`)
      return { started: true, log }
    }
    const args = action === 'update' ? ['update'] : ['uninstall', '--yes', '--remove-plugin', ...(opts.keepAuth ? ['--keep-auth'] : [])]
    const cmd = [process.execPath, join(PKG_ROOT, 'bin', 'dsh-cpamc.js'), ...args, '--lang', lang()]
    const env = { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    let pid: number | undefined
    if (this.ctx.platform === 'linux' && (await which('systemd-run'))) {
      // Linux 的 systemd --user 重启服务会杀掉整个 cgroup：交给 systemd-run 另起一个
      const keepEnv = ['PATH', 'HOME', 'LANG', 'DSH_HOME', 'DSH_CPAMC_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter((k) => process.env[k]).map((k) => `--setenv=${k}=${process.env[k]}`)
      const viaSystemd = ['--user', '--collect', '--quiet', ...keepEnv, '--setenv=NO_COLOR=1', '/bin/sh', '-c', 'log="$1"; shift; exec "$@" >"$log" 2>&1', 'sh', log, ...cmd]
      spawn('systemd-run', viaSystemd, { detached: true, stdio: 'ignore', env }).unref()
    } else {
      pid = spawnDetached(cmd[0]!, cmd.slice(1), { log, env })
    }
    this.selfJob = { action, startedAt: new Date().toISOString(), log, ...(pid ? { pid } : {}) }
    log_(`daemon: started ${action}${pid ? ` (pid ${pid})` : ''}`)
    return { started: true, log }
  }

  /** 这个来源的全部模型，以及哪些显示在 dsh 里；recommended = 全局默认里的那个（实测调通的免费模型） */
  async sourceModels(id: string): Promise<{ custom: boolean; models: { id: string; name: string; selected: boolean; recommended: boolean }[] }> {
    const def = mustSource(id)
    const all = await loadAll(this.ctx)
    const candidates = await dshCandidates(this.ctx, all)
    const list = candidates.get(def.id)?.models ?? []
    const rec = (await defaultSelection(this.ctx, candidates)).get(def.id) ?? []
    const chosen = all.config.dshModels?.[def.id]
    const picked = new Set(pickedFor(list.map((m) => m.id), chosen, rec))
    return { custom: chosen !== undefined, models: list.map((m) => ({ id: m.id, name: m.name, selected: picked.has(m.id), recommended: rec.includes(m.id) })) }
  }

  /** 保存勾选；null = 恢复默认挑选 */
  async setSourceModels(id: string, models: string[] | null): Promise<{ selected: number }> {
    const def = mustSource(id)
    if (models !== null && !(Array.isArray(models) && models.every((m) => typeof m === 'string' && m.length < 200))) {
      throw new DshModelError('bad_models', L('models 应是模型 id 列表', 'models must be a list of model ids'))
    }
    await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      const next = { ...all.config.dshModels }
      if (models === null) delete next[def.id]
      else next[def.id] = [...new Set(models)]
      all.config.dshModels = Object.keys(next).length ? next : undefined
      await saveAll(this.ctx, all)
    })
    await this.resync()
    return { selected: models === null ? -1 : new Set(models).size }
  }

  /** 管理页"复制"用：取一把未吊销 key 的完整值（只经同源、带页面 token 的插件路由转发） */
  async revealKey(name: string): Promise<{ name: string; key: string }> {
    const entry = (await loadKeys(this.ctx)).keys.find((k) => k.name === name && !k.revokedAt)
    if (!entry) throw new DshModelError('no_key', L(`没有这把 key：${name}`, `No such key: ${name}`))
    return { name: entry.name, key: entry.key }
  }

  /** 访问地址：本机地址总有；vps 开了对外端点时还有公网地址 */
  async endpoints(): Promise<{ local: string; public?: string }> {
    const all = await loadAll(this.ctx)
    const pub = all.state.remote?.mode === 'caddy' ? all.state.remote.publicUrl : undefined
    return { local: `http://127.0.0.1:${all.config.port}/v1`, ...(pub ? { public: pub } : {}) }
  }

  /** 新增：返回完整 key（只这一次） */
  async addKey(name: string): Promise<{ name: string; key: string }> {
    return withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      const entry = addKey(all.keys, name)
      await saveKeys(this.ctx, all.keys)
      await applyEngineConfig(this.ctx, all)
      await this.reloadKeyNames()
      return { name: entry.name, key: entry.key }
    })
  }

  async revokeKey(name: string): Promise<void> {
    if (name === DSH_KEY_NAME) throw new DshModelError('cannot_revoke_dsh', L('dsh 用的 key 不能吊销，只能轮换', 'The dsh key cannot be revoked, only rotated'))
    await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      revokeKey(all.keys, name)
      await saveKeys(this.ctx, all.keys)
      await applyEngineConfig(this.ctx, all)
    })
    await this.reloadKeyNames()
  }

  async rotateKey(name: string): Promise<{ name: string; key?: string }> {
    const entry = await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      const e = rotateKey(all.keys, name)
      await saveKeys(this.ctx, all.keys)
      await applyEngineConfig(this.ctx, all)
      return e
    })
    await this.reloadKeyNames()
    if (name === DSH_KEY_NAME) {
      await this.resync() // 新 key 写进 dsh 凭据
      return { name }
    }
    return { name, key: entry.key }
  }

  // —— 服务与「全部功能」——

  /** 服务区块：引擎、渠道插件、管理界面、守护进程的状态（R2 ③） */
  async serviceInfo(): Promise<{
    mode: 'local' | 'vps'
    engine: { running: boolean; port: number; version: string | null; service: ServiceStatus | null }
    components: { plugins: string | null; panel: string | null }
    daemon: { port: number | null }
    remote: { publicUrl?: string; host?: string }
    canRestart: boolean
  }> {
    const all = await loadAll(this.ctx)
    const svc = this.ctx.serviceDisabled ? null : await serviceFor(this.ctx).status().catch(() => null)
    const bridge = await loadBridgeConfig(this.ctx.paths.home)
    const pub = all.state.remote?.mode === 'caddy' ? all.state.remote.publicUrl : undefined
    return {
      mode: this.ctx.mode,
      engine: { running: await healthy(all.config.port), port: all.config.port, version: await currentVersion(this.ctx), service: svc },
      components: { plugins: all.state.components?.plugins ?? null, panel: all.state.components?.panel ?? null },
      daemon: { port: bridge?.port ?? null },
      remote: { ...(pub ? { publicUrl: pub } : {}), ...(all.config.remote.domain ? { host: all.config.remote.domain } : {}) },
      // VPS 上引擎是系统服务，守护进程以 dsh 用户运行，没有权限重启它
      canRestart: this.ctx.mode !== 'vps' && !this.ctx.serviceDisabled,
    }
  }

  async restartEngine(): Promise<{ running: boolean }> {
    if (this.ctx.mode === 'vps') throw new DshModelError('needs_root', L('服务器上重启引擎要 root：在终端执行 sudo dsh-cpamc service restart', 'Restarting the engine on a server needs root: run sudo dsh-cpamc service restart'))
    const all = await loadAll(this.ctx)
    await serviceFor(this.ctx).restart()
    const running = await waitHealthy(all.config.port, 15_000)
    if (running) void this.resync()
    return { running }
  }

  /**
   * 「全部功能」：确保引擎在跑，返回本机地址（设计 §5.4、§7）。
   * 远程浏览器用不了 127.0.0.1：页面会改用 dsh 自己网页服务下的 /dsh-cpamc/panel/（插件宿主端提供，先过 dsh 登录）。
   */
  async panelOpen(): Promise<{ url: string; apiBase: string; running: boolean }> {
    const all = await loadAll(this.ctx)
    let running = await healthy(all.config.port)
    if (!running && this.ctx.mode !== 'vps' && !this.ctx.serviceDisabled) {
      await serviceFor(this.ctx).start().catch(() => {})
      running = await waitHealthy(all.config.port, 15_000)
    }
    const local = `http://127.0.0.1:${all.config.port}`
    return { url: `${local}/management.html`, apiBase: local, running }
  }

  /** 原版管理界面的登录密钥（只经同源、带页面 token、过了 dsh 登录的插件路由；设计 §7.3） */
  async panelKey(): Promise<{ key: string }> {
    const m = await loadMgmt(this.ctx)
    if (!m?.secret) throw new DshModelError('mgmt_not_configured', L('管理密钥还没生成（dsh-cpamc setup）', 'Management key not generated yet (dsh-cpamc setup)'))
    return { key: m.secret }
  }

  /** 引擎里不是 keys.json 发的 key（在完整管理界面里加的）的个数 */
  private async foreignKeyCount(): Promise<number> {
    try {
      const text = await readFile(this.ctx.paths.engineYaml, 'utf8')
      const store = await loadKeys(this.ctx)
      const ours = new Set(store.keys.map((k) => k.key))
      return engineApiKeys(YAML.parseDocument(text)).filter((k) => !ours.has(k)).length
    } catch {
      return 0
    }
  }

  // —— /control/* 路由 ——

  async handle(method: string, path: string, body: unknown, query: URLSearchParams): Promise<{ status: number; body: unknown }> {
    const b = (body ?? {}) as Record<string, unknown>
    const seg = path.split('/').filter(Boolean)
    try {
      if (method === 'GET' && path === '/status') {
        return ok({ sources: await this.sources(), keys: await this.keys(), stats: this.statsSnapshot(), endpoints: await this.endpoints() })
      }
      if (method === 'GET' && path === '/sources') {
        if (query.get('refresh') === '1') {
          await this.watchCredentials()
          await this.refreshUsage()
        }
        return ok(await this.sources())
      }
      if (seg[0] === 'sources' && seg[1] && method === 'POST') {
        if (seg[2] === 'show') return ok(await this.setShown(seg[1], true))
        if (seg[2] === 'hide') return ok(await this.setShown(seg[1], false))
        if (seg[2] === 'login') return ok(await this.login(seg[1], { acceptRisk: b.acceptRisk === true }))
        if (seg[2] === 'logout') return ok(await this.logout(seg[1]).then(() => ({ loggedIn: false })))
      }
      if (seg[0] === 'sources' && seg[1] && seg[2] === 'models') {
        if (method === 'GET') return ok(await this.sourceModels(seg[1]))
        if (method === 'POST') return ok(await this.setSourceModels(seg[1], b.models === null ? null : (b.models as string[])))
      }
      if (seg[0] === 'login' && seg[1]) {
        if (method === 'GET') {
          const s = this.session(seg[1])
          return s ? ok(s) : fail(404, 'no_session', L('登录会话不存在', 'Login session not found'))
        }
        if (method === 'POST' && seg[2] === 'callback') return ok(await this.submitPaste(seg[1], String(b.redirectUrl ?? '')))
        if (method === 'DELETE') return ok({ cancelled: this.cancelSession(seg[1]) })
      }
      if (method === 'GET' && path === '/keys') return ok(await this.keys())
      if (method === 'POST' && path === '/keys') return ok(await this.addKey(String(b.name ?? '')))
      if (seg[0] === 'keys' && seg[1]) {
        if (method === 'DELETE') return ok(await this.revokeKey(seg[1]).then(() => ({ revoked: true })))
        if (method === 'POST' && seg[2] === 'rotate') return ok(await this.rotateKey(seg[1]))
        if (method === 'POST' && seg[2] === 'reveal') return ok(await this.revealKey(seg[1]))
      }
      if (method === 'GET' && path === '/stats') return ok(this.statsSnapshot())
      if (method === 'GET' && path === '/keys-info') return ok(await this.keysInfo())
      if (method === 'GET' && path === '/checkin') return ok(await this.checkinStatus())
      if (method === 'POST' && path === '/checkin/auto') return ok(await this.setAutoCheckin(b.on !== false))
      if (method === 'POST' && seg[0] === 'checkin' && seg[1] && seg[1] !== 'auto') return ok(await this.checkin(seg[1]))
      if (method === 'GET' && path === '/service') return ok(await this.serviceInfo())
      if (method === 'POST' && path === '/service/restart') return ok(await this.restartEngine())
      if (method === 'POST' && path === '/panel/open') return ok(await this.panelOpen())
      if (method === 'POST' && path === '/panel/key') return ok(await this.panelKey())
      if (method === 'GET' && path === '/endpoints') return ok(await this.endpoints())
      if (method === 'GET' && path === '/self') return ok(await this.selfInfo())
      if (method === 'POST' && path === '/self/update') return ok(await this.startSelfJob('update'))
      if (method === 'POST' && path === '/self/uninstall') return ok(await this.startSelfJob('uninstall', { keepAuth: b.keepAuth === true }))
      if (method === 'GET' && path === '/usage') return ok(await this.usage(query.get('refresh') === '1'))
      return fail(404, 'not_found', `${method} ${path}`)
    } catch (error) {
      if (isDshModelError(error)) return fail(400, error.code, error.message, error.hint)
      return fail(500, 'internal', String((error as Error).message ?? error))
    }
  }
}

function ok(body: unknown): { status: number; body: unknown } {
  return { status: 200, body }
}

function fail(status: number, code: string, message: string, hint?: string): { status: number; body: unknown } {
  return { status, body: { error: { code, message, ...(hint ? { hint } : {}) } } }
}

function mustSource(id: string): SourceDef {
  const def = findSource(id)
  if (!def) throw new DshModelError('unknown_source', L(`不认识的来源：${id}`, `Unknown source: ${id}`), SOURCES.map((s) => s.id).join(', '))
  return def
}

function accountOf(c: CredentialEntry): string {
  return String(c.email ?? c.account ?? c.label ?? c.name)
}

function publicSession(s: SessionInternal): LoginSession {
  const { engineState: _e, provider: _p, before: _b, abort: _a, ...pub } = s
  return pub
}
