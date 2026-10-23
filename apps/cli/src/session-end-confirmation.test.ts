import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
import { claudeDescriptorDir } from './claude-wake.js'
import type { HookMaintenanceLaunch } from './hook-maintenance.js'
import {
  beginSessionIncarnation,
  concludeEndCandidate,
  endCandidatePath,
  lifecycleStamp,
  readSessionEndMarker,
  readSessionState,
  recordSessionStart,
  sessionStatePath,
  updateSessionState,
} from './hook-session-state.js'
import { END_CONFIRM_MS } from './hub.js'
import { encodeFrame, FrameDecoder, hubRunDir, hubSocketPath } from './hub-ipc.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { attendantClaimPath } from './session-attendant-state.js'
import { nullLogger } from './logging.js'
import { processStartTime } from './process-identity.js'
import { confirmSessionEnds, END_CONFIRMATION_MS, type EndConfirmationSeams } from './session-end-confirmation.js'

const SESSION = '33333333-4444-5555-6666-777777777777'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** No hub runs in this environment: nothing listens on its socket. */
function fixture(harness: 'codex' | 'claude-code', options: { sourcePid?: number } = {}) {
  // Short root: the hub socket path must fit in a Unix socket path.
  const root = mkdtempSync(path.join('/tmp', 'nfend-'))
  roots.push(root)
  mkdirSync(path.join(root, 'claude', 'sessions'), { recursive: true })
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), NOTIFAI_CREDENTIALS: 'file',
    NOTIFAI_HOOK_SOURCE_PID: String(options.sourcePid ?? process.pid),
  }
  const launches: HookMaintenanceLaunch[] = []
  const retirements: HookMaintenanceLaunch[] = []
  const deps: CommandDeps = {
    io: { out: () => undefined, err: () => undefined, confirm: async () => false, openUrl: () => undefined },
    store: { load: () => null, save: () => undefined, clear: () => undefined, describe: () => 'none' },
    env, cwd: root, logger: nullLogger(), hookPlatform: 'darwin',
    spawnEndConfirmation: (launch) => { launches.push(launch) },
    spawnRetirement: (launch) => { retirements.push(launch) },
  }
  beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: { pid: process.pid, start: processStartTime(process.pid)! } })
  updateSessionState(SESSION, env, (state) => ({ ...state, harness, pending: [{ question: 'Deploy?', request_id: 'req_deploy',
    collapse_key: 'collapse-deploy', device_ids: ['dev_phone'] } as never] }))
  const sessionEnd = () => hookRunCommand(deps, 'session-end', async () => JSON.stringify({ session_id: SESSION, cwd: root,
    hook_event_name: 'SessionEnd', reason: 'other' }), harness)
  return { root, env, deps, launches, retirements, sessionEnd }
}

const NO_RESTART: EndConfirmationSeams = { confirmationMs: 0, codexThreadHolders: () => [], shutdownUnderway: () => false }

