/**
 * The window's last check, `notifai --internal-reopen-guard <record>`,
 * compiled from `launcher/main.c` and run for real.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { guardRecord } from './session-reopen.js'

const posix = process.platform !== 'win32'
let launcher = ''

beforeAll(() => {
  if (!posix) return
  const build = mkdtempSync(path.join(os.tmpdir(), 'notifai-guard-build-'))
  launcher = path.join(build, 'notifai')
  const source = fileURLToPath(new URL('../launcher/main.c', import.meta.url))
  execFileSync('cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_XOPEN_SOURCE=700',
    ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE', '-mmacosx-version-min=13.0'] : []),
    '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', launcher], { stdio: 'inherit' })
}, 120_000)

const LIVE = 'Notifai did not reopen this conversation here: it is already open somewhere else.\n'
const STALE = 'Notifai did not reopen this conversation: this window is no longer needed.\n'

function setup(harness: 'claude-code' | 'codex', options: { expiresAt?: number; allowHolder?: number | null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-guard-'))
  const directory = path.join(root, 'reopen')
  mkdirSync(directory, { mode: 0o700 })
  const home = path.join(root, harness === 'codex' ? '.codex' : '.claude')
  mkdirSync(home)
  const token = 'ab'.repeat(16)
  const record = path.join(directory, `${token}.json`)
  writeFileSync(record, guardRecord({ token, harness, sessionId: 'sess-1', home, defaultHome: home, allowHolder: options.allowHolder ?? null,
    expiresAt: options.expiresAt ?? Date.now() + 60_000 })!, { mode: 0o600 })
  /** Run the guard from a shell, as the window's script does; the shell's pid is what it should record. */
  const run = (file = record) => {
    const result = spawnSync('/bin/sh', ['-c', '"$0" --internal-reopen-guard "$1"; code=$?; echo "shell=$$"; exit $code', launcher, file], { encoding: 'utf8' })
    const shell = /shell=(\d+)/.exec(result.stdout)?.[1]
    return { code: result.status, out: result.stdout.replace(/shell=\d+\n$/, ''), shell }
  }
  return { root, home, record, pidFile: path.join(directory, `${token}.pid`), run }
}

describe.skipIf(!posix)('the reopen guard', () => {
  it('lets the window go on and names its shell, once', () => {
    const { run, pidFile } = setup('claude-code')
    const first = run()
    expect(first).toMatchObject({ code: 0, out: '' })
    expect(readFileSync(pidFile, 'utf8')).toBe(`${first.shell}\n`)
    expect(run()).toMatchObject({ code: 1, out: STALE })
  })

  it('refuses a record that is expired, renamed, readable by others or malformed', () => {
    expect(setup('claude-code', { expiresAt: Date.now() - 1 }).run()).toMatchObject({ code: 1, out: STALE })
    const renamed = setup('claude-code')
    const other = path.join(path.dirname(renamed.record), `${'cd'.repeat(16)}.json`)
    writeFileSync(other, readFileSync(renamed.record), { mode: 0o600 })
    expect(renamed.run(other)).toMatchObject({ code: 1, out: STALE })
    const open = setup('codex')
    chmodSync(open.record, 0o644)
    expect(open.run()).toMatchObject({ code: 1, out: STALE })
    const broken = setup('codex')
    writeFileSync(broken.record, '{"v":1}\n', { mode: 0o600 })
    expect(broken.run()).toMatchObject({ code: 1, out: STALE })
    expect(broken.run('relative.json')).toMatchObject({ code: 1, out: STALE })
  })

  it('refuses while a live Claude Code process has the conversation open, and not for a dead one', () => {
    const { home, run } = setup('claude-code')
    mkdirSync(path.join(home, 'sessions'))
    writeFileSync(path.join(home, 'sessions', '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'sess-1' }))
    writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), '{"pid": 1, "sessionId" : "sess-10"}')
    expect(run()).toMatchObject({ code: 0 })
    const live = setup('claude-code')
    mkdirSync(path.join(live.home, 'sessions'))
    writeFileSync(path.join(live.home, 'sessions', `${process.pid}.json`), `{"pid": ${process.pid}, "sessionId" : "sess-1", "status": "idle"}`)
    expect(live.run()).toMatchObject({ code: 1, out: LIVE })
  })

  it('refuses while another process holds the Codex thread, except the shared server the hub found unattached', () => {
    const held = setup('codex')
    mkdirSync(path.join(held.home, 'thread-writer-locks'))
    const lock = path.join(held.home, 'thread-writer-locks', 'sess-1.lock')
    writeFileSync(lock, '')
    expect(held.run()).toMatchObject({ code: 0 })
    const fd = openSync(lock, 'r')
    try {
      const again = setup('codex')
      mkdirSync(path.join(again.home, 'thread-writer-locks'))
      const busy = path.join(again.home, 'thread-writer-locks', 'sess-1.lock')
      writeFileSync(busy, '')
      const busyFd = openSync(busy, 'r')
      try {
        expect(again.run()).toMatchObject({ code: 1, out: LIVE })
        const allowed = setup('codex', { allowHolder: process.pid })
        mkdirSync(path.join(allowed.home, 'thread-writer-locks'))
        const mine = path.join(allowed.home, 'thread-writer-locks', 'sess-1.lock')
        writeFileSync(mine, '')
        const mineFd = openSync(mine, 'r')
        try { expect(allowed.run()).toMatchObject({ code: 0 }) } finally { closeSync(mineFd) }
      } finally {
        closeSync(busyFd)
      }
    } finally {
      closeSync(fd)
    }
  })
})
