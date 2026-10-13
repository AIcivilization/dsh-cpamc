import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fetchComponent, forgetPacks, type NpmAssets } from '../../src/engine/sources.js'
import { readTgz } from '../../src/util/tar.js'

/** 造一个最小的 npm tgz（ustar） */
function tgz(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = []
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512)
    h.write(name, 0)
    h.write('0000644\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h.write('0', 156)
    h.write('ustar\0', 257)
    h.write('00', 263)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const engine = Buffer.from('engine-bytes')
const plugins = Buffer.from('plugins-bytes')

describe('component sources', () => {
  let hits: string[] = []
  let mirror = ''
  let github = ''
  let servers: ReturnType<typeof createServer>[] = []
  let pack = tgz({ 'package/engine.tar.gz': engine, 'package/plugins.zip': plugins, 'package/LICENSE': Buffer.from('MIT') })
  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<string>((resolve) => {
      const s = createServer(handler)
      servers.push(s)
      s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`))
    })
  beforeAll(async () => {
    mirror = await listen((req, res) => {
      hits.push(`mirror ${req.url}`)
      if (req.url === '/dsh-cpamc-assets-darwin-arm64/-/dsh-cpamc-assets-darwin-arm64-1.0.0.tgz') return res.writeHead(200, { 'content-length': pack.length }).end(pack)
      res.writeHead(404).end()
    })
    github = await listen((req, res) => {
      hits.push(`github ${req.url}`)
      res.writeHead(200).end(req.url === '/engine' ? engine : 'tampered')
    })
  })
  afterAll(() => servers.forEach((s) => s.close()))
  beforeEach(() => {
    hits = []
    forgetPacks()
  })
  const npm = (): NpmAssets => ({ package: 'dsh-cpamc-assets', version: '1.0.0', registries: [mirror], targets: { 'darwin-aarch64': 'darwin-arm64' } })

  it('reads npm tarballs', () => {
    expect([...readTgz(pack).keys()]).toEqual(['package/engine.tar.gz', 'package/plugins.zip', 'package/LICENSE'])
  })

  it('takes every component from one assets package download', async () => {
    const a = await fetchComponent({ file: 'engine.tar.gz', sha256: sha(engine), url: `${github}/engine`, what: 'e', target: 'darwin-aarch64', npm: npm() })
    const b = await fetchComponent({ file: 'plugins.zip', sha256: sha(plugins), url: `${github}/plugins`, what: 'p', target: 'darwin-aarch64', npm: npm() })
    expect([a.toString(), b.toString()]).toEqual(['engine-bytes', 'plugins-bytes'])
    expect(hits).toEqual(['mirror /dsh-cpamc-assets-darwin-arm64/-/dsh-cpamc-assets-darwin-arm64-1.0.0.tgz'])
  })

  it('falls back to the original address when the package is missing or does not match, and still checks sha256', async () => {
    const e = await fetchComponent({ file: 'engine.tar.gz', sha256: sha(engine), url: `${github}/engine`, what: 'e', target: 'linux-amd64', npm: npm() })
    expect(e.toString()).toBe('engine-bytes')
    expect(hits).toEqual(['github /engine'])
    hits = []
    pack = tgz({ 'package/engine.tar.gz': Buffer.from('evil') })
    forgetPacks()
    expect((await fetchComponent({ file: 'engine.tar.gz', sha256: sha(engine), url: `${github}/engine`, what: 'e', target: 'darwin-aarch64', npm: npm() })).toString()).toBe('engine-bytes')
    expect(hits.at(-1)).toBe('github /engine')
    await expect(fetchComponent({ file: 'plugins.zip', sha256: sha(plugins), url: `${github}/plugins`, what: 'p', target: 'darwin-aarch64', npm: npm() })).rejects.toThrow(/checksum|校验/)
  })
})
