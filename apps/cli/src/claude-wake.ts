import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConnection } from 'node:net'
import type {
  ContinuationEvent,
  DeliveryOutcome,
  EscalationDeliveryRoute,
} from './hooks.js'

/** Claude Code's currently observed inbox protocol. Unknown versions fail closed. */
export const CLAUDE_PEER_PROTOCOL = 1

/** The first Claude Code release that publishes a session inbox socket. */
export const CLAUDE_MIN_INBOX_VERSION = '2.1.224'

/** The inbox socket is a Unix domain socket; no Windows implementation exists. */
const INBOX_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'linux'])

/** macOS verifies own-child ancestry only while the posting process is alive. */
export const CLAUDE_POST_SEND_LIVENESS_MS = 8_000

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

export type ClaudeInboxReadiness =
  | { state: 'ready'; socketPath: string; version: string }
  | { state: 'unavailable'; reason: string }

/** Ordered comparison of dotted release numbers, ignoring any suffix. */
function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): number[] =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(version)
  const right = parse(minimum)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

/**
 * Whether an answer could reach this exact Claude session over its inbox
 * socket, decided from evidence already on disk.
 *
 * Read-only by construction: it reads the session descriptor and asks whether
 * the socket file exists, and never connects to it. A diagnostic that delivers
 * a message is not a diagnostic.
 *
 * Every negative answer here is a degradation, not a failure — the accepted
 * journal still replays the answer at the session's next turn. What it buys is
 * that the reason is nameable in advance instead of being discovered as
 * silence. The common one is `--bare`, which binds no socket at all (and runs
 * no hooks either, so nothing would have registered a question in the first
 * place).
 */
export function inspectClaudeInbox(options: {
  pid: number
  platform: NodeJS.Platform
  readDescriptor: (pid: number) => unknown
  socketExists: (socketPath: string) => boolean
}): ClaudeInboxReadiness {
  if (!INBOX_PLATFORMS.has(options.platform)) {
    return {
      state: 'unavailable',
      reason: `Claude Code publishes no inbox socket on ${options.platform}; it exists on macOS and Linux only`,
    }
  }
  let raw: unknown
  try {
    raw = options.readDescriptor(options.pid)
  } catch (err) {
    return {
      state: 'unavailable',
      reason: `no session descriptor for pid ${options.pid} (${err instanceof Error ? err.message : String(err)}); a session started with \`--bare\` binds no inbox socket`,
    }
  }
  const descriptor = parseDescriptor(raw)
  if (descriptor === null) {
    return {
      state: 'unavailable',
      reason: `the session descriptor for pid ${options.pid} has an unknown shape`,
    }
  }
  if (descriptor.peerProtocol !== CLAUDE_PEER_PROTOCOL) {
    return {
      state: 'unavailable',
      reason: `this session speaks inbox protocol ${descriptor.peerProtocol}, and only ${CLAUDE_PEER_PROTOCOL} is known; refusing to guess at an undocumented wire format`,
    }
  }
  if (!versionAtLeast(descriptor.version, CLAUDE_MIN_INBOX_VERSION)) {
    return {
      state: 'unavailable',
      reason: `Claude Code ${descriptor.version} is older than ${CLAUDE_MIN_INBOX_VERSION}, which is where the inbox socket starts`,
    }
  }
  if (!options.socketExists(descriptor.messagingSocketPath)) {
    return {
      state: 'unavailable',
      reason: `the descriptor names ${descriptor.messagingSocketPath}, but no socket exists there`,
    }
  }
  return {
    state: 'ready',
    socketPath: descriptor.messagingSocketPath,
    version: descriptor.version,
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
 * consumption — and this route reports exactly that, no more. It reports
 * `delivered` all the same, because the write is the strongest acknowledgement
 * this route can ever obtain: the message it posts starts a brand-new turn
 * rather than continuing this one, so no later hook will confirm anything about
 * it. An answer delivered once and settled is strictly better than an answer
 * redelivered on every turn-end for ever.
 *
 * Every path that hands nothing over reports `held`, so the accepted journal
 * replays it. Unknown state deliberately returns without throwing, so the
 * journal becomes `hold-for-next-turn` instead of failing the hook.
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
    async deliver(event: ContinuationEvent): Promise<DeliveryOutcome> {
      const observation = await observeClaudeSession(options.sessionId, adapters)
      if (observation.state === 'unknown') {
        return {
          notes: [`holding the accepted answer for the next turn: ${observation.reason}`],
          log: { route: 'hold-for-next-turn', stage: 'queued', reason: observation.reason },
          acknowledgement: 'held',
        }
      }
      if (sourceDescriptor === null) {
        const reason = 'the Stop-hook process cannot prove exact Claude session ownership'
        return {
          notes: [`holding the accepted answer for the next turn: ${reason}`],
          log: { route: 'hold-for-next-turn', stage: 'queued', reason },
          acknowledgement: 'held',
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
            acknowledgement: 'held',
          }
        }
        if (!event.commitDelivery()) return cancelledDelivery()
        await adapters.resume(options.sessionId, sourceDescriptor.cwd, event.context)
        return {
          notes: ['cold-resumed the stopped Claude session with its accepted answer'],
          log: { route: 'cold-resume', stage: 'delivered' },
          acknowledgement: 'delivered',
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
          acknowledgement: 'held',
        }
      }
      if (!event.commitDelivery()) return cancelledDelivery()
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
        // The write completed: Claude Code holds the message. Nothing later
        // reports on it, so this is where the journal settles.
        acknowledgement: 'delivered',
      }
    },
  }
}

function cancelledDelivery(): DeliveryOutcome {
  return {
    notes: ['the Agent Session ended before answer delivery; stopping this observer'],
    log: { route: 'hold-for-next-turn', stage: 'queued', reason: 'session-ended' },
    acknowledgement: 'held',
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
