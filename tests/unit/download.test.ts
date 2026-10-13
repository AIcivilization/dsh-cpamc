import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { download } from '../../src/util/download.js'

describe('download', () => {
  let server: ReturnType<typeof createServer>
  let base = ''
  let failures = 0
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/flaky' && failures-- > 0) return req.socket.destroy()
      if (req.url === '/redirect') return res.writeHead(302, { location: '/slow' }).end()
      // 2 MB，分 20 块慢慢发
      const chunk = Buffer.alloc(100 * 1024, 7)
      res.writeHead(200, { 'content-length': String(chunk.length * 20) })
      let n = 0
      const t = setInterval(() => {
        res.write(chunk)
        if (++n === 20) {
          clearInterval(t)
          res.end()
        }
      }, 10)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => server.close())

  it('follows redirects and prints progress lines when asked to', async () => {
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true))
    process.env.DSH_CPAMC_PROGRESS = '1'
    try {
      const b = await download(`${base}/redirect`, null, '引擎')
      expect(b.length).toBe(20 * 100 * 1024)
    } finally {
      spy.mockRestore()
      delete process.env.DSH_CPAMC_PROGRESS
    }
    const lines = out.filter((l) => l.includes('引擎'))
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(lines[0]).toMatch(/\d+%（[\d.]+ \/ 2\.0 MB/)
  })

  it('retries a dropped connection', async () => {
    failures = 2
    const b = await download(`${base}/flaky`, null, 'x')
    expect(b.length).toBe(20 * 100 * 1024)
  }, 20_000)

  it('explains a dead proxy', async () => {
    await expect(download('https://example.invalid/x', 'http://127.0.0.1:1', 'test')).rejects.toThrow(/127\.0\.0\.1:1/)
  }, 20_000)
})
