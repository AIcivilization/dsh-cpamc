// ops.ts — 各命令共用的流程：读全部状态、应用引擎配置、同步模型到 dsh

import type { Ctx } from './context.js'
import { connectDshGroups, type DshGroup } from './dsh/connect.js'
import { listModels, waitModelsChange } from './engine/client.js'
import { offeredModels, subscriptionMap } from './engine/sourcemap.js'
import { computeAliases, type AliasEntry } from './engine/alias.js'
import { globalDefault, pickedFor } from './dsh/pick.js'
import { usageFilePath, type SourceUsage } from './daemon/usage.js'
import { SOURCES } from './sources.js'
import { readJson } from './util/fs.js'
import { writeEngineConfig } from './engine/config.js'
import { DshModelError, isDshModelError } from './errors.js'
import { L } from './i18n.js'
import { DSH_KEY_NAME, findActive, loadKeys, saveKeys, type KeyStore } from './keys.js'
import { loadConfig, loadState, saveConfig, saveState, type Config, type State } from './state.js'
import { ok, skip, warn } from './util/output.js'

export interface All {
  config: Config
  state: State
  keys: KeyStore
}

export async function loadAll(ctx: Ctx): Promise<All> {
  const [config, state, keys] = await Promise.all([loadConfig(ctx), loadState(ctx), loadKeys(ctx)])
  return { config, state, keys }
}

export async function saveAll(ctx: Ctx, all: All): Promise<void> {
  await saveConfig(ctx, all.config)
  await saveState(ctx, all.state)
}

export function dshKey(keys: KeyStore): string {
  const k = findActive(keys, DSH_KEY_NAME)
  if (!k) throw new DshModelError('not_setup', L('还没有初始化', 'Not set up yet'), L('先执行 dsh-cpamc setup', 'Run dsh-cpamc setup first'))
  return k.key
}

/** 写 engine.yaml（只动自己的键，内容变了才写，引擎热重载）。在完整管理界面里删掉的 key 同步成吊销。返回是否写了 */
export async function applyEngineConfig(ctx: Ctx, all: All, opts: { aliases?: AliasEntry[] } = {}): Promise<boolean> {
  const r = await writeEngineConfig(ctx, all.config, all.keys, all.state, opts)
  if (r.revoked.length) {
    await saveKeys(ctx, all.keys)
    warn(L(`这些 key 在完整管理界面里被删除了，已标记为吊销：${r.revoked.join('、')}`, `These keys were deleted in the full management interface and are now revoked: ${r.revoked.join(', ')}`))
  }
  await saveState(ctx, all.state)
  return r.written
}

/**
 * 把引擎当前的模型列表写进 dsh。dsh 没装 / 没接过线时只提示，不算失败。
 * before：login/logout 前的模型 id，用来等引擎热重载完成。
 */
export async function syncModels(ctx: Ctx, all: All, opts: { before?: string[]; profile?: string | null; force?: boolean; quiet?: boolean } = {}): Promise<string[]> {
  const key = dshKey(all.keys)
  const models = opts.before ? await waitModelsChange(all.config.port, key, opts.before) : await listModels(all.config.port, key)
  const ids = models.map((m) => m.id)
  const candidates = await dshCandidates(ctx, all, ids)
  // 每个来源只把挑中的模型写进 dsh（面板勾选，或全局默认）；引擎照常提供全部
  const defaults = await defaultSelection(ctx, candidates)
  const groups: DshGroup[] = []
  for (const c of candidates.values()) {
    const picked = new Set(pickedFor(c.models.map((m) => m.id), all.config.dshModels?.[c.source], defaults.get(c.source)))
    const models = c.models.filter((m) => picked.has(m.id)).map(({ rate: _r, ...m }) => m)
    if (models.length) groups.push({ providerId: c.providerId, displayName: c.label, models })
  }
  try {
    const r = await connectDshGroups(ctx, all.state, all.keys, {
      port: all.config.port,
      key,
      groups,
      profile: opts.profile ?? all.config.dsh.profile,
      force: opts.force,
    })
    all.config.dsh.profile = r.location.profile
    r.warnings.forEach((w) => warn(w))
    if (!opts.quiet) {
      if (r.providers.length) {
        const summary = groups.map((g) => `${g.displayName} ${g.models.length}`).join(' · ')
        const shown = groups.reduce((n, g) => n + g.models.length, 0)
        const usable = [...candidates.values()].reduce((n, c) => n + c.models.length, 0)
        ;(r.changed ? ok : skip)(L(`dsh（${r.location.profile}）显示 ${shown} 个模型（共 ${usable} 个可用）：${summary}`, `dsh (${r.location.profile}) shows ${shown} of ${usable} models: ${summary}`))
      } else {
        skip(L('还没有登录任何上游，dsh 里暂时没有 dsh-cpamc 的模型', 'No upstream logged in yet, so dsh has no dsh-cpamc models for now'))
      }
    }
  } catch (error) {
    if (isDshModelError(error) && error.code === 'dsh_not_found') {
      warn(`${error.message}${error.hint ? ` — ${error.hint}` : ''}`)
    } else {
      throw error
    }
  }
  await saveAll(ctx, all)
  return ids
}

