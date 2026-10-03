/** Fail-open CLI adapter from harness input to hook lifecycle handlers. */
import { agentUpdateNotice } from './agent-update-notice.js'
import { integrationFaultNotice } from './integration-health.js'
import { claudeWakeRoute } from './claude-wake.js'
import { ApiCallError } from './client.js'
import { codexWakeRoute } from './codex-wake.js'
import { deliverCodexToolMessage } from './codex-tool-messages.js'
import {
  EXIT,
  SETUP_COMMAND,
  diagnoseIgnoredOriginOverride,
  log,
  makeClient,
  rejectedPaths,
  updateCliCommand,
  type CommandDeps,
} from './commands-core.js'
import { claudeSessionPid } from './commands-harness-context.js'
import { attendHook, recordCodexTurnStart, reportCodexSessionEnded } from './commands-hook-attend.js'
import { waitForReply } from './commands-send-support.js'
import { loadConfig, type CliConfig } from './config.js'
import { withFileLock } from './file-lock.js'
import { questionRoutingCapability, type HookInstallableHarness } from './harnesses.js'
import { HOOK_EVENTS } from './hook-events.js'
import {
  handleSessionEnd,
  handleStop,
  handleUserPromptSubmit,
  parseHookInput,
  submitSessionQuestions,
} from './hook-lifecycle.js'
import {
  claimCursorStopActivation,
  confirmCursorStopActivation,
  lifecycleStamp,
  pruneAbandonedSessions,
  readSessionIncarnation,
  readSessionState,
  updateSessionState,
  recordSessionStart,
  resetCursorStopActivation,
  sessionHasEnded,
  sessionStatePath,
} from './hook-session-state.js'
import {
  type EscalationDeliveryRoute,
  type HookContext,
  type HookHarness,
  type HookOutcome,
} from './hook-types.js'
import { codexStopDefinitionFingerprint, findInstallations } from './install-hooks.js'
import { logConfigResolved, logSettingsFrom } from './logging.js'
import {
  observeOpenclawPrompt,
  observeOpenclawStart,
  openclawGenerationLockPath,
  readOpenclawGeneration,
  writeOpenclawGeneration,
} from './openclaw-generation.js'
import { projectBinding, projectEnabled } from './project-enablement.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import { QUESTION_WAITER_CEILING_SECONDS } from './question-timing.js'
import { cursorStopActivationOutput, sessionActivationOutput, userPromptContextOutput } from './session-activation.js'
import { currentProcessIdentity } from './process-identity.js'
import { attendantSupport } from './session-attendant-probe.js'
import { readAttendantEndingLease, readAttendantLease } from './session-attendant-state.js'
import { openclawContinuationRoute } from './openclaw-continuation-bridge.js'
import { listPendingOpenclawSessions } from './openclaw-pending.js'
import { readDeliveryJournal } from './session-delivery.js'
import { sessionInputRoute, stageSessionAnswers, observeSessionInputWake, sessionInputWake } from './session-inputs.js'
import { receiveSessionInputs } from './commands-receive.js'
const INTERNAL_HOOK_EVENTS = [
  'question-submission', 'question-settlement', 'openclaw-lifecycle', 'openclaw-generation',
  'openclaw-turn-start', 'openclaw-turn-end', 'openclaw-list-pending',
  'openclaw-attendance-ready', 'openclaw-settlement',
  'openclaw-verify-prepared',
] as const

