/** Fail-open CLI adapter from harness input to hook lifecycle handlers. */
import { claudeWakeRoute } from './claude-wake.js'
import { ApiCallError } from './client.js'
import { codexWakeRoute } from './codex-wake.js'
import {
  EXIT,
  SETUP_COMMAND,
  diagnoseIgnoredOriginOverride,
  log,
  makeClient,
  rejectedPaths,
  type CommandDeps,
} from './commands-core.js'
import { claudeSessionPid } from './commands-harness-context.js'
import { waitForReply } from './commands-send-support.js'
import { loadConfig, type CliConfig } from './config.js'
import { questionRoutingCapability, type HookInstallableHarness } from './harnesses.js'
import { HOOK_EVENTS } from './hook-events.js'
import {
  handleSessionEnd,
  handleStop,
  handleUserPromptSubmit,
  parseHookInput,
} from './hook-lifecycle.js'
import {
  claimCursorStopActivation,
  confirmCursorStopActivation,
  pruneAbandonedSessions,
  readSessionState,
  recordSessionStart,
  resetCursorStopActivation,
} from './hook-session-state.js'
import {
  type EscalationDeliveryRoute,
  type HookContext,
  type HookHarness,
  type HookOutcome,
} from './hook-types.js'
import { codexStopDefinitionFingerprint, findInstallations } from './install-hooks.js'
import { logConfigResolved, logSettingsFrom } from './logging.js'
import { projectBinding, projectEnabled } from './project-enablement.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import { QUESTION_WAITER_CEILING_SECONDS } from './question-timing.js'
import { cursorStopActivationOutput, sessionActivationOutput } from './session-activation.js'
const INTERNAL_HOOK_EVENTS = ['question-settlement'] as const

/** SessionEnd cleanup must precede every diagnostic that can wait on a file lock. */
export function hookDefersDiagnosticsUntilAfterCleanup(
  event: unknown,
): event is 'session-end' {
  return event === 'session-end'
}

/**
 * Runs one harness hook. Contract with every harness: hook JSON arrives on
 * stdin, harness output (if any) goes to stdout, diagnostics go to stderr, and
 * exit 0 with no stdout means "no decision or added context — carry on as normal".
 *
 * Every failure path in here must reach that no-decision state. A hook that
 * throws, or that blocks past the harness's timeout, degrades the agent for a
 * feature the user only asked to make it more convenient.
 */
