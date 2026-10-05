import { describe, expect, it } from 'vitest'
import { claudeHookSourcePid } from './commands-harness-context.js'

describe('the Claude Code process behind a hook', () => {
  it('is the adapter-declared parent on POSIX, where Claude Code runs the adapter itself', () => {
    const env = { NOTIFAI_HOOK_SOURCE_PID: '4100', CLAUDE_PID: '4200' }
    expect(claudeHookSourcePid(env, 'darwin')).toBe(4100)
    expect(claudeHookSourcePid(env, 'linux')).toBe(4100)
    expect(claudeHookSourcePid({ CLAUDE_PID: '4200' }, 'darwin')).toBe(4200)
  })

  it('is the pid Claude Code names on Windows, where the adapter parent is a shell', () => {
    expect(claudeHookSourcePid({ NOTIFAI_HOOK_SOURCE_PID: '4100', CLAUDE_PID: '4200' }, 'win32')).toBe(4200)
    // An older Claude Code that names no pid leaves only the declared parent.
    expect(claudeHookSourcePid({ NOTIFAI_HOOK_SOURCE_PID: '4100' }, 'win32')).toBe(4100)
  })

  it('names nothing from values that are not process ids', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(claudeHookSourcePid({}, platform)).toBeUndefined()
      expect(claudeHookSourcePid({ NOTIFAI_HOOK_SOURCE_PID: '0', CLAUDE_PID: 'claude' }, platform)).toBeUndefined()
    }
  })
})
