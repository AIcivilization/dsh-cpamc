import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { bareName, computeAliases } from '../../src/engine/alias.js'
import { applyAliases } from '../../src/engine/config.js'

describe('model aliases', () => {
  it('splits only models offered by more than one source', () => {
    const offered = new Map([
      ['workbuddy', ['glm-5.3', 'hy3']],
      ['trae', ['GLM-5.3', 'doubao-seed']],
      ['zcode', ['glm-5.3']],
    ])
    expect(computeAliases(offered).map((e) => e.alias)).toEqual(['trae/GLM-5.3', 'workbuddy/glm-5.3', 'zcode/glm-5.3'])
  })

  it('recognises its own aliases in the engine catalog and keeps them while the source still offers the model', () => {
    const prev = computeAliases(new Map([['workbuddy', ['glm-5.3']], ['trae', ['glm-5.3']]]))
    // trae 退出登录：workbuddy 那条别名保留，dsh 里选中的 id 不变
    const now = computeAliases(new Map([['workbuddy', ['workbuddy/glm-5.3']]]), prev)
    expect(now.map((e) => e.alias)).toEqual(['workbuddy/glm-5.3'])
    // workbuddy 也不再提供：别名去掉
    expect(computeAliases(new Map([['workbuddy', ['hy3']]]), prev)).toEqual([])
    expect(bareName('trae', 'trae/glm-5.3')).toBe('glm-5.3')
    expect(bareName('trae', 'vendor/x')).toBe('vendor/x')
  })

  it('writes aliases grouped by source, keeps the user own entries and removes stale ones of ours', () => {
    const doc = YAML.parseDocument('oauth:\n  auth-dir: /a\n  model-alias:\n    claude:\n      - name: claude-x\n        alias: cx\n    trae:\n      - name: mine\n        alias: m\n')
    const first = computeAliases(new Map([['workbuddy', ['glm-5.3', 'k2']], ['trae', ['glm-5.3', 'k2']]]))
    applyAliases(doc, first, [])
    let o = YAML.parse(doc.toString())
    expect(o.oauth['model-alias'].claude).toEqual([{ name: 'claude-x', alias: 'cx' }])
    expect(o.oauth['model-alias'].trae).toEqual([{ name: 'mine', alias: 'm' }, { name: 'glm-5.3', alias: 'trae/glm-5.3' }, { name: 'k2', alias: 'trae/k2' }])
    expect(o.oauth['model-alias'].workbuddy).toHaveLength(2)
    applyAliases(doc, [], first)
    o = YAML.parse(doc.toString())
    expect(o.oauth['model-alias']).toEqual({ claude: [{ name: 'claude-x', alias: 'cx' }], trae: [{ name: 'mine', alias: 'm' }] })
    expect(o.oauth['auth-dir']).toBe('/a')
  })
})
