// commands/migrate.ts — 从 dsh-model 迁过来（设计 §11）
//
// 两者可以同时装着（provider id 不同），但 dsh 里会出现两组模型，也各占一份端口和服务，所以建议只留一个。
// 迁移只复制、不删除：Claude / Codex 的登录凭据（两边都是引擎原生格式）与访问 key（设备不用改配置）。
// WorkBuddy 在 dsh-model 里是它自己的 bridge 登录，格式不同，迁不过来——在「全部功能」里重新登录一次。
// dsh-model 本身由用户执行 dsh-model uninstall 卸载，这里不替用户删它的数据。

import { copyFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { VPS_USER_HOME } from '../context.js'
import { tightenAuthPerms } from '../engine/auth.js'
import { L } from '../i18n.js'
import { DSH_KEY_NAME, activeKeys, saveKeys, type KeyStore } from '../keys.js'
import { loadAll, syncAll } from '../ops.js'
import { withLock } from '../state.js'
import { ensureDir, exists, readJson } from '../util/fs.js'
import { info, ok, skip, warn } from '../util/output.js'

/** dsh-model 装在这台机器上的数据目录（没有就是 null） */
export async function dshModelHome(ctx: Ctx): Promise<string | null> {
  const dir = ctx.env.DSH_MODEL_HOME || (ctx.mode === 'vps' ? join(VPS_USER_HOME, '.dsh-model') : join(homedir(), '.dsh-model'))
  return (await exists(join(dir, 'state.json'))) ? dir : null
}

const MIGRATABLE = ['codex-', 'claude-']

export async function migrate(ctx: Ctx): Promise<number> {
  const src = await dshModelHome(ctx)
  if (!src) {
    info(L('这台机器上没有找到 dsh-model', 'dsh-model was not found on this machine'))
    return 0
  }
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    await ensureDir(ctx.paths.auth, { owner: ctx.owner })

    // 登录凭据：这边还没有同一来源的凭据才复制
    const mine = await readdir(ctx.paths.auth).catch(() => [] as string[])
    const theirs = await readdir(join(src, 'auth')).catch(() => [] as string[])
    let copied = 0
    for (const prefix of MIGRATABLE) {
      const files = theirs.filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      if (!files.length) continue
      if (mine.some((f) => f.startsWith(prefix))) {
        skip(L(`${prefix.slice(0, -1)} 这边已经登录过，保留现有的`, `${prefix.slice(0, -1)} is already signed in here; keeping it`))
        continue
      }
      for (const f of files) await copyFile(join(src, 'auth', f), join(ctx.paths.auth, f))
      copied += files.length
      ok(L(`已复制 ${prefix.slice(0, -1)} 的登录凭据`, `Copied the ${prefix.slice(0, -1)} sign-in`))
    }
    if (copied) await tightenAuthPerms(ctx)

    // 访问 key：保留名字和值，用它的设备不用改配置；同名的跳过；dsh 用的那把不迁（各自一把）
    const old = (await readJson<KeyStore>(join(src, 'keys.json'))) ?? { keys: [] }
    let keys = 0
    for (const k of activeKeys(old)) {
      if (k.name === DSH_KEY_NAME) continue
      if (all.keys.keys.some((x) => x.name === k.name && !x.revokedAt)) {
        skip(L(`key「${k.name}」这边已经有了，跳过`, `Key "${k.name}" already exists here; skipped`))
        continue
      }
      all.keys.keys.push({ name: k.name, key: k.key, createdAt: k.createdAt })
      keys++
    }
    if (keys) {
      await saveKeys(ctx, all.keys)
      ok(L(`已迁移 ${keys} 把访问 key（设备上的配置不用改；Base URL 换成 dsh-cpamc 的地址）`, `Migrated ${keys} access key(s) (devices keep their key; switch their Base URL to dsh-cpamc's address)`))
    }

    if (copied || keys) await syncAll(ctx, all).catch((e: unknown) => warn(String((e as Error).message ?? e)))
    info('')
    warn(L('WorkBuddy 的登录迁不过来：在 dsh 的「设置 → dsh-cpamc → 全部功能」里重新登录一次', 'The WorkBuddy sign-in cannot be migrated: sign in again under dsh Settings → dsh-cpamc → All features'))
    info(L('确认 dsh-cpamc 一切正常后，执行 dsh-model uninstall 卸载 dsh-model（dsh 里就不会有两组模型了）', 'Once dsh-cpamc works, run dsh-model uninstall to remove dsh-model (so dsh no longer shows two model groups)'))
    return 0
  })
}
