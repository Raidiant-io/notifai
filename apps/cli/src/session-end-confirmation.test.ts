import { existsSync,mkdirSync,mkdtempSync,rmSync } from 'node:fs'
import { createServer,type Server } from 'node:net'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
import type { HookMaintenanceLaunch } from './hook-maintenance.js'
import { acquireClaimFile } from './hook-question-lock.js'
import {
beginSessionIncarnation,
endCandidatePath,
lifecycleStamp,
readSessionEndMarker,
readSessionState,
updateSessionState
} from './hook-session-state.js'
import { encodeFrame,FrameDecoder,hubRunDir,hubSocketPath } from './hub-ipc.js'
import { nullLogger } from './logging.js'
import { processStartTime } from './process-identity.js'
import { attendantClaimPath } from './session-attendant-state.js'
import { confirmSessionEnds,type EndConfirmationSeams } from './session-end-confirmation.js'

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
