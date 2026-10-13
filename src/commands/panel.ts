// commands/panel.ts — dsh-cpamc panel：打印原版完整管理界面的地址（设计 §5.4）；--show-key 才打印登录密钥

import type { Ctx } from '../context.js'
import { control } from '../daemon/client.js'
import { L } from '../i18n.js'
import { bold, dim, info, isJsonMode, printJson, warn } from '../util/output.js'

export async function panel(ctx: Ctx, opts: { showKey?: boolean }): Promise<number> {
  const r = await control<{ url: string; apiBase: string; running: boolean }>(ctx, 'POST', '/panel/open')
  const key = opts.showKey ? (await control<{ key: string }>(ctx, 'POST', '/panel/key')).key : undefined
  if (isJsonMode()) {
    printJson({ ...r, remotePath: '/dsh-cpamc/panel/management.html', ...(key ? { key } : {}) })
    return r.running ? 0 : 1
  }
  if (!r.running) warn(L('模型服务没有在运行：先执行 dsh-cpamc repair', 'The model service is not running: run dsh-cpamc repair first'))
  info(bold(L('完整管理界面（本机）：', 'Full management interface (this machine):')) + ` ${r.url}`)
  info(dim(L('在别的设备上：打开 dsh 的网址，后面加 /dsh-cpamc/panel/management.html（要先登录 dsh）', 'From another device: open your dsh address followed by /dsh-cpamc/panel/management.html (sign in to dsh first)')))
  if (key) info(bold(L('登录密钥：', 'Sign-in key:')) + ` ${key}`)
  else info(dim(L('登录密钥：在 dsh 的设置页点「复制登录密钥」，或执行 dsh-cpamc panel --show-key（会显示在终端里）', 'Sign-in key: use "Copy sign-in key" in dsh settings, or run dsh-cpamc panel --show-key (prints it in the terminal)')))
  return r.running ? 0 : 1
}