/** 全局默认显示的模型：免费来源里实测调通的那个，最多 2 个（设计 §4.2） */
export async function defaultSelection(ctx: Ctx, candidates: Map<string, DshCandidate>): Promise<Map<string, string[]>> {
  const usage = (await readJson<SourceUsage[]>(usageFilePath(ctx.paths.home)).catch(() => null)) ?? []
  const probed = new Map(usage.filter((u) => u.probedModel && !u.noAccess).map((u) => [u.source, u.probedModel!]))
  return globalDefault(
    SOURCES.map((def) => ({ source: def.id, tier: def.pricing.tier, models: (candidates.get(def.id)?.models ?? []).map((m) => m.id), ...(probed.has(def.id) ? { probedModel: probed.get(def.id)! } : {}) })),
  )
}

export interface DshCandidate {
  /** 来源 id（workbuddy / trae / qoder / zcode / claude / codex） */
  source: string
  providerId: string
  label: string
  models: (DshGroup['models'][number] & { rate?: number })[]
}

/**
 * 每个来源可以放进 dsh 的全部模型（勾选列表也用它）。
 * 隐藏的来源、已登录但没有可用额度的来源不算；归不到六个来源的模型（在完整管理界面里另加的）暂不放进 dsh。
 */
export async function dshCandidates(ctx: Ctx, all: All, ids?: string[]): Promise<Map<string, DshCandidate>> {
  const list = ids ?? (await listModels(all.config.port, dshKey(all.keys))).map((m) => m.id)
  const subs = await subscriptionMap(ctx, all.config.port)
  const hidden = new Set(all.config.hiddenSources ?? [])
  const out = new Map<string, DshCandidate>()
  for (const id of list) {
    const s = subs.models.get(id)
    if (!s || subs.noAccess.has(s.source) || hidden.has(s.source)) continue
    let g = out.get(s.source)
    if (!g) out.set(s.source, (g = { source: s.source, providerId: `dsh-cpamc-${s.source}`, label: s.label, models: [] }))
    g.models.push({ id, name: s.displayName ?? id })
  }
  return out
}

/**
 * 全量同步：算同名模型别名 → 写 engine.yaml（引擎热重载）→ 等模型列表跟上 → 把模型清单写进 dsh。
 * setup、key 变化、来源显示 / 隐藏、凭据变化时都走这里。引擎没在跑时只写配置，别名不动。
 */
export async function syncAll(ctx: Ctx, all: All, opts: { quiet?: boolean } = {}): Promise<string[]> {
  const offered = await offeredModels(ctx, all.config.port)
  const aliases = offered ? computeAliases(offered, all.state.engineOwned?.aliases ?? []) : undefined
  const changedAliases = aliases !== undefined && JSON.stringify(aliases) !== JSON.stringify(all.state.engineOwned?.aliases ?? [])
  const before = changedAliases ? await listModels(all.config.port, dshKey(all.keys)).then((m) => m.map((x) => x.id)).catch(() => undefined) : undefined
  await applyEngineConfig(ctx, all, aliases ? { aliases } : {})
  return syncModels(ctx, all, { quiet: opts.quiet, ...(before ? { before } : {}) })
}
