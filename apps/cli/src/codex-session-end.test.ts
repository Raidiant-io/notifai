import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyCodexSessionEnd,
  codexDormantSurface,
  codexHostHoldsThread,
  codexHostKind,
  codexThreadWriterLockPath,
  codexTranscriptState,
  readCodexThreadOriginator,
  type CodexEndEvidence,
} from './codex-session-end.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function rollout(originator: string, instructions = 'short'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-end-'))
  roots.push(root)
  const file = path.join(root, 'rollout.jsonl')
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 't', originator, source: 'vscode', base_instructions: instructions } })}\n` +
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`)
  return file
}

describe('Codex SessionEnd classification', () => {
  const app: CodexEndEvidence = { transcript: 'present', host: 'alive', originator: 'Codex Desktop', hostKind: 'app-server' }

  it.each<[string, CodexEndEvidence, ReturnType<typeof classifyCodexSessionEnd>]>([
    ['an archived or deleted conversation is closed', { ...app, transcript: 'missing' }, { state: 'ended', reason: 'session-archived' }],
    ['a quit app (its server gone) closes the conversation', { ...app, host: 'gone' }, { state: 'ended', reason: 'harness-gone' }],
    ['an app conversation unloaded while the app runs stays open', app, { state: 'dormant-open', surface: 'app' }],
    ['so does one from the newer Codex app', { ...app, originator: 'codex_work_desktop' }, { state: 'dormant-open', surface: 'app' }],
    ['and one from the IDE extension', { ...app, originator: 'codex_vscode' }, { state: 'dormant-open', surface: 'ide' }],
    ['a CLI conversation unloaded by the shared server is closed', { ...app, originator: 'codex-tui', hostKind: 'other' }, { state: 'ended', reason: 'session-end-hook' }],
    ['even when it looks like an app-server', { ...app, originator: 'codex-tui' }, { state: 'ended', reason: 'session-end-hook' }],
    ['an app conversation a terminal took over and closed is closed', { ...app, hostKind: 'other' }, { state: 'ended', reason: 'session-end-hook' }],
    ['another app-server client is closed', { ...app, originator: 'orca_desktop' }, { state: 'ended', reason: 'session-end-hook' }],
    ['an unreadable originator is closed', { ...app, originator: null }, { state: 'ended', reason: 'session-end-hook' }],
    ['an unknown host is closed', { ...app, hostKind: 'unknown' }, { state: 'ended', reason: 'session-end-hook' }],
    ['archive wins over everything', { ...app, transcript: 'missing', host: 'gone' }, { state: 'ended', reason: 'session-archived' }],
  ])('%s', (_name, evidence, verdict) => {
    expect(classifyCodexSessionEnd(evidence)).toEqual(verdict)
  })

  it('names only the app and IDE originators as surfaces that keep a conversation open', () => {
    expect(codexDormantSurface('Codex Desktop')).toBe('app')
    expect(codexDormantSurface('codex_vscode')).toBe('ide')
    for (const other of ['codex-tui', 'codex_exec', 'orca_desktop', 'T3 Code', null]) expect(codexDormantSurface(other)).toBeNull()
  })

  it('reads the originator from the rollout\'s first line, however long its instructions', () => {
    expect(readCodexThreadOriginator(rollout('Codex Desktop'))).toBe('Codex Desktop')
    expect(readCodexThreadOriginator(rollout('codex-tui', 'x'.repeat(300_000)))).toBe('codex-tui')
  })

  it('reads no originator from a missing, empty or foreign file', () => {
    expect(readCodexThreadOriginator(undefined)).toBeNull()
    expect(readCodexThreadOriginator(path.join(os.tmpdir(), 'notifai-no-such-rollout.jsonl'))).toBeNull()
    const file = rollout('Codex Desktop')
    writeFileSync(file, '{"type":"event_msg","payload":{"originator":"Codex Desktop"}}\n')
    expect(readCodexThreadOriginator(file)).toBeNull()
    writeFileSync(file, '')
    expect(readCodexThreadOriginator(file)).toBeNull()
  })

  it('tells a present rollout from a moved one, and knows when none was named', () => {
    const file = rollout('Codex Desktop')
    expect(codexTranscriptState(file)).toBe('present')
    rmSync(file)
    expect(codexTranscriptState(file)).toBe('missing')
    expect(codexTranscriptState(undefined)).toBe('unknown')
  })

  it('does not take an ordinary process for an app-server', () => {
    expect(codexHostKind(process.pid)).toBe(process.platform === 'win32' ? 'unknown' : 'other')
  })
})

describe('Codex thread writer lock', () => {
  const THREAD = '01a15732-d133-7602-9f11-cbee134b7ba0'

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'tells the process holding a thread\'s writer lock open from any other, and a released lock from a held one', async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-lock-'))
      roots.push(home)
      const lock = codexThreadWriterLockPath(home, THREAD)
      expect(lock).toBe(path.join(home, 'thread-writer-locks', `${THREAD}.lock`))
      expect(codexHostHoldsThread(home, THREAD, process.pid)).toBe(false) // no lock file yet
      mkdirSync(path.dirname(lock), { recursive: true })
      writeFileSync(lock, '')
      // A stand-in host: a shell that keeps the lock open, as Codex does while the thread is loaded.
      const host = spawn('/bin/sh', ['-c', 'exec 9<>"$0"; exec sleep 30', lock], { stdio: 'ignore' })
      try {
        let held = false
        for (let i = 0; i < 100 && !held; i += 1) {
          held = codexHostHoldsThread(home, THREAD, host.pid!)
          if (!held) await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(held).toBe(true)
        expect(codexHostHoldsThread(home, THREAD, process.pid)).toBe(false)
        expect(codexHostHoldsThread(home, '01a15732-0000-0000-0000-000000000000', host.pid!)).toBe(false)
      } finally {
        host.kill('SIGKILL')
      }
      await new Promise((resolve) => host.once('exit', resolve))
      expect(codexHostHoldsThread(home, THREAD, host.pid!)).toBe(false)
    })

  it('cannot tell on Windows, so a reload there is never assumed', () => {
    expect(codexHostHoldsThread(null, THREAD, process.pid, 'win32')).toBe(false)
  })
})
