import { deflateRawSync } from 'node:zlib'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { applyOwned, engineApiKeys, initialDoc, keyHash, mergeApiKeys, reconcileRemovedKeys, type OwnedInput } from '../../src/engine/config.js'
import { addKey, revokeKey, type KeyStore } from '../../src/keys.js'
import { extractZip, readZip } from '../../src/util/unzip.js'

function input(keys: KeyStore, extra: Partial<OwnedInput> = {}): OwnedInput {
  return { port: 8317, mgmtSecret: 'dshg_secret', authDir: '/h/auth', pluginsDir: '/h/engine/plugins/0.8.68', keys, ...extra }
}

describe('engine config ownership', () => {
  it('initial config enables the control panel without auto-update and the four channel plugins', () => {
    const keys: KeyStore = { keys: [] }
    const k = addKey(keys, 'dsh').key
    const doc = initialDoc(input(keys))
    applyOwned(doc, input(keys))
    const o = YAML.parse(doc.toString())
    expect(o['config-version']).toBe(8)
    expect(o.server).toEqual({ host: '127.0.0.1', port: 8317 })
    expect(o.management).toMatchObject({ 'allow-remote': false, 'secret-key': 'dshg_secret', 'disable-control-panel': false, 'disable-auto-update-panel': true })
    expect(o.access['api-keys']).toEqual([k])
    expect(o.plugins).toMatchObject({ enabled: true, dir: '/h/engine/plugins/0.8.68' })
    expect(Object.keys(o.plugins.configs)).toEqual(['workbuddy', 'trae', 'qoder', 'zcode'])
    expect(o.observability.usage['usage-statistics-enabled']).toBe(true)
  })

  it('keeps what the management interface changed and only fixes our own keys', () => {
    const keys: KeyStore = { keys: [] }
    const dsh = addKey(keys, 'dsh').key
    const text = `# user note
config-version: 8
server:
    host: 0.0.0.0
    port: 9999
routing:
    strategy: round-robin
access:
    api-keys:
        - user-added-in-panel
management:
    secret-key: old
    disable-control-panel: true
plugins:
    configs:
        trae:
            enabled: false
            login_region: intl
        mimo:
            enabled: true
openai-compatibility:
    - name: mine
`
    const doc = YAML.parseDocument(text)
    applyOwned(doc, input(keys))
    const out = doc.toString()
    const o = YAML.parse(out)
    expect(out).toContain('# user note')
    expect(o.server).toEqual({ host: '127.0.0.1', port: 8317 })
    expect(o.routing.strategy).toBe('round-robin')
    expect(o['openai-compatibility']).toEqual([{ name: 'mine' }])
    expect(o.access['api-keys']).toEqual(['user-added-in-panel', dsh])
    expect(o.management['secret-key']).toBe('dshg_secret')
    expect(o.management['disable-control-panel']).toBe(false)
    expect(o.plugins.configs.trae).toEqual({ enabled: true, login_region: 'intl' })
    expect(o.plugins.configs.mimo).toEqual({ enabled: true })
  })

  it('touches the proxy only when dsh-cpamc changed it', () => {
    const keys: KeyStore = { keys: [] }
    addKey(keys, 'dsh')
    const doc = YAML.parseDocument('requests:\n  proxy-url: http://set-in-panel:1\n')
    applyOwned(doc, input(keys))
    expect(YAML.parse(doc.toString()).requests['proxy-url']).toBe('http://set-in-panel:1')
    applyOwned(doc, input(keys, { proxy: 'http://127.0.0.1:7890' }))
    expect(YAML.parse(doc.toString()).requests['proxy-url']).toBe('http://127.0.0.1:7890')
    applyOwned(doc, input(keys, { proxy: null }))
    expect(YAML.parse(doc.toString()).requests['proxy-url']).toBeUndefined()
  })

  it('merges api keys: revoked ones of ours go away, others stay', () => {
    const keys: KeyStore = { keys: [] }
    const a = addKey(keys, 'dsh').key
    const b = addKey(keys, 'laptop').key
    revokeKey(keys, 'laptop')
    expect(mergeApiKeys(['foreign', b, a], keys)).toEqual(['foreign', a])
  })

  it('a key deleted in the management interface is revoked locally, except the dsh key', () => {
    const keys: KeyStore = { keys: [] }
    const dsh = addKey(keys, 'dsh').key
    const laptop = addKey(keys, 'laptop').key
    const phone = addKey(keys, 'phone').key
    const lastWritten = [dsh, laptop].map(keyHash)
    // 引擎里只剩 phone：laptop 是在管理界面里删的；dsh 也被删了但要写回；phone 是刚加的还没写过
    const revoked = reconcileRemovedKeys([phone], keys, lastWritten)
    expect(revoked).toEqual(['laptop'])
    expect(keys.keys.find((k) => k.name === 'dsh')?.revokedAt).toBeUndefined()
    const doc = YAML.parseDocument(`access:\n  api-keys:\n    - ${phone}\n`)
    applyOwned(doc, input(keys))
    expect(engineApiKeys(doc).sort()).toEqual([phone, dsh].sort())
  })
})

/** 造一个最小的 zip（store + deflate 各一条） */
function makeZip(files: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const cens: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data
    const name = Buffer.from(f.name)
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0)
    loc.writeUInt16LE(f.deflate ? 8 : 0, 8)
    loc.writeUInt32LE(body.length, 18)
    loc.writeUInt32LE(f.data.length, 22)
    loc.writeUInt16LE(name.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(f.deflate ? 8 : 0, 10)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(f.data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    locals.push(loc, name, body)
    cens.push(cen, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(cens)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

describe('unzip', () => {
  it('extracts stored and deflated entries', async () => {
    const zip = makeZip([
      { name: 'trae.so', data: Buffer.from('stored-bytes') },
      { name: 'qoder.so', data: Buffer.from('x'.repeat(5000)), deflate: true },
    ])
    expect(readZip(zip).map((e) => e.name)).toEqual(['trae.so', 'qoder.so'])
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cpamc-unzip-'))
    await extractZip(zip, dir)
    expect((await readdir(dir)).sort()).toEqual(['qoder.so', 'trae.so'])
    expect((await readFile(join(dir, 'qoder.so'), 'utf8')).length).toBe(5000)
  })

  it('refuses paths that escape the destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cpamc-unzip-'))
    await expect(extractZip(makeZip([{ name: '../evil.so', data: Buffer.from('x') }]), dir)).rejects.toThrow(/unsafe/)
  })
})
