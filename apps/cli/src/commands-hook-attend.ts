import { hasSessionInputs, inputWakeOverdue, stageSessionMessages, wakeSessionInputs, wakeCodexSessionInputs, reconcileSessionInputWakes } from './session-inputs.js'
/**
 * `notifai hook attend`: the asynchronous handler that becomes an Agent
 * Session's Session Attendant, or exits within milliseconds when a healthy
 * attendant for this exact session incarnation already runs.
 *
 * Installed on SessionStart next to the short activation handler (which it
 * never delays: the harness does not wait for an async handler), and on
 * UserPromptSubmit and Stop to re-arm a session whose attendant died.
 */
import { existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { EXIT, makeClient, type CommandDeps } from './commands-core.js'
import { claudeSessionPid } from './commands-harness-context.js'
import { loadConfig } from './config.js'
import type { ApiClient } from './client.js'
import { inspectHookAdapter, isNpxAdapterTarget, type HookAdapterTarget } from './hook-adapter.js'
import { acquireClaimFile, claimHolderMayRun, readClaimFile, releaseClaimFile, requestClaimHandoff } from './hook-question-lock.js'
import {
  beginSessionIncarnation,
  endsIncarnation,
  readSessionEndMarker,
  type LifecycleStamp,
  readSessionIncarnation,
  readSessionState,
  refreshSessionMarkers,
  rotateSessionIncarnation,
  sessionNotified,
  sessionHasEnded,
  updateSessionState,
  happenedBefore,
} from './hook-session-state.js'
import type { HookEnvelope, HookHarness } from './hook-types.js'
import { findInstallations, findLegacyProjectInstallations, handlerEvent } from './install-hooks.js'
import { logSettingsFrom, type Logger } from './logging.js'
import { processExecutableName, processStartTime, type ProcessIdentity } from './process-identity.js'
import { projectBinding, projectEnabled } from './project-enablement.js'
import { packageVersion } from './release.js'
import type { AttendanceMessage } from '@raidiant/notifai-protocol'
import {
  runSessionAttendant,
  systemAttendantClock,
  type AttendantClock,
  type AttendantHandle,
  type AttendantResult,
  type GateResult,
} from './session-attendant.js'
import {
  attendantSupport,
  claudeAttendanceProbe,
  codexAttendanceProbe,
  openclawAttendanceProbe,
  systemClaudeProbeAdapters,
  type ClaudeProbeAdapters,
} from './session-attendant-probe.js'
import {
  attendantClaimPath,
  attendantStatusPath,
  observedCodexTurnActivity,
  readAttendantLease,
  recordTurnEnd,
  recordTurnStart,
  reconcileNativeTurn,
  turnActivityPath,
  writeAttendantStatus,
} from './session-attendant-state.js'
import { CLI_PACKAGE_NAME } from './cli-contract.js'
import { inspectClaudeInbox, systemClaudeWakeAdapters, type ClaudeWakeAdapters } from './claude-wake.js'
import { currentProcessIdentity } from './process-identity.js'
import type { DeliveryLease, SequencerDeps } from './session-delivery.js'
import { inspectCodexQueue, systemCodexWakeAdapters, type CodexWakeAdapters } from './codex-wake.js'
import { claudeSourceDescriptor, deliverIntoClaudeSession, deliverIntoCodexThread } from './session-handoff.js'
import { handOffSessionMessages, type MessageHandOffResult } from './session-message-handoff.js'
import { compareVersions } from './version.js'
import { readOpenclawGeneration } from './openclaw-generation.js'
import { integrationFaultNotice } from './integration-health.js'
import { openclawBridgeActivity, openclawMessageBridge, openclawMessageBridgeAvailable } from './openclaw-message-bridge.js'
import { readNativeTurnSnapshot } from './codex-native-turn.js'
import { codexInputObserver, refreshCodexInputActivity } from './codex-input-lifecycle.js'

// Captured when this module loads, so an in-place build cannot make a resident
// writer mistake the replacement files for its own loaded implementation.
export const attendantRuntimeRevision = (() => {
  const file = fileURLToPath(import.meta.url), extension = path.extname(file), directory = path.dirname(file)
  const hash = createHash('sha256')
  for (const name of readdirSync(directory).filter(name => name.endsWith(extension) &&
    !name.endsWith('.d.ts') && !name.endsWith('.test.ts')).sort()) {
    hash.update(name).update('\0').update(readFileSync(path.join(directory, name)))
  }
  return hash.digest('hex')
})()

/** Test seams; production reads the real harness, clocks, and signals. */
export interface AttendantSeams {
  harnessProcess?: ProcessIdentity
  probeAdapters?: ClaudeProbeAdapters
  clock?: AttendantClock
  /** Resolves to simulate SIGTERM/SIGHUP/SIGINT. */
  signalled?: Promise<void>
  probeIntervalMs?: number
  waitSeconds?: number
  /** How long a new start waits for a superseded attendant to step aside. */
  supersededOwnerWaitMs?: number
  /** Replace the Project Enablement and installed-contract gates. */
  gates?: () => GateResult
  /** Observe the finished attendant. */
  onExit?: (result: AttendantResult) => void
  /** This attendant as a writer; production reads its own PID and start time. */
  writer?: ProcessIdentity | null
}

const SUPERSEDED_OWNER_WAIT_MS = 6_000

/**
 * Bound on Codex SessionEnd's `ended` report. Codex allows SessionEnd at most
 * three seconds, and the CLI's own start and durable cleanup come first.
 */
export const CODEX_SESSION_END_REPORT_MS = 1_000

export async function attendHook(
  deps: CommandDeps,
  input: {
    envelope: HookEnvelope
    harness: HookHarness | undefined
    cwd: string
    invokedAt: LifecycleStamp
    logger: Logger
    /** Explicit updater recovery, never a fabricated native hook invocation. */
    recovery?: { key: string; harnessProcess: ProcessIdentity; transcriptPath: string }
  },
): Promise<number> {
  const { envelope, harness, cwd, logger } = input
  const seams = deps.attendant ?? {}
  const end = (outcome: string, data: Record<string, unknown> = {}): number => {
    if (input.recovery !== undefined) logger.info('attendant.state', { source: 'update-resume', outcome, ...data })
    else logger.info('hook.end', { hook: 'attend', outcome, decided: false, ...data })
    return EXIT.ok
  }
  // Read once, now: an in-place reinstall replaces the manifest on disk, and
  // rereading it later would compare the installed files with themselves.
  const runningVersion = deps.runningVersion === undefined ? packageVersion() : deps.runningVersion
  const sessionId = envelope.session_id
  if (sessionId === undefined) return end('ignored', { reason: 'missing-session-id' })
  const support = attendantSupport(harness, deps.hookPlatform ?? process.platform)
  if (!support.supported) return end('unsupported', { reason: support.reason })
  if (harness !== 'claude-code' && harness !== 'codex' && harness !== 'openclaw') {
    return end('unsupported', { reason: 'harness-has-no-attendant' })
  }

  const starting = envelope.hook_event_name === 'SessionStart' || envelope.source !== undefined
  const claimFile = attendantClaimPath(sessionId, deps.env)
  // The hook adapter names the harness process that ran it. Claude Code also
  // names itself; Codex is only ever the declared parent.
  const pid = input.recovery?.harnessProcess.pid ?? (harness === 'codex' || harness === 'openclaw'
    ? declaredHookSourcePid(deps.env)
    : declaredHookSourcePid(deps.env) ?? claudeSessionPid(deps.env))
  if (pid === undefined) return end('ignored', { reason: 'harness-process-unproven' })
  const nativeOwner = harness === 'codex'
    ? seams.harnessProcess ?? (() => {
        const start = processStartTime(pid)
        return start === null ? null : { pid, start }
      })()
    : null
  const ownsNative = (key: string): boolean => {
    const current = readSessionIncarnation(sessionId, deps.env)
    return nativeOwner !== null && current?.key === key &&
      envelope.agent_id === undefined && envelope.agent_type === undefined &&
      current.harness_process?.pid === nativeOwner.pid && current.harness_process.start === nativeOwner.start &&
      (input.recovery === undefined || current.key === input.recovery.key) &&
      !happenedBefore(input.invokedAt, current.start) && !sessionHasEnded(sessionId, deps.env)
  }
  const observeNative = (key: string, initial = false): void => {
    if (!ownsNative(key)) return
    if (envelope.hook_event_name === 'Stop') {
      refreshCodexInputActivity(sessionId, deps.env, key, envelope.transcript_path)
      return
    }
    if (envelope.hook_event_name === 'Interrupt') {
      recordCodexTurnEnd(envelope, sessionId, deps.env)
      return
    }
    if (!initial && envelope.hook_event_name !== 'UserPromptSubmit' && input.recovery === undefined) return
    const native = readNativeTurnSnapshot(input.recovery?.transcriptPath ?? envelope.transcript_path, sessionId, deps.env)
    const turnId = envelope.turn_id ?? (initial || input.recovery !== undefined ? native?.latest.id : undefined)
    if (native === null || turnId === undefined) return
    try {
      if (reconcileNativeTurn(sessionId, deps.env, key, turnId, native, () => ownsNative(key), initial)) {
        updateSessionState(sessionId, deps.env, state => ({ ...state, codex_native_turn: {
          key, turn_id: turnId, transcript_path: native.file,
        } }))
      }
    } catch { /* A busy observation lock must not cost this session its attendant. */ }
  }
  if (harness === 'codex') {
    const current = readSessionIncarnation(sessionId, deps.env)
    if (input.recovery !== undefined && (current === null || !ownsNative(current.key))) {
      return end('ignored', { reason: 'recovery-owner-changed' })
    }
    if (current !== null) observeNative(current.key)
  }
  // Interrupt is a bounded observation, never a replacement attendant.
  if (envelope.hook_event_name === 'Interrupt') return end('recorded')
  if (!starting) {
    // Re-arm fast path, before any configuration or gate work: this runs on
    // every prompt and every turn end, and almost always finds its owner.
    const current = readSessionIncarnation(sessionId, deps.env)
    const holder = readClaimFile(claimFile)
    if (
      current !== null &&
      current.harness_process?.pid === (seams.harnessProcess?.pid ?? pid) &&
      holder?.['incarnation'] === current.incarnation &&
      claimHolderMayRun(holder)
    ) {
      // An authenticated native event can hand the resident writer over to
      // installed code. The old owner exits through claim-lost, not SessionEnd.
      const upgrade = harness === 'codex' && ownsNative(current.key) &&
        runningVersion !== null && (holder['runtime_version'] !== runningVersion ||
          holder['runtime_revision'] !== attendantRuntimeRevision) && holder['pid'] !== process.pid &&
        (seams.gates ?? (() => attendantGates(deps, cwd, sessionId, harness, runningVersion)))().ok &&
        (holder['handoff'] === true || (typeof holder['token'] === 'string' &&
          requestClaimHandoff(claimFile, holder['token'], current.incarnation)))
      if (!upgrade) return end('owner-present', { same_incarnation: true, holder_alive: true })
      logger.info('attendant.state', { reason: 'installed-runtime-changed', phase: 'handoff' })
    }
  }

  const assessGates = seams.gates ?? (() => attendantGates(deps, cwd, sessionId, harness!, runningVersion))
  const gates = () => {
    const result = assessGates()
    if (!result.ok && !['project-disabled', 'enablement-unavailable'].includes(result.reason)) {
      // Preserve evidence before the missing contract withdraws this observer.
      // An explicit loss invalidates a recent healthy cache immediately.
      integrationFaultNotice({ ...deps, cwd }, harness, false, true)
    }
    return result
  }
  try {
    const config = loadConfig({ cwd, env: deps.env, sessionId })
    logger.adopt(logSettingsFrom(config))
    logger.bind({ project: config.project.value })
  } catch {
    // The gate below reports enablement it cannot read.
  }
  const gate = gates()
  if (!gate.ok) return end('ignored', { reason: gate.reason })

  // Codex runs a hook through `$SHELL -lc`. bash and zsh exec the adapter, so
  // its parent is Codex; a shell that does not would be named instead and
  // outlive a crashed Codex. Only the Codex executable itself is proof.
  if (seams.harnessProcess === undefined && harness === 'codex' && processExecutableName(pid) !== 'codex') {
    return end('ignored', { reason: 'harness-process-not-codex' })
  }
  const harnessProcess =
    seams.harnessProcess ?? (() => {
      const start = processStartTime(pid)
      return start === null ? null : { pid, start }
    })()
  if (harnessProcess === null) return end('ignored', { reason: 'harness-process-unproven' })

  const openclawGeneration = harness === 'openclaw'
    ? readOpenclawGeneration(sessionId, deps.env)
    : null
  if (harness === 'openclaw' && (openclawGeneration === null ||
      openclawGeneration.ended || !openclawGeneration.activated ||
      readSessionIncarnation(sessionId, deps.env)?.openclaw_generation !== openclawGeneration.id)) {
    return end('ignored', { reason: 'stale-openclaw-generation' })
  }

  const clock = seams.clock ?? systemAttendantClock
  let record = input.recovery !== undefined ? readSessionIncarnation(sessionId, deps.env) : await withLockRetry(clock, () =>
    beginSessionIncarnation(sessionId, deps.env, {
      stamp: input.invokedAt,
      harnessProcess,
      clearEarlierEnd: starting,
      ...(openclawGeneration === null ? {} : { openclawGeneration: openclawGeneration.id }),
    }),
  )
  if (record === null || (input.recovery !== undefined && !ownsNative(record.key))) return end('ignored', { reason: 'recovery-owner-changed' })
  if (harness === 'codex' && starting) observeNative(record.key, true)

  // One live attendant per session. A holder serving an older incarnation of
  // this session (an in-process resume moments after a clear) steps aside
  // within one probe; a holder serving this one is healthy, so this exits.
  const waitUntil = clock.monotonic() + (seams.supersededOwnerWaitMs ?? SUPERSEDED_OWNER_WAIT_MS)
  let token: string | null = null
  while (true) {
    token = acquireClaimFile(claimFile, { incarnation: record.incarnation, runtime_version: runningVersion, runtime_revision: attendantRuntimeRevision }, clock.wall())
    if (token !== null) break
    const holder = readClaimFile(claimFile)
    if ((holder?.['incarnation'] === record.incarnation && holder['handoff'] !== true) || clock.monotonic() >= waitUntil) {
      return end('owner-present', {
        same_incarnation: holder?.['incarnation'] === record.incarnation,
        holder_alive: claimHolderMayRun(holder),
      })
    }
    await clock.sleep(250, new AbortController().signal).catch(() => undefined)
    if (input.recovery !== undefined && !ownsNative(record.key)) return end('ignored', { reason: 'recovery-owner-changed' })
    record = readSessionIncarnation(sessionId, deps.env) ?? record
  }

  logger.info(input.recovery === undefined ? 'hook.end' : 'attendant.state', {
    hook: 'attend',
    outcome: 'attending',
    decided: false,
    source: input.recovery === undefined ? envelope.source ?? envelope.hook_event_name ?? null : 'update-resume',
  })

  const served = record
  const codexActivity = harness === 'codex'
    ? codexInputObserver(sessionId, deps.env, served.key, clock.monotonic, input.recovery?.transcriptPath ?? envelope.transcript_path)
    : null
  const probeAdapters = seams.probeAdapters ?? systemClaudeProbeAdapters(deps.env)
  // SessionEnd names the incarnation it ended; an end of any other one,
  // earlier or later, is not this attendant's.
  const endedByHook = (): boolean => endsIncarnation(readSessionEndMarker(sessionId, deps.env), served)
  const probe =
    harness === 'codex'
      ? codexAttendanceProbe({
          harness: harnessProcess,
          endedByHook,
          activity: () => {
            // Presence remains live through a read gap. The binary service
            // activity is last-observed; scheduling reads afresh.
            const activity = codexActivity!.observe()
            if (activity === 'unknown') logger.debug('attendant.state', { activity: 'cached', reason: 'native-activity-unreadable' })
            return observedCodexTurnActivity(sessionId, deps.env, served.key)
          },
          adapters: probeAdapters,
        })
      : harness === 'openclaw'
        ? openclawAttendanceProbe({
            sessionKey: sessionId,
            generationId: served.openclaw_generation ?? '',
            gateway: harnessProcess,
            env: deps.env,
            endedByHook,
            activity: openclawBridgeActivity,
          })
        : claudeAttendanceProbe({ sessionId, harness: harnessProcess, endedByHook, adapters: probeAdapters })

  let client: ApiClient | null | undefined
  const connect = (): ApiClient | null => {
    if (client !== undefined) return client
    const credential = deps.store.load()
    client = credential
      ? makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
      : null
    return client
  }
  const codexWakeNeeded = codexActivity?.mayWake ?? null
  // An idle Claude session presents an inbox message at once, so a wake it
  // accepted and still has not shown after this long idle is not coming.
  let idleSince: number | null = null
  const settledIdle = (): boolean => idleSince !== null && clock.monotonic() - idleSince >= IDLE_BEFORE_WAKE_REPLACEMENT_MS
  const messages = sessionMessageWriter({
    deps,
    harness: harness!,
    sessionId,
    cwd: envelope.cwd ?? cwd,
    harnessPid: harnessProcess.pid,
    writer: seams.writer === undefined ? currentProcessIdentity() : seams.writer,
    clock,
    logger,
    mayWake: codexWakeNeeded ?? (() => true),
    settledIdle,
    unknownAllowed: codexActivity?.unknownAllowed ?? (() => false),
  })
  let wakeCleanup: Promise<void> | null = null
  const signals = seams.signalled === undefined ? terminationSignal() : null
  try {
    const result = await runSessionAttendant({
      sessionId,
      incarnation: record.incarnation,
      incarnationNow: () => readSessionIncarnation(sessionId, deps.env)?.incarnation ?? null,
      rotateIncarnation: (expected) => {
        const next = rotateSessionIncarnation(sessionId, deps.env, expected)
        if (next === null) return null
        // Keep the claim naming the incarnation it serves.
        releaseClaimFile(claimFile, token!)
        token = acquireClaimFile(claimFile, { incarnation: next.incarnation, runtime_version: runningVersion, runtime_revision: attendantRuntimeRevision }, clock.wall())
        return token === null ? null : next.incarnation
      },
      probe,
      // A claim that vanished or changed hands fences this attendant: another
      // may already serve the same incarnation.
      claimHeld: () => token !== null && readClaimFile(claimFile)?.['token'] === token,
      notified: () => sessionNotified(sessionId, deps.env),
      gates,
      client: connect,
      serverSupportsAttendance: async (api) =>
        (await api.compatibility()).server_capabilities.includes('session_attendance'),
      // The service accepts notes for this session only while an attendant
      // that can hand them in place says so.
      acceptsMessages: messages !== null,
      ...(harness === 'claude-code' && messages !== null ? {
        localInputPending: () => {
          const state = readSessionState(sessionId, deps.env)
          return (!state.input_wake?.queued || (settledIdle() && inputWakeOverdue(state, clock.wall()))) &&
            hasSessionInputs(sessionId, deps.env, null)
        },
      } : {}),
      ...(codexWakeNeeded === null ? {} : {
        localInputPending: () => !readSessionState(sessionId, deps.env).input_wake?.queued &&
          hasSessionInputs(sessionId, deps.env, readAttendantLease(sessionId, deps.env)) && codexWakeNeeded(),
      }),
      ...(messages === null
        ? {}
        : {
            onMessages: async (batch, attendant) => {
              const api = connect()
              return api === null ? 'done' : messages(api, batch, attendant)
            },
          }),
      clock,
      logger,
      writeStatus: (status) => writeAttendantStatus(sessionId, deps.env, status),
      onProbe: (observed) => {
        if (observed.state === 'running' && observed.activity === 'idle') idleSince ??= clock.monotonic()
        else idleSince = null
        if (harness === 'codex' && wakeCleanup === null) {
          wakeCleanup = reconcileSessionInputWakes(sessionId, deps.env, deps.codexQueueControl)
            .catch(() => undefined).finally(() => { wakeCleanup = null })
        }
        // Observe locally without consuming the agent's next context notice.
        // This catches removal of the very hook that would report the fault.
        const notice = integrationFaultNotice({ ...deps, cwd: envelope.cwd ?? cwd, now: () => clock.wall() }, harness, false)
        if (notice !== undefined) logger.info('attendant.state', { integration: 'needs-attention' })
      },
      heartbeat: () => {
        refreshSessionMarkers(sessionId, deps.env, clock.wall(), [
          claimFile,
          attendantStatusPath(sessionId, deps.env),
          turnActivityPath(sessionId, deps.env),
        ])
      },
      signalled: seams.signalled ?? signals!.promise,
      ...(seams.probeIntervalMs === undefined ? {} : { probeIntervalMs: seams.probeIntervalMs }),
      ...(seams.waitSeconds === undefined ? {} : { waitSeconds: seams.waitSeconds }),
    })
    seams.onExit?.(result)
  } finally {
    signals?.dispose()
    if (token !== null) releaseClaimFile(claimFile, token)
  }
  return EXIT.ok
}

type SessionMessageWriter = (
  client: ApiClient,
  batch: AttendanceMessage[],
  attendant: AttendantHandle,
) => Promise<MessageHandOffResult>

/** Idle time after which an accepted but unshown Claude wake is treated as lost. */
const IDLE_BEFORE_WAKE_REPLACEMENT_MS = 30_000

/**
 * The attendant's Session Message writer, or null when this session cannot
 * take a message in place: for Claude Code no inbox socket (`--bare`, an older
 * Claude Code, an unsupported protocol), for Codex no thread id, and for
 * either no provable writer identity. Null keeps the attendant presence-only,
 * and the service accepts no notes for the session.
 */
function sessionMessageWriter(input: {
  deps: CommandDeps
  harness: HookHarness
  sessionId: string
  cwd: string
  harnessPid: number
  writer: ProcessIdentity | null
  clock: AttendantClock
  logger: Logger
  mayWake: () => boolean
  /** Whether the session has been idle long enough to have shown an accepted wake. */
  settledIdle: () => boolean
  unknownAllowed: () => boolean
}): SessionMessageWriter | null {
  const { deps, sessionId, harnessPid, writer, clock, logger } = input
  if (writer === null) return null
  const sequencerFor = (client: ApiClient): SequencerDeps => ({
    sessionId,
    env: deps.env,
    client,
    monotonic: () => clock.monotonic(),
    wall: () => clock.wall(),
    sleep: (milliseconds) => clock.sleep(milliseconds, new AbortController().signal),
    writer,
    log: logger,
  })
  if (input.harness === 'codex') return codexMessageWriter({ deps, sessionId, cwd: input.cwd, logger, mayWake: input.mayWake, unknownAllowed: input.unknownAllowed })
  if (input.harness === 'openclaw') {
    if (!openclawMessageBridgeAvailable(deps.env)) return null
    const generation = readOpenclawGeneration(sessionId, deps.env)
    if (generation === null || generation.ended) return null
    const send = openclawMessageBridge()
    return (client, batch, attendant) =>
      handOffSessionMessages(batch, attendant, {
        sequencer: sequencerFor(client),
        openclawGeneration: generation.id,
        write: (text, begin, guard, _writerGroup, message) => {
          return send(message.message_id, sessionId, generation.id, text, begin, guard)
        },
      })
  }
  if (input.harness !== 'claude-code') return null
  const adapters: ClaudeWakeAdapters = deps.claudeWake ?? systemClaudeWakeAdapters(deps.env)
  const inbox = inspectClaudeInbox({
    pid: harnessPid,
    platform: deps.hookPlatform ?? process.platform,
    readDescriptor: adapters.readDescriptor,
    socketExists: existsSync,
  })
  if (inbox.state !== 'ready') {
    logger.info('attendant.state', { messages: 'unavailable', reason: inbox.reason })
    return null
  }
  return async (_client, batch, attendant) => {
    const generation = attendant.generation()
    if (generation === null || !attendant.mayWrite()) return 'retry-soon'
    stageSessionMessages(sessionId, deps.env, { incarnation: attendant.incarnation(), generation }, batch)
    if (!hasSessionInputs(sessionId, deps.env, { incarnation: attendant.incarnation(), generation })) return 'done'
    await wakeSessionInputs(sessionId, deps.env, async (text) => {
      const result = await deliverIntoClaudeSession({
        sessionId, sourcePid: harnessPid,
        sourceDescriptor: claudeSourceDescriptor(sessionId, harnessPid, adapters),
        adapters, text, begin: () => attendant.mayWrite(), holdAfterSend: false, writer: 'Session Attendant',
      })
      return result.status === 'written'
    }, logger, { unique: true, replaceLost: input.settledIdle, now: () => clock.wall() })
    return 'done'
  }
}

/** Stage pending input for foreground consumption and coalesce its native wake. */
function codexMessageWriter(input: {
  deps: CommandDeps
  sessionId: string
  cwd: string
  logger: Logger
  mayWake: () => boolean
  unknownAllowed: () => boolean
}): SessionMessageWriter | null {
  const { deps, sessionId, cwd, logger, mayWake } = input
  const queue = inspectCodexQueue(sessionId, deps.env)
  if (queue.state !== 'ready') {
    logger.info('attendant.state', { messages: 'unavailable', reason: queue.reason })
    return null
  }
  const adapters: CodexWakeAdapters = deps.codexWake ?? systemCodexWakeAdapters(deps.env)
  if (adapters.available?.() === false) {
    // A queue writer that cannot start would leave every note unconfirmed.
    logger.info('attendant.state', { messages: 'unavailable', reason: 'codex-executable-not-found' })
    return null
  }
  return async (_client, batch, attendant) => {
    const incarnation = readSessionIncarnation(sessionId, deps.env)
    const generation = attendant.generation()
    if (incarnation === null || generation === null || !attendant.mayWrite()) return 'retry-soon'
    stageSessionMessages(sessionId, deps.env, { incarnation: attendant.incarnation(), generation }, batch)
    if (await wakeCodexSessionInputs({ sessionId, env: deps.env,
      lease: { incarnation: attendant.incarnation(), generation },
      mayWrite: () => attendant.mayWrite(), mayWake,
      unknownAllowed: input.unknownAllowed,
      ...(deps.codexQueueControl === undefined ? {} : { connect: deps.codexQueueControl }),
    })) return 'done'
    if (!hasSessionInputs(sessionId, deps.env, { incarnation: attendant.incarnation(), generation })) return 'done'
    if (!mayWake()) return 'done'
    // The resident observes completion even when no further tool runs. Recheck
    // eligibility and pending input immediately before queue admission; a hook
    // may have consumed the batch since the last attendance exchange.
    await wakeSessionInputs(sessionId, deps.env, async (text) => {
      if (!attendant.mayWrite() || !mayWake() ||
          !hasSessionInputs(sessionId, deps.env, { incarnation: attendant.incarnation(), generation })) return false
      const result = await deliverIntoCodexThread({
        threadId: queue.threadId, cwd, env: deps.env, adapters, text,
        begin: () => attendant.mayWrite() && mayWake() &&
          hasSessionInputs(sessionId, deps.env, { incarnation: attendant.incarnation(), generation }),
      })
      return result.status === 'written'
    }, logger)
    return 'done'
  }
}

/** Record the Codex turn this turn end or interrupt closes. */
function recordCodexTurnEnd(envelope: HookEnvelope, sessionId: string, env: NodeJS.ProcessEnv): void {
  const turnId = envelope.turn_id
  const event = envelope.hook_event_name
  if (typeof turnId !== 'string' || turnId === '' || (event !== 'Stop' && event !== 'Interrupt')) return
  try {
    recordTurnEnd(sessionId, env, turnId)
  } catch {
    // Activity is a hint; a busy lock never costs the session its attendant.
  }
}

/**
 * Record the Codex turn this prompt starts. Called from the synchronous
 * UserPromptSubmit hook: Codex runs it before the turn and one turn at a time,
 * which is what orders recorded starts. Never throws.
 */
export function recordCodexTurnStart(envelope: HookEnvelope, env: NodeJS.ProcessEnv): void {
  const sessionId = envelope.session_id
  const turnId = envelope.turn_id
  if (sessionId === undefined || typeof turnId !== 'string' || turnId === '') return
  try {
    const current = readSessionIncarnation(sessionId, env)
    if (current !== null) recordTurnStart(sessionId, env, current.key, turnId)
  } catch {
    // Activity is a hint; it never delays or fails the User's prompt.
  }
}

/**
 * Re-checked before every exchange: the User-owned Project Enablement, and
 * the installed CLI/hook contract. Hooks removed or replaced by a build that
 * does not attend, or an installed CLI older than this attendant, withdraw it.
 */
export function attendantGates(
  deps: CommandDeps,
  cwd: string,
  sessionId: string,
  harness: HookHarness,
  runningVersion: string | null,
): GateResult {
  try {
    const config = loadConfig({ cwd, env: deps.env, sessionId })
    if (!projectEnabled(projectBinding(cwd, deps.env, config.project.value))) {
      return { ok: false, reason: 'project-disabled' }
    }
  } catch {
    return { ok: false, reason: 'enablement-unavailable' }
  }
  // The handler that started this attendant lives in the Machine layer, or in
  // a Project layer an older build wrote; either keeps the contract in place.
  const attendInstalled = [
    ...findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform),
    ...findLegacyProjectInstallations(cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform),
  ]
    .filter((installation) => installation.harness === harness)
    .some((installation) => harness === 'openclaw'
      ? (installation.problems ?? []).length === 0
      : installation.handlers.some((handler) => handlerEvent(handler.command) === 'attend'))
  if (!attendInstalled) return { ok: false, reason: 'attend-handler-removed' }
  // Fail closed: an installed contract this attendant cannot establish is not
  // one it may keep attending under.
  const installed = installedCliVersion(inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform).target)
  if (runningVersion === null || installed === null) return { ok: false, reason: 'cli-contract-unknown' }
  const order = compareVersions(installed, runningVersion)
  if (order === 'unparseable') return { ok: false, reason: 'cli-contract-unknown' }
  if (order === 'before') return { ok: false, reason: 'cli-downgraded' }
  return { ok: true }
}

