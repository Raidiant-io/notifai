import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PutMachineSetupIssuesRequest, type MachineSetupIssue } from '@raidiant/notifai-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiCallError } from './client.js'
import { checkCodexHooksTrust, HubSetupIssues, type CodexHooksTrust } from './hub-setup-issues.js'

// Validate against the protocol's own schema dependency without adding it to the CLI runtime.
const { Value } = createRequire(import.meta.resolve('@raidiant/notifai-protocol'))('@sinclair/typebox/value')

const stops: (() => Promise<void>)[] = []
const roots: string[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(checkTrust: CodexHooksTrust = async () => true) {
  let now = 0
  const snapshots: MachineSetupIssue[][] = []
  const client = {
    features: vi.fn(async (): Promise<unknown> => ({ features: ['setup_issues'] })),
    putMachineSetupIssues: vi.fn(async (body: { issues: MachineSetupIssue[] }) => {
      expect(Value.Check(PutMachineSetupIssuesRequest, body)).toBe(true)
      snapshots.push(structuredClone(body.issues))
      return { ok: true as const }
    }),
  }
  const trust = vi.fn(checkTrust)
  let connection = { client: { ...client, features: async () => await client.features() as { features: string[] } }, key: 'machine:1', signal: new AbortController().signal }
  const reporter = new HubSetupIssues({ now: () => now, connection: () => connection, checkTrust: trust })
  stops.push(() => reporter.stop())
  const env = { HOME: path.resolve(os.tmpdir(), 'setup-account'), CODEX_HOME: path.resolve(os.tmpdir(), 'setup-account', '.codex') }
  return { reporter, env, client, trust, snapshots,
    advance: (ms: number) => { now += ms; reporter.tick() },
    rekey: () => { connection = { ...connection, key: 'machine:2' }; reporter.tick() },
  }
}

const reported = async (f: ReturnType<typeof fixture>, predicate: (issues: MachineSetupIssue[]) => boolean) =>
  vi.waitFor(() => expect(f.snapshots.some(predicate)).toBe(true))

it('groups sessions by their own Codex home, hides the account path, and removes ended sessions from snapshots', async () => {
  const f = fixture()
  const other = { ...f.env, CODEX_HOME: path.join(f.env.HOME, '.t3', 'work') }
  f.reporter.attend('one', f.env, '/work', 'terminal')
  f.reporter.attend('two', f.env, '/work', 'terminal')
  f.reporter.attend('three', other, '/other-work', 't3')
  await reported(f, (issues) => issues.length === 2 && issues.some((issue) => issue.session_ids.length === 2))
  const snapshot = f.snapshots.at(-1)!
  expect(snapshot.map((issue) => issue.params.codex_home).sort()).toEqual(['~/.codex', '~/.t3/work'])
  expect(f.trust.mock.calls.map(([env]) => env.CODEX_HOME).sort()).toEqual([f.env.CODEX_HOME, other.CODEX_HOME].sort())
  expect(snapshot.find((issue) => issue.session_ids.includes('three'))).toMatchObject({ host: 't3', lost: ['session_notes', 'answer_wake'] })
  expect(JSON.stringify(snapshot)).not.toContain(f.env.HOME)
  const key = snapshot.find((issue) => issue.session_ids.includes('one'))!.key
  f.reporter.ended('one')
  await reported(f, (issues) => issues.some((issue) => issue.key === key && issue.session_ids.join() === 'two'))
  f.reporter.ended('two')
  f.reporter.ended('three')
  await reported(f, (issues) => issues.length === 0)
  f.reporter.attend('four', f.env, '/work', 'terminal')
  await reported(f, (issues) => issues.some((issue) => issue.key === key && issue.session_ids.join() === 'four'))
})

it('refreshes nonempty snapshots every ten minutes, clears on a clean trust check, and stays quiet otherwise', async () => {
  let pending = true
  const f = fixture(async () => pending)
  f.reporter.attend('one', f.env, '/work', 'codex-app')
  await reported(f, (issues) => issues.length === 1)
  expect(f.snapshots.at(-1)![0]).toMatchObject({ host: 'codex_app' })
  f.advance(60_000)
  await vi.waitFor(() => expect(f.trust).toHaveBeenCalledTimes(2))
  expect(f.snapshots).toHaveLength(1)
  f.advance(9 * 60_000)
  await vi.waitFor(() => expect(f.snapshots).toHaveLength(2))
  expect(f.snapshots[1]).toEqual(f.snapshots[0])
  pending = false
  f.advance(60_000)
  await reported(f, (issues) => issues.length === 0)
  const count = f.snapshots.length
  f.advance(10 * 60_000)
  await Promise.resolve()
  expect(f.snapshots).toHaveLength(count)
})

it.each(['absent', 'old-server', 'malformed'])('sends no snapshots when feature discovery is %s, including shutdown', async (mode) => {
  const f = fixture()
  f.client.features.mockImplementation(async () => {
    if (mode === 'old-server') throw new ApiCallError(404, 'not_found', 'No feature endpoint')
    return mode === 'absent' ? { features: ['session_notes'] } : { features: 'setup_issues' }
  })
  f.reporter.attend('one', f.env, '/work', 'terminal')
  await vi.waitFor(() => expect(f.client.features).toHaveBeenCalledTimes(1))
  f.advance(60_000)
  await f.reporter.stop()
  expect(f.client.putMachineSetupIssues).not.toHaveBeenCalled()
})

it('retries failed snapshots with a bound and rechecks feature support when the machine credential changes', async () => {
  const f = fixture()
  f.client.putMachineSetupIssues.mockRejectedValueOnce(new Error('offline'))
  f.reporter.attend('one', f.env, '/work', 'terminal')
  await vi.waitFor(() => expect(f.client.putMachineSetupIssues).toHaveBeenCalledTimes(1))
  f.advance(15_000)
  await Promise.resolve()
  expect(f.client.putMachineSetupIssues).toHaveBeenCalledTimes(1)
  f.advance(15_000)
  await reported(f, (issues) => issues.length === 1)
  f.rekey()
  await vi.waitFor(() => expect(f.client.features).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(f.snapshots).toHaveLength(2))
})

it('clears a possibly accepted report even when its response was lost', async () => {
  const f = fixture()
  f.client.putMachineSetupIssues.mockRejectedValueOnce(new Error('response lost after commit'))
  f.reporter.attend('one', f.env, '/work', 'terminal')
  await vi.waitFor(() => expect(f.client.putMachineSetupIssues).toHaveBeenCalledTimes(1))
  f.reporter.ended('one')
  f.advance(30_000)
  await reported(f, (issues) => issues.length === 0)
})

it('clears the whole home on a hook, ignores late trust checks, and raises a new episode after a later unhooked send', async () => {
  let finish: ((pending: boolean) => void) | undefined
  const f = fixture(async () => await new Promise<boolean>((resolve) => { finish = resolve }))
  f.reporter.attend('one', f.env, '/work', 'terminal')
  f.reporter.attend('two', f.env, '/work', 'terminal')
  f.reporter.hooked(f.env)
  finish!(true)
  await Promise.resolve()
  expect(f.snapshots).toEqual([])
  f.trust.mockResolvedValue(true)
  f.reporter.attend('three', f.env, '/work', 'terminal')
  await reported(f, (issues) => issues[0]?.session_ids.join() === 'three')
  f.reporter.hooked(f.env)
  await reported(f, (issues) => issues.length === 0)
})

it('cancels an in-flight report before sending the empty graceful-exit snapshot', async () => {
  const f = fixture()
  let aborted = false
  f.client.putMachineSetupIssues.mockImplementationOnce(async (_body, options: { signal: AbortSignal }) => {
    await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
    throw new Error('cancelled')
  })
  f.reporter.attend('one', f.env, '/work', 'terminal')
  await vi.waitFor(() => expect(f.client.putMachineSetupIssues).toHaveBeenCalledTimes(1))
  await f.reporter.stop()
  expect(aborted).toBe(true)
  expect(f.snapshots).toEqual([[]])
  expect(f.client.putMachineSetupIssues).toHaveBeenCalledTimes(2)
})

it('times out unknown trust and retries later without creating a warning', async () => {
  vi.useFakeTimers()
  const f = fixture(async () => await new Promise(() => undefined))
  f.reporter.attend('one', f.env, '/work', 'terminal')
  await vi.advanceTimersByTimeAsync(6_000)
  expect(f.client.putMachineSetupIssues).not.toHaveBeenCalled()
  f.trust.mockResolvedValue(true)
  f.advance(60_000)
  await vi.waitFor(() => expect(f.snapshots.at(-1)).toHaveLength(1))
})

it('keeps external absolute paths intact and rejects unreportable names and paths before diagnosis', async () => {
  const f = fixture()
  const outside = path.resolve(os.tmpdir(), 'external-codex')
  f.reporter.attend('outside', { ...f.env, CODEX_HOME: outside }, '/work', 'terminal')
  f.reporter.attend('bad\nsession', f.env, '/work', 'terminal')
  f.reporter.attend('too-long', { ...f.env, CODEX_HOME: path.join(f.env.HOME, 'x'.repeat(513)) }, '/work', 'terminal')
  f.reporter.attend('bad-home', { ...f.env, CODEX_HOME: path.join(f.env.HOME, 'bad\nfolder') }, '/work', 'terminal')
  await reported(f, (issues) => issues.length === 1)
  expect(f.snapshots.at(-1)![0]!.params.codex_home).toBe(outside)
  expect(f.trust).toHaveBeenCalledTimes(1)
})

it('bounds concurrent trust checks and reports within server limits without guessing about unknown trust', async () => {
  const finishes: ((pending: boolean | null) => void)[] = []
  const f = fixture(async () => await new Promise<boolean | null>((resolve) => { finishes.push(resolve) }))
  for (let i = 0; i < 35; i += 1) {
    const env = { ...f.env, CODEX_HOME: path.join(f.env.HOME, `codex-${i}`) }
    f.reporter.attend(`session-${i}`, env, '/work', 'terminal')
  }
  expect(f.trust).toHaveBeenCalledTimes(2)
  // Unknown homes add no warnings; the next two homes get a turn.
  finishes.splice(0).forEach((finish) => finish(null))
  await vi.waitFor(() => expect(f.trust).toHaveBeenCalledTimes(4))
  for (let batch = 0; batch < 15; batch += 1) {
    const calls = f.trust.mock.calls.length
    finishes.splice(0).forEach((finish) => finish(true))
    if (calls < 32) await vi.waitFor(() => expect(f.trust).toHaveBeenCalledTimes(calls + 2))
  }
  await vi.waitFor(() => expect(f.snapshots.at(-1)).toHaveLength(30))
  expect(f.trust).toHaveBeenCalledTimes(32)
  for (let i = 0; i < 105; i += 1) f.reporter.attend(`extra-${i}`, { ...f.env, CODEX_HOME: path.join(f.env.HOME, 'codex-2') }, '/work', 'terminal')
  await vi.waitFor(() => expect(f.snapshots.at(-1)!.find((issue) => issue.params.codex_home === '~/codex-2')!.session_ids).toHaveLength(100))
})

it('uses the installed hooks trust reader without writing approval, and keeps missing hooks inconclusive', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'setup-trust-'))
  roots.push(root)
  const home = path.join(root, '.codex')
  mkdirSync(home)
  const env = { HOME: root, CODEX_HOME: home }
  expect(await checkCodexHooksTrust(env, root, async () => null)).toBeNull()
  writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '/x/notifai hook session-start --harness codex' }] }],
  } }))
  expect(await checkCodexHooksTrust(env, root, async () => null)).toBe(true)
  const source = path.join(home, 'hooks.json')
  const row = { key: `${source}:session_start:0:0`, eventName: 'sessionStart', sourcePath: source, enabled: true, currentHash: 'sha256:test', trustStatus: 'trusted' }
  expect(await checkCodexHooksTrust(env, root, async () => [row])).toBe(false)
  expect(await checkCodexHooksTrust(env, root, async () => [{ ...row, enabled: false }])).toBeNull()
})
