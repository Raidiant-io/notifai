/**
 * `notifai hook attend`: the asynchronous handler that becomes an Agent
 * Session's Session Attendant, or exits within milliseconds when a healthy
 * attendant for this exact session incarnation already runs.
 *
 * Installed on SessionStart next to the short activation handler (which it
 * never delays: the harness does not wait for an async handler), and on
 * UserPromptSubmit and Stop to re-arm a session whose attendant died.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EXIT, makeClient, type CommandDeps } from './commands-core.js'
import { claudeSessionPid } from './commands-harness-context.js'
import { loadConfig } from './config.js'
import type { ApiClient } from './client.js'
import { inspectHookAdapter, isNpxAdapterTarget, type HookAdapterTarget } from './hook-adapter.js'
import { acquireClaimFile, claimHolderMayRun, readClaimFile, releaseClaimFile } from './hook-question-lock.js'
import {
  beginSessionIncarnation,
  endsIncarnation,
  readSessionEndMarker,
  type LifecycleStamp,
  readSessionIncarnation,
  refreshSessionMarkers,
  rotateSessionIncarnation,
  sessionNotified,
} from './hook-session-state.js'
import type { HookEnvelope, HookHarness } from './hook-types.js'
import { findInstallations, findLegacyProjectInstallations, handlerEvent } from './install-hooks.js'
import { logSettingsFrom, type Logger } from './logging.js'
import { processStartTime, type ProcessIdentity } from './process-identity.js'
import { projectBinding, projectEnabled } from './project-enablement.js'
import { packageVersion } from './release.js'
import {
  runSessionAttendant,
  systemAttendantClock,
  type AttendantClock,
  type AttendantResult,
  type GateResult,
} from './session-attendant.js'
import {
  attendantSupport,
  claudeAttendanceProbe,
  systemClaudeProbeAdapters,
  type ClaudeProbeAdapters,
} from './session-attendant-probe.js'
import { attendantClaimPath, attendantStatusPath, writeAttendantStatus } from './session-attendant-state.js'
import { CLI_PACKAGE_NAME } from './cli-contract.js'
import { compareVersions } from './version.js'

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
}

const SUPERSEDED_OWNER_WAIT_MS = 6_000

export async function attendHook(
  deps: CommandDeps,
  input: {
    envelope: HookEnvelope
    harness: HookHarness | undefined
    cwd: string
    invokedAt: LifecycleStamp
    logger: Logger
  },
): Promise<number> {
  const { envelope, harness, cwd, logger } = input
  const seams = deps.attendant ?? {}
  const end = (outcome: string, data: Record<string, unknown> = {}): number => {
    logger.info('hook.end', { hook: 'attend', outcome, decided: false, ...data })
    return EXIT.ok
  }
  // Read once, now: an in-place reinstall replaces the manifest on disk, and
  // rereading it later would compare the installed files with themselves.
  const runningVersion = deps.runningVersion === undefined ? packageVersion() : deps.runningVersion
  const sessionId = envelope.session_id
  if (sessionId === undefined) return end('ignored', { reason: 'missing-session-id' })
  const support = attendantSupport(harness, deps.hookPlatform ?? process.platform)
  if (!support.supported) return end('unsupported', { reason: support.reason })

  const starting = envelope.hook_event_name === 'SessionStart' || envelope.source !== undefined
  const claimFile = attendantClaimPath(sessionId, deps.env)
  const pid = declaredHookSourcePid(deps.env) ?? claudeSessionPid(deps.env)
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
      return end('owner-present', { same_incarnation: true, holder_alive: true })
    }
  }

  const gates = seams.gates ?? (() => attendantGates(deps, cwd, sessionId, harness!, runningVersion))
  try {
    const config = loadConfig({ cwd, env: deps.env, sessionId })
    logger.adopt(logSettingsFrom(config))
    logger.bind({ project: config.project.value })
  } catch {
    // The gate below reports enablement it cannot read.
  }
  const gate = gates()
  if (!gate.ok) return end('ignored', { reason: gate.reason })

  const harnessProcess =
    seams.harnessProcess ?? (() => {
      const start = processStartTime(pid)
      return start === null ? null : { pid, start }
    })()
  if (harnessProcess === null) return end('ignored', { reason: 'harness-process-unproven' })

  const clock = seams.clock ?? systemAttendantClock
  let record = await withLockRetry(clock, () =>
    beginSessionIncarnation(sessionId, deps.env, {
      stamp: input.invokedAt,
      harnessProcess,
      clearEarlierEnd: starting,
    }),
  )

  // One live attendant per session. A holder serving an older incarnation of
  // this session (an in-process resume moments after a clear) steps aside
  // within one probe; a holder serving this one is healthy, so this exits.
  const waitUntil = clock.monotonic() + (seams.supersededOwnerWaitMs ?? SUPERSEDED_OWNER_WAIT_MS)
  let token: string | null = null
  while (true) {
    token = acquireClaimFile(claimFile, { incarnation: record.incarnation }, clock.wall())
    if (token !== null) break
    const holder = readClaimFile(claimFile)
    if (holder?.['incarnation'] === record.incarnation || clock.monotonic() >= waitUntil) {
      return end('owner-present', {
        same_incarnation: holder?.['incarnation'] === record.incarnation,
        holder_alive: claimHolderMayRun(holder),
      })
    }
    await clock.sleep(250, new AbortController().signal).catch(() => undefined)
    record = readSessionIncarnation(sessionId, deps.env) ?? record
  }

  logger.info('hook.end', {
    hook: 'attend',
    outcome: 'attending',
    decided: false,
    source: envelope.source ?? envelope.hook_event_name ?? null,
  })

  const served = record
  const probeAdapters = seams.probeAdapters ?? systemClaudeProbeAdapters(deps.env)
  const probe = claudeAttendanceProbe({
    sessionId,
    harness: harnessProcess,
    // SessionEnd names the incarnation it ended; an end of any other one,
    // earlier or later, is not this attendant's.
    endedByHook: () => endsIncarnation(readSessionEndMarker(sessionId, deps.env), served),
    adapters: probeAdapters,
  })

  let client: ApiClient | null | undefined
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
        token = acquireClaimFile(claimFile, { incarnation: next.incarnation }, clock.wall())
        return token === null ? null : next.incarnation
      },
      probe,
      // A claim that vanished or changed hands fences this attendant: another
      // may already serve the same incarnation.
      claimHeld: () => token !== null && readClaimFile(claimFile)?.['token'] === token,
      notified: () => sessionNotified(sessionId, deps.env),
      gates,
      client: () => {
        if (client !== undefined) return client
        const credential = deps.store.load()
        client = credential
          ? makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
          : null
        return client
      },
      serverSupportsAttendance: async (api) =>
        (await api.compatibility()).server_capabilities.includes('session_attendance'),
      // Session Messages need the delivery sequencer; until it ships, this
      // attendant reports presence only and the service accepts no notes.
      acceptsMessages: false,
      clock,
      logger,
      writeStatus: (status) => writeAttendantStatus(sessionId, deps.env, status),
      heartbeat: () =>
        refreshSessionMarkers(sessionId, deps.env, clock.wall(), [
          claimFile,
          attendantStatusPath(sessionId, deps.env),
        ]),
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
    .some((installation) => installation.handlers.some((handler) => handlerEvent(handler.command) === 'attend'))
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
    const manifest = path.join(path.dirname(target.scriptPath), '..', 'package.json')
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