describe('SessionEnd without a hub', () => {
  it('waits for the end confirmation instead of ending a session with open questions', async () => {
    const f = fixture('claude-code')
    expect(await f.sessionEnd()).toBe(0)
    expect(f.launches).toEqual([expect.objectContaining({ harness: 'claude-code' })])
    expect(existsSync(endCandidatePath(SESSION, f.env))).toBe(true)
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
    expect(readSessionState(SESSION, f.env).pending).toHaveLength(1)
  })

  it('preserves questions when its confirmation process cannot start', async () => {
    const f = fixture('codex')
    f.deps.spawnEndConfirmation = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    await f.sessionEnd()
    expect(existsSync(endCandidatePath(SESSION, f.env))).toBe(true)
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
    expect(readSessionState(SESSION, f.env).pending).toHaveLength(1)
  })

  it('does not read a truncated state as nothing waiting', async () => {
    const f = fixture('claude-code')
    writeFileSync(sessionStatePath(SESSION, f.env), '{"pending":')
    await f.sessionEnd()
    expect(await confirmSessionEnds(f.deps, { wait: false }, NO_RESTART)).toMatchObject({ ended: 0, deferred: 1 })
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
    expect(readFileSync(sessionStatePath(SESSION, f.env), 'utf8')).toBe('{"pending":')
  })

  it('ends at once when closing loses nothing', async () => {
    const f = fixture('codex')
    updateSessionState(SESSION, f.env, (state) => { const next = { ...state }; delete next.pending; return next })
    await f.sessionEnd()
    expect(f.launches).toEqual([])
    expect(readSessionEndMarker(SESSION, f.env)).not.toBeNull()
  })

  it('defers an unconfirmed end while a question still waits', async () => {
    const f = fixture('claude-code')
    await f.sessionEnd()
    expect(await confirmSessionEnds(f.deps, { wait: false }, NO_RESTART)).toEqual({ ended: 0, kept: 0, deferred: 1, superseded: 0 })
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
    expect(readSessionState(SESSION, f.env).pending).toHaveLength(1)
    expect(f.retirements).toEqual([])
  })

  it('keeps a session that started again within the confirmation', async () => {
    const f = fixture('codex')
    await f.sessionEnd()
    // A reload in the same process: SessionStart joins the same incarnation.
    recordSessionStart(SESSION, f.env, 'codex', f.root)
    expect(existsSync(endCandidatePath(SESSION, f.env))).toBe(false)
    expect(await confirmSessionEnds(f.deps, { wait: false }, NO_RESTART)).toEqual({ ended: 0, kept: 0, deferred: 0, superseded: 0 })
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
    expect(readSessionState(SESSION, f.env).pending).toHaveLength(1)
  })

  it('keeps a session another process started a new incarnation of', async () => {
    const f = fixture('codex')
    await f.sessionEnd()
    beginSessionIncarnation(SESSION, f.env, { stamp: lifecycleStamp(), clearEarlierEnd: false,
      harnessProcess: { pid: process.ppid, start: processStartTime(process.ppid)! } })
    expect(await confirmSessionEnds(f.deps, { wait: false }, NO_RESTART)).toEqual({ ended: 0, kept: 1, deferred: 0, superseded: 0 })
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
    expect(existsSync(endCandidatePath(SESSION, f.env))).toBe(false)
  })

  it('keeps a Codex thread a live process holds again, and preserves one whose holder cannot be read', async () => {
    const held = fixture('codex')
    await held.sessionEnd()
    expect(await confirmSessionEnds(held.deps, { wait: false }, { ...NO_RESTART, codexThreadHolders: () => [process.ppid] }))
      .toEqual({ ended: 0, kept: 1, deferred: 0, superseded: 0 })
    expect(readSessionState(SESSION, held.env).pending).toHaveLength(1)
    // Windows: the writer lock's holders are unknown, which is no evidence.
    const unreadable = fixture('codex')
    await unreadable.sessionEnd()
    expect(await confirmSessionEnds(unreadable.deps, { wait: false }, { ...NO_RESTART, codexThreadHolders: () => 'unknown' }))
      .toEqual({ ended: 0, kept: 0, deferred: 1, superseded: 0 })
    expect(readSessionEndMarker(SESSION, unreadable.env)).toBeNull()
  })

  it('keeps a Claude Code conversation another live process still has open, not one only the ending process names', async () => {
    const writeDescriptor = (env: NodeJS.ProcessEnv, pid: number) => writeFileSync(path.join(claudeDescriptorDir(env), `${pid}.json`),
      JSON.stringify({ pid, sessionId: SESSION, cwd: '/tmp', startedAt: Date.now(), procStart: processStartTime(pid), version: '2.1.304',
        peerProtocol: 1, messagingSocketPath: '/tmp/nfend-inbox.sock', status: 'idle' }))
    const seams = { confirmationMs: 0, shutdownUnderway: () => false }
    // The process that ran SessionEnd (this one) still names the conversation.
    const alone = fixture('claude-code')
    writeDescriptor(alone.env, process.pid)
    await alone.sessionEnd()
    expect(await confirmSessionEnds(alone.deps, { wait: false }, seams)).toEqual({ ended: 0, kept: 0, deferred: 1, superseded: 0 })
    // Another live process has it open too.
    const elsewhere = fixture('claude-code')
    writeDescriptor(elsewhere.env, process.pid)
    writeDescriptor(elsewhere.env, process.ppid)
    await elsewhere.sessionEnd()
    expect(await confirmSessionEnds(elsewhere.deps, { wait: false }, seams)).toEqual({ ended: 0, kept: 1, deferred: 0, superseded: 0 })
    expect(readSessionState(SESSION, elsewhere.env).pending).toHaveLength(1)
    expect(readSessionEndMarker(SESSION, elsewhere.env)).toBeNull()
  })

  it('leaves alone an end another confirmation process decided meanwhile', async () => {
    const f = fixture('codex')
    await f.sessionEnd()
    const since = JSON.parse(readFileSync(endCandidatePath(SESSION, f.env), 'utf8')).since
    // Another process concludes the same candidate while this one gathers evidence.
    const racing = { ...NO_RESTART, codexThreadHolders: () => {
      expect(concludeEndCandidate(SESSION, f.env, since, Date.now())).not.toBeNull()
      return []
    } }
    expect(await confirmSessionEnds(f.deps, { wait: false }, racing)).toEqual({ ended: 0, kept: 0, deferred: 0, superseded: 1 })
    expect(f.retirements).toEqual([])
    expect(readSessionEndMarker(SESSION, f.env)).not.toBeNull()
  })

  it('leaves the end undecided while the machine shuts down', async () => {
    const f = fixture('codex')
    await f.sessionEnd()
    expect(await confirmSessionEnds(f.deps, { wait: false }, { ...NO_RESTART, shutdownUnderway: () => true }))
      .toEqual({ ended: 0, kept: 0, deferred: 1, superseded: 0 })
    expect(existsSync(endCandidatePath(SESSION, f.env))).toBe(true)
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
  })

  it('waits out the confirmation before deciding', async () => {
    const f = fixture('codex')
    await f.sessionEnd()
    const seams = { ...NO_RESTART, confirmationMs: 1_000 }
    expect(await confirmSessionEnds(f.deps, { wait: false }, seams)).toEqual({ ended: 0, kept: 0, deferred: 0, superseded: 0 })
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
    expect(await confirmSessionEnds(f.deps, { wait: true }, seams)).toEqual({ ended: 0, kept: 0, deferred: 1, superseded: 0 })
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
  })

  it('uses the hub\'s end confirmation', () => {
    expect(END_CONFIRMATION_MS).toBe(END_CONFIRM_MS)
  })
})

