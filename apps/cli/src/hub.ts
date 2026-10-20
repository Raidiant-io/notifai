/**
 * The hub: one shared Notifai process per OS user and state directory.
 *
 * It attends every live Agent Session on this machine that has a native
 * session child: it holds the Machine credential (read once), every session's
 * presence lease behind one batched exchange, the question waiters, the Codex
 * queue nudges, and the sweep for closes nobody reported. Session children
 * watch their harness through the kernel and write Claude's inbox; the hub
 * never writes there itself.
 *
 * It starts on demand (the first child that finds no hub starts it), takes an
 * exclusive lock so a second one leaves at once, and exits 30 seconds after
 * nothing is connected and nothing is owed. There is no login item, launch
 * agent, systemd unit or startup task.
 */
import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import { existsSync, readdirSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttendanceMessage, SessionActivity } from '@raidiant/notifai-protocol'
import { atomicWriteFileSync } from './atomic-file.js'
import { claudeDescriptorDir, claudeMinInboxVersion, CLAUDE_PEER_PROTOCOL, parseDescriptor } from './claude-wake.js'
import { claudePickerHolds } from './claude-question-hooks.js'
import { createClient, type ApiClient } from './client.js'
import { codexInputObserver, refreshCodexInputActivity } from './codex-input-lifecycle.js'
import { connectCodexQueue } from './codex-queue-control.js'
import {
  classifyCodexSessionEnd,
  codexDormantSurface,
  codexHostKind,
  codexTranscriptState,
  readCodexThreadOriginator,
  type CodexEndVerdict,
} from './codex-session-end.js'
import { readNativeTurnSnapshot } from './codex-native-turn.js'
import { inspectCodexQueue, systemCodexWakeAdapters, type CodexWakeAdapters } from './codex-wake.js'
import { EXIT, log, makeClient, type CommandDeps } from './commands-core.js'
import type { CredentialStore, MachineCredential } from './credentials.js'
import { buildIdentity } from './distribution.js'
import type { HookInstallableHarness } from './harnesses.js'
import { acquireClaimFile, claimHolderMayRun, readClaimFile, releaseClaimFile, requestClaimHandoff } from './hook-question-lock.js'
import {
  beginSessionIncarnation,
  endsIncarnation,
  pendingList,
  readSessionEndMarker,
  readSessionIncarnation,
  readSessionState,
  refreshSessionMarkers,
  rotateSessionIncarnation,
  sessionHasEnded,
  sessionNotified,
  updateSessionState,
  type SessionIncarnation,
} from './hook-session-state.js'
import { ExchangeDriver, type AttendedSession, type HubClock } from './hub-exchange.js'
import {
  attemptAutomaticUpdate,
  candidatePlan,
  candidateResume,
  waitingSessionWork,
  type AttemptOutcome,
  type AutomaticUpdateHost,
  type WaitingReason,
} from './automatic-update.js'
import { hubEnvironment } from './hub-client.js'
import { osAccountHome } from './os-account-home.js'
import type { managedInstallation as ManagedInstallation } from './native-installation.js'
import {
  childLockPath,
  credentialGenerationPath,
  encodeFrame,
  endedRecordsDir,
  ensurePrivateDirectory,
  FrameDecoder,
  HUB_IPC_VERSION,
  HUB_IPC_VERSIONS,
  hubHistoryPath,
  hubLockPath,
  hubRunDir,
  hubSocketPath,
  hubStatusPath,
} from './hub-ipc.js'
import { SessionLease, type LeaseOutcome } from './hub-lease.js'
import { currentRuntimeBuild } from './launch-self.js'
import { bootstrapLogger, type Logger } from './logging.js'
import { nativeUninstallPending } from './native-uninstall-barrier.js'
import { descriptorStartMatches, linuxStartTicks, normalizeProcessStart, pidExists, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { packageVersion } from './release.js'
import { retainSessionRuntime } from './runtime-build-retention.js'
import {
  attendantClaimPath,
  attendantStatusPath,
  observedCodexTurnActivity,
  readAttendantEndingLease,
  reconcileNativeTurn,
  turnActivityPath,
  writeAttendantStatus,
} from './session-attendant-state.js'
import type { DeliveryLease } from './session-delivery.js'
import { claudeSocketLine, deliverIntoCodexThread } from './session-handoff.js'
import { detachInputWakes, readInputWakes } from './session-input-wakes.js'
import {
  hasSessionInputs,
  inputWakeOverdue,
  reconcileSessionInputWakes,
  stageSessionMessages,
  wakeCodexSessionInputs,
  wakeSessionInputs,
} from './session-inputs.js'
import { compareVersions } from './version.js'
import { QUESTION_WAITER_CEILING_SECONDS } from './question-timing.js'

/** The hub leaves this long after nothing is connected and nothing is owed (Proposal). */
export const HUB_IDLE_EXIT_MS = 30_000
/** Restarts stop for the rest of this window after this many crashes in it (Proposal). */
export const HUB_CRASH_LIMIT = 3
export const HUB_CRASH_WINDOW_MS = 10 * 60_000
/** A Claude wake accepted but still not shown after this long idle is treated as lost. */
const IDLE_BEFORE_WAKE_REPLACEMENT_MS = 30_000
/** Safety re-read of activity and pending input; events do the ordinary work. */
const SAFETY_TICK_MS = 15_000
/** A claimed write must begin within this bound of the child reading the request. */
const CHILD_WRITE_DEADLINE_MS = 8_000
/**
 * A child gets this long to answer a write request: past its own deadline
 * (and its five-second connect), so a write the hub already gave up on cannot
 * still land; inside the service's 30 s claim window.
 */
const CHILD_WRITE_TIMEOUT_MS = 20_000
/** How long a new hub waits for a replaced attendant to step aside. */
const HANDOFF_WAIT_MS = 10_000
/** First automatic-update pass after the hub starts, then the pass interval. The lookup itself is daily. */
const AUTOMATIC_UPDATE_FIRST_MS = 60_000
const AUTOMATIC_UPDATE_INTERVAL_MS = 10 * 60_000
const SHELLS: ReadonlySet<string> = new Set(['sh', 'dash', 'bash', 'zsh', 'ksh', 'mksh', 'fish'])
/**
 * How long the hub waits after a Codex SessionEnd before deciding what it
 * meant (Proposal): an archive moves the rollout and an app quit takes its
 * host down within this, and a reopen starts the session again within it.
 */
export const CODEX_END_CONFIRM_MS = 5_000
/** A dormant conversation keeps the hub alive at most one answer window. */
const DORMANT_CEILING_MS = QUESTION_WAITER_CEILING_SECONDS * 1000

export interface PeerProcess { pid: number; ppid: number; comm: string; start: string; ticks?: string }

/** Refusals a child retries later; any other refusal is final for that child. */
const PASSING_REFUSALS: ReadonlySet<string> = new Set(['hub-exiting', 'peer-unverifiable', 'claim-held', 'incarnation-unavailable',
  'session-ending', 'descriptor-missing'])
export interface PeerCredentials {
  uid: number
  pid: number
  peer?: PeerProcess | null
  parent?: PeerProcess | null
  grandparent?: PeerProcess | null
}
export type PeerVerifier = (socket: Socket) => Promise<PeerCredentials | null>

export interface HubOptions {
  deps: CommandDeps
  clock?: HubClock
  /** Kernel peer credentials of a connected child; production asks the native launcher. */
  verifyPeer?: PeerVerifier
  idleExitMs?: number
  /** This boot's identity; production reads Linux's boot id or macOS's `kern.bootsessionuuid`. */
  bootIdentity?: () => string | null
  /** Install SIGTERM/SIGINT handlers (the real process only). */
  handleSignals?: boolean
  /** Test seam; production re-reads every 15 s. */
  safetyTickMs?: number
  /** Test seam; production waits CODEX_END_CONFIRM_MS. */
  codexEndConfirmMs?: number
  /** Test seam: what kind of process hosts a Codex session; production asks `ps`. */
  codexHostKind?: typeof codexHostKind
  /**
   * Automatic updates (design §11). Absent: off (tests and development).
   * `hubCommand` supplies the production updater for a managed installation.
   */
  automaticUpdate?: AutomaticUpdateOptions
}

export interface AutomaticUpdateOptions {
  attempt?: (host: AutomaticUpdateHost) => Promise<AttemptOutcome>
  /** Overrides for parts of the host (tests). */
  host?: Partial<AutomaticUpdateHost>
  firstDelayMs?: number
  intervalMs?: number
  /** Start the next hub after this one hands over; production runs the stable launcher. */
  startSuccessor?: (env: NodeJS.ProcessEnv) => void
}

type ChildReply = { result: 'ok' } | { result: 'failed'; stage: 'before-write' | 'during-write'; error: string }

/** One connected native session child. */
class ChildLink {
  ended = false
  closed = false
  private nextId = 1
  private readonly pending = new Map<string, (reply: ChildReply) => void>()

  constructor(readonly socket: Socket, readonly pid: number, readonly ipcVersion: number) {}

  send(message: Record<string, unknown>): void {
    if (this.closed) return
    try { this.socket.write(encodeFrame(message)) } catch { /* A gone child is noticed on close. */ }
  }

  /** Ask the child to write one prepared inbox line; resolves with what it reports. */
  write(line: string, inbox: string, deadlineMs: number): Promise<ChildReply> {
    if (this.closed) return Promise.resolve({ result: 'failed', stage: 'before-write', error: 'the session child is gone' })
    const id = String(this.nextId++)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // No answer: the write may have happened.
        resolve({ result: 'failed', stage: 'during-write', error: 'the session child did not answer' })
      }, CHILD_WRITE_TIMEOUT_MS)
      this.pending.set(id, (reply) => { clearTimeout(timer); resolve(reply) })
      this.send({ type: 'write', id, deadline_ms: deadlineMs,
        socket_b64: Buffer.from(inbox, 'utf8').toString('base64'), line_b64: Buffer.from(line, 'utf8').toString('base64') })
    })
  }

  answered(frame: Record<string, unknown>): void {
    const id = typeof frame['id'] === 'string' ? frame['id'] : null
    const resolve = id === null ? undefined : this.pending.get(id)
    if (resolve === undefined) return
    this.pending.delete(id!)
    if (frame['result'] === 'ok') resolve({ result: 'ok' })
    else resolve({ result: 'failed', stage: frame['stage'] === 'during-write' ? 'during-write' : 'before-write',
      error: typeof frame['error'] === 'string' ? frame['error'] : 'the session child could not write' })
  }

  close(): void {
    this.closed = true
    for (const resolve of this.pending.values()) resolve({ result: 'failed', stage: 'during-write', error: 'the session child disconnected' })
    this.pending.clear()
  }
}

