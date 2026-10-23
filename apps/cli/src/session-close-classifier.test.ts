import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_IDLE_STOP_MS,
  classifyClaudeEnd,
  classifyCodexEnd,
  claudeDesktopPauseLogged,
  claudeForkParent,
  type CodexEndEvidence,
  claudeTranscriptPresent,
  machineDownEarlierBoot,
  readClaudeDesktopRecord,
} from './session-close-classifier.js'

const SESSION = '11111111-2222-3333-4444-555555555555'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'r2-classifier-'))
  roots.push(dir)
  return dir
}

function stamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

describe('who ended a Claude Code conversation', () => {
  const desktop = { appAlive: true, record: { localId: 'local_a', archived: false }, pauseLogged: true }

  it('keeps only the desktop app\'s own pause: app running, conversation listed, the pause logged', () => {
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop })).toEqual({ cause: 'app', reason: 'desktop-paused' })
  })

  it('requires positive archival evidence to close', () => {
    expect(classifyClaudeEnd({ place: 'terminal', transcript: 'present' })).toMatchObject({ cause: 'app' })
    expect(classifyClaudeEnd({ place: 'claude-ide', transcript: 'present' })).toMatchObject({ cause: 'app' })
    expect(classifyClaudeEnd({ place: 'claude-background', transcript: 'present' })).toMatchObject({ cause: 'app' })
    expect(classifyClaudeEnd({ place: 'headless', transcript: 'present' })).toMatchObject({ cause: 'app' })
    expect(classifyClaudeEnd({ place: 'unreported', transcript: 'present' })).toMatchObject({ cause: 'app' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'missing', desktop })).toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present' })).toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, appAlive: false } }))
      .toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, record: 'missing' } }))
      .toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, record: 'unreadable' } }))
      .toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, record: { localId: 'local_a', archived: true } } }))
      .toEqual({ cause: 'user', reason: 'archived' })
    // The Stop button: app running, listed, no pause line.
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, pauseLogged: false } }))
      .toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
  })
})

describe('who ended a conversation in an Orca terminal pane or an Orca chat', () => {
  it('keeps one whose pane lost its terminal host, and expires one whose pane the User closed', () => {
    expect(classifyClaudeEnd({ place: 'terminal', transcript: 'present', terminalHost: 'gone' })).toEqual({ cause: 'app', reason: 'terminal-host-died' })
    expect(classifyClaudeEnd({ place: 'terminal', transcript: 'present', terminalHost: 'alive' })).toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ place: 'terminal', transcript: 'present', terminalHost: null })).toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ place: 'terminal', transcript: 'missing', terminalHost: 'gone' })).toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
  })

  it('keeps an Orca chat stopped 30 minutes after its last activity while Orca runs, without treating earlier stops as closes', () => {
    const chat = { place: 'orca-chat' as const, transcript: 'present' as const, hostApp: 'alive' as const }
    expect(classifyClaudeEnd({ ...chat, idleMs: APP_IDLE_STOP_MS + 60_000 })).toEqual({ cause: 'app', reason: 'idle-stopped' })
    expect(classifyClaudeEnd({ ...chat, idleMs: APP_IDLE_STOP_MS - 60_000 })).toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ ...chat, idleMs: APP_IDLE_STOP_MS + 60_000, hostApp: 'gone' })).toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
    expect(classifyClaudeEnd({ ...chat, idleMs: null })).toEqual({ cause: 'app', reason: 'unconfirmed-stop' })
  })
})

