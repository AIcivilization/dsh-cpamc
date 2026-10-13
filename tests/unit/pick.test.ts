import { describe, expect, it } from 'vitest'
import { globalDefault, isChatModel, pickedFor } from '../../src/dsh/pick.js'

describe('default dsh model selection', () => {
  it('shows at most two models: the tested model of free sources, in source order', () => {
    const d = globalDefault([
      { source: 'workbuddy', tier: 'free', models: ['hy3', 'glm-5.3'], probedModel: 'hy3' },
      { source: 'trae', tier: 'free', models: ['doubao'], probedModel: 'doubao' },
      { source: 'qoder', tier: 'free', models: ['q1'], probedModel: 'q1' },
    ])
    expect([...d]).toEqual([['workbuddy', ['hy3']], ['trae', ['doubao']]])
  })

  it('never defaults to untested, paid or vanished models', () => {
    const d = globalDefault([
      { source: 'workbuddy', tier: 'free', models: ['hy3'] },
      { source: 'trae', tier: 'free', models: ['x'], probedModel: 'gone' },
      { source: 'codex', tier: 'paid', models: ['gpt-6'], probedModel: 'gpt-6' },
    ])
    expect(d.size).toBe(0)
  })

  it('a saved choice wins; vanished choices fall back to the default', () => {
    const models = ['a-1', 'b-2']
    expect(pickedFor(models, ['b-2', 'gone'], ['a-1'])).toEqual(['b-2'])
    expect(pickedFor(models, [], ['a-1'])).toEqual([])
    expect(pickedFor(models, ['gone'], ['a-1'])).toEqual(['a-1'])
    expect(pickedFor(models, undefined, ['a-1'])).toEqual(['a-1'])
    expect(pickedFor(models, undefined)).toEqual([])
  })

  it('probes chat models only', () => {
    expect(isChatModel('gpt-image-2.5')).toBe(false)
    expect(isChatModel('bge-m3')).toBe(false)
    expect(isChatModel('codex-auto-review')).toBe(false)
    expect(isChatModel('glm-5.3')).toBe(true)
  })
})