type Probe =
  | { state: 'running'; activity: SessionActivity }
  | { state: 'uncertain'; reason: string }
  | { state: 'ended'; reason: EndReason }

type EndReason = 'harness-gone' | 'session-replaced' | 'session-end-hook' | 'session-archived'

interface Registration {
  sessionId: string
  harness: 'claude-code' | 'codex'
  harnessProcess: ProcessIdentity
  boot: string | null
  stamp: { wall: number; mono: string }
  hookEvent: string
  source: string | null
  cwd: string | null
  transcriptPath: string | null
  inboxSocket: string | null
  inboxToken: boolean
  claudeConfigDir: string | null
  codexHome: string | null
  /** Linux: the harness's start in kernel ticks, which Claude's descriptor carries and no clock step moves. */
  harnessTicks: string | null
}

/** One Agent Session the hub attends. */
class HubSession implements AttendedSession {
  lease: SessionLease
  child: ChildLink | null = null
  claimToken: string | null = null
  idleSince: number | null = null
  private activityValue: SessionActivity = 'idle'
  private lastPhaseWritten = ''
  ending: EndReason | null = null
  codexObserver: ReturnType<typeof codexInputObserver> | null = null
  /** A Codex SessionEnd waiting for its classification. */
  endCandidate: { child: ChildLink | null; transcriptPath: string | null; timer: ReturnType<typeof setTimeout> } | null = null
  /**
   * Monotonic time Codex unloaded this conversation while its app still
   * lists it (dormant-open): no lease renewal, no writes, and the answer
   * waits in the conversation until the User opens it.
   */
  dormantSince: number | null = null
  /** The rollout existed at some point; only then does its absence mean an archive or delete. */
  transcriptSeen = false

  constructor(
    readonly hub: Hub,
    readonly id: string,
    readonly harness: 'claude-code' | 'codex',
    readonly env: NodeJS.ProcessEnv,
    public harnessProcess: ProcessIdentity,
    public record: SessionIncarnation,
    public registration: Registration,
  ) {
    this.lease = new SessionLease(record.incarnation, (expected) => this.rotate(expected))
    if (harness === 'codex') {
      this.codexObserver = codexInputObserver(id, env, record.key, () => hub.clock.monotonic(),
        registration.transcriptPath ?? undefined, (owner) => this.harnessAlive(owner))
    }
  }

  /** Kernel evidence: the child is connected, watching this exact process, and has not seen it exit. */
  harnessAlive(owner: ProcessIdentity = this.harnessProcess): boolean {
    return this.child !== null && !this.child.closed && !this.child.ended &&
      owner.pid === this.harnessProcess.pid && normalizeProcessStart(owner.start) === normalizeProcessStart(this.harnessProcess.start)
  }

  /** The Codex rollout this session writes was archived or deleted (E5). */
  transcriptGone(): boolean {
    if (this.harness !== 'codex') return false
    const state = codexTranscriptState(this.registration.transcriptPath)
    if (state === 'present') this.transcriptSeen = true
    return state === 'missing' && this.transcriptSeen
  }

  /** Something still waits on this dormant conversation: a question, an answer, a note. */
  dormantOwes(now: number): boolean {
    if (this.dormantSince === null || now - this.dormantSince >= DORMANT_CEILING_MS) return false
    const state = readSessionState(this.id, this.env)
    if (pendingList(state).length > 0 || state.accepted !== undefined || (state.waiting_answers?.length ?? 0) > 0) return true
    const lease = this.lease.generation === null ? null : { incarnation: this.lease.incarnation, generation: this.lease.generation }
    return hasSessionInputs(this.id, this.env, lease)
  }

  /** Asked of the process table when no kernel watch is connected: ticks on Linux, the start text elsewhere. */
  harnessGone(): boolean {
    const ticks = this.registration.harnessTicks
    if (ticks === null) return processIdentityLiveness(this.harnessProcess) === 'gone'
    const now = linuxStartTicks(this.harnessProcess.pid)
    return now === null ? !pidExists(this.harnessProcess.pid) : now !== ticks
  }

  get notified(): boolean {
    return sessionNotified(this.id, this.env)
  }

  /** Fresh local evidence, read now; nothing carried over from an earlier read. */
  probe(): Probe {
    if (this.ending !== null) return { state: 'ended', reason: this.ending }
    if (endsIncarnation(readSessionEndMarker(this.id, this.env), this.record)) return { state: 'ended', reason: 'session-end-hook' }
    if (this.child?.ended === true) return { state: 'ended', reason: 'harness-gone' }
    if (this.child === null || this.child.closed) return { state: 'uncertain', reason: 'session-child-disconnected' }
    if (this.harness === 'codex') {
      const activity = observedCodexTurnActivity(this.id, this.env, this.record.key)
      return activity === null ? { state: 'uncertain', reason: 'turn-activity-unobserved' } : { state: 'running', activity }
    }
    const descriptor = this.descriptor()
    if (descriptor === 'missing') return { state: 'uncertain', reason: 'descriptor-missing' }
    if (descriptor === null) return { state: 'uncertain', reason: 'descriptor-unrecognised' }
    if (!descriptorStartMatches(descriptor.procStart, this.harnessProcess, this.registration.harnessTicks)) {
      return { state: 'uncertain', reason: 'process-start-mismatch' }
    }
    if (descriptor.sessionId !== this.id) return { state: 'ended', reason: 'session-replaced' }
    return { state: 'running', activity: descriptor.status === 'idle' ? 'idle' : 'working' }
  }

