// util/redact.ts — key 脱敏：只露前缀和后 4 位

export function redactKey(key: string): string {
  if (key.length <= 12) return '****'
  const prefix = key.startsWith('dshc_') ? 'dshc_' : key.slice(0, 4)
  return `${prefix}…${key.slice(-4)}`
}
