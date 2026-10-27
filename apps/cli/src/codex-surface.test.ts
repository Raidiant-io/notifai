import { describe, expect, it } from 'vitest'
import { codexHooksReminder, codexHooksTerminalLine, codexHooksWarning, codexSurface } from './codex-surface.js'
import { doneMessage, doneTerminalLines } from './setup-journey.js'

describe('codexSurface', () => {
  it('reads the client Codex names in the agent shell', () => {
    expect(codexSurface({ CODEX_THREAD_ID: 't', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' })).toBe('app')
    expect(codexSurface({ CODEX_THREAD_ID: 't', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_work_desktop' })).toBe('app')
    expect(codexSurface({ CODEX_THREAD_ID: 't', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode' })).toBe('ide')
    expect(codexSurface({ CODEX_THREAD_ID: 't' })).toBe('cli')
  })

  it('does not guess for other clients or outside Codex', () => {
    expect(codexSurface({ CODEX_THREAD_ID: 't', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3 Code' })).toBeNull()
    expect(codexSurface({ CODEX_THREAD_ID: 't', ORCA_STRUCTURED_SESSION: '1' })).toBeNull()
    expect(codexSurface({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBeNull()
  })
})

describe('hook approval wording', () => {
  const facts = { email: null, notificationsOff: null, apps: ['codex'] as const, codexNeedsApproval: true, commandApps: [] }

  it('names the step the surface actually shows', () => {
    expect(doneMessage({ ...facts, codexSurface: 'cli' })).toContain('- **Codex**: open a new session, type `/hooks` and **approve the Notifai hooks**')
    expect(doneMessage({ ...facts, codexSurface: 'app' })).toContain('- **Codex**: start a new chat, click the **Review hooks** icon by the message box and **allow the Notifai hooks**')
    expect(doneMessage({ ...facts, codexSurface: 'ide' })).toContain('**Review hooks** icon')
  })

  it('gives both ways when the surface is unknown', () => {
    for (const text of [doneMessage(facts), codexHooksWarning(null), codexHooksReminder(null)]) {
      expect(text).toContain('**Review hooks** icon')
      expect(text).toContain('`/hooks`')
    }
    const terminal = doneTerminalLines(facts).lines.join('\n')
    expect(terminal).toContain('Codex: open a new session')
    expect(terminal).toContain(codexHooksTerminalLine(null))
    expect(terminal).not.toMatch(/\*\*|`/)
  })

  it('reminds without asking to be told, and covers hooks that are off', () => {
    for (const surface of ['cli', 'app', 'ide', null] as const) {
      for (const off of [false, true]) {
        const reminder = codexHooksReminder(surface, { off })
        expect(reminder).toMatch(/^\*\*Keep in mind:\*\* Codex won't use Notifai until you /)
        expect(reminder).not.toMatch(/tell me|let me know/i)
      }
    }
    expect(codexHooksReminder('app', { off: true })).toContain('Settings → **Hooks**')
    expect(codexHooksReminder('cli', { off: true })).toContain('`/hooks`')
  })
})
