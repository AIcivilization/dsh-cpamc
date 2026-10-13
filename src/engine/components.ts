// engine/components.ts — 引擎之外的两样锁定组件：渠道插件包（四个 IDE 来源）与完整管理界面（management.html）
//
// 和引擎一样只信 engine-manifest.json 里的 sha256，校验不过直接失败；先解到临时目录，成功后再换上（设计 §8）。
// 渠道插件包：engine/plugins/<版本>/，引擎配置里 plugins.dir 写这个绝对路径，四个渠道逐个 enabled。
// 管理界面：放在 engine.yaml 同目录的 static/management.html，并关掉引擎的自动更新（disable-auto-update-panel），
// 这样引擎不会去网上换掉它（M0 V3 实测）。

import { readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Ctx } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { run } from '../util/exec.js'
import { atomicWrite, ensureDir, exists, sha256, sha256File } from '../util/fs.js'
import { extractZip } from '../util/unzip.js'
import { download } from '../util/download.js'
import { platformTarget, type ManifestAsset } from './install.js'

export interface PluginsManifest {
  version: string
  license: string
  /** 要启用的渠道插件 id */
  ids: string[]
  assets: Record<string, ManifestAsset>
}

export interface PanelManifest {
  version: string
  license: string
  file: string
  url: string
  sha256: string
}

/** 插件文件的扩展名（各平台的动态库） */
export function pluginExt(platform: string = process.platform): string {
  return platform === 'win32' ? '.dll' : platform === 'darwin' ? '.dylib' : '.so'
}

export function pluginsVersionDir(ctx: Ctx, version: string): string {
  return join(ctx.paths.pluginsDir, version)
}

/** 下载（或读 env 指定的本地文件，测试 / 离线用），校验 sha256 */
async function fetchVerified(url: string, expected: string, localEnv: string | undefined, what: string, proxy?: string | null): Promise<Buffer> {
  const data = localEnv ? await readFile(localEnv) : await download(url, proxy, what)
  const actual = sha256(data)
  if (actual !== expected) {
    throw new DshModelError(
      'checksum_mismatch',
      L(`${what}校验失败：期望 ${expected}，实际 ${actual}`, `${what} checksum mismatch: expected ${expected}, got ${actual}`),
      L('文件可能被篡改或下载不完整，已中止。', 'The file may be tampered with or incomplete; aborted.'),
    )
  }
  return data
}

/**
 * 装渠道插件包到 plugins/<版本>/（已装且齐全就跳过）。返回是否真的装了。
 * DSH_CPAMC_PLUGINS_ARCHIVE 可指向本地 zip（离线 / 测试），同样要过 sha256 校验。
 */
export async function installPlugins(ctx: Ctx, m: PluginsManifest, proxy?: string | null, target = platformTarget()): Promise<boolean> {
  const asset = m.assets[target]
  if (!asset) {
    throw new DshModelError(
      'unsupported_platform',
      L(`渠道插件包没有 ${target} 的版本，这台机器上暂时用不了 WorkBuddy、Trae、Qoder、ZCode`, `The channel plugin package has no ${target} build; WorkBuddy, Trae, Qoder and ZCode are not available on this machine yet`),
    )
  }
  const dir = pluginsVersionDir(ctx, m.version)
  if (await pluginsPresent(ctx, m)) return false
  const what = L('渠道插件包', 'channel plugin package')
  const data = await fetchVerified(asset.url, asset.sha256, ctx.env.DSH_CPAMC_PLUGINS_ARCHIVE, what, proxy)
  const partial = `${dir}.partial`
  await rm(partial, { recursive: true, force: true })
  await ensureDir(partial)
  try {
    const names = await extractZip(data, partial)
    const missing = m.ids.filter((id) => !names.includes(`${id}${pluginExt()}`))
    if (missing.length) throw new DshModelError('plugins_incomplete', L(`渠道插件包里缺少：${missing.join(', ')}`, `Missing from the channel plugin package: ${missing.join(', ')}`))
    await rm(dir, { recursive: true, force: true })
    await rename(partial, dir)
    if (ctx.owner) await run('chown', ['-R', `${ctx.owner.uid}:${ctx.owner.gid}`, ctx.paths.pluginsDir])
    return true
  } finally {
    await rm(partial, { recursive: true, force: true })
  }
}

export async function pluginsPresent(ctx: Ctx, m: PluginsManifest): Promise<boolean> {
  const dir = pluginsVersionDir(ctx, m.version)
  for (const id of m.ids) if (!(await exists(join(dir, `${id}${pluginExt()}`)))) return false
  return true
}

/**
 * 放好锁定版本的管理界面。文件已在且校验一致就跳过；不一致（被换过）就换回锁定版本。返回是否写了。
 * DSH_CPAMC_PANEL_FILE 可指向本地文件（离线 / 测试）。
 */
export async function installPanel(ctx: Ctx, m: PanelManifest, proxy?: string | null): Promise<boolean> {
  if ((await sha256File(ctx.paths.panelFile)) === m.sha256) return false
  const data = await fetchVerified(m.url, m.sha256, ctx.env.DSH_CPAMC_PANEL_FILE, L('完整管理界面', 'full management interface'), proxy)
  await ensureDir(dirname(ctx.paths.panelFile), { owner: ctx.owner })
  await atomicWrite(ctx.paths.panelFile, data, { owner: ctx.owner, mode: 0o644 })
  return true
}