export async function hookRunCommand(
  deps: CommandDeps,
  event: string,
  readStdin: () => Promise<string>,
  harness?: HookHarness,
): Promise<number> {
  if (
    !(HOOK_EVENTS as readonly string[]).includes(event) &&
    !(INTERNAL_HOOK_EVENTS as readonly string[]).includes(event)
  ) {
    deps.io.err(`Unknown hook event "${event}". Valid: ${HOOK_EVENTS.join(', ')}`)
    return EXIT.usage
  }

  // One clock owns the complete Stop invocation, including stdin, config,
  // credentials, and client construction. Starting this inside `handleStop`
  // would grant slow setup a second budget and let the harness kill us before
  // an accepted answer is journaled or written to stdout.
  const now = deps.now ?? Date.now
  // One owner lifetime covers startup and the longest answer window. Claude
  // runs it detached; Codex holds the turn. The delivery mechanism does not
  // change how long the exact Agent Session remains reachable.
  const processDeadlineAt = now() + QUESTION_WAITER_CEILING_SECONDS * 1000

  const logger = log(deps)
  logger.bind({ cmd: `hook ${event}` })
  let started = false
  const start = (data: Record<string, unknown> = {}): void => {
    if (started) return
    started = true
    logger.info('hook.start', { hook: event, harness: harness ?? 'unknown', ...data })
  }
  const failureData = (err: unknown): Record<string, unknown> =>
    err instanceof ApiCallError
      ? { status: err.status, code: err.code, message: err.message, details: err.details }
      : { message: err instanceof Error ? err.message : String(err) }

  // Cursor may load ~/.claude/settings.json in addition to its own native
  // hooks. Cursor guarantees CURSOR_PROJECT_DIR to hook processes, so a Claude
  // compatibility copy becomes a no-op and the native Cursor definition is
  // the single owner. Real Claude hooks do not receive that hook-only marker.
  if (harness === 'claude-code' && deps.env['CURSOR_PROJECT_DIR']) {
    start({ outcome: 'cursor-compatibility-copy-skipped' })
    logger.info('hook.end', {
      hook: event,
      outcome: 'ignored',
      reason: 'cursor-native-handler-owns-event',
      decided: false,
    })
    return EXIT.ok
  }

  let raw: string
  try {
    raw = await readStdin()
  } catch (err) {
    start({ input: 'unavailable' })
    logger.error('hook.end', {
      hook: event,
      outcome: 'ignored',
      reason: 'input-read-failed',
      ...failureData(err),
    })
    return EXIT.ok
  }

  if (raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    } catch {
      start({ input: 'malformed' })
      logger.error('hook.end', { hook: event, outcome: 'ignored', reason: 'malformed-input' })
      deps.io.err('notifai: ignored malformed or truncated hook input; no routing action was taken')
      return EXIT.ok
    }
  }

  let envelope = parseHookInput(raw)
  if (harness === 'cursor') {
    const sessionId = envelope.session_id ?? envelope.conversation_id
    const cwd = envelope.cwd ?? envelope.workspace_roots?.[0]
    envelope = {
      ...envelope,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(cwd === undefined ? {} : { cwd }),
      stop_hook_active:
        envelope.stop_hook_active ??
        (typeof envelope.loop_count === 'number' && envelope.loop_count > 0),
    }
  }

  const cwd = envelope.cwd ?? deps.cwd
  const sessionEnd = hookDefersDiagnosticsUntilAfterCleanup(event)
  logger.bind({ session: envelope.session_id ?? null })
  const lifecycleEnabled = (): boolean => {
    try {
      const activationConfig = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
      return projectEnabled(projectBinding(cwd, deps.env, activationConfig.project.value))
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'enablement-unavailable', ...failureData(err) })
      return false
    }
  }
  // Installation only makes lifecycle hooks available. Model-visible
  // activation is a separate User-owned Project decision, checked anew on
  // every run so disabling takes effect without reinstalling anything.
  if (event === 'session-start' || event === 'subagent-start') {
    start({ cwd, source: envelope.source ?? null })
    if (!lifecycleEnabled()) {
      logger.info('hook.end', {
        hook: event,
        outcome: 'ignored',
        reason: 'project-disabled',
        decided: false,
      })
      return EXIT.ok
    }
    if (event === 'session-start' && harness === 'cursor' && envelope.session_id !== undefined) {
      try {
        resetCursorStopActivation(envelope.session_id, deps.env)
      } catch (err) {
        logger.error('hook.end', {
          hook: event,
          outcome: 'reset-failed',
          ...failureData(err),
        })
      }
    }
    const stdout = sessionActivationOutput(
      harness,
      event === 'session-start' ? 'SessionStart' : 'SubagentStart',
      cwd,
      deps.env,
    )
    if (stdout !== undefined) deps.io.out(stdout)
    if (event === 'session-start' && envelope.session_id !== undefined) {
      try {
        const stopFingerprint = harness === 'codex'
          ? codexStopDefinitionFingerprint(
              findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform),
            )
          : undefined
        recordSessionStart(envelope.session_id, deps.env, harness, cwd, stopFingerprint)
      } catch (err) {
        logger.error('hook.end', {
          hook: event,
          outcome: 'record-failed',
          reason: 'session-state-failed',
          ...failureData(err),
        })
      }
    }
    logger.info('hook.end', {
      hook: event,
      outcome: stdout === undefined ? 'unsupported-harness' : 'context-added',
      decided: false,
    })
    return EXIT.ok
  }

  // Cursor has a confirmed host bug in which sessionStart.additional_context
  // is accepted but never reaches the model. A native Stop follow-up is the
  // host's guaranteed model-visible channel. Claim it once per conversation,
  // before config/auth/network, and leave the ordinary Stop handler separate
  // so question delivery is never displaced by activation.
  if (event === 'activation-stop') {
    start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
    if (harness !== 'cursor') {
      logger.info('hook.end', { hook: event, outcome: 'unsupported-harness', decided: false })
      return EXIT.ok
    }
    if (!lifecycleEnabled()) {
      logger.info('hook.end', {
        hook: event,
        outcome: 'ignored',
        reason: 'project-disabled',
        decided: false,
      })
      return EXIT.ok
    }
    if (envelope.status === 'aborted') {
      logger.info('hook.end', {
        hook: event,
        outcome: 'ignored',
        reason: `turn-${envelope.status}`,
        decided: false,
      })
      return EXIT.ok
    }
    if (envelope.session_id === undefined) {
      logger.info('hook.end', {
        hook: event,
        outcome: 'ignored',
        reason: 'missing-conversation-id',
        decided: false,
      })
      return EXIT.ok
    }
    if (
      envelope.session_id !== undefined &&
      typeof envelope.loop_count === 'number' &&
      envelope.loop_count > 0
    ) {
      let activationOwned = false
      try {
        activationOwned = confirmCursorStopActivation(envelope.session_id, deps.env, now())
      } catch (err) {
        logger.error('hook.end', {
          hook: event,
          outcome: 'confirm-failed',
          ...failureData(err),
        })
      }
      if (activationOwned) {
        logger.info('hook.end', { hook: event, outcome: 'confirmed', decided: false })
        return EXIT.ok
      }
    }
    const cursorState = readSessionState(envelope.session_id, deps.env)
    if (
      (cursorState.pending?.length ?? 0) > 0 ||
        cursorState.accepted !== undefined ||
        (cursorState.acknowledgement_due?.length ?? 0) > 0
    ) {
      logger.info('hook.end', {
        hook: event,
        outcome: 'deferred',
        reason: 'question-continuation-owns-stop',
        decided: false,
      })
      return EXIT.ok
    }
    let claimed = false
    try {
      claimed = claimCursorStopActivation(envelope.session_id, deps.env, now())
    } catch (err) {
      logger.error('hook.end', {
        hook: event,
        outcome: 'claim-failed',
        ...failureData(err),
      })
    }
    logger.info('hook.end', {
      hook: event,
      outcome: claimed ? 'followup-added' : 'already-activated',
      decided: claimed,
    })
    if (claimed) deps.io.out(cursorStopActivationOutput(cwd, deps.env))
    return EXIT.ok
  }

  let config: CliConfig | null = null
  let configFailure: unknown
  try {
    config = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
    // The hook's project is the session's, not this process's, and the log
    // settings that apply are that project's too. Keeping a mutable bootstrap
    // logger lets this more-specific layer turn logging back on.
    logger.adopt(logSettingsFrom(config))
    logger.bind({ project: config.project.value })
    if (!sessionEnd) {
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      logConfigResolved(logger, config)
    }
  } catch (err) {
    configFailure = err
    if (!sessionEnd) {
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      logger.error('hook.end', {
        hook: event,
        outcome: 'failed',
        reason: 'config-failed',
        ...failureData(err),
      })
      for (const line of describeHookFailure(err)) deps.io.err(`notifai: ${line}`)
      return EXIT.ok
    }
  }

  // Everything below is inside one fail-open boundary. Credential loading,
  // client construction and hook handling can all throw, and a hook that exits
  // non-zero makes the harness report a failure — strictly worse than skipping.
  try {
    if (sessionEnd) {
      // Codex gives SessionEnd one second total. Do every durable cleanup write
      // before lifecycle diagnostics: the log lock is deliberately allowed to
      // wait that long, and a busy log must never preserve ended-session state
      // or its inherited configuration. The resolved config above is retained
      // in memory so logging still uses the ending session's settings afterwards.
      const outcome = handleSessionEnd(deps.env, envelope, (deps.now ?? Date.now)())
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      if (config !== null) logConfigResolved(logger, config)
      const data = { hook: event, decided: false, ...outcome.log }
      if (configFailure === undefined) logger.info('hook.end', data)
      else {
        logger.error('hook.end', {
          ...data,
          reason: 'config-failed',
          config_error: failureData(configFailure),
        })
      }
      for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
      return EXIT.ok
    }

    // Non-SessionEnd hooks cannot reach here without resolved configuration.
    const resolved = config!
    const credential = deps.store.load()
    if (!credential) {
      logger.error('hook.end', { hook: event, outcome: 'not-paired' })
      deps.io.err(`notifai: hook skipped: this machine is not paired; run \`${SETUP_COMMAND}\``)
      return EXIT.ok
    }
    // Pin authenticated traffic to the origin the credential was issued for. A
    // repository can commit `.notifai/config.toml`, and honouring a base_url
    // from it would hand this machine's bearer token to whatever host it names.
    const baseUrl = credential.baseUrl
    diagnoseIgnoredOriginOverride(deps.io, resolved, credential)
    // UserPromptSubmit runs in front of the user's own prompt under a 15s
    // harness ceiling and can make two calls, so each gets a small slice of it;
    // Stop is allowed to block and keeps the ordinary budget.
    const client = makeClient(
      deps,
      baseUrl,
      `Bearer nfm_${credential.machineId}.${credential.secret}`,
      {
        timeoutMs: event === 'user-prompt-submit' ? 4_000 : 20_000,
        ...(event === 'stop' || event === 'question-settlement'
          ? { deadlineAt: processDeadlineAt, now }
          : {}),
      },
    )
    const ctx: HookContext = {
      client,
      config: resolved,
      env: deps.env,
      now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      waitForFirstReply: async (requestId, timeoutSeconds) => {
        const result = await waitForReply(client, requestId, {
          timeoutSeconds,
          afterSeq: 0,
          now: deps.now,
          sleep: deps.sleep,
        })
        return {
          replies: result.response.replies,
          timedOut: result.timedOut,
          degraded: result.degraded,
        }
      },
      log: logger,
      ...(harness === undefined ? {} : { harness }),
    }

    // Real clock, deliberately, not `deps.now`. This compares against file
    // mtimes, which are wall-clock facts — handing it a virtual or skewed clock
    // would have it delete live session state as "abandoned".
    // Daily state pruning is housekeeping, not part of the Stop delivery
    // contract. Its directory scan has no useful bound, so keep it on the
    // short prompt path and never spend the answer owner's finite budget on it.
    if (event !== 'stop' && event !== 'question-settlement') {
      pruneAbandonedSessions(deps.env)
    }

    let outcome: HookOutcome
    if (event === 'user-prompt-submit') {
      outcome = await handleUserPromptSubmit(ctx, envelope)
      if (
        outcome.settlementRequired === true &&
        envelope.session_id !== undefined &&
        harness !== undefined &&
        questionRoutingCapability(harness, deps.hookPlatform ?? process.platform)
          .stopContinuation !== 'unsupported'
      ) {
        try {
          const launchSettlement = deps.spawnQuestionSettlement ?? spawnQuestionSettlement
          launchSettlement({
            envelope: { session_id: envelope.session_id, cwd },
            harness,
          })
          outcome.log = { ...outcome.log, settlement: 'launched' }
        } catch (err) {
          outcome.log = {
            ...outcome.log,
            settlement: 'launch-failed',
            settlement_error: failureData(err),
          }
        }
      }
    } else {
      outcome = await handleStop(
        ctx,
        envelope,
        processDeadlineAt,
        stopWakeRoute(
          deps,
          harness,
          envelope.session_id,
          cwd,
          event === 'stop',
        ),
        event === 'stop',
      )
    }
    // Answer diagnostics are already persisted once as hook.answer. Keep every
    // other note in the lifecycle record without duplicating the user's text.
    const notes = outcome.notes.filter((note) => !/^(?:late )?answer from /.test(note))
    logger.info('hook.end', {
      hook: event,
      decided: outcome.decided ?? outcome.stdout !== undefined,
      ...(notes.length === 0 ? {} : { notes }),
      ...outcome.log,
    })
    for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
    if (outcome.stdout !== undefined) {
      // No work, await, or diagnostic may sit between this cross-process
      // SessionEnd fence and the irreversible harness stdout write.
      if (outcome.commitStdout === undefined || outcome.commitStdout()) {
        deps.io.out(outcome.stdout)
      } else {
        deps.io.err('notifai: the Agent Session ended before answer delivery; no continuation was written')
      }
    }
    return EXIT.ok
  } catch (err) {
    // SessionEnd defers its start record until after cleanup; if cleanup itself
    // fails, begin the after-the-fact lifecycle here before recording why.
    if (sessionEnd) start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
    // The hook still exits 0 — handing the terminal back is always right. What
    // this adds is that the reason survives, including the server's own words.
    logger.error('hook.end', {
      hook: event,
      outcome: 'failed',
      reason: 'execution-failed',
      ...failureData(err),
    })
    for (const line of describeHookFailure(err)) deps.io.err(`notifai: ${line}`)
    return EXIT.ok
  }
}

