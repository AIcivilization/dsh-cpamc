// 设置页的渲染测试：用真的 React 把每个区块按几种状态渲染一遍，抓渲染路径上的引用错误与文案
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

type Comp = (props: Record<string, unknown>) => unknown
interface Mod {
  __test: Record<string, Comp> & { statusOf: (s: object) => { text: string } }
}

function load(lang: string): Mod {
  const src = readFileSync(join(__dirname, '../../plugin/client.js'), 'utf8')
  let mod: Mod | undefined
  runInNewContext(src, {
    window: { __ModuleLoader__: { load: ({ factory }: { factory: (req: (n: string) => unknown) => Mod }) => (mod = factory(() => React)) } },
    document: { documentElement: { lang } },
    navigator: {},
    console,
  })
  return mod!
}

const render = (m: Mod, name: string, props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(m.__test[name] as never, props as never))

const pricing = { tier: 'free', zh: '账号自带免费积分', en: 'Free credits' }
const sources = [
  { id: 'workbuddy', label: 'WorkBuddy', plugin: true, login: 'link', riskAck: false, pricing, loggedIn: true, active: true, shown: true, account: 'me@example.com', models: 12, usage: { source: 'workbuddy', windows: [], fetchedAt: '', unsupported: true, probedModel: 'hy3' } },
  { id: 'trae', label: 'Trae', plugin: true, login: 'link', riskAck: false, pricing, loggedIn: true, active: true, shown: false, models: 3 },
  { id: 'qoder', label: 'Qoder', plugin: true, login: 'link', riskAck: false, pricing, loggedIn: true, active: false, shown: true, models: 0 },
  { id: 'zcode', label: 'ZCode', plugin: true, login: 'link', riskAck: false, pricing, loggedIn: false, active: false, shown: true, models: 0 },
  { id: 'claude', label: 'Claude', plugin: false, login: 'paste', riskAck: true, pricing: { tier: 'paid', zh: '需要 Claude Pro / Max 订阅', en: 'Needs a plan' }, subscribeUrl: 'https://claude.com/pricing', loggedIn: false, active: false, shown: true, models: 0 },
  { id: 'codex', label: 'Codex', plugin: false, login: 'device', riskAck: false, pricing: { tier: 'paid', zh: '需要 ChatGPT Plus / Pro 订阅', en: 'Needs a plan' }, loggedIn: true, active: true, shown: true, models: 5, usage: { source: 'codex', plan: 'plus', windows: [{ id: '5h', label: '5h', usedPercent: 40 }], fetchedAt: '' } },
]
const w = (n: number) => ({ requests: n, failures: 0, successRate: n ? 1 : null, avgLatencyMs: n ? 1200 : null, tokensPerSec: n ? 42.5 : null, lastUsedAt: n ? new Date().toISOString() : null, lastFailureAt: null })
const stats = { updatedAt: '', byKey: { dsh: { h1: w(1), d1: w(3) } }, bySource: { workbuddy: { h1: w(1), d1: w(3) } }, byModel: {}, lastOk: { model: 'hy3', source: 'workbuddy', at: new Date().toISOString() } }
const noop = () => {}

describe('settings page rendering', () => {
  for (const lang of ['zh-CN', 'en']) {
    const m = load(lang)
    const zh = lang.startsWith('zh')

    it(`${lang}: header shows name and version, update only when newer`, () => {
      const base = { version: '0.1.0', canManage: true, commands: { update: 'u', uninstall: 'x' } }
      const same = render(m, 'Header', { self: { ...base, latest: '0.1.0' }, onJob: noop })
      expect(same).toContain('dsh-cpamc')
      expect(same).toContain('v0.1.0')
      expect(same).not.toContain(zh ? '更新到' : 'Update to')
      expect(same).toContain(zh ? '卸载' : 'Uninstall')
      expect(render(m, 'Header', { self: { ...base, latest: '0.2.0' }, onJob: noop })).toContain(zh ? '更新到 v0.2.0' : 'Update to v0.2.0')
      expect(render(m, 'Header', { self: null, onJob: noop })).toContain('dsh-cpamc')
    })

    it(`${lang}: models section covers every source state`, () => {
      const html = render(m, 'ModelsSection', { sources, stats, reload: noop, openPanel: noop })
      for (const s of sources) expect(html).toContain(s.label)
      expect(html).toContain('hy3')
      expect(html).toContain(zh ? '在全部功能中登录' : 'Sign in under All features')
      expect(html).toContain(zh ? '暂无请求数据' : 'No request data yet')
      expect(html).toContain('42.5 tokens/s')
      expect(html).toContain(zh ? '已隐藏' : 'Hidden')
      expect(html).toContain(zh ? '已停用' : 'Disabled')
      const empty = render(m, 'ModelsSection', { sources: sources.map((s) => ({ ...s, loggedIn: false })), stats: { ...stats, lastOk: null, bySource: {} }, reload: noop, openPanel: noop })
      expect(empty).toContain(zh ? '还没有登录任何来源' : 'No source is signed in yet')
    })

    it(`${lang}: keys, service and the All features card render`, () => {
      const keys = render(m, 'KeysSection', { info: { keys: [{ name: 'dsh', key: 'dshc_…abcd', createdAt: '2026-10-13T00:00:00Z', stats: { h1: w(0), d1: w(3) } }], foreign: 2 }, endpoints: { local: 'http://127.0.0.1:8317/v1', public: 'https://x.example:9443/v1' }, reload: noop })
      expect(keys).toContain('dshc_…abcd')
      expect(keys).toContain('https://x.example:9443/v1')
      expect(keys).toContain(zh ? '另有 2 把' : '2 more key')
      const service = { mode: 'vps', engine: { running: true, port: 8317, version: '8.0.13', service: null }, components: { plugins: '0.8.68', panel: '1.26.2' }, daemon: { port: 18327 }, remote: { publicUrl: 'https://x.example:9443/v1' }, canRestart: false }
      const svc = render(m, 'ServiceSection', { service, reload: noop })
      expect(svc).toContain('v0.8.68')
      expect(svc).toContain('dsh-vps')
      expect(svc).not.toContain(zh ? '重启服务' : 'Restart service')
      const card = render(m, 'FullFeaturesCard', { openRef: { current: null } })
      expect(card).toContain(zh ? '全部功能' : 'All features')
      expect(card).toContain(zh ? '复制登录密钥' : 'Copy sign-in key')
      expect(render(m, 'Onboarding', { code: 'daemon_not_configured', onDone: noop })).toContain(zh ? '一键准备' : 'Prepare now')
      expect(render(m, 'SelfProgress', { job: { action: 'uninstall', from: '0.1.0' }, onDone: noop })).toContain(zh ? '正在卸载' : 'Uninstalling')
      expect(render(m, 'SettingsSection', {})).toContain('dsh-cpamc')
    })
  }

  it('source status labels', () => {
    const m = load('en')
    expect(m.__test.statusOf({ loggedIn: false }).text).toBe('Signed out')
    expect(m.__test.statusOf({ loggedIn: true, active: false }).text).toBe('Disabled')
    expect(m.__test.statusOf({ loggedIn: true, active: true, usage: { noAccess: true } }).text).toBe('No quota')
    expect(m.__test.statusOf({ loggedIn: true, active: true, usage: { unsupported: true } }).text).toBe('Ready')
  })
})
