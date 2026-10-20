import { describe, expect, it } from 'vitest'
import { hookScopeEnv, inHookScope, oncePerHook } from './hook-scope.js'

describe('hook scope', () => {
  it('answers each question once per hook, keeps hooks apart, and remembers nothing outside one', async () => {
    let asked = 0
    const ask = (): number => oncePerHook('question', () => ++asked)
    expect([ask(), ask()]).toEqual([1, 2])
    const [first, second] = await Promise.all([
      inHookScope({ HOOK: 'a' }, async () => { const one = ask(); await new Promise((resolve) => setTimeout(resolve, 5)); return [one, ask(), hookScopeEnv()?.['HOOK']] }),
      inHookScope({ HOOK: 'b' }, async () => [ask(), ask(), hookScopeEnv()?.['HOOK']]),
    ])
    expect(first).toEqual([3, 3, 'a'])
    expect(second).toEqual([4, 4, 'b'])
    expect(hookScopeEnv()).toBeUndefined()
  })
})
