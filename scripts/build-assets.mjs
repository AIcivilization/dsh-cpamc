// scripts/build-assets.mjs — 把引擎、渠道插件包、管理界面按平台打成 npm 资源包（dsh-cpamc-assets-<平台>）
//
// 用法：node scripts/build-assets.mjs <下载好的发布物目录> [输出目录，默认 build/assets]
// 发布物按 engine-manifest.json 校验 sha256，不对就停下。每个包附三份原项目的 MIT 许可（third-party/licenses）。
// 打好后执行 scripts/publish-assets.sh 发布（需要 npm 账号的两步验证码）。

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const src = process.argv[2]
const out = resolve(process.argv[3] ?? join(root, 'build', 'assets'))
if (!src) {
  console.error('usage: node scripts/build-assets.mjs <dir with downloaded release files> [out dir]')
  process.exit(2)
}
const m = JSON.parse(readFileSync(join(root, 'engine-manifest.json'), 'utf8'))
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const need = (file, expected) => {
  const p = join(src, file)
  if (!existsSync(p)) throw new Error(`missing ${file}`)
  if (sha(p) !== expected) throw new Error(`sha256 mismatch: ${file}`)
  return p
}
const OS = { darwin: 'darwin', linux: 'linux', win32: 'win32' }
rmSync(out, { recursive: true, force: true })
const built = []
for (const [target, suffix] of Object.entries(m.npm.targets)) {
  const engine = m.assets[target]
  const plugins = m.plugins.assets[target]
  if (!engine || !plugins) throw new Error(`no assets for ${target}`)
  const name = `${m.npm.package}-${suffix}`
  const dir = join(out, name)
  mkdirSync(join(dir, 'licenses'), { recursive: true })
  copyFileSync(need(engine.file, engine.sha256), join(dir, engine.file))
  copyFileSync(need(plugins.file, plugins.sha256), join(dir, plugins.file))
  copyFileSync(need(m.panel.file, m.panel.sha256), join(dir, m.panel.file))
  for (const f of ['engine.LICENSE', 'channel-plugins.LICENSE', 'management-interface.LICENSE']) copyFileSync(join(root, 'third-party', 'licenses', f), join(dir, 'licenses', f))
  const [os, cpu] = suffix.split('-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: m.npm.version,
    description: `Prebuilt components used by dsh-cpamc on ${suffix}. Installed and verified by dsh-cpamc setup; not meant to be required directly.`,
    license: 'MIT',
    author: 'AIcivilization',
    repository: { type: 'git', url: 'git+https://github.com/AIcivilization/dsh-cpamc.git' },
    homepage: 'https://github.com/AIcivilization/dsh-cpamc#readme',
    os: [OS[os]],
    cpu: [cpu],
    files: [engine.file, plugins.file, m.panel.file, 'licenses', 'README.md'],
    dshCpamcComponents: { engine: { version: m.version, file: engine.file, sha256: engine.sha256 }, plugins: { version: m.plugins.version, file: plugins.file, sha256: plugins.sha256 }, panel: { version: m.panel.version, file: m.panel.file, sha256: m.panel.sha256 } },
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nPrebuilt components for [dsh-cpamc](https://github.com/AIcivilization/dsh-cpamc) on ${suffix}: the model service, the channel plugins and the full management interface, exactly as released upstream (sha256 checked against dsh-cpamc's engine-manifest.json). Each keeps its own MIT license, see \`licenses/\`.\n\n\`dsh-cpamc setup\` downloads this package itself and verifies every file; you do not need to install it.\n`)
  built.push(dir)
}
console.log(built.join('\n'))
