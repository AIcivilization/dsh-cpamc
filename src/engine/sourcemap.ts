// engine/sourcemap.ts — 引擎里的模型属于哪个来源
//
// /v1/models 不说明模型来自哪个来源（owned_by 可能为空），只能靠管理接口
// GET /credentials/models?name= 逐个凭据取它能服务的模型，映射回来源（workbuddy / trae / … / claude / codex）。
// 同时给出"没有可用订阅"的来源：用量接口判定的 noAccess，或引擎记录的 payment_required 冷却。

import type { Ctx } from '../context.js'
import { usageFilePath, type SourceUsage } from '../daemon/usage.js'
import { SOURCES, credsFor, paymentRequired } from '../sources.js'
import { readJson } from '../util/fs.js'
import { Mgmt } from './mgmt.js'

export interface SubscriptionModel {
  source: string
  label: string
  displayName?: string
}

export interface SubscriptionMap {
  models: Map<string, SubscriptionModel>
  /** 已登录但没有可用订阅的来源 id */
  noAccess: Set<string>
}

export async function subscriptionMap(ctx: Ctx, port: number): Promise<SubscriptionMap> {
  const models = new Map<string, SubscriptionModel>()
  const noAccess = new Set<string>()
  const usage = (await readJson<SourceUsage[]>(usageFilePath(ctx.paths.home)).catch(() => null)) ?? []
  for (const u of usage) if (u.noAccess) noAccess.add(u.source)
  let mgmt: Mgmt
  try {
    mgmt = await Mgmt.forCtx(ctx, port)
  } catch {
    return { models, noAccess }
  }
  let creds: Awaited<ReturnType<Mgmt['credentials']>> = []
  try {
    creds = await mgmt.credentials()
  } catch {
    return { models, noAccess }
  }
  for (const def of SOURCES) {
    const mine = credsFor(creds, def).filter((c) => !c.disabled)
    if (mine.length && mine.every(paymentRequired)) noAccess.add(def.id)
    for (const c of mine) {
      try {
        for (const m of await mgmt.credentialModels(c.name)) {
          if (!models.has(m.id)) models.set(m.id, { source: def.id, label: def.label, ...(m.display_name ? { displayName: m.display_name } : {}) })
        }
      } catch {
        // 单个凭据取不到就跳过
      }
    }
  }
  return { models, noAccess }
}

/** 每个来源现在能服务的模型 id（只看没停用的凭据）；引擎没起来就返回 null */
export async function offeredModels(ctx: Ctx, port: number): Promise<Map<string, string[]> | null> {
  let mgmt: Mgmt
  let creds: Awaited<ReturnType<Mgmt['credentials']>>
  try {
    mgmt = await Mgmt.forCtx(ctx, port)
    creds = await mgmt.credentials()
  } catch {
    return null
  }
  const out = new Map<string, string[]>()
  for (const def of SOURCES) {
    const ids = new Set<string>()
    for (const c of credsFor(creds, def).filter((x) => !x.disabled)) {
      for (const m of await mgmt.credentialModels(c.name).catch(() => [])) ids.add(m.id)
    }
    if (ids.size) out.set(def.id, [...ids])
  }
  return out
}
