import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { generatedSessionLabel } from './generated-session-label.js'
import { buildProgram } from './program.js'
import { renameStoredSessionLabel, resolveSessionLabel } from './session-labels.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(markers: NodeJS.ProcessEnv) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-session-status-'))
  roots.push(root)
  const env = { HOME: root, USERPROFILE: root, XDG_STATE_HOME: path.join(root, 'state'), ...markers }
  const out: string[] = []
  const errors: string[] = []
  const deps: CommandDeps = {
    cwd: root, env,
    io: { out: line => out.push(line), err: line => errors.push(line), confirm: async () => false, openUrl: () => undefined },
    store: { load: () => null, save: () => undefined, clear: () => undefined, describe: () => 'test store' },
  }
  const status = async (...flags: string[]) => {
    const codes: number[] = []
    await buildProgram(deps, { exit: code => { codes.push(code) } }).parseAsync(['node', 'notifai', 'session', 'status', ...flags])
    expect(codes).toEqual([0])
    expect(errors).toEqual([])
    const line = out.at(-1)!
    return flags.includes('--json') ? JSON.parse(line) : line
  }
  return { env, status, store: path.join(env.XDG_STATE_HOME, 'notifai', 'session-labels.json') }
}

describe('notifai session status', () => {
  it('reports the exact Agent Session name and where it came from, without naming it', async () => {
    const f = fixture({ GROK_SESSION_ID: 'grok-session-1' })
    expect(await f.status('--json')).toEqual({ session: { harness: 'grok', name: null, name_source: null } })
    expect(await f.status()).toBe('This Agent Session has no name yet; Notifai names it when it first sends.')
    expect(existsSync(f.store)).toBe(false)

    resolveSessionLabel({ env: f.env, sessionId: 'grok-session-1', harness: 'grok' })
    const generated = generatedSessionLabel('grok-session-1')
    expect(await f.status('--json')).toEqual({ session: { harness: 'grok', name: generated, name_source: 'generated' } })
    expect(await f.status()).toBe(`Agent Session "${generated}": a generated placeholder.`)

    resolveSessionLabel({ env: f.env, sessionId: 'grok-session-1', harness: 'grok', harnessLabel: 'Parser rewrite' })
    expect(await f.status('--json')).toEqual({ session: { harness: 'grok', name: 'Parser rewrite', name_source: 'harness' } })
    expect(await f.status()).toBe('Agent Session "Parser rewrite": from Grok\'s own session title.')

    renameStoredSessionLabel({ env: f.env, sessionId: 'grok-session-1', label: 'Release the parser' })
    expect(await f.status('--json')).toEqual({ session: { harness: 'grok', name: 'Release the parser', name_source: 'agent' } })
    expect(await f.status()).toBe('Agent Session "Release the parser": set by an agent.')
  })

  it('says plainly, and succeeds, when no exact Agent Session is identified', async () => {
    const none = fixture({})
    expect(await none.status('--json')).toEqual({ session: null, reason: 'not_identified' })
    expect(await none.status()).toBe('No agent app identifies an Agent Session here, so there is no name to show.')

    const cursor = fixture({ CURSOR_AGENT: '1' })
    expect(await cursor.status('--json')).toEqual({ session: null, reason: 'not_identified', harness: 'cursor' })
    expect(await cursor.status()).toBe('Cursor does not identify its Agent Session here, so there is no name to show.')

    const contested = fixture({ GROK_SESSION_ID: 'grok-session-2', HERMES_SESSION_ID: 'hermes-session-2' })
    expect(await contested.status('--json')).toEqual({ session: null, reason: 'ambiguous' })
    expect(await contested.status()).toBe('More than one agent app could own this shell, so no exact Agent Session can be proven here.')
  })
})
