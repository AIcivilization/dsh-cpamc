/**
 * dsh-cpamc — 0.0.1 占位版本。
 *
 * 这个版本只为在 npm 上占住 `dsh-cpamc` 这个名字，**没有任何实现**。
 *
 * 它也不是一个可用的 DeepSeek Harness 插件：package.json 里刻意**没有** `dsh` 字段，
 * 所以 dsh 不会去加载它，装上去也不会有任何效果。
 *
 * 真正的实现见 https://github.com/AIcivilization/dsh-cpamc
 */

export const name = 'dsh-cpamc'
export const version = '0.0.1'
export const implemented = false

export default { name, version, implemented }
