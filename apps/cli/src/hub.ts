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
import { codexAttachVerified, codexThreadAttachState, type CodexAttachInput, type CodexAttachState } from './codex-attach-signal.js'
import { checkCodexServerBuild } from './codex-attach-canary.js'
import {
  codexAppSurface,
  codexHostHoldsThread,
  codexHostKind,
  codexThreadHeld,
  codexThreadHolders,
  locateCodexRollout,
  readCodexSessionMeta,
  readCodexThreadOriginator,
  type CodexHostKind,
  type RolloutPlace,
} from './codex-session-end.js'
import { readNativeTurnSnapshot } from './codex-native-turn.js'
import { inspectCodexQueue, systemCodexWakeAdapters, type CodexWakeAdapters } from './codex-wake.js'
import { EXIT, log, makeClient, type CommandDeps } from './commands-core.js'
import type { CredentialStore, MachineCredential } from './credentials.js'
import { buildIdentity } from './distribution.js'
import { isHookInstallableHarness, type HookInstallableHarness } from './harnesses.js'
import { acquireClaimFile, claimHolderMayRun, readClaimFile, releaseClaimFile, requestClaimHandoff, standDownQuestionOwners } from './hook-question-lock.js'
import {
  beginSessionIncarnation,
  endsIncarnation,
  pendingList,
  readSessionEndMarker,
  readSessionIncarnation,
  readSessionState,
  refreshSessionMarkers,
  rehostSessionIncarnation,
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
  type AttemptOutcome,
  type AutomaticUpdateHost,
  type WaitingReason,
} from './automatic-update.js'
import { adoptionCandidates, childWatching, parseAdoptionRecord, recordedRolloutArchived, stoppedCandidates, type AdoptionRecord,
  type StoppedRecord, type StoppedWatch } from './hub-adoption.js'
import { hubEnvironment } from './hub-client.js'
import { readActiveBuild } from './hub-handover.js'
import type { ActivationPlan } from './activation-plan.js'
import { osAccountHome } from './os-account-home.js'
import { olderClaudeAttendantsAlive, readClaudeFormDeferral } from './claude-form-readers.js'
import type { managedInstallation as ManagedInstallation } from './native-installation.js'
import {
  credentialGenerationPath,
  encodeFrame,
  endedRecordsDir,
  ensurePrivateDirectory,
  FrameDecoder,
  HUB_IPC_VERSION,
  HUB_IPC_VERSIONS,
  hubHistoryPath,
  fnv64Hex,
  hubLockPath,
  hubRunDir,
  hubSettlementsDir,
  hubSocketPath,
  hubStatusPath,
  readShutdownMarker,
  SHUTDOWN_MARKER_FRESH_MS,
  shutdownMarkerPath,
  writeShutdownMarker,
} from './hub-ipc.js'
import { SessionLease, type LeaseOutcome } from './hub-lease.js'
import { dropExpiredHeldAnswers, moveQuestionsToSuccessor } from './stopped-hold.js'
import { shareGitIdentityAnswers } from './git-query.js'
import { ingressRefusal, parseIngressRequest, resultFrames, runIngressHook, type IngressHost, type IngressIdentity } from './hub-ingress.js'
import { currentRuntimeBuild } from './launch-self.js'
import { bootstrapLogger, type Logger } from './logging.js'
import { nativeUninstallPending } from './native-uninstall-barrier.js'
import { accountHome } from './platform.js'
import { descriptorStartMatches, linuxStartTicks, normalizeProcessStart, pidExists, processIdentityLiveness, processStartTime, type ProcessIdentity } from './process-identity.js'
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
  inputWakeDeferred,
  inputWakeOverdue,
  reconcileSessionInputWakes,
  stageSessionMessages,
  wakeCodexSessionInputs,
  wakeSessionInputs,
} from './session-inputs.js'
import { compareVersions } from './version.js'
import { QUESTION_WAITER_CEILING_SECONDS } from './question-timing.js'
import { claudePlaceOf, codexPlaceOf, orcaTerminalHostOf, parentProcessOf, placeReceives, type SessionPlace } from './session-place.js'
import {
  classifyClaudeEnd,
  classifyCodexEnd,
  claudeDesktopPauseLogged,
  claudeDesktopPaths,
  claudeForkParent,
  claudeTranscriptPresent,
  machineDownEarlierBoot,
  readClaudeDesktopRecord,
  type AppStopReason,
  type ClaudeEndEvidence,
  type CloseVerdict,
  type CodexEndEvidence,
  type Recorded,
} from './session-close-classifier.js'
import { systemdStopping, systemPowerWatch, type PowerEvent, type PowerWatch, type PowerWatchFactory } from './power-watch.js'

/** The hub leaves this long after nothing is connected and nothing is owed (Proposal). */
export const HUB_IDLE_EXIT_MS = 30_000
/** Restarts stop for the rest of this window after this many crashes in it (Proposal). */
export const HUB_CRASH_LIMIT = 3
export const HUB_CRASH_WINDOW_MS = 10 * 60_000
/** A Claude wake accepted but still not shown after this long idle is treated as lost. */
const IDLE_BEFORE_WAKE_REPLACEMENT_MS = 30_000
/** Safety re-read of activity and pending input; events do the ordinary work. */
const SAFETY_TICK_MS = 15_000
/**
 * How often an open question's conversation on Codex's shared server is
 * checked for a closed terminal (Codex reports none), and how long one
 * confirmation that a terminal shows it lets a wake through.
 */
const CODEX_ATTACH_WATCH_MS = 10_000
const CODEX_ATTACH_WAKE_MS = 10_000
/** A SessionEnd this soon after Notifai's own confirming request is that request's reload. */
const CODEX_OWN_RELOAD_MS = 10_000
/** A claimed write must begin within this bound of the child reading the request. */
const CHILD_WRITE_DEADLINE_MS = 8_000
/**
 * A child gets this long to answer a write request: past its own deadline
 * (and its five-second connect), so a write the hub already gave up on cannot
 * still land; inside the service's 30 s claim window.
 */
const CHILD_WRITE_TIMEOUT_MS = 20_000
/** A Claude Code descriptor still being written is read again this often, this many times, at registration. */
const DESCRIPTOR_SETTLE_MS = 100
const DESCRIPTOR_SETTLE_TRIES = 10
/** How long an accepted hook waits for the launcher to commit it to the hub. */
const INGRESS_GO_WAIT_MS = 5_000
/** How long a new hub waits for a replaced attendant to step aside. */
const HANDOFF_WAIT_MS = 10_000
/** First automatic-update pass after the hub starts, then the pass interval. The lookup itself is daily. */
const AUTOMATIC_UPDATE_FIRST_MS = 60_000
const AUTOMATIC_UPDATE_INTERVAL_MS = 10 * 60_000
const SHELLS: ReadonlySet<string> = new Set(['sh', 'dash', 'bash', 'zsh', 'ksh', 'mksh', 'fish'])
/**
 * The end confirmation: how long the hub waits after a session's end signal
 * (SessionEnd, its harness exiting, its child going) before deciding what it
 * meant. A same-moment handoff brings the same conversation back within it:
 * the shared Codex server reloads a resumed thread in about two seconds, the
 * Claude desktop app respawns a session in under one, `/desktop`, `/app` and a
 * resume in a new tab start it at once. An archive moves the rollout and an
 * app quit takes its host down within it. Anything not back by then was
 * closed, and its questions expire.
 */
export const END_CONFIRM_MS = 10_000
/** A stopped conversation keeps the hub alive at most one answer window. */
const STOPPED_CEILING_MS = QUESTION_WAITER_CEILING_SECONDS * 1000
/** A fork's transcript may not name its parent yet at its first hook: looked at again at this many later hooks. */
const FORK_CHECKS = 5
/**
 * A Session Note staged for a stopped conversation waits this long from the
 * stop (Proposal). Before the service holds notes for stopped sessions, only a
 * note the service handed over before the stop can be waiting.
 */
const STOPPED_NOTE_HOLD_MS = 24 * 60 * 60_000
/**
 * How long a hub that hands over waits for work already in flight (a hook it
 * serves, a write into a session, a wake, an answer owner finishing a step)
 * before it leaves anyway. Everything else is on disk for the next hub.
 */
const HANDOVER_DRAIN_MS = 30_000

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
  /** Test seam; production waits END_CONFIRM_MS. */
  endConfirmMs?: number
  /** Test seam; production waits at most HANDOVER_DRAIN_MS for work in flight. */
  handoverDrainMs?: number
  /**
   * The machine's shutdown signal (see `power-watch.ts`). Absent: the
   * platform's own (the real process only); false: none.
   */
  powerWatch?: PowerWatchFactory | false
  /** Test seam: where the Claude desktop app keeps its sessions and log; production reads the account home's. */
  claudeDesktop?: { sessions: string; log: string } | null
  /** Test seam: run one internal hook (an answer owner); production runs `hookRunCommand` in this process. */
  runHook?: (event: string, envelope: Record<string, unknown> | null, harness: HookInstallableHarness, env: NodeJS.ProcessEnv) => Promise<number>
  /** Test seam: what kind of process hosts a Codex session; production asks `ps`. */
  codexHostKind?: typeof codexHostKind
  /** Test seams for Codex's shared server (see `codex-attach-signal.ts`). */
  codexAttach?: {
    /** Whether Codex's behaviour was checked for the binary this host runs. */
    verified?: (host: ProcessIdentity) => boolean
    state?: (input: CodexAttachInput) => Promise<CodexAttachState>
    checkBuild?: (host: ProcessIdentity) => Promise<{ outcome: 'passed' | 'failed'; step?: number; codexVersion: string | null; detail?: string } | null>
    watchMs?: number
  }
  /** Test seam: whether a process holds a Codex thread's writer lock; production asks `lsof` or `/proc`. */
  codexHostHoldsThread?: (codexHome: string | null, threadId: string, pid: number) => boolean
  /** Test seam: whether any process has a Codex thread loaded; production asks `lsof` or `/proc`. */
  codexThreadHeld?: (codexHome: string | null, threadId: string) => boolean | 'unknown'
  /** Test seam: which processes have a Codex thread loaded; production asks `lsof` or `/proc`. */
  codexThreadHolders?: (codexHome: string | null, threadId: string) => number[] | 'unknown'
  /** Test seam: the Orca terminal host above a harness in an Orca pane; production walks the process table. */
  orcaTerminalHostOf?: (harnessPid: number) => ProcessIdentity | null
  /** Test seam: the process that started another; production asks `ps`. */
  parentProcessOf?: (pid: number) => ProcessIdentity | null
  /** Test seam: the build and installation this hub runs; production reads its own managed build once. */
  ingressIdentity?: () => IngressIdentity | null
  /**
   * Automatic updates (design §11). Absent: off (tests and development).
   * `hubCommand` supplies the production updater for a managed installation.
   */
  automaticUpdate?: AutomaticUpdateOptions
  /**
   * Handing over to another active build (a manual, npm or curl update, a
   * rollback). Absent: off (tests and development). `hubCommand` supplies it
   * for a managed installation.
   */
  handover?: HandoverOptions
}

export interface HandoverOptions {
  /** The build this hub runs and the installation's active build; production reads its own build and `active.json`. */
  builds?: () => { running: string; active: string | null } | null
  /** Ask the active build what its hub serves. Null when it cannot say. */
  plan?: (activeBuild: string) => Promise<ActivationPlan | null>
  /** Start the next hub after this one hands over; production runs the stable launcher. */
  startSuccessor?: (env: NodeJS.ProcessEnv) => void
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

  /** Writes asked of the child that it has not answered yet. */
  get writesInFlight(): number {
    return this.pending.size
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

type EndReason = 'harness-gone' | 'session-replaced' | 'session-end-hook' | 'session-archived' |
  /** No terminal shows a conversation on Codex's shared server any more (it reports no close). */
  'terminal-closed' |
  /** A stopped conversation: every window it waited for ended, it was deleted or archived, or its app quit. */
  'window-over' | 'session-deleted' | 'app-quit' |
  /** It continued as a fork with a new id; until the service can re-home its items there, they expire. */
  'moved'

/** Why a conversation stopped without the User closing it: its app paused it, or the machine went down. */
export type StopCause = 'app' | 'machine'

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
  /** Where the conversation runs (see `session-place.ts`). */
  place: SessionPlace
  /** The process that started the harness (the desktop app's main process, T3 Code's server, Orca's supervisor), when known. */
  hostApp: ProcessIdentity | null
  /** An Orca pane's terminal host, when the harness runs in one. */
  terminalHost: ProcessIdentity | null
}

/**
 * One process hosting a conversation, with the session child that watches
 * it. A Claude Code conversation can be open in two places at once (two
 * terminals, a terminal and the desktop app): each is a writer.
 */
interface Writer {
  child: ChildLink
  harnessProcess: ProcessIdentity
  registration: Registration
  env: NodeJS.ProcessEnv
}

const identityKey = (identity: ProcessIdentity): string => `${identity.pid}\0${normalizeProcessStart(identity.start)}`

/**
 * The most recently opened of two writers: the one whose session child began
 * serving this conversation later (its first hook for it), then the higher pid.
 */
function openedLater(a: Writer, b: Writer): boolean {
  return a.registration.stamp.wall !== b.registration.stamp.wall
    ? a.registration.stamp.wall > b.registration.stamp.wall
    : a.harnessProcess.pid > b.harnessProcess.pid
}

/** One Agent Session the hub attends. */
class HubSession implements AttendedSession {
  lease: SessionLease
  /** The primary writer's child: the only one anything is written through. */
  child: ChildLink | null = null
  /**
   * The other live writers of this conversation, on standby: nothing is
   * written through them, their prompt hooks drain nothing, and the most
   * recently opened takes over when the primary goes.
   */
  standbys: Writer[] = []
  /** Harness processes whose exit their child's kernel watch reported: never a writer again. */
  readonly exited = new Set<string>()
  /** Processes that ran SessionEnd for this conversation and have not opened it again since. */
  readonly left = new Set<number>()
  /**
   * Monotonic time the Codex host was seen holding the thread's writer lock
   * again after its end (the shared server reloaded it in place), while no
   * child is back yet: the conversation is loaded there and runs.
   */
  reloadedAt: number | null = null
  claimToken: string | null = null
  idleSince: number | null = null
  private activityValue: SessionActivity = 'idle'
  private lastPhaseWritten = ''
  ending: EndReason | null = null
  codexObserver: ReturnType<typeof codexInputObserver> | null = null
  /**
   * Codex's shared server only (see `codex-attach-signal.ts`): until when
   * (monotonic) a confirmation that a terminal shows the thread lets a wake
   * through; when the input check last asked (at most every 10 s); whether
   * the close watch waits for the next turn (a terminal that joined the
   * thread shows it; a waiting item is checked by the input check meanwhile);
   * and Notifai's own last confirming request, whose reload runs SessionEnd.
   */
  attachWakeUntil = 0
  attachAskedAt = -Infinity
  attachWatchPaused = false
  attachOwnReload: { pid: number; at: number } | null = null
  /** An end signal waiting for the end confirmation (see `END_CONFIRM_MS`). */
  endCandidate: { child: ChildLink | null; transcriptPath: string | null; timer: ReturnType<typeof setTimeout>; reason: EndReason;
    since: number } | null = null
  /** The rollout existed at some point; only then does its absence mean an archive or delete. */
  transcriptSeen = false
  /**
   * A conversation stopped by its app or by the machine, not closed by the
   * User (wall-clock milliseconds): nothing runs it, its questions stay open
   * for their windows, and what is answered meanwhile reaches it when it
   * comes back in place. The lease is not renewed (the session shows as out
   * of reach) but its fencing identity is kept.
   */
  stopped: StoppedRecord | null = null
  /** Wall-clock milliseconds of the last hook the hub saw for this conversation. */
  lastActivity: number
  /** Later hooks at which a fork's parent is looked for again; 0 when not a fork. */
  forkChecks = 0
  /** It was stopped when it ended (its Codex wake is only detached then). */
  wasStopped = false
  /**
   * Session Notes and Answer Edits the service holds for this conversation
   * while it is stopped (seen, never claimed): each keeps it waiting for its
   * own hold.
   */
  held: { message_id: string; created_at: string }[] = []

