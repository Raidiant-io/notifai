import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyClaudeEnd,
  claudeDesktopPauseLogged,
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

  it('takes everything else for the User\'s close', () => {
    expect(classifyClaudeEnd({ place: 'terminal', transcript: 'present' })).toMatchObject({ cause: 'user' })
    expect(classifyClaudeEnd({ place: 'claude-ide', transcript: 'present' })).toMatchObject({ cause: 'user' })
    expect(classifyClaudeEnd({ place: 'claude-background', transcript: 'present' })).toMatchObject({ cause: 'user' })
    expect(classifyClaudeEnd({ place: 'headless', transcript: 'present' })).toMatchObject({ cause: 'user' })
    expect(classifyClaudeEnd({ place: 'unreported', transcript: 'present' })).toMatchObject({ cause: 'user' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'missing', desktop })).toEqual({ cause: 'user', reason: 'transcript-missing' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present' })).toEqual({ cause: 'user', reason: 'app-quit' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, appAlive: false } }))
      .toEqual({ cause: 'user', reason: 'app-quit' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, record: 'missing' } }))
      .toEqual({ cause: 'user', reason: 'deleted' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, record: 'unreadable' } }))
      .toEqual({ cause: 'user', reason: 'record-unreadable' })
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, record: { localId: 'local_a', archived: true } } }))
      .toEqual({ cause: 'user', reason: 'archived' })
    // The Stop button: app running, listed, no pause line.
    expect(classifyClaudeEnd({ place: 'claude-desktop', transcript: 'present', desktop: { ...desktop, pauseLogged: false } }))
      .toEqual({ cause: 'user', reason: 'stopped-in-app' })
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
