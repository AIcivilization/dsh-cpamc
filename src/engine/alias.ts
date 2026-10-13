// engine/alias.ts — 同名模型的别名（设计 §3.3）
//
// 引擎的模型 id 不带来源：同一个模型名由几个来源同时提供时，引擎会在这几个来源的账号之间轮询，
// 用户选了 Trae 的模型，却可能消耗 WorkBuddy 的额度。给每个来源的同名模型配一个唯一别名
// <来源>/<模型名>（写在引擎配置 oauth.model-alias.<来源> 下），别名只登记在那个来源名下，就不会跨来源。
//
// 规则：
//   - 只拆同名的：不重名的模型保持原名，用户在别处用原名照样能调；
//   - 别名一旦建了就保留（只要那个来源还提供这个模型），免得另一个来源退出登录后 id 变回原名、dsh 里选中的模型失效；
//   - 前缀就是来源 id，统计里的来源归属（stats.sourceOf）直接按前缀认。

import { SOURCES } from '../sources.js'

export interface AliasEntry {
  /** 来源 id（= 引擎 model-alias 下的键） */
  source: string
  /** 上游的模型名 */
  name: string
  /** 客户端看到的 id */
  alias: string
}

export function aliasFor(source: string, name: string): string {
  return `${source}/${name}`
}

/** 引擎报回来的 id 去掉本来源自己的别名前缀（别的斜杠 id 原样保留） */
export function bareName(source: string, id: string): string {
  const prefix = `${source}/`
  return id.toLowerCase().startsWith(prefix) ? id.slice(prefix.length) : id
}

export function entryKey(e: Pick<AliasEntry, 'source' | 'name'>): string {
  return `${e.source}\t${e.name.toLowerCase()}`
}

/**
 * @param offered 每个来源现在能服务的模型 id（可能已经是别名形态）
 * @param previous 上次写进引擎的、dsh-cpamc 生成的别名
 */
export function computeAliases(offered: Map<string, string[]>, previous: AliasEntry[] = []): AliasEntry[] {
  const bySource = new Map<string, Set<string>>()
  const owners = new Map<string, Set<string>>() // 小写裸名 → 来源
  const display = new Map<string, string>() // 来源 + 小写裸名 → 该来源报的原样大小写
  for (const [source, ids] of offered) {
    if (!SOURCES.some((s) => s.id === source)) continue
    const names = new Set<string>()
    for (const id of ids) {
      const name = bareName(source, id)
      const k = name.toLowerCase()
      names.add(k)
      display.set(`${source}\t${k}`, name)
      let set = owners.get(k)
      if (!set) owners.set(k, (set = new Set()))
      set.add(source)
    }
    bySource.set(source, names)
  }
  const out = new Map<string, AliasEntry>()
  for (const [k, set] of owners) {
    if (set.size < 2) continue
    for (const source of set) {
      const name = display.get(`${source}\t${k}`)!
      out.set(entryKey({ source, name }), { source, name, alias: aliasFor(source, name) })
    }
  }
  for (const p of previous) {
    if (bySource.get(p.source)?.has(p.name.toLowerCase()) && !out.has(entryKey(p))) out.set(entryKey(p), p)
  }
  return [...out.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
}
