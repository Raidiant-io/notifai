import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codexAppSurface,
  codexHomeOfRollout,
  codexHostHoldsThread,
  codexHostKind,
  codexSubcommand,
  codexThreadHeld,
  codexThreadWriterLockPath,
  locateCodexRollout,
  readCodexSessionMeta,
  readCodexThreadOriginator,
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

describe('Codex thread records', () => {
  const THREAD = '01a159b2-cf06-7590-a500-4917a76e96c2'

  it('names only the app and IDE originators as apps that keep a conversation open', () => {
    expect(codexAppSurface('Codex Desktop')).toBe('app')
    expect(codexAppSurface('codex_work_desktop')).toBe('app')
    expect(codexAppSurface('codex_vscode')).toBe('ide')
    for (const other of ['codex-tui', 'codex_exec', 'orca_desktop', 'T3 Code', null]) expect(codexAppSurface(other)).toBeNull()
  })

  it('reads the thread a fork came from (`forked_from_id`, as Codex 0.163.0 writes it)', () => {
    const file = rollout('codex-tui')
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'f', originator: 'codex-tui', forked_from_id: THREAD,
      history_base: { thread_id: THREAD } } })}\n`)
    expect(readCodexSessionMeta(file)).toEqual({ originator: 'codex-tui', forkedFrom: THREAD })
    expect(readCodexSessionMeta(rollout('codex-tui'))).toEqual({ originator: 'codex-tui', forkedFrom: null })
  })

  it('finds a rollout by its id where an archive or unarchive moved it, and knows when it is gone', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-home-'))
    roots.push(home)
    const live = path.join(home, 'sessions', '2026', '10', '20', `rollout-2026-10-20T07-29-00-${THREAD}.jsonl`)
    mkdirSync(path.dirname(live), { recursive: true })
    writeFileSync(live, '{}\n')
    mkdirSync(path.join(home, 'sessions', '2026', '10', '19'), { recursive: true })
    writeFileSync(path.join(home, 'sessions', '2026', '10', '19', 'rollout-2026-10-19T00-00-00-01a159b2-0000-0000-0000-000000000000.jsonl'), '{}\n')
    expect(locateCodexRollout(home, THREAD, live)).toEqual({ place: 'sessions', path: live })
    // The hook names no path, or one an earlier move left behind.
    expect(locateCodexRollout(home, THREAD, null)).toEqual({ place: 'sessions', path: live })
    // Archived: the hook still names the old path.
    const archived = path.join(home, 'archived_sessions', path.basename(live))
    mkdirSync(path.dirname(archived), { recursive: true })
    renameSync(live, archived)
    expect(locateCodexRollout(home, THREAD, live)).toEqual({ place: 'archived', path: archived })
    expect(locateCodexRollout(null, THREAD, archived)).toEqual({ place: 'archived', path: archived })
    expect(codexHomeOfRollout(archived)).toBe(home)
    expect(codexHomeOfRollout(live)).toBe(home)
    // Deleted.
    rmSync(archived)
    expect(locateCodexRollout(home, THREAD, live)).toEqual({ place: 'missing', path: null })
    // Nothing readable: unknown, never a delete.
    expect(locateCodexRollout(path.join(home, 'nowhere'), THREAD, null)).toEqual({ place: 'unknown', path: null })
    expect(locateCodexRollout(null, THREAD, null)).toEqual({ place: 'unknown', path: null })
  })

  it('tells a scripted `codex exec` run from a terminal and an app-server by its subcommand', () => {
    expect(codexSubcommand(['codex', 'exec', 'resume', THREAD])).toBe('exec')
    expect(codexSubcommand(['/opt/codex', '-c', 'model=x', '--model', 'gpt', 'exec', 'hi'])).toBe('exec')
    expect(codexSubcommand(['codex', '--no-daemon', 'resume', THREAD])).toBe('resume')
    expect(codexSubcommand(['codex', 'app-server', '--listen', 'unix://x'])).toBe('app-server')
    expect(codexSubcommand(['codex'])).toBeNull()
    expect(codexSubcommand(['codex', '-m', 'exec'])).toBeNull()
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
        expect(codexThreadHeld(home, THREAD)).toBe(true)
        expect(codexHostHoldsThread(home, THREAD, process.pid)).toBe(false)
        expect(codexHostHoldsThread(home, '01a15732-0000-0000-0000-000000000000', host.pid!)).toBe(false)
      } finally {
        host.kill('SIGKILL')
      }
      await new Promise((resolve) => host.once('exit', resolve))
      expect(codexHostHoldsThread(home, THREAD, host.pid!)).toBe(false)
      expect(codexThreadHeld(home, THREAD)).toBe(false)
    })

  it('cannot tell on Windows, so a reload there is never assumed', () => {
    expect(codexHostHoldsThread(null, THREAD, process.pid, 'win32')).toBe(false)
    const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-lock-'))
    roots.push(home)
    mkdirSync(path.join(home, 'thread-writer-locks'), { recursive: true })
    writeFileSync(codexThreadWriterLockPath(home, THREAD), '')
    expect(codexThreadHeld(home, THREAD, 'win32')).toBe('unknown')
  })
})
