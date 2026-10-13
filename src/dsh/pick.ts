// dsh/pick.ts — dsh 的模型选择器里默认显示哪些模型（设计 §4.2）
//
// 引擎照常提供全部模型（其他软件经同一个地址都能用）；写进 dsh 的要精简。
// 用户在面板里勾选过的来源按勾选；没勾选过的用全局默认：
//   免费来源里、在用户自己的账号上实测调通的那个模型（守护进程登录后会实测一次），按来源顺序最多取 2 个。
//   没有一个实测通过时就什么都不默认显示，面板给出空状态——不拿没验证过的模型凑数。

export const DEFAULT_LIMIT = 2

/** 不是对话用的模型（画图、向量、重排、语音、审查、自动路由） */
const NON_CHAT = /image|embed|bge-|rerank|tts|whisper|audio|review|(^|\/)(auto|default-model)$/i

export function isChatModel(id: string): boolean {
  return !NON_CHAT.test(id)
}

export interface DefaultSource {
  source: string
  tier: 'free' | 'limited' | 'paid'
  /** 这个来源现在能放进 dsh 的模型 id */
  models: string[]
  /** 实测调通的模型 */
  probedModel?: string
}

/** 全局默认：来源 → 默认显示的模型（按传入顺序，最多 limit 个来源各 1 个） */
export function globalDefault(sources: DefaultSource[], limit = DEFAULT_LIMIT): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const s of sources) {
    if (out.size >= limit) break
    if (s.tier !== 'free' || !s.probedModel || !s.models.includes(s.probedModel)) continue
    out.set(s.source, [s.probedModel])
  }
  return out
}

/** 这个来源在 dsh 里显示哪些：勾选过就按勾选（只留现在还在的），否则用默认 */
export function pickedFor(models: string[], chosen: string[] | undefined, fallback: string[] = []): string[] {
  if (!chosen) return fallback
  const have = new Set(models)
  const kept = chosen.filter((id) => have.has(id))
  // 勾选的模型全都下线了：退回默认，免得这个来源整组消失
  return kept.length || !chosen.length ? kept : fallback
}
