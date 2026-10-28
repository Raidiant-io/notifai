import { describe, expect, it } from 'vitest'
import { codexHost, codexHooksReminder, codexHooksTerminalLine, codexHooksWarning, codexNextStep, codexSurface } from './codex-surface.js'
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
  })

  it('names `notifai doctor codex` when an app runs Codex in its own home', () => {
    const t3 = "**Keep in mind:** Codex won't use Notifai in this Codex account until you approve its hooks there. In a terminal on this machine (T3 Code's terminal panel works), run `notifai doctor codex`: it opens Codex's own hook review for this account, where you choose **Trust all and continue**."
    expect(codexHooksReminder(null, { home: '/Users/me/app/shadow', host: 't3', platform: 'darwin' })).toBe(t3)
    // One command on every platform: no home path, no PowerShell form to type.
    expect(codexHooksReminder(null, { home: "C:\\Users\\me's\\shadow", host: 't3', platform: 'win32' })).toBe(t3)
    // The startup prompt does not list hooks that are off, so that takes /hooks.
    expect(codexHooksReminder(null, { home: '/Users/me/My Apps/shadow', off: true, platform: 'linux' })).toBe(
      "**Keep in mind:** Codex won't use Notifai in this Codex account until you turn its hooks on and approve them there. In a terminal on this machine, run `notifai doctor codex`: it opens Codex's own hook review for this account, where you type `/hooks` to turn them on and approve them.",
    )
    // The Codex CLI, app and editor already approve in the home they run on.
    expect(codexHooksReminder('cli', { home: '/Users/me/app/shadow', host: 't3' })).toBe(codexHooksReminder('cli'))
    expect(codexHooksReminder('cli', { off: true })).toContain('`/hooks`')
  })

  it('sends a T3 Code default account to the terminal too, on ~/.codex', () => {
    expect(codexHooksReminder(null, { host: 't3', home: null, platform: 'darwin' })).toBe(
      "**Keep in mind:** Codex won't use Notifai until you approve its hooks. In a terminal on this machine (T3 Code's terminal panel works), run `notifai doctor codex`: it opens Codex's own hook review, where you choose **Trust all and continue**.",
    )
  })

  it('approves once in ~/.codex for Orca, which copies it to every account', () => {
    for (const home of [null, '/Users/me/Library/Application Support/orca/codex-accounts/a/home']) {
      expect(codexHooksReminder(null, { host: 'orca', home, platform: 'darwin' })).toBe(
        "**Keep in mind:** Codex won't use Notifai in Orca until you approve its hooks. In a terminal on this machine, run `notifai doctor codex`: it opens Codex's own hook review, where you choose **Trust all and continue**. Orca copies the approval to its Codex accounts the next time it starts Codex.",
      )
    }
    expect(codexHooksReminder(null, { host: 'orca', off: true })).toContain("run `notifai doctor codex`: it opens Codex's own hook review, where you type `/hooks` to turn them on and approve them.")
  })

  it('gives setup and its done message the same step for a separate home', () => {
    const place = { home: '/Users/me/app/shadow', host: 't3', platform: 'darwin' } as const
    const step = "in a terminal on this machine (T3 Code's terminal panel works), run `notifai doctor codex`: it opens Codex's own hook review for this account, where you choose **Trust all and continue**."
    expect(codexHooksWarning(null, place)).toBe(`⚠️ **Codex won't use Notifai in this Codex account until you approve its hooks there:** ${step}`)
    expect(codexNextStep(null, true, place)).toBe(`**approve the Notifai hooks**, then open a new session: ${step}`)
    expect(doneMessage({ ...facts, codexSurface: null, codexPlace: place })).toContain(`- **Codex**: **approve the Notifai hooks**, then open a new session: ${step}`)
    const terminal = doneTerminalLines({ ...facts, codexSurface: null, codexPlace: place }).lines.join('\n')
    expect(terminal).toContain("run notifai doctor codex: it opens Codex's own hook review for this account, where you choose Trust all and continue")
    expect(terminal).not.toMatch(/\*\*|`/)
  })
})

describe('codexHost', () => {
  it('names T3 Code and Orca chats, never a surface with its own hook review', () => {
    expect(codexHost({ CODEX_THREAD_ID: 't', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3' })).toBe('t3')
    expect(codexHost({ CODEX_THREAD_ID: 't', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3 Code' })).toBe('t3')
    expect(codexHost({ CODEX_THREAD_ID: 't', ORCA_STRUCTURED_SESSION: '1' })).toBe('orca')
    // An Orca terminal pane runs the plain Codex CLI, whose /hooks approves its own home.
    expect(codexHost({ CODEX_THREAD_ID: 't' })).toBeNull()
    expect(codexHost({ CODEX_THREAD_ID: 't', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'other_app' })).toBeNull()
  })
})