  constructor(
    readonly hub: Hub,
    readonly id: string,
    readonly harness: 'claude-code' | 'codex',
    /** The primary writer's environment: the hub's, plus that writer's harness homes. */
    public env: NodeJS.ProcessEnv,
    public harnessProcess: ProcessIdentity,
    public record: SessionIncarnation,
    public registration: Registration,
  ) {
    this.lease = new SessionLease(record.incarnation, (expected) => this.rotate(expected))
    this.lastActivity = registration.stamp.wall
    this.observeCodex()
  }

  private observeCodex(): void {
    if (this.harness !== 'codex') return
    this.codexObserver = codexInputObserver(this.id, this.env, this.record.key, () => this.hub.clock.monotonic(),
      this.registration.transcriptPath ?? undefined, (owner) => this.harnessAlive(owner), (owner) => this.hub.codexIdleWake(this, owner))
  }

  /** The primary as a writer, while its child is connected. */
  primary(): Writer | null {
    return this.child === null ? null : { child: this.child, harnessProcess: this.harnessProcess, registration: this.registration, env: this.env }
  }

  /**
   * Whether this writer hosts the conversation now: its child is connected
   * and has not seen the harness exit, and a Claude Code process's own
   * descriptor still names this conversation (after `/clear` or an in-session
   * `/resume` it names another).
   */
  hosts(writer: Writer): boolean {
    if (writer.child.closed || writer.child.ended || this.exited.has(identityKey(writer.harnessProcess)) ||
        this.left.has(writer.harnessProcess.pid)) return false
    if (this.harness !== 'claude-code') return true
    const descriptor = readClaudeDescriptor(writer.env, writer.harnessProcess.pid)
    return descriptor !== null && descriptor.sessionId === this.id &&
      descriptorStartMatches(descriptor.procStart, writer.harnessProcess, writer.registration.harnessTicks)
  }

  /** The standby that takes over: the most recently opened that still hosts the conversation. */
  nextPrimary(): Writer | null {
    let best: Writer | null = null
    for (const writer of this.standbys) if (this.hosts(writer) && (best === null || openedLater(writer, best))) best = writer
    return best
  }

  /**
   * Make this writer the primary. The incarnation stays (same key, service
   * identity and lease) and names the new host, so prompt hooks of every
   * other writer drain nothing. With `keepPrevious` the previous primary
   * becomes a standby while it still hosts the conversation; otherwise it is
   * let go.
   */
  promote(writer: Writer, keepPrevious = false): void {
    const previous = this.primary()
    this.standbys = this.standbys.filter((standby) => standby !== writer)
    if (previous !== null && previous.child !== writer.child) {
      if (keepPrevious && this.hosts(previous)) this.standbys.push(previous)
      else this.hub.letGo(this, previous)
    }
    this.child = writer.child
    this.harnessProcess = writer.harnessProcess
    this.registration = writer.registration
    this.env = writer.env
    this.reloadedAt = null
    this.rehost(writer.harnessProcess, writer.registration.boot)
    this.observeCodex()
    this.lease.needsFresh = true
    this.writeStatus(true)
  }

