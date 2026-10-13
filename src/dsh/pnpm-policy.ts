// dsh/pnpm-policy.ts — 绕过 pnpm 例外名单的一个坑
//
// dsh 的插件管理用 pnpm 11，它不信刚发布不到一天的包；装包时会把点名的版本追加进 profile 的
// pnpm-workspace.yaml 的 minimumReleaseAgeExclude。但它每次追加新的一行，而同一个包只认第一行：
//   - dshmarket@1.66.18
//   - dshmarket@1.66.20     ← 不生效
// 之后往这个 profile 装任何插件，锁文件检查都会因为 dshmarket@1.66.20 失败（用户的 profile 复现，2026-10-13）。
// 合成一行 dshmarket@1.66.18 || 1.66.20 就好。这里只做这一件事：合并同名的多行，其余一字不动，改之前先备份。

import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML, { isScalar, isSeq } from 'yaml'
import { atomicWrite, timestamp } from '../util/fs.js'

const KEY = 'minimumReleaseAgeExclude'

/** "name@1.2.3 || 1.2.4" → { name, versions }；不是这种形状（例如通配）就返回 null，不动它 */
function parse(entry: string): { name: string; versions: string[] } | null {
  const m = /^((?:@[^/\s@]+\/)?[^@\s]+)@(.+)$/.exec(entry.trim())
  if (!m) return null
  const versions = m[2]!.split('||').map((v) => v.trim()).filter(Boolean)
  if (!versions.length || versions.some((v) => !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v))) return null
  return { name: m[1]!, versions }
}

/** 合并同名条目；返回新列表与是否有变化 */
export function mergeExcludes(list: string[]): { list: string[]; changed: boolean } {
  const out: string[] = []
  const at = new Map<string, number>()
  let changed = false
  for (const entry of list) {
    const p = parse(entry)
    if (!p) {
      out.push(entry)
      continue
    }
    const i = at.get(p.name)
    if (i === undefined) {
      at.set(p.name, out.length)
      out.push(entry)
      continue
    }
    const prev = parse(out[i]!)!
    const versions = [...new Set([...prev.versions, ...p.versions])]
    out[i] = `${p.name}@${versions.join(' || ')}`
    changed = true
  }
  return { list: out, changed }
}

/** 修 profile 的 pnpm-workspace.yaml；返回备份文件路径（没改就是 null） */
export async function fixReleaseAgeExcludes(profileDir: string, backupsDir: string): Promise<string | null> {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const doc = YAML.parseDocument(text)
  const seq = doc.get(KEY, true)
  if (doc.errors.length || !isSeq(seq)) return null
  const entries = seq.items.map((i) => (isScalar(i) ? String(i.value) : null))
  if (entries.some((e) => e === null)) return null
  const { list, changed } = mergeExcludes(entries as string[])
  if (!changed) return null
  const backup = join(backupsDir, `pnpm-workspace.yaml.${timestamp()}`)
  await copyFile(file, backup)
  doc.set(KEY, doc.createNode(list))
  await atomicWrite(file, doc.toString(), { mode: 0o644 })
  return backup
}
