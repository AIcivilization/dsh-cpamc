// daemon/runtime.ts — 守护进程的端口与控制密钥（bridge.json，0600）
//
// 文件名和服务名沿用 dsh-model 的 bridge 叫法：服务 com.dsh-cpamc.bridge / dsh-cpamc-bridge.service 跑的就是守护进程。

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson, type Owner } from '../util/fs.js'

export const BRIDGE_DEFAULT_PORT = 18327

export interface BridgeConfig {
  port: number
  secret: string
}

export function bridgeConfigPath(home: string): string {
  return join(home, 'bridge.json')
}

export async function loadBridgeConfig(home: string): Promise<BridgeConfig | null> {
  return readJson<BridgeConfig>(bridgeConfigPath(home))
}

export async function ensureBridgeConfig(home: string, port: number, owner?: Owner): Promise<BridgeConfig> {
  const existing = await loadBridgeConfig(home)
  if (existing && existing.port === port) return existing
  const cfg: BridgeConfig = { port, secret: existing?.secret ?? `dshb_${randomBytes(32).toString('base64url')}` }
  await writeJson(bridgeConfigPath(home), cfg, { owner })
  return cfg
}

/** 守护进程活着且控制密钥对得上 */
export async function bridgeHealthy(port: number, secret: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}