  /** The incarnation names this process as its host from now on. */
  rehost(harnessProcess: ProcessIdentity, boot: string | null): void {
    try {
      const next = rehostSessionIncarnation(this.id, this.env, this.record.key, harnessProcess, boot ?? undefined)
      if (next !== null) this.record = next
    } catch (err) {
      this.hub.logger.error('hub.session', { event: 'rehost-failed', session: this.id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Kernel evidence: the child is connected, watching this exact process, and has not seen it exit. */
  harnessAlive(owner: ProcessIdentity = this.harnessProcess): boolean {
    return this.child !== null && !this.child.closed && !this.child.ended &&
      owner.pid === this.harnessProcess.pid && normalizeProcessStart(owner.start) === normalizeProcessStart(this.harnessProcess.start)
  }

  /** Where the Codex rollout this session writes is now, found by its id. */
  rollout(): RolloutPlace {
    const home = this.registration.codexHome ?? this.env['CODEX_HOME'] ?? null
    const place = locateCodexRollout(home, this.id, this.registration.transcriptPath).place
    if (place === 'sessions') this.transcriptSeen = true
    return place
  }

  /** The Codex rollout this session writes was archived or deleted (E5). */
  transcriptGone(): boolean {
    if (this.harness !== 'codex' || this.registration.transcriptPath === null) return false
    const place = this.rollout()
    return (place === 'missing' || place === 'archived') && this.transcriptSeen
  }

  /**
   * Something still waits, inside its own window, on this stopped
   * conversation: an open question, an answer to one, a staged note.
   */
  stoppedOwes(wall: number): boolean {
    if (this.stopped === null) return false
    const lease = this.lease.generation === null ? null : { incarnation: this.lease.incarnation, generation: this.lease.generation }
    return owesWhileStopped(this.id, this.env, this.stopped.since, lease, wall, this.held)
  }

  /**
   * The service holds this conversation as stopped and drops an unread
   * answer at its question's window: drop it here at the same moment, so it
   * is never handed in after the User was told it did not arrive.
   */
  dropExpiredAnswers(): void {
    if (!this.lease.stopReported) return
    const dropped = dropExpiredHeldAnswers(this.id, this.env, this.hub.clock.wall())
    if (dropped.length > 0) this.hub.logger.info('hub.session', { event: 'held-answers-dropped', session: this.id, answers: dropped.length, reason: 'window-over' })
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
    if (this.child === null || this.child.closed) {
      // The shared Codex server reloaded the thread in place: it runs there
      // until its next prompt brings a child back. Nothing is woken meanwhile.
      if (this.harness === 'codex' && this.reloadedAt !== null) {
        return { state: 'running', activity: observedCodexTurnActivity(this.id, this.env, this.record.key) ?? 'idle' }
      }
      return { state: 'uncertain', reason: 'session-child-disconnected' }
    }
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
    // Stopped: nothing hosts it until it comes back in place.
    if (this.stopped !== null) return false
    const probe = this.probe()
    if (probe.state === 'ended') { this.hub.closing(this, probe.reason); return false }
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
    return this.hub.handing(() => this.harness === 'claude-code' ? this.handClaude(messages) : this.handCodex(messages))
  }

  settled(outcome: LeaseOutcome): void {
    if (outcome.kind === 'rotated') this.rekeyClaim()
    if (outcome.kind === 'reported') {
      if (outcome.successor !== null) { this.hub.continuedAt(this, outcome.successor); return }
      this.hub.forget(this, `reported-${outcome.state}`)
      return
    }
    if (outcome.kind === 'successor-refused') { this.hub.successorRefused(this, outcome.successor); return }
    if (outcome.kind === 'stopped') {
      const held = outcome.messages.map((message) => ({ message_id: message.message_id, created_at: message.created_at }))
      const changed = held.length !== this.held.length || held.some((message, index) => message.message_id !== this.held[index]?.message_id)
      this.held = held
      if (changed) {
        this.hub.logger.info('hub.session', { event: 'stopped-held', session: this.id, messages: held.length })
        this.hub.touch()
      }
    }
    if (outcome.kind === 'stop-refused') this.hub.logger.info('hub.session', { event: 'stopped-not-held', session: this.id })
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
    if (this.stopped !== null) return
    // A turn passed: the close watch looks again.
    this.attachWatchPaused = false
    this.lastActivity = Math.max(this.lastActivity, this.hub.clock.wall())
    if (this.forkChecks > 0) this.hub.checkFork(this)
    if (this.harness === 'codex') refreshCodexInputActivity(this.id, this.env, this.record.key,
      this.registration.transcriptPath ?? undefined, (owner) => this.harnessAlive(owner))
    if (this.lease.phase === 'withdrawn') {
      // The old attendant's next hook re-armed it; the hub re-arms on the next boundary.
      this.lease.generation = null
      this.lease.setPhase('acquiring', 're-armed')
      this.lease.needsFresh = true
    }
    const probe = this.probe()
    if (probe.state === 'ended') { this.hub.closing(this, probe.reason); return }
    if (probe.state === 'running') this.observeActivity(probe.activity)
    this.checkInput()
    this.hub.driver.poke()
  }

  settledIdle(): boolean {
    return this.idleSince !== null && this.hub.clock.monotonic() - this.idleSince >= IDLE_BEFORE_WAKE_REPLACEMENT_MS
  }

  /** Staged input that needs a wake: cut the held exchange and hand it in. */
  checkInput(): void {
    // A hub handing over starts no new write; the next hub hands the input in.
    if (this.hub.handingOver) return
    // Stopped: a Codex thread gets one wake in its own queue, run when it loads again.
    if (this.stopped !== null) { if (this.harness === 'codex') void this.hub.stoppedWake(this); return }
    if (!this.notified || this.lease.generation === null || this.hub.clock.monotonic() < this.lease.pausedUntil) return
    const lease: DeliveryLease = { incarnation: this.lease.incarnation, generation: this.lease.generation }
    let pending = false
    const state = readSessionState(this.id, this.env)
    // A wake shown without its input handed in spaces out the next one.
    if (inputWakeDeferred(state, this.hub.clock.wall())) return
    if (this.harness === 'claude-code') {
      pending = !claudePickerHolds(state) &&
        (!state.input_wake?.queued || (this.settledIdle() && inputWakeOverdue(state, this.hub.clock.wall()))) &&
        hasSessionInputs(this.id, this.env, null)
    } else {
      const waiting = !state.input_wake?.queued && hasSessionInputs(this.id, this.env, lease)
      pending = waiting && (this.codexObserver?.mayWake() ?? false)
      // On Codex's shared server a wake waits until a terminal is seen to show the thread.
      if (waiting && !pending && this.hub.codexSharedServer(this)) void this.hub.checkCodexAttach(this, 'input')
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
    // While an end waits for its confirmation, everything stays held.
    if (this.ending !== null || this.endCandidate !== null || this.hub.handingOver || !this.claimHeld()) return false
    if (readSessionIncarnation(this.id, this.env)?.incarnation !== this.lease.incarnation) return false
    const probe = this.probe()
    if (probe.state !== 'running') return false
    return this.lease.covers(this.hub.clock.monotonic(), this.hub.driver.currentEpoch, this.hub.credentialKey())
  }

  writerAvailable(): boolean {
    if (this.child === null || this.child.closed || this.endCandidate !== null) return false
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

  /** What the next hub needs to take this session over without its child. */
  adoptionRecord(): AdoptionRecord {
    const registration = this.registration
    return {
      harness: this.harness,
      harness_process: this.harnessProcess,
      harness_ticks: registration.harnessTicks,
      boot: registration.boot,
      cwd: registration.cwd,
      transcript_path: registration.transcriptPath,
      claude_config_dir: registration.claudeConfigDir,
      codex_home: registration.codexHome,
      last_activity_at: this.lastActivity,
      transcript_seen: this.transcriptSeen,
      end_candidate_since: this.endCandidate?.since ?? null,
      place: registration.place,
      host_app: registration.hostApp,
      terminal_host: registration.terminalHost,
      stopped: this.stopped,
    }
  }

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
    // The last activity counts by the minute: the next hub needs it only for a 30-minute idle stop.
    const phase = `${this.lease.phase}|${this.lease.reason}|${this.lease.generation}|${this.activityValue}|${this.writerAvailable()}|` +
      `${Math.floor(this.lastActivity / 60_000)}|${this.transcriptSeen}|${this.endCandidate?.since ?? null}|${this.harnessProcess.pid}|${this.stopped?.cause ?? null}`
    if (!force && phase === this.lastPhaseWritten) return
    this.lastPhaseWritten = phase
    try {
      writeAttendantStatus(this.id, this.env, {
        // A stopped session reads as exited to a hub from an earlier build, so
        // its sweep never ends it; the fencing identity stays for this build's.
        phase: this.lease.phase === 'withdrawn' || (this.stopped !== null && this.lease.phase !== 'exited') ? 'exited' : this.lease.phase,
        incarnation: this.lease.incarnation,
        generation: this.lease.generation,
        activity: this.activityValue,
        reason: this.stopped !== null && this.lease.phase !== 'exited' ? 'stopped' : this.lease.reason,
        accepts_messages: this.writerAvailable(),
        updated_at: this.hub.clock.wall(),
        adoption: this.adoptionRecord(),
      })
    } catch {
      // Status is diagnostic; attendance continues without it.
    }
    this.hub.statusChanged()
  }
}

/**
 * Whether a stopped conversation still waits for something inside its own
 * window: a question asked of the User, an answer to one, a staged note
 * (24 h). Never longer than one answer window from the stop.
 */
function owesWhileStopped(sessionId: string, env: NodeJS.ProcessEnv, since: number, lease: DeliveryLease | null, wall: number,
  held: readonly { created_at: string }[] = []): boolean {
  if (wall - since >= STOPPED_CEILING_MS) return false
  const state = readSessionState(sessionId, env)
  const open = (deadline: number | undefined): boolean => deadline === undefined || deadline > wall
  // Asked of the User (a request exists, or its submission began) and not past its window.
  if (pendingList(state).some((entry) => (entry.request_id !== undefined || entry.submission !== undefined) && open(entry.reply_deadline_at))) return true
  for (const answer of [...(state.accepted?.answers ?? []), ...(state.waiting_answers ?? [])]) {
    if (open(answer.pending.reply_deadline_at)) return true
  }
  // A note the service holds for it, within the note's own hold.
  if (held.some((message) => wall - Date.parse(message.created_at) < STOPPED_NOTE_HOLD_MS)) return true
  if (wall - since >= STOPPED_NOTE_HOLD_MS) return false
  return lease !== null && hasSessionInputs(sessionId, env, lease)
}

/** A recorded process's liveness now; null when none was recorded or it cannot be told. */
function recordedLiveness(identity: ProcessIdentity | null): Recorded {
  if (identity === null) return null
  const liveness = processIdentityLiveness(identity)
  return liveness === 'unknown' ? null : liveness
}

/**
 * Which process quitting, once the app stopped a conversation, means the User
 * quit that app: the app-server itself for the Codex app and IDE extension,
 * the app that started the harness for the Claude desktop app, Orca chats and
 * T3 Code. Nothing for an Orca pane, whose terminal host is already gone.
 */
function watchedAfter(reason: AppStopReason): StoppedWatch {
  if (reason === 'app-unloaded' || reason === 'ide-unloaded') return 'harness'
  return reason === 'terminal-host-died' ? null : 'host-app'
}

/** A stopped conversation the start sweep or a previous hub recorded; nothing a scripted run may take over. */
function stoppedOnDisk(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const status = JSON.parse(readFileSync(attendantStatusPath(sessionId, env), 'utf8')) as Record<string, unknown>
    return status['phase'] === 'exited' && status['reason'] === 'stopped'
  } catch {
    return false
  }
}

/** A Claude Code process's own session descriptor, or null. */
function readClaudeDescriptor(env: NodeJS.ProcessEnv, pid: number): ReturnType<typeof parseDescriptor> {
  try {
    const descriptor = parseDescriptor(JSON.parse(readFileSync(path.join(claudeDescriptorDir(env), `${pid}.json`), 'utf8')))
    return descriptor !== null && descriptor.pid === pid ? descriptor : null
  } catch {
    return null
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
    this.hub.endReported(this)
  }
}

/** One answer owner the hub runs, as `run/settlements` records it. */
interface SettlementRecord {
  file: string
  sessionId: string
  harness: HookInstallableHarness
  cwd: string | null
  purpose: 'submission' | 'settlement'
  claudeConfigDir: string | null
  codexHome: string | null
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
  /**
   * Handing over to the active build: no new hook, write, wake or answer
   * owner starts here, and work in flight finishes before this hub leaves.
   */
  handingOver = false
  /** Session Messages, answers and wakes being handed into sessions right now. */
  private handIns = 0
  /** Local end work (`handleSessionEnd`) started for sessions that just ended. */
  private readonly localEnds = new Set<Promise<void>>()
  /** An automatic update activated a new build, or another build became active: start its hub after this one leaves. */
  private successor: 'automatic-update' | 'build-superseded' | null = null
  /** Another build is active; what this hub still waits for before it hands over. */
  private handoverState: { active_build: string; waiting_for: WaitingReason[] } | null = null
  private handoverChecking = false
  private handoverPlan: { build: string; at: number; plan: ActivationPlan | null } | null = null
  private runtimeBuildValue: string | null | undefined
  /** Hook ingress: what this hub answered itself, what it handed back to the runtime and why. */
  private readonly ingressCounts = { served: 0, declined: 0, reasons: {} as Record<string, number> }
  private ingressInFlight = 0
  private ingressIdentityValue: IngressIdentity | null | undefined
  /** The machine's shutdown signal, while watched. */
  private powerWatch: PowerWatch | null = null
  /**
   * The machine said it is shutting down or restarting and has not cancelled
   * (wall-clock milliseconds, and what said so): every new end is held.
   */
  private shutdownState: { since: number; name: string } | null = null

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
    // Hook ingress: repository identity is asked of Git once per checkout while it is unchanged,
    // and the hook handlers are loaded now rather than in front of the first hook.
    shareGitIdentityAnswers()
    void import('./commands-hook-run.js').catch(() => undefined)
    this.writeStatusNow()
    // A hub started while this boot's shutdown is under way (the previous one went first) holds ends too.
    const marker = readShutdownMarker(this.env)
    if (marker !== null && marker.boot !== null && marker.boot === boot && now - marker.since < SHUTDOWN_MARKER_FRESH_MS) {
      this.shutdownState = { since: marker.since, name: 'noted-by-an-earlier-hub' }
    }
    this.watchPower()
    const signals = this.options.handleSignals === true ? this.installSignals() : null
    const exchange = this.driver.run().catch((err: unknown) => {
      this.logger.error('hub.exchange', { event: 'stopped', message: err instanceof Error ? err.message : String(err) })
    })
    this.sweep()
    // What the previous hub held: sessions no child brings back, and the answer owners it ran.
    void this.restore().catch((err: unknown) => {
      this.logger.error('hub.session', { event: 'restore-failed', message: err instanceof Error ? err.message : String(err) })
    })
    this.safetyTimer = setInterval(() => this.safetyTick(), this.options.safetyTickMs ?? SAFETY_TICK_MS)
    this.safetyTimer.unref?.()
    this.attachWatchTimer = setInterval(() => this.watchCodexAttach(), this.options.codexAttach?.watchMs ?? CODEX_ATTACH_WATCH_MS)
    this.attachWatchTimer.unref?.()
    this.scheduleAutomaticUpdate(this.options.automaticUpdate?.firstDelayMs ?? AUTOMATIC_UPDATE_FIRST_MS)
    // An exit asked for during startup (a signal, `stop`) must not be lost.
    if (!this.exiting) await new Promise<void>((resolve) => { this.exitResolve = resolve })
    signals?.()
    await this.shutdown(exchange)
    if (this.successor !== null) {
      // The handover (design §4.8): this hub has kept every lease on disk and
      // released the lock; the new build's hub takes them over. Children also
      // reconnect and would start it themselves.
      const reason = this.successor
      try {
        ((reason === 'automatic-update' ? this.options.automaticUpdate?.startSuccessor : this.options.handover?.startSuccessor) ??
          startSuccessorHub)(this.env)
        this.logger.info('hub.exit', { reason, successor: 'started' })
      } catch (err) {
        this.logger.error('hub.exit', { reason, successor: 'failed', message: err instanceof Error ? err.message : String(err) })
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
      if (outcome.outcome === 'activated' && !this.exiting) void this.handOver('automatic-update')
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
      childIpcVersions: () => [...this.links].filter((link) => !link.closed).map((link) => link.ipcVersion),
      plan: (launcher) => candidatePlan(launcher, hubEnvironment(this.env), cwd),
      resume: (launcher, from) => candidateResume(launcher, from, hubEnvironment(this.env), cwd),
      logger: this.logger,
    }
  }

  // -- handing over to another active build ---------------------------------------

  /** The build this hub runs (its `versions/<build>` directory), or null outside a managed installation. */
  runtimeBuild(): string | null {
    if (this.runtimeBuildValue === undefined) {
      try { this.runtimeBuildValue = currentRuntimeBuild(this.env)?.build ?? null } catch { this.runtimeBuildValue = null }
    }
    return this.runtimeBuildValue
  }

  /**
   * Another build became active under this hub (a manual, npm or curl update,
   * a rollback): hand over to it now. Nothing a session waits for holds it
   * back, because the next hub takes all of it over (see `handOver`). It
   * waits only while the active build's hub could not serve a connected
   * child, or cannot be asked at all.
   */
  async checkBuildHandover(): Promise<WaitingReason[] | null> {
    const options = this.options.handover
    if (options === undefined || this.exiting || this.updating || this.handoverChecking || this.handingOver) return null
    const builds = options.builds !== undefined ? options.builds()
      : this.runtimeBuild() === null ? null : { running: this.runtimeBuild()!, active: readActiveBuild(this.env) }
    if (builds === null || builds.active === null || builds.active === builds.running) {
      if (this.handoverState !== null) { this.handoverState = null; this.statusChanged() }
      return null
    }
    const active = builds.active
    this.handoverChecking = true
    try {
      const reasons = new Set<WaitingReason>()
      // The children connected now must be served by the active build's hub.
      const now = this.clock.monotonic()
      if (this.handoverPlan === null || this.handoverPlan.build !== active ||
          (this.handoverPlan.plan === null && now - this.handoverPlan.at >= AUTOMATIC_UPDATE_INTERVAL_MS)) {
        let plan: ActivationPlan | null = null
        try { plan = await (options.plan ?? ((build) => this.activePlan(build)))(active) } catch { plan = null }
        this.handoverPlan = { build: active, at: now, plan }
      }
      const plan = this.handoverPlan.plan
      if (plan === null) reasons.add('candidate-unverified')
      else if ([...this.links].some((link) => !link.closed && (link.ipcVersion < plan.hub_ipc_versions.min || link.ipcVersion > plan.hub_ipc_versions.max))) {
        reasons.add('session-child-incompatible')
      }
      const waiting = [...reasons]
      if (this.handoverState?.active_build !== active || this.handoverState.waiting_for.join() !== waiting.join()) {
        this.logger.info('hub.handover', { event: waiting.length > 0 ? 'waiting' : 'handing-over', active_build: active, waiting_for: waiting })
      }
      this.handoverState = { active_build: active, waiting_for: waiting }
      this.statusChanged()
      if (waiting.length === 0) void this.handOver('build-superseded')
      return waiting
    } finally {
      this.handoverChecking = false
    }
  }

  /**
   * Leave so the active build's hub takes over, losing nothing. Everything a
   * session waits for is on disk: its questions and answers, staged Notes,
   * owed acknowledgements and ends, the answer owners this hub ran
   * (`run/settlements`), and the Codex conversations no child brings back
   * (their attendance status). What is in flight finishes first: hooks this
   * hub serves, writes and wakes into sessions, and local end work; then its
   * answer owners are asked to step aside at their next check. The next hub,
   * started through the stable launcher, continues every lease.
   */
  async handOver(reason: 'automatic-update' | 'build-superseded'): Promise<void> {
    if (this.handingOver || this.exiting) return
    this.handingOver = true
    this.statusChanged()
    const deadline = this.clock.monotonic() + (this.options.handoverDrainMs ?? HANDOVER_DRAIN_MS)
    const settle = async (done: () => boolean): Promise<void> => {
      while (!done() && !this.exiting && this.clock.monotonic() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await settle(() => this.ingressInFlight === 0 && this.handIns === 0 && this.localEnds.size === 0 && this.stoppedWaking.size === 0 &&
      ![...this.links].some((link) => link.writesInFlight > 0))
    // The answer owners stop at their next check, without consuming, closing
    // or retiring anything; their reply polls end now.
    const asked = standDownQuestionOwners()
    this.credentialAbort.abort()
    this.credentialAbort = new AbortController()
    await settle(() => this.settlements.size === 0)
    const left = { ingress: this.ingressInFlight, hand_ins: this.handIns, local_ends: this.localEnds.size, settlements: this.settlements.size }
    this.logger.info('hub.handover', { event: 'drained', reason, answer_owners_asked: asked,
      ...(Object.values(left).some((count) => count > 0) ? { in_flight: left } : {}) })
    if (this.exiting) return
    if (this.sessions.size > 0 || this.children > 0 || this.settlementRecords().length > 0) this.successor = reason
    this.requestExit(reason)
  }

  /** Run `work` as a hand-in a handover waits for. */
  async handing<T>(work: () => Promise<T>): Promise<T> {
    this.handIns += 1
    try { return await work() } finally { this.handIns -= 1 }
  }

  private async activePlan(build: string): Promise<ActivationPlan | null> {
    if (nativeInstallationModule === null) return null
    const release = nativeInstallationModule.managedInstallation({ env: this.env }).versionRelease(build)
    return candidatePlan(release.launcher, hubEnvironment(this.env), os.homedir())
  }

  /** Ask the hub to leave (idle, stop request, signal, logout timeout). */
  requestExit(reason: string): void {
    if (this.exiting) return
    this.exiting = true
    this.logger.info('hub.exit', { reason, sessions: this.sessions.size })
    this.exitResolve?.()
  }

  private async shutdown(exchange: Promise<void>): Promise<void> {
    // An end still being confirmed is left undecided, on disk: the next hub
    // decides it (a signal at shutdown or logout must not expire anything).
    for (const session of this.sessions.values()) if (session.endCandidate !== null) clearTimeout(session.endCandidate.timer)
    this.powerWatch?.stop()
    if (this.safetyTimer !== null) clearInterval(this.safetyTimer)
    if (this.attachWatchTimer !== null) clearInterval(this.attachWatchTimer)
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
    const onSignal = (): void => {
      // Linux, a shutdown logind did not announce (`systemctl start reboot.target`): systemd says it is
      // stopping. Noted for the next boot, so a terminal closed after this hub went counts as the machine's.
      if (!this.exiting && this.shutdownState === null && process.platform === 'linux' && systemdStopping()) {
        writeShutdownMarker(this.env, { boot: (this.options.bootIdentity ?? currentBootIdentity)(), since: this.clock.wall(), name: 'systemd-stopping' })
        this.logger.info('hub.session', { event: 'power-shutdown-noted', name: 'systemd-stopping' })
      }
      this.requestExit('signal')
    }
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
    // Hook ingress: the launcher's `go` after the hub accepted, or its going away.
    let ingressStarted = false
    let ingressGo: ((go: boolean) => void) | null = null
    const helloTimer = setTimeout(() => { if (role === null) socket.destroy() }, 5_000)
    const refuse = (reason: string): void => {
      this.logger.info('hub.session', { event: 'refused', role, reason })
      try { socket.end(encodeFrame({ type: 'refused', reason, retry: PASSING_REFUSALS.has(reason) })) } catch { socket.destroy() }
    }
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(helloTimer)
      ingressGo?.(false)
      ingressGo = null
      if (link !== null) {
        this.children -= 1
        this.links.delete(link)
        link.close()
        if (session !== null) this.linkClosed(session, link)
      }
      // A hook connection settles its own idle bookkeeping (see `ingress`): the
      // frequent hooks must not each rewrite the hub's status file.
      if (role !== 'ingress') this.touch()
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
          if (role === 'ingress') {
            if (frame['type'] === 'go') { ingressGo?.(true); ingressGo = null; return }
            if (frame['type'] !== 'hook' || ingressStarted) { socket.destroy(); return }
            ingressStarted = true
            // Not awaited: the launcher's `go` arrives on this same connection.
            void this.ingress(socket, frame, () => new Promise<boolean>((resolve) => { ingressGo = resolve }))
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
              this.writerExited(session, link)
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
        // A process that left this conversation and starts it again (an
        // in-session `/resume` back to it) hosts it again.
        const pid = frame['harness_pid']
        if (session !== undefined && frame['hook_event'] === 'SessionStart' && typeof pid === 'number') session.left.delete(pid)
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
        // A Claude Code or Codex SessionEnd: a handoff (a reload, a resume
        // elsewhere, the desktop app's respawn) brings the conversation back at
        // once and an app's unload leaves it open, so decide only after the
        // end confirmation. The hook cleans up nothing while the hub holds it.
        const session = sessionId === null ? undefined : this.sessions.get(sessionId)
        if (session === undefined || session.ending !== null) {
          reply({ type: 'refused', reason: 'unknown-session' })
          return
        }
        const transcript = typeof frame['transcript_path'] === 'string' && path.isAbsolute(frame['transcript_path'])
          ? frame['transcript_path'] : session.registration.transcriptPath
        const pid = frame['harness_pid']
        this.endSignalled(session, typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? pid : null, transcript)
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
        // A build that became active asks this hub to make way: the same handover as its own.
        if (frame['reason'] === 'build-superseded') void this.handOver('build-superseded')
        else this.requestExit(typeof frame['reason'] === 'string' ? frame['reason'] : 'stop-requested')
        return
      default:
        reply({ type: 'refused', reason: 'unknown-request' })
    }
  }

  // -- hook ingress ----------------------------------------------------------------

  /**
   * One hook offered by the native launcher (see `hub-ingress.ts`). Declined
   * before anything is done unless this hub can answer it exactly as the
   * runtime would; then run here, and the output handed back.
   */
  private async ingress(socket: Socket, frame: Record<string, unknown>, launcherGo: () => Promise<boolean>): Promise<void> {
    const request = parseIngressRequest(frame)
    const reason = typeof request === 'string' ? request
      : this.exiting || this.handingOver ? 'hub-exiting' : ingressRefusal(request, this.ingressIdentity())
    if (reason !== null || typeof request === 'string') {
      const why = reason ?? 'malformed'
      this.ingressCounts.declined += 1
      this.ingressCounts.reasons[why] = (this.ingressCounts.reasons[why] ?? 0) + 1
      try { socket.end(encodeFrame({ type: 'fallback', reason: why })) } catch { socket.destroy() }
      return
    }
    this.ingressInFlight += 1
    try {
      // Two steps: a launcher that already gave up and started the runtime
      // never says `go`, so the hook never runs twice.
      const go = launcherGo()
      socket.write(encodeFrame({ type: 'accepted' }))
      let timer: ReturnType<typeof setTimeout> | undefined
      const committed = await Promise.race([go, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), INGRESS_GO_WAIT_MS) })])
      clearTimeout(timer)
      if (!committed) {
        this.ingressCounts.reasons['launcher-gone'] = (this.ingressCounts.reasons['launcher-gone'] ?? 0) + 1
        socket.destroy()
        return
      }
      const result = await runIngressHook(this.ingressHost(), request)
      this.ingressCounts.served += 1
      for (const reply of resultFrames(result)) socket.write(encodeFrame(reply))
      socket.end()
    } catch (err) {
      this.logger.error('hub.ingress', { event: 'failed', hook: request.event, message: err instanceof Error ? err.message : String(err) })
      socket.destroy()
    } finally {
      this.ingressInFlight -= 1
      // Children keep the hub; without any, a hook is activity like any other.
      if (this.children === 0) this.touch()
    }
  }

  private ingressIdentity(): IngressIdentity | null {
    if (this.options.ingressIdentity !== undefined) return this.options.ingressIdentity()
    if (this.ingressIdentityValue === undefined) {
      try {
        const reference = currentRuntimeBuild(this.env)
        this.ingressIdentityValue = reference === null ? null : { build: reference.build, root: path.join(accountHome(this.env), '.notifai') }
      } catch {
        this.ingressIdentityValue = null
      }
    }
    return this.ingressIdentityValue
  }

  private ingressHost(): IngressHost {
    return {
      deps: this.deps,
      cachedStore: this.cachedStore(),
      clientFactory: (baseUrl, bearer, options) =>
        (this.deps.clientFactory ?? createClient)(baseUrl, bearer, { ...options, signal: this.waiterSignal() }),
      settle: (sessionId, harness, cwd, purpose) => this.settle(sessionId, harness, cwd, purpose),
      inputStaged: (sessionId) => this.inputStaged(sessionId),
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
      // A child from an earlier build reports no entrypoint: interactive, as before.
      // A Codex thread's place depends on its host, read once the peer is verified.
      place: harness === 'claude-code'
        ? claudePlaceOf({ entrypoint: text('entrypoint', 64), sessionKind: text('session_kind', 32),
          orcaStructured: frame['orca_structured'] === '1' })
        : 'unreported',
      hostApp: null,
      terminalHost: null,
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
    // The child comes back to the next hub.
    if (this.exiting || this.handingOver) return 'hub-exiting'
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
    // The process that started the harness: for the Claude desktop app, its
    // main process, which must still run for a pause to be the app's own.
    if (owner === peer.parent && peer.grandparent !== undefined && peer.grandparent !== null) {
      registration.hostApp = { pid: peer.grandparent.pid, start: peer.grandparent.start }
    }
    this.placeOf(registration, frame, owner.pid)
    const env = this.sessionEnv(registration)
    if (registration.harness === 'claude-code') {
      // Claude Code publishes its descriptor before it has every field (a
      // resumed session's first write has no status yet): a moment later it
      // does. One still incomplete then is a passing refusal; the child comes back.
      let descriptor: ReturnType<typeof parseDescriptor> = null
      for (let attempt = 0; descriptor === null; attempt += 1) {
        let raw: unknown
        try { raw = JSON.parse(readFileSync(path.join(claudeDescriptorDir(env), `${owner.pid}.json`), 'utf8')) } catch { raw = undefined }
        descriptor = raw === undefined ? null : parseDescriptor(raw)
        if (descriptor !== null) break
        if (attempt >= DESCRIPTOR_SETTLE_TRIES) return 'descriptor-missing'
        await new Promise((resolve) => setTimeout(resolve, DESCRIPTOR_SETTLE_MS))
      }
      if (descriptor.pid !== owner.pid || descriptor.sessionId !== registration.sessionId ||
          !descriptorStartMatches(descriptor.procStart, owner, owner.ticks ?? registration.harnessTicks)) return 'descriptor-mismatch'
    }
    const existing = this.sessions.get(registration.sessionId)
    if (existing !== undefined) {
      // The earlier incarnation still owes its `ended` report and holds the
      // claim: the child comes back once that has gone.
      if (existing.ending !== null) return 'session-ending'
      // A conversation its app or the machine stopped comes back here.
      if (existing.stopped !== null) return this.resumeStopped(existing, { child: link, harnessProcess: registration.harnessProcess, registration, env })
      // A process that left this conversation and opens it again hosts it again.
      existing.left.delete(registration.harnessProcess.pid)
      const sameHarness = (identity: ProcessIdentity, ticks: string | null): boolean => identity.pid === registration.harnessProcess.pid &&
        (ticks !== null && registration.harnessTicks !== null ? ticks === registration.harnessTicks
          : normalizeProcessStart(identity.start) === normalizeProcessStart(registration.harnessProcess.start))
      if (sameHarness(existing.harnessProcess, existing.registration.harnessTicks)) {
        if (existing.child !== null && !existing.child.closed && !existing.child.ended) return 'session-already-served'
        existing.child = link
        existing.registration = registration
        existing.reloadedAt = null
        if (existing.endCandidate !== null) {
          // The User opened the conversation again (SessionStart resume): it
          // was never closed, and what waited for it is handed in now.
          clearTimeout(existing.endCandidate.timer)
          existing.endCandidate = null
          existing.writeStatus(true)
          this.logger.info('hub.session', { event: 'reopened', session: existing.id })
        }
        this.logger.info('hub.session', { event: 'reconnected', session: existing.id })
        existing.hinted()
        this.touch()
        return existing
      }
      const standby = existing.standbys.find((writer) => sameHarness(writer.harnessProcess, writer.registration.harnessTicks))
      if (standby !== undefined) {
        if (!standby.child.closed && !standby.child.ended) return 'session-already-served'
        standby.child = link
        standby.registration = registration
        this.logger.info('hub.session', { event: 'reconnected', session: existing.id, writer: 'standby' })
        this.touch()
        return existing
      }
      // A scripted run of the same conversation never becomes a place it is in.
      if (!placeReceives(registration.place)) return 'place-receives-nothing'
      // Another process hosts this same conversation: a second place it is
      // open in, or the place it continues in after a handoff.
      this.addWriter(existing, { child: link, harnessProcess: registration.harnessProcess, registration, env })
      return existing
    }
    // A stopped conversation this hub has not taken back yet: never into a scripted run.
    if (!placeReceives(registration.place) && stoppedOnDisk(registration.sessionId, env)) return 'place-receives-nothing'
    const starting = registration.hookEvent === 'SessionStart' || registration.source !== null
    let record: SessionIncarnation
    try {
      record = this.sharedIncarnation(registration, env) ?? beginSessionIncarnation(registration.sessionId, env, {
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
    // A fork names the conversation it continues: Claude Code in its copied
    // lines (written by the first prompt at the latest), Codex in its rollout's first line.
    if (registration.harness === 'claude-code' ? registration.source === 'fork' : starting) {
      session.forkChecks = registration.harness === 'claude-code' ? FORK_CHECKS : 1
      this.checkFork(session)
    }
    this.touch()
    this.driver.poke()
    return session
  }

  /**
   * Where a Codex thread runs (its host decides), the app that started an
   * app-server (T3 Code's server, Orca's supervisor), and an Orca pane's
   * terminal host.
   */
  private placeOf(registration: Registration, frame: Record<string, unknown>, harnessPid: number): void {
    if (registration.harness === 'codex') {
      const override = frame['originator_override']
      registration.place = codexPlaceOf({ hostKind: (this.options.codexHostKind ?? codexHostKind)(harnessPid),
        originatorOverride: typeof override === 'string' ? override : null, orcaStructured: frame['orca_structured'] === '1',
        originator: readCodexThreadOriginator(registration.transcriptPath) })
    }
    if ((registration.place === 't3' || registration.place === 'orca-chat') && registration.hostApp === null) {
      registration.hostApp = (this.options.parentProcessOf ?? parentProcessOf)(harnessPid)
    }
    if (frame['orca_pane'] === '1' && (registration.place === 'terminal' || registration.place === 'unreported')) {
      registration.terminalHost = (this.options.orcaTerminalHostOf ?? orcaTerminalHostOf)(harnessPid)
    }
  }

  /**
   * A new conversation that is a fork of one this hub attends. When that one
   * is stopped, or ending with nowhere left to run, it continues only in the
   * fork: it has moved. Where the service can move its questions (it offers
   * `session_stopped_hold`, and either creates an unseen successor with
   * `session_continued_successor` or already knows the fork because it has
   * notified), they continue there, with its held answers and notes;
   * otherwise they expire as for a close. A
   * fork of a conversation still open somewhere is a new conversation beside
   * it, and changes nothing. Only a fork that records its origin counts
   * (Claude Code's `/branch`, a Codex fork); one that records none is a new
   * conversation.
   */
  checkFork(fork: HubSession): void {
    if (fork.forkChecks <= 0) return
    fork.forkChecks -= 1
    const parentId = fork.harness === 'claude-code' ? claudeForkParent(fork.registration.transcriptPath, fork.id)
      : readCodexSessionMeta(fork.registration.transcriptPath)?.forkedFrom ?? null
    if (parentId === null) return
    fork.forkChecks = 0
    const parent = this.sessions.get(parentId)
    if (parent === undefined || parent === fork || parent.ending !== null) return
    const primary = parent.primary()
    const stillOpen = parent.stopped === null && (parent.endCandidate === null || (primary !== null && parent.hosts(primary)) ||
      parent.nextPrimary() !== null)
    if (stillOpen) return
    const continued = this.driver.offers('session_stopped_hold') &&
      (this.driver.offers('session_continued_successor') || fork.notified)
    this.logger.info('hub.session', { event: 'moved', session: parent.id, to: fork.id, from_state: parent.stopped !== null ? 'stopped' : 'ending',
      follows: continued })
    this.endSession(parent, 'moved', continued ? fork.id : null)
  }

  /**
   * The service moved a continued conversation's questions, held answers and
   * notes to its successor: the local records follow, the successor's answer
   * owner collects what is answered, and what waited is handed in there.
   * What this session asked but never submitted ends with it.
   */
  continuedAt(session: HubSession, successorId: string): void {
    const moved = moveQuestionsToSuccessor(session.id, successorId, session.env)
    this.logger.info('hub.session', { event: 'continued', session: session.id, to: successorId, questions: moved.questions.length,
      answers: moved.answers.length })
    this.endLocally(session)
    this.forget(session, 'reported-continued')
    const successor = this.sessions.get(successorId)
    if (successor === undefined) return
    const state = readSessionState(successorId, successor.env)
    if (pendingList(state).length > 0 || state.accepted !== undefined) this.settle(successorId, successor.harness, successor.registration.cwd, 'settlement')
    successor.checkInput()
  }

  /** The service would not continue it under that successor (unknown to it, or ended): it ends as a close. */
  successorRefused(session: HubSession, successorId: string): void {
    this.logger.info('hub.session', { event: 'continued-refused', session: session.id, to: successorId })
    this.endLocally(session)
    this.driver.poke()
  }

  /**
   * A Claude Code conversation another live process still hosts (a writer
   * whose child has not come back to this hub yet): the incarnation is the
   * same conversation's, so it is kept and names this process instead.
   */
  private sharedIncarnation(registration: Registration, env: NodeJS.ProcessEnv): SessionIncarnation | null {
    if (registration.harness !== 'claude-code') return null
    const current = readSessionIncarnation(registration.sessionId, env)
    const host = current?.harness_process
    if (current === null || host === undefined || host.pid === registration.harnessProcess.pid ||
        endsIncarnation(readSessionEndMarker(registration.sessionId, env), current)) return null
    const descriptor = readClaudeDescriptor(env, host.pid)
    if (descriptor === null || descriptor.sessionId !== registration.sessionId || processIdentityLiveness(host) !== 'alive' ||
        !descriptorStartMatches(descriptor.procStart, host)) return null
    return rehostSessionIncarnation(registration.sessionId, env, current.key, registration.harnessProcess, registration.boot ?? undefined)
  }

  /**
   * A stopped conversation opened again: in its place (a resume after a
   * reboot, the desktop app reopening it, the Codex app loading it again, the
   * next send in an Orca chat or T3 thread) or in another interactive one (a
   * move follows the User). It is attended from this process on, and what
   * waited for it is handed in here: a Codex thread runs the wake already in
   * its queue. A scripted run receives nothing.
   */
  private resumeStopped(session: HubSession, writer: Writer): HubSession | string {
    if (!placeReceives(writer.registration.place)) return 'place-receives-nothing'
    const from = session.stopped!
    // An answer whose window ended while it was stopped is never handed in.
    session.dropExpiredAnswers()
    session.stopped = null
    session.held = []
    session.lease.holdStopped = false
    // A service holding it as stopped takes it back only from a new
    // incarnation: its refusal of this one's renewal then rotates it.
    session.lease.resumedFromStop = true
    session.lease.stopReported = false
    session.standbys = []
    // The same process may have run SessionEnd when it stopped (a Codex app-server unloading it).
    session.left.delete(writer.harnessProcess.pid)
    if (session.child !== null && !session.child.closed) this.letGo(session, { child: session.child, harnessProcess: session.harnessProcess,
      registration: session.registration, env: session.env })
    session.child = null
    session.lease.setPhase('acquiring', 'resumed')
    session.lease.needsFresh = true
    this.logger.info('hub.session', { event: 'resumed', session: session.id, stopped_by: from.cause, place: writer.registration.place,
      stopped_for_s: Math.round(Math.max(0, this.clock.wall() - from.since) / 1000) })
    this.addWriter(session, writer)
    const state = readSessionState(session.id, session.env)
    if (pendingList(state).length > 0 || state.accepted !== undefined) this.settle(session.id, session.harness, writer.registration.cwd, 'settlement')
    return session
  }

  /** One more process hosts a conversation this hub attends. */
  private addWriter(session: HubSession, writer: Writer): void {
    const primary = session.primary()
    if (primary !== null && session.hosts(primary) && !openedLater(writer, primary)) {
      session.standbys.push(writer)
      this.logger.info('hub.session', { event: 'writer-standby', session: session.id, writers: session.standbys.length + 1 })
    } else {
      // The most recently opened place receives. An end still being
      // confirmed was a handoff: the conversation continues here, and what
      // waited for it follows.
      const followed = session.endCandidate !== null
      if (session.endCandidate !== null) { clearTimeout(session.endCandidate.timer); session.endCandidate = null }
      session.promote(writer, true)
      this.logger.info('hub.session', { event: followed ? 'followed' : 'writer-primary', session: session.id,
        writers: session.standbys.length + 1 })
    }
    session.hinted()
    this.touch()
    this.driver.poke()
  }

  /** A writer this conversation no longer has: its child has nothing left to watch for it. */
  letGo(session: HubSession, writer: Writer): void {
    if (!writer.child.closed) writer.child.send({ type: 'bye' })
    this.logger.info('hub.session', { event: 'writer-left', session: session.id })
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

  /** A child connection closed: the primary's, or a standby's. */
  private linkClosed(session: HubSession, link: ChildLink): void {
    if (session.child === link) { this.childGone(session); return }
    const standby = session.standbys.find((writer) => writer.child === link)
    if (standby === undefined || link.ended) return
    // A standby's child went without reporting an exit: nothing can be written through it.
    session.standbys = session.standbys.filter((writer) => writer !== standby)
    this.logger.info('hub.session', { event: 'writer-disconnected', session: session.id })
  }

  /** A child's kernel watch saw its harness exit. */
  private writerExited(session: HubSession, link: ChildLink): void {
    if (session.child === link) { this.closing(session, 'harness-gone'); return }
    const standby = session.standbys.find((writer) => writer.child === link)
    if (standby === undefined) return
    session.exited.add(identityKey(standby.harnessProcess))
    session.standbys = session.standbys.filter((writer) => writer !== standby)
    this.removeEndRecords(session.id, standby.harnessProcess.pid)
    this.logger.info('hub.session', { event: 'writer-left', session: session.id, reason: 'harness-gone' })
  }

  /** The child closed without reporting an end. */
  private childGone(session: HubSession): void {
    if (session.child?.ended === true || session.stopped !== null) return
    const probe = session.probe()
    if (probe.state === 'ended') { this.closing(session, probe.reason); return }
    if (session.endCandidate !== null) return
    // A close nobody reported: the kernel watch went with the child, so ask
    // once (this is rare) whether that exact harness process still runs.
    if (session.harnessGone()) {
      this.closing(session, 'harness-gone')
      return
    }
    // Nothing can be written through this process any more; another place
    // the conversation is open in takes over.
    const next = session.nextPrimary()
    if (next !== null) {
      session.promote(next)
      this.logger.info('hub.session', { event: 'writer-promoted', session: session.id, reason: 'session-child-disconnected' })
      this.driver.poke()
      return
    }
    this.logger.info('hub.session', { event: 'child-disconnected', session: session.id })
    session.lease.setPhase('uncertain', 'session-child-disconnected')
    session.writeStatus()
    // Codex stops the child when it ends or unloads a session; the Codex app
    // does not always run SessionEnd for an unload. For an app or IDE
    // conversation, decide as SessionEnd would have.
    if (session.harness === 'codex' && codexAppSurface(readCodexThreadOriginator(session.registration.transcriptPath)) !== null) {
      this.holdEnd(session, 'session-end-hook', session.registration.transcriptPath)
    }
  }

  /**
   * The primary writer stopped hosting the conversation: its harness exited,
   * or it now shows another one (`/clear`, an in-session `/resume`). Another
   * place it is open in takes over at once; with none, the end waits for the
   * end confirmation. Evidence nothing brings back ends it now: SessionEnd
   * already cleaned up (the hook could not reach this hub), or the rollout
   * was archived.
   */
  closing(session: HubSession, reason: EndReason): void {
    if (session.ending !== null || session.stopped !== null) return
    if (reason === 'session-end-hook' || reason === 'session-archived') { this.endSession(session, reason); return }
    if (reason === 'harness-gone') session.exited.add(identityKey(session.harnessProcess))
    const next = session.nextPrimary()
    if (next !== null) {
      session.promote(next)
      this.logger.info('hub.session', { event: 'writer-promoted', session: session.id, reason })
      this.driver.poke()
      return
    }
    if (session.endCandidate !== null) return
    this.holdEnd(session, reason, session.registration.transcriptPath)
  }

  /**
   * A SessionEnd from the process `harnessPid` (null when the hook could not
   * say). A standby leaving changes nothing for the others; the primary
   * leaving hands over to the most recently opened standby; otherwise the
   * end waits for the end confirmation.
   */
  endSignalled(session: HubSession, harnessPid: number | null, transcriptPath: string | null): void {
    // Notifai's own confirming request reloaded the thread (nobody showed it): not an end.
    const own = session.attachOwnReload
    if (own !== null && this.clock.monotonic() - own.at < CODEX_OWN_RELOAD_MS && (harnessPid === null || harnessPid === own.pid)) {
      this.logger.info('hub.session', { event: 'end-ignored', session: session.id, reason: 'own-check' })
      return
    }
    // A process that never hosted this conversation here ends nothing: a
    // scripted run of the same id the hub refused, or one that started after
    // the conversation stopped.
    if (harnessPid !== null && harnessPid !== session.harnessProcess.pid &&
        !session.standbys.some((writer) => writer.harnessProcess.pid === harnessPid)) {
      this.logger.info('hub.session', { event: 'end-ignored', session: session.id, reason: 'not-a-writer' })
      return
    }
    if (session.stopped !== null) return
    if (harnessPid !== null) session.left.add(harnessPid)
    const standby = harnessPid === null ? undefined : session.standbys.find((writer) => writer.harnessProcess.pid === harnessPid)
    if (standby !== undefined) {
      session.standbys = session.standbys.filter((writer) => writer !== standby)
      this.letGo(session, standby)
      return
    }
    if (harnessPid !== null && harnessPid === session.harnessProcess.pid && session.child !== null) {
      const next = session.nextPrimary()
      if (next !== null) {
        session.promote(next)
        this.logger.info('hub.session', { event: 'writer-promoted', session: session.id, reason: 'session-end-hook' })
        this.driver.poke()
        return
      }
    }
    if (session.endCandidate !== null) return
    this.holdEnd(session, 'session-end-hook', transcriptPath)
  }

  /**
   * Positive close evidence for this incarnation: clean up locally the way
   * SessionEnd would have (when it did not run), report `ended`, and let the
   * child go.
   */
  endSession(session: HubSession, reason: EndReason, successor: string | null = null): void {
    if (session.ending !== null) return
    session.ending = reason
    if (session.endCandidate !== null) { clearTimeout(session.endCandidate.timer); session.endCandidate = null }
    // A stopped thread is loaded nowhere this hub can reach without a control
    // connection to a User's server: its wake is only detached.
    session.wasStopped = session.stopped !== null
    session.stopped = null
    session.reloadedAt = null
    session.lease.holdStopped = false
    // Continued: its records wait for the service to move its questions, and
    // follow them there (`continuedAt`); a refusal ends it as a close.
    if (successor === null || !session.notified) this.endLocally(session)
    // The harness may outlive this session (`/clear`, `/resume`): its child
    // has nothing left to watch for it.
    session.child?.send({ type: 'bye' })
    for (const standby of session.standbys) standby.child.send({ type: 'bye' })
    this.logger.info('hub.session', { event: 'ending', session: session.id, reason, ...(successor === null ? {} : { successor }) })
    if (session.notified) {
      session.lease.final = 'ended'
      session.lease.successor = successor
      session.lease.pausedUntil = 0
      this.driver.poke()
    } else this.forget(session, `ended-${reason}`)
  }

  /** Clean up an ended session locally, as its SessionEnd would have, unless that already ran. */
  private endLocally(session: HubSession): void {
    const ended = !endsIncarnation(readSessionEndMarker(session.id, session.env), session.record)
    const wasStopped = session.wasStopped
    this.trackLocalEnd((async () => {
      // Best effort, never relied on: take back a wake Notifai queued that
      // the closed thread has not shown. The prompt hook blocks one that stays.
      if (session.harness === 'codex') await this.withdrawQueuedWakes(session.id, session.env, !wasStopped)
      if (ended) {
        const { handleSessionEnd } = await import('./hook-lifecycle.js')
        try {
          handleSessionEnd(session.env, { session_id: session.id, ...(session.registration.cwd === null ? {} : { cwd: session.registration.cwd }) }, this.clock.wall())
        } catch (err) {
          this.logger.error('hub.session', { event: 'local-end-failed', session: session.id, message: err instanceof Error ? err.message : String(err) })
        }
      }
      this.drainRetirements()
    })())
  }

  /**
   * An end signal: hold it for the end confirmation, then decide. Nothing is
   * written into the conversation meanwhile, and its questions stay open.
   */
  holdEnd(session: HubSession, reason: EndReason, transcriptPath: string | null, delayMs?: number, since?: number, why?: string): void {
    if (session.endCandidate !== null) clearTimeout(session.endCandidate.timer)
    const timer = setTimeout(() => this.resolveEnd(session), delayMs ?? this.options.endConfirmMs ?? END_CONFIRM_MS)
    session.endCandidate = { child: session.child, transcriptPath, timer, reason, since: since ?? session.endCandidate?.since ?? this.clock.wall() }
    this.logger.info('hub.session', { event: 'end-held', session: session.id, reason, ...(why === undefined ? {} : { held_for: why }) })
    // Durable: a hub that leaves before deciding leaves it to the next one.
    session.writeStatus(true)
    this.touch()
  }

  /** The end confirmation passed: the conversation came back, the app only unloaded it, or it closed. */
  private resolveEnd(session: HubSession): void {
    const candidate = session.endCandidate
    if (candidate === null || session.ending !== null || this.sessions.get(session.id) !== session || this.exiting) return
    session.endCandidate = null
    session.writeStatus(true)
    const kept = (reason: string): void => {
      this.logger.info('hub.session', { event: 'end-cancelled', session: session.id, reason })
      session.hinted()
      this.touch()
    }
    // A SessionStart since the end (a reopen in the same host, a handoff to
    // another) brought a child back: the conversation is open and attended.
    const primary = session.primary()
    if (primary !== null && primary.child !== candidate.child && session.hosts(primary)) { kept('session-restarted'); return }
    const next = session.nextPrimary()
    if (next !== null) { session.promote(next); kept('writer-took-over'); return }
    if (session.harness === 'claude-code') {
      // The same process still shows it (a SessionEnd from another place).
      if (primary !== null && session.hosts(primary)) { kept('still-open'); return }
      // Another process hosts it whose child has not registered yet (the
      // desktop app respawning it, a resume in a new tab).
      const host = this.claudeHostOf(session)
      if (host !== null) {
        if (primary !== null) this.letGo(session, primary)
        session.child = null
        session.harnessProcess = host
        session.registration = { ...session.registration, harnessProcess: host, harnessTicks: null, inboxSocket: null, inboxToken: false }
        session.rehost(host, session.registration.boot)
        session.writeStatus(true)
        kept('hosted-elsewhere')
        return
      }
      // The machine is going down: the next boot decides (machine down); a cancellation, this hub.
      if (this.holdForShutdown(session, candidate)) return
      const verdict = this.classifyClaudeStop(session, candidate.since)
      this.logger.info('hub.session', { event: 'end-classified', session: session.id, verdict: verdict.cause === 'app' ? 'stopped' : 'closed',
        reason: verdict.reason, place: session.registration.place })
      if (verdict.cause === 'app') { this.stopSession(session, 'app', verdict.reason, undefined, watchedAfter(verdict.reason)); return }
      this.endSession(session, candidate.reason)
      return
    }
    // Codex: the host holds the thread again (the shared server reloaded it
    // in place for a resume), so it was never closed.
    if (!session.harnessGone() && this.codexHolds(session)) {
      if (session.child !== null && session.child.closed) session.child = null
      session.reloadedAt = this.clock.monotonic()
      kept('reloaded')
      return
    }
    // Another process holds it now (the shared server restarted and its
    // terminal reconnected): the conversation runs there, and its next prompt
    // brings a child back. Nothing is woken meanwhile.
    const holder = this.codexHolderElsewhere(session)
    if (holder !== null) {
      if (primary !== null) this.letGo(session, primary)
      session.child = null
      session.harnessProcess = holder
      session.registration = { ...session.registration, harnessProcess: holder, harnessTicks: null }
      session.rehost(holder, session.registration.boot)
      session.reloadedAt = this.clock.monotonic()
      session.writeStatus(true)
      kept('hosted-elsewhere')
      return
    }
    if (this.holdForShutdown(session, candidate)) return
    const { verdict, evidence } = this.classifyCodexStop(session, candidate)
    this.logger.info('hub.session', { event: 'end-classified', session: session.id, verdict: verdict.cause === 'app' ? 'stopped' : 'closed',
      reason: verdict.reason, place: evidence.place, originator: evidence.originator, host: evidence.host, host_kind: evidence.hostKind,
      rollout: evidence.rollout })
    if (verdict.cause === 'app') { this.stopSession(session, 'app', verdict.reason, undefined, watchedAfter(verdict.reason)); return }
    this.endSession(session, verdict.reason === 'archived' ? 'session-archived' : verdict.reason === 'deleted' ? 'session-deleted'
      : verdict.reason === 'harness-gone' ? 'harness-gone' : candidate.reason)
  }

  /** Who ended a Codex conversation the confirmation did not bring back (see `session-close-classifier.ts`). */
  private classifyCodexStop(session: HubSession, candidate: NonNullable<HubSession['endCandidate']>): { verdict: CloseVerdict; evidence: CodexEndEvidence } {
    const transcriptPath = candidate.transcriptPath ?? session.registration.transcriptPath
    const located = locateCodexRollout(session.registration.codexHome ?? session.env['CODEX_HOME'] ?? null, session.id, transcriptPath)
    const evidence: CodexEndEvidence = {
      place: session.registration.place,
      rollout: located.place,
      host: session.harnessGone() ? 'gone' : 'alive',
      hostKind: this.codexHostKind(session.harnessProcess.pid),
      // No rollout, no originator: nothing then shows the app still lists it.
      originator: readCodexThreadOriginator(located.path ?? transcriptPath),
      hostApp: recordedLiveness(session.registration.hostApp),
      idleMs: Math.max(0, candidate.since - session.lastActivity),
      terminalHost: recordedLiveness(session.registration.terminalHost),
    }
    return { verdict: classifyCodexEnd(evidence), evidence }
  }

  // -- stopped conversations and the machine going down --------------------------

  /** The machine said it is going down and has not cancelled; Linux without a watched signal asks systemd. */
  shutdownInProgress(): boolean {
    if (this.shutdownState !== null) {
      if (this.clock.wall() - this.shutdownState.since < SHUTDOWN_MARKER_FRESH_MS) return true
      // A shutdown that never went on nor was cancelled: decide as usual again.
      this.logger.info('hub.session', { event: 'power-shutdown-lapsed', name: this.shutdownState.name })
      this.shutdownState = null
      rmSync(shutdownMarkerPath(this.env), { force: true })
      this.statusChanged()
      return false
    }
    return this.powerWatch?.state().source === null && process.platform === 'linux' && this.options.powerWatch !== false && systemdStopping()
  }

  /** While the machine goes down, an end is held undecided: re-armed, never resolved. */
  private holdForShutdown(session: HubSession, candidate: NonNullable<HubSession['endCandidate']>): boolean {
    if (!this.shutdownInProgress()) return false
    this.holdEnd(session, candidate.reason, candidate.transcriptPath, this.options.endConfirmMs ?? END_CONFIRM_MS, candidate.since, 'shutdown-in-progress')
    return true
  }

  /** Whether a conversation's rollout or transcript is where it can come back from. */
  private recordPresent(session: HubSession): 'present' | 'archived' | 'deleted' {
    if (session.harness === 'claude-code') return this.transcriptPresent(session) ? 'present' : 'deleted'
    const place = session.rollout()
    return place === 'archived' ? 'archived' : place === 'missing' ? 'deleted' : 'present'
  }

  private desktopPaths(): { sessions: string; log: string } | null {
    if (this.options.claudeDesktop !== undefined) return this.options.claudeDesktop
    return process.platform === 'darwin' ? claudeDesktopPaths(accountHome(this.env)) : null
  }

  private transcriptPresent(session: HubSession): boolean {
    return claudeTranscriptPresent(path.dirname(claudeDescriptorDir(session.env)), session.id, session.registration.transcriptPath)
  }

  /** Who ended a Claude Code conversation the confirmation did not bring back (see `session-close-classifier.ts`). */
  private classifyClaudeStop(session: HubSession, since: number): CloseVerdict {
    const registration = session.registration
    const transcript = this.transcriptPresent(session) ? 'present' : 'missing'
    const place = registration.place as ClaudeEndEvidence['place']
    if (place !== 'claude-desktop') {
      return classifyClaudeEnd({ place, transcript, terminalHost: recordedLiveness(registration.terminalHost),
        hostApp: recordedLiveness(registration.hostApp), idleMs: Math.max(0, since - session.lastActivity) })
    }
    const paths = this.desktopPaths()
    const record = paths === null ? 'unreadable' as const : readClaudeDesktopRecord(paths.sessions, session.id)
    const appAlive = registration.hostApp !== null && processIdentityLiveness(registration.hostApp) === 'alive'
    const pauseLogged = paths !== null && typeof record === 'object' && claudeDesktopPauseLogged(paths.log, record.localId, since, this.clock.wall())
    return classifyClaudeEnd({ place, transcript, desktop: { appAlive, record, pauseLogged } })
  }

  /**
   * Its app or the machine stopped this conversation; the User did not close
   * it. Its questions stay open for their windows and what is answered
   * meanwhile waits for it to come back in place. The lease is no longer
   * renewed (the phone shows it out of reach) but its fencing identity is
   * kept, on disk too, so a later end can still be reported.
   */
  stopSession(session: HubSession, cause: StopCause, reason: string, since = this.clock.wall(), watch: StoppedWatch = null): void {
    if (session.ending !== null || session.stopped !== null) return
    if (session.endCandidate !== null) { clearTimeout(session.endCandidate.timer); session.endCandidate = null }
    session.stopped = { since, cause, boot: (this.options.bootIdentity ?? currentBootIdentity)(), watch }
    // Nothing is written through its process any more.
    for (const writer of [session.primary(), ...session.standbys]) if (writer !== null && !writer.child.closed) writer.child.send({ type: 'bye' })
    session.standbys = []
    session.child = null
    session.reloadedAt = null
    session.lease.setPhase('uncertain', 'stopped')
    session.lease.lose()
    // Where the service holds stopped sessions, it is told, and the session
    // stays in the exchange to see notes sent to it meanwhile.
    session.lease.holdStopped = true
    session.lease.needsFresh = true
    // A Claude Code wake written into the process that went never shows; the
    // next place gets its own. A Codex wake waits in the thread's own queue
    // and runs when the thread loads again.
    if (session.harness === 'claude-code') {
      try {
        updateSessionState(session.id, session.env, (state) => {
          if (state.input_wake === undefined) return state
          const next = { ...state }
          delete next.input_wake
          return next
        })
      } catch { /* A busy lock: the wake is replaced once it is overdue. */ }
    }
    session.writeStatus(true)
    this.logger.info('hub.session', { event: 'stopped', session: session.id, cause, reason, place: session.registration.place })
    if (!session.stoppedOwes(this.clock.wall())) { this.endSession(session, 'window-over'); return }
    if (session.harness === 'codex') void this.stoppedWake(session)
    this.driver.poke()
    this.touch()
  }

  /**
   * A stopped conversation that waits: ended once nothing it waits for is
   * still inside its window, or once the User ends it after all (deleted,
   * archived, or its app quit while the machine stayed up).
   */
  private checkStopped(session: HubSession): void {
    const stopped = session.stopped
    if (stopped === null) return
    session.dropExpiredAnswers()
    if (!session.stoppedOwes(this.clock.wall())) { this.endSession(session, 'window-over'); return }
    const record = this.recordPresent(session)
    if (record === 'deleted') { this.endSession(session, 'session-deleted'); return }
    if (record === 'archived') { this.endSession(session, 'session-archived'); return }
    if (session.registration.place === 'claude-desktop') {
      const paths = this.desktopPaths()
      const desktop = paths === null ? 'unreadable' : readClaudeDesktopRecord(paths.sessions, session.id)
      if (desktop === 'missing') { this.endSession(session, 'session-deleted'); return }
      if (typeof desktop === 'object' && desktop.archived) { this.endSession(session, 'session-archived'); return }
    }
    // Its app quit while the machine stayed up: the User closed it after all.
    const boot = (this.options.bootIdentity ?? currentBootIdentity)()
    const watched = stopped.watch === 'harness' ? session.harnessProcess : stopped.watch === 'host-app' ? session.registration.hostApp : null
    if (stopped.cause === 'app' && (stopped.boot === null || stopped.boot === boot) && watched !== null && !this.shutdownInProgress() &&
        processIdentityLiveness(watched) === 'gone') { this.endSession(session, 'app-quit'); return }
    if (session.harness === 'codex') void this.stoppedWake(session)
  }

  /** The machine's shutdown signal: watched for the hub's life. */
  private watchPower(): void {
    const factory = this.options.powerWatch ?? (this.options.handleSignals === true ? systemPowerWatch(this.env, launcherExecutable()) : false)
    if (factory === false) return
    try {
      this.powerWatch = factory((event) => this.onPower(event))
      const state = this.powerWatch.state()
      this.logger.info('hub.session', { event: 'power-watching', source: state.source, ...(state.unavailable === null ? {} : { unavailable: state.unavailable }) })
    } catch (err) {
      this.logger.error('hub.session', { event: 'power-watch-failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  onPower(event: PowerEvent): void {
    const now = this.clock.wall()
    if (event.kind === 'other') { this.logger.info('hub.session', { event: 'power-posted', name: event.name }); return }
    if (event.kind === 'shutdown') {
      if (this.shutdownState === null) this.shutdownState = { since: now, name: event.name }
      // Durable before the shutdown goes on: the next boot reads this.
      writeShutdownMarker(this.env, { boot: (this.options.bootIdentity ?? currentBootIdentity)(), since: this.shutdownState.since, name: this.shutdownState.name })
      for (const session of this.sessions.values()) session.writeStatus(true)
      this.logger.info('hub.session', { event: 'power-shutdown-in-progress', name: event.name })
      this.powerWatch?.persisted()
      this.statusChanged()
      return
    }
    // Cancelled: the apps that quit really did; decide what waited, as usual.
    if (this.shutdownState === null) return
    this.shutdownState = null
    rmSync(shutdownMarkerPath(this.env), { force: true })
    this.logger.info('hub.session', { event: 'power-shutdown-cancelled', name: event.name })
    for (const session of this.sessions.values()) {
      const candidate = session.endCandidate
      if (candidate === null) continue
      const waited = Math.max(0, now - candidate.since)
      this.holdEnd(session, candidate.reason, candidate.transcriptPath, Math.max(0, (this.options.endConfirmMs ?? END_CONFIRM_MS) - waited), candidate.since)
    }
    this.statusChanged()
  }

  /** A live process other than the recorded host that has the session's Codex thread loaded, or null. */
  private codexHolderElsewhere(session: HubSession): ProcessIdentity | null {
    const home = session.registration.codexHome ?? session.env['CODEX_HOME'] ?? null
    const holders = (this.options.codexThreadHolders ?? codexThreadHolders)(home, session.id)
    if (holders === 'unknown') return null
    for (const pid of holders) {
      if (pid === session.harnessProcess.pid || pid === process.pid) continue
      const start = processStartTime(pid)
      if (start !== null && !session.exited.has(identityKey({ pid, start }))) return { pid, start }
    }
    return null
  }

  /** Whether the session's Codex host has the thread loaded: it holds the thread's writer lock. */
  codexHolds(session: HubSession): boolean {
    const home = session.registration.codexHome ?? session.env['CODEX_HOME'] ?? null
    return (this.options.codexHostHoldsThread ?? codexHostHoldsThread)(home, session.id, session.harnessProcess.pid)
  }

  /**
   * A live Claude Code process whose own descriptor names this conversation,
   * other than one whose exit was seen: the most recently started, or null.
   */
  private claudeHostOf(session: HubSession): ProcessIdentity | null {
    const directory = claudeDescriptorDir(session.env)
    let names: string[]
    try { names = readdirSync(directory).filter((name) => /^\d+\.json$/.test(name)) } catch { return null }
    let best: { identity: ProcessIdentity; startedAt: number } | null = null
    for (const name of names) {
      const pid = Number(name.slice(0, -'.json'.length))
      const descriptor = readClaudeDescriptor(session.env, pid)
      if (descriptor === null || descriptor.sessionId !== session.id || !pidExists(pid)) continue
      const start = processStartTime(pid)
      if (start === null) continue
      const identity = { pid, start }
      if (session.exited.has(identityKey(identity)) || session.left.has(pid) || !descriptorStartMatches(descriptor.procStart, identity)) continue
      if (best === null || descriptor.startedAt > best.startedAt) best = { identity, startedAt: descriptor.startedAt }
    }
    return best?.identity ?? null
  }

  readonly stoppedWaking = new Set<string>()

  /**
   * An answer (or anything else staged) for a stopped Codex conversation
   * waits in it: one content-free wake goes into that thread's own queue
   * (`codex queue`, no connection to any Codex server), which Codex runs only
   * when the conversation loads again, that is, when the User opens it in
   * its app, sends in its Orca chat or T3 thread, or resumes it in a
   * terminal. Nothing starts or loads the thread before that. A thread some
   * process has loaded gets none: a wake into a thread loaded with nobody
   * watching would run unseen, and a place that shows it registers first.
   */
  async stoppedWake(session: HubSession): Promise<void> {
    if (session.harness !== 'codex' || session.stopped === null || session.ending !== null || this.handingOver || this.stoppedWaking.has(session.id)) return
    const home = session.registration.codexHome ?? session.env['CODEX_HOME'] ?? null
    const open = (): boolean => session.stopped !== null && session.ending === null && !sessionHasEnded(session.id, session.env) &&
      session.rollout() === 'sessions' && (this.options.codexThreadHeld ?? codexThreadHeld)(home, session.id) !== true
    const lease = session.lease.generation === null ? null : { incarnation: session.lease.incarnation, generation: session.lease.generation }
    if (readSessionState(session.id, session.env).input_wake?.queued === true || !hasSessionInputs(session.id, session.env, lease) || !open()) return
    this.stoppedWaking.add(session.id)
    try {
      await wakeSessionInputs(session.id, session.env, async (text) => {
        if (!open() || !hasSessionInputs(session.id, session.env, lease)) return false
        const result = await deliverIntoCodexThread({ threadId: session.id, cwd: session.registration.cwd ?? process.cwd(), env: session.env,
          adapters: this.codexAdapters(session), text, begin: open })
        this.logger.info('hub.session', { event: 'stopped-wake', session: session.id, outcome: result.status })
        return result.status === 'written'
      }, this.logger)
    } catch (err) {
      this.logger.error('hub.session', { event: 'stopped-wake', session: session.id, message: err instanceof Error ? err.message : String(err) })
    } finally {
      this.stoppedWaking.delete(session.id)
    }
  }

  /**
   * Detach Notifai's own unconsumed wakes from a closing thread, and delete
   * them from its native queue when that queue is reachable. For a stopped
   * thread nothing connects to any Codex server: the prompt hook blocks a
   * wake the thread shows later.
   */
  private async withdrawQueuedWakes(sessionId: string, env: NodeJS.ProcessEnv, connect: boolean): Promise<void> {
    const scope = { sessionId, env }
    try {
      if (!readInputWakes(scope).some((attempt) => attempt.phase !== 'consumed' && attempt.phase !== 'cancelled')) return
      detachInputWakes({ ...scope, pendingIds: () => [] })
      if (connect) await reconcileSessionInputWakes(sessionId, env, this.deps.codexQueueControl ?? connectCodexQueue)
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
    for (const standby of session.standbys) this.removeEndRecords(session.id, standby.harnessProcess.pid)
    this.logger.info('hub.lease', { event: 'released', session: session.id, reason })
    this.touch()
  }

  /**
   * A swept session's `ended` report reached the service: record its lease
   * exited, so no later hub start reports that end again.
   */
  endReported(session: EndedSession): void {
    this.ended.delete(session.id)
    try {
      const file = attendantStatusPath(session.id, this.env)
      const status = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      if (status['session_id'] === session.id && status['incarnation'] === session.lease.incarnation && status['phase'] !== 'exited') {
        atomicWriteFileSync(file, `${JSON.stringify({ ...status, pid: process.pid, phase: 'exited', reason: 'reported-ended', generation: null,
          accepts_messages: false, updated_at: this.clock.wall() })}\n`)
      }
    } catch { /* No status: nothing would report it again. */ }
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
        const standby = live.standbys.find((writer) => writer.harnessProcess.pid === record['harness_pid'])
        if (live.harnessProcess.pid === record['harness_pid']) this.closing(live, 'harness-gone')
        else {
          if (standby !== undefined) {
            live.exited.add(identityKey(standby.harnessProcess))
            live.standbys = live.standbys.filter((writer) => writer !== standby)
          }
          rmSync(path.join(directory, name), { force: true })
        }
        continue
      }
      // Its harness exited while the machine went down: stopped, not closed.
      if ((record['harness'] === 'claude-code' || record['harness'] === 'codex') &&
        this.stopAtStart(sessionId, typeof record['boot'] === 'string' ? record['boot'] : null,
        typeof record['at'] === 'number' ? record['at'] : Number.NaN)) {
        rmSync(path.join(directory, name), { force: true })
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
      if (!otherBoot) {
        // A live child reports its own session's end, to whichever hub runs.
        if (childWatching(this.env, sessionId, incarnation.harness_process.pid)) continue
        // Closed while no hub reported it: its harness is gone, it ran
        // SessionEnd (the harness itself may live on: /clear, another
        // conversation), or Codex archived its rollout.
        const closed = processIdentityLiveness(incarnation.harness_process) === 'gone' ||
          endsIncarnation(readSessionEndMarker(sessionId, this.env), incarnation) ||
          recordedRolloutArchived(this.env, sessionId, status)
        if (!closed) continue
      }
      // Attended when the machine went down (power loss, a crash, a reboot): stopped, not closed.
      if (otherBoot && this.stopAtStart(sessionId, incarnation.boot, null)) continue
      this.queueEnded(sessionId, incarnation.harness_process.pid, [])
    }
    // An earlier boot's shutdown has been read for every session it concerned.
    const marker = readShutdownMarker(this.env)
    if (marker !== null && boot !== null && marker.boot !== boot) rmSync(shutdownMarkerPath(this.env), { force: true })
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
   *
   * Each is recorded in `run/settlements` first and the record removed when
   * it ends, so the next hub runs again whatever this one did not finish (a
   * handover, a crash). A hub handing over only records it.
   */
  settle(sessionId: string, harness: HookInstallableHarness, cwd: string | null, purpose: 'submission' | 'settlement',
    env: NodeJS.ProcessEnv = this.sessions.get(sessionId)?.env ?? this.env): void {
    const key = `${sessionId}\0${purpose}`
    const record = path.join(hubSettlementsDir(this.env), `${fnv64Hex(key)}.json`)
    try {
      ensurePrivateDirectory(hubSettlementsDir(this.env))
      atomicWriteFileSync(record, `${JSON.stringify({ session_id: sessionId, harness, cwd, purpose,
        claude_config_dir: env['CLAUDE_CONFIG_DIR'] ?? null, codex_home: env['CODEX_HOME'] ?? null })}\n`)
    } catch (err) {
      this.logger.error('hub.session', { event: 'settlement-unrecorded', session: sessionId, message: err instanceof Error ? err.message : String(err) })
    }
    if (this.handingOver || this.exiting) return
    const running = this.settlements.get(key)
    if (running !== undefined) { running.rerun = true; return }
    const entry = { rerun: false }
    this.settlements.set(key, entry)
    void (async () => {
      do {
        entry.rerun = false
        try {
          await this.runInternalHook(purpose === 'submission' ? 'question-submission' : 'question-settlement', { session_id: sessionId,
            ...(cwd === null ? {} : { cwd }) }, harness, env)
        } catch (err) {
          this.logger.error('hub.session', { event: 'settlement-failed', session: sessionId, message: err instanceof Error ? err.message : String(err) })
        }
      } while (entry.rerun && !this.exiting && !this.handingOver)
    })().finally(() => {
      this.settlements.delete(key)
      // Stood down for a handover (or cut by an exit): the next hub runs it again.
      if (!this.handingOver && !this.exiting) rmSync(record, { force: true })
      this.inputStaged(sessionId)
      this.touch()
    })
  }

  /** The answer owners a previous hub recorded and did not finish. */
  settlementRecords(): SettlementRecord[] {
    const directory = hubSettlementsDir(this.env)
    let names: string[]
    try { names = readdirSync(directory).filter((name) => /^[0-9a-f]{16}\.json$/.test(name)) } catch { return [] }
    const records: SettlementRecord[] = []
    for (const name of names) {
      const file = path.join(directory, name)
      try {
        const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        const absolute = (key: string): string | null => typeof value[key] === 'string' && path.isAbsolute(value[key]) ? value[key] : null
        const harness = value['harness'], sessionId = value['session_id'], purpose = value['purpose']
        if (typeof sessionId !== 'string' || sessionId === '' || typeof harness !== 'string' || !isHookInstallableHarness(harness) ||
            (purpose !== 'submission' && purpose !== 'settlement')) { rmSync(file, { force: true }); continue }
        records.push({ file, sessionId, harness, cwd: absolute('cwd'), purpose, claudeConfigDir: absolute('claude_config_dir'), codexHome: absolute('codex_home') })
      } catch { rmSync(file, { force: true }) }
    }
    return records
  }

  /**
   * Take over what the previous hub held only in memory, whatever ended it:
   * the conversations no child will bring back (stopped, or whose
   * end it was still deciding), and the answer owners it ran.
   */
  async restore(): Promise<void> {
    for (const candidate of stoppedCandidates(this.env)) {
      if (this.exiting || this.handingOver) return
      if (this.sessions.has(candidate.sessionId) || this.ended.has(candidate.sessionId)) continue
      await this.adoptStopped(candidate.sessionId, candidate.record)
    }
    for (const candidate of adoptionCandidates(this.env)) {
      if (this.exiting || this.handingOver) return
      if (candidate.record === null || this.sessions.has(candidate.sessionId) || this.ended.has(candidate.sessionId)) continue
      await this.adopt(candidate.sessionId, candidate.record)
    }
    for (const record of this.settlementRecords()) {
      if (this.exiting || this.handingOver) return
      this.settle(record.sessionId, record.harness, record.cwd, record.purpose,
        this.sessions.get(record.sessionId)?.env ?? this.sessionEnv({ claudeConfigDir: record.claudeConfigDir, codexHome: record.codexHome }))
    }
  }

  /**
   * Attend a Codex session a previous hub attended, without its child: take
   * the claim, continue the lease at its generation, restart its answer
   * owner when something is owed, and decide again, from fresh evidence, what
   * the previous hub held: closed (archived, its host gone), or an end to
   * confirm and classify now.
   */
  private async adopt(sessionId: string, record: AdoptionRecord): Promise<void> {
    const registration: Registration = {
      sessionId, harness: record.harness, harnessProcess: record.harness_process, boot: record.boot,
      stamp: { wall: this.clock.wall(), mono: '0' }, hookEvent: 'Adopted', source: null, cwd: record.cwd,
      transcriptPath: record.transcript_path, inboxSocket: null, inboxToken: false,
      claudeConfigDir: record.claude_config_dir, codexHome: record.codex_home, harnessTicks: record.harness_ticks,
      place: record.place, hostApp: record.host_app, terminalHost: record.terminal_host,
    }
    const env = this.sessionEnv(registration)
    const incarnation = readSessionIncarnation(sessionId, env)
    if (incarnation === null) return
    const session = new HubSession(this, sessionId, record.harness, env, record.harness_process, incarnation, registration)
    if (record.last_activity_at !== null) session.lastActivity = record.last_activity_at
    session.transcriptSeen = record.transcript_seen
    session.transcriptGone()
    session.claimToken = await this.takeClaim(session)
    if (session.claimToken === null) return
    if (this.sessions.has(sessionId) || this.exiting) {
      // A child registered it meanwhile, or this hub is leaving.
      releaseClaimFile(attendantClaimPath(sessionId, env), session.claimToken)
      return
    }
    this.sessions.set(sessionId, session)
    const now = this.clock.wall()
    session.lease.setPhase('uncertain', 'session-child-disconnected')
    session.writeStatus(true)
    this.logger.info('hub.session', { event: 'adopted', session: sessionId, harness: record.harness })
    const state = readSessionState(sessionId, env)
    if (pendingList(state).length > 0 || state.accepted !== undefined) this.settle(sessionId, record.harness, record.cwd, 'settlement')
    const probe = session.probe()
    if (probe.state === 'ended') this.endSession(session, probe.reason)
    else if (session.transcriptGone()) this.endSession(session, 'session-archived')
    else if (session.harnessGone()) this.closing(session, 'harness-gone')
    // An end the previous hub was still confirming: confirm what is left of it.
    else if (record.end_candidate_since !== null) {
      const waited = Math.max(0, now - record.end_candidate_since)
      this.holdEnd(session, 'session-end-hook', record.transcript_path,
        Math.max(0, (this.options.endConfirmMs ?? END_CONFIRM_MS) - waited), record.end_candidate_since)
    }
    // An app or IDE conversation whose end was still being decided: decide
    // now, as its SessionEnd would have. Anything else stays attended,
    // watched by the process table until a child comes back or its host goes.
    else if (codexAppSurface(readCodexThreadOriginator(record.transcript_path)) !== null) this.holdEnd(session, 'session-end-hook', record.transcript_path)
    this.touch()
  }

  /**
   * Take back a conversation a previous hub stopped (or the start sweep found
   * stopped by the machine going down): no child, no renewals, its answer
   * owner running while a question waits, until it comes back in place or
   * nothing it waits for is still inside its window.
   */
  private async adoptStopped(sessionId: string, record: AdoptionRecord): Promise<void> {
    const registration: Registration = {
      sessionId, harness: record.harness, harnessProcess: record.harness_process, boot: record.boot,
      stamp: { wall: this.clock.wall(), mono: '0' }, hookEvent: 'Adopted', source: null, cwd: record.cwd,
      transcriptPath: record.transcript_path, inboxSocket: null, inboxToken: false,
      claudeConfigDir: record.claude_config_dir, codexHome: record.codex_home, harnessTicks: record.harness_ticks,
      place: record.place, hostApp: record.host_app, terminalHost: record.terminal_host,
    }
    const env = this.sessionEnv(registration)
    const incarnation = readSessionIncarnation(sessionId, env)
    if (incarnation === null || record.stopped === null) return
    const session = new HubSession(this, sessionId, record.harness, env, record.harness_process, incarnation, registration)
    if (record.last_activity_at !== null) session.lastActivity = record.last_activity_at
    session.transcriptSeen = record.transcript_seen
    session.stopped = record.stopped
    session.lease.setPhase('uncertain', 'stopped')
    session.lease.holdStopped = true
    session.claimToken = await this.takeClaim(session)
    if (session.claimToken === null) return
    if (this.sessions.has(sessionId) || this.exiting) {
      releaseClaimFile(attendantClaimPath(sessionId, env), session.claimToken)
      return
    }
    this.sessions.set(sessionId, session)
    session.writeStatus(true)
    this.logger.info('hub.session', { event: 'adopted', session: sessionId, harness: record.harness, stopped_by: record.stopped.cause })
    const state = readSessionState(sessionId, env)
    if (pendingList(state).length > 0 || state.accepted !== undefined) this.settle(sessionId, record.harness, record.cwd, 'settlement')
    this.checkStopped(session)
    this.touch()
  }

  /**
   * At the start sweep: a conversation attended in an earlier boot that the
   * machine going down stopped (see `machineDownEarlierBoot`) is kept as
   * stopped, not ended, while something waits for it and its transcript or
   * rollout is there (an archived rollout was closed by the User). `endedAt`
   * is its child's end record, when one exists.
   */
  private stopAtStart(sessionId: string, recordedBoot: string | null | undefined, endedAt: number | null): boolean {
    const declined = (reason: string): false => {
      this.logger.info('hub.session', { event: 'not-stopped-at-start', session: sessionId, reason })
      return false
    }
    const file = attendantStatusPath(sessionId, this.env)
    let status: Record<string, unknown>
    try { status = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return declined('no-status') }
    const record = parseAdoptionRecord(status['adoption'])
    if (record === null) return declined('no-record')
    const boot = (this.options.bootIdentity ?? currentBootIdentity)()
    const marker = readShutdownMarker(this.env)
    if (!machineDownEarlierBoot({ recordedBoot, currentBoot: boot, endedAt, endPending: record.end_candidate_since !== null,
      shutdown: marker === null || marker.boot === null ? null : { boot: marker.boot, since: marker.since } })) return declined('not-machine-down')
    const env = this.sessionEnv({ claudeConfigDir: record.claude_config_dir, codexHome: record.codex_home })
    const lease = readAttendantEndingLease(sessionId, env)
    if (lease === null) return declined('no-lease')
    const present = record.harness === 'claude-code'
      ? claudeTranscriptPresent(path.dirname(claudeDescriptorDir(env)), sessionId, record.transcript_path)
      : locateCodexRollout(record.codex_home, sessionId, record.transcript_path).place === 'sessions'
    if (!present) return declined('transcript-missing')
    const updatedAt = typeof status['updated_at'] === 'number' ? status['updated_at'] : null
    const since = Math.min(this.clock.wall(), endedAt !== null && Number.isFinite(endedAt) ? endedAt : updatedAt ?? this.clock.wall())
    const stopped: StoppedRecord = { since, cause: 'machine', boot: typeof recordedBoot === 'string' ? recordedBoot : null, watch: null }
    if (!owesWhileStopped(sessionId, env, since, lease, this.clock.wall())) return declined('nothing-waits')
    try {
      atomicWriteFileSync(file, `${JSON.stringify({ ...status, pid: process.pid, phase: 'exited', reason: 'stopped', accepts_messages: false,
        updated_at: this.clock.wall(), adoption: { ...record, end_candidate_since: null, stopped } })}\n`)
    } catch {
      return declined('status-unwritable')
    }
    this.logger.info('hub.session', { event: 'stopped', session: sessionId, cause: 'machine', reason: endedAt === null ? 'boot-changed' : 'ended-while-going-down' })
    return true
  }

  private async runInternalHook(event: string, envelope: Record<string, unknown> | null, harness: HookInstallableHarness, env: NodeJS.ProcessEnv): Promise<number> {
    if (this.options.runHook !== undefined) return this.options.runHook(event, envelope, harness, env)
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
    delete deps.spawnEndConfirmation
    delete deps.spawnHubHandover
    return hookRunCommand(deps, event, async () => envelope === null ? '' : JSON.stringify(envelope), harness)
  }

  /** Local end work a handover waits for. */
  private trackLocalEnd(work: Promise<void>): void {
    const tracked = work.catch(() => undefined).finally(() => { this.localEnds.delete(tracked) })
    this.localEnds.add(tracked)
  }

  /** An answer was staged for a session: hand it in now rather than at a later tick. */
  inputStaged(sessionId: string): void {
    this.sessions.get(sessionId)?.checkInput()
  }

  // -- Codex's shared server: is the conversation still on a screen? ------------

  private readonly sharedHosts = new Map<string, boolean>()
  private readonly attachChecking = new Set<string>()
  private codexBuildChecking = false
  private attachWatchTimer: ReturnType<typeof setInterval> | null = null

  /** Whether the session's Codex host is the shared server (asked once per host process). */
  codexSharedServer(session: HubSession): boolean {
    if (session.harness !== 'codex') return false
    const key = identityKey(session.harnessProcess)
    let shared = this.sharedHosts.get(key)
    if (shared === undefined) {
      const kind = this.codexHostKind(session.harnessProcess.pid)
      if (kind === 'unknown') return false
      shared = kind === 'shared-server'
      if (this.sharedHosts.size > 256) this.sharedHosts.clear()
      this.sharedHosts.set(key, shared)
    }
    return shared
  }

  /** What kind of Codex process hosts a session: its own app, a terminal, the shared server. */
  codexHostKind(pid: number): CodexHostKind {
    return (this.options.codexHostKind ?? codexHostKind)(pid)
  }

  /**
   * The idle-wake rule: anywhere but the shared server as before; there only
   * shortly after a terminal was confirmed to show the thread.
   */
  codexIdleWake(session: HubSession, owner: ProcessIdentity): boolean {
    if (identityKey(owner) !== identityKey(session.harnessProcess)) return this.codexHostKind(owner.pid) !== 'shared-server'
    return !this.codexSharedServer(session) || this.clock.monotonic() < session.attachWakeUntil
  }

  private codexAttachVerified(session: HubSession): boolean {
    return (this.options.codexAttach?.verified ?? ((host: ProcessIdentity) => codexAttachVerified(host, this.env)))(session.harnessProcess)
  }

  /**
   * Ask whether a terminal shows a shared-server conversation: before a wake
   * (`input`: both checks, so a terminal that joined it is woken too), or for
   * the close watch (`watch`: the confirming request only when the passive
   * check sees no terminal). Confirmed shown: the wake goes through. Confirmed
   * not shown: the User closed it, and its questions expire. Anything else
   * changes nothing. Nothing runs before Codex's behaviour was checked for
   * the binary that server runs; that check is started here.
   */
  async checkCodexAttach(session: HubSession, why: 'input' | 'watch'): Promise<void> {
    if (this.attachChecking.has(session.id) || session.ending !== null || session.stopped !== null || session.endCandidate !== null ||
        this.handingOver || this.exiting) return
    if (why === 'input' && this.clock.monotonic() - session.attachAskedAt < CODEX_ATTACH_WATCH_MS) return
    if (!this.codexAttachVerified(session)) { this.checkCodexBuild(session); return }
    this.attachChecking.add(session.id)
    if (why === 'input') session.attachAskedAt = this.clock.monotonic()
    const host = session.harnessProcess
    let result: CodexAttachState
    try {
      const input: CodexAttachInput = {
        threadId: session.id, env: session.env, host, confirm: why === 'input' ? 'always' : 'closed',
        beforeConfirm: () => { session.attachOwnReload = { pid: host.pid, at: this.clock.monotonic() } },
      }
      result = await (this.options.codexAttach?.state ?? ((value: CodexAttachInput) =>
        codexThreadAttachState(value, { verified: () => true })))(input)
    } catch {
      result = { state: 'unknown', confirmed: false, reason: 'check-failed' }
    } finally {
      this.attachChecking.delete(session.id)
    }
    if (this.sessions.get(session.id) !== session || session.ending !== null || session.stopped !== null ||
        identityKey(session.harnessProcess) !== identityKey(host)) return
    if (result.state === 'attached' && result.confirmed) {
      session.attachWakeUntil = this.clock.monotonic() + CODEX_ATTACH_WAKE_MS
      // Only a terminal that joined it shows it: asking again every few seconds would reload nothing new.
      if (why === 'watch') session.attachWatchPaused = true
      if (why === 'input') {
        this.logger.info('hub.session', { event: 'terminal-shows', session: session.id, reason: result.reason })
        session.checkInput()
      }
      return
    }
    if (result.state === 'closed' && result.confirmed) {
      this.logger.info('hub.session', { event: 'terminal-closed', session: session.id, reason: result.reason })
      this.endSession(session, 'terminal-closed')
      return
    }
    if (why === 'input') this.logger.info('hub.session', { event: 'wake-held', session: session.id, reason: result.reason })
  }

  /** Check, in the background and once per binary, that Codex still behaves as the shared-server checks need. */
  private checkCodexBuild(session: HubSession): void {
    if (this.codexBuildChecking || this.exiting) return
    this.codexBuildChecking = true
    const run = this.options.codexAttach?.checkBuild ?? ((host: ProcessIdentity) => checkCodexServerBuild(this.env, host, this.clock.wall(),
      undefined, (event) => this.logger.info('hub.session', { ...event, event: `codex-check-${String(event['event'])}` })))
    void run(session.harnessProcess).then((result) => {
      if (result === null) return
      this.logger.info('hub.session', { event: 'codex-check-finished', outcome: result.outcome, step: result.step ?? null,
        codex_version: result.codexVersion, detail: result.detail ?? null })
      if (result.outcome === 'passed') for (const each of this.sessions.values()) if (this.codexSharedServer(each)) each.checkInput()
    }).catch((err: unknown) => {
      this.logger.error('hub.session', { event: 'codex-check-failed', message: err instanceof Error ? err.message : String(err) })
    }).finally(() => { this.codexBuildChecking = false })
  }

  /**
   * Codex runs no hook when a terminal on its shared server closes. While a
   * conversation there has asked the User something, look every few seconds.
   */
  private watchCodexAttach(): void {
    for (const session of this.sessions.values()) {
      if (session.harness !== 'codex' || session.attachWatchPaused || session.ending !== null || session.stopped !== null ||
          session.endCandidate !== null || session.child === null || session.child.closed || !session.notified ||
          !this.codexSharedServer(session)) continue
      void this.checkCodexAttach(session, 'watch')
    }
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
    this.applyDeferredClaudeForm(now)
    void this.checkBuildHandover()
    for (const session of this.sessions.values()) {
      if (session.ending !== null) continue
      if (session.stopped !== null) { this.checkStopped(session); continue }
      // An archived or deleted Codex conversation is closed (E5); Codex runs no SessionEnd for it.
      if (session.transcriptGone()) { this.endSession(session, 'session-archived'); continue }
      if (session.lease.phase === 'dormant' && session.notified) { session.lease.needsFresh = true; this.driver.poke() }
      if (session.harness === 'codex' && session.lease.generation !== null) {
        refreshCodexInputActivity(session.id, session.env, session.record.key, session.registration.transcriptPath ?? undefined,
          (owner) => session.harnessAlive(owner))
        void reconcileSessionInputWakes(session.id, session.env, this.deps.codexQueueControl).catch(() => undefined)
      }
      // A thread the shared Codex server reloaded runs there only while it holds the thread.
      if (session.reloadedAt !== null && (session.child === null || session.child.closed) &&
          (session.harnessGone() || !this.codexHolds(session))) {
        session.reloadedAt = null
        session.writeStatus()
      }
      if (session.lease.phase === 'attending' && session.lease.leaseEndsAt !== null && this.clock.monotonic() >= session.lease.leaseEndsAt) {
        // The service has not renewed the lease (an outage): say so to status readers.
        session.lease.setPhase('acquiring', 'lease-lapsed')
        session.writeStatus()
      }
      const probe = session.probe()
      if (probe.state === 'ended') this.closing(session, probe.reason)
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
          this.closing(session, 'harness-gone')
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

  private claudeFormTriedAt = 0

  /**
   * An install or update held Claude Code's exec-form hooks back while an
   * older attendant ran (it reads only shell form). Once none runs (each gone,
   * or handed its session to this hub at its next hook), apply the change the
   * User's install or update already asked for. Never while one still runs.
   */
  applyDeferredClaudeForm(now: number): void {
    // At most every five minutes: a Claude Code version this hub cannot read keeps the record.
    if (now - this.claudeFormTriedAt < 5 * 60_000) return
    const deferral = readClaudeFormDeferral(this.env)
    if (deferral === null || olderClaudeAttendantsAlive(this.env) > 0) return
    this.claudeFormTriedAt = now
    const env = { ...this.env }
    if (deferral.claude_config_dir === null) delete env['CLAUDE_CONFIG_DIR']
    else env['CLAUDE_CONFIG_DIR'] = deferral.claude_config_dir
    void import('./commands-hook-install.js').then(({ hooksRefreshCommand }) => {
      const code = hooksRefreshCommand({ ...this.deps, env, io: { out: () => undefined, err: (line) => this.logger.debug('hub.session', { note: line }),
        confirm: async () => false, openUrl: () => undefined } }, 'claude-code')
      this.logger.info('hub.session', { event: 'claude-hook-form-applied', outcome: code === EXIT.ok ? 'ok' : 'failed',
        deferred: readClaudeFormDeferral(this.env) !== null })
    }).catch((err: unknown) => {
      this.logger.error('hub.session', { event: 'claude-hook-form-applied', outcome: 'failed', message: err instanceof Error ? err.message : String(err) })
    })
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
    if (this.children > 0 || this.settlements.size > 0 || this.updating || this.ingressInFlight > 0 || this.handingOver) return true
    // A stopped conversation still owed something: watch its app, so a quit expires it at once.
    const wall = this.clock.wall()
    for (const session of this.sessions.values()) {
      if (session.endCandidate !== null || session.stoppedOwes(wall)) return true
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
      runtime_build: this.runtimeBuild(),
      // A newer build reads this: this hub hands itself over at once and the
      // next hub takes over everything it holds, so nobody replaces it from outside.
      seamless_handover: true,
      handing_over: this.handingOver,
      handover: this.handoverState,
      ipc_version: HUB_IPC_VERSION,
      started_at: new Date(this.startedAt).toISOString(),
      transport: this.driver.transport,
      requests: this.driver.requests,
      last_exchange_at: this.driver.lastSuccessAt === null ? null : new Date(this.driver.lastSuccessAt).toISOString(),
      children: this.children,
      credential: this.unauthorizedState ? 're-pair-needed' : this.credential === undefined ? 'unread' : this.credential === null ? 'absent' : 'present',
      recent_crashes: this.crashes,
      settlements: this.settlements.size,
      ingress: { served: this.ingressCounts.served, declined: this.ingressCounts.declined, reasons: { ...this.ingressCounts.reasons } },
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
        writers: (session.child !== null && !session.child.closed ? 1 : 0) + session.standbys.length,
        end_pending: session.endCandidate !== null,
        stopped: session.stopped?.cause ?? null,
      })),
      pending_end_reports: this.ended.size,
      power_watch: this.powerWatch?.state() ?? { source: null, unavailable: 'off' },
      shutdown_in_progress: this.shutdownState !== null,
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
  const hub = new Hub(deps, { deps, handleSignals: true, ...(buildIdentity() !== null ? { automaticUpdate: {}, handover: {} } : {}) })
  return hub.run()
}