/**
 * The last meter for an answer this Stop hook accepted, chosen by harness.
 *
 * Both wake adapters need the harness process that invoked this hook: Claude's
 * to prove exact own-child session ownership before it posts to the inbox
 * socket, Codex's to know whether its own stdout is still a live continuation
 * channel. Without an exact session id neither can prove anything, so the
 * waiter falls back to the plain blocking Stop continuation.
 */
function stopWakeRoute(
  deps: CommandDeps,
  harness: HookInstallableHarness | undefined,
  sessionId: string | undefined,
  cwd: string,
  continuationActive = true,
): EscalationDeliveryRoute | undefined {
  if (sessionId === undefined) return undefined
  const declaredSourcePid = declaredHookSourcePid(deps)
  if (harness === 'claude-code') {
    if ((deps.hookPlatform ?? process.platform) === 'win32') return undefined
    return claudeWakeRoute({
      sessionId,
      cwd,
      sourcePid: deps.claudeSourcePid ?? declaredSourcePid ?? claudeSessionPid(deps.env),
      ...(deps.claudeWake === undefined ? {} : { adapters: deps.claudeWake }),
    })
  }
  if (harness === 'codex') {
    return codexWakeRoute({
      threadId: sessionId,
      cwd,
      sourcePid: deps.codexSourcePid ?? declaredSourcePid ?? process.ppid,
      env: deps.env,
      ...(deps.codexWake === undefined ? {} : { adapters: deps.codexWake }),
      continuationActive,
    })
  }
  return undefined
}

