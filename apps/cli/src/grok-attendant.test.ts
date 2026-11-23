import { describe, expect, it } from 'vitest'
import { grokHostOf } from './grok-attendant.js'

const hook = { pid: 400, name: 'node' }
const shell = { pid: 300, name: 'sh' }
const grok = { pid: 200, name: 'grok' }
const orca = { pid: 100, name: 'orca-provider-exec' }
const start = (pid: number): string | null => pid === 200 ? 'Mon Nov 23 09:07:28 2026' : null

describe('grokHostOf', () => {
  it('names the Grok process an ACP host started, past the shell that runs the hook', () => {
    // Orca chat runs `grok agent --always-approve stdio`; hooks run under that process.
    expect(grokHostOf([hook, shell, grok, orca], () => '/home/u/.grok/bin/grok agent --always-approve stdio', start))
      .toEqual({ pid: 200, start: 'Mon Nov 23 09:07:28 2026', role: 'session' })
  })

  it('recognizes the shared leader, whose process alone cannot prove one session', () => {
    expect(grokHostOf([hook, grok], () => 'grok agent leader --no-exit-on-disconnect --relay-on-demand', start)?.role).toBe('leader')
    expect(grokHostOf([hook, grok], () => 'grok agent --leader --always-approve stdio', start)?.role).toBe('leader')
    expect(grokHostOf([hook, grok], () => 'grok --cwd /work/leader', start)?.role).toBe('session')
  })

  it('claims no host it cannot identify', () => {
    expect(grokHostOf([hook, shell, orca], () => 'grok agent stdio', start)).toBeNull()
    expect(grokHostOf(null, () => 'grok agent stdio', start)).toBeNull()
    expect(grokHostOf([grok], () => 'grok agent stdio', start)).toBeNull()
    expect(grokHostOf([hook, grok], () => null, start)).toBeNull()
    expect(grokHostOf([hook, grok], () => 'grok agent stdio', () => null)).toBeNull()
  })
})
