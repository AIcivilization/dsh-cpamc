// commands/panel.ts — dsh-cpamc panel：打印原版完整管理界面的地址（设计 §5.4）；--show-key 才打印登录密钥

import type { Ctx } from '../context.js'
import { control } from '../daemon/client.js'
import { L } from '../i18n.js'
import { bold, dim, info, isJsonMode, printJson, warn } from '../util/output.js'

export async function panel(ctx: Ctx, opts: { showKey?: boolean }): Promise<number> {
  const r = await control<{ url?: string; apiBase?: string; vps: boolean; tunnel?: string; running: boolean }>(ctx, 'POST', '/panel/open')
  const key = opts.showKey ? (await control<{ key: string }>(ctx, 'POST', '/panel/key')).key : undefined
  if (isJsonMode()) {
    printJson({ ...r, ...(key ? { key } : {}) })
    return r.running ? 0 : 1
  }
  if (!r.running) warn(L('模型服务没有在运行：先执行 dsh-cpamc repair', 'The model service is not running: run dsh-cpamc repair first'))
  if (r.tunnel) {
    info(L('这台服务器还没有为完整管理界面开通受保护的入口。先在你自己的电脑上执行：', 'This server has no protected entry for the full interface yet. First run on your own computer:'))
    info(`\n  ${r.tunnel}\n`)
  }
  info(bold(L('完整管理界面：', 'Full management interface:')) + ` ${r.url ?? '-'}`)
  if (r.vps && r.apiBase && !r.tunnel) info(dim(L(`第一次登录时勾选「自定义连接地址」，填 ${r.apiBase}`, `On first sign-in tick "custom connection address" and enter ${r.apiBase}`)))
  if (key) info(bold(L('登录密钥：', 'Sign-in key:')) + ` ${key}`)
  else info(dim(L('登录密钥：在 dsh 的设置页点「复制登录密钥」，或执行 dsh-cpamc panel --show-key（会显示在终端里）', 'Sign-in key: use "Copy sign-in key" in dsh settings, or run dsh-cpamc panel --show-key (prints it in the terminal)')))
  return r.running ? 0 : 1
}
