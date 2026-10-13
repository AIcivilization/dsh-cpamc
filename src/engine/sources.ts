// engine/sources.ts — 引擎、渠道插件包、管理界面这三样从哪儿下载
//
// 原始发布物在 GitHub；在要靠代理才连得上 GitHub 的网络里，经代理下载可能慢到一小时（实测几 KB/s），甚至失败。
// 所以 dsh-cpamc 把同一批文件按平台打成 npm 包（dsh-cpamc-assets-<平台>，附各自的 MIT 许可）发布，
// 依次试：国内 npm 镜像（直连）→ npm 官方源（经代理）→ GitHub 原地址（经代理）。
// 无论从哪儿来，都按 engine-manifest.json 里原有的 sha256 校验——来源换了，信任的依据不变。
// 一次 setup 里，同一个资源包只下载一次（三样文件都在里面）。

import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { download } from '../util/download.js'
import { sha256 } from '../util/fs.js'
import { readTgz } from '../util/tar.js'
import { loadManifest, platformTarget } from './install.js'

export interface NpmAssets {
  package: string
  version: string
  registries: string[]
  /** 我们的平台名（darwin-aarch64）→ 资源包的后缀（darwin-arm64） */
  targets: Record<string, string>
}

export function assetsPackageName(npm: NpmAssets, target: string): string | null {
  const suffix = npm.targets[target]
  return suffix ? `${npm.package}-${suffix}` : null
}

export function tarballUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${name}/-/${name}-${version}.tgz`
}

const packs = new Map<string, Promise<Map<string, Buffer> | null>>()

/** 下载并解开这个平台的资源包；各个源都不行就返回 null（调用方退回 GitHub） */
function assetsPack(npm: NpmAssets, target: string, proxy: string | null | undefined): Promise<Map<string, Buffer> | null> {
  const name = assetsPackageName(npm, target)
  if (!name) return Promise.resolve(null)
  const key = `${name}@${npm.version}`
  let p = packs.get(key)
  if (!p) {
    p = (async () => {
      for (const [i, registry] of npm.registries.entries()) {
        // 第一个（国内镜像）直连；之后的经代理
        try {
          const tgz = await download(tarballUrl(registry, name, npm.version), i === 0 ? null : proxy, L(`组件包（${new URL(registry).hostname}）`, ` the component package (${new URL(registry).hostname})`))
          return readTgz(tgz)
        } catch (error) {
          if (process.stdout.isTTY || process.env.DSH_CPAMC_PROGRESS === '1') process.stdout.write(L(`  ${new URL(registry).hostname} 不可用（${(error as Error).message.slice(0, 120)}），换下一个来源\n`, `  ${new URL(registry).hostname} unavailable (${(error as Error).message.slice(0, 120)}); trying the next source\n`))
        }
      }
      return null
    })()
    packs.set(key, p)
  }
  return p
}

/** 测试用：清掉本进程里缓存的资源包 */
export function forgetPacks(): void {
  packs.clear()
}

/**
 * 取一个发布物的内容并校验 sha256：先从资源包里拿，拿不到（或校验不过）再从 GitHub 原地址下载。
 * @param file 文件名（与 manifest 里的 file 一致；管理界面是 management.html）
 */
export async function fetchComponent(opts: { file: string; sha256: string; url: string; what: string; proxy?: string | null; target?: string; npm?: NpmAssets }): Promise<Buffer> {
  const npm = opts.npm ?? (await loadManifest()).npm
  const target = opts.target ?? platformTarget()
  if (npm) {
    const pack = await assetsPack(npm, target, opts.proxy)
    const data = pack?.get(`package/${opts.file}`)
    if (data && sha256(data) === opts.sha256) return data
  }
  const data = await download(opts.url, opts.proxy, opts.what)
  const actual = sha256(data)
  if (actual !== opts.sha256) {
    throw new DshModelError(
      'checksum_mismatch',
      L(`${opts.what}校验失败：期望 ${opts.sha256}，实际 ${actual}`, `${opts.what} checksum mismatch: expected ${opts.sha256}, got ${actual}`),
      L('文件可能被篡改或下载不完整，已中止。', 'The file may be tampered with or incomplete; aborted.'),
    )
  }
  return data
}
