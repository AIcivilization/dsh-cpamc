// util/loopback.ts — 本机 HTTP 接口的来源校验：Host 必须是回环（挡 DNS rebinding），浏览器带来的 Origin 也必须是回环

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 去掉 Host 里的端口（认得 [IPv6]:port；不带括号的 IPv6 不截） */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? h : h.slice(0, end + 1)
  }
  const colon = h.lastIndexOf(':')
  if (colon !== -1 && !h.slice(0, colon).includes(':') && /^\d+$/.test(h.slice(colon + 1))) return h.slice(0, colon)
  return h
}

export function hostIsLoopback(host: string | undefined): boolean {
  return Boolean(host?.trim()) && LOOPBACK.has(hostnameOf(host!))
}

/** 没有 Origin（非浏览器调用）放行；有就必须是回环 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (!origin?.trim()) return true
  try {
    return LOOPBACK.has(new URL(origin).hostname)
  } catch {
    return false
  }
}