  descriptor(): ReturnType<typeof parseDescriptor> | 'missing' {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path.join(claudeDescriptorDir(this.env), `${this.harnessProcess.pid}.json`), 'utf8'))
    } catch {
      return 'missing'
    }
    const descriptor = parseDescriptor(raw)
    return descriptor === null || descriptor.pid !== this.harnessProcess.pid ? null : descriptor
  }

  claimHeld(): boolean {
    return this.claimToken !== null && readClaimFile(attendantClaimPath(this.id, this.env))?.['token'] === this.claimToken
  }

  // -- AttendedSession -------------------------------------------------------

  runnable(now: number): boolean {
    if (!this.notified || now < this.lease.pausedUntil) return false
    if (this.lease.phase === 'withdrawn' || this.lease.phase === 'exited' || this.lease.phase === 'unsupported') return false
    if (!this.claimHeld()) return false
    const probe = this.probe()
    if (probe.state === 'ended') { this.hub.endSession(this, probe.reason); return false }
    // Dormant-open: Notifai cannot reach the conversation until it loads again.
    if (this.dormantSince !== null) return false
    if (probe.state === 'uncertain') {
      this.lease.setPhase('uncertain', probe.reason)
      this.writeStatus()
      return false
    }
    this.observeActivity(probe.activity)
    if (this.lease.phase === 'dormant' || this.lease.phase === 'uncertain') this.lease.setPhase('acquiring')
    return true
  }

  activity(): SessionActivity {
    return this.activityValue
  }

  acceptsMessages(): boolean {
    return this.writerAvailable()
  }

  async attended(messages: AttendanceMessage[]): Promise<'done' | 'retry-soon'> {
    this.writeStatus()
    if (!this.writerAvailable()) return 'done'
    return this.harness === 'claude-code' ? this.handClaude(messages) : this.handCodex(messages)
  }

  settled(outcome: LeaseOutcome): void {
    if (outcome.kind === 'rotated') this.rekeyClaim()
    if (outcome.kind === 'reported') { this.hub.forget(this, `reported-${outcome.state}`); return }
    this.writeStatus()
  }

  // -- activity --------------------------------------------------------------

  observeActivity(activity: SessionActivity): void {
    if (activity === 'idle') this.idleSince ??= this.hub.clock.monotonic()
    else this.idleSince = null
    if (activity === this.activityValue) return
    this.activityValue = activity
    // A held exchange carries the old activity; cut it so the next one reports this.
    this.lease.needsFresh = true
    this.writeStatus()
    this.hub.driver.poke()
  }

  /** A hook boundary passed (prompt, turn end, interrupt): read activity again. */
  hinted(): void {
    if (this.harness === 'codex') refreshCodexInputActivity(this.id, this.env, this.record.key,
      this.registration.transcriptPath ?? undefined, (owner) => this.harnessAlive(owner))
    if (this.lease.phase === 'withdrawn') {
      // The old attendant's next hook re-armed it; the hub re-arms on the next boundary.
      this.lease.generation = null
      this.lease.setPhase('acquiring', 're-armed')
      this.lease.needsFresh = true
    }
    const probe = this.probe()
    if (probe.state === 'ended') { this.hub.endSession(this, probe.reason); return }
    if (probe.state === 'running') this.observeActivity(probe.activity)
    this.checkInput()
    this.hub.driver.poke()
  }

  settledIdle(): boolean {
    return this.idleSince !== null && this.hub.clock.monotonic() - this.idleSince >= IDLE_BEFORE_WAKE_REPLACEMENT_MS
  }

  /** Staged input that needs a wake: cut the held exchange and hand it in. */
  checkInput(): void {
    if (this.dormantSince !== null) { void this.hub.dormantWake(this); return }
    if (!this.notified || this.lease.generation === null || this.hub.clock.monotonic() < this.lease.pausedUntil) return
    const lease: DeliveryLease = { incarnation: this.lease.incarnation, generation: this.lease.generation }
    let pending = false
    if (this.harness === 'claude-code') {
      const state = readSessionState(this.id, this.env)
      pending = !claudePickerHolds(state) &&
        (!state.input_wake?.queued || (this.settledIdle() && inputWakeOverdue(state, this.hub.clock.wall()))) &&
        hasSessionInputs(this.id, this.env, null)
    } else {
      pending = !readSessionState(this.id, this.env).input_wake?.queued && hasSessionInputs(this.id, this.env, lease) &&
        (this.codexObserver?.mayWake() ?? false)
    }
    if (!pending || this.lease.needsFresh) return
    this.lease.needsFresh = true
    this.hub.driver.poke()
  }

  // -- writing ---------------------------------------------------------------

  /**
   * True only while, right now: the hub still holds this session's claim and
   * incarnation, fresh evidence shows it running, the credential is the one
   * the lease was granted under, and the lease outlives a write that starts now.
   */
  mayWrite(): boolean {
    if (this.ending !== null || !this.claimHeld()) return false
    if (readSessionIncarnation(this.id, this.env)?.incarnation !== this.lease.incarnation) return false
    const probe = this.probe()
    if (probe.state !== 'running') return false
    return this.lease.covers(this.hub.clock.monotonic(), this.hub.driver.currentEpoch, this.hub.credentialKey())
  }

  writerAvailable(): boolean {
    if (this.child === null || this.child.closed) return false
    if (this.harness === 'codex') {
      if (inspectCodexQueue(this.id, this.env).state !== 'ready') return false
      return this.hub.codexAdapters(this).available?.() !== false
    }
    const descriptor = this.descriptor()
    if (descriptor === 'missing' || descriptor === null || descriptor.peerProtocol !== CLAUDE_PEER_PROTOCOL) return false
    const order = compareVersions(descriptor.version, claudeMinInboxVersion(process.platform))
    return order !== 'before' && order !== 'unparseable' &&
      (this.registration.inboxSocket === null || this.registration.inboxSocket === descriptor.messagingSocketPath)
  }

  private async handClaude(messages: AttendanceMessage[]): Promise<'done' | 'retry-soon'> {
    const generation = this.lease.generation
    if (generation === null || !this.mayWrite()) return 'retry-soon'
    const lease: DeliveryLease = { incarnation: this.lease.incarnation, generation }
    stageSessionMessages(this.id, this.env, lease, messages)
    if (!hasSessionInputs(this.id, this.env, lease)) return 'done'
    // While the picker is on screen nothing else can be shown, and its handler
    // returns the answer as the picker's own result. A note still gets a wake.
    if (messages.length === 0 && claudePickerHolds(readSessionState(this.id, this.env))) return 'done'
    await wakeSessionInputs(this.id, this.env, async (text) => (await this.writeClaude(text)) === 'written',
      this.hub.logger, { unique: true, replaceLost: () => this.settledIdle(), now: () => this.hub.clock.wall() })
    return 'done'
  }

  /** The content-free wake, written by the session's own child into Claude's inbox. */
  async writeClaude(text: string): Promise<'written' | 'unavailable' | 'cancelled' | 'failed'> {
    const descriptor = this.descriptor()
    if (descriptor === 'missing' || descriptor === null || descriptor.sessionId !== this.id ||
        !descriptorStartMatches(descriptor.procStart, this.harnessProcess, this.registration.harnessTicks) ||
        descriptor.peerProtocol !== CLAUDE_PEER_PROTOCOL || !['idle', 'busy'].includes(descriptor.status)) return 'unavailable'
    if (this.child === null || !this.mayWrite()) return 'cancelled'
    const reply = await this.child.write(claudeSocketLine(text), descriptor.messagingSocketPath, CHILD_WRITE_DEADLINE_MS)
    if (reply.result === 'ok') {
      this.hub.logger.info('delivery.handoff', { route: 'inbox-socket', stage: 'written', session: this.id, session_state: descriptor.status })
      return 'written'
    }
    this.hub.logger.info('delivery.handoff', { route: 'inbox-socket', stage: reply.stage, session: this.id, reason: reply.error })
    return reply.stage === 'before-write' ? 'cancelled' : 'failed'
  }

  private async handCodex(messages: AttendanceMessage[]): Promise<'done' | 'retry-soon'> {
    const generation = this.lease.generation
    const incarnation = readSessionIncarnation(this.id, this.env)
    if (incarnation === null || generation === null || !this.mayWrite()) return 'retry-soon'
    const lease: DeliveryLease = { incarnation: this.lease.incarnation, generation }
    stageSessionMessages(this.id, this.env, lease, messages)
    const mayWake = (): boolean => this.codexObserver?.mayWake() ?? false
    if (await wakeCodexSessionInputs({ sessionId: this.id, env: this.env, lease, mayWrite: () => this.mayWrite(), mayWake,
      unknownAllowed: () => this.codexObserver?.unknownAllowed() ?? false,
      ...(this.hub.deps.codexQueueControl === undefined ? {} : { connect: this.hub.deps.codexQueueControl }) })) return 'done'
    if (!hasSessionInputs(this.id, this.env, lease) || !mayWake()) return 'done'
    // Recheck eligibility and pending input immediately before queue admission;
    // a hook may have consumed the batch since the last exchange.
    const cwd = this.registration.cwd ?? process.cwd()
    await wakeSessionInputs(this.id, this.env, async (text) => {
      if (!this.mayWrite() || !mayWake() || !hasSessionInputs(this.id, this.env, lease)) return false
      const result = await deliverIntoCodexThread({ threadId: this.id, cwd, env: this.env, adapters: this.hub.codexAdapters(this), text,
        begin: () => this.mayWrite() && mayWake() && hasSessionInputs(this.id, this.env, lease) })
      return result.status === 'written'
    }, this.hub.logger)
    return 'done'
  }

  // -- local records -------------------------------------------------------------

  private rotate(expected: string): string | null {
    const next = rotateSessionIncarnation(this.id, this.env, expected)
    if (next === null) return null
    this.record = next
    return next.incarnation
  }

  /** Keep the claim naming the incarnation it serves. */
  private rekeyClaim(): void {
    const file = attendantClaimPath(this.id, this.env)
    if (this.claimToken !== null) releaseClaimFile(file, this.claimToken)
    this.claimToken = acquireClaimFile(file, this.hub.claimFields(this.lease.incarnation), this.hub.clock.wall())
  }

  writeStatus(force = false): void {
    const phase = `${this.lease.phase}|${this.lease.reason}|${this.lease.generation}|${this.activityValue}|${this.writerAvailable()}`
    if (!force && phase === this.lastPhaseWritten) return
    this.lastPhaseWritten = phase
    try {
      writeAttendantStatus(this.id, this.env, {
        phase: this.lease.phase === 'withdrawn' ? 'exited' : this.lease.phase,
        incarnation: this.lease.incarnation,
        generation: this.lease.generation,
        activity: this.activityValue,
        reason: this.lease.reason,
        accepts_messages: this.writerAvailable(),
        updated_at: this.hub.clock.wall(),
      })
    } catch {
      // Status is diagnostic; attendance continues without it.
    }
    this.hub.statusChanged()
  }
}

/** A session that ended while the hub was away: one `ended` report from saved fencing identity. */
class EndedSession implements AttendedSession {
  readonly lease: SessionLease
  constructor(readonly hub: Hub, readonly id: string, lease: DeliveryLease, readonly records: string[]) {
    this.lease = new SessionLease(lease.incarnation, () => null)
    this.lease.generation = lease.generation
    this.lease.final = 'ended'
  }
  runnable(): boolean { return false }
  activity(): SessionActivity { return 'idle' }
  acceptsMessages(): boolean { return false }
  async attended(): Promise<'done'> { return 'done' }
  settled(outcome: LeaseOutcome): void {
    if (outcome.kind !== 'reported') return
    for (const file of this.records) rmSync(file, { force: true })
    this.hub.forgetEnded(this)
  }
}

interface History { starts: { at: number; pid: number; clean: boolean; boot?: string | null }[]; fault?: { reason: string; since: number } }

export class Hub {
  readonly clock: HubClock
  readonly logger: Logger
  readonly driver: ExchangeDriver
  readonly sessions = new Map<string, HubSession>()
  private readonly ended = new Map<string, EndedSession>()
  private readonly settlements = new Map<string, { rerun: boolean }>()
  private server: Server | null = null
  private lockToken: string | null = null
  private credential: MachineCredential | null | undefined
  private client_: ApiClient | null = null
  private credentialLoads = 0
  private credentialMarker: string | null = null
  /** Aborted when the credential changes: ends every request any in-hub waiter started with it. */
  private credentialAbort = new AbortController()
  private unauthorizedState = false
  /** A 401/403 already caused one fresh read of the store for this credential. */
  private rereadAfterRefusal = false
  private children = 0
  private idleSince: number
  private exiting = false
  private exitResolve: (() => void) | null = null
  private safetyTimer: ReturnType<typeof setInterval> | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private readonly startedAt: number
  private crashes = 0
  private readonly codexAdapterCache = new Map<string, CodexWakeAdapters>()
  /** Every connected session child, registered or not yet. */
  private readonly links = new Set<ChildLink>()
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private updating = false
  /** An automatic update activated a new build: start its hub after this one leaves. */
  private successor = false