describe('SessionEnd a slow hub attends', () => {
  /** A hub that attends the session and answers its first end request only after the hook gave up on it. */
  async function slowHub(env: NodeJS.ProcessEnv, firstReplyMs: number): Promise<{ server: Server; requests: string[] }> {
    mkdirSync(hubRunDir(env), { recursive: true, mode: 0o700 })
    acquireClaimFile(attendantClaimPath(SESSION, env), { role: 'hub' })
    const requests: string[] = []
    const server = createServer((socket) => {
      const decoder = new FrameDecoder()
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame['type'] === 'hello') continue
          requests.push(String(frame['type']))
          const reply = (): void => { socket.end(encodeFrame({ type: 'ok', held: true })) }
          if (requests.length === 1) setTimeout(reply, firstReplyMs)
          else reply()
        }
      })
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server.listen(hubSocketPath(env), resolve))
    return { server, requests }
  }

  it('leaves the decision to the hub, which classifies stops, instead of ending the session itself', async () => {
    const f = fixture('claude-code')
    const hub = await slowHub(f.env, 1_500)
    try {
      expect(await f.sessionEnd()).toBe(0)
      // The hook gave up on the hub after 800 ms and opened its own candidate.
      expect(f.launches).toEqual([expect.objectContaining({ harness: 'claude-code' })])
      expect(await confirmSessionEnds(f.deps, { wait: false }, NO_RESTART)).toEqual({ ended: 0, kept: 0, deferred: 0, superseded: 1 })
      // Handed back to the hub; nothing expired, nothing told the hub the session ended.
      expect(hub.requests).toEqual(['session-end-candidate', 'session-end-candidate'])
      expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
      expect(readSessionState(SESSION, f.env).pending).toHaveLength(1)
      expect(existsSync(endCandidatePath(SESSION, f.env))).toBe(false)
      expect(f.retirements).toEqual([])
    } finally {
      hub.server.close()
    }
  })

  it('waits, deciding nothing, while the attending hub does not answer', async () => {
    const f = fixture('codex')
    await f.sessionEnd()
    expect(await confirmSessionEnds(f.deps, { wait: false }, { ...NO_RESTART, hubEndOwner: async () => 'unresponsive' }))
      .toEqual({ ended: 0, kept: 0, deferred: 1, superseded: 0 })
    expect(existsSync(endCandidatePath(SESSION, f.env))).toBe(true)
    expect(readSessionEndMarker(SESSION, f.env)).toBeNull()
  })
})
