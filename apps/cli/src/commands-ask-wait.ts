/**
 * The held wait: `notifai ask --wait` where no later answer can come back.
 *
 * A script outside any harness, Cursor (no exact conversation id), OpenCode,
 * OpenClaw off macOS, Hermes off its classic CLI and a shell with conflicting
 * inherited markers have no Agent Session a later answer could wake. So the
 * command itself submits the question at once and stays in the foreground
 * until an answer arrives or the wait ends. The service owns the end: the
 * question's answer window ends at the wait's deadline, so it leaves the
 * User's devices even if this process is killed. An unanswered end also
 * withdraws it at once, as best effort.
 */
import {
  REPLY_MAX_WINDOW_SECONDS,
  type CloseRepliesResponse,
  type ListRepliesResponse,
  type NotificationDraftT,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { ApiCallError, NetworkError, isRetryableReplyPollError } from './client.js'
import { EXIT, authedClient, log, reportError, type CommandDeps } from './commands-core.js'
import { sourceContextHarnessSession, type ActiveHarnessSession } from './commands-harness-context.js'
import {
  degradedWaitWarning,
  draftForServerCapabilities,
  printReplies,
  recordReplies,
  replyResultJson,
  reportForegroundAnswer,
  replyWindowDue,
  unansweredReplyResultJson,
} from './commands-send.js'
import { printAcknowledgementStatus, resolveDraftInvocation, uploadImage, waitForReply } from './commands-send-support.js'
import type { CliConfig } from './config.js'
import { HERMES_QUESTION_ROUTING_UNAVAILABLE, isHookInstallableHarness, questionRoutingCapability } from './harnesses.js'
import { MIN_REPLY_WINDOW_SECONDS } from './hook-lifecycle.js'
import { recordSessionNotified } from './hook-session-state.js'
import { activeOpenclawGeneration, recordOpenclawForegroundReply } from './openclaw-session-access.js'
import { selectedForClaimedDelivery } from './hook-question-retirement.js'
import { beginSendAttempt, semanticMediaIds, sendDraftFingerprint, settleSendAttempt } from './send-attempts.js'
import { buildAskDraft, reportAskFailure, type AskFlags, type BuiltQuestions } from './commands-ask.js'

/** The receipt a script's answer gets: no agent will write one. */
export const PROGRAM_RECEIPT = 'Received by the program that asked.'

/** The margin a held wait keeps inside a harness's command limit. */
export const HARNESS_LIMIT_MARGIN_SECONDS = 10

/**
 * The foreground command limit of each harness, in seconds, where one is known.
 *
 * Claude Code stops Bash after `BASH_DEFAULT_TIMEOUT_MS` (120 000 by default)
 * unless the agent gives the command a longer timeout, which this process
 * cannot see. Cursor's is about ten minutes by its staff's forum replies,
 * provisional until a live check. Anything unmeasured counts as Claude Code's
 * default, the shortest limit known.
 */
const UNMEASURED_LIMIT_SECONDS = 120
const CURSOR_LIMIT_SECONDS = 600

function claudeCodeLimitSeconds(env: NodeJS.ProcessEnv): number {
  const configured = Number(env['BASH_DEFAULT_TIMEOUT_MS'])
  return Number.isFinite(configured) && configured > 0 ? configured / 1000 : UNMEASURED_LIMIT_SECONDS
}

function harnessLimitSeconds(harness: string, env: NodeJS.ProcessEnv): number {
  if (harness === 'claude-code') return claudeCodeLimitSeconds(env)
  if (harness === 'cursor') return CURSOR_LIMIT_SECONDS
  return UNMEASURED_LIMIT_SECONDS
}

/**
 * How long a held wait lasts. No flag sets it:
 *
 * - no harness, so no command limit (a script): the answer window,
 *   `reply_window_seconds`;
 * - inside a harness that kills long commands: its limit minus 10 s. With
 *   conflicting markers every named harness could own the shell, so the
 *   shortest of their limits applies.
 *
 * The result never drops below the shortest answer window the service
 * accepts, and never exceeds the longest.
 */
export function heldWaitSeconds(
  harnesses: readonly string[],
  env: NodeJS.ProcessEnv,
  config: Pick<CliConfig, 'reply_window_seconds'>,
): number {
  if (harnesses.length === 0) {
    return Math.min(REPLY_MAX_WINDOW_SECONDS, Math.max(MIN_REPLY_WINDOW_SECONDS, config.reply_window_seconds.value))
  }
  const limit = Math.min(...harnesses.map((harness) => harnessLimitSeconds(harness, env)))
  const wait = Math.floor(limit - HARNESS_LIMIT_MARGIN_SECONDS)
  return Math.min(REPLY_MAX_WINDOW_SECONDS, Math.max(MIN_REPLY_WINDOW_SECONDS, wait))
}

/** The route a held wait runs on, and why no later answer could return. */
export interface HeldWaitRoute {
  /** Every harness that could own this shell; empty for a program outside any harness. */
  harnesses: readonly string[]
  /** The one active harness, when exactly one marker names it. */
  active: ActiveHarnessSession | null
  /** What the agent reads when plain `ask` is refused here. */
  reason: string
  /** The refusal code and check plain `ask` has always used for this case; scripts match them. */
  code: 'session_identity_missing' | 'session_identity_ambiguous' | 'question_routing_unavailable'
  checkId: 'exact_session' | 'hook_contract'
}

/**
 * Whether this shell has no return path, so plain `ask` is refused and
 * `ask --wait` holds. A harness with a return path whose routing is not ready
 * is not this case: admission refuses it in `askCommand`, never held.
 */
export function heldWaitRoute(
  active: ActiveHarnessSession | null,
  contested: readonly ActiveHarnessSession[],
  platform: NodeJS.Platform,
): HeldWaitRoute | null {
  if (active === null) {
    return {
      harnesses: [], active: null,
      reason: 'No supported harness owns this shell, so no Agent Session can receive a later answer.',
      code: 'session_identity_missing', checkId: 'exact_session',
    }
  }
  if (contested.length > 1) {
    return {
      harnesses: contested.map((candidate) => candidate.harness),
      active: null,
      reason: `Several harness sessions could own this shell (${contested.map((candidate) => candidate.label).join(', ')}), so no later answer can return to the right one.`,
      code: 'session_identity_ambiguous', checkId: 'exact_session',
    }
  }
  const routable = isHookInstallableHarness(active.harness) &&
    !(active.harness === 'hermes' && active.integrationInstance === undefined)
  const capability = routable ? questionRoutingCapability(active.harness, platform) : HERMES_QUESTION_ROUTING_UNAVAILABLE
  if (capability.stopContinuation === 'unsupported') {
    return {
      harnesses: [active.harness], active, reason: `${active.label}: ${capability.deliveryContract}`,
      ...(routable && active.sessionId === undefined
        ? { code: 'session_identity_missing', checkId: 'exact_session' } as const
        : { code: 'question_routing_unavailable', checkId: 'hook_contract' } as const),
    }
  }
  if (active.sessionId === undefined) {
    return {
      harnesses: [active.harness], active,
      reason: `The active ${active.label} shell does not expose an exact session id, so no later answer can return to this Agent Session.`,
      code: 'session_identity_missing', checkId: 'exact_session',
    }
  }
  return null
}

/** The remedy plain `ask` prints where it cannot return an answer: the held wait, and in OpenCode the form too. */
export function answerCannotReturnRemedy(route: HeldWaitRoute): string {
  if (route.active?.harness === 'opencode' && route.active.worker === false) {
    return 'to wait for the answer, run `notifai ask --wait`: it hands back OpenCode\'s `question` form, which reaches the User\'s devices; to keep working, ask in the conversation, which the devices do not see'
  }
  // A plugin too old to say whether this is a worker hands back no form.
  if (route.active?.harness === 'opencode' && route.active.worker === undefined) {
    return 'to wait for the answer, open OpenCode\'s `question` form, which reaches the User\'s devices, or run `notifai ask --wait`, which waits in this command; to keep working, ask in the conversation, which the devices do not see'
  }
  return 'run `notifai ask --wait` for this question: the command itself waits for the answer'
}

export interface HeldWaitInput {
  question: string | undefined
  built: BuiltQuestions
  flags: AskFlags
  config: CliConfig
  route: HeldWaitRoute
}

type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'
const WITHDRAW_SIGNALS: readonly Signal[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

function subscribeSignals(deps: CommandDeps, handler: (signal: Signal) => void): () => void {
  if (deps.heldWaitSignals !== undefined) return deps.heldWaitSignals(handler)
  for (const signal of WITHDRAW_SIGNALS) process.once(signal, handler)
  return () => {
    for (const signal of WITHDRAW_SIGNALS) process.removeListener(signal, handler)
  }
}

const UNANSWERED = 'No answer: the question ended unanswered, and it is off the User\'s devices. Carry on without the answer, or ask in the conversation.'

/**
 * Submit the question with its window ending at the wait's deadline, hold for
 * the answer, and end with exit 0 (answered), 3 (ended unanswered; the question
 * is withdrawn or has expired) or 5 (the service was unreachable at the end).
 */
export async function heldAskWait(deps: CommandDeps, input: HeldWaitInput): Promise<number> {
  const { built, flags, config, route } = input
  const json = flags.json === true
  const authed = authedClient(deps, config)
  if (!authed) {
    return reportAskFailure(deps, flags, {
      code: 'auth_required', check_id: 'credential', exit_code: EXIT.auth,
      message: 'This machine is not signed in, so nothing can reach the User\'s devices.',
      remedy: 'run `notifai init --json`',
    })
  }
  const now = deps.now ?? Date.now
  // The harness limit bounds the whole command, so the wait is measured from
  // its start, not from the submission.
  const startedAt = now()
  const waitSeconds = heldWaitSeconds(route.harnesses, deps.env, config)
  const deadline = startedAt + waitSeconds * 1000
  // The source names the one harness that owns this shell, when one does.
  // Cursor contributes its harness without a session; a script contributes
  // none; conflicting markers name nobody.
  const activeSession = sourceContextHarnessSession(deps.env, deps.cwd, now())
  const source = resolveDraftInvocation(deps, flags, activeSession)
  if (!source.ok) {
    return reportAskFailure(deps, flags, {
      code: 'invalid_source', check_id: 'source_context', exit_code: EXIT.usage, message: source.error,
      remedy: /session-name store|session's name/u.test(source.error)
        ? 'inspect the named session-name store, isolate or remove the invalid record, and retry'
        : 'remove the conflicting source override and retry',
    })
  }
  // Every limit fails before an upload starts; the real ids replace the
  // placeholders only after this passes.
  const placeholders = (flags.image ?? []).map((_, index) => `med_pending_${index + 1}`)
  const preflight = buildAskDraft(config, built, flags, source.invocation, placeholders, waitSeconds)
  if (!preflight.ok) {
    return reportAskFailure(deps, flags, { code: 'invalid_draft', check_id: 'draft', exit_code: EXIT.usage, message: preflight.error, remedy: 'fix the reported field and retry' })
  }
  const credential = deps.store.load()!
  let semanticImages: string[]
  try {
    semanticImages = semanticMediaIds(flags.image ?? [], deps.cwd)
  } catch (err) {
    return reportAskFailure(deps, flags, { code: 'invalid_input', check_id: 'media', exit_code: EXIT.usage,
      message: `Could not fingerprint an image: ${String(err)}`, remedy: 'fix the reported image and retry' })
  }
  const semantic = buildAskDraft(config, built, flags, source.invocation, semanticImages, waitSeconds)
  if (!semantic.ok) {
    return reportAskFailure(deps, flags, { code: 'invalid_draft', check_id: 'draft', exit_code: EXIT.usage, message: semantic.error, remedy: 'fix the reported field and retry' })
  }
  const attempt = beginSendAttempt({
    env: deps.env, credential, fingerprint: sendDraftFingerprint(semantic.draft, credential), retry: false, now: now(),
  })
  if (!attempt.ok) {
    return reportAskFailure(deps, flags, { code: attempt.code, check_id: 'send_attempt', exit_code: EXIT.usage, message: attempt.message, remedy: 'retry the same ask' })
  }
  const mediaIds: string[] = []
  for (const image of flags.image ?? []) {
    if (image.startsWith('med_')) {
      mediaIds.push(image)
      continue
    }
    const uploaded = await uploadImage(deps, authed.client, image, config.media_origins.value)
    if (!uploaded.ok) {
      settleSendAttempt(deps.env, attempt.attemptId)
      if (uploaded.error !== null) deps.io.err(uploaded.error)
      return reportAskFailure(deps, flags, { code: 'media_upload_failed', check_id: 'media', exit_code: uploaded.exit,
        message: uploaded.error ?? 'The image upload failed.', remedy: 'fix the reported image or network problem, then retry the same ask' })
    }
    mediaIds.push(uploaded.mediaId)
  }
  const ready = buildAskDraft(config, built, flags, source.invocation, mediaIds, waitSeconds)
  if (!ready.ok) {
    settleSendAttempt(deps.env, attempt.attemptId)
    return reportAskFailure(deps, flags, { code: 'invalid_draft', check_id: 'draft', exit_code: EXIT.usage, message: ready.error, remedy: 'fix the reported field and retry' })
  }
  let submissionDraft: NotificationDraftT
  try {
    submissionDraft = draftForServerCapabilities(ready.draft, await authed.client.capabilities(ready.platform))
  } catch (err) {
    settleSendAttempt(deps.env, attempt.attemptId)
    return reportError(deps, err)
  }
  const foregroundSession = activeSession?.sessionId !== undefined && submissionDraft.source?.session_id === activeSession.sessionId
    ? activeSession.sessionId : null
  const foregroundGeneration = foregroundSession === null || activeSession?.harness !== 'openclaw' ? null
    : activeOpenclawGeneration(foregroundSession, deps.env)
  log(deps).info('send.attempt', { attempt_id: attempt.attemptId, idempotency_key: attempt.idempotencyKey, replay: attempt.replay, held_wait_seconds: waitSeconds })
  let receipt: SubmissionReceipt
  const submittedAt = now()
  try {
    // Returns at acceptance: every second inside the harness limit goes to
    // the answer, and `notifai status` shows what the devices did.
    receipt = await authed.client.submit({ idempotency_key: attempt.idempotencyKey, draft: submissionDraft }, 0)
  } catch (err) {
    settleSendAttempt(deps.env, attempt.attemptId)
    const exit = reportError(deps, err)
    if (exit === EXIT.network) {
      deps.io.err('The service may have accepted this question before the connection failed; it expires by itself at the end of its window. Run the same `notifai ask --wait` again to ask once more.')
    }
    return exit
  }
  settleSendAttempt(deps.env, attempt.attemptId)
  if (foregroundSession !== null && foregroundGeneration !== null) {
    let recorded = false
    try {
      recorded = recordOpenclawForegroundReply(foregroundSession, receipt.request_id, foregroundGeneration, deps.env)
    } catch (err) {
      deps.io.err(`Could not retain ownership of ${receipt.request_id}: ${String(err)}`)
    }
    if (!recorded) {
      deps.io.err(`The creating OpenClaw generation can no longer own ${receipt.request_id}; inspect the submitted request before acting on a reply.`)
      if (json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, false, 'answer_result')))
      return EXIT.failed
    }
  }
  const notifiedSession = submissionDraft.source?.session_id
  if (notifiedSession !== undefined) recordSessionNotified(notifiedSession, deps.env, now())
  const dueAt = replyWindowDue(receipt, submittedAt, submissionDraft.reply?.expires_in_seconds)
  const deadlineIso = new Date(Number.isFinite(dueAt) ? dueAt : deadline).toISOString()
  log(deps).info('send.submitted', {
    request_id: receipt.request_id, kind: 'question', title_chars: submissionDraft.presentation.title.length,
    overall: receipt.overall, replayed: receipt.replayed, agent_acknowledgement_required: receipt.agent_acknowledgement_required,
    deliveries: receipt.deliveries.length, wait_seconds: 0, held_wait_seconds: waitSeconds, exit: EXIT.ok,
  })
  // The output states the wait before it starts. With --json stdout stays one
  // object, printed when the wait ends, so the statement goes to stderr.
  const say = (line: string): void => (json ? deps.io.err(line) : deps.io.out(line))
  say(`Question submitted as ${receipt.request_id}; waiting up to ${waitSeconds}s for the answer (until ${new Date(deadline).toISOString()}). Keep this command running until it returns.`)

  // A signal withdraws the question at once, as best effort: the service would
  // end it at the deadline anyway, but a wait the User interrupted should not
  // leave a question nobody is waiting for on their devices.
  let signalled: Signal | null = null
  let onSignal: (signal: Signal) => void = () => {}
  const interrupted = new Promise<'signal'>((resolve) => {
    onSignal = (signal) => {
      signalled = signal
      resolve('signal')
    }
  })
  const unsubscribe = subscribeSignals(deps, (signal) => onSignal(signal))
  const waited = (): number => Math.round((now() - startedAt) / 1000)
  const unreachable = (): number => {
    log(deps).error('cli.error', { kind: 'network', operation: 'reply_wait', request_id: receipt.request_id, degraded: true,
      message: 'the held wait ended while the server was unreachable or faulting' })
    deps.io.err(degradedWaitWarning(receipt.request_id))
    deps.io.err(`The service was unreachable at the end of the wait. An answer may be waiting until ${deadlineIso}: \`notifai replies ${receipt.request_id}\`; the question expires then by itself.`)
    if (json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, true, 'answer_result')))
    return EXIT.network
  }
  try {
    const outcome = await Promise.race([
      waitForReply(authed.client, receipt.request_id, {
        timeoutSeconds: Math.max(0, (deadline - now()) / 1000), afterSeq: 0, now: deps.now, sleep: deps.sleep,
        ...(Number.isFinite(dueAt) ? { expiresAt: dueAt } : {}),
      }),
      interrupted,
    ])
    if (outcome === 'signal') {
      try {
        await authed.client.closeReplies(receipt.request_id, 'retire')
      } catch (err) {
        log(deps).error('cli.error', { kind: 'network', operation: 'held_wait_withdraw', request_id: receipt.request_id,
          message: err instanceof Error ? err.message : String(err) })
      }
      log(deps).info('ask.held_wait', { request_id: receipt.request_id, outcome: 'withdrawn', signal: signalled, waited_seconds: waited() })
      deps.io.err(`Interrupted (${signalled ?? 'signal'}): the question is withdrawn from the User's devices.`)
      if (json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, false, 'answer_result')))
      return EXIT.noReply
    }
    if (outcome.degraded) return unreachable()
    if (outcome.closed === true) {
      // The window closed early with no answer (the User dismissed it):
      // nothing more can arrive, and it is already off the devices.
      log(deps).info('ask.held_wait', { request_id: receipt.request_id, outcome: 'expired', waited_seconds: waited() })
      deps.io.err(UNANSWERED)
      if (json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, false, 'answer_result')))
      return EXIT.noReply
    }
    // Answered, or the wait ended. Either way one close under the server's
    // reply fence settles it: it selects the latest answer, a correction or an
    // answer that landed at the deadline included, or it withdraws the
    // question from the devices when there is none.
    let response: ListRepliesResponse | CloseRepliesResponse
    try {
      response = await authed.client.closeReplies(receipt.request_id, 'deliver')
    } catch (err) {
      if (err instanceof NetworkError || isRetryableReplyPollError(err)) return unreachable()
      const exit = reportError(deps, err, { operation: 'reply_delivery_close', request_id: receipt.request_id })
      deps.io.err(`Could not confirm the answer handoff for ${receipt.request_id}. No answer was returned; inspect the request before acting on it.`)
      if (json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, true, 'answer_result')))
      return exit
    }
    if (response.replies.length === 0) {
      log(deps).info('ask.held_wait', { request_id: receipt.request_id, outcome: 'timed_out', waited_seconds: waited() })
      deps.io.err(UNANSWERED)
      if (json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, false, 'answer_result')))
      return EXIT.noReply
    }
    if (!selectedForClaimedDelivery(response)) {
      log(deps).error('cli.error', { kind: 'reply_delivery_unconfirmed', operation: 'reply_delivery_close', request_id: receipt.request_id,
        close_disposition: 'close_disposition' in response ? response.close_disposition : null })
      deps.io.err(`Could not confirm the answer handoff for ${receipt.request_id}. The question may have been closed elsewhere; no answer was returned.`)
      if (json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, true, 'answer_result')))
      return EXIT.failed
    }
    recordReplies(deps, receipt.request_id, response.replies)
    // A program outside any harness has no agent to write the
    // acknowledgement, so Notifai records the fixed receipt at once.
    let answered: ListRepliesResponse = response
    if (route.harnesses.length === 0 && answered.agent_acknowledgement === null) {
      try {
        const recorded = await authed.client.putAgentAcknowledgement(receipt.request_id, { text: PROGRAM_RECEIPT })
        answered = { ...answered, agent_acknowledgement: recorded.agent_acknowledgement }
      } catch (err) {
        log(deps).error('cli.error', { kind: 'network', operation: 'program_receipt', request_id: receipt.request_id,
          message: err instanceof Error ? err.message : String(err) })
      }
    }
    log(deps).info('ask.held_wait', { request_id: receipt.request_id, outcome: 'answered', waited_seconds: waited() })
    if (json) {
      deps.io.out(JSON.stringify(replyResultJson(answered, false, receipt, 'answer_result')))
    } else {
      printReplies(deps, answered.replies)
      printAcknowledgementStatus(deps, answered)
    }
    if (foregroundSession !== null && foregroundSession === notifiedSession) {
      const handoffExit = await reportForegroundAnswer(deps, authed.client, foregroundSession, receipt.request_id)
      if (handoffExit !== EXIT.ok) return handoffExit
    }
    return EXIT.ok
  } catch (err) {
    // The submission already succeeded; a wait fault must not read as "the
    // question failed". The durable request is named, and the typed recovery.
    if (err instanceof ApiCallError || err instanceof NetworkError) {
      log(deps).error('cli.error', { kind: err instanceof ApiCallError ? 'api' : 'network', operation: 'reply_wait', request_id: receipt.request_id,
        ...(err instanceof ApiCallError ? { status: err.status, code: err.code } : {}), message: err.message })
      deps.io.err(`notifai: the wait for ${receipt.request_id} failed (${err instanceof ApiCallError ? err.code : 'network'}: ${err.message}).`)
      deps.io.err(`An answer may be waiting until ${deadlineIso}: \`notifai replies ${receipt.request_id}\`; the question expires then by itself.`)
      if (json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, true, 'answer_result')))
      if (err instanceof ApiCallError) {
        if (err.code === 'auth_required' || err.code === 'machine_revoked') return EXIT.auth
        return err.status >= 500 || err.status === 429 || err.status === 408 ? EXIT.network : EXIT.failed
      }
      return EXIT.network
    }
    return reportError(deps, err)
  } finally {
    unsubscribe()
  }
}

/** Test seam for the signals a held wait withdraws on; production subscribes to the process. */
export type HeldWaitSignalSeam = (handler: (signal: Signal) => void) => () => void
