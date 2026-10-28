import { attendCursorStop } from './cursor-attendant.js'
import { recordOpenclawNativeSession } from './openclaw-native-session.js'
import { stopAnswerOutput } from './hook-acknowledgements.js'
import { observeCodexTerminalAnswers, reportCodexTerminalAnswers, takeCodexTerminalConflictContext } from './codex-terminal-answers.js'
import { observeLoadedIntegration } from './integration-revision.js'
/** Fail-open CLI adapter from harness input to hook lifecycle handlers. */
import { pendingAgentUpdateNotice } from './agent-update-notice.js'
import { claimNow, type PendingNotice } from './pending-notice.js'
import { cachedIntegrationFaultNotice, pendingIntegrationFaultNotice, refreshIntegrationHealth } from './integration-health.js'
import { claudeWakeRoute } from './claude-wake.js'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import { type MachineCredential } from './credentials.js'
import { OWNER_STEP_BUDGETS, hookStepBudgets, hookWorkAllowanceMs } from './hook-budgets.js'
import { claimHookMaintenance, runHookMaintenance } from './hook-maintenance.js'
import { claimOlderHubHandover, handOverOlderHub } from './hub-handover.js'
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
import { claudeHookSourcePid, claudeSessionPid } from './commands-harness-context.js'
import { claudePlaceOf, claudePlaceSignals, placeReceives } from './session-place.js'
import { codexHostKind } from './codex-session-end.js'
import { attendHook, recordCodexTurnStart, reportCodexSessionEnded } from './commands-hook-attend.js'
import { hubSupported } from './hub-ipc.js'
import { holdSessionEnd, hubAttendsSession, notifyHubSessionEnded, shutdownUnderway } from './hub-client.js'
import { awaitEndConfirmation, confirmSessionEnds } from './session-end-confirmation.js'
import { waitForReply } from './commands-send-support.js'
import { loadConfig, type CliConfig } from './config.js'
import { withFileLock } from './file-lock.js'
import { questionRoutingCapability, type HookInstallableHarness } from './harnesses.js'
import { HOOK_EVENTS } from './hook-events.js'
import { claimGrokActivation, grokQuestionRoute, grokHookEnvelope, grokWorker, resetGrokActivation } from './grok-hooks.js'
import {
  drainClosedSessionRetirements,
  handleSessionEnd,
  handleStop,
  handleUserPromptSubmit,
  parseHookInput,
  submitSessionQuestions,
} from './hook-lifecycle.js'
import { cursorHookEnvironment } from './cursor-imported-hook.js'
import { grokHookEnvironment } from './grok-imported-hook.js'
import { drainRetirements } from './hook-question-retirement.js'
import {
  lifecycleStamp,
  readSessionIncarnation,
  readSessionState,
  updateSessionState,
  recordSessionStart,
  sessionHasEnded,
  sessionStatePath,
} from './hook-session-state.js'
import {
  type EscalationDeliveryRoute,
  type HookContext,
  type HookEnvelope,
  type HookHarness,
  type HookOutcome,
} from './hook-types.js'
import { codexHandlerFingerprints, codexStopDefinitionFingerprint, findInstallations } from './install-hooks.js'
import { logConfigResolved, logSettingsFrom } from './logging.js'
import {
  observeOpenclawPrompt,
  observeOpenclawStart,
  openclawGenerationLockPath,
  readOpenclawGeneration,
  writeOpenclawGeneration,
} from './openclaw-generation.js'
import { projectBinding, projectEnabled } from './project-enablement.js'
import { workspaceExclusion } from './workspace-eligibility.js'
import { releaseCodexCardHandbacks } from './codex-card-handback.js'
import { codexCardPostToolUse, codexPreToolUse } from './codex-question-hooks.js'
import { grokQuestionFormGate, unlinkedQuestionFormContext } from './unlinked-question-forms.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import { QUESTION_WAITER_CEILING_SECONDS } from './question-timing.js'
import { rootGuidanceDigest, rootGuidanceDelivery, sessionActivationOutput, userPromptContextOutput } from './session-activation.js'
import { GUIDANCE_NOT_GIVEN, claimGuidanceChange, invalidateGuidanceRead, guidanceSessionKey, recordGuidanceGiven, startingCurrency } from './guidance-currency.js'
import { currentProcessIdentity } from './process-identity.js'
import { attendantSupport } from './session-attendant-probe.js'
import { proveWindowsCodexHookSource } from './windows-hook-source.js'
import { grokAttendHook, startGrokAttendant } from './grok-attendant.js'
import { readAttendantEndingLease, readAttendantLease } from './session-attendant-state.js'
import { openclawContinuationRoute } from './openclaw-continuation-bridge.js'
import { listPendingOpenclawSessions } from './openclaw-pending.js'
import { readDeliveryJournal } from './session-delivery.js'
import {
  hasSessionInputs,
  inputWakeFaultContext,
  markInputWakeFaultReported,
  inputWakeToken,
  isSessionInputWake,
  observeSessionInputWake,
  sessionInputRoute,
  sessionInputWake,
  stageSessionAnswers,
} from './session-inputs.js'
import { receiveSessionInputs } from './commands-receive.js'
import { recordClaudeSessionTitle } from './harness-session-title.js'
import { recordClaudePermissionMode } from './claude-command-approval.js'
import { recordReopenLaunch } from './reopen-terminal.js'
import {
  claudePermissionRequest,
  claudePostToolUse,
  closeClaudePicker,
  reportClaudeTerminalAnswers,
  settleCancelledClaudePicker,
  takeOwedClaudePickerAnswer,
} from './claude-question-hooks.js'
const INTERNAL_HOOK_EVENTS = [
  'question-submission', 'question-settlement', 'openclaw-lifecycle', 'openclaw-generation',
  'openclaw-turn-start', 'openclaw-turn-end', 'openclaw-list-pending',
  'openclaw-native-session', 'openclaw-attendance-ready', 'openclaw-settlement',
  'openclaw-verify-prepared', 'maintenance', 'retirement', 'hub-handover',
  'end-confirmation', 'guidance-check',
] as const

/**
 * The credential is read on the first authenticated call, not at hook start.
 * Most prompt and Stop hooks have nothing to send, so they never start a
 * credential helper. It is a NetworkError so that every caller already treats
 * it as "not now" and keeps local state, exactly as for an unreachable server.
 */
class MachineNotPairedError extends NetworkError {
  constructor() {
    super('this machine is not paired')
  }
}

/** A client whose credential and connection are resolved on its first call. */
function lazyClient(resolve: () => ApiClient): ApiClient {
  return new Proxy({} as ApiClient, {
    get(_target, property) {
      // Never thenable, never inspectable: only API methods resolve.
      if (typeof property !== 'string' || property === 'then') return undefined
      return async (...args: unknown[]) => {
        const client = resolve()
        const method = client[property as keyof ApiClient] as unknown as (...values: unknown[]) => Promise<unknown>
        return method.apply(client, args)
      }
    },
  })
}

/**
 * Harnesses whose prompt-time hook output reaches the model. Cursor's
 * `beforeSubmitPrompt` accepts only `continue` and `user_message`; OpenCode's
 * `chat.message` and OpenClaw's `message_received` discard what the hook
 * prints; Grok's prompt hook is passive. A notice claimed there would be
 * spent unseen, so it stays due for the next activation that is shown.
 */