/** Stable harness parent propagated by the managed adapter across child tools. */
function declaredHookSourcePid(deps: CommandDeps): number | undefined {
  const value = Number(deps.env['NOTIFAI_HOOK_SOURCE_PID'])
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * What went wrong, in terms of what to do about it.
 *
 * On 2026-08-03 a contract change shipped without the server deploy that goes
 * with it. The CLI stamped `lifecycle` on every question draft, the deployed
 * server rejected the unknown field, and escalation stopped working entirely —
 * announced as "hook failed, deferring to the terminal", which reads like a
 * flaky network. The information needed to diagnose it in one second was
 * already in hand: a 422 whose details name the offending path. It was being
 * thrown away by `String(err)`.
 *
 * A hook still exits 0 whatever this says. Handing the terminal back is always
 * right; the only question is whether the user is told anything they can use.
 */
export function describeHookFailure(err: unknown): string[] {
  if (!(err instanceof ApiCallError)) {
    return [`hook failed, deferring to the terminal (${String(err)})`]
  }
  const lines = [`hook failed, deferring to the terminal (${err.code}: ${err.message})`]
  const paths = rejectedPaths(err.details)
  if (paths.length > 0) lines.push(`the server rejected: ${paths.join(', ')}`)
  // A 422 on a draft this CLI built is not a user error — this CLI's own
  // contract produced it. Either the server is behind, or the two disagree.
  if (err.status === 422) {
    lines.push(
      'this build sent a field the server did not accept, which usually means the server ' +
        'is older than this CLI — check with `notifai doctor`',
    )
  }
  return lines
}
