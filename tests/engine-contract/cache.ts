// 契约测试共用：锁定版本的发布物下载到 tests/.cache/（之后复用）；安装时照常过 sha256 校验

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadManifest, platformTarget } from '../../src/engine/install.js'

const CACHE = join(__dirname, '..', '.cache')

async function cached(file: string, url: string): Promise<string> {
  const path = join(CACHE, file)
  if (!existsSync(path)) {
    await mkdir(CACHE, { recursive: true })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download ${url}: ${res.status}`)
    await writeFile(path, Buffer.from(await res.arrayBuffer()))
  }
  return path
}

export async function cachedArchive(): Promise<string> {
  const a = (await loadManifest()).assets[platformTarget()]!
  return cached(a.file, a.url)
}

export async function cachedPlugins(): Promise<string> {
  const a = (await loadManifest()).plugins.assets[platformTarget()]!
  return cached(a.file, a.url)
}

export async function cachedPanel(): Promise<string> {
  const p = (await loadManifest()).panel
  return cached(`panel-${p.version}-${p.file}`, p.url)
}

/** 三样都备好，返回给 tempCtx / process.env 用的环境变量 */
export async function componentEnv(): Promise<Record<string, string>> {
  return { DSH_CPAMC_ENGINE_ARCHIVE: await cachedArchive(), DSH_CPAMC_PLUGINS_ARCHIVE: await cachedPlugins(), DSH_CPAMC_PANEL_FILE: await cachedPanel() }
}