/** Keep diagnostic context in the same document as an answer or Session Note. */
function appendIntegrationContext(output: string | undefined, notice: string | undefined,
  harness: HookHarness | undefined, event: 'UserPromptSubmit' | 'PostToolUse'): string {
  if (notice === undefined) return output ?? ''
  if (harness === 'opencode' || harness === 'openclaw') return [output, notice].filter(Boolean).join('\n\n')
  if (output === undefined) {
    return event === 'UserPromptSubmit' ? userPromptContextOutput(harness, notice) ?? ''
      : JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: notice } })
  }
  try {
    const value = JSON.parse(output)
    if (harness === 'cursor') value.additional_context = [value.additional_context, notice].filter(Boolean).join('\n\n')
    else {
      value.hookSpecificOutput ??= { hookEventName: event }
      value.hookSpecificOutput.additionalContext = [value.hookSpecificOutput.additionalContext, notice].filter(Boolean).join('\n\n')
    }
    return JSON.stringify(value)
  } catch { return output }
}

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
  // Taken before stdin is read: an end the harness recorded before this
  // invocation began belongs to an earlier incarnation of the session.
  const invokedAt = lifecycleStamp(now())
  // One owner lifetime covers startup and the longest answer window. Native
  // observers run detached; held Stop routes keep stdout. The delivery mechanism does not
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
  // Grok loads Claude settings by default. Its native Notifai definition is
  // the sole owner; the inherited Claude copy must stop before reading stdin.
  if (harness === 'claude-code' && (deps.env['GROK_HOOK_EVENT'] ?? '') !== '') {
    start({ outcome: 'grok-compatibility-copy-skipped' })
    logger.info('hook.end', {
      hook: event,
      outcome: 'ignored',
      reason: 'grok-native-handler-owns-event',
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
  // Codex subagents share the root session_id and harness process, while
  // turn_id belongs to the child. They must never own the root's lifecycle
  // or consume its input. SubagentStart only teaches worker ownership and
  // deliberately does not activate or update the parent session.
  if (harness === 'codex' && event !== 'subagent-start' &&
      (envelope.agent_id !== undefined || envelope.agent_type !== undefined)) {
    start({ outcome: 'codex-child-callback-skipped' })
    logger.info('hook.end', {
      hook: event, outcome: 'ignored', reason: 'codex-subagent-owns-event', decided: false,
    })
    return EXIT.ok
  }
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
  if (harness === 'grok') {
    envelope = {
      ...envelope,
      ...(envelope.stop_hook_active === undefined && envelope.stopHookActive !== undefined
        ? { stop_hook_active: envelope.stopHookActive }
        : {}),
    }
  }

  const cwd = envelope.cwd ?? deps.cwd
  if (event === 'openclaw-lifecycle') {
    logger.bind({ session: envelope.session_id ?? null })
    start({ cwd, event: envelope.hook_event_name ?? null })
    if (harness !== 'openclaw' || envelope.session_id === undefined) return EXIT.ok
    try {
      const sessionKey = envelope.session_id
      const outcome = withFileLock(openclawGenerationLockPath(sessionKey, deps.env), () => {
        const current = readOpenclawGeneration(sessionKey, deps.env)
        if (envelope.hook_event_name === 'SessionStart') {
          const next = observeOpenclawStart(
            current, envelope.openclaw_session_id, envelope.openclaw_resumed_from,
          )
          if (envelope.openclaw_session_id !== undefined &&
              next.sessionId !== envelope.openclaw_session_id) return 'stale-start-ignored'
          writeOpenclawGeneration(sessionKey, deps.env, next)
          return 'start-observed'
        }
        if (envelope.hook_event_name === 'BeforeReset' && current !== null && !current.ended) {
          // OpenClaw dispatches before_reset after committing its new entry and
          // does not await the hook. A late old reset must not end a generation
          // already observed from the replacement entry's native revision.
          if (current.lifecycleRevision !== undefined &&
              (typeof envelope.openclaw_lifecycle_revision !== 'string' ||
                envelope.openclaw_lifecycle_revision === current.lifecycleRevision ||
                current.supersededLifecycleRevisions?.includes(envelope.openclaw_lifecycle_revision))) {
            return 'stale-reset-ignored'
          }
          if (
            envelope.openclaw_session_id !== undefined && current.sessionId !== undefined &&
            envelope.openclaw_session_id !== current.sessionId
          ) return 'stale-reset-ignored'
          if (current.activated) handleSessionEnd(deps.env, envelope, now())
          writeOpenclawGeneration(sessionKey, deps.env, {
            ...current, ended: true, resetPending: true,
          })
          return 'reset-observed'
        }
        return 'ignored'
      })
      logger.info('hook.end', { hook: event, outcome, decided: false })
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'failed', ...failureData(err) })
    }
    return EXIT.ok
  }
  if (event === 'attend') {
    logger.bind({ session: envelope.session_id ?? null })
    start({ cwd, event: envelope.hook_event_name ?? null, source: envelope.source ?? null })
    try {
      return await attendHook(deps, { envelope, harness, cwd, invokedAt, logger })
    } catch (err) {
      // A resident process that throws must still hand the harness exit 0.
      logger.error('hook.end', { hook: event, outcome: 'failed', ...failureData(err) })
      return EXIT.ok
    }
  }
  const launchSettlement = (): Record<string, unknown> => {
    const sessionId = envelope.session_id
    if (sessionId === undefined || harness === undefined) return {}
    try {
      const launched = withFileLock(`${sessionStatePath(sessionId, deps.env)}.lock`, () => {
        if (sessionHasEnded(sessionId, deps.env)) return false
        const current = readSessionState(sessionId, deps.env)
        if ((current.pending?.length ?? 0) === 0 && current.accepted === undefined) return false
        const spawnSettlement = deps.spawnQuestionSettlement ?? spawnQuestionSettlement
        spawnSettlement({
          envelope: { session_id: sessionId, cwd }, harness,
        })
        return true
      })
      return { settlement: launched ? 'launched' : 'cancelled' }
    } catch (err) {
      return { settlement: 'launch-failed', settlement_error: failureData(err) }
    }
  }
  const sessionEnd = hookDefersDiagnosticsUntilAfterCleanup(event)
  // Codex may kill the attendant before this hook starts. Capture its saved
  // fencing identity before cleanup or another start can replace local state.
  const codexEndingLease =
    sessionEnd && harness === 'codex' && envelope.session_id !== undefined
      ? readAttendantEndingLease(envelope.session_id, deps.env)
      : null
  logger.bind({ session: envelope.session_id ?? null })
  const lifecycleEnabled = (): boolean => {
    try {
      const activationConfig = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
      logger.bind({ project: activationConfig.project.value })
      return projectEnabled(projectBinding(cwd, deps.env, activationConfig.project.value))
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'enablement-unavailable', ...failureData(err) })
      return false
    }
  }
  const currentOpenclawOwner = (): string | null => {
    if (harness !== 'openclaw' || envelope.session_id === undefined || !lifecycleEnabled()) return null
    const current = readOpenclawGeneration(envelope.session_id, deps.env)
    const incarnation = readSessionIncarnation(envelope.session_id, deps.env)
    return current !== null && current.activated && !current.ended &&
      incarnation?.openclaw_generation === current.id &&
      !sessionHasEnded(envelope.session_id, deps.env) &&
      (envelope.openclaw_lifecycle_revision === undefined ||
        current.lifecycleRevision === envelope.openclaw_lifecycle_revision) &&
      (envelope.openclaw_session_id === undefined || current.sessionId === envelope.openclaw_session_id)
      ? current.id : null
  }
  if (event === 'post-tool-use') {
    start({ cwd })
    try {
      if (harness === 'codex' && lifecycleEnabled()) {
        const notice = integrationFaultNotice({ ...deps, cwd }, harness)
        let wrote = false
        const io = { ...deps.io, out: (line: string) => {
          wrote = true
          deps.io.out(appendIntegrationContext(line, notice, harness, 'PostToolUse'))
        } }
        await deliverCodexToolMessage({ ...deps, io }, envelope, logger)
        if (!wrote && notice !== undefined) deps.io.out(appendIntegrationContext(undefined, notice, harness, 'PostToolUse'))
      }
      logger.info('hook.end', { hook: event, outcome: 'checked', decided: false })
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'ignored', ...failureData(err) })
    }
    return EXIT.ok
  }
  if (event === 'openclaw-generation') {
    start({ cwd })
    const generation = currentOpenclawOwner()
    if (generation !== null) deps.io.out(generation)
    return EXIT.ok
  }
  if (event === 'openclaw-turn-start') {
    start({ cwd })
    const generation = currentOpenclawOwner()
    if (generation !== null && envelope.session_id !== undefined) {
      updateSessionState(envelope.session_id, deps.env, (state) => ({
        ...state, last_prompt_at: now(),
      }))
    }
    return EXIT.ok
  }
  if (event === 'openclaw-turn-end') {
    start({ cwd })
    const generation = currentOpenclawOwner()
    if (generation !== null && envelope.session_id !== undefined) {
      updateSessionState(envelope.session_id, deps.env, (state) => ({
        ...state, last_stop_at: now(),
      }))
    }
    return EXIT.ok
  }
  if (event === 'openclaw-list-pending') {
    start({ cwd })
    if (harness === 'openclaw') deps.io.out(JSON.stringify(listPendingOpenclawSessions(deps.env)))
    return EXIT.ok
  }
  if (event === 'openclaw-attendance-ready') {
    start({ cwd })
    if (currentOpenclawOwner() !== null && envelope.session_id !== undefined &&
        readAttendantLease(envelope.session_id, deps.env) !== null &&
        (() => {
          try {
            const config = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
            return projectEnabled(projectBinding(cwd, deps.env, config.project.value))
          } catch { return false }
        })()) deps.io.out('ready')
    return EXIT.ok
  }
  if (event === 'openclaw-verify-prepared') {
    start({ cwd })
    const ids = envelope.openclaw_request_ids
    if (currentOpenclawOwner() !== null && envelope.session_id !== undefined &&
        Array.isArray(ids) && ids.length > 0 &&
        ids.every((id) => typeof id === 'string' && /^req_[A-Za-z0-9_-]+$/.test(id))) {
      const entries = readDeliveryJournal(envelope.session_id, deps.env)
      if (ids.every((id) => entries.some((entry) =>
        entry.subject.type === 'answer' && entry.subject.request_id === id &&
        (entry.stage === 'writing' || entry.stage === 'written' || entry.stage === 'failed')))) {
        deps.io.out('committed')
      }
    }
    return EXIT.ok
  }
  if (event === 'openclaw-settlement' && currentOpenclawOwner() === null) return EXIT.ok
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
    const updateNotice = event === 'session-start' &&
      ['claude-code', 'codex', 'opencode', 'openclaw'].includes(harness ?? '')
      ? await agentUpdateNotice({ env: deps.env, now: now(), updateCommand: updateCliCommand(deps),
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) })
      : undefined
    const faultNotice = event === 'session-start' && harness !== undefined && harness !== 'grok'
      ? integrationFaultNotice({ ...deps, cwd }, harness) : undefined
    const notice = [updateNotice, faultNotice].filter(part => part !== undefined).join('\n\n') || undefined
    if (harness === 'openclaw' && envelope.session_id !== undefined) {
      try {
        const sessionKey = envelope.session_id
        const outcome = withFileLock(openclawGenerationLockPath(sessionKey, deps.env), () => {
          const current = readOpenclawGeneration(sessionKey, deps.env)
          if (envelope.openclaw_lifecycle_revision !== undefined &&
              current?.supersededLifecycleRevisions?.includes(envelope.openclaw_lifecycle_revision)) {
            return 'stale-prompt-ignored'
          }
          const generation = observeOpenclawPrompt(
            current, envelope.openclaw_session_id,
            envelope.openclaw_lifecycle_revision,
          )
          if (envelope.openclaw_session_id !== undefined &&
              generation.sessionId !== envelope.openclaw_session_id) return 'stale-prompt-ignored'
          writeOpenclawGeneration(sessionKey, deps.env, generation)
          if (generation.activated) return 'already-activated'
          const previous = readSessionIncarnation(sessionKey, deps.env)
          if (previous !== null && previous.openclaw_generation !== generation.id) {
            // A new sessionId or resumed generation is authoritative even if
            // its old session_end was dropped or delayed.
            handleSessionEnd(deps.env, envelope, now())
          }
          const output = sessionActivationOutput(
            harness, event === 'session-start' ? 'SessionStart' : 'SubagentStart',
            cwd, deps.env, notice,
          )
          if (output === undefined || output.trim().length === 0) return 'activation-unavailable'
          recordSessionStart(
            sessionKey, deps.env, harness, cwd, undefined, lifecycleStamp(now()), generation.id,
          )
          writeOpenclawGeneration(sessionKey, deps.env, { ...generation, activated: true })
          deps.io.out(output)
          return 'context-added'
        })
        logger.info('hook.end', { hook: event, outcome, decided: false })
      } catch (err) {
        logger.error('hook.end', {
          hook: event, outcome: 'record-failed', reason: 'session-state-failed', ...failureData(err),
        })
      }
      return EXIT.ok
    }
    const stdout = sessionActivationOutput(
      harness,
      event === 'session-start' ? 'SessionStart' : 'SubagentStart',
      cwd,
      deps.env,
      notice,
    )
    if (stdout !== undefined) deps.io.out(stdout)
    let settlementRecovery: Record<string, unknown> = {}
    if (event === 'session-start' && envelope.session_id !== undefined) {
      try {
        const stopFingerprint = harness === 'codex'
          ? codexStopDefinitionFingerprint(
              findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform),
            )
          : undefined
        recordSessionStart(envelope.session_id, deps.env, harness, cwd, stopFingerprint, invokedAt)
        if (harness === 'codex') {
          // Pending state is the durable handoff debt if the prior process
          // died after queue commit but before starting its successor.
          settlementRecovery = launchSettlement()
        }
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
      outcome: stdout === undefined
        ? harness === 'grok' ? 'activation-context-unsupported' : 'unsupported-harness'
        : 'context-added',
      decided: false,
      ...settlementRecovery,
    })
    return EXIT.ok
  }

  // A Codex turn starts here. This prompt hook is synchronous, so Codex runs it
  // before the turn and one turn at a time: the Session Attendant reads the
  // thread's activity from starts recorded in that order.
  if (event === 'user-prompt-submit' && harness === 'codex') recordCodexTurnStart(envelope, deps.env)

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
    if (claimed) {
      const updateNotice = await agentUpdateNotice({ env: deps.env, now: now(), updateCommand: updateCliCommand(deps),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) })
      const notice = [updateNotice, integrationFaultNotice({ ...deps, cwd }, 'cursor')].filter(Boolean).join('\n\n') || undefined
      deps.io.out(cursorStopActivationOutput(cwd, deps.env, notice))
    }
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
      const outcome = harness === 'openclaw' && envelope.session_id !== undefined
        ? withFileLock(openclawGenerationLockPath(envelope.session_id, deps.env), (): HookOutcome => {
            const sessionKey = envelope.session_id!
            const current = readOpenclawGeneration(sessionKey, deps.env)
            const reason = envelope.openclaw_reason
            if (reason === 'new' || reason === 'reset') {
              // These can arrive after a same-ID replacement. before_reset
              // owns cleanup; an end event alone cannot identify the old ID.
              return { notes: [], log: { outcome: 'ignored', reason: 'reset-end' } }
            }
            if (current === null || current.ended ||
              (envelope.openclaw_session_id !== undefined && current.sessionId !== undefined &&
                envelope.openclaw_session_id !== current.sessionId)) {
              return { notes: [], log: { outcome: 'ignored', reason: 'stale-openclaw-generation' } }
            }
            const ended = current.activated
              ? handleSessionEnd(deps.env, envelope, now())
              : { notes: [], log: { outcome: 'ignored', reason: 'inactive-openclaw-generation' } }
            writeOpenclawGeneration(sessionKey, deps.env, { ...current, ended: true })
            return ended
          })
        : handleSessionEnd(deps.env, envelope, now())
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
      if (harness === 'codex' && envelope.session_id !== undefined) {
        // Codex kills the attendant as soon as this hook returns.
        const reported = await reportCodexSessionEnded(deps, envelope.session_id, codexEndingLease)
        logger.info('attendant.lease', { event: 'ended-by-session-end', outcome: reported })
      }
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
      service_identity: { base_url: credential.baseUrl, machine_id: credential.machineId },
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
      ...answerClaimsFor(deps, harness, envelope.session_id, event),
    }

    if (event === 'question-submission') {
      const notes: string[] = []
      const sessionId = envelope.session_id
      if (sessionId === undefined || harness === undefined ||
          readSessionState(sessionId, deps.env).harness !== harness || !lifecycleEnabled()) return EXIT.ok
      await submitSessionQuestions(ctx, envelope, processDeadlineAt, notes)
      // Native queues can observe answers while the asking turn keeps working.
      // Held Stop and plugin routes retain their own genuine output owner.
      const nativeObserver = harness === 'codex' ||
        (harness === 'claude-code' && (deps.hookPlatform ?? process.platform) !== 'win32')
      logger.info('hook.end', { hook: event, outcome: 'submission-checked', notes,
        ...(nativeObserver ? launchSettlement() : {}) })
      return EXIT.ok
    }

    // Real clock, deliberately, not `deps.now`. This compares against file
    // mtimes, which are wall-clock facts — handing it a virtual or skewed clock
    // would have it delete live session state as "abandoned".
    // Daily state pruning is housekeeping, not part of the Stop delivery
    // contract. Its directory scan has no useful bound, so keep it on the
    // short prompt path and never spend the answer owner's finite budget on it.
    if (event !== 'stop' && event !== 'question-settlement' && event !== 'openclaw-settlement') {
      pruneAbandonedSessions(deps.env)
    }

    let outcome: HookOutcome
    if (event === 'user-prompt-submit') {
      if (envelope.session_id !== undefined) observeSessionInputWake(envelope.session_id, deps.env, envelope.prompt)
      const notice = lifecycleEnabled() && harness !== undefined && harness !== 'grok'
        ? integrationFaultNotice({ ...deps, cwd }, harness) : undefined
      outcome = envelope.session_id !== undefined && envelope.prompt === sessionInputWake()
        ? { notes: [], log: { stage: 'input-wake-observed' } }
        : await handleUserPromptSubmit(ctx, envelope)
      if (notice !== undefined) outcome.stdout = appendIntegrationContext(outcome.stdout, notice, harness, 'UserPromptSubmit')
    } else {
      outcome = await handleStop(
        ctx,
        envelope,
        processDeadlineAt,
        event === 'openclaw-settlement' && envelope.session_id !== undefined
          ? openclawContinuationRoute(envelope.session_id, currentOpenclawOwner()!)
          : stopWakeRoute(deps, harness, envelope.session_id, cwd, event !== 'stop'),
        // The Gateway settlement process is not an agent turn boundary. Only
        // agent_end records Stop; a background poll must not spend the three
        // acknowledgement reminders or abandon a Session Message debt.
        event === 'stop',
      )
    }
    if (
      outcome.settlementRequired === true && harness !== undefined && harness !== 'openclaw' &&
      questionRoutingCapability(harness, deps.hookPlatform ?? process.platform)
        .stopContinuation !== 'unsupported'
    ) {
      // handleStop released its question-owner lease before returning here.
      outcome.log = { ...outcome.log, ...launchSettlement() }
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
    let inputWritten = false
    if (event === 'user-prompt-submit' && (harness === 'codex' || harness === 'claude-code') &&
        envelope.session_id !== undefined && outcome.commitStdout === undefined &&
        readSessionIncarnation(envelope.session_id, deps.env)?.harness_process?.pid === declaredHookSourcePid(deps)) {
      inputWritten = await receiveSessionInputs(deps, envelope.session_id, (text) => {
        deps.io.out(appendIntegrationContext(outcome.stdout, text, harness, 'UserPromptSubmit'))
      })
      if (inputWritten) await outcome.afterOutput?.()
    }
    if (!inputWritten && outcome.stdout !== undefined) {
      // No work, await, or diagnostic may sit between this cross-process
      // SessionEnd fence and the irreversible harness stdout write.
      if (outcome.commitStdout === undefined || outcome.commitStdout()) {
        deps.io.out(outcome.stdout)
        try {
          await outcome.afterOutput?.()
        } catch {
          // Recording what the hand-off proved never fails the hook.
        }
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
 * Claude's adapter needs the harness process that invoked this hook, to prove
 * exact own-child session ownership before it posts to the inbox socket. Codex's
 * needs only the thread id: queueing is a write to that thread's own durable
 * inbox, which no other process can be confused for. Without an exact session id
 * neither can prove anything, so the waiter falls back to the plain Stop
 * continuation.
 */
function stopWakeRoute(
  deps: CommandDeps,
  harness: HookInstallableHarness | undefined,
  sessionId: string | undefined,
  cwd: string,
  background: boolean,
): EscalationDeliveryRoute | undefined {
  if (harness === 'grok') return undefined
  if (sessionId === undefined) return undefined
  const declaredSourcePid = declaredHookSourcePid(deps)
  if (harness === 'claude-code') {
    if ((deps.hookPlatform ?? process.platform) === 'win32') return undefined
    const route = sessionInputRoute(sessionId, deps.env, claudeWakeRoute({
      sessionId,
      cwd,
      sourcePid: deps.claudeSourcePid ?? declaredSourcePid ?? claudeSessionPid(deps.env),
      ...(deps.claudeWake === undefined ? {} : { adapters: deps.claudeWake }),
    }), log(deps))
    // A detached subprocess can be reparented after ask exits. Only the
    // resident Session Attendant retains Claude's required own-child ancestry.
    // Its ordinary attendance exchange wakes staged inputs, even with no notes.
    return background ? { ...route, defer: async (accepted) => {
      stageSessionAnswers(sessionId, deps.env, accepted)
    } } : route
  }
  if (harness === 'codex') {
    return sessionInputRoute(sessionId, deps.env, codexWakeRoute({
      threadId: sessionId,
      cwd,
      env: deps.env,
      ...(deps.codexWake === undefined ? {} : { adapters: deps.codexWake }),
    }), log(deps), 'attendant')
  }
  return undefined
}

/**
 * The Stop waiter claims fenced answers only where a Session Attendant can
 * hold the session's lease and the answer is written in place: Claude Code on
 * macOS and Linux. Everywhere else it closes and writes exactly as before.
 */
function answerClaimsFor(
  deps: CommandDeps,
  harness: HookInstallableHarness | undefined,
  sessionId: string | undefined,
  event: string,
): Pick<HookContext, 'answerClaims'> {
  if (sessionId === undefined ||
      (event !== 'stop' && event !== 'question-settlement' && event !== 'openclaw-settlement')) return {}
  if (!attendantSupport(harness, deps.hookPlatform ?? process.platform).supported) return {}
  const writer = deps.answerWriter === undefined ? currentProcessIdentity() : deps.answerWriter
  if (writer === null) return {}
  return {
    answerClaims: {
      lease: () => readAttendantLease(sessionId, deps.env),
      writer,
      monotonic: () => performance.now(),
    },
  }
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
