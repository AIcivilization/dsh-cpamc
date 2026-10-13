/* global window, document, fetch, navigator, setTimeout, clearTimeout, setInterval, clearInterval */
// plugin/client.js — dsh-cpamc 的设置页（设计 §5）
//
// 手写单文件 bundle，没有构建链：由 dsh web 客户端的 ModuleLoader 注入。
// 挂在「设置 → dsh-cpamc」：页眉（名称、版本、更新、卸载）→ 模型管理 → API Key → 服务 →「全部功能」卡片。
// 界面只通过 /api-dsh-cpamc/call 调宿主，宿主再转给 dsh-cpamc 守护进程；页面拿不到守护进程或引擎的密钥。
// 语言跟随 dsh（页面的 lang），没有单独的语言选择。
// 硬约束：界面崩了不能影响 dsh，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-cpamc',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    // —— 语言：跟着 dsh ——
    const isZh = () => {
      const l = (document.documentElement.lang || navigator.language || 'zh').toLowerCase()
      return l.startsWith('zh')
    }
    const L = (zh, en) => (isZh() ? zh : en)

    // —— 调宿主 ——
    let token = window.__DSH_CPAMC_TOKEN__ || ''
    async function refreshToken() {
      const r = await fetch('/api-dsh-cpamc/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' })
      const j = await r.json().catch(() => ({}))
      if (j.token) token = j.token
    }
    async function api(method, path, body, retried) {
      const r = await fetch('/api-dsh-cpamc/call', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-cpamc-token': token },
        body: JSON.stringify({ method, path, lang: isZh() ? 'zh' : 'en', ...(body !== undefined ? { body } : {}) }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.status === 403 && !retried && j?.error?.code === 'refused') {
        await refreshToken()
        return api(method, path, body, true)
      }
      if (!r.ok || j?.error) {
        const e = new Error(j?.error?.message || `HTTP ${r.status}`)
        e.code = j?.error?.code
        e.hint = j?.error?.hint
        throw e
      }
      return j
    }

    // —— 样式（用 dsh 的颜色变量，跟随明暗主题）——
    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #888)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,.25))',
      layer: 'var(--dsw-alias-bg-layer-1, transparent)',
      base: 'var(--dsw-alias-bg-base, #fff)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
      err: 'var(--dsw-alias-state-error-primary, #cf222e)',
      accent: 'var(--primary, #4d6bfe)',
      accentFg: 'var(--primary-foreground, #fff)',
    }
    const S = {
      section: { margin: '0 0 28px' },
      h: { fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: C.text },
      note: { fontSize: 12, color: C.sub, margin: '0 0 12px', lineHeight: 1.6 },
      card: { border: `1px solid ${C.border}`, borderRadius: 10, background: C.layer, overflow: 'hidden' },
      row: { padding: '12px 14px', borderTop: `1px solid ${C.border}` },
      rowFirst: { padding: '12px 14px' },
      line: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 28, flexWrap: 'wrap' },
      label: { fontSize: 14, fontWeight: 500, color: C.text },
      meta: { fontSize: 12, color: C.sub },
      grow: { flex: 1, minWidth: 0 },
      btn: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: `1px solid ${C.border}`, background: 'transparent', color: C.text, cursor: 'pointer' },
      btnPrimary: { fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none', background: C.accent, color: C.accentFg, cursor: 'pointer' },
      input: { fontSize: 13, padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.base, color: C.text, minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', fontWeight: 500, color: C.sub, padding: '6px 10px', borderBottom: `1px solid ${C.border}` },
      td: { padding: '6px 10px', borderBottom: `1px solid ${C.border}`, color: C.text, whiteSpace: 'nowrap' },
      chip: (color) => ({ fontSize: 11, color, marginLeft: 6, border: `1px solid ${color}`, borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap' }),
    }

    // —— 小部件 ——
    function Switch({ on, busy, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': label,
        title: label,
        disabled: busy,
        onClick: () => onChange(!on),
        style: {
          width: 36, height: 20, borderRadius: 10, border: 'none', padding: 2, cursor: busy ? 'wait' : 'pointer', flex: 'none',
          background: on ? C.ok : 'var(--dsw-alias-border-l4, rgba(127,127,127,.4))', opacity: busy ? 0.6 : 1, transition: 'background .15s',
        },
      }, h('span', { style: { display: 'block', width: 16, height: 16, borderRadius: 8, background: '#fff', transform: on ? 'translateX(16px)' : 'none', transition: 'transform .15s' } }))
    }

    function Bar({ pct }) {
      const p = Math.max(0, Math.min(100, pct))
      const color = p >= 90 ? C.err : p >= 70 ? C.warn : C.ok
      return h('span', { style: { display: 'inline-block', width: 120, height: 6, borderRadius: 3, background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.2))', verticalAlign: 'middle', overflow: 'hidden' } },
        h('span', { style: { display: 'block', width: `${p}%`, height: '100%', background: color } }))
    }

    const until = (iso) => {
      if (!iso) return ''
      const ms = Date.parse(iso) - Date.now()
      if (!(ms > 0)) return L('即将重置', 'resetting')
      const m = Math.round(ms / 60000)
      const d = Math.floor(m / 1440)
      const hh = Math.floor((m % 1440) / 60)
      const mm = m % 60
      const t = d ? L(`${d} 天 ${hh} 小时`, `${d}d ${hh}h`) : hh ? L(`${hh} 小时 ${mm} 分`, `${hh}h ${mm}m`) : L(`${mm} 分`, `${mm}m`)
      return L(`${t}后重置`, `resets in ${t}`)
    }
    const winLabel = (w) => ({ '5h': L('5 小时', '5 hours'), '7d': L('每周', 'Weekly'), '30d': L('每月', 'Monthly'), quota: L('总额度', 'Quota') }[w.label] || w.label)
    const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`)
    const ms = (x) => (x == null ? '-' : x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${x}ms`)
    const ago = (iso) => {
      if (!iso) return '-'
      const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
      return m < 1 ? L('刚刚', 'just now') : m < 60 ? L(`${m} 分钟前`, `${m}m ago`) : m < 1440 ? L(`${Math.round(m / 60)} 小时前`, `${Math.round(m / 60)}h ago`) : L(`${Math.round(m / 1440)} 天前`, `${Math.round(m / 1440)}d ago`)
    }
    const rateColor = (x) => (x == null ? C.sub : x >= 0.98 ? C.ok : x >= 0.9 ? C.warn : C.err)

    async function copy(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // 非安全上下文（http 访问）没有 clipboard API：退回老办法
        try {
          const t = document.createElement('textarea')
          t.value = text
          t.style.position = 'fixed'
          t.style.opacity = '0'
          document.body.appendChild(t)
          t.select()
          const done = document.execCommand('copy')
          t.remove()
          return done
        } catch {
          return false
        }
      }
    }

    /** 复制按钮：get 可以是异步取值（例如取完整 key）；点完显示"已复制"。clearAfter：多少毫秒后清空剪贴板（尽力而为） */
    function CopyButton({ get, label, style, clearAfter }) {
      const [state, setState] = useState('')
      const timer = useRef(null)
      useEffect(() => () => clearTimeout(timer.current), [])
      const onClick = async () => {
        let done = false
        let value = ''
        try { value = typeof get === 'function' ? await get() : get; done = await copy(value) } catch { done = false }
        setState(done ? 'ok' : 'fail')
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setState(''), 1500)
        if (done && clearAfter) {
          setTimeout(async () => {
            try { if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText('') } catch { /* 读不了剪贴板就算了 */ }
          }, clearAfter)
        }
      }
      return h('button', { type: 'button', style: { ...S.btn, ...(style || {}), ...(state === 'ok' ? { color: C.ok } : state === 'fail' ? { color: C.err } : {}) }, onClick },
        state === 'ok' ? L('已复制', 'Copied') : state === 'fail' ? L('复制失败', 'Copy failed') : (label || L('复制', 'Copy')))
    }

    function PriceTag({ pricing }) {
      if (!pricing) return null
      const color = pricing.tier === 'free' ? C.ok : pricing.tier === 'limited' ? C.warn : C.err
      const text = pricing.tier === 'free' ? L('免费额度', 'Free quota') : pricing.tier === 'limited' ? L('免费·额度少', 'Free · limited') : L('需付费', 'Paid')
      return h('span', { title: L(pricing.zh, pricing.en), style: S.chip(color) }, text)
    }

    /** 来源状态：未登录 / 可用 / 无可用额度 / 已停用 / 状态未知 */
    function statusOf(s) {
      if (!s.loggedIn) return { text: L('未登录', 'Signed out'), color: C.faint }
      if (!s.active) return { text: L('已停用', 'Disabled'), color: C.warn, hint: L('凭据在完整管理界面里被停用了', 'Its credentials were disabled in the full management interface') }
      if (s.usage?.noAccess) return { text: L('无可用额度', 'No quota'), color: C.warn }
      if (s.usage && !s.usage.error) return { text: L('可用', 'Ready'), color: C.ok }
      return { text: L('已登录', 'Signed in'), color: C.ok }
    }

    // —— 页眉（R7）——
    const newer = (a, b) => {
      const pa = String(a || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
      const pb = String(b || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
      return false
    }

    function Header({ self, onJob }) {
      const [confirming, setConfirming] = useState(false)
      const [keepAuth, setKeepAuth] = useState(false)
      const [err, setErr] = useState('')
      const [starting, setStarting] = useState(false)
      const [showCmd, setShowCmd] = useState('')
      const version = self?.version
      const hasUpdate = Boolean(self?.latest && version && newer(self.latest, version))
      const start = async (action) => {
        if (starting) return
        if (!self.canManage) { setShowCmd(action); return }
        setErr('')
        setStarting(true)
        try {
          await api('POST', `/self/${action}`, action === 'uninstall' ? { keepAuth } : {})
          onJob({ action, from: version, target: self.latest })
        } catch (e) {
          // 连不上守护进程多半是它已经开始重启（任务已经在跑）：照样进进度页，等它回来
          if (e.code === 'daemon_unreachable') onJob({ action, from: version, target: self.latest })
          else setErr(e.message)
        } finally {
          setStarting(false)
        }
      }
      return h('div', { style: { ...S.section, marginBottom: 20 } },
        h('div', { style: { ...S.line, gap: 12 } },
          h('span', { style: { fontSize: 18, fontWeight: 600, color: C.text } }, 'dsh-cpamc'),
          version ? h('span', { style: { ...S.meta, ...S.mono } }, `v${version}`) : null,
          h('span', { style: S.grow }),
          hasUpdate ? h('button', { type: 'button', style: S.btnPrimary, disabled: starting, onClick: () => void start('update') }, starting ? L('正在开始…', 'Starting…') : L(`更新到 v${self.latest}`, `Update to v${self.latest}`)) : null,
          self ? h('button', { type: 'button', style: { ...S.btn, color: C.err }, onClick: () => setConfirming(!confirming) }, L('卸载', 'Uninstall')) : null),
        showCmd && self ? h('div', { style: { ...S.card, padding: '10px 12px', marginTop: 10 } },
          h('div', { style: S.meta }, L('服务器上这一步要 root 权限，请在服务器终端里执行：', 'On the server this needs root; run in a server terminal:')),
          h('div', { style: { ...S.line, minHeight: 30 } }, h('code', { style: { ...S.mono, ...S.grow } }, self.commands[showCmd]), h(CopyButton, { get: self.commands[showCmd] }))) : null,
        confirming ? h('div', { style: { marginTop: 10, padding: 12, border: `1px solid ${C.err}`, borderRadius: 8 } },
          h('div', { style: { fontSize: 13, color: C.text, lineHeight: 1.7 } }, L(
            '卸载会依次：撤下对外访问 → 把 dsh 里的模型配置还原 → 停止并移除模型服务与守护进程 → 确认端口已释放 → 删除 ~/.dsh-cpamc（含各来源的登录凭据）→ 从 dsh 移除本插件。任何一步没完成都会停下来并可以重试，不会显示「已卸载」。',
            'Uninstall will: remove remote access → restore dsh\'s model config → stop and remove the model service and daemon → confirm the ports are free → delete ~/.dsh-cpamc (including source sign-ins) → remove this plugin from dsh. If any step fails it stops there and can be retried; it never reports success early.')),
          h('label', { style: { ...S.line, fontSize: 13, marginTop: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: keepAuth, onChange: (e) => setKeepAuth(e.target.checked) }),
            L('先把各来源的登录凭据备份到主目录（以后重装可以拷回来）', 'Back up source sign-ins to the home folder first (to reuse after reinstalling)')),
          h('div', { style: { ...S.line, marginTop: 8 } },
            h('button', { type: 'button', style: { ...S.btnPrimary, background: C.err }, disabled: starting, onClick: () => void start('uninstall') }, starting ? L('正在开始…', 'Starting…') : L('确认卸载', 'Uninstall')),
            h('button', { type: 'button', style: S.btn, onClick: () => setConfirming(false) }, L('取消', 'Cancel')))) : null,
        err ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, err) : null)
    }

    // —— 模型管理（R2 ①、R3、R6）——
    function Usage({ usage, subscribeUrl }) {
      if (!usage) return null
      if (usage.noAccess) {
        return h('div', { style: { ...S.line, alignItems: 'flex-start', fontSize: 12, color: C.warn, marginTop: 6, paddingLeft: 46, lineHeight: 1.6 } },
          h('span', { style: S.grow }, L(`当前账号没有可用额度，调用会被拒绝，所以它的模型没有放进 dsh。${usage.error ? `（${usage.error}）` : ''}`, `This account has no usable quota — calls are refused, so its models are not in dsh.${usage.error ? ` (${usage.error})` : ''}`)),
          subscribeUrl ? h('a', { href: subscribeUrl, target: '_blank', rel: 'noopener noreferrer', style: { ...S.btn, textDecoration: 'none', flex: 'none' } }, L('看套餐 ↗', 'Plans ↗')) : null)
      }
      if (usage.unsupported) return null
      const lines = []
      if (usage.plan) lines.push(h('div', { key: 'plan', style: { ...S.meta, marginTop: 6 } }, `${L('套餐', 'Plan')}：${usage.plan}`))
      for (const w of usage.windows || []) {
        lines.push(h('div', { key: w.id, style: { ...S.line, minHeight: 22, fontSize: 12, color: C.text } },
          h('span', { style: { width: 72, color: C.sub } }, winLabel(w)),
          w.usedPercent != null ? h(Bar, { pct: w.usedPercent }) : null,
          w.usedPercent != null ? h('span', { style: { width: 40, textAlign: 'right' } }, `${Math.round(w.usedPercent)}%`) : null,
          w.used != null && w.limit != null ? h('span', { style: { color: C.sub } }, `${w.used}/${w.limit}`) : null,
          h('span', { style: { color: C.faint } }, until(w.resetAt))))
      }
      if (usage.credits) {
        const c = usage.credits
        lines.push(h('div', { key: 'credits', style: { ...S.line, minHeight: 22, fontSize: 12 } },
          h('span', { style: { width: 72, color: C.sub } }, L('余额', 'Balance')),
          c.total ? h(Bar, { pct: 100 - (c.remaining / c.total) * 100 }) : null,
          h('span', null, c.unlimited ? L('不限量', 'Unlimited') : L(`剩余 ${c.remaining.toLocaleString()}${c.total ? ` / ${c.total.toLocaleString()}` : ''}`, `${c.remaining.toLocaleString()} left${c.total ? ` of ${c.total.toLocaleString()}` : ''}`))))
      }
      if (usage.error) lines.push(h('div', { key: 'err', style: { fontSize: 12, color: C.warn, marginTop: 4 } }, `${L('用量暂不可用', 'Usage unavailable')}：${usage.error}`))
      return lines.length ? h('div', { style: { marginTop: 4, paddingLeft: 46 } }, lines) : null
    }

    /** 一个来源最近 24 小时经引擎的真实请求：请求数、成功率、平均延迟、输出速度；没有请求就写「暂无请求数据」 */
    function SourceStats({ st }) {
      const d = st?.d1
      if (!d || !d.requests) return h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 2 } }, L('暂无请求数据', 'No request data yet'))
      return h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 2 } },
        L('最近 24 小时', 'Last 24h'), ' · ',
        L(`${d.requests} 次请求`, `${d.requests} requests`), ' · ',
        h('span', { style: { color: rateColor(d.successRate) } }, L(`成功率 ${pct(d.successRate)}`, `${pct(d.successRate)} success`)), ' · ',
        L(`平均延迟 ${ms(d.avgLatencyMs)}`, `avg latency ${ms(d.avgLatencyMs)}`), ' · ',
        d.tokensPerSec != null ? `${d.tokensPerSec} tokens/s` : L('速度暂不可用', 'speed n/a'))
    }

    /** 勾选这个来源的哪些模型显示在 dsh 里（引擎照常提供全部） */
    function ModelPicker({ source, onClose }) {
      const [data, setData] = useState(null)
      const [sel, setSel] = useState(new Set())
      const [q, setQ] = useState('')
      const [msg, setMsg] = useState('')
      const [saving, setSaving] = useState(false)
      useEffect(() => {
        let alive = true
        api('GET', `/sources/${source.id}/models`).then((r) => {
          if (!alive) return
          setData(r)
          setSel(new Set(r.models.filter((m) => m.selected).map((m) => m.id)))
        }, (e) => alive && setMsg(e.message))
        return () => { alive = false }
      }, [source.id])
      if (!data) return h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 8 } }, msg || L('加载中…', 'Loading…'))
      const flip = (id) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n })
      const save = async (models) => {
        setSaving(true)
        setMsg('')
        try {
          await api('POST', `/sources/${source.id}/models`, { models })
          onClose(true)
        } catch (e) {
          setMsg(e.message)
        } finally {
          setSaving(false)
        }
      }
      const shown = data.models.filter((m) => !q || `${m.name} ${m.id}`.toLowerCase().includes(q.toLowerCase()))
      return h('div', { style: { marginTop: 10, marginLeft: 46, padding: 10, border: `1px solid ${C.border}`, borderRadius: 8 } },
        h('div', { style: { ...S.line, marginBottom: 6 } },
          h('span', { style: { ...S.meta, ...S.grow } }, L(`勾选的模型显示在 dsh 的模型选择器里（已选 ${sel.size} / ${data.models.length}）。其他软件经同一个地址照样能用全部模型。`, `Checked models appear in dsh's model picker (${sel.size} / ${data.models.length} selected). Other tools can still use every model through the same address.`)),
          data.models.length > 10 ? h('input', { style: { ...S.input, width: 140 }, placeholder: L('搜索', 'Search'), value: q, onChange: (e) => setQ(e.target.value) }) : null),
        h('div', { style: { maxHeight: 300, overflowY: 'auto' } }, shown.map((m) => h('label', { key: m.id, style: { ...S.line, minHeight: 26, fontSize: 13, cursor: 'pointer', flexWrap: 'nowrap' } },
          h('input', { type: 'checkbox', checked: sel.has(m.id), onChange: () => flip(m.id) }),
          h('span', { style: S.grow }, m.name),
          m.recommended ? h('span', { title: L('免费额度，已在你的账号上实测调通', 'Free quota, tested OK on your account'), style: { fontSize: 11, color: C.accent } }, L('默认', 'Default')) : null))),
        msg ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, msg) : null,
        h('div', { style: { ...S.line, marginTop: 8 } },
          h('button', { type: 'button', style: S.btnPrimary, disabled: saving, onClick: () => save([...sel]) }, saving ? L('保存中…', 'Saving…') : L('保存', 'Save')),
          h('button', { type: 'button', style: S.btn, disabled: saving, onClick: () => save(null) }, L('恢复默认', 'Use default')),
          h('button', { type: 'button', style: S.btn, onClick: () => setSel(new Set(data.models.map((m) => m.id))) }, L('全选', 'All')),
          h('button', { type: 'button', style: S.btn, onClick: () => setSel(new Set()) }, L('全不选', 'None')),
          h('span', { style: S.grow }),
          h('button', { type: 'button', style: S.btn, onClick: () => onClose(false) }, L('取消', 'Cancel'))))
    }

    function ModelsSection({ sources, stats, reload, openPanel }) {
      const [picking, setPicking] = useState('')
      const [busy, setBusy] = useState({})
      const [err, setErr] = useState('')
      const toggle = async (s, show) => {
        setErr('')
        setBusy((b) => ({ ...b, [s.id]: true }))
        try {
          await api('POST', `/sources/${s.id}/${show ? 'show' : 'hide'}`)
          await reload()
        } catch (e) {
          setErr(`${s.label}：${e.message}`)
        } finally {
          setBusy((b) => ({ ...b, [s.id]: false }))
        }
      }
      const last = stats?.lastOk
      const anyLogged = sources.some((s) => s.loggedIn)
      return h('div', { style: S.section },
        h('div', { style: S.h }, L('模型管理', 'Models')),
        h('p', { style: S.note }, L('六个来源都已装好。登录过、检查通过的来源，它的模型才会出现在 dsh 的模型选择器里；开关只决定在 dsh 里显示还是隐藏，不会改动账号和完整管理界面里的设置。',
          'All six sources are installed. Only signed-in, verified sources put models into dsh\'s model picker; the switch only shows or hides them in dsh and never changes accounts or settings in the full management interface.')),
        h('div', { style: { ...S.card, padding: '10px 14px', marginBottom: 10 } },
          h('div', { style: S.line },
            h('span', { style: { ...S.meta, width: 72 } }, L('最近使用', 'Last used')),
            last ? h('span', { style: S.grow }, h('code', { style: S.mono }, last.model), h('span', { style: { ...S.meta, marginLeft: 8 } }, `${last.source} · ${ago(last.at)}`))
              : h('span', { style: { ...S.meta, ...S.grow } }, L('暂无请求数据', 'No request data yet'))),
          h('div', { style: { ...S.meta, color: C.faint } }, L('dsh 当前对话选的是哪个模型，dsh 没有提供读取接口；这里显示 dsh 最近一次成功请求用到的模型。', 'dsh does not expose which model the current chat uses; this is the model of dsh\'s most recent successful request.'))),
        !anyLogged ? h('div', { style: { ...S.card, padding: '10px 14px', marginBottom: 10, fontSize: 13 } },
          L('还没有登录任何来源。点下方「全部功能」，在完整管理界面里登录 WorkBuddy、Trae、Qoder、ZCode 或你的 Claude / Codex 订阅。', 'No source is signed in yet. Open All features below and sign in to WorkBuddy, Trae, Qoder, ZCode or your Claude / Codex subscription in the full management interface.')) : null,
        err ? h('div', { style: { fontSize: 12, color: C.err, margin: '0 0 8px' } }, err) : null,
        h('div', { style: S.card }, sources.map((s, i) => {
          const st = statusOf(s)
          const usable = s.loggedIn && s.active && !s.usage?.noAccess
          return h('div', { key: s.id, style: i ? S.row : S.rowFirst },
            h('div', { style: S.line },
              h(Switch, { on: s.shown, busy: busy[s.id], label: s.shown ? L('在 dsh 中显示（点一下隐藏）', 'Shown in dsh (click to hide)') : L('在 dsh 中隐藏（点一下显示）', 'Hidden in dsh (click to show)'), onChange: (on) => toggle(s, on) }),
              h('div', { style: S.grow },
                h('span', { style: S.label }, s.label),
                h(PriceTag, { pricing: s.pricing }),
                h('span', { title: st.hint || '', style: S.chip(st.color) }, st.text),
                !s.shown ? h('span', { style: S.chip(C.faint) }, L('已隐藏', 'Hidden')) : null,
                h('span', { style: { ...S.meta, marginLeft: 8 } },
                  s.loggedIn ? (s.account || '') : '',
                  s.models ? ` · ${L(`${s.models} 个模型`, `${s.models} models`)}` : '')),
              usable && s.shown && s.models ? h('button', { type: 'button', style: S.btn, onClick: () => setPicking(picking === s.id ? '' : s.id) }, L('选模型', 'Models')) : null,
              !s.loggedIn ? h('button', { type: 'button', style: S.btn, onClick: openPanel }, L('在全部功能中登录', 'Sign in under All features')) : null),
            picking === s.id ? h(ModelPicker, { source: s, onClose: (saved) => { setPicking(''); if (saved) void reload() } }) : null,
            s.loggedIn ? h(SourceStats, { st: stats?.bySource?.[s.id] }) : null,
            s.loggedIn ? h(Usage, { usage: s.usage, subscribeUrl: s.subscribeUrl }) : null,
            !s.loggedIn ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4 } },
              L(s.pricing.zh, s.pricing.en),
              s.subscribeUrl && s.pricing.tier !== 'free' ? h('a', { href: s.subscribeUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent, marginLeft: 8 } }, L('看套餐 ↗', 'Plans ↗')) : null) : null,
            s.loggedIn && s.detail ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4, color: C.warn } }, s.detail) : null)
        })))
    }

    // —— API Key（R2 ②）——
    function KeysSection({ info, endpoints, reload }) {
      const [name, setName] = useState('')
      const [fresh, setFresh] = useState(null)
      const [err, setErr] = useState('')
      const keys = info?.keys || []
      const add = async () => {
        setErr('')
        try { const r = await api('POST', '/keys', { name: name.trim() }); setFresh(r); setName(''); await reload() } catch (e) { setErr(e.message) }
      }
      const rotate = async (k) => {
        if (!window.confirm(L(`轮换 ${k.name}？旧 key 立即失效。`, `Rotate ${k.name}? The old key stops working immediately.`))) return
        try { const r = await api('POST', `/keys/${encodeURIComponent(k.name)}/rotate`); if (r.key) setFresh(r); await reload() } catch (e) { setErr(e.message) }
      }
      const revoke = async (k) => {
        if (!window.confirm(L(`吊销 ${k.name}？用它的设备会立即无法访问。`, `Revoke ${k.name}? Devices using it lose access immediately.`))) return
        try { await api('DELETE', `/keys/${encodeURIComponent(k.name)}`); await reload() } catch (e) { setErr(e.message) }
      }
      const addrs = endpoints ? [
        ...(endpoints.public ? [{ id: 'public', name: L('外部地址', 'Public'), url: endpoints.public, note: L('你的电脑、手机或其他软件用这个', 'Use this from your computer, phone or other tools') }] : []),
        { id: 'local', name: L('本机地址', 'Local'), url: endpoints.local, note: endpoints.public ? L('只在这台服务器上能用（dsh 自己用的就是它）', 'Only works on this server (dsh itself uses it)') : L('只在这台电脑上能用', 'Only works on this computer') },
      ] : []
      return h('div', { style: S.section },
        h('div', { style: S.h }, 'API Key'),
        h('p', { style: S.note }, L('所有模型都经同一个 OpenAI 兼容地址提供：Base URL 填下面的地址，API Key 用下面任意一把。dsh 用名为 dsh 的那把（已自动配置）；其他设备或软件各领一把，丢了就吊销。新 key 的完整内容只显示一次。',
          'Every model is served from one OpenAI-compatible address: use it as Base URL and any key below as the API key. dsh uses the "dsh" key (configured automatically); give each other device or tool its own key and revoke it if lost. A new key is shown in full only once.')),
        addrs.length ? h('div', { style: { ...S.card, marginBottom: 10 } }, addrs.map((r, i) => h('div', { key: r.id, style: i ? S.row : S.rowFirst },
          h('div', { style: S.line },
            h('span', { style: { ...S.label, width: 72, flex: 'none' } }, r.name),
            h('code', { style: { ...S.mono, ...S.grow, wordBreak: 'break-all' } }, r.url),
            h(CopyButton, { get: r.url })),
          h('div', { style: { ...S.meta, paddingLeft: 82 } }, r.note)))) : null,
        err ? h('div', { style: { fontSize: 12, color: C.err, margin: '0 0 8px' } }, err) : null,
        fresh ? h('div', { style: { ...S.card, padding: 12, marginBottom: 10 } },
          h('div', { style: S.meta }, L(`新 key「${fresh.name}」只显示这一次：`, `New key "${fresh.name}" is shown only once:`)),
          h('div', { style: { ...S.line, marginTop: 6 } }, h('code', { style: { ...S.mono, ...S.grow, wordBreak: 'break-all' } }, fresh.key), h(CopyButton, { get: fresh.key }), h('button', { type: 'button', style: S.btn, onClick: () => setFresh(null) }, L('我已保存', 'Saved')))) : null,
        h('div', { style: { ...S.card, overflowX: 'auto' } },
          h('table', { style: S.table },
            h('thead', null, h('tr', null, [L('名称', 'Name'), 'Key', L('创建时间', 'Created'), L('最近使用', 'Last used'), L('请求(24h)', 'Requests (24h)'), L('成功率', 'Success'), ''].map((t, i) => h('th', { key: i, style: S.th }, t)))),
            h('tbody', null, keys.map((k) => {
              const st = k.stats?.d1
              return h('tr', { key: k.name },
                h('td', { style: S.td }, k.name),
                h('td', { style: { ...S.td, ...S.mono } }, k.key),
                h('td', { style: S.td }, (k.createdAt || '').slice(0, 10)),
                h('td', { style: S.td }, ago(st?.lastUsedAt)),
                h('td', { style: S.td }, st ? st.requests : 0),
                h('td', { style: { ...S.td, color: rateColor(st?.successRate) } }, pct(st?.successRate)),
                h('td', { style: { ...S.td, textAlign: 'right' } },
                  h(CopyButton, { get: async () => (await api('POST', `/keys/${encodeURIComponent(k.name)}/reveal`)).key, style: { marginRight: 6 } }),
                  h('button', { type: 'button', style: S.btn, onClick: () => rotate(k) }, L('轮换', 'Rotate')),
                  k.name !== 'dsh' ? h('button', { type: 'button', style: { ...S.btn, marginLeft: 6, color: C.err }, onClick: () => revoke(k) }, L('吊销', 'Revoke')) : null))
            })))),
        info?.foreign ? h('div', { style: { ...S.meta, marginTop: 6 } }, L(`另有 ${info.foreign} 把 key 是在完整管理界面里添加的，在那里管理。`, `${info.foreign} more key(s) were added in the full management interface; manage them there.`)) : null,
        h('div', { style: { ...S.line, marginTop: 10 } },
          h('input', { style: { ...S.input, width: 200 }, placeholder: L('新 key 名称，如 laptop', 'New key name, e.g. laptop'), value: name, onChange: (e) => setName(e.target.value) }),
          h('button', { type: 'button', style: S.btnPrimary, disabled: !name.trim(), onClick: add }, L('新增 key', 'Add key'))))
    }

    // —— 服务（R2 ③）——
    function ServiceSection({ service, reload }) {
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      if (!service) return null
      const e = service.engine
      const restart = async () => {
        setBusy('restart'); setMsg('')
        try { const r = await api('POST', '/service/restart'); setMsg(r.running ? L('已重启', 'Restarted') : L('重启后没有起来，查看日志：dsh-cpamc logs', 'Did not come back after restart; check: dsh-cpamc logs')); await reload(true) } catch (x) { setMsg(x.message) } finally { setBusy('') }
      }
      const repair = async () => {
        setBusy('repair'); setMsg('')
        try {
          const r = await fetch('/api-dsh-cpamc/setup', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-cpamc-token': token }, body: JSON.stringify({ action: 'repair', lang: isZh() ? 'zh' : 'en' }) })
          const j = await r.json().catch(() => ({}))
          setMsg(j.vps ? L('服务器上请在终端执行：sudo dsh-cpamc repair', 'On the server run: sudo dsh-cpamc repair') : j.code === 0 ? L('修复完成', 'Repaired') : L(`修复没有完成（退出码 ${j.code}）`, `Repair did not finish (exit code ${j.code})`))
          await reload(true)
        } catch (x) { setMsg(x.message) } finally { setBusy('') }
      }
      const row = (label, value, color) => h('div', { style: { ...S.line, minHeight: 26 } }, h('span', { style: { ...S.meta, width: 110, flex: 'none' } }, label), h('span', { style: { fontSize: 13, color: color || C.text } }, value))
      return h('div', { style: S.section },
        h('div', { style: S.h }, L('服务', 'Service')),
        h('div', { style: { ...S.card, padding: '10px 14px' } },
          row(L('模型服务', 'Model service'), e.running ? L(`运行中 · 127.0.0.1:${e.port}`, `Running · 127.0.0.1:${e.port}`) : L('没有运行（点「修复」）', 'Not running (press Repair)'), e.running ? C.ok : C.err),
          row(L('服务版本', 'Service version'), e.version ? `v${e.version}` : '-'),
          row(L('渠道插件', 'Channel plugins'), service.components.plugins ? `v${service.components.plugins}` : '-'),
          row(L('完整管理界面', 'Full interface'), service.components.panel ? `v${service.components.panel}` : '-'),
          service.mode === 'vps' ? row(L('部署位置', 'Deployed on'), L('dsh-vps 服务器', 'dsh-vps server')) : null,
          service.mode === 'vps' && service.remote.publicUrl ? row(L('外部地址', 'Public address'), service.remote.publicUrl) : null,
          service.mode === 'vps' ? h('div', { style: { ...S.meta, marginTop: 4 } }, L('服务器账号、密码和域名在「设置 → dsh-vps」里管理。', 'Server account, password and domain are managed under Settings → dsh-vps.')) : null,
          h('div', { style: { ...S.line, marginTop: 8 } },
            h('button', { type: 'button', style: S.btn, disabled: Boolean(busy), onClick: () => void reload(true) }, L('重新检查', 'Check again')),
            service.canRestart ? h('button', { type: 'button', style: S.btn, disabled: Boolean(busy), onClick: restart }, busy === 'restart' ? L('重启中…', 'Restarting…') : L('重启服务', 'Restart service')) : null,
            h('button', { type: 'button', style: S.btn, disabled: Boolean(busy), onClick: repair }, busy === 'repair' ? L('修复中…', 'Repairing…') : L('修复', 'Repair')),
            msg ? h('span', { style: S.meta }, msg) : null)))
    }

    // —— 「全部功能」卡片（R4）——
    function FullFeaturesCard({ openRef }) {
      const [res, setRes] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const open = async () => {
        setErr('')
        setBusy(true)
        // 先同步开一个空窗口（在点击的手势里），拿到地址再跳过去，免得被拦截弹窗
        let w = null
        try { w = window.open('about:blank', '_blank') } catch { w = null }
        try {
          const r = await api('POST', '/panel/open')
          setRes(r)
          if (!r.running) setErr(L('模型服务没有起来，先在「服务」里点「修复」。', 'The model service is not running; press Repair under Service first.'))
          if (r.url && !r.tunnel && r.running) {
            if (w) { w.opener = null; w.location.href = r.url } else window.open(r.url, '_blank', 'noopener')
          } else if (w) w.close()
        } catch (e) {
          if (w) w.close()
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }
      useEffect(() => { if (openRef) openRef.current = open })
      return h('div', { style: S.section },
        h('div', { style: { ...S.card, padding: '14px 16px' } },
          h('div', { style: S.line },
            h('div', { style: S.grow },
              h('div', { style: S.label }, L('全部功能', 'All features')),
              h('div', { style: { ...S.meta, marginTop: 2 } }, L('需要登录来源账号、修改完整配置、调整路由或查看详细日志？打开原版完整管理界面，它管理的就是为 dsh 提供模型的这个服务。',
                'Need to sign in to sources, change the full configuration, adjust routing or read detailed logs? Open the original full management interface; it manages the very service that provides dsh\'s models.'))),
            h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: open }, busy ? L('正在打开…', 'Opening…') : L('全部功能', 'All features'))),
          h('div', { style: { ...S.line, marginTop: 10 } },
            h('span', { style: { ...S.meta, ...S.grow } }, L('打开后在登录页填入管理密钥：点右边复制（不会显示出来，30 秒后自动从剪贴板清除）。', 'On its sign-in page, paste the management key: copy it with the button on the right (never displayed; cleared from the clipboard after 30 seconds).')),
            h(CopyButton, { get: async () => (await api('POST', '/panel/key')).key, label: L('复制登录密钥', 'Copy sign-in key'), clearAfter: 30_000 })),
          res?.vps && res.apiBase && !res.tunnel ? h('div', { style: { ...S.meta, marginTop: 8 } },
            L('第一次打开时，在登录页勾选「自定义连接地址」，填入：', 'The first time, tick "custom connection address" on the sign-in page and enter:'),
            h('div', { style: { ...S.line, marginTop: 4 } }, h('code', { style: { ...S.mono, ...S.grow } }, res.apiBase), h(CopyButton, { get: res.apiBase }))) : null,
          res?.tunnel ? h('div', { style: { ...S.meta, marginTop: 8, lineHeight: 1.7 } },
            L('这台 dsh-vps 服务器还没有为完整管理界面开通受保护的入口（需要更新 dsh-vps）。现在可以先在你自己的电脑上执行下面的命令，再在本机浏览器打开：', 'This dsh-vps server does not yet provide a protected entry for the full interface (dsh-vps needs an update). For now, run this on your own computer, then open the address in a local browser:'),
            h('div', { style: { ...S.line, marginTop: 4 } }, h('code', { style: { ...S.mono, ...S.grow } }, res.tunnel), h(CopyButton, { get: res.tunnel })),
            h('div', { style: { ...S.line, marginTop: 4 } }, h('code', { style: { ...S.mono, ...S.grow } }, res.url), h(CopyButton, { get: res.url }))) : null,
          err ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, err) : null))
    }

    /** 守护进程还没装 / 没在运行：说明 + 一键安装（本机）或命令（VPS 上要 root） */
    function Onboarding({ code, onDone }) {
      const [busy, setBusy] = useState(false)
      const [res, setRes] = useState(null)
      const notInstalled = code === 'daemon_not_configured'
      const action = notInstalled ? 'setup' : 'repair'
      const run = async () => {
        setBusy(true)
        setRes(null)
        try {
          const r = await fetch('/api-dsh-cpamc/setup', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-cpamc-token': token }, body: JSON.stringify({ action, lang: isZh() ? 'zh' : 'en' }) })
          const j = await r.json().catch(() => ({}))
          if (r.status === 403 && j?.error?.code === 'refused') { await refreshToken(); setBusy(false); return run() }
          setRes(j)
          if (j.code === 0) setTimeout(onDone, 1500)
        } catch (e) {
          setRes({ code: -1, output: e.message })
        } finally {
          setBusy(false)
        }
      }
      const cmds = notInstalled ? ['npm install -g dsh-cpamc', 'dsh-cpamc setup'] : ['dsh-cpamc repair']
      const vpsCmds = notInstalled ? ['sudo npm install -g dsh-cpamc', 'sudo dsh-cpamc setup'] : ['sudo dsh-cpamc repair']
      const cmdBlock = (list) => h('div', { style: { ...S.card, padding: '8px 12px', marginTop: 8 } }, list.map((c) => h('div', { key: c, style: { ...S.line, minHeight: 30 } }, h('code', { style: { ...S.mono, ...S.grow } }, c), h(CopyButton, { get: c }))))
      return h('div', { style: S.section },
        h('div', { style: S.h }, notInstalled ? L('还差一步：准备模型服务', 'One more step: prepare the model service') : L('模型服务没在运行', 'The model service is not running')),
        h('p', { style: S.note }, notInstalled
          ? L('这一步会下载并校验模型服务、四个 IDE 来源的组件和完整管理界面，生成配置与 API Key，启动服务并接进 dsh。之后在这里管理来源、模型和 key。', 'This downloads and verifies the model service, the components for the four IDE sources and the full management interface, generates config and API keys, starts the service and wires it into dsh. After that, manage sources, models and keys here.')
          : L('可能是电脑重启后服务没起来，或者刚升级。修复会按记录重新注册并启动服务。', 'The service may not have started after a reboot, or was just upgraded. Repair re-registers and starts it from the saved records.')),
        res?.vps ? h('div', null,
          h('p', { style: { ...S.note, color: C.text } }, L('这是 dsh-vps 服务器：这一步要 root 权限，请在服务器终端里执行：', 'This is a dsh-vps server: this needs root, so run in a server terminal:')),
          cmdBlock(vpsCmds),
          h('p', { style: { ...S.note, marginTop: 8 } }, L('完成后刷新本页。', 'Reload this page when done.'))) : h('div', null,
          h('div', { style: S.line },
            h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: run }, busy ? (notInstalled ? L('准备中…（约 1 分钟）', 'Preparing… (about a minute)') : L('修复中…', 'Repairing…')) : (notInstalled ? L('一键准备', 'Prepare now') : L('修复', 'Repair'))),
            h('button', { type: 'button', style: S.btn, onClick: onDone }, L('重新检测', 'Check again'))),
          h('p', { style: { ...S.note, marginTop: 10 } }, L('也可以在终端里执行：', 'Or run in a terminal:')),
          cmdBlock(cmds)),
        res && !res.vps ? h('div', { style: { marginTop: 12 } },
          h('div', { style: { fontSize: 12, color: res.code === 0 ? C.ok : C.err, marginBottom: 6 } }, res.code === 0 ? L('完成，正在加载…', 'Done, loading…') : L(`没有完成（退出码 ${res.code}），输出如下：`, `Did not finish (exit code ${res.code}); output:`)),
          h('pre', { style: { ...S.mono, ...S.card, padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, res.output || '')) : null)
    }

    /** 更新 / 卸载进行中：守护进程会重启或消失，期间不显示别的 */
    function SelfProgress({ job, onDone }) {
      const [state, setState] = useState({ phase: 'running', log: '' })
      useEffect(() => {
        let stop = false
        const tick = async () => {
          if (stop) return
          try {
            const r = await api('GET', '/self')
            if (r.job?.log) setState((s) => ({ ...s, log: r.job.log }))
            if (job.action === 'update' && r.version !== job.from) { setState({ phase: 'done', log: r.job?.log || '' }); return }
          } catch (e) {
            if (job.action === 'uninstall' && e.code === 'daemon_not_configured') { setState((s) => ({ ...s, phase: 'done' })); return }
          }
          setTimeout(tick, 2000)
        }
        const t = setTimeout(tick, 2000)
        return () => { stop = true; clearTimeout(t) }
      }, [])
      const upd = job.action === 'update'
      const title = state.phase === 'done'
        ? (upd ? L('更新完成', 'Update complete') : L('已卸载', 'Uninstalled'))
        : (upd ? L(`正在更新到 v${job.target}…（服务会重启一下）`, `Updating to v${job.target}… (the service restarts briefly)`) : L('正在卸载…', 'Uninstalling…'))
      return h('div', { style: S.section },
        h('div', { style: S.h }, title),
        state.phase === 'done' ? h('p', { style: { ...S.note, color: C.text } }, upd
          ? L('完全退出 dsh 再打开一次，设置页的新代码才会生效。', 'Quit dsh completely and open it again so the settings page loads the new code.')
          : L('服务已停止、端口已释放，dsh 里的 dsh-cpamc 模型已移除。完全退出 dsh 再打开，这一页就会消失。日志在主目录的 dsh-cpamc-uninstall.log。', 'Services are stopped, ports are free and dsh-cpamc\'s models are gone from dsh. Quit dsh completely and reopen it and this page disappears. The log is ~/dsh-cpamc-uninstall.log.')) : null,
        state.log ? h('pre', { style: { ...S.mono, ...S.card, padding: 10, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, state.log) : null,
        state.phase === 'done' && upd ? h('button', { type: 'button', style: { ...S.btn, marginTop: 10 }, onClick: onDone }, L('返回', 'Back')) : null)
    }

    // —— 整页 ——
    function SettingsSection() {
      const [data, setData] = useState(null)
      const [self, setSelf] = useState(null)
      const [err, setErr] = useState('')
      const [errCode, setErrCode] = useState('')
      const [selfJob, setSelfJob] = useState(null)
      const alive = useRef(true)
      const openPanel = useRef(null)
      const load = useCallback(async (refresh) => {
        try {
          const [sources, keys, stats, endpoints, service] = await Promise.all([
            api('GET', refresh ? '/sources?refresh=1' : '/sources'),
            api('GET', '/keys-info'),
            api('GET', '/stats'),
            api('GET', '/endpoints').catch(() => null),
            api('GET', '/service').catch(() => null),
          ])
          if (alive.current) { setData({ sources, keys, stats, endpoints, service }); setErr(''); setErrCode('') }
        } catch (e) {
          if (alive.current) { setErr(e.hint ? `${e.message}（${e.hint}）` : e.message); setErrCode(e.code || '') }
        }
      }, [])
      useEffect(() => {
        alive.current = true
        void load(true)
        api('GET', '/self').then((r) => alive.current && setSelf(r), () => {})
        const t = setInterval(() => void load(false), 15000)
        return () => { alive.current = false; clearInterval(t) }
      }, [load])
      const page = (children) => h('div', { style: { color: C.text, maxWidth: 860 } }, h(Header, { self, onJob: setSelfJob }), children)
      if (selfJob) return page(h(SelfProgress, { job: selfJob, onDone: () => { setSelfJob(null); void load(true) } }))
      if (errCode === 'daemon_not_configured' || errCode === 'daemon_unreachable') return page(h(Onboarding, { code: errCode, onDone: () => void load(true) }))
      if (!data) return page(h('div', { style: { fontSize: 13, color: err ? C.err : C.sub, padding: '8px 0' } }, err || L('加载中…', 'Loading…')))
      return page([
        err ? h('div', { key: 'err', style: { fontSize: 12, color: C.err, marginBottom: 12 } }, err) : null,
        h(ModelsSection, { key: 'models', sources: data.sources, stats: data.stats, reload: () => load(false), openPanel: () => openPanel.current?.() }),
        h(KeysSection, { key: 'keys', info: data.keys, endpoints: data.endpoints, reload: () => load(false) }),
        h(ServiceSection, { key: 'service', service: data.service, reload: load }),
        h(FullFeaturesCard, { key: 'full', openRef: openPanel }),
      ])
    }

    const name = 'dsh-cpamc'
    // 用到的服务必须先声明，否则 ctx.slots 读不到
    const inject = ['slots']
    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-cpamc', order: 25, label: () => 'dsh-cpamc' }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-cpamc] 设置页注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { until, pct, ms, statusOf, newer, Header, ModelsSection, KeysSection, ServiceSection, FullFeaturesCard, Onboarding, SelfProgress, SettingsSection } }
    return module.exports
  },
})