  constructor(readonly deps: CommandDeps, private readonly options: HubOptions) {
    this.clock = options.clock ?? { monotonic: () => performance.now(), wall: () => Date.now() }
    this.logger = log(deps)
    this.logger.bind({ cmd: 'hub' })
    this.idleSince = this.clock.monotonic()
    this.startedAt = this.clock.wall()
    this.driver = new ExchangeDriver({
      sessions: () => [...this.sessions.values(), ...this.ended.values()].filter((s) => s.lease.phase !== 'exited'),
      client: () => this.client(),
      credentialKey: () => this.credentialKey(),
      unauthorized: () => this.unauthorized(),
      clock: this.clock,
      logger: this.logger,
      sleep: (ms, signal) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      }),
    })
  }

  get env(): NodeJS.ProcessEnv {
    return this.deps.env
  }

  // -- lifecycle --------------------------------------------------------------

  /** Runs until idle exit, a stop request or a signal. Returns the exit code. */
  async run(): Promise<number> {
    ensurePrivateDirectory(hubRunDir(this.env))
    const history = this.readHistory()
    const now = this.clock.wall()
    const recent = history.starts.filter((start) => now - start.at < HUB_CRASH_WINDOW_MS)
    // A hub that died with its machine (a reboot, power loss) did not crash.
    const boot = (this.options.bootIdentity ?? currentBootIdentity)()
    this.crashes = recent.filter((start) => !start.clean && start.pid !== process.pid && !pidExists(start.pid) &&
      !(boot !== null && typeof start.boot === 'string' && start.boot !== boot)).length
    if (this.crashes >= HUB_CRASH_LIMIT) {
      // Repeated crashes: stop restarting for the rest of the window and say so.
      this.writeHistory({ starts: recent, fault: history.fault ?? { reason: 'repeated-crashes', since: now } })
      this.logger.error('hub.start', { outcome: 'refused', reason: 'repeated-crashes', crashes: this.crashes })
      return 3
    }
    this.lockToken = acquireClaimFile(hubLockPath(this.env), { role: 'hub', build: packageVersion() }, now)
    if (this.lockToken === null) {
      this.logger.info('hub.start', { outcome: 'already-running' })
      return EXIT.ok
    }
    this.writeHistory({ starts: [...recent, { at: now, pid: process.pid, clean: false, boot }].slice(-20) })
    try {
      await this.listen()
    } catch (err) {
      this.logger.error('hub.start', { outcome: 'failed', reason: 'socket', message: err instanceof Error ? err.message : String(err) })
      this.releaseLock(true)
      return EXIT.failed
    }
    this.logger.info('hub.start', { outcome: 'listening', ipc_version: HUB_IPC_VERSION, crashes: this.crashes })
    this.writeStatusNow()
    const signals = this.options.handleSignals === true ? this.installSignals() : null
    const exchange = this.driver.run().catch((err: unknown) => {
      this.logger.error('hub.exchange', { event: 'stopped', message: err instanceof Error ? err.message : String(err) })
    })
    this.sweep()
    this.safetyTimer = setInterval(() => this.safetyTick(), this.options.safetyTickMs ?? SAFETY_TICK_MS)
    this.safetyTimer.unref?.()
    this.scheduleAutomaticUpdate(this.options.automaticUpdate?.firstDelayMs ?? AUTOMATIC_UPDATE_FIRST_MS)
    // An exit asked for during startup (a signal, `stop`) must not be lost.
    if (!this.exiting) await new Promise<void>((resolve) => { this.exitResolve = resolve })
    signals?.()
    await this.shutdown(exchange)
    if (this.successor) {
      // The handover (design §4.8): this hub has kept every lease on disk and
      // released the lock; the new build's hub takes them over. Children also
      // reconnect and would start it themselves.
      try {
        (this.options.automaticUpdate?.startSuccessor ?? startSuccessorHub)(this.env)
        this.logger.info('hub.exit', { reason: 'automatic-update', successor: 'started' })
      } catch (err) {
        this.logger.error('hub.exit', { reason: 'automatic-update', successor: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    }
    return EXIT.ok
  }

  // -- automatic updates (design §11) -------------------------------------------

  private scheduleAutomaticUpdate(delayMs: number): void {
    if (this.options.automaticUpdate === undefined || this.exiting) return
    this.updateTimer = setTimeout(() => { this.updateTimer = null; void this.runAutomaticUpdate() }, delayMs)
    this.updateTimer.unref?.()
  }

  /** One pass of the updater; a successful activation hands this hub over. */
  async runAutomaticUpdate(): Promise<AttemptOutcome | null> {
    const options = this.options.automaticUpdate
    if (options === undefined || this.updating || this.exiting) return null
    if (!this.busy()) {
      // Nothing attended: this hub is on its way out, and a pass must not
      // hold it here (it would reset the idle clock). The next hub checks.
      this.scheduleAutomaticUpdate(options.intervalMs ?? AUTOMATIC_UPDATE_INTERVAL_MS)
      return null
    }
    this.updating = true
    try {
      const outcome = await (options.attempt ?? attemptAutomaticUpdate)({ ...this.automaticUpdateHost(), ...options.host })
      if (outcome.outcome === 'activated' && !this.exiting) {
        this.successor = true
        this.requestExit('automatic-update')
      }
      return outcome
    } catch (err) {
      this.logger.error('update.automatic', { event: 'failed', message: err instanceof Error ? err.message : String(err) })
      return null
    } finally {
      this.updating = false
      this.scheduleAutomaticUpdate(options.intervalMs ?? AUTOMATIC_UPDATE_INTERVAL_MS)
      this.touch()
    }
  }

  private automaticUpdateHost(): AutomaticUpdateHost {
    const cwd = os.homedir()
    return {
      env: this.env,
      now: () => this.clock.wall(),
      installation: () => {
        if (nativeInstallationModule === null) throw new Error('No managed native installation')
        return nativeInstallationModule.managedInstallation({ env: this.env, ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }) })
      },
      running: () => {
        const reference = currentRuntimeBuild(this.env)
        const version = packageVersion()
        return reference === null || version === null ? null : { build: reference.build, version }
      },
      blockers: () => this.updateBlockers(),
      childIpcVersions: () => [...this.links].filter((link) => !link.closed).map((link) => link.ipcVersion),
      plan: (launcher) => candidatePlan(launcher, hubEnvironment(this.env), cwd),
      resume: (launcher, from) => candidateResume(launcher, from, hubEnvironment(this.env), cwd),
      logger: this.logger,
    }
  }

  /**
   * Work that holds an activation back, seen from here: every Agent Session's
   * outstanding questions and answers on this machine, the question waiters
   * this hub runs, Notes and Answer Edits it staged but has not handed in, and
   * end reports it still owes.
   */
  updateBlockers(): WaitingReason[] {
    const reasons = new Set<WaitingReason>(waitingSessionWork(this.env, this.clock.wall()))
    if (this.settlements.size > 0) reasons.add('question-waiting')
    for (const session of this.sessions.values()) {
      if (session.lease.final !== null) reasons.add('session-ending')
      // A dormant-open Codex conversation, or one whose end is still being
      // classified, lives only in this hub's memory: a handover now could lose
      // it, so wait until it reopens, ends or stops owing anything.
      if (session.dormantSince !== null || session.endCandidate !== null) reasons.add('session-dormant')
      const generation = session.lease.generation
      if (generation !== null && hasSessionInputs(session.id, session.env, { incarnation: session.lease.incarnation, generation })) {
        reasons.add('session-input-pending')
      }
    }
    if (this.ended.size > 0) reasons.add('session-ending')
    return [...reasons]
  }

  /** Ask the hub to leave (idle, stop request, signal, logout timeout). */
  requestExit(reason: string): void {
    if (this.exiting) return
    this.exiting = true
    this.logger.info('hub.exit', { reason, sessions: this.sessions.size })
    this.exitResolve?.()
  }

  private async shutdown(exchange: Promise<void>): Promise<void> {
    if (this.safetyTimer !== null) clearInterval(this.safetyTimer)
    if (this.updateTimer !== null) clearTimeout(this.updateTimer)
    this.driver.stop()
    await exchange
    for (const session of this.sessions.values()) {
      session.child?.close()
      session.child?.socket.destroy()
      // Leases are kept, not released: the generation stays in the status
      // file, so the next hub renews the same lease without a false end.
      if (session.claimToken !== null) releaseClaimFile(attendantClaimPath(session.id, session.env), session.claimToken)
    }
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
    rmSync(hubSocketPath(this.env), { force: true })
    this.releaseLock(true)
    this.writeStatusNow(true)
  }

  private releaseLock(clean: boolean): void {
    if (clean) {
      const history = this.readHistory()
      this.writeHistory({ starts: history.starts.map((start) => start.pid === process.pid ? { ...start, clean: true } : start) })
    }
    if (this.lockToken !== null) releaseClaimFile(hubLockPath(this.env), this.lockToken)
    this.lockToken = null
  }

  private installSignals(): () => void {
    const onSignal = (): void => this.requestExit('signal')
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(name, onSignal)
    return () => { for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(name, onSignal) }
  }

  private readHistory(): History {
    try {
      const parsed = JSON.parse(readFileSync(hubHistoryPath(this.env), 'utf8')) as History
      return { starts: Array.isArray(parsed.starts) ? parsed.starts.filter((s) => typeof s?.at === 'number' && typeof s.pid === 'number') : [],
        ...(parsed.fault ? { fault: parsed.fault } : {}) }
    } catch {
      return { starts: [] }
    }
  }

  private writeHistory(history: History): void {
    try { atomicWriteFileSync(hubHistoryPath(this.env), `${JSON.stringify(history)}\n`) } catch { /* diagnostic */ }
  }

  private async listen(): Promise<void> {
    const socketPath = hubSocketPath(this.env)
    ensurePrivateDirectory(path.dirname(socketPath))
    // Only the lock holder may remove a socket another hub left behind.
    rmSync(socketPath, { force: true })
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    chmodSync(socketPath, 0o600)
    this.server = server
  }

  // -- credential ---------------------------------------------------------------

  /** One read of the OS store; read again only after a 401/403 or a change signal. */
  client(): ApiClient | null {
    const marker = this.readCredentialMarker()
    if (marker !== this.credentialMarker) {
      this.credentialMarker = marker
      this.rereadAfterRefusal = false
      if (this.credential !== undefined) this.dropCredential('credential-marker-changed')
    }
    if (this.credential === undefined) {
      try {
        this.credential = this.deps.store.load()
      } catch {
        this.credential = null
      }
      this.credentialLoads += 1
      this.unauthorizedState = false
      this.client_ = this.credential === null ? null
        : makeClient(this.deps, this.credential.baseUrl, `Bearer nfm_${this.credential.machineId}.${this.credential.secret}`)
      this.statusChanged()
    }
    return this.unauthorizedState ? null : this.client_
  }

  credentialKey(): string | null {
    return this.credential ? `${this.credential.machineId}:${this.credentialLoads}` : null
  }

  /** Ends every request an in-hub waiter makes with the current credential, once it changes. */
  waiterSignal(): AbortSignal {
    return this.credentialAbort.signal
  }

  /** The store the in-process question waiters use: the hub's single read, never another helper run. */
  cachedStore(): CredentialStore {
    return {
      load: () => { this.client(); return this.unauthorizedState ? null : this.credential ?? null },
      save: () => { throw new Error('The hub never writes the credential') },
      clear: () => { throw new Error('The hub never clears the credential') },
      describe: () => this.deps.store.describe(),
    }
  }

  private readCredentialMarker(): string | null {
    try { return readFileSync(credentialGenerationPath(this.env), 'utf8').trim() } catch { return null }
  }

  /** Forget the credential at once: no authenticated request is sent after this returns. */
  dropCredential(reason: string): void {
    this.credential = undefined
    this.client_ = null
    this.credentialAbort.abort()
    this.credentialAbort = new AbortController()
    // Waiters stop with the old credential; one more run each picks up a new one (re-pair).
    for (const running of this.settlements.values()) running.rerun = true
    for (const session of this.sessions.values()) {
      session.lease.lose()
      session.lease.generation = null
      session.lease.needsFresh = true
      session.lease.setPhase('acquiring', reason)
      session.writeStatus()
    }
    this.driver.reset()
    this.logger.info('hub.lease', { event: 'credential-dropped', reason })
  }

  unauthorized(): void {
    if (!this.unauthorizedState && !this.rereadAfterRefusal) {
      // The store may already hold a newer credential; read it once more.
      this.rereadAfterRefusal = true
      this.dropCredential('unauthorized-reread')
      return
    }
    this.unauthorizedState = true
    for (const session of this.sessions.values()) {
      session.lease.lose()
      session.lease.setPhase('acquiring', 're-pair-needed')
      session.writeStatus()
    }
    this.logger.error('hub.lease', { event: 'unauthorized', reason: 're-pair-needed' })
    this.statusChanged()
  }

  // -- connections ---------------------------------------------------------------

  private accept(socket: Socket): void {
    const decoder = new FrameDecoder()
    let role: string | null = null
    let link: ChildLink | null = null
    let session: HubSession | null = null
    let busy: Promise<void> = Promise.resolve()
    const helloTimer = setTimeout(() => { if (role === null) socket.destroy() }, 5_000)
    const refuse = (reason: string): void => {
      this.logger.info('hub.session', { event: 'refused', role, reason })
      try { socket.end(encodeFrame({ type: 'refused', reason, retry: PASSING_REFUSALS.has(reason) })) } catch { socket.destroy() }
    }
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (link !== null) {
        this.children -= 1
        this.links.delete(link)
        link.close()
        if (session !== null && session.child === link) this.childGone(session)
      }
      this.touch()
    })
    socket.on('data', (chunk: Buffer) => {
      let frames: Record<string, unknown>[]
      try { frames = decoder.push(chunk) } catch { socket.destroy(); return }
      for (const frame of frames) {
        busy = busy.then(async () => {
          if (role === null) {
            clearTimeout(helloTimer)
            const version = frame['ipc_version']
            if (frame['type'] !== 'hello' || typeof version !== 'number' || version < HUB_IPC_VERSIONS.min || version > HUB_IPC_VERSIONS.max) {
              refuse('ipc-version')
              return
            }
            role = typeof frame['role'] === 'string' ? frame['role'] : 'cli'
            if (role === 'child') {
              const pid = frame['pid']
              if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) { refuse('malformed-hello'); return }
              link = new ChildLink(socket, pid, version)
              this.links.add(link)
              this.children += 1
            }
            return
          }
          if (role === 'child' && link !== null) {
            if (frame['type'] === 'register' && session === null) {
              const result = await this.register(link, frame, socket)
              if (typeof result === 'string') { refuse(result); return }
              session = result
              link.send({ type: 'registered', session_id: result.id })
              return
            }
            if (frame['type'] === 'written') { link.answered(frame); return }
            if (frame['type'] === 'ended' && session !== null) {
              link.ended = true
              this.logger.info('hub.session', { event: 'ended', session: session.id, reason: 'harness-gone' })
              this.endSession(session, 'harness-gone')
            }
            return
          }
          await this.request(socket, frame)
        }).catch((err: unknown) => {
          this.logger.error('hub.session', { event: 'ipc-failed', message: err instanceof Error ? err.message : String(err) })
          socket.destroy()
        })
      }
    })
  }

  /** Requests from the CLI and from children that found their session already served. */
  private async request(socket: Socket, frame: Record<string, unknown>): Promise<void> {
    const reply = (message: Record<string, unknown>): void => { try { socket.end(encodeFrame(message)) } catch { /* gone */ } }
    const sessionId = typeof frame['session_id'] === 'string' ? frame['session_id'] : null
    switch (frame['type']) {
      case 'hint': {
        const session = sessionId === null ? undefined : this.sessions.get(sessionId)
        session?.hinted()
        reply({ type: 'ok' })
        return
      }
      case 'notified': {
        const session = sessionId === null ? undefined : this.sessions.get(sessionId)
        if (session !== undefined) { session.lease.needsFresh = true; this.driver.poke() }
        reply({ type: 'ok' })
        return
      }
      case 'settle': {
        const harness = frame['harness']
        const purpose = frame['purpose'] === 'submission' ? 'submission' : 'settlement'
        if (sessionId === null || (harness !== 'claude-code' && harness !== 'codex')) { reply({ type: 'refused', reason: 'malformed' }); return }
        this.settle(sessionId, harness, typeof frame['cwd'] === 'string' ? frame['cwd'] : null, purpose)
        reply({ type: 'ok' })
        return
      }
      case 'session-end': {
        const session = sessionId === null ? undefined : this.sessions.get(sessionId)
        if (session !== undefined) this.endSession(session, 'session-end-hook')
        reply({ type: 'ok' })
        return
      }
      case 'session-end-candidate': {
        // A Codex SessionEnd for a conversation of the Codex app or IDE
        // extension: an unload leaves it open, so decide before ending it.
        const session = sessionId === null ? undefined : this.sessions.get(sessionId)
        if (session === undefined || session.harness !== 'codex' || session.ending !== null) {
          reply({ type: 'refused', reason: 'unknown-session' })
          return
        }
        const transcript = typeof frame['transcript_path'] === 'string' && path.isAbsolute(frame['transcript_path'])
          ? frame['transcript_path'] : session.registration.transcriptPath
        this.holdCodexEnd(session, transcript)
        reply({ type: 'ok', held: true })
        return
      }
      case 'credential-changed': {
        this.credentialMarker = this.readCredentialMarker()
        this.rereadAfterRefusal = false
        this.dropCredential('credential-changed')
        reply({ type: 'ack' })
        return
      }
      case 'status':
        reply({ type: 'status', status: this.status() })
        return
      case 'stop':
        reply({ type: 'ack' })
        this.requestExit(typeof frame['reason'] === 'string' ? frame['reason'] : 'stop-requested')
        return
      default:
        reply({ type: 'refused', reason: 'unknown-request' })
    }
  }

  // -- registration ----------------------------------------------------------------

  private parseRegistration(frame: Record<string, unknown>): Registration | null {
    const text = (key: string, max = 4096): string | null => {
      const value = frame[key]
      return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
    }
    const sessionId = text('session_id', 512)
    const harness = frame['harness']
    const pid = frame['harness_pid']
    const start = text('harness_start', 128)
    const wall = frame['stamp_wall']
    const mono = text('stamp_mono', 32)
    if (sessionId === null || (harness !== 'claude-code' && harness !== 'codex') || typeof pid !== 'number' ||
        !Number.isSafeInteger(pid) || pid <= 1 || start === null || typeof wall !== 'number' || mono === null || !/^\d{1,30}$/.test(mono)) return null
    const absolute = (key: string): string | null => {
      const value = text(key)
      return value !== null && path.isAbsolute(value) ? value : null
    }
    return {
      sessionId, harness, harnessProcess: { pid, start }, boot: text('boot', 128),
      stamp: { wall, mono }, hookEvent: text('hook_event', 64) ?? '', source: text('source', 64),
      cwd: absolute('cwd'), transcriptPath: absolute('transcript_path'), inboxSocket: absolute('inbox_socket'),
      inboxToken: frame['inbox_token'] === 'present', claudeConfigDir: absolute('claude_config_dir'), codexHome: absolute('codex_home'),
      harnessTicks: /^\d{1,30}$/.test(text('harness_ticks', 32) ?? '') ? text('harness_ticks', 32) : null,
    }
  }

  /** The environment one session's work runs under: the hub's, plus that session's harness homes. */
  private sessionEnv(registration: Pick<Registration, 'claudeConfigDir' | 'codexHome'>): NodeJS.ProcessEnv {
    const env = { ...this.env }
    delete env['CLAUDE_CONFIG_DIR']
    delete env['CODEX_HOME']
    if (registration.claudeConfigDir !== null) env['CLAUDE_CONFIG_DIR'] = registration.claudeConfigDir
    if (registration.codexHome !== null) env['CODEX_HOME'] = registration.codexHome
    return env
  }

  private async register(link: ChildLink, frame: Record<string, unknown>, socket: Socket): Promise<HubSession | string> {
    const registration = this.parseRegistration(frame)
    if (registration === null) return 'malformed-registration'
    if (this.exiting) return 'hub-exiting'
    // The peer must be this user's process, the child that said hello, and the
    // child (or the shell's child) of the harness it names, at that start.
    const peer = await (this.options.verifyPeer ?? nativePeerVerifier)(socket)
    if (peer === null) return 'peer-unverifiable'
    if (peer.uid !== process.getuid?.() || peer.pid !== link.pid) return 'peer-mismatch'
    const owner = peer.parent?.pid === registration.harnessProcess.pid ? peer.parent
      : peer.parent !== undefined && peer.parent !== null && SHELLS.has(peer.parent.comm) &&
        peer.grandparent?.pid === registration.harnessProcess.pid ? peer.grandparent : null
    if (owner === null || owner === undefined) return 'harness-not-parent'
    const sameStart = owner.ticks !== undefined && registration.harnessTicks !== null ? owner.ticks === registration.harnessTicks
      : normalizeProcessStart(owner.start) === normalizeProcessStart(registration.harnessProcess.start)
    if (!sameStart) return 'harness-start-mismatch'
    if (registration.harness === 'codex' && owner.comm !== 'codex') return 'harness-not-codex'
    const env = this.sessionEnv(registration)
    if (registration.harness === 'claude-code') {
      let raw: unknown
      try { raw = JSON.parse(readFileSync(path.join(claudeDescriptorDir(env), `${owner.pid}.json`), 'utf8')) } catch { return 'descriptor-missing' }
      const descriptor = parseDescriptor(raw)
      if (descriptor === null || descriptor.pid !== owner.pid || descriptor.sessionId !== registration.sessionId ||
          !descriptorStartMatches(descriptor.procStart, owner, owner.ticks ?? registration.harnessTicks)) return 'descriptor-mismatch'
    }
    const existing = this.sessions.get(registration.sessionId)
    if (existing !== undefined) {
      // The earlier incarnation still owes its `ended` report and holds the
      // claim: the child comes back once that has gone.
      if (existing.ending !== null) return 'session-ending'
      if (existing.child !== null && !existing.child.closed && !existing.child.ended) return 'session-already-served'
      const sameHarness = existing.harnessProcess.pid === registration.harnessProcess.pid &&
        (existing.registration.harnessTicks !== null && registration.harnessTicks !== null
          ? existing.registration.harnessTicks === registration.harnessTicks
          : normalizeProcessStart(existing.harnessProcess.start) === normalizeProcessStart(registration.harnessProcess.start))
      if (!sameHarness) {
        // Another process now hosts this session id; the old one is gone.
        this.endSession(existing, 'harness-gone')
        if (this.sessions.get(registration.sessionId) === existing) return 'session-ending'
      } else {
        existing.child = link
        existing.registration = registration
        if (existing.endCandidate !== null || existing.dormantSince !== null) {
          // The User opened the conversation again (SessionStart resume): it
          // was never closed, and what waited for it is handed in now.
          if (existing.endCandidate !== null) clearTimeout(existing.endCandidate.timer)
          existing.endCandidate = null
          existing.dormantSince = null
          this.logger.info('hub.session', { event: 'reopened', session: existing.id })
        }
        this.logger.info('hub.session', { event: 'reconnected', session: existing.id })
        existing.hinted()
        this.touch()
        return existing
      }
    }
    const starting = registration.hookEvent === 'SessionStart' || registration.source !== null
    let record: SessionIncarnation
    try {
      record = beginSessionIncarnation(registration.sessionId, env, {
        stamp: registration.stamp,
        harnessProcess: registration.harnessProcess,
        clearEarlierEnd: starting,
        ...(registration.boot === null ? {} : { boot: registration.boot }),
      })
    } catch (err) {
      this.logger.error('hub.session', { event: 'refused', reason: 'incarnation', message: err instanceof Error ? err.message : String(err) })
      return 'incarnation-unavailable'
    }
    try { retainSessionRuntime(registration.sessionId, env, currentRuntimeBuild(env)) } catch { /* Retention is update bookkeeping. */ }
    const session = new HubSession(this, registration.sessionId, registration.harness, env, registration.harnessProcess, record, registration)
    session.transcriptGone()
    session.child = link
    session.claimToken = await this.takeClaim(session)
    if (session.claimToken === null) return 'claim-held'
    if (registration.harness === 'codex' && starting) this.observeCodexStart(session)
    this.sessions.set(session.id, session)
    this.logger.info('hub.session', { event: 'registered', session: session.id, harness: session.harness,
      hook_event: registration.hookEvent, inbox: registration.inboxToken ? 'token' : registration.inboxSocket !== null ? 'socket' : 'none' })
    session.writeStatus(true)
    // A restarted hub picks up questions that still wait on this session.
    const state = readSessionState(session.id, env)
    if (pendingList(state).length > 0 || state.accepted !== undefined) {
      this.settle(session.id, session.harness, registration.cwd, 'settlement')
    }
    this.touch()
    this.driver.poke()
    return session
  }

  claimFields(incarnation: string): Record<string, unknown> {
    return { incarnation, runtime_version: packageVersion(), runtime_revision: 'hub', role: 'hub' }
  }

  /**
   * One owner per session. An attendant from an earlier build is asked to
   * step aside through the existing claim hand-off; it stops without a final
   * report, and the hub renews the same lease under the same incarnation.
   */
  private async takeClaim(session: HubSession): Promise<string | null> {
    const file = attendantClaimPath(session.id, session.env)
    const deadline = this.clock.monotonic() + HANDOFF_WAIT_MS
    let asked = false
    for (;;) {
      const token = acquireClaimFile(file, this.claimFields(session.lease.incarnation), this.clock.wall())
      if (token !== null) {
        // The previous owner's lease is this incarnation's: continue it.
        const saved = readAttendantEndingLease(session.id, session.env)
        if (saved !== null && saved.incarnation === session.lease.incarnation) session.lease.generation = saved.generation
        return token
      }
      const holder = readClaimFile(file)
      // This hub's own claim (an entry still finishing): never hand it to ourselves.
      if (holder !== null && holder['pid'] === process.pid) return null
      if (!asked && holder !== null && typeof holder['token'] === 'string' && typeof holder['incarnation'] === 'string') {
        asked = requestClaimHandoff(file, holder['token'], holder['incarnation'])
        if (asked) this.logger.info('hub.session', { event: 'handoff-requested', session: session.id })
      }
      if (this.clock.monotonic() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  private observeCodexStart(session: HubSession): void {
    const native = readNativeTurnSnapshot(session.registration.transcriptPath ?? undefined, session.id, session.env)
    const turnId = native?.latest.id
    if (native === null || native === undefined || turnId === undefined) return
    const owns = (): boolean => readSessionIncarnation(session.id, session.env)?.key === session.record.key && !sessionHasEnded(session.id, session.env)
    try {
      if (reconcileNativeTurn(session.id, session.env, session.record.key, turnId, native, owns, true)) {
        updateSessionState(session.id, session.env, (state) => ({ ...state, codex_native_turn: {
          key: session.record.key, turn_id: turnId, transcript_path: native.file,
        } }))
      }
    } catch { /* Activity is a hint; a busy lock never costs the session its attendance. */ }
  }

  // -- endings ---------------------------------------------------------------

  /** The child closed without reporting an end. */
  private childGone(session: HubSession): void {
    if (session.child?.ended === true) return
    const probe = session.probe()
    if (probe.state === 'ended') { this.endSession(session, probe.reason); return }
    // Codex unloaded a conversation its app still lists: its child is gone, its host is not.
    if (session.dormantSince !== null || session.endCandidate !== null) return
    // A close nobody reported: the kernel watch went with the child, so ask
    // once (this is rare) whether that exact harness process still runs.
    if (session.harnessGone()) {
      this.endSession(session, 'harness-gone')
      return
    }
    this.logger.info('hub.session', { event: 'child-disconnected', session: session.id })
    session.lease.setPhase('uncertain', 'session-child-disconnected')
    session.writeStatus()
    // Codex stops the child when it ends or unloads a session; the Codex app
    // does not always run SessionEnd for an unload. For an app or IDE
    // conversation, decide as SessionEnd would have.
    if (session.harness === 'codex' && codexDormantSurface(readCodexThreadOriginator(session.registration.transcriptPath)) !== null) {
      this.holdCodexEnd(session, session.registration.transcriptPath)
    }
  }

  /**
   * Positive close evidence for this incarnation: clean up locally the way
   * SessionEnd would have (when it did not run), report `ended`, and let the
   * child go.
   */
  endSession(session: HubSession, reason: EndReason): void {
    if (session.ending !== null) return
    session.ending = reason
    if (session.endCandidate !== null) { clearTimeout(session.endCandidate.timer); session.endCandidate = null }
    session.dormantSince = null
    const ended = !endsIncarnation(readSessionEndMarker(session.id, session.env), session.record)
    void (async () => {
      // Best effort, never relied on: take back a wake Notifai queued that
      // the closed thread has not shown. The prompt hook blocks one that stays.
      if (session.harness === 'codex') await this.withdrawQueuedWakes(session.id, session.env)
      if (ended) {
        const { handleSessionEnd } = await import('./hook-lifecycle.js')
        try {
          handleSessionEnd(session.env, { session_id: session.id, ...(session.registration.cwd === null ? {} : { cwd: session.registration.cwd }) }, this.clock.wall())
        } catch (err) {
          this.logger.error('hub.session', { event: 'local-end-failed', session: session.id, message: err instanceof Error ? err.message : String(err) })
        }
      }
      this.drainRetirements()
    })()
    // The harness may outlive this session (`/clear`, `/resume`): its child
    // has nothing left to watch for it.
    session.child?.send({ type: 'bye' })
    this.logger.info('hub.session', { event: 'ending', session: session.id, reason })
    if (session.notified) {
      session.lease.final = 'ended'
      session.lease.pausedUntil = 0
      this.driver.poke()
    } else this.forget(session, `ended-${reason}`)
  }

  /** A Codex SessionEnd that may be an unload: classify it once the confirmation delay passes. */
  holdCodexEnd(session: HubSession, transcriptPath: string | null): void {
    if (session.endCandidate !== null) clearTimeout(session.endCandidate.timer)
    const timer = setTimeout(() => this.classifyCodexEnd(session), this.options.codexEndConfirmMs ?? CODEX_END_CONFIRM_MS)
    session.endCandidate = { child: session.child, transcriptPath, timer }
    this.logger.info('hub.session', { event: 'end-held', session: session.id })
    this.touch()
  }

  private classifyCodexEnd(session: HubSession): void {
    const candidate = session.endCandidate
    session.endCandidate = null
    if (candidate === null || session.ending !== null || this.sessions.get(session.id) !== session) return
    // A SessionStart for this session since the end (a reopen in the same
    // host) brought a new child: the conversation is open and attended.
    const child = session.child
    if (child !== null && child !== candidate.child && !child.closed && !child.ended) {
      this.logger.info('hub.session', { event: 'end-cancelled', session: session.id, reason: 'session-restarted' })
      return
    }
    const transcriptPath = candidate.transcriptPath ?? session.registration.transcriptPath
    const evidence = {
      transcript: codexTranscriptState(transcriptPath) === 'missing' || session.transcriptGone() ? 'missing' as const : 'present' as const,
      host: session.harnessGone() ? 'gone' as const : 'alive' as const,
      // No rollout, no originator: nothing then shows the app still lists it.
      originator: readCodexThreadOriginator(transcriptPath),
      hostKind: (this.options.codexHostKind ?? codexHostKind)(session.harnessProcess.pid),
    }
    const verdict: CodexEndVerdict = classifyCodexSessionEnd(evidence)
    this.logger.info('hub.session', { event: 'end-classified', session: session.id, verdict: verdict.state,
      ...(verdict.state === 'ended' ? { reason: verdict.reason } : { surface: verdict.surface }),
      originator: evidence.originator, host: evidence.host, host_kind: evidence.hostKind, transcript: evidence.transcript })
    if (verdict.state === 'ended') { this.endSession(session, verdict.reason); return }
    session.dormantSince = this.clock.monotonic()
    if (child !== null && !child.closed) child.send({ type: 'bye' })
    session.lease.setPhase('uncertain', 'dormant-open')
    session.writeStatus()
    this.driver.poke()
    void this.dormantWake(session)
    this.touch()
  }

  private readonly dormantWaking = new Set<string>()

  /**
   * An answer (or anything else staged) for a dormant conversation waits in
   * it: one content-free wake goes into that thread's own Codex queue, which
   * Codex starts only when the conversation is loaded again, that is, when
   * the User opens it. Nothing starts or loads the thread before that.
   */
  async dormantWake(session: HubSession): Promise<void> {
    if (session.dormantSince === null || session.ending !== null || this.dormantWaking.has(session.id)) return
    const open = (): boolean => session.dormantSince !== null && session.ending === null &&
      !sessionHasEnded(session.id, session.env) && !session.harnessGone() && !session.transcriptGone()
    const lease = session.lease.generation === null ? null : { incarnation: session.lease.incarnation, generation: session.lease.generation }
    if (!open() || readSessionState(session.id, session.env).input_wake?.queued === true || !hasSessionInputs(session.id, session.env, lease)) return
    this.dormantWaking.add(session.id)
    try {
      await wakeSessionInputs(session.id, session.env, async (text) => {
        if (!open() || !hasSessionInputs(session.id, session.env, lease)) return false
        const result = await deliverIntoCodexThread({ threadId: session.id, cwd: session.registration.cwd ?? process.cwd(), env: session.env,
          adapters: this.codexAdapters(session), text, begin: open })
        this.logger.info('hub.session', { event: 'dormant-wake', session: session.id, outcome: result.status })
        return result.status === 'written'
      }, this.logger)
    } catch (err) {
      this.logger.error('hub.session', { event: 'dormant-wake', session: session.id, message: err instanceof Error ? err.message : String(err) })
    } finally {
      this.dormantWaking.delete(session.id)
    }
  }

  /** Detach and delete Notifai's own unconsumed wakes from a closing thread's native queue, when that queue is reachable. */
  private async withdrawQueuedWakes(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
    const scope = { sessionId, env }
    try {
      if (!readInputWakes(scope).some((attempt) => attempt.phase !== 'consumed' && attempt.phase !== 'cancelled')) return
      detachInputWakes({ ...scope, pendingIds: () => [] })
      await reconcileSessionInputWakes(sessionId, env, this.deps.codexQueueControl ?? connectCodexQueue)
    } catch {
      // Best effort: the prompt hook still blocks a wake the thread shows later.
    }
  }

  /** Drop a session: release its claim, record it exited, remove its end records. */
  forget(session: HubSession, reason: string): void {
    if (this.sessions.get(session.id) !== session) return
    this.sessions.delete(session.id)
    session.lease.setPhase('exited', reason)
    session.writeStatus(true)
    if (session.claimToken !== null) releaseClaimFile(attendantClaimPath(session.id, session.env), session.claimToken)
    session.claimToken = null
    this.removeEndRecords(session.id, session.harnessProcess.pid)
    this.logger.info('hub.lease', { event: 'released', session: session.id, reason })
    this.touch()
  }

  forgetEnded(session: EndedSession): void {
    this.ended.delete(session.id)
    this.touch()
  }

  private removeEndRecords(sessionId: string, harnessPid: number | null): void {
    const directory = endedRecordsDir(this.env)
    for (const file of this.endRecords()) {
      if (file.record.session_id === sessionId && (harnessPid === null || file.record.harness_pid === harnessPid)) {
        rmSync(path.join(directory, file.name), { force: true })
      }
    }
  }

  private endRecords(): { name: string; record: Record<string, unknown> }[] {
    const directory = endedRecordsDir(this.env)
    let names: string[]
    try { names = readdirSync(directory).filter((name) => name.endsWith('.json')) } catch { return [] }
    const records: { name: string; record: Record<string, unknown> }[] = []
    for (const name of names) {
      try {
        const record = JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as Record<string, unknown>
        if (typeof record['session_id'] === 'string') records.push({ name, record })
      } catch { rmSync(path.join(directory, name), { force: true }) }
    }
    return records
  }

  /**
   * O2: closes nobody reported. End records the children left when the hub
   * was down, and sessions whose saved lease names a harness process that is
   * gone or ran in an earlier boot. Each machine sweeps only its own records.
   */
  sweep(): void {
    const directory = endedRecordsDir(this.env)
    const boot = (this.options.bootIdentity ?? currentBootIdentity)()
    for (const { name, record } of this.endRecords()) {
      const sessionId = record['session_id'] as string
      const live = this.sessions.get(sessionId)
      if (live !== undefined) {
        if (live.harnessProcess.pid === record['harness_pid']) this.endSession(live, 'harness-gone')
        else rmSync(path.join(directory, name), { force: true })
        continue
      }
      this.queueEnded(sessionId, record['harness_pid'], [path.join(directory, name)])
    }
    // Saved leases with no attendant: a reboot, power loss, or a kill of the
    // harness and its child together.
    let statuses: string[]
    try { statuses = readdirSync(path.dirname(attendantStatusPath('x', this.env))).filter((name) => name.endsWith('.attendance.json')) } catch { statuses = [] }
    for (const name of statuses) {
      let status: Record<string, unknown>
      try { status = JSON.parse(readFileSync(path.join(path.dirname(attendantStatusPath('x', this.env)), name), 'utf8')) as Record<string, unknown> } catch { continue }
      const sessionId = status['session_id']
      if (typeof sessionId !== 'string' || this.sessions.has(sessionId) || this.ended.has(sessionId)) continue
      if (status['phase'] === 'exited' || typeof status['generation'] !== 'number') continue
      const claim = readClaimFile(attendantClaimPath(sessionId, this.env))
      if (claim !== null && claimHolderMayRun(claim)) continue // An attendant (or another hub) still owns it.
      const incarnation = readSessionIncarnation(sessionId, this.env)
      if (incarnation?.harness_process === undefined) continue
      const otherBoot = boot !== null && incarnation.boot !== undefined && incarnation.boot !== boot
      if (!otherBoot && (this.childWatching(sessionId, incarnation.harness_process.pid) ||
          processIdentityLiveness(incarnation.harness_process) !== 'gone')) continue
      this.queueEnded(sessionId, incarnation.harness_process.pid, [])
    }
  }

  /**
   * Whether a session child still runs for this session and harness process:
   * it writes `<pid> <harness pid>` into its lock, which it holds for life. A
   * live child has its own kernel watch and will report the end itself.
   */
  private childWatching(sessionId: string, harnessPid: number): boolean {
    try {
      const [child, harness] = readFileSync(childLockPath(this.env, sessionId), 'utf8').trim().split(' ').map(Number)
      return harness === harnessPid && child !== undefined && pidExists(child)
    } catch {
      return false
    }
  }

  private queueEnded(sessionId: string, harnessPid: unknown, records: string[]): void {
    const incarnation = readSessionIncarnation(sessionId, this.env)
    const lease = readAttendantEndingLease(sessionId, this.env)
    if (incarnation === null || lease === null || (typeof harnessPid === 'number' && incarnation.harness_process?.pid !== harnessPid)) {
      // Nothing safe to end: an older incarnation's record, or no saved fencing identity.
      for (const file of records) rmSync(file, { force: true })
      return
    }
    if (!endsIncarnation(readSessionEndMarker(sessionId, this.env), incarnation)) {
      void import('./hook-lifecycle.js').then(({ handleSessionEnd }) => {
        try { handleSessionEnd(this.env, { session_id: sessionId }, this.clock.wall()) } catch { /* reported below anyway */ }
        this.drainRetirements()
      })
    }
    this.logger.info('hub.session', { event: 'swept', session: sessionId })
    this.ended.set(sessionId, new EndedSession(this, sessionId, lease, records))
    this.driver.poke()
  }

  /** Retire questions a close queued, now rather than at some later hook. */
  private drainRetirements(): void {
    void this.runInternalHook('retirement', null, 'claude-code', this.env).catch(() => undefined)
  }

  // -- question waiters ---------------------------------------------------------

  /**
   * Run a session's question submission or answer waiter in this process,
   * where today a detached process per question ran it. One per session and
   * purpose; a request while one runs reruns it once it ends.
   */
  settle(sessionId: string, harness: HookInstallableHarness, cwd: string | null, purpose: 'submission' | 'settlement'): void {
    const key = `${sessionId}\0${purpose}`
    const running = this.settlements.get(key)
    if (running !== undefined) { running.rerun = true; return }
    const entry = { rerun: false }
    this.settlements.set(key, entry)
    const env = this.sessions.get(sessionId)?.env ?? this.env
    void (async () => {
      do {
        entry.rerun = false
        try {
          await this.runInternalHook(purpose === 'submission' ? 'question-submission' : 'question-settlement', { session_id: sessionId,
            ...(cwd === null ? {} : { cwd }) }, harness, env)
        } catch (err) {
          this.logger.error('hub.session', { event: 'settlement-failed', session: sessionId, message: err instanceof Error ? err.message : String(err) })
        }
      } while (entry.rerun && !this.exiting)
    })().finally(() => {
      this.settlements.delete(key)
      this.inputStaged(sessionId)
      this.touch()
    })
  }

  private async runInternalHook(event: string, envelope: Record<string, unknown> | null, harness: HookInstallableHarness, env: NodeJS.ProcessEnv): Promise<number> {
    const { hookRunCommand } = await import('./commands-hook-run.js')
    const deps: CommandDeps = {
      ...this.deps,
      env,
      // Each in-process hook binds its own command and session to its logger.
      ...(this.deps.logger?.enabled === true ? { logger: bootstrapLogger({ env,
        ...(typeof envelope?.['cwd'] === 'string' ? { cwd: envelope['cwd'] } : {}) }) } : {}),
      store: this.cachedStore(),
      // Every client a waiter makes ends with the credential it was made with.
      clientFactory: (baseUrl, bearer, options) =>
        (this.deps.clientFactory ?? createClient)(baseUrl, bearer, { ...options, signal: this.waiterSignal() }),
      io: { out: () => undefined, err: (line) => this.logger.debug('hub.session', { note: line }), confirm: async () => false, openUrl: () => undefined },
      spawnQuestionSettlement: (launch) => this.settle(launch.envelope.session_id ?? '', launch.harness,
        launch.envelope.cwd ?? null, launch.purpose === 'submission' ? 'submission' : 'settlement'),
      onSessionInputStaged: (sessionId) => this.inputStaged(sessionId),
      questionOwnerRole: 'hub',
    }
    delete deps.spawnHookMaintenance
    delete deps.spawnRetirement
    return hookRunCommand(deps, event, async () => envelope === null ? '' : JSON.stringify(envelope), harness)
  }

  /** An answer was staged for a session: hand it in now rather than at a later tick. */
  inputStaged(sessionId: string): void {
    this.sessions.get(sessionId)?.checkInput()
  }

  codexAdapters(session: HubSession): CodexWakeAdapters {
    if (this.deps.codexWake !== undefined) return this.deps.codexWake
    const key = session.env['CODEX_HOME'] ?? ''
    let adapters = this.codexAdapterCache.get(key)
    if (adapters === undefined) {
      adapters = systemCodexWakeAdapters(session.env)
      this.codexAdapterCache.set(key, adapters)
    }
    return adapters
  }

  // -- housekeeping --------------------------------------------------------------

  private safetyTick(): void {
    if (nativeUninstallPending(this.env)) {
      // The uninstall waits for every launcher image: the children go too.
      for (const session of this.sessions.values()) session.child?.send({ type: 'bye' })
      this.requestExit('uninstall-in-progress')
      return
    }
    const now = this.clock.wall()
    for (const session of this.sessions.values()) {
      // An archived or deleted Codex conversation is closed (E5); Codex runs no SessionEnd for it.
      if (session.transcriptGone()) { this.endSession(session, 'session-archived'); continue }
      if (session.lease.phase === 'dormant' && session.notified) { session.lease.needsFresh = true; this.driver.poke() }
      if (session.harness === 'codex' && session.lease.generation !== null) {
        refreshCodexInputActivity(session.id, session.env, session.record.key, session.registration.transcriptPath ?? undefined,
          (owner) => session.harnessAlive(owner))
        void reconcileSessionInputWakes(session.id, session.env, this.deps.codexQueueControl).catch(() => undefined)
      }
      if (session.lease.phase === 'attending' && session.lease.leaseEndsAt !== null && this.clock.monotonic() >= session.lease.leaseEndsAt) {
        // The service has not renewed the lease (an outage): say so to status readers.
        session.lease.setPhase('acquiring', 'lease-lapsed')
        session.writeStatus()
      }
      const probe = session.probe()
      if (probe.state === 'ended') this.endSession(session, probe.reason)
      else if (probe.state === 'running') {
        session.observeActivity(probe.activity)
        // Evidence came back after an uncertain read: renew again now.
        if (session.lease.phase === 'uncertain' && session.notified) this.driver.poke()
      } else if (session.child === null || session.child.closed) {
        // No kernel watch while no child is connected: ask the process table.
        // Signal 0 every tick; the start-time read (a `ps` off Linux) only now and then.
        this.disconnectedTicks += 1
        if (!pidExists(session.harnessProcess.pid) ||
            ((session.registration.harnessTicks !== null || this.disconnectedTicks % 10 === 0) && session.harnessGone())) {
          this.endSession(session, 'harness-gone')
        }
      }
      session.checkInput()
    }
    if (now - this.lastHeartbeat >= 60 * 60_000) {
      // Keep a long session's small files younger than the abandoned-state prune.
      this.lastHeartbeat = now
      for (const session of this.sessions.values()) {
        refreshSessionMarkers(session.id, session.env, now, [attendantClaimPath(session.id, session.env),
          attendantStatusPath(session.id, session.env), turnActivityPath(session.id, session.env)])
      }
    }
    if (this.endRecords().length > 0) this.sweep()
    this.touch()
  }

  /** Something happened; re-evaluate idle exit. */
  touch(): void {
    if (this.busy()) {
      this.idleSince = this.clock.monotonic()
      this.statusChanged()
      return
    }
    const idleFor = this.clock.monotonic() - this.idleSince
    const limit = this.options.idleExitMs ?? HUB_IDLE_EXIT_MS
    if (idleFor >= limit) { this.requestExit('idle'); return }
    if (this.idleTimer === null) {
      this.idleTimer = setTimeout(() => { this.idleTimer = null; this.touch() }, limit - idleFor + 50)
      this.idleTimer.unref?.()
    }
    this.statusChanged()
  }

  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private lastHeartbeat = Date.now()
  private disconnectedTicks = 0

  private busy(): boolean {
    // An update pass in progress (a download, a staged write) finishes first.
    if (this.children > 0 || this.settlements.size > 0 || this.updating) return true
    // A dormant conversation still owed something: watch its app, so a quit expires it at once.
    const now = this.clock.monotonic()
    for (const session of this.sessions.values()) {
      if (session.endCandidate !== null || session.dormantOwes(now)) return true
    }
    // Owed end reports keep the hub only while it can send them. Signed out
    // (or refused), they stay on disk and the next signed-in hub sends them.
    const canSend = this.credential !== null && !this.unauthorizedState
    return canSend && (this.ended.size > 0 || [...this.sessions.values()].some((session) => session.lease.final !== null) ||
      this.endRecords().length > 0)
  }

  statusChanged(): void {
    if (this.statusTimer !== null) return
    this.statusTimer = setTimeout(() => { this.statusTimer = null; this.writeStatusNow() }, 500)
    this.statusTimer.unref?.()
  }

  status(): Record<string, unknown> {
    return {
      pid: process.pid,
      version: packageVersion(),
      build: buildIdentity()?.sourceDigest ?? null,
      ipc_version: HUB_IPC_VERSION,
      started_at: new Date(this.startedAt).toISOString(),
      transport: this.driver.transport,
      requests: this.driver.requests,
      last_exchange_at: this.driver.lastSuccessAt === null ? null : new Date(this.driver.lastSuccessAt).toISOString(),
      children: this.children,
      credential: this.unauthorizedState ? 're-pair-needed' : this.credential === undefined ? 'unread' : this.credential === null ? 'absent' : 'present',
      recent_crashes: this.crashes,
      settlements: this.settlements.size,
      sessions: [...this.sessions.values()].map((session) => ({
        session_id: session.id,
        harness: session.harness,
        phase: session.lease.phase,
        reason: session.lease.reason,
        generation: session.lease.generation,
        activity: session.activity(),
        child: session.child !== null && !session.child.closed,
        watching: session.harnessAlive(),
        accepts_messages: session.writerAvailable(),
      })),
      pending_end_reports: this.ended.size,
    }
  }

  private writeStatusNow(exited = false): void {
    try {
      atomicWriteFileSync(hubStatusPath(this.env), `${JSON.stringify({ ...this.status(), state: exited ? 'exited' : 'running',
        updated_at: new Date(this.clock.wall()).toISOString() })}\n`)
    } catch { /* diagnostic */ }
  }
}

/** The native launcher beside this runtime (or a development build's), for kernel peer checks. */
export function launcherExecutable(): string | null {
  const extension = process.platform === 'win32' ? '.exe' : ''
  const candidate = buildIdentity() !== null
    ? path.join(path.dirname(process.execPath), `notifai${extension}`)
    : fileURLToPath(new URL(`./native/notifai${extension}`, import.meta.url))
  return existsSync(candidate) ? candidate : null
}

/** Asks the launcher for the connected peer's kernel credentials and ancestry. */
export const nativePeerVerifier: PeerVerifier = (socket) => peerVerifierFor(launcherExecutable())(socket)

export function peerVerifierFor(launcher: string | null): PeerVerifier {
  return (socket) => launcher === null ? Promise.resolve(null) : askLauncher(launcher, socket)
}

function askLauncher(launcher: string, socket: Socket): Promise<PeerCredentials | null> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(launcher, ['--internal-peer-credentials'], { stdio: [socket, 'pipe', 'ignore'], env: {} })
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    // Node pauses a socket it hands to a child's stdio; resume it afterwards.
    child.once('error', () => { clearTimeout(timer); socket.resume(); resolve(null) })
    child.once('close', (code) => {
      clearTimeout(timer)
      socket.resume()
      if (code !== 0) { resolve(null); return }
      try { resolve(JSON.parse(output) as PeerCredentials) } catch { resolve(null) }
    })
  })
}

