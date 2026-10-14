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

    /** 页面是不是在本机打开的（地址是回环）；读不到地址就按本机算 */
    const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1']
    const isLoopbackPage = () => {
      try { return LOOPBACK.includes(window.location.hostname) } catch { return true }
    }
    const pageOrigin = () => { try { return window.location.origin } catch { return '' } }

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

    // —— 插件已更新、但 dsh 还在跑旧代码：页面顶部提示（改写自 dsh-model）——
    async function hostCall(body, retried) {
      const r = await fetch('/api-dsh-cpamc/host', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-cpamc-token': token }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      if (r.status === 403 && !retried && j?.error?.code === 'refused') {
        await refreshToken()
        return hostCall(body, true)
      }
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`)
      return j
    }

    function RestartBanner({ host }) {
      const [state, setState] = useState('')
      if (!host || !host.installed || !host.running || host.installed === host.running) return null
      const restart = async () => {
        if (!window.confirm(L('重启 dsh？正在进行的对话会中断，重启后自动恢复。', 'Restart dsh? Ongoing conversations are interrupted and resume after the restart.'))) return
        setState('restarting')
        try {
          await hostCall({ action: 'restart' })
        } catch (e) {
          setState(e.message)
        }
      }
      return h('div', { style: { ...S.card, padding: '10px 14px', marginBottom: 16, borderColor: C.warn } },
        h('div', { style: S.line },
          h('span', { style: { ...S.grow, fontSize: 13, color: C.text } },
            L(`dsh-cpamc 已更新到 v${host.installed}，但 dsh 还在运行 v${host.running} 的代码，重启 dsh 后生效。`, `dsh-cpamc was updated to v${host.installed}, but dsh is still running v${host.running}; restart dsh to apply it. `),
            host.restart !== 'desktop' ? h('span', { style: { color: C.sub } }, L('请重启 dsh（桌面版请完全退出再打开，Windows 上连同右下角托盘图标；服务器上请重启运行 dsh 的服务）。', 'Please restart dsh (desktop: quit completely and reopen, on Windows including the tray icon; on a server, restart the service that runs dsh).')) : null),
          host.restart === 'desktop' ? h('button', { type: 'button', style: S.btnPrimary, disabled: state === 'restarting', onClick: () => void restart() }, state === 'restarting' ? L('正在重启…', 'Restarting…') : L('重启 dsh', 'Restart dsh')) : null),
        state && state !== 'restarting' ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, state) : null)
    }

    // —— 页眉（R7）——
    /** a 是否比 b 新（语义化版本：正式版 > 预发布版，alpha.6 > alpha.3；与命令行的 compareVersions 同一规则） */
    const newer = (a, b) => {
      const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim())
        return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : { core: [0, 0, 0], pre: [] }
      }
      const x = parse(a)
      const y = parse(b)
      for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i]
      if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0
      for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i]
        const q = y.pre[i]
        if (p === undefined) return false
        if (q === undefined) return true
        if (p === q) continue
        const pn = /^\d+$/.test(p)
        const qn = /^\d+$/.test(q)
        if (pn && qn) return +p > +q
        if (pn !== qn) return !pn
        return p > q
      }
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

    /** 签到一行：今天签了没（连续几天）+「签到」按钮 */
    function CheckinLine({ status, reload }) {
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      if (!status) return null
      const go = async () => {
        setBusy(true); setMsg('')
        try {
          const r = await api('POST', `/checkin/${status.source}`)
          setMsg(r.reward ? L(`签到成功：${r.reward}`, `Checked in: ${r.reward}`) : L('签到成功', 'Checked in'))
          await reload()
        } catch (e) { setMsg(e.message) } finally { setBusy(false) }
      }
      const done = status.checkedToday === true
      const text = done
        ? L(`今天已签到${status.streakDays ? `（连续 ${status.streakDays} 天）` : ''}`, `Checked in today${status.streakDays ? ` (${status.streakDays}-day streak)` : ''}`)
        : status.checkedToday === false ? L('今天还没签到', 'Not checked in today') : L('今天的签到状态暂时查不到', 'Today\'s check-in status is unavailable')
      return h('div', { style: { ...S.line, minHeight: 22, paddingLeft: 46, marginTop: 2, fontSize: 12, color: done ? C.ok : C.sub } },
        h('span', null, text),
        !done ? h('button', { type: 'button', style: { ...S.btn, padding: '1px 8px' }, disabled: busy, onClick: go }, busy ? L('签到中…', 'Checking in…') : L('签到', 'Check in')) : null,
        msg ? h('span', { style: { color: C.sub } }, msg) : null)
    }

    /** 勾选这个来源的哪些模型显示在 dsh 里（引擎照常提供全部） */
    function ModelPicker({ source, onClose }) {
      const [data, setData] = useState(null)
      const [sel, setSel] = useState(new Set())
      const [q, setQ] = useState('')
      const [msg, setMsg] = useState('')
      const [saving, setSaving] = useState(false)
      const [tests, setTests] = useState({})
      const test = async (id) => {
        setTests((t) => ({ ...t, [id]: { running: true } }))
        try {
          const r = await api('POST', '/models/test', { model: id })
          setTests((t) => ({ ...t, [id]: r }))
        } catch (e) {
          setTests((t) => ({ ...t, [id]: { ok: false, advice: e.message } }))
        }
      }
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
          m.recommended ? h('span', { title: L('免费额度，已在你的账号上实测调通', 'Free quota, tested OK on your account'), style: { fontSize: 11, color: C.accent } }, L('默认', 'Default')) : null,
          tests[m.id] ? h('span', { style: { fontSize: 11, color: tests[m.id].running ? C.sub : tests[m.id].ok ? C.ok : C.err, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: tests[m.id].message || tests[m.id].reply || '' },
            tests[m.id].running ? L('测试中…', 'Testing…') : tests[m.id].ok ? L(`可用 · ${(tests[m.id].ms / 1000).toFixed(1)} 秒${tests[m.id].reply ? ` · ${tests[m.id].reply}` : ''}`, `OK · ${(tests[m.id].ms / 1000).toFixed(1)}s${tests[m.id].reply ? ` · ${tests[m.id].reply}` : ''}`) : (tests[m.id].advice || L('不可用', 'Not working'))) : null,
          h('button', { type: 'button', title: L('发一句很短的话试试（会用掉一点点额度）', 'Send one short message to try it (uses a tiny bit of quota)'), style: { ...S.btn, padding: '2px 8px' }, disabled: tests[m.id]?.running, onClick: (e) => { e.preventDefault(); void test(m.id) } }, L('测一下', 'Test'))))),
        msg ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, msg) : null,
        h('div', { style: { ...S.line, marginTop: 8 } },
          h('button', { type: 'button', style: S.btnPrimary, disabled: saving, onClick: () => save([...sel]) }, saving ? L('保存中…', 'Saving…') : L('保存', 'Save')),
          h('button', { type: 'button', style: S.btn, disabled: saving, onClick: () => save(null) }, L('恢复默认', 'Use default')),
          h('button', { type: 'button', style: S.btn, onClick: () => setSel(new Set(data.models.map((m) => m.id))) }, L('全选', 'All')),
          h('button', { type: 'button', style: S.btn, onClick: () => setSel(new Set()) }, L('全不选', 'None')),
          h('span', { style: S.grow }),
          h('button', { type: 'button', style: S.btn, onClick: () => onClose(false) }, L('取消', 'Cancel'))))
    }

    function ModelsSection({ sources, stats, checkin, reload, openPanel }) {
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
            s.loggedIn ? h(CheckinLine, { status: checkin?.sources?.find((c) => c.source === s.id), reload }) : null,
            s.loggedIn ? h(Usage, { usage: s.usage, subscribeUrl: s.subscribeUrl }) : null,
            !s.loggedIn ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4 } },
              L(s.pricing.zh, s.pricing.en),
              s.subscribeUrl && s.pricing.tier !== 'free' ? h('a', { href: s.subscribeUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent, marginLeft: 8 } }, L('看套餐 ↗', 'Plans ↗')) : null) : null,
            s.loggedIn && s.detail ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4, color: C.warn } }, s.detail) : null)
        })))
    }

    /** 最近 24 小时失败的请求：哪个模型、为什么、该怎么办（只有出过错才显示；改写自 dsh-model） */
    function FailuresCard({ failures }) {
      const [all, setAll] = useState(false)
      if (!failures || !failures.length) return null
      const color = (k) => (k === 'rate' || k === 'upstream' ? C.warn : C.err)
      const shown = all ? failures : failures.slice(0, 5)
      return h('div', { style: S.section },
        h('div', { style: S.h }, L(`最近失败（24 小时内 ${failures.length} 次）`, `Recent failures (${failures.length} in 24 hours)`)),
        h('p', { style: S.note }, L('经模型服务失败的请求。只记录模型和报错，不记录对话内容。', 'Requests that failed through the model service. Only the model and the error are kept, never the conversation.')),
        h('div', { style: S.card }, shown.map((f, i) => h('div', { key: `${f.at}-${i}`, style: i ? S.row : S.rowFirst },
          h('div', { style: S.line },
            h('span', { style: { ...S.label, ...S.mono, ...S.grow, fontSize: 13 } }, f.model || L('（未知模型）', '(unknown model)')),
            h('span', { style: { fontSize: 12, color: color(f.kind) } }, `HTTP ${f.status}`),
            h('span', { style: S.meta }, ago(f.at))),
          h('div', { style: { fontSize: 13, color: color(f.kind), marginTop: 2 } }, f.advice),
          f.message ? h('div', { style: { ...S.meta, ...S.mono, marginTop: 2, wordBreak: 'break-all' } }, f.message) : null))),
        failures.length > 5 ? h('button', { type: 'button', style: { ...S.btn, marginTop: 8 }, onClick: () => setAll(!all) }, all ? L('收起', 'Show less') : L(`全部 ${failures.length} 条`, `All ${failures.length}`)) : null)
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
      // 其他设备的地址：dsh-cpamc 自己的 HTTPS 端口（服务器上默认开）优先；远程浏览器里另外列出经 dsh 网址的那条
      const remote = !isLoopbackPage()
      const viaDsh = remote ? `${pageOrigin()}/dsh-cpamc/v1` : null
      const tls = endpoints?.tls
      const portNote = tls
        ? tls.source === 'reuse'
          ? L(`你的电脑、手机或其他软件用这个，只认 API key。证书：复用服务器上已有的正规证书（${String(tls.issuer || '').split(',')[0]}，${String(tls.notAfter || '').slice(0, 10)} 到期，每天自动同步）`, `Use this from your computer, phone or other tools; only the API key is checked. Certificate: the server's existing one (${String(tls.issuer || '').split(',')[0]}, expires ${String(tls.notAfter || '').slice(0, 10)}, synced daily)`)
          : L(`你的电脑、手机或其他软件用这个，只认 API key。证书是自签的：软件里要先信任它（或关闭证书校验），指纹 ${tls.fingerprint}`, `Use this from your computer, phone or other tools; only the API key is checked. The certificate is self-signed: trust it in the software first (or turn off certificate checks); fingerprint ${tls.fingerprint}`)
        : L('你的电脑、手机或其他软件用这个，只认 API key', 'Use this from your computer, phone or other tools; only the API key is checked')
      const addrs = endpoints ? [
        ...(endpoints.public ? [{ id: 'public', name: L('外部地址', 'Public'), url: endpoints.public, note: portNote, warn: endpoints.listening === false ? L('端口还没有开始监听：守护进程半分钟内会开；一直没开就在「服务」里点「修复」', 'The port is not listening yet: the daemon opens it within half a minute; if it never does, press Repair under Service') : '' }] : []),
        ...(viaDsh ? [{ id: 'via-dsh', name: endpoints.public ? L('经 dsh 网址', 'Via dsh') : L('外部地址', 'Public'), url: viaDsh, note: L('经 dsh 自己的网址，只认 API key。如果 dsh 前面的网关要求先登录，外部软件会被挡在网关外——那就用上面那个地址', 'Through dsh\'s own address; only the API key is checked. If a gateway in front of dsh requires sign-in, outside tools are stopped there — use the address above instead') }] : []),
        { id: 'local', name: L('本机地址', 'Local'), url: endpoints.local, note: remote ? L('只在这台服务器上能用（dsh 自己用的就是它）', 'Only works on this server (dsh itself uses it)') : L('只在这台电脑上能用', 'Only works on this computer') },
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
          h('div', { style: { ...S.meta, paddingLeft: 82, wordBreak: 'break-all' } }, r.note),
          r.warn ? h('div', { style: { ...S.meta, paddingLeft: 82, color: C.warn } }, r.warn) : null))) : null,
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
    function ServiceSection({ service, checkin, reload }) {
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      // Hook 必须在提前返回之前调用（每次渲染数量一致）
      const repairJob = useSetupJob(() => void reload(true))
      if (!service) return null
      const e = service.engine
      const restart = async () => {
        setBusy('restart'); setMsg('')
        try { const r = await api('POST', '/service/restart'); setMsg(r.running ? L('已重启', 'Restarted') : L('重启后没有起来，查看日志：dsh-cpamc logs', 'Did not come back after restart; check: dsh-cpamc logs')); await reload(true) } catch (x) { setMsg(x.message) } finally { setBusy('') }
      }
      const repair = () => { setMsg(''); void repairJob.start('repair') }
      const row = (label, value, color) => h('div', { style: { ...S.line, minHeight: 26 } }, h('span', { style: { ...S.meta, width: 110, flex: 'none' } }, label), h('span', { style: { fontSize: 13, color: color || C.text } }, value))
      return h('div', { style: S.section },
        h('div', { style: S.h }, L('服务', 'Service')),
        h('div', { style: { ...S.card, padding: '10px 14px' } },
          row(L('模型服务', 'Model service'), e.running ? L(`运行中 · 127.0.0.1:${e.port}`, `Running · 127.0.0.1:${e.port}`) : L('没有运行（点「修复」）', 'Not running (press Repair)'), e.running ? C.ok : C.err),
          row(L('服务版本', 'Service version'), e.version ? `v${e.version}` : '-'),
          row(L('渠道插件', 'Channel plugins'), service.components.plugins ? `v${service.components.plugins}` : '-'),
          row(L('完整管理界面', 'Full interface'), service.components.panel ? `v${service.components.panel}` : '-'),
          checkin ? h('div', { style: { ...S.line, minHeight: 26 } },
            h('span', { style: { ...S.meta, width: 110, flex: 'none' } }, L('每日自动签到', 'Daily check-in')),
            h(Switch, { on: checkin.auto, label: L('每日自动签到', 'Daily check-in'), onChange: async (on) => { try { await api('POST', '/checkin/auto', { on }); await reload(false) } catch (e) { setMsg(e.message) } } }),
            h('span', { style: S.meta }, L('WorkBuddy、Trae、Qoder 登录后每天自动签到一次', 'WorkBuddy, Trae and Qoder check in once a day after sign-in'))) : null,
          service.mode === 'vps' ? row(L('部署位置', 'Deployed on'), L('服务器', 'Server')) : null,
          service.mode === 'vps' && service.remote.publicUrl ? row(L('外部地址', 'Public address'), service.remote.publicUrl) : null,
          h('div', { style: { ...S.line, marginTop: 8 } },
            h('button', { type: 'button', style: S.btn, disabled: Boolean(busy), onClick: () => void reload(true) }, L('重新检查', 'Check again')),
            service.canRestart ? h('button', { type: 'button', style: S.btn, disabled: Boolean(busy), onClick: restart }, busy === 'restart' ? L('重启中…', 'Restarting…') : L('重启服务', 'Restart service')) : null,
            h('button', { type: 'button', style: S.btn, disabled: Boolean(busy) || repairJob.running, onClick: repair }, repairJob.running ? L('修复中…', 'Repairing…') : L('修复', 'Repair')),
            msg ? h('span', { style: S.meta }, msg) : null),
          repairJob.vps ? h('div', { style: { ...S.meta, marginTop: 6 } }, L('服务器上请在终端执行：sudo dsh-cpamc repair', 'On the server run: sudo dsh-cpamc repair')) : null,
          repairJob.job?.action === 'repair' || repairJob.err ? h(JobLog, { job: repairJob.job, err: repairJob.err }) : null))
    }

    // —— 部署到服务器（设计 §9.1）：在这台电脑上的 dsh 里填表，经 SSH 把 dsh-cpamc 装到已经有 DSH 的服务器 ——
    const DEPLOY_API = '/api/dsh-cpamc.deploy'
    async function deployApi(method, body) {
      const r = await fetch(DEPLOY_API, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      if (r.status === 404) return { unavailable: true }
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      return j
    }

    function DeploySection() {
      const [open, setOpen] = useState(false)
      const [form, setForm] = useState({ host: '', port: '22', user: 'root', password: '', mirror: true })
      const [job, setJob] = useState(null)
      const [version, setVersion] = useState('')
      const [unavailable, setUnavailable] = useState(false)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const poll = useRef(null)
      const refresh = useCallback(async () => {
        try {
          const r = await deployApi('GET')
          if (r.unavailable) { setUnavailable(true); return }
          setVersion(r.version || '')
          setJob(r.job)
          if (r.job?.state === 'running') { clearTimeout(poll.current); poll.current = setTimeout(refresh, 2000) }
        } catch (e) { setErr(e.message) }
      }, [])
      useEffect(() => { if (open) void refresh(); return () => clearTimeout(poll.current) }, [open, refresh])
      const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
      const start = async (action) => {
        if (action === 'uninstall' && !window.confirm(L(`从 ${form.host} 卸载 dsh-cpamc？服务器上的模型服务会停止，那台 DSH 里的 dsh-cpamc 模型会消失。`, `Uninstall dsh-cpamc from ${form.host}? Its model service stops and the dsh-cpamc models disappear from that DSH.`))) return
        setErr(''); setBusy(true)
        try {
          const r = await deployApi('POST', { action, host: form.host.trim(), port: Number(form.port) || 22, user: form.user.trim() || 'root', password: form.password, mirror: form.mirror, lang: isZh() ? 'zh' : 'en' })
          setForm((f) => ({ ...f, password: '' }))
          setJob(r.job)
          clearTimeout(poll.current); poll.current = setTimeout(refresh, 2000)
        } catch (e) { setErr(e.message) } finally { setBusy(false) }
      }
      const running = job?.state === 'running'
      const field = (label, key, extra = {}) => h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: C.sub, minWidth: 0, flex: extra.flex || 1 } }, label,
        h('input', { style: S.input, value: form[key], onChange: set(key), disabled: running, ...extra.input }))
      return h('div', { style: S.section },
        h('div', { style: S.line },
          h('div', { style: { ...S.h, ...S.grow, margin: 0 } }, L('部署到服务器', 'Deploy to a server')),
          h('button', { type: 'button', style: S.btn, onClick: () => setOpen(!open) }, open ? L('收起', 'Hide') : L('展开', 'Show'))),
        h('p', { style: S.note }, L('把 dsh-cpamc 装到一台已经装好 DSH 的服务器上（同一个版本），之后在浏览器里打开那台 DSH → 设置 → dsh-cpamc 管理。密码只用于这一次连接，不保存；不填就用这台电脑上的 SSH 密钥。',
          'Install dsh-cpamc (this same version) on a server that already runs DSH, then manage it from that DSH → Settings → dsh-cpamc in a browser. The password is used for this connection only and never stored; leave it empty to use this computer\'s SSH key.')),
        open ? (unavailable ? h('div', { style: S.meta }, L('这个版本的 DSH 不支持从页面部署。可以在服务器上执行：npm install -g dsh-cpamc && sudo dsh-cpamc setup', 'This DSH version cannot deploy from the page. On the server run: npm install -g dsh-cpamc && sudo dsh-cpamc setup')) : h('div', { style: { ...S.card, padding: '12px 14px' } },
          h('div', { style: { ...S.line, alignItems: 'flex-end' } },
            field(L('服务器地址', 'Server address'), 'host', { flex: 3, input: { placeholder: L('公网 IP 或域名', 'Public IP or domain') } }),
            field(L('SSH 端口', 'SSH port'), 'port', { flex: 1 }),
            field(L('用户名', 'User'), 'user', { flex: 1 }),
            field(L('密码（可留空）', 'Password (optional)'), 'password', { flex: 2, input: { type: 'password', autoComplete: 'off' } })),
          h('label', { style: { ...S.line, fontSize: 12, color: C.sub, marginTop: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: form.mirror, onChange: set('mirror'), disabled: running }), L('服务器在国内：用国内镜像下载 dsh-cpamc', 'Server in mainland China: download dsh-cpamc from the China mirror')),
          h('div', { style: { ...S.line, marginTop: 8 } },
            h('button', { type: 'button', style: S.btnPrimary, disabled: busy || running || !form.host.trim(), onClick: () => void start('install') }, running && job.action === 'install' ? L('部署中…', 'Deploying…') : L(`部署 v${version || '?'} 到这台服务器`, `Deploy v${version || '?'} to this server`)),
            h('button', { type: 'button', style: { ...S.btn, color: C.err }, disabled: busy || running || !form.host.trim(), onClick: () => void start('uninstall') }, L('从这台服务器卸载', 'Uninstall from this server'))),
          err ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, err) : null,
          job ? h('div', { style: { marginTop: 10 } },
            h('div', { style: { fontSize: 12, color: job.state === 'success' ? C.ok : job.state === 'failed' ? C.err : C.sub, marginBottom: 6 } },
              job.state === 'running' ? (job.phase === 'connecting' ? L(`正在连接 ${job.host}…`, `Connecting to ${job.host}…`) : L('服务器上正在执行（可以关掉这一页，任务会在服务器上继续）…', 'Running on the server (you can close this page; it keeps running there)…'))
                : job.state === 'success' ? (job.action === 'install' ? L(`完成：在浏览器里打开 ${job.host} 上的 DSH → 设置 → dsh-cpamc。服务器上的 DSH 要重启一次才会出现这一页。`, `Done: open the DSH on ${job.host} → Settings → dsh-cpamc. Restart that DSH once for the page to appear.`) : L('已从服务器卸载', 'Uninstalled from the server'))
                  : job.error),
            job.lines?.length ? h('pre', { style: { ...S.mono, ...S.card, padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, job.lines.join('\n')) : null) : null)) : null)
    }

    // —— 「全部功能」卡片（R4）——
    const PANEL_PREFIX = '/dsh-cpamc/panel'
    /** 「全部功能」的地址：本机打开 dsh 时直连本机服务；远程浏览器经 dsh 自己的网址（先过 dsh 登录） */
    function panelTarget(endpoints) {
      if (!isLoopbackPage()) return { url: `${pageOrigin()}${PANEL_PREFIX}/management.html`, apiBase: `${pageOrigin()}${PANEL_PREFIX}`, remote: true }
      const local = String(endpoints?.local || '').replace(/\/v1\/?$/, '')
      return local ? { url: `${local}/management.html`, apiBase: local, remote: false } : null
    }

    function FullFeaturesCard({ openRef, endpoints }) {
      const [err, setErr] = useState('')
      const target = panelTarget(endpoints)
      // 点链接时顺手确认服务在跑（服务没起来时会尝试启动）；链接本身是普通链接，不会被浏览器当成弹窗拦掉
      const ensure = async () => {
        setErr('')
        try {
          const r = await api('POST', '/panel/open')
          if (!r.running) setErr(L('模型服务没有起来，先在「服务」里点「修复」，再打开。', 'The model service is not running; press Repair under Service, then open it again.'))
        } catch (e) {
          setErr(e.message)
        }
      }
      useEffect(() => { if (openRef) openRef.current = () => { void ensure(); if (target) { try { window.open(target.url, '_blank', 'noopener') } catch { /* 拦截了就让用户点链接 */ } } } })
      return h('div', { style: S.section },
        h('div', { style: { ...S.card, padding: '14px 16px' } },
          h('div', { style: S.line },
            h('div', { style: S.grow },
              h('div', { style: S.label }, L('全部功能', 'All features')),
              h('div', { style: { ...S.meta, marginTop: 2 } }, L('需要登录来源账号、修改完整配置、调整路由或查看详细日志？打开原版完整管理界面，它管理的就是为 dsh 提供模型的这个服务。',
                'Need to sign in to sources, change the full configuration, adjust routing or read detailed logs? Open the original full management interface; it manages the very service that provides dsh\'s models.'))),
            target
              ? h('a', { href: target.url, target: '_blank', rel: 'noopener noreferrer', onClick: () => void ensure(), style: { ...S.btnPrimary, textDecoration: 'none', display: 'inline-block' } }, L('全部功能', 'All features'))
              : h('span', { style: S.meta }, L('服务地址还没读到', 'Service address not available yet'))),
          h('div', { style: { ...S.line, marginTop: 10 } },
            h('span', { style: { ...S.meta, ...S.grow } }, L('打开后在登录页填入管理密钥：点右边复制（不会显示出来，30 秒后自动从剪贴板清除）。', 'On its sign-in page, paste the management key: copy it with the button on the right (never displayed; cleared from the clipboard after 30 seconds).')),
            h(CopyButton, { get: async () => (await api('POST', '/panel/key')).key, label: L('复制登录密钥', 'Copy sign-in key'), clearAfter: 30_000 })),
          target?.remote ? h('div', { style: { ...S.meta, marginTop: 8 } },
            L('如果登录页提示连不上服务，勾选「自定义连接地址」，填入：', 'If the sign-in page cannot reach the service, tick "custom connection address" and enter:'),
            h('div', { style: { ...S.line, marginTop: 4 } }, h('code', { style: { ...S.mono, ...S.grow } }, target.apiBase), h(CopyButton, { get: target.apiBase }))) : null,
          err ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, err) : null))
    }

    // —— 一键准备 / 修复：后台任务，轮询进度（宿主端 /api-dsh-cpamc/setup）——
    async function setupCall(body) {
      const once = () => fetch('/api-dsh-cpamc/setup', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-cpamc-token': token }, body: JSON.stringify({ ...body, lang: isZh() ? 'zh' : 'en' }) })
      let r = await once()
      let j = await r.json().catch(() => ({}))
      if (r.status === 403 && j?.error?.code === 'refused') {
        await refreshToken()
        r = await once()
        j = await r.json().catch(() => ({}))
      }
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`)
      return j
    }

    /** 跑 setup / repair 并跟进度：start(action)；job 为当前任务（state: running / success / failed） */
    function useSetupJob(onSuccess) {
      const [job, setJob] = useState(null)
      const [vps, setVps] = useState(false)
      const [err, setErr] = useState('')
      const timer = useRef(null)
      const misses = useRef(0)
      const poll = useCallback(async () => {
        clearTimeout(timer.current)
        try {
          const r = await setupCall({ action: 'status' })
          misses.current = 0
          setJob(r.job)
          if (r.job?.state === 'running') timer.current = setTimeout(poll, 1500)
          else if (r.job?.state === 'success') onSuccess?.()
        } catch (e) {
          // dsh 重启、网络抖一下：多试几次再报错
          if (++misses.current < 8) timer.current = setTimeout(poll, 3000)
          else setErr(L(`查不到进度：${e.message}`, `Cannot read progress: ${e.message}`))
        }
      }, [])
      useEffect(() => { void poll(); return () => clearTimeout(timer.current) }, [poll])
      const start = async (action) => {
        setErr('')
        try {
          const r = await setupCall({ action })
          if (r.vps) { setVps(true); return }
          setJob(r.job)
          clearTimeout(timer.current)
          timer.current = setTimeout(poll, 1500)
        } catch (e) {
          setErr(e.message)
        }
      }
      return { job, vps, err, start, running: job?.state === 'running' }
    }

    function JobLog({ job, err }) {
      const ref = useRef(null)
      useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight })
      if (!job && !err) return null
      const secs = job ? Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000) : 0
      const head = err ? err
        : job.state === 'running' ? L(`进行中… 已用 ${secs} 秒（下载经代理时可能要几分钟，可以离开这一页，回来还能看到进度）`, `Running… ${secs}s so far (downloads through a proxy can take minutes; you can leave and come back)`)
          : job.state === 'success' ? L('完成，正在加载…', 'Done, loading…')
            : L(`没有完成（退出码 ${job.code}），输出如下：`, `Did not finish (exit code ${job.code}); output:`)
      return h('div', { style: { marginTop: 12 } },
        h('div', { style: { fontSize: 12, color: err || job?.state === 'failed' ? C.err : job?.state === 'success' ? C.ok : C.sub, marginBottom: 6 } }, head),
        job?.output ? h('pre', { ref, style: { ...S.mono, ...S.card, padding: 10, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, job.output) : null)
    }

    /** 守护进程还没装 / 没在运行：说明 + 一键安装（本机）或命令（VPS 上要 root） */
    function Onboarding({ code, onDone }) {
      const notInstalled = code === 'daemon_not_configured'
      const action = notInstalled ? 'setup' : 'repair'
      const { job, vps, err, start, running } = useSetupJob(() => setTimeout(onDone, 1500))
      const busy = running
      const run = () => void start(action)
      const res = vps ? { vps: true } : null
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
        !vps ? h(JobLog, { job, err }) : null)
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
      const [host, setHost] = useState(null)
      const alive = useRef(true)
      const openPanel = useRef(null)
      const load = useCallback(async (refresh) => {
        try {
          const [sources, keys, stats, endpoints, service, checkin, failures] = await Promise.all([
            api('GET', refresh ? '/sources?refresh=1' : '/sources'),
            api('GET', '/keys-info'),
            api('GET', '/stats'),
            api('GET', '/endpoints').catch(() => null),
            api('GET', '/service').catch(() => null),
            api('GET', '/checkin').catch(() => null),
            api('GET', '/failures').catch(() => null),
          ])
          if (alive.current) { setData({ sources, keys, stats, endpoints, service, checkin, failures }); setErr(''); setErrCode('') }
        } catch (e) {
          if (alive.current) { setErr(e.hint ? `${e.message}（${e.hint}）` : e.message); setErrCode(e.code || '') }
        }
      }, [])
      useEffect(() => {
        let stop = false
        const check = () => hostCall({}).then((r) => { if (!stop) setHost(r) }, () => {})
        void check()
        const t = setInterval(check, 60_000)
        return () => { stop = true; clearInterval(t) }
      }, [])
      useEffect(() => {
        alive.current = true
        void load(true)
        api('GET', '/self').then((r) => alive.current && setSelf(r), () => {})
        const t = setInterval(() => void load(false), 15000)
        return () => { alive.current = false; clearInterval(t) }
      }, [load])
      const page = (children) => h('div', { style: { color: C.text, maxWidth: 860 } }, h(Header, { self, onJob: setSelfJob }), h(RestartBanner, { host }), children)
      if (selfJob) return page(h(SelfProgress, { job: selfJob, onDone: () => { setSelfJob(null); void load(true) } }))
      if (errCode === 'daemon_not_configured' || errCode === 'daemon_unreachable') return page(h(Onboarding, { code: errCode, onDone: () => void load(true) }))
      if (!data) return page(h('div', { style: { fontSize: 13, color: err ? C.err : C.sub, padding: '8px 0' } }, err || L('加载中…', 'Loading…')))
      return page([
        err ? h('div', { key: 'err', style: { fontSize: 12, color: C.err, marginBottom: 12 } }, err) : null,
        h(ModelsSection, { key: 'models', sources: data.sources, stats: data.stats, checkin: data.checkin, reload: () => load(false), openPanel: () => openPanel.current?.() }),
        h(FailuresCard, { key: 'failures', failures: data.failures }),
        h(KeysSection, { key: 'keys', info: data.keys, endpoints: data.endpoints, reload: () => load(false) }),
        h(ServiceSection, { key: 'service', service: data.service, checkin: data.checkin, reload: load }),
        isLoopbackPage() ? h(DeploySection, { key: 'deploy' }) : null,
        h(FullFeaturesCard, { key: 'full', openRef: openPanel, endpoints: data.endpoints }),
      ])
    }

    /** 这一页渲染出错时只在这一页显示原因，不连累 dsh 的设置窗口（白屏、别的设置页打不开） */
    // 宿主的 React 没有 Component（不该发生）时退回不带保护的页面，也不能在加载时就崩
    const Boundary = typeof React.Component !== 'function' ? null : class extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        console.warn('[dsh-cpamc] settings page crashed', error)
      }
      render() {
        if (!this.state.error) return this.props.children
        const msg = String(this.state.error?.stack || this.state.error?.message || this.state.error).slice(0, 1500)
        return h('div', { style: { color: C.text, maxWidth: 860 } },
          h('div', { style: S.h }, 'dsh-cpamc'),
          h('p', { style: { ...S.note, color: C.err } }, L('这一页显示出错了（dsh 的其他功能不受影响）。把下面的信息发给开发者，或点「重试」。', 'This page failed to render (the rest of dsh is unaffected). Send the details below to the developer, or press Retry.')),
          h('pre', { style: { ...S.mono, ...S.card, padding: 10, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', margin: '0 0 10px' } }, msg),
          h('button', { type: 'button', style: S.btn, onClick: () => this.setState({ error: null }) }, L('重试', 'Retry')))
      }
    }
    const SafeSettingsSection = Boundary ? () => h(Boundary, null, h(SettingsSection)) : SettingsSection

    const name = 'dsh-cpamc'
    // 用到的服务必须先声明，否则 ctx.slots 读不到
    const inject = ['slots']
    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-cpamc', order: 25, label: () => 'dsh-cpamc' }, SafeSettingsSection))
      } catch (error) {
        console.warn('[dsh-cpamc] 设置页注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { RestartBanner, CheckinLine, FailuresCard, until, pct, ms, statusOf, newer, Boundary, panelTarget, Header, ModelsSection, KeysSection, ServiceSection, FullFeaturesCard, Onboarding, SelfProgress, SettingsSection, DeploySection } }
    return module.exports
  },
})
