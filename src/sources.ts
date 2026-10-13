// sources.ts — 六个默认来源（设计 §4）。都由引擎提供：四个 IDE 来源是引擎的渠道插件，Claude / Codex 是引擎原生 OAuth。
//
// 界面上每个来源一个「显示 / 隐藏」开关，只决定它的模型进不进 dsh，不改引擎里的凭据与配置。
// 登录与完整设置在原版管理界面（「全部功能」）里做；login 字段给备用的命令行登录用。

export type LoginKind = 'device' | 'paste' | 'link'

export interface SourceDef {
  id: string
  label: string
  /** 引擎管理接口里的 provider 名（凭据的 provider / type 字段，oauth/auth-url 的 provider 参数） */
  engineProvider: string
  /** 渠道插件 id（引擎 plugins.configs.<id>）；Claude / Codex 是引擎原生，没有 */
  plugin?: string
  login: LoginKind
  /** auth-dir 里凭据文件名前缀（列表里没有 provider 字段时兜底） */
  filePrefix: string
  /** 条款明确限制第三方使用：开启前要确认风险 */
  riskAck?: boolean
  /** 没有订阅时给用户的开通页面 */
  subscribeUrl?: string
  /** 引擎自带的 device code 登录参数（命令行登录用） */
  deviceCliFlag?: string
  /** 查不了用量的来源，登录后用这个模型实测一次能不能调（不写就用它的第一个模型） */
  probeModel?: string
  pricing: Pricing
}

export interface Pricing {
  tier: 'free' | 'limited' | 'paid'
  zh: string
  en: string
}

export const SOURCES: SourceDef[] = [
  { id: 'workbuddy', label: 'WorkBuddy', engineProvider: 'workbuddy', plugin: 'workbuddy', login: 'link', filePrefix: 'workbuddy-', pricing: { tier: 'free', zh: '账号自带免费积分', en: 'Free credits on the account' } },
  { id: 'trae', label: 'Trae', engineProvider: 'trae', plugin: 'trae', login: 'link', filePrefix: 'trae-', pricing: { tier: 'free', zh: '账号自带免费积分', en: 'Free credits on the account' } },
  { id: 'qoder', label: 'Qoder', engineProvider: 'qoder', plugin: 'qoder', login: 'link', filePrefix: 'qoder-', pricing: { tier: 'free', zh: '账号自带免费积分', en: 'Free credits on the account' } },
  { id: 'zcode', label: 'ZCode', engineProvider: 'zcode', plugin: 'zcode', login: 'link', filePrefix: 'zcode-', pricing: { tier: 'free', zh: '账号自带免费 token 额度', en: 'Free token quota on the account' } },
  { id: 'claude', label: 'Claude', engineProvider: 'claude', login: 'paste', filePrefix: 'claude-', riskAck: true, subscribeUrl: 'https://claude.com/pricing', pricing: { tier: 'paid', zh: '需要 Claude Pro / Max 订阅', en: 'Needs a Claude Pro / Max subscription' } },
  { id: 'codex', label: 'Codex', engineProvider: 'codex', login: 'device', deviceCliFlag: '-codex-device-login', filePrefix: 'codex-', subscribeUrl: 'https://chatgpt.com/pricing', pricing: { tier: 'paid', zh: '需要 ChatGPT Plus / Pro 订阅', en: 'Needs a ChatGPT Plus / Pro subscription' } },
]

/** 要在引擎里逐个启用的渠道插件 */
export const PLUGIN_IDS = SOURCES.flatMap((s) => (s.plugin ? [s.plugin] : []))

const ALIASES: Record<string, string> = { chatgpt: 'codex', openai: 'codex', wb: 'workbuddy' }

export function findSource(id: string): SourceDef | undefined {
  const k = ALIASES[id.toLowerCase()] ?? id.toLowerCase()
  return SOURCES.find((s) => s.id === k)
}

/** 凭据属于哪个来源：优先看 provider / type 字段，否则看文件名前缀 */
export function credsFor<T extends { name: string; provider?: unknown; type?: unknown }>(creds: T[], def: SourceDef): T[] {
  return creds.filter((c) => {
    const p = String(c.provider ?? c.type ?? '').toLowerCase()
    if (p) return p === def.engineProvider
    return c.name.startsWith(def.filePrefix)
  })
}

/** 引擎因 403 payment_required 把这个凭据冷却了（实测：没有订阅时如此）*/
export function paymentRequired(cred: object): boolean {
  const cooldowns = (cred as { cooldowns?: unknown }).cooldowns
  return Array.isArray(cooldowns) && cooldowns.some((c) => (c as { reason?: string })?.reason === 'payment_required')
}