let cachedBoot: string | null | undefined
/** This boot: Linux's boot id, macOS's boot session UUID. A different value means a reboot or power loss. */
export function currentBootIdentity(): string | null {
  if (cachedBoot !== undefined) return cachedBoot
  cachedBoot = null
  try {
    if (process.platform === 'linux') cachedBoot = `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}`
    else if (process.platform === 'darwin') {
      const launcher = launcherExecutable()
      if (launcher !== null) cachedBoot = execFileSync(launcher, ['--internal-boot-identity'], { encoding: 'utf8', timeout: 2_000 }).trim() || null
    }
  } catch {
    cachedBoot = null
  }
  return cachedBoot
}

/** Loaded only for a managed native installation (the updater's installation authority). */
let nativeInstallationModule: { managedInstallation: typeof ManagedInstallation } | null = null

/** The next hub, from the stable launcher, so it runs whatever build is active now. */
export function startSuccessorHub(env: NodeJS.ProcessEnv): void {
  const home = osAccountHome()
  const launcher = path.join(home, '.notifai', 'bin', process.platform === 'win32' ? 'notifai.exe' : 'notifai')
  const child = spawn(launcher, ['hub', '--owner', 'notifai'], { cwd: home, env: hubEnvironment(env), detached: true, stdio: 'ignore' })
  child.once('error', () => undefined)
  child.unref()
}

/** `notifai hub`: run the hub in this process until it is idle or told to stop. */
export async function hubCommand(deps: CommandDeps): Promise<number> {
  // Automatic updates run only in a managed native installation.
  if (buildIdentity() !== null) nativeInstallationModule = await import('./native-installation.js')
  const hub = new Hub(deps, { deps, handleSignals: true, ...(buildIdentity() !== null ? { automaticUpdate: {} } : {}) })
  return hub.run()
}
