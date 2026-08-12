import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConnection } from 'node:net'
import type {
  ContinuationEvent,
  EscalationDeliveryRoute,
  HookOutcome,
} from './hooks.js'

/** Claude Code's currently observed inbox protocol. Unknown versions fail closed. */
export const CLAUDE_PEER_PROTOCOL = 1

/** macOS verifies own-child ancestry only while the posting process is alive. */
export const CLAUDE_POST_SEND_LIVENESS_MS = 8_000

export type ClaudeLiveStatus = 'idle' | 'busy'

export interface ClaudeSessionDescriptor {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart: string
  version: string
  peerProtocol: number
  messagingSocketPath: string
  status: string
}

export interface ClaudeAgentObservation {
  pid: number
  sessionId: string
  startedAt: number
  status: string
}

export interface ClaudeWakeAdapters {
  listAgents(): Promise<unknown>
  readDescriptor(pid: number): unknown
  sendSocket(socketPath: string, line: string): Promise<void>
  resume(sessionId: string, cwd: string, context: string): Promise<void>
  sleep(milliseconds: number): Promise<void>
}

export type ClaudeWakeObservation =
  | {
      state: 'live-idle' | 'live-busy'
      descriptor: ClaudeSessionDescriptor
    }
  | { state: 'stopped' }
  | { state: 'unknown'; reason: string }

