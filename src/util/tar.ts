// util/tar.ts — 读 npm 包（.tgz）：在内存里解开，按文件名取内容。只认普通文件，够用于我们自己发布的资源包

import { gunzipSync } from 'node:zlib'

export function readTgz(buf: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(buf)
  const out = new Map<string, Buffer>()
  let p = 0
  let longName: string | null = null
  while (p + 512 <= tar.length) {
    const header = tar.subarray(p, p + 512)
    if (header.every((b) => b === 0)) break
    const field = (from: number, len: number) => header.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = field(345, 155)
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const body = tar.subarray(p + 512, p + 512 + size)
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '')
    else if (type === '0' || type === '\0') out.set(name, Buffer.from(body))
    p += 512 + Math.ceil(size / 512) * 512
  }
  return out
}