function installedCliVersion(target: HookAdapterTarget | null): string | null {
  if (target === null) return null
  if (isNpxAdapterTarget(target)) {
    // Installers pin npx targets to an exact version: `@raidiant/notifai@1.2.3`.
    const prefix = `${CLI_PACKAGE_NAME}@`
    return target.spec.startsWith(prefix) ? target.spec.slice(prefix.length) : null
  }
  try {
    const manifest = path.join(path.dirname(realpathSync(target.scriptPath)), '..', 'package.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * The session-state lock is shared with the synchronous activation handler
 * running beside this one. This handler is asynchronous and nobody waits on
 * it, so it outlasts a busy moment instead of giving the session up.
 */
async function withLockRetry<T>(clock: AttendantClock, action: () => T): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action()
    } catch (err) {
      if (attempt >= 8 || !(err instanceof Error) || !err.message.startsWith('timed out waiting for file lock')) {
        throw err
      }
      await clock.sleep(250 * attempt, new AbortController().signal)
    }
  }
}

function declaredHookSourcePid(env: NodeJS.ProcessEnv): number | undefined {
  const value = Number(env['NOTIFAI_HOOK_SOURCE_PID'])
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Terminal close reaches the attendant as SIGTERM with no SessionEnd; treat
 * any termination signal as "ending, report once".
 */
function terminationSignal(): { promise: Promise<void>; dispose(): void } {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT']
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  const onSignal = (): void => resolve()
  for (const signal of signals) process.on(signal, onSignal)
  return {
    promise,
    dispose: () => {
      for (const signal of signals) process.off(signal, onSignal)
    },
  }
}

/**
 * Codex's SessionEnd reports the attended session `ended`.
 *
 * On Codex the attendant cannot: Codex SIGKILLs every unfinished async hook's
 * process group the moment SessionEnd returns, before the attendant's next
 * probe could see the end marker, and may kill it before SessionEnd starts.
 * SessionEnd therefore ends the saved lease of the current incarnation, even
 * without a living attendant. Its exact incarnation and generation let the
 * service fence it as it would the attendant's own report. Without saved
 * fencing identity there is nothing safe to end; a failed report leaves the
 * lease to lapse, and presence reads out of reach.
 */
export async function reportCodexSessionEnded(
  deps: CommandDeps,
  sessionId: string,
  lease: DeliveryLease | null,
): Promise<'no-lease' | 'not-paired' | 'reported' | 'failed'> {
  if (lease === null) return 'no-lease'
  const credential = deps.store.load()
  if (!credential) return 'not-paired'
  const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`, {
    timeoutMs: CODEX_SESSION_END_REPORT_MS,
  })
  const bound = new AbortController()
  const timer = setTimeout(() => bound.abort(), CODEX_SESSION_END_REPORT_MS)
  try {
    await client.attend(
      sessionId,
      { incarnation: lease.incarnation, generation: lease.generation, state: 'ended' },
      { waitSeconds: 0, signal: bound.signal },
    )
    return 'reported'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}
