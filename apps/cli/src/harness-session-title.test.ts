import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readClaudeSessionTitle, readCodexSessionTitle, readHarnessSessionTitle, recordClaudeSessionTitle, recordClaudeTranscriptPath,
  recordHarnessTitleEnvironment, sessionTitleEnvironment,
} from './harness-session-title.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function home(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-titles-'))
  roots.push(root)
  const env = { HOME: root, CODEX_HOME: path.join(root, '.codex'), T3CODE_HOME: path.join(root, '.t3') }
  mkdirSync(env.CODEX_HOME, { recursive: true })
  mkdirSync(path.join(env.T3CODE_HOME, 'userdata'), { recursive: true })
  return env
}
function t3(env: NodeJS.ProcessEnv, driver = 'codex'): DatabaseSync {
  const db = new DatabaseSync(path.join(env.T3CODE_HOME!, 'userdata', 'statev2.sqlite'))
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, driver TEXT, payload_json TEXT);`)
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL)').run('host-thread', 'Repair the parser')
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)').run('host-thread', driver,
    JSON.stringify({ nativeThreadRef: { driver, nativeId: 'exact-session', strength: 'strong' } }))
  return db
}

describe('exact host names outside the Codex index', () => {
  it.each([['codex', 'codex'], ['claude-code', 'claudeAgent'], ['cursor', 'cursor'], ['grok', 'grok']] as const)(
    'reads the exact T3 %s native session, never a neighbour', (harness, driver) => {
      const env = home()
      const db = t3(env, driver)
      db.close()
      expect(readHarnessSessionTitle(env, { harness, label: harness, sessionId: 'exact-session' })).toBe('Repair the parser')
      expect(readHarnessSessionTitle(env, { harness, label: harness, sessionId: 'other-session' })).toBeUndefined()
    })
  it('keeps exact-session host selectors separate from the shared Hub launcher', () => {
    const env = home()
    const db = t3(env)
    db.close()
    recordHarnessTitleEnvironment('exact-session', { ...env, ORCA_PANE_KEY: 'own-pane', UNRELATED_SECRET: 'never-copy' })
    const scoped = sessionTitleEnvironment('exact-session', { ...env, T3CODE_HOME: '/unrelated-host', ORCA_PANE_KEY: 'other-pane' })
    expect(scoped.T3CODE_HOME).toBe(env.T3CODE_HOME)
    expect(scoped.ORCA_PANE_KEY).toBe('own-pane')
    expect(scoped.UNRELATED_SECRET).toBeUndefined()
    expect(readHarnessSessionTitle(scoped, { harness: 'codex', label: 'Codex', sessionId: 'exact-session' })).toBe('Repair the parser')
    expect(sessionTitleEnvironment('other-session', scoped).ORCA_PANE_KEY).toBeUndefined()
  })
  it('fails closed for ambiguous native identity and malformed state', () => {
    const env = home()
    const db = t3(env)
    db.exec("INSERT INTO orchestration_v2_projection_threads VALUES ('other-host', 'Other task', NULL)")
    db.exec("INSERT INTO orchestration_v2_projection_provider_threads SELECT 'other-host', driver, payload_json FROM orchestration_v2_projection_provider_threads")
    expect(readHarnessSessionTitle(env, { harness: 'codex', label: 'Codex', sessionId: 'exact-session' })).toBeUndefined()
    db.exec('DROP TABLE orchestration_v2_projection_provider_threads')
    expect(readHarnessSessionTitle(env, { harness: 'codex', label: 'Codex', sessionId: 'exact-session' })).toBeUndefined()
    db.close()
  })
  it('reads only the explicit Codex name field, never the first-prompt title', () => {
    const env = home()
    const db = new DatabaseSync(path.join(env.CODEX_HOME!, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('exact-session', 'Repair the parser', '$ub-mode')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('prompt-only', null, 'Private first prompt')
    expect(readCodexSessionTitle(env, 'exact-session')).toBe('Repair the parser')
    expect(readCodexSessionTitle(env, 'prompt-only')).toBeUndefined()
    expect(readCodexSessionTitle(env, 'other-session')).toBeUndefined()
    writeFileSync(path.join(env.CODEX_HOME!, 'session_index.jsonl'), JSON.stringify({ id: 'exact-session', thread_name: 'Index name' }))
    expect(readCodexSessionTitle(env, 'exact-session')).toBe('Index name')
    db.close()
  })
})

describe('Claude Code session titles', () => {
  const SESSION = 'f7ad613e-7aeb-4004-9ddf-e7cfc2fd64db'
  function transcript(env: NodeJS.ProcessEnv, entries: unknown[], sessionId = SESSION): string {
    const dir = path.join(env.HOME!, '.claude', 'projects', '-work-repo')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${sessionId}.jsonl`)
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    return file
  }
  const turn = { type: 'user', sessionId: SESSION, message: { role: 'user', content: 'x'.repeat(2_000) } }

  it('names an unnamed session after the title Claude Code generated for it', () => {
    const env = home()
    const file = transcript(env, [turn, { type: 'ai-title', aiTitle: 'Early guess', sessionId: SESSION }, turn,
      { type: 'ai-title', aiTitle: 'Repair the parser', sessionId: SESSION }, turn])
    expect(readClaudeSessionTitle(env, SESSION)).toBeUndefined()
    recordClaudeTranscriptPath(SESSION, env, file)
    expect(readClaudeSessionTitle(env, SESSION)).toBe('Repair the parser')
    expect(readHarnessSessionTitle(env, { harness: 'claude-code', label: 'Claude Code', sessionId: SESSION })).toBe('Repair the parser')
  })

  it('prefers the User\'s rename, whether reported by a hook or written to the transcript', () => {
    const env = home()
    const file = transcript(env, [{ type: 'custom-title', customTitle: 'Parser rewrite', sessionId: SESSION }, turn,
      { type: 'ai-title', aiTitle: 'Repair the parser', sessionId: SESSION }])
    recordClaudeTranscriptPath(SESSION, env, file)
    expect(readClaudeSessionTitle(env, SESSION)).toBe('Parser rewrite')
    recordClaudeSessionTitle(SESSION, env, 'Named at launch')
    expect(readClaudeSessionTitle(env, SESSION)).toBe('Named at launch')
  })

  it('ignores another session\'s titles and any transcript path that is not this session\'s', () => {
    const env = home()
    const file = transcript(env, [{ type: 'ai-title', aiTitle: 'Someone else', sessionId: 'other-session' }])
    recordClaudeTranscriptPath(SESSION, env, file)
    expect(readClaudeSessionTitle(env, SESSION)).toBeUndefined()
    const foreign = transcript(env, [{ type: 'ai-title', aiTitle: 'Someone else', sessionId: SESSION }], 'other-session')
    recordClaudeTranscriptPath(SESSION, env, foreign)
    recordClaudeTranscriptPath(SESSION, env, `relative/${SESSION}.jsonl`)
    expect(readClaudeSessionTitle(env, SESSION)).toBeUndefined()
  })

  it('reads only the newest part of a long transcript and survives a missing one', () => {
    const env = home()
    const old = { type: 'ai-title', aiTitle: 'Old title', sessionId: SESSION }
    const filler = (count: number) => Array.from({ length: count }, () => turn)
    // About 1.4 MB before the current title and 200 KB after it.
    const file = transcript(env, [old, ...filler(700), { type: 'ai-title', aiTitle: 'Current title', sessionId: SESSION }, ...filler(100)])
    recordClaudeTranscriptPath(SESSION, env, file)
    expect(readClaudeSessionTitle(env, SESSION)).toBe('Current title')
    rmSync(file)
    expect(readClaudeSessionTitle(env, SESSION)).toBeUndefined()
  })
})
