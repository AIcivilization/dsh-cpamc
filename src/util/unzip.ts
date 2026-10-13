// util/unzip.ts — 解压 zip（渠道插件包是 zip；Linux 的 GNU tar 读不了 zip，也不想依赖系统装了 unzip）
//
// 只支持 store 与 deflate 两种压缩方式，够用于发布包。按中央目录读，拒绝带 .. 或绝对路径的条目。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CEN = 0x02014b50
const LOC = 0x04034b50

export interface ZipEntry {
  name: string
  data: Buffer
}

export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error('corrupt zip central directory')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (buf.readUInt32LE(local) !== LOC) throw new Error(`corrupt zip entry: ${name}`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    if (method === 0) out.push({ name, data: Buffer.from(raw) })
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) })
    else throw new Error(`unsupported zip compression method ${method}: ${name}`)
  }
  return out
}

/** 解到 dest；条目路径必须留在 dest 里面 */
export async function extractZip(buf: Buffer, dest: string): Promise<string[]> {
  const names: string[] = []
  for (const e of readZip(buf)) {
    const rel = normalize(e.name)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`unsafe path in zip: ${e.name}`)
    const file = join(dest, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, e.data, { mode: 0o755 })
    names.push(rel)
  }
  return names
}