const LIVE_STATUSES: ReadonlySet<string> = new Set(['idle', 'busy'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAgent(value: unknown): ClaudeAgentObservation | null {
  if (!isRecord(value)) return null
  if (
    typeof value['pid'] !== 'number' ||
    !Number.isInteger(value['pid']) ||
    value['pid'] <= 0 ||
    typeof value['sessionId'] !== 'string' ||
    value['sessionId'] === '' ||
    typeof value['startedAt'] !== 'number' ||
    !Number.isFinite(value['startedAt']) ||
    typeof value['status'] !== 'string'
  ) {
    return null
  }
  return {
    pid: value['pid'],
    sessionId: value['sessionId'],
    startedAt: value['startedAt'],
    status: value['status'],
  }
}

function parseDescriptor(value: unknown): ClaudeSessionDescriptor | null {
  if (!isRecord(value)) return null
  if (
    typeof value['pid'] !== 'number' ||
    !Number.isInteger(value['pid']) ||
    value['pid'] <= 0 ||
    typeof value['sessionId'] !== 'string' ||
    value['sessionId'] === '' ||
    typeof value['cwd'] !== 'string' ||
    value['cwd'] === '' ||
    typeof value['startedAt'] !== 'number' ||
    !Number.isFinite(value['startedAt']) ||
    typeof value['procStart'] !== 'string' ||
    value['procStart'] === '' ||
    typeof value['version'] !== 'string' ||
    value['version'] === '' ||
    typeof value['peerProtocol'] !== 'number' ||
    !Number.isInteger(value['peerProtocol']) ||
    typeof value['messagingSocketPath'] !== 'string' ||
    value['messagingSocketPath'] === '' ||
    typeof value['status'] !== 'string'
  ) {
    return null
  }
  return {
    pid: value['pid'],
    sessionId: value['sessionId'],
    cwd: value['cwd'],
    startedAt: value['startedAt'],
    procStart: value['procStart'],
    version: value['version'],
    peerProtocol: value['peerProtocol'],
    messagingSocketPath: value['messagingSocketPath'],
    status: value['status'],
  }
}

/**
 * Observe one exact Claude Code session without guessing.
 *
 * `claude agents --json` is the liveness oracle: Claude Code itself validates
 * each registry row against both PID and process start time before returning it.
 * The descriptor supplies the socket and peer protocol, but is never trusted as
 * proof that a process still owns the session.
 */
export async function observeClaudeSession(
  sessionId: string,
  adapters: Pick<ClaudeWakeAdapters, 'listAgents' | 'readDescriptor'>,
): Promise<ClaudeWakeObservation> {
  let listed: unknown
  try {
    listed = await adapters.listAgents()
  } catch (err) {
    return {
      state: 'unknown',
      reason: `claude agents probe failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!Array.isArray(listed)) {
    return { state: 'unknown', reason: 'claude agents returned an invalid document' }
  }

  const matchingRaw = listed.filter(
    (value) => isRecord(value) && value['sessionId'] === sessionId,
  )
  if (matchingRaw.length === 0) return { state: 'stopped' }
  if (matchingRaw.length !== 1) {
    return { state: 'unknown', reason: 'claude agents returned duplicate session owners' }
  }
  const agent = parseAgent(matchingRaw[0])
  if (agent === null) {
    return { state: 'unknown', reason: 'claude agents returned an invalid matching row' }
  }

  let descriptorRaw: unknown
  try {
    descriptorRaw = adapters.readDescriptor(agent.pid)
  } catch (err) {
    return {
      state: 'unknown',
      reason: `Claude session descriptor could not be read: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const descriptor = parseDescriptor(descriptorRaw)
  if (descriptor === null) {
    return { state: 'unknown', reason: 'Claude session descriptor has an unknown shape' }
  }
  if (
    descriptor.pid !== agent.pid ||
    descriptor.sessionId !== agent.sessionId ||
    descriptor.startedAt !== agent.startedAt
  ) {
    return { state: 'unknown', reason: 'Claude liveness probe and descriptor disagree' }
  }
  if (descriptor.peerProtocol !== CLAUDE_PEER_PROTOCOL) {
    return {
      state: 'unknown',
      reason: `unsupported Claude peer protocol ${descriptor.peerProtocol}`,
    }
  }
  if (!LIVE_STATUSES.has(agent.status)) {
    return { state: 'unknown', reason: `Claude session status ${agent.status} is not wakeable` }
  }
  return {
    state: agent.status === 'idle' ? 'live-idle' : 'live-busy',
    descriptor,
  }
}

function socketLine(context: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: context },
  })}\n`
}

/**
 * Claude's own-child delivery route.
 *
 * A successful socket write proves delivery to Claude Code, not model
 * consumption. The accepted journal remains until a successor Stop proves the
 * continued turn ran. Unknown state deliberately returns without throwing so
 * the journal becomes `hold-for-next-turn` instead of failing the hook.
 */
export function claudeWakeRoute(options: {
  sessionId: string
  cwd: string
  sourcePid: number
  adapters?: ClaudeWakeAdapters
}): EscalationDeliveryRoute {
  const adapters = options.adapters ?? systemClaudeWakeAdapters()
  let sourceDescriptor: ClaudeSessionDescriptor | null = null
  try {
    const parsed = parseDescriptor(adapters.readDescriptor(options.sourcePid))
    if (
      parsed !== null &&
      parsed.sessionId === options.sessionId &&
      parsed.pid === options.sourcePid
    ) {
      sourceDescriptor = parsed
    }
  } catch {
    // Delivery fails closed below; route construction must never break the hook.
  }
  return {
    kind: 'inbox-socket',
    async deliver(event: ContinuationEvent): Promise<HookOutcome> {
      const observation = await observeClaudeSession(options.sessionId, adapters)
      if (observation.state === 'unknown') {
        return {
          notes: [`holding the accepted answer for the next turn: ${observation.reason}`],
          log: { route: 'hold-for-next-turn', stage: 'queued', reason: observation.reason },
        }
      }
      if (sourceDescriptor === null) {
        const reason = 'the Stop-hook process cannot prove exact Claude session ownership'
        return {
          notes: [`holding the accepted answer for the next turn: ${reason}`],
          log: { route: 'hold-for-next-turn', stage: 'queued', reason },
        }
      }
      if (observation.state === 'stopped') {
        // Probe immediately before spawn. A prior descriptor or dead socket is
        // never sufficient: resuming a live session creates a divergent ghost.
        const confirmed = await observeClaudeSession(options.sessionId, adapters)
        if (confirmed.state !== 'stopped') {
          const reason =
            confirmed.state === 'unknown'
              ? confirmed.reason
              : 'the Claude session became live before cold resume'
          return {
            notes: [`holding the accepted answer for the next turn: ${reason}`],
            log: { route: 'hold-for-next-turn', stage: 'queued', reason },
          }
        }
        await adapters.resume(options.sessionId, sourceDescriptor.cwd, event.context)
        return {
          notes: ['cold-resumed the stopped Claude session with its accepted answer'],
          log: { route: 'cold-resume', stage: 'delivered' },
        }
      }

      if (
        observation.descriptor.pid !== options.sourcePid ||
        sourceDescriptor.startedAt !== observation.descriptor.startedAt
      ) {
        const reason = 'the Stop-hook process is not the observed exact Claude session child'
        return {
          notes: [`holding the accepted answer for the next turn: ${reason}`],
          log: { route: 'hold-for-next-turn', stage: 'queued', reason },
        }
      }
      await adapters.sendSocket(
        observation.descriptor.messagingSocketPath,
        socketLine(event.context),
      )
      await adapters.sleep(CLAUDE_POST_SEND_LIVENESS_MS)
      return {
        notes: [
          observation.state === 'live-idle'
            ? 'posted the accepted answer to the live Claude session'
            : 'queued the accepted answer for the busy Claude session',
        ],
        log: {
          route: 'inbox-socket',
          stage: 'delivered',
          session_state: observation.state,
        },
      }
    },
  }
}

function runClaude(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString())
        return
      }
      reject(
        new Error(
          `claude ${args[0] ?? ''} exited ${code === null ? `on ${String(signal)}` : String(code)}: ${Buffer.concat(stderr).toString().trim()}`,
        ),
      )
    })
  })
}

function coldResumeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of Object.keys(next)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key.startsWith('CLAUDE_CODE_')) {
      delete next[key]
    }
  }
  return next
}

export function systemClaudeWakeAdapters(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeWakeAdapters {
  return {
    async listAgents() {
      const output = await runClaude(['agents', '--json'], { env })
      return JSON.parse(output) as unknown
    },
    readDescriptor(pid) {
      const file = path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`)
      return JSON.parse(readFileSync(file, 'utf8')) as unknown
    },
    sendSocket(socketPath, line) {
      return new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath)
        let settled = false
        const fail = (err: Error): void => {
          if (settled) return
          settled = true
          socket.destroy()
          reject(err)
        }
        socket.once('error', fail)
        socket.once('connect', () => {
          socket.end(line, () => {
            if (settled) return
            settled = true
            resolve()
          })
        })
      })
    },
    async resume(sessionId, cwd, context) {
      if (!existsSync(cwd)) throw new Error(`Claude session cwd no longer exists: ${cwd}`)
      await runClaude(
        [
          '-p',
          '--resume',
          sessionId,
          '--output-format',
          'json',
          context,
        ],
        { cwd, env: coldResumeEnvironment(env) },
      )
    },
    sleep(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds))
    },
  }
}
