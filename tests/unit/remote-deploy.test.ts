import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 模块
import { classifyFailure, createDeployer, remoteScript, validateRequest } from '../../plugin/remote-deploy.js'

describe('deploy to a server', () => {
  it('validates the form', () => {
    expect(validateRequest({ host: '1.2.3.4' }).value).toMatchObject({ action: 'install', host: '1.2.3.4', port: 22, user: 'root', password: '' })
    expect(validateRequest({ host: 'bad host!' }).error).toBeTruthy()
    expect(validateRequest({ host: 'a.example', port: 70000 }).error).toBeTruthy()
    expect(validateRequest({ host: 'a.example', user: 'rm -rf' }).error).toBeTruthy()
    expect(validateRequest({ host: 'a.example', action: 'uninstall', keepAuth: true }).value).toMatchObject({ action: 'uninstall', keepAuth: true })
  })

  it('builds a valid remote script that installs this exact version', () => {
    const install = remoteScript({ action: 'install', version: '0.1.0-alpha.2', mirror: true })
    expect(install).toContain('npm install -g dsh-cpamc@0.1.0-alpha.2 --registry=https://registry.npmmirror.com && dsh-cpamc setup')
    expect(install).toContain('DSHCPAMC_ERR=no_dsh')
    const uninstall = remoteScript({ action: 'uninstall', version: '0.1.0-alpha.2', keepAuth: true })
    expect(uninstall).toContain('dsh-cpamc uninstall --yes --remove-plugin --keep-auth')
    expect(uninstall).not.toContain('npm install')
    for (const sc of [install, uninstall]) expect(spawnSync('sh', ['-n'], { input: sc }).status).toBe(0)
    expect(() => remoteScript({ action: 'install', version: '1; rm -rf /' })).toThrow()
  })

  it('explains failures', () => {
    expect(classifyFailure('Permission denied (password).', 255, true)).toMatch(/密码不对/)
    expect(classifyFailure('', 6, false)).toMatch(/没找到 DSH/)
    expect(classifyFailure('', 5, false, 'linux', 'en')).toMatch(/Node 20/)
  })

  function fakeSpawn(stdoutText: string, code: number, record: { args?: string[]; env?: NodeJS.ProcessEnv; script?: string }) {
    return (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      record.args = args
      record.env = opts.env
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.kill = () => {}
      let script = ''
      child.stdin.on('data', (d) => (script += d))
      child.stdin.on('end', () => {
        record.script = script
        child.stdout.end(stdoutText)
        setTimeout(() => child.emit('close', code), 10)
      })
      return child
    }
  }

  it('runs a job: password only in the environment, success read from the remote exit marker', async () => {
    const rec: { args?: string[]; env?: NodeJS.ProcessEnv; script?: string } = {}
    const d = createDeployer({ version: '0.1.0-alpha.2', spawnImpl: fakeSpawn('DSHCPAMC_STARTED\n✓ Engine v8.0.13 downloaded\nDSHCPAMC_EXIT=0\n', 0, rec), env: {} })
    await d.start(validateRequest({ host: 'srv.example', password: 's3cret' }).value)
    await new Promise((r) => setTimeout(r, 50))
    const job = d.snapshot().job
    expect(job.state).toBe('success')
    expect(job.lines).toEqual(['✓ Engine v8.0.13 downloaded'])
    expect(rec.args!.join(' ')).not.toContain('s3cret')
    expect(rec.env!.DSH_CPAMC_PW).toBe('s3cret')
    expect(rec.args).toContain('root@srv.example')
    expect(rec.script).toContain('dsh-cpamc@0.1.0-alpha.2')
    expect(JSON.stringify(job)).not.toContain('s3cret')
  })

  it('reports a missing DSH on the server', async () => {
    const d = createDeployer({ version: '0.1.0-alpha.2', spawnImpl: fakeSpawn('DSHCPAMC_ERR=no_dsh\n', 6, {}), env: {} })
    await d.start(validateRequest({ host: 'srv.example' }).value)
    await new Promise((r) => setTimeout(r, 50))
    expect(d.snapshot().job).toMatchObject({ state: 'failed' })
    expect(d.snapshot().job.error).toMatch(/没找到 DSH/)
  })
})