describe('who ended a Codex conversation', () => {
  const app: CodexEndEvidence = { place: 'codex-app', rollout: 'sessions', host: 'alive', hostKind: 'app-server', originator: 'Codex Desktop',
    hostApp: 'alive', idleMs: 0, terminalHost: null }
  const t3: CodexEndEvidence = { ...app, place: 't3', originator: 'T3 Code', host: 'gone' }
  const terminal: CodexEndEvidence = { ...app, place: 'terminal', hostKind: 'other', originator: 'codex-tui', host: 'gone' }
  const minutes = (n: number): number => n * 60_000

  it.each<[string, CodexEndEvidence, ReturnType<typeof classifyCodexEnd>]>([
    ['an app conversation unloaded while the app runs is kept', app, { cause: 'app', reason: 'app-unloaded' }],
    ['so is one from the newer Codex app', { ...app, originator: 'codex_work_desktop' }, { cause: 'app', reason: 'app-unloaded' }],
    ['and one the IDE extension unloads', { ...app, place: 'codex-ide', originator: 'codex_vscode' }, { cause: 'app', reason: 'ide-unloaded' }],
    ['quitting the app (its server gone) is the User\'s', { ...app, host: 'gone' }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['an archive is the User\'s', { ...app, rollout: 'archived' }, { cause: 'user', reason: 'archived' }],
    ['a delete is the User\'s', { ...app, rollout: 'missing' }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['an unreadable rollout is unconfirmed', { ...app, rollout: 'unknown' }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['a terminal thread opened in the app and unloaded is the User\'s', { ...app, originator: 'codex-tui' }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['an unreadable originator is unconfirmed', { ...app, originator: null }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['the shared server unloading a terminal thread is the User\'s', { ...terminal, host: 'alive' }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['a terminal closed is the User\'s', terminal, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['an Orca pane whose terminal host died is kept', { ...terminal, terminalHost: 'gone' }, { cause: 'app', reason: 'terminal-host-died' }],
    ['an Orca pane the User closed is not', { ...terminal, terminalHost: 'alive' }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['a scripted run ends with its run', { ...terminal, place: 'headless' }, { cause: 'user', reason: 'run-ended' }],
    ['T3 stopping it at 29 minutes is the User\'s (an archive or a closed thread)', { ...t3, idleMs: minutes(29) }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['T3 stopping it at 31 minutes with T3 running is T3\'s idle stop', { ...t3, idleMs: minutes(31) }, { cause: 'app', reason: 'idle-stopped' }],
    ['T3 gone at 31 minutes is the User quitting it', { ...t3, idleMs: minutes(31), hostApp: 'gone' }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['T3 that cannot be read is unconfirmed', { ...t3, idleMs: minutes(31), hostApp: null }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['an Orca chat idled out at 31 minutes is kept', { ...t3, place: 'orca-chat', originator: 'orca_desktop', idleMs: minutes(31) }, { cause: 'app', reason: 'idle-stopped' }],
    ['an Orca chat tab closed at 5 minutes is not', { ...t3, place: 'orca-chat', originator: 'orca_desktop', idleMs: minutes(5) }, { cause: 'app', reason: 'unconfirmed-stop' }],
    ['an idle stop of an archived thread is the User\'s', { ...t3, idleMs: minutes(31), rollout: 'archived' }, { cause: 'user', reason: 'archived' }],
  ])('%s', (_name, evidence, verdict) => {
    expect(classifyCodexEnd(evidence)).toEqual(verdict)
  })
})

describe('the conversation a Claude Code fork came from', () => {
  const PARENT = '9f8b306e-d9eb-45cd-924e-8c3f263d7401'
  const FORK = 'fced776f-569d-47aa-8ded-fc58efedd2d9'
  function transcript(lines: unknown[]): string {
    const file = path.join(root(), `${FORK}.jsonl`)
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
    return file
  }

  it('reads `/branch`\'s `forkedFrom`, which names the parent on the copied lines', () => {
    expect(claudeForkParent(transcript([{ type: 'mode', sessionId: FORK }, { type: 'user', sessionId: FORK, forkedFrom: { sessionId: PARENT, messageUuid: 'u1' } }]), FORK))
      .toBe(PARENT)
  })

  it('names no parent for `--fork-session`, which rewrites its copied lines to its own id, nor for a transcript not written yet', () => {
    expect(claudeForkParent(transcript([{ type: 'mode', sessionId: FORK }, { type: 'user', sessionId: FORK, uuid: 'u1' }]), FORK)).toBeNull()
    expect(claudeForkParent(path.join(root(), 'none.jsonl'), FORK)).toBeNull()
    expect(claudeForkParent(null, FORK)).toBeNull()
    expect(claudeForkParent(transcript([{ type: 'user', sessionId: FORK, forkedFrom: { sessionId: FORK } }]), FORK)).toBeNull()
  })
})

describe('the machine going down, seen at the next boot', () => {
  const base = { recordedBoot: 'a', currentBoot: 'b', endedAt: 1_000, endPending: false, shutdown: null }

  it('is a different boot with the end never recorded, still pending, or recorded after the machine said it was going down', () => {
    expect(machineDownEarlierBoot({ ...base, endedAt: null })).toBe(true)
    expect(machineDownEarlierBoot({ ...base, endPending: true })).toBe(true)
    expect(machineDownEarlierBoot({ ...base, shutdown: { boot: 'a', since: 900 } })).toBe(true)
    expect(machineDownEarlierBoot({ ...base, shutdown: { boot: 'a', since: 1_000 } })).toBe(true)
  })

  it('is not the same boot, an unknown boot, an end recorded before the shutdown, or another boot\'s shutdown', () => {
    expect(machineDownEarlierBoot({ ...base, recordedBoot: 'b', endedAt: null })).toBe(false)
    expect(machineDownEarlierBoot({ ...base, currentBoot: null, endedAt: null })).toBe(false)
    expect(machineDownEarlierBoot({ ...base, recordedBoot: null, endedAt: null })).toBe(false)
    expect(machineDownEarlierBoot({ ...base })).toBe(false)
    expect(machineDownEarlierBoot({ ...base, shutdown: { boot: 'a', since: 1_001 } })).toBe(false)
    expect(machineDownEarlierBoot({ ...base, shutdown: { boot: 'z', since: 0 } })).toBe(false)
  })
})

describe('the Claude desktop app\'s records (read-only)', () => {
  it('finds the conversation\'s own record by its CLI session id, archived or not', () => {
    const sessions = path.join(root(), 'claude-code-sessions')
    mkdirSync(path.join(sessions, 'acct', 'org'), { recursive: true })
    writeFileSync(path.join(sessions, 'acct', 'org', 'local_other.json'), JSON.stringify({ sessionId: 'local_other', cliSessionId: 'x' }))
    writeFileSync(path.join(sessions, 'acct', 'org', 'local_mine.json'), JSON.stringify({ sessionId: 'local_mine', cliSessionId: SESSION, isArchived: false }))
    writeFileSync(path.join(sessions, 'acct', 'org', 'local_bad.json'), '{')
    expect(readClaudeDesktopRecord(sessions, SESSION)).toEqual({ localId: 'local_mine', archived: false })
    writeFileSync(path.join(sessions, 'acct', 'org', 'local_mine.json'), JSON.stringify({ sessionId: 'local_mine', cliSessionId: SESSION, isArchived: true }))
    expect(readClaudeDesktopRecord(sessions, SESSION)).toEqual({ localId: 'local_mine', archived: true })
    expect(readClaudeDesktopRecord(sessions, 'gone')).toBe('missing')
    expect(readClaudeDesktopRecord(path.join(sessions, 'nowhere'), SESSION)).toBe('missing')
  })

  it('reads a pause or a governor eviction of this conversation around the end, and nothing else', () => {
    const log = path.join(root(), 'main.log')
    const now = Date.now()
    writeFileSync(log, [
      `${stamp(now - 3_600_000)} [info] [CCD] Pausing session local_mine due to idle`,
      `${stamp(now)} [info] [CCD] Pausing session local_other due to idle`,
      `${stamp(now)} [info] LocalSessions.stop: sessionId=local_mine`,
    ].join('\n'))
    expect(claudeDesktopPauseLogged(log, 'local_mine', now, now)).toBe(false)
    writeFileSync(log, `${stamp(now - 2_000)} [info] [CCD] Pausing session local_mine (idle_timeout)\n`, { flag: 'a' })
    expect(claudeDesktopPauseLogged(log, 'local_mine', now, now)).toBe(true)
    const evicted = path.join(root(), 'main.log')
    writeFileSync(evicted, `${stamp(now)} [info] [CliGovernor] pressure evicting local_mine (idle 2400s)\n`)
    expect(claudeDesktopPauseLogged(evicted, 'local_mine', now, now)).toBe(true)
    expect(claudeDesktopPauseLogged(path.join(root(), 'missing.log'), 'local_mine', now, now)).toBe(false)
  })

  it('finds the transcript by id when the recorded path does not exist, and calls it missing only on evidence', () => {
    const config = root()
    expect(claudeTranscriptPresent(config, SESSION, null)).toBe(false)
    mkdirSync(path.join(config, 'projects', '-elsewhere'), { recursive: true })
    expect(claudeTranscriptPresent(config, SESSION, path.join(config, 'projects', '-here', `${SESSION}.jsonl`))).toBe(false)
    writeFileSync(path.join(config, 'projects', '-elsewhere', `${SESSION}.jsonl`), '{}\n')
    expect(claudeTranscriptPresent(config, SESSION, path.join(config, 'projects', '-here', `${SESSION}.jsonl`))).toBe(true)
  })
})

// Failure to observe a close is not positive evidence of a close.
describe('uncertain stops preserve waiting work', () => {
  it.each(['t3', 'orca-chat', 'terminal', 'unreported', 'claude-ide'] as const)('does not infer a User close in %s', (place) => {
    expect(classifyClaudeEnd({ place, transcript: 'present', hostApp: 'gone', idleMs: 0 }).cause).not.toBe('user')
  })
  it('does not turn unreadable desktop records into a close', () => {
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: {
      appAlive: true, record: 'unreadable', pauseLogged: false,
    } }).cause).not.toBe('user')
  })
  it('does not turn an unreadable rollout or crashed host into a close', () => {
    const evidence: CodexEndEvidence = { place: 't3', rollout: 'unknown', host: 'gone', hostKind: 'app-server',
      originator: null, hostApp: null, idleMs: 0, terminalHost: null }
    expect(classifyCodexEnd(evidence).cause).not.toBe('user')
    expect(classifyCodexEnd({ ...evidence, rollout: 'sessions' }).cause).not.toBe('user')
  })
})