const PROMPT_CONTEXT_REACHES_MODEL: ReadonlySet<HookHarness> = new Set(['claude-code', 'codex'])

/** Keep diagnostic context in the same document as an answer or Session Note. */
function appendIntegrationContext(output: string | undefined, notice: string | undefined,
  harness: HookHarness | undefined, event: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'): string {
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
  integrationRevision?: string,
): Promise<number> {
  if (
    !(HOOK_EVENTS as readonly string[]).includes(event) &&
    !(INTERNAL_HOOK_EVENTS as readonly string[]).includes(event)
  ) {
    deps.io.err(`Unknown hook event "${event}". Valid: ${HOOK_EVENTS.join(', ')}`)
    return EXIT.usage
  }
  // A Windows Codex hook declares the PowerShell its command starts; every
  // ownership check below compares the Codex process above it.
  if (harness === 'codex' && process.platform === 'win32' && (HOOK_EVENTS as readonly string[]).includes(event)) {
    proveWindowsCodexHookSource(deps.env)
  }

  // One clock owns the complete Stop invocation, including stdin, config,
  // credentials, and client construction. Starting this inside `handleStop`
  // would grant slow setup a second budget and let the harness kill us before
  // an accepted answer is journaled or written to stdout.
  const now = deps.now ?? Date.now
  // Taken before stdin is read: an end the harness recorded before this
  // invocation began belongs to an earlier incarnation of the session.
  const invokedAt = lifecycleStamp(now())
  // Every nested step shares the timeout the generated definition declares.
  const budgets = hookStepBudgets(event, harness)
  const workAllowanceMs = hookWorkAllowanceMs(event, harness)
  // One owner lifetime covers startup and the longest answer window. Native
  // observers run detached; held Stop routes keep stdout. The delivery mechanism does not
  // change how long the exact Agent Session remains reachable. A short hook
  // (UserPromptSubmit, a non-routing Stop) ends inside its own harness timeout.
  const processDeadlineAt = now() + (workAllowanceMs ?? QUESTION_WAITER_CEILING_SECONDS * 1000)

  const logger = log(deps)
  logger.bind({ cmd: `hook ${event}` })
  const failureData = (err: unknown): Record<string, unknown> =>
    err instanceof ApiCallError
      ? { status: err.status, code: err.code, message: err.message, details: err.details }
      : { message: err instanceof Error ? err.message : String(err) }

  // Daily housekeeping, started detached by a prompt-path hook.
  if (event === 'maintenance') {
    logger.info('hook.start', { hook: event, harness: harness ?? 'unknown' })
    try {
      const result = await runHookMaintenance({ env: deps.env, now: now(),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) })
      // An end whose confirmation process died is decided here at the latest.
      const ends = await confirmSessionEnds(deps, { wait: false, logger })
      logger.info('hook.end', { hook: event, outcome: 'maintained', decided: false, ...result, end_confirmations: ends })
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'failed', ...failureData(err) })
    }
    return EXIT.ok
  }
  // SessionEnds no hub decides, waiting out their end confirmation detached.
  if (event === 'end-confirmation') {
    logger.info('hook.start', { hook: event, harness: harness ?? 'unknown' })
    try {
      const result = await confirmSessionEnds(deps, { wait: true, logger })
      logger.info('hook.end', { hook: event, outcome: 'confirmed', decided: false, ...result })
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'failed', ...failureData(err) })
    }
    return EXIT.ok
  }
  // An earlier build's hub beside this active build, started detached by a hook.
  if (event === 'hub-handover') {
    logger.info('hook.start', { hook: event, harness: harness ?? 'unknown' })
    const result = await handOverOlderHub(deps.env, { logger })
    logger.info('hook.end', { hook: event, decided: false, ...result })
    return EXIT.ok
  }
  let started = false
  const start = (data: Record<string, unknown> = {}): void => {
    if (started) return
    started = true
    logger.info('hook.start', { hook: event, harness: harness ?? 'unknown', ...data })
  }

  // Cursor may load ~/.claude/settings.json in addition to its own native
  // hooks, and runs those copies with no Stop loop limit. Cursor's hook-only
  // environment marks them, so a Claude compatibility copy becomes a no-op and
  // the native Cursor definition is the single owner. Real Claude hooks do not
  // receive that environment. The launcher ends these copies earlier on macOS
  // and Linux; this covers every other entry.
  if (harness === 'claude-code' && cursorHookEnvironment(deps.env)) {
    start({ outcome: 'cursor-compatibility-copy-skipped' })
    logger.info('hook.end', {
      hook: event,
      outcome: 'ignored',
      reason: 'cursor-native-handler-owns-event',
      decided: false,
    })
    return EXIT.ok
  }
  // Grok can import other harness settings. Its native Notifai definition is
  // the sole owner; imported copies stop before reading stdin. The launcher
  // and the runtime entry end them earlier; this covers hooks the hub serves.
  if ((harness === 'claude-code' || harness === 'cursor') && grokHookEnvironment(deps.env)) {
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
    const native = grokHookEnvelope(envelope)
    if (native === null || (event === 'stop' && native.reason !== 'end_turn')) {
      start({ outcome: 'ignored' })
      logger.info('hook.end', {
        hook: event, outcome: 'ignored',
        reason: native === null ? 'grok-session-identity-unavailable' : 'grok-stop-cannot-continue',
        decided: false,
      })
      return EXIT.ok
    }
    envelope = native
  }

  const cwd = envelope.cwd ?? deps.cwd
  if (harness === 'codex' && workspaceExclusion(cwd, deps.env) !== null) return EXIT.ok
  const observeIntegration = (): void => {
    if (harness === undefined || envelope.session_id === undefined || envelope.agent_id !== undefined ||
        envelope.agent_type !== undefined || !['session-start', 'user-prompt-submit', 'stop'].includes(event)) return
    try { observeLoadedIntegration(envelope.session_id, harness, integrationRevision, deps.env) }
    catch { /* Observation failure never disrupts existing question delivery. */ }
  }
  // Claude Code reports the User's own session title on these two events. A
  // subagent's callback names the child, never the session.
  if (harness === 'claude-code' && (event === 'session-start' || event === 'user-prompt-submit') &&
      envelope.session_id !== undefined && envelope.agent_id === undefined) {
    try {
      recordClaudeSessionTitle(envelope.session_id, deps.env, envelope.session_title)
    } catch {
      // A title is an enrichment; failing to keep one never fails the hook.
    }
  }
  // The User can switch Claude Code's permission mode mid-session, so every
  // main-session callback that carries it keeps the latest. Readiness offers
  // command approval in every mode but bypassPermissions.
  if (harness === 'claude-code' && envelope.permission_mode !== undefined &&
      envelope.session_id !== undefined && envelope.agent_id === undefined) {
    try {
      recordClaudePermissionMode(envelope.session_id, deps.env, envelope.permission_mode)
    } catch {
      // Only the command-approval offer reads this; it never fails the hook.
    }
  }
  // A conversation a restart stops reopens where it ran, in the mode it last
  // ran in: keep what its start, prompt and turn-end hooks see of both.
  if ((harness === 'claude-code' || harness === 'codex') && (event === 'session-start' || event === 'user-prompt-submit' || event === 'stop') &&
      envelope.session_id !== undefined && envelope.agent_id === undefined) {
    try {
      recordReopenLaunch(envelope.session_id, deps.env, envelope.permission_mode)
    } catch {
      // Only a later reopen reads this; it never fails the hook.
    }
  }
  // The turn moved on, so no picker of this session is still on screen: a
  // handler that was waiting on one stops when it next looks.
  if (harness === 'claude-code' && (event === 'stop' || event === 'user-prompt-submit') &&
      envelope.session_id !== undefined && envelope.agent_id === undefined) {
    try {
      closeClaudePicker(deps, envelope.session_id, logger, cwd)
    } catch {
      // The waiting handler also ends with its picker or its session.
    }
  }
  if (harness === 'codex' && envelope.session_id !== undefined &&
      ['post-tool-use', 'stop', 'interrupt', 'user-prompt-submit'].includes(event)) {
    releaseCodexCardHandbacks(envelope.session_id, deps.env, envelope, event, (deps.now ?? Date.now)())
  }
  if (event === 'permission-request') {
    logger.bind({ session: envelope.session_id ?? null })
    start({ cwd })
    // Claude Code signals this handler when the picker is dismissed.
    let signal!: () => void
    const signalled = new Promise<void>((resolve) => { signal = resolve })
    const onSignal = (): void => signal()
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(name, onSignal)
    try {
      const outcome = harness === 'claude-code'
        ? await claudePermissionRequest(deps, envelope, logger, { signalled })
        : 'not-bound'
      logger.info('hook.end', { hook: event, outcome, decided: outcome === 'answered' || outcome === 'closed' || outcome === 'refused' })
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'ignored', ...failureData(err) })
    } finally {
      for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.removeListener(name, onSignal)
    }
    return EXIT.ok
  }
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
          if (current.recorded) handleSessionEnd(deps.env, envelope, now())
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
      if (harness === 'grok') return await grokAttendHook(deps, envelope, cwd, logger)
      // On macOS and Linux the native launcher runs Claude Code's and Codex's
      // attend handler as the session child and never starts the runtime.
      // The runtime attendant remains for Windows (until verified there),
      // OpenClaw, and source checkouts that have no native launcher.
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
          envelope: { session_id: sessionId, cwd }, harness, sessionLockHeld: true,
          ...(budgets.detachedLaunchMs < OWNER_STEP_BUDGETS.detachedLaunchMs
            ? { detachTimeoutMs: budgets.detachedLaunchMs } : {}),
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
  if (event === 'pre-tool-use') {
    start({ cwd })
    try {
      if (harness === 'grok' && lifecycleEnabled()) {
        const context = claimGrokActivation(envelope, cwd, deps.env, [
          pendingAgentUpdateNotice({ env: deps.env, now: now(), updateCommand: updateCliCommand(deps) }),
          pendingIntegrationFaultNotice({ ...deps, cwd }, 'grok'),
        ].filter((notice): notice is PendingNotice => notice !== undefined))
        // Passive Grok events discard context. Its tool gate can return it
        // before even the first Notification Request has side effects.
        if (context !== undefined) deps.io.out(JSON.stringify({ decision: 'deny',
          reason: `${context}\n\nFollow this context before retrying the tool.` }))
        else grokQuestionFormGate(deps, envelope, cwd)
      }
      if (harness === 'grok' && !lifecycleEnabled()) grokQuestionFormGate(deps, envelope, cwd)
      const changed = harness === 'codex' && lifecycleEnabled() ? guidanceChangeFor(deps, harness, envelope, cwd) : undefined
      let wrote = false
      const io = { ...deps.io, out: (line: string) => {
        wrote = true
        deps.io.out(appendIntegrationContext(line, changed, harness, 'PreToolUse'))
      } }
      if (harness === 'codex') await codexPreToolUse({ ...deps, io }, envelope, logger)
      if (!wrote && changed !== undefined) deps.io.out(appendIntegrationContext(undefined, changed, harness, 'PreToolUse'))
      logger.info('hook.end', { hook: event, outcome: 'checked', decided: false })
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'ignored', ...failureData(err) })
    }
    return EXIT.ok
  }
  // Prune and the update lookup run in one detached process at most daily; a
  // prompt-path hook only checks its stamp.
  const startDueMaintenance = (): void => {
    if (deps.spawnHookMaintenance === undefined) return
    try {
      if (!claimHookMaintenance(deps.env)) return
      deps.spawnHookMaintenance({
        cwd,
        ...(harness === undefined ? {} : { harness }),
        ...(budgets.detachedLaunchMs < OWNER_STEP_BUDGETS.detachedLaunchMs
          ? { detachTimeoutMs: budgets.detachedLaunchMs } : {}),
      })
    } catch (err) {
      logger.error('hook.gate', { stage: 'maintenance', outcome: 'ignored', ...failureData(err) })
    }
  }
  // A hub from an earlier build cannot hand over seamlessly: this active build
  // replaces it, in a detached check, unless it is in the middle of something
  // the next hub cannot take over. One file read when none runs.
  const startDueHubHandover = (): void => {
    if (deps.spawnHubHandover === undefined) return
    try {
      if (!claimOlderHubHandover(deps.env)) return
      deps.spawnHubHandover({
        cwd,
        ...(budgets.detachedLaunchMs < OWNER_STEP_BUDGETS.detachedLaunchMs
          ? { detachTimeoutMs: budgets.detachedLaunchMs } : {}),
      })
    } catch (err) {
      logger.error('hook.gate', { stage: 'hub-handover', outcome: 'ignored', ...failureData(err) })
    }
  }
  // A plugin's turn start (Hermes): guidance that changed since this root
  // session was given it, told once. Nothing else happens on this call.
  if (event === 'guidance-check') {
    start({ cwd })
    let notice: string | undefined
    try {
      if (harness !== undefined && envelope.session_id !== undefined) {
        const enabled = lifecycleEnabled()
        if (envelope.hermes_worker === true || !enabled) {
          if (envelope.compacted === true) invalidateGuidanceRead(envelope.session_id, deps.env)
        } else {
          notice = claimGuidanceChange(envelope.session_id, deps.env, rootGuidanceDigest(cwd, deps.env),
            readSessionIncarnation(envelope.session_id, deps.env) !== null, { ...rootGuidanceDelivery(cwd, deps.env, harness, envelope.session_id), compacted: envelope.compacted === true })
        }
      }
    } catch (err) {
      logger.error('hook.gate', { stage: 'guidance-currency', outcome: 'ignored', ...failureData(err) })
    }
    if (notice !== undefined) deps.io.out(notice)
    logger.info('hook.end', { hook: event, outcome: notice === undefined ? 'current' : 'guidance-changed', decided: false })
    return EXIT.ok
  }
  // Grok's startup and prompt output never reaches the model, so the notices
  // other harnesses get at SessionStart ride on its activation instead, and a
  // later fault on the next tool result. Each is claimed only if printed.
  const grokNotices = (): { update: PendingNotice | undefined; fault: PendingNotice | undefined } => ({
    update: pendingAgentUpdateNotice({ env: deps.env, now: now(), updateCommand: updateCliCommand(deps) }),
    fault: pendingIntegrationFaultNotice({ ...deps, cwd }, 'grok'),
  })
  if (harness === 'grok' && (event === 'post-tool-use' || event === 'post-compact')) {
    start({ cwd })
    let context: string | undefined
    try {
      if (event === 'post-compact') resetGrokActivation(envelope.session_id!, deps.env, true)
      else if (lifecycleEnabled()) {
        const { update, fault } = grokNotices()
        context = claimGrokActivation(envelope, cwd, deps.env, [update, fault].filter((notice): notice is PendingNotice => notice !== undefined))
        if (context === undefined && !grokWorker(envelope)) context = claimNow(fault)
      }
      if (event === 'post-tool-use') {
        const form = unlinkedQuestionFormContext(deps, envelope, harness, cwd)
        if (form !== undefined) context = [context, form].filter(Boolean).join('\n\n')
      }
      if (context !== undefined) deps.io.out(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: envelope.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse',
          additionalContext: context,
        },
      }))
      logger.info('hook.end', { hook: event, outcome: context === undefined ? 'silent' : 'context-added', decided: false })
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'ignored', ...failureData(err) })
    }
    return EXIT.ok
  }
  // A tool-free first turn has no context-bearing tool hook. One genuine Stop
  // continuation activates it; teardown and cancellation can never do so.
  if (harness === 'grok' && event === 'stop' && typeof envelope.promptId === 'string' && lifecycleEnabled()) {
    try {
      // An activation block also sets stopHookActive. Never let that stand in
      // for delivery of a question answer that is already queued or accepted.
      const state = readSessionState(envelope.session_id!, deps.env)
      const hasQuestion = (state.pending?.length ?? 0) > 0 || state.accepted !== undefined ||
        (state.acknowledgement_due?.length ?? 0) > 0
      const { update, fault } = grokNotices()
      const context = hasQuestion ? undefined
        : claimGrokActivation(envelope, cwd, deps.env, [update, fault].filter((notice): notice is PendingNotice => notice !== undefined))
      if (context !== undefined) {
        start({ cwd })
        deps.io.out(JSON.stringify({ decision: 'block', reason: context }))
        logger.info('hook.end', { hook: event, outcome: 'context-added', decided: true })
        return EXIT.ok
      }
    } catch (err) {
      logger.error('hook.gate', { stage: 'grok-activation', outcome: 'ignored', ...failureData(err) })
    }
  }
  // Generation fencing alone decides ownership. SessionStart records a
  // generation in every Project, so disabling never strands owed answers.
  const currentOpenclawOwner = (): string | null => {
    if (harness !== 'openclaw' || envelope.session_id === undefined) return null
    const current = readOpenclawGeneration(envelope.session_id, deps.env)
    const incarnation = readSessionIncarnation(envelope.session_id, deps.env)
    return current !== null && current.recorded && !current.ended &&
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
      const cardContext = harness === 'codex' ? await codexCardPostToolUse(deps, envelope, logger) : null
      // A device answer and a terminal-answer conflict reach the session in
      // every Project; the fault notice is guidance, so only a Project with
      // guidance on carries it.
      if (harness === 'codex') {
        const enabled = lifecycleEnabled()
        const faultNotice = enabled ? cachedIntegrationFaultNotice({ ...deps, cwd }, harness) : undefined
        // A busy turn learns of changed guidance at its next tool boundary.
        const changed = enabled ? guidanceChangeFor(deps, harness, envelope, cwd) : undefined
        const notice = [cardContext, unlinkedQuestionFormContext(deps, envelope, harness, cwd),
          takeCodexTerminalConflictContext(deps, envelope), faultNotice, changed].filter(Boolean).join('\n\n') || undefined
        let wrote = false
        const io = { ...deps.io, out: (line: string) => {
          wrote = true
          deps.io.out(appendIntegrationContext(line, notice, harness, 'PostToolUse'))
        } }
        await deliverCodexToolMessage({ ...deps, io }, envelope, logger)
        if (!wrote && notice !== undefined) deps.io.out(appendIntegrationContext(undefined, notice, harness, 'PostToolUse'))
      }
      // A picker's answer, like every answer, does not depend on Project Enablement.
      if (harness === 'claude-code') claudePostToolUse(deps, envelope, logger)
      logger.info('hook.end', { hook: event, outcome: 'checked', decided: false })
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'ignored', ...failureData(err) })
    }
    return EXIT.ok
  }
  // Cursor resume may emit a prompt without SessionStart. The exact native
  // callback can establish an unseen conversation, but never revive an ended one.
  if (event === 'user-prompt-submit' && harness === 'cursor' && envelope.session_id !== undefined &&
      !sessionHasEnded(envelope.session_id, deps.env)) {
    if (readSessionIncarnation(envelope.session_id, deps.env) === null) {
      recordSessionStart(envelope.session_id, deps.env, harness, cwd, undefined, invokedAt)
    }
    updateSessionState(envelope.session_id, deps.env, (state) => ({ ...state, last_prompt_at: now() }))
  }
  if (event === 'stop' && harness === 'cursor') {
    try { await attendCursorStop(deps, envelope, logger, processDeadlineAt) }
    catch (err) { logger.error('hook.end', { hook: event, outcome: 'ignored', ...failureData(err) }) }
    return EXIT.ok
  }
  if (event === 'openclaw-native-session') {
    const generation = currentOpenclawOwner()
    if (generation !== null && envelope.session_id !== undefined) {
      recordOpenclawNativeSession(deps.env, envelope.openclaw_native_thread_id, envelope.session_id, generation)
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
    // Turn end, not the prompt path, refreshes what the next prompt reads.
    if (harness === 'openclaw') refreshIntegrationHealth({ ...deps, cwd }, harness)
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
        readAttendantLease(envelope.session_id, deps.env) !== null) deps.io.out('ready')
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
  // Installation only makes lifecycle hooks available. The session is
  // recorded in every Project, because its questions and answers route there;
  // model-visible activation is a separate User-owned Project decision,
  // checked anew on every run so disabling takes effect without reinstalling.
  if (event === 'session-start' || event === 'subagent-start') {
    start({ cwd, source: envelope.source ?? null })
    if (event === 'session-start' && harness === 'codex' && envelope.session_id !== undefined) {
      // Capture the definition this runtime loaded before maintenance or
      // guidance work can exhaust SessionStart's budget. Later prompt hooks
      // cannot reconstruct that activation proof from a possibly changed file.
      try {
        const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)
        recordSessionStart(envelope.session_id, deps.env, harness, cwd,
          codexStopDefinitionFingerprint(installations, deps.env), invokedAt, undefined,
          codexHandlerFingerprints(installations, deps.env))
      } catch (err) {
        logger.error('hook.end', {
          hook: event, outcome: 'record-failed', reason: 'session-state-failed', ...failureData(err),
        })
        return EXIT.ok
      }
    }
    if (event === 'session-start') startDueMaintenance()
    const guidanceOn = lifecycleEnabled()
    // Both notices are read from records written off the prompt path: the
    // update lookup by the detached daily maintenance, the integration
    // assessment at turn end and by the Session Attendant. They are claimed
    // only if the activation below prints them.
    const updateNotice = guidanceOn && event === 'session-start' &&
      ['claude-code', 'codex', 'cursor', 'opencode', 'openclaw', 'hermes'].includes(harness ?? '')
      ? pendingAgentUpdateNotice({ env: deps.env, now: now(), updateCommand: updateCliCommand(deps) })
      : undefined
    const faultNotice = guidanceOn && event === 'session-start' && harness !== undefined && harness !== 'grok'
      ? pendingIntegrationFaultNotice({ ...deps, cwd }, harness) : undefined
    const notices = [updateNotice, faultNotice].filter((part): part is PendingNotice => part !== undefined)
    // A root session's record of the guidance it was given decides whether
    // this start must also reload what it read before (`guidance-currency.ts`).
    const owner = event === 'session-start' && envelope.agent_id === undefined && envelope.session_id !== undefined && harness !== 'grok'
    const currencyKey = envelope.session_id === undefined ? '' : guidanceSessionKey(envelope.session_id, envelope.agent_id)
    let digest: string | undefined
    if (guidanceOn && owner) {
      try {
        digest = rootGuidanceDigest(cwd, deps.env)
      } catch (err) {
        logger.error('hook.gate', { stage: 'guidance-currency', outcome: 'ignored', ...failureData(err) })
      }
    }
    const currencyFor = (compacted: boolean): string | undefined => {
      if (digest === undefined) return undefined
      try {
        return startingCurrency({ sessionId: currencyKey, env: deps.env, digest, source: envelope.source, compacted, delivery: rootGuidanceDelivery(cwd, deps.env, harness, envelope.session_id) })
      } catch {
        return undefined
      }
    }
    const recordGiven = (): boolean => {
      if (!owner) return true
      const delivery = rootGuidanceDelivery(cwd, deps.env, harness, currencyKey)
      return recordGuidanceGiven(currencyKey, deps.env, guidanceOn ? delivery.digest : GUIDANCE_NOT_GIVEN, undefined, delivery.generation)
    }
    if ((!owner || !guidanceOn) && (envelope.source === 'compact' || envelope.compacted === true) && currencyKey !== '') {
      invalidateGuidanceRead(currencyKey, deps.env)
      // Claude children inherit the root's shell identity. A child compaction
      // must also expire conversation tokens bound to that shared identity.
      if (harness === 'claude-code' && envelope.agent_id !== undefined) invalidateGuidanceRead(envelope.session_id!, deps.env)
    }
    if (harness === 'openclaw' && envelope.session_id !== undefined) {
      try {
        const sessionKey = envelope.session_id
        const outcome = withFileLock(openclawGenerationLockPath(sessionKey, deps.env), () => {
          const current = readOpenclawGeneration(sessionKey, deps.env)
          if (envelope.openclaw_lifecycle_revision !== undefined &&
              current?.supersededLifecycleRevisions?.includes(envelope.openclaw_lifecycle_revision)) {
            return 'stale-prompt-ignored'
          }
          let generation = observeOpenclawPrompt(
            current, envelope.openclaw_session_id,
            envelope.openclaw_lifecycle_revision,
          )
          if (envelope.openclaw_session_id !== undefined &&
              generation.sessionId !== envelope.openclaw_session_id) return 'stale-prompt-ignored'
          if (!generation.recorded) {
            const previous = readSessionIncarnation(sessionKey, deps.env)
            if (previous !== null && previous.openclaw_generation !== generation.id) {
              // A new sessionId or resumed generation is authoritative even if
              // its old session_end was dropped or delayed.
              handleSessionEnd(deps.env, envelope, now())
            }
            recordSessionStart(
              sessionKey, deps.env, harness, cwd, undefined, lifecycleStamp(now()), generation.id,
            )
            generation = { ...generation, recorded: true }
          }
          writeOpenclawGeneration(sessionKey, deps.env, generation)
          observeIntegration()
          // A conversation recorded while guidance was off gets its activation
          // at the first prompt after the Project is enabled.
          if (!guidanceOn) {
            recordGiven()
            return 'recorded'
          }
          // The conversation already carries its activation, unless a
          // compaction summarized it away (the plugin finds it missing from
          // the prompt's messages): then it is activated again.
          const reactivate = generation.activationPrinted === true && envelope.compacted === true
          if (generation.activationPrinted && !reactivate) {
            const changed = owner && digest !== undefined ? claimGuidanceChange(sessionKey, deps.env, digest, true, rootGuidanceDelivery(cwd, deps.env, harness, envelope.session_id)) : undefined
            if (changed === undefined) return 'already-activated'
            deps.io.out(changed)
            return 'guidance-changed'
          }
          const output = sessionActivationOutput(
            harness, event === 'session-start' ? 'SessionStart' : 'SubagentStart',
            cwd, deps.env, notices, false, owner ? currencyFor(reactivate) : undefined,
          )
          if (output === undefined || output.trim().length === 0) return 'activation-unavailable'
          if (!recordGiven()) return 'receipt-unavailable'
          writeOpenclawGeneration(sessionKey, deps.env, { ...generation, activationPrinted: true })
          deps.io.out(output)
          return 'context-added'
        })
        logger.info('hook.end', {
          hook: event, outcome, decided: false, ...(guidanceOn ? {} : { reason: 'guidance-off' }),
        })
      } catch (err) {
        logger.error('hook.end', {
          hook: event, outcome: 'record-failed', reason: 'session-state-failed', ...failureData(err),
        })
      }
      return EXIT.ok
    }
    const stdout = guidanceOn
      ? sessionActivationOutput(
        harness,
        event === 'session-start' ? 'SessionStart' : 'SubagentStart',
        cwd,
        deps.env,
        notices,
        envelope.hermes_prompt_sections === 2,
        owner ? currencyFor(envelope.compacted === true) : undefined,
      )
      : undefined
    if (stdout !== undefined) {
      if (recordGiven()) deps.io.out(stdout)
    } else if (!guidanceOn) recordGiven()
    let settlementRecovery: Record<string, unknown> = {}
    if (event === 'session-start' && envelope.session_id !== undefined) {
      try {
        if (harness !== 'codex') recordSessionStart(envelope.session_id, deps.env, harness, cwd, undefined, invokedAt)
        if (harness === 'grok') {
          resetGrokActivation(envelope.session_id, deps.env)
          startGrokAttendant(envelope, cwd, deps.env)
        }
        observeIntegration()
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
      outcome: !guidanceOn
        ? 'recorded'
        : stdout === undefined
          ? harness === 'grok' ? 'activation-awaiting-tool' : 'unsupported-harness'
          : 'context-added',
      ...(guidanceOn ? {} : { reason: 'guidance-off' }),
      decided: false,
      ...settlementRecovery,
    })
    return EXIT.ok
  }

  // A Codex turn starts here. This prompt hook is synchronous, so Codex runs it
  // before the turn and one turn at a time: the Session Attendant reads the
  // thread's activity from starts recorded in that order.
  if (event === 'user-prompt-submit' && harness === 'grok') {
    try { startGrokAttendant(envelope, cwd, deps.env) }
    catch (err) { logger.error('hook.gate', { stage: 'grok-attendant', outcome: 'ignored', ...failureData(err) }) }
  }
  if (event === 'user-prompt-submit' && harness === 'codex') recordCodexTurnStart(envelope, deps.env)
  if (event === 'user-prompt-submit' || event === 'stop') {
    observeIntegration()
    startDueHubHandover()
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
    if (sessionEnd && (harness === 'codex' || harness === 'claude-code') && envelope.session_id !== undefined &&
        await holdSessionEnd(deps.env, envelope.session_id, {
          harnessPid: harness === 'claude-code' ? claudeHookSourcePid(deps.env, deps.hookPlatform ?? process.platform) : declaredHookSourcePid(deps),
          transcriptPath: envelope.transcript_path,
          closeReason: harness === 'claude-code' ? envelope.reason : undefined,
        }) === 'held') {
      // SessionEnd is not final: the shared Codex server runs it for a reload
      // on resume, the desktop app for a respawn, a handoff starts the same
      // conversation elsewhere at once, another place may still have it open,
      // and an app unloads conversations it still lists. The hub that attends
      // it decides after the end confirmation, and cleans up only for a close.
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      logger.info('hook.end', { hook: event, session_end_reason: envelope.reason ?? null, decided: false, outcome: 'held-for-confirmation' })
      return EXIT.ok
    }
    if (sessionEnd && (harness === 'claude-code' || harness === 'codex') && envelope.session_id !== undefined &&
        hubSupported(deps.hookPlatform ?? process.platform) && shutdownUnderway(deps.env, now())) {
      // The machine is going down and its hub may already be gone: the next
      // hub decides (stopped by the machine, or closed), never this hook.
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      logger.info('hook.end', { hook: event, session_end_reason: envelope.reason ?? null, decided: false, outcome: 'held-for-shutdown' })
      return EXIT.ok
    }
    if (sessionEnd && (harness === 'claude-code' || harness === 'codex') && envelope.session_id !== undefined &&
        deps.spawnEndConfirmation !== undefined &&
        !(harness === 'claude-code' && ['terminal', 'claude-ide'].includes(claudePlaceOf(claudePlaceSignals(deps.env, claudeHookSourcePid(deps.env, deps.hookPlatform ?? process.platform)))) && (envelope.reason === 'prompt_input_exit' || envelope.reason === 'logout'))) {
      const spawnEndConfirmation = deps.spawnEndConfirmation
      const sessionHarness = harness
      if (awaitEndConfirmation(deps.env, {
        sessionId: envelope.session_id,
        harness: sessionHarness,
        harnessPid: sessionHarness === 'claude-code' ? claudeHookSourcePid(deps.env, deps.hookPlatform ?? process.platform) : declaredHookSourcePid(deps),
        cwd: envelope.cwd,
        endingLease: codexEndingLease,
      }, now(), () => spawnEndConfirmation({ cwd, harness: sessionHarness,
        ...(workAllowanceMs === null ? {} : { detachTimeoutMs: Math.min(5_000, workAllowanceMs) }) }))) {
        // No hub decides this end, and closing now would expire questions or
        // drop answers: a detached process waits out the end confirmation and
        // ends the session only if the same conversation has not come back.
        start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
        logger.info('hook.end', { hook: event, session_end_reason: envelope.reason ?? null, decided: false, outcome: 'awaiting-end-confirmation' })
        return EXIT.ok
      }
    }
    if (sessionEnd) {
      // Codex gives SessionEnd one second total. Do every durable cleanup write
      // before lifecycle diagnostics: a busy log must never preserve
      // ended-session state or its inherited configuration. (A hook never waits
      // for the log lock; a busy lock means an unlocked append.) The resolved
      // config above is retained in memory so logging still uses the ending
      // session's settings afterwards.
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
            const ended = current.recorded
              ? handleSessionEnd(deps.env, envelope, now())
              : { notes: [], log: { outcome: 'ignored', reason: 'inactive-openclaw-generation' } }
            writeOpenclawGeneration(sessionKey, deps.env, { ...current, ended: true })
            return ended
          })
        : handleSessionEnd(deps.env, envelope, now())
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      if (config !== null) logConfigResolved(logger, config)
      const data = { hook: event, decided: false, ...outcome.log, session_end_reason: envelope.reason ?? null }
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
      if ((harness === 'codex' || harness === 'claude-code') && envelope.session_id !== undefined) {
        // The hub reports the end and retires what it queued at once. With no
        // hub running, a detached process retires the queue now instead.
        const handed = await notifyHubSessionEnded(deps.env, envelope.session_id)
        const queued = (outcome.log as { queued_retirements?: unknown }).queued_retirements
        if (!handed && typeof queued === 'number' && queued > 0) {
          try {
            deps.spawnRetirement?.({ cwd, harness, ...(workAllowanceMs === null ? {} : { detachTimeoutMs: Math.min(5_000, workAllowanceMs) }) })
          } catch (err) {
            logger.error('hook.retirement', { stage: 'spawn', ...failureData(err) })
          }
        }
      }
      return EXIT.ok
    }

    // Non-SessionEnd hooks cannot reach here without resolved configuration.
    const resolved = config!
    // No credential is read until the first authenticated call: a prompt or
    // Stop with nothing to send never starts a credential helper.
    let authenticated: { credential: MachineCredential; client: ApiClient } | null | undefined
    const authenticate = (): { credential: MachineCredential; client: ApiClient } => {
      if (authenticated === undefined) {
        const credential = deps.store.load()
        if (credential === null) authenticated = null
        else {
          // Pin authenticated traffic to the origin the credential was issued
          // for. Honouring a base_url from anywhere else would hand this
          // machine's bearer token to whatever host it names.
          diagnoseIgnoredOriginOverride(deps.io, resolved, credential)
          // A short hook (UserPromptSubmit in front of the User's own prompt,
          // a non-routing Stop) can make two calls, so each gets a slice of its
          // harness timeout and all of them end with the hook. Owners keep the
          // ordinary budget.
          authenticated = {
            credential,
            client: makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`, {
              timeoutMs: budgets.serviceRequestMs,
              ...(event === 'stop' || event === 'question-settlement' || workAllowanceMs !== null
                ? { deadlineAt: processDeadlineAt, now }
                : {}),
            }),
          }
        }
      }
      if (authenticated === null) throw new MachineNotPairedError()
      return authenticated
    }
    const notPaired = (): boolean => authenticated === null
    const client = lazyClient(() => authenticate().client)
    const ctx: HookContext = {
      client,
      get service_identity() {
        const { credential } = authenticate()
        return { base_url: credential.baseUrl, machine_id: credential.machineId }
      },
      config: resolved,
      env: deps.env,
      now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      waitForFirstReply: async (requestId, timeoutSeconds, expiresAt) => {
        const result = await waitForReply(client, requestId, {
          timeoutSeconds,
          afterSeq: 0,
          now: deps.now,
          sleep: deps.sleep,
          expiresAt,
        })
        return {
          replies: result.response.replies,
          timedOut: result.timedOut,
          degraded: result.degraded,
          ...(result.closed === true ? { closed: true } : {}),
        }
      },
      log: logger,
      ...(harness === undefined ? {} : { harness }),
      ...answerClaimsFor(deps, harness, envelope.session_id, event),
    }

    if (event === 'retirement') {
      // The hub learned of a close: retire what it queued now, not at a later hook.
      const retired = await drainClosedSessionRetirements(ctx)
      logger.info('hook.end', { hook: event, outcome: 'drained', decided: false, retired: retired.length })
      return EXIT.ok
    }

    if (event === 'question-submission') {
      const notes: string[] = []
      const sessionId = envelope.session_id
      // A registered question keeps the contract it was registered under:
      // like Stop, submit it whatever the Project's decision is now.
      if (sessionId === undefined || harness === undefined ||
          readSessionState(sessionId, deps.env).harness !== harness) return EXIT.ok
      if (harness === 'codex') await reportCodexTerminalAnswers(ctx, sessionId, true)
      await submitSessionQuestions(ctx, envelope, processDeadlineAt, notes)
      // The same owner settles what a closed Claude Code picker left behind:
      // a cancelled picker whose result never came, a withdrawn device
      // question to retire, a terminal answer to report.
      if (harness === 'claude-code') {
        await settleCancelledClaudePicker({ env: deps.env, log: logger, now: deps.now, sleep: ctx.sleep }, sessionId)
        await reportClaudeTerminalAnswers(ctx, sessionId)
        await drainRetirements(ctx, sessionId, deps.env)
      }
      if (harness === 'codex') await reportCodexTerminalAnswers(ctx, sessionId)
      // Native queues can observe answers while the asking turn keeps working.
      // Held Stop and plugin routes retain their own genuine output owner.
      const nativeObserver = harness === 'codex' || harness === 'claude-code'
      logger.info('hook.end', { hook: event, outcome: 'submission-checked', notes,
        ...(nativeObserver ? launchSettlement() : {}) })
      return EXIT.ok
    }

    // Daily state pruning moved off the prompt path into the detached hook
    // maintenance process; this only checks its stamp.
    if (event === 'user-prompt-submit') startDueMaintenance()

    let outcome: HookOutcome
    // What this turn hands the agent itself, before any diagnostic notice.
    let handedStdout: string | undefined
    // A scripted run of a conversation another process hosts or held.
    let runElsewhere = false
    if (event === 'user-prompt-submit') {
      if (envelope.session_id !== undefined) observeSessionInputWake(envelope.session_id, deps.env, envelope.prompt, (deps.now ?? Date.now)())
      const enabled = harness !== undefined && PROMPT_CONTEXT_REACHES_MODEL.has(harness) && lifecycleEnabled()
      const notice = enabled ? cachedIntegrationFaultNotice({ ...deps, cwd }, harness) : undefined
      // A scripted run (`claude -p`, an SDK script, `codex exec`) of a conversation
      // another process hosts is not where the User is: nothing held for it is handed in here.
      const elsewhere = envelope.session_id !== undefined && scriptedRunElsewhere(deps, harness, envelope.session_id)
      runElsewhere = elsewhere
      if (harness === 'codex' && !elsewhere) observeCodexTerminalAnswers(deps, envelope, logger)
      // Claude wakes carry a token; Codex prompts with one keep their own path.
      outcome = elsewhere ? { notes: [], log: { stage: 'scripted-run-receives-nothing' } }
        : envelope.session_id !== undefined && (envelope.prompt === sessionInputWake() ||
          (harness === 'claude-code' && inputWakeToken(envelope.prompt) !== null))
          ? { notes: [], log: { stage: 'input-wake-observed' } }
          : await handleUserPromptSubmit(ctx, envelope)
      if (harness === 'codex' && !elsewhere) {
        const conflict = takeCodexTerminalConflictContext(deps, envelope)
        if (conflict !== null) outcome.stdout = appendIntegrationContext(outcome.stdout, conflict, harness, 'UserPromptSubmit')
      }
      handedStdout = outcome.stdout
      if (notice !== undefined) outcome.stdout = appendIntegrationContext(outcome.stdout, notice, harness, 'UserPromptSubmit')
      // Guidance that changed since this owner session read it, told once at
      // its next turn. Not in a scripted run of a conversation hosted elsewhere.
      const changed = enabled && !elsewhere ? guidanceChangeFor(deps, harness, envelope, cwd) : undefined
      if (changed !== undefined) outcome.stdout = appendIntegrationContext(outcome.stdout, changed, harness, 'UserPromptSubmit')
      // A device answer returned through a picker that Claude Code never took
      // is still owed to the agent; this prompt carries it.
      if (harness === 'claude-code' && envelope.session_id !== undefined && envelope.agent_id === undefined && !elsewhere) {
        const owed = takeOwedClaudePickerAnswer(envelope.session_id, deps.env)
        if (owed !== null) outcome.stdout = appendIntegrationContext(outcome.stdout, owed, harness, 'UserPromptSubmit')
      }
    } else {
      // An OpenCode question form whose command died with OpenCode left its
      // device question open; the turn end of any later session withdraws it.
      if (event === 'stop' && harness === 'opencode') {
        const { sweepAbandonedOpencodeForms } = await import('./opencode-question.js')
        await sweepAbandonedOpencodeForms(deps, { timeoutMs: budgets.serviceRequestMs, limit: 2 })
      }
      // A scripted run's turn end collects no answer meant for the place the conversation is in.
      const scriptedElsewhere = event === 'stop' && envelope.session_id !== undefined && scriptedRunElsewhere(deps, harness, envelope.session_id)
      const terminalConflict = event === 'stop' && harness === 'codex' && !scriptedElsewhere
        ? takeCodexTerminalConflictContext(deps, envelope) : null
      outcome = terminalConflict !== null ? { notes: [], stdout: stopAnswerOutput(terminalConflict), decided: true }
        : scriptedElsewhere ? { notes: [], log: { stage: 'scripted-run-receives-nothing' } } : await handleStop(
        ctx,
        envelope,
        processDeadlineAt,
        event === 'openclaw-settlement' && envelope.session_id !== undefined
          ? openclawContinuationRoute(envelope.session_id, currentOpenclawOwner()!)
          : await stopWakeRoute(deps, harness, envelope.session_id, cwd, event !== 'stop'),
        // The Gateway settlement process is not an agent turn boundary. Only
        // agent_end records Stop; a background poll must not spend the three
        // acknowledgement reminders or abandon a Session Message debt.
        event === 'stop',
        // When the hub attends this session, Claude Code's Stop hook submits
        // and hands the answer window to the hub instead of waiting through it.
        event === 'stop' && harness === 'claude-code' && envelope.session_id !== undefined &&
          hubSupported(deps.hookPlatform ?? process.platform) && hubAttendsSession(envelope.session_id, deps.env),
        // A background answer owner, in the hub or detached, takes over from
        // one that must not keep this session's questions.
        event === 'question-settlement' ? deps.questionOwnerRole ?? 'detached' : 'stop',
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
      ...(notPaired() ? { credential: 'not-paired' } : {}),
    })
    for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
    if (notPaired()) deps.io.err(`notifai: this machine is not paired; run \`${SETUP_COMMAND}\``)
    let inputWritten = false
    if (event === 'user-prompt-submit' && (harness === 'codex' || harness === 'claude-code') &&
        envelope.session_id !== undefined && outcome.commitStdout === undefined &&
        readSessionIncarnation(envelope.session_id, deps.env)?.harness_process?.pid ===
          (harness === 'claude-code' ? claudeHookSourcePid(deps.env, deps.hookPlatform ?? process.platform) : declaredHookSourcePid(deps))) {
      inputWritten = await receiveSessionInputs(deps, envelope.session_id, (text) => {
        deps.io.out(appendIntegrationContext(outcome.stdout, text, harness, 'UserPromptSubmit'))
      })
      if (inputWritten) await outcome.afterOutput?.()
    }
    if (event === 'user-prompt-submit' && harness === 'codex' && envelope.session_id !== undefined && !inputWritten &&
        handedStdout === undefined && isSessionInputWake(envelope.prompt) &&
        !codexWakeHasInput(deps, envelope.session_id)) {
      // A Notifai wake with nothing behind it: the session closed since it was
      // queued (a stale wake in a reopened conversation), or what it was for
      // was already handed in; or a `codex exec` run of a conversation whose
      // answers wait for the place it was open in. Blocking it means no turn
      // and no model request.
      deps.io.out(JSON.stringify({ decision: 'block', reason: runElsewhere ? CODEX_ELSEWHERE_WAKE_REASON : CODEX_EMPTY_WAKE_REASON }))
      logger.info('hook.gate', { stage: 'codex-wake', outcome: 'blocked', reason: runElsewhere ? 'scripted-run' : 'nothing-waiting' })
      return EXIT.ok
    }
    if (!inputWritten && event === 'user-prompt-submit' && !runElsewhere && envelope.session_id !== undefined &&
        !sessionHasEnded(envelope.session_id, deps.env) && (harness === 'codex' || harness === 'claude-code') &&
        readSessionIncarnation(envelope.session_id, deps.env)?.harness_process?.pid ===
          (harness === 'claude-code' ? claudeHookSourcePid(deps.env, deps.hookPlatform ?? process.platform) : declaredHookSourcePid(deps))) {
      const state = readSessionState(envelope.session_id, deps.env)
      const fault = inputWakeFaultContext(state)
      if (fault !== null) {
        outcome.stdout = appendIntegrationContext(outcome.stdout, fault, harness, 'UserPromptSubmit')
        const after = outcome.afterOutput
        const lastAt = state.input_wake_fault!.last_at
        outcome.afterOutput = async () => {
          markInputWakeFaultReported(envelope.session_id!, deps.env, lastAt)
          await after?.()
        }
      }
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
    // Turn end, not the prompt path, refreshes the integration assessment the
    // next prompt, activation or Grok tool result reads. It scans at most once
    // per check interval.
    if (event === 'stop' && harness !== undefined) refreshIntegrationHealth({ ...deps, cwd }, harness)
    return EXIT.ok
  } catch (err) {
    // SessionEnd defers its start record until after cleanup; if cleanup itself
    // fails, begin the after-the-fact lifecycle here before recording why.
    if (sessionEnd) start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
    if (err instanceof MachineNotPairedError) {
      logger.error('hook.end', { hook: event, outcome: 'not-paired' })
      deps.io.err(`notifai: hook skipped: this machine is not paired; run \`${SETUP_COMMAND}\``)
      return EXIT.ok
    }
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
async function stopWakeRoute(
  deps: CommandDeps,
  harness: HookInstallableHarness | undefined,
  sessionId: string | undefined,
  cwd: string,
  background: boolean,
): Promise<EscalationDeliveryRoute | undefined> {
  if (harness === 'grok') return grokQuestionRoute(sessionId, cwd, deps.env)
  if (sessionId === undefined) return undefined
  const declaredSourcePid = declaredHookSourcePid(deps)
  if (harness === 'claude-code') {
    const route = sessionInputRoute(sessionId, deps.env, claudeWakeRoute({
      sessionId,
      sourcePid: deps.claudeSourcePid ?? claudeHookSourcePid(deps.env, deps.hookPlatform ?? process.platform) ??
        declaredSourcePid ?? claudeSessionPid(deps.env),
      env: deps.env,
      ...(deps.claudeWake === undefined ? {} : { adapters: deps.claudeWake }),
      ...(deps.hookPlatform === undefined ? {} : { platform: deps.hookPlatform }),
    }), log(deps), 'producer', { unique: true })
    // A detached or hub-owned waiter is not Claude's child. Only the session's
    // own resident (the session child, through the hub) has the own-child
    // standing the inbox requires; its attendance wakes staged inputs.
    return background ? { ...route, defer: async (accepted) => {
      stageSessionAnswers(sessionId, deps.env, accepted)
      deps.onSessionInputStaged?.(sessionId)
    } } : route
  }
  if (harness === 'codex') {
    return sessionInputRoute(sessionId, deps.env, codexWakeRoute({
      threadId: sessionId,
      cwd,
      env: deps.env,
      ...(deps.codexWake === undefined ? {} : { adapters: deps.codexWake }),
    }), log(deps), 'attendant', {}, deps.onSessionInputStaged)
  }
  return undefined
}

/**
 * The Stop waiter claims fenced answers only where a Session Attendant can
 * hold the session's lease and the answer is written in place: Claude Code.
 * Everywhere else it closes and writes exactly as before.
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

/** What a Codex User sees under "Blocked by hook" when an empty wake is skipped. */
export const CODEX_EMPTY_WAKE_REASON = 'Notifai: nothing is waiting for this session, so this wake started no turn.'
export const CODEX_ELSEWHERE_WAKE_REASON = "Notifai: this conversation's answers are waiting where it was last open, so this run won't pick them up."

/**
 * Whether anything this Codex session can still be handed waits locally: it
 * is open, this hook runs in the process that hosts it, and an answer or a
 * Session Message is staged for it.
 */
function codexWakeHasInput(deps: CommandDeps, sessionId: string): boolean {
  if (sessionHasEnded(sessionId, deps.env)) return false
  const owner = readSessionIncarnation(sessionId, deps.env)?.harness_process
  if (owner === undefined || owner.pid !== declaredHookSourcePid(deps)) return false
  const lease = readAttendantLease(sessionId, deps.env) ?? readAttendantEndingLease(sessionId, deps.env)
  return hasSessionInputs(sessionId, deps.env, lease)
}

/**
 * A Claude Code prompt in a place that receives nothing held for the
 * conversation (a scripted run, an unknown entrypoint) while another process
 * hosts it: its own questions still work, but answers and notes wait for the
 * place the conversation is in.
 */
export function claudeRunElsewhere(sessionId: string, env: NodeJS.ProcessEnv, sourcePid: number | undefined): boolean {
  if (placeReceives(claudePlaceOf(claudePlaceSignals(env, sourcePid)))) return false
  const host = readSessionIncarnation(sessionId, env)?.harness_process
  return host !== undefined && host.pid !== sourcePid
}

/**
 * A `codex exec` run of a thread another process hosts (or hosted until it
 * stopped): nothing held for the thread is handed into a scripted run. Asks
 * the process table only when the hook's process is not the thread's host.
 */
export function codexRunElsewhere(sessionId: string, env: NodeJS.ProcessEnv, sourcePid: number | undefined,
  hostKind: (pid: number) => string = codexHostKind): boolean {
  const host = readSessionIncarnation(sessionId, env)?.harness_process
  if (host === undefined || sourcePid === undefined || host.pid === sourcePid) return false
  return hostKind(sourcePid) === 'exec'
}

function scriptedRunElsewhere(deps: CommandDeps, harness: string | undefined, sessionId: string): boolean {
  if (harness === 'claude-code') return claudeRunElsewhere(sessionId, deps.env, claudeHookSourcePid(deps.env, deps.hookPlatform ?? process.platform))
  return harness === 'codex' && codexRunElsewhere(sessionId, deps.env, declaredHookSourcePid(deps))
}

/**
 * The change notice for a root owner session whose guidance changed since it
 * was given it (`guidance-currency.ts`), claimed. Only where the harness
 * shows this hook's context to the model: Claude Code and Codex prompts, and
 * Codex tool boundaries.
 */
function guidanceChangeFor(deps: CommandDeps, harness: HookHarness | undefined, envelope: HookEnvelope, cwd: string): string | undefined {
  if ((harness !== 'claude-code' && harness !== 'codex') || envelope.session_id === undefined || envelope.agent_id !== undefined) return undefined
  try {
    return claimGuidanceChange(guidanceSessionKey(envelope.session_id, envelope.agent_id), deps.env, rootGuidanceDigest(cwd, deps.env),
      readSessionIncarnation(envelope.session_id, deps.env) !== null, rootGuidanceDelivery(cwd, deps.env, harness, envelope.session_id))
  } catch {
    // Guidance currency never fails a hook.
    return undefined
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
