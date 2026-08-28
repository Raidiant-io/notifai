import {
  CAPABILITIES_V1,
  REPLY_MAX_WINDOW_SECONDS,
  validateDraft,
  type ListRepliesResponse,
  type ReplyView,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { ApiCallError, NetworkError } from './client.js'
import type { FlagOverrides, loadConfig } from './config.js'
import { MIN_REPLY_WINDOW_SECONDS, readSessionState } from './hooks.js'
import { enableProject, projectBinding } from './project-enablement.js'
import {
  buildDraft,
  formatReceipt,
  receiptExitCode,
  rejectAccidentalEscapedNewlines,
  validateMediaInputs,
  type SendFlags,
} from './send.js'
import { recordObservedDeliveryProof, setupProofProject } from './commands-setup-proof.js'
import {
  EXIT,
  authedClient,
  loadLoggedConfig,
  log,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import { sourceContextHarnessSession } from './commands-harness-context.js'
import { resolveCommandSession } from './command-session.js'
import {
  beginSendAttempt,
  semanticMediaIds,
  sendDraftFingerprint,
  settleSendAttempt,
} from './send-attempts.js'
import {
  acknowledgementCommand,
  printAcknowledgementStatus,
  resolveDraftInvocation,
  uploadImage,
  waitForReply,
} from './commands-send-support.js'

// ---------------------------------------------------------------------------
// send / status
// ---------------------------------------------------------------------------


export async function sendCommand(
  deps: CommandDeps,
  flags: SendFlags & {
    json?: boolean
    wait?: number
    noWait?: boolean
    replyTimeout?: number
    idempotencyKey?: string
    retry?: boolean
    baseUrl?: string
  },
): Promise<number> {
  if (flags.retry === true && flags.idempotencyKey !== undefined) {
    deps.io.err('Pass --retry or --idempotency-key, not both.')
    return EXIT.usage
  }
  const hasChoice = Array.isArray(flags.choice)
    ? flags.choice.length > 0
    : flags.choice !== undefined
  if (flags.reply && flags.kind !== undefined && flags.kind !== 'question') {
    deps.io.err(`--kind ${flags.kind} cannot be combined with --reply; a reply request is a question.`)
    return EXIT.usage
  }
  // Kind now decides the sound a notification arrives with, so it is asked for
  // at the boundary rather than defaulted silently: an unlabelled send would
  // reach the user as ordinary news whatever actually happened.
  if (!flags.reply && flags.kind === undefined) {
    deps.io.err(
      '--kind is required: say what this notification is. ' +
        'update (news) · done (finished) · failed (terminal failure) · blocked (cannot proceed; no User reply would resume it). ' +
        '--reply makes it a question without --kind.',
    )
    return EXIT.usage
  }
  if (!flags.reply && flags.kind === 'question') {
    deps.io.err('--kind question requires --reply so the question can be answered.')
    return EXIT.usage
  }
  if (
    !flags.reply &&
    (flags.replyTimeout !== undefined || flags.replyWindow !== undefined || hasChoice)
  ) {
    deps.io.err('Use --reply with --reply-timeout, --reply-window, or --choice.')
    return EXIT.usage
  }
  const replyTimeout = flags.replyTimeout ?? 900
  if (flags.reply && !isNonNegativeInteger(replyTimeout)) {
    deps.io.err('--reply-timeout must be a non-negative integer number of seconds.')
    return EXIT.usage
  }
  // Asking while declaring that nothing will wait for the answer. The reply is
  // captured server-side and then unreachable: only a blocking send waits for
  // it, and the hook path drains questions registered by `ask`, never a send's
  // request id. So the user gets a real button, taps it, and nothing happens —
  // worse than a banner that never asked, because it spends their attention
  // and their trust in the channel.
  if (flags.reply && replyTimeout === 0) {
    deps.io.err(
      'A question needs someone to hear the answer, so --reply cannot be combined ' +
        'with --reply-timeout 0.\n' +
        'To ask and end the turn, use `notifai ask` — the turn-end hook returns the answer.\n' +
        'To announce finished work, drop --reply and its choices.',
    )
    return EXIT.usage
  }
  if (
    flags.reply &&
    flags.replyWindow !== undefined &&
    (!Number.isInteger(flags.replyWindow) ||
      flags.replyWindow < MIN_REPLY_WINDOW_SECONDS ||
      flags.replyWindow > REPLY_MAX_WINDOW_SECONDS)
  ) {
    deps.io.err(
      `--reply-window must be an integer from ${MIN_REPLY_WINDOW_SECONDS} to ${REPLY_MAX_WINDOW_SECONDS} seconds.`,
    )
    return EXIT.usage
  }
  const escapedBody = rejectAccidentalEscapedNewlines(flags.body, flags.literalBackslashN)
  if (escapedBody !== null) {
    deps.io.err(escapedBody)
    return EXIT.usage
  }
  const mediaInputError = validateMediaInputs(flags.image, flags.imageAlt)
  if (mediaInputError !== null) {
    deps.io.err(mediaInputError)
    return EXIT.usage
  }
  const config = loadLoggedConfig(deps, {
    cwd: deps.cwd,
    env: deps.env,
    flags: { base_url: flags.baseUrl, wait_seconds: flags.wait } as FlagOverrides,
  })
  const source = resolveDraftInvocation(
    deps,
    flags,
    sourceContextHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)()),
  )
  if (!source.ok) {
    deps.io.err(source.error)
    return EXIT.usage
  }
  let semanticImages: string[]
  try {
    semanticImages = semanticMediaIds(flags.image ?? [], deps.cwd)
  } catch (err) {
    deps.io.err(`Could not fingerprint an image for safe retry: ${String(err)}`)
    return EXIT.usage
  }
  const semanticBuild = buildDraft(
    config,
    { ...flags, ...(semanticImages.length > 0 ? { image: semanticImages } : {}) },
    source.invocation,
  )
  if (!semanticBuild.ok) {
    deps.io.err(semanticBuild.error)
    return EXIT.usage
  }
  if (semanticBuild.draft.project !== undefined) {
    const binding = projectBinding(deps.cwd, deps.env, semanticBuild.draft.project)
    if (binding !== null) enableProject(binding)
  }
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  const credential = deps.store.load()!
  const attempt = beginSendAttempt({
    env: deps.env,
    credential,
    fingerprint: sendDraftFingerprint(semanticBuild.draft, credential),
    retry: flags.retry === true,
    ...(flags.idempotencyKey === undefined ? {} : { idempotencyKey: flags.idempotencyKey }),
    now: (deps.now ?? Date.now)(),
  })
  if (!attempt.ok) {
    deps.io.err(`${attempt.code}: ${attempt.message}`)
    return EXIT.usage
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
      return uploaded.exit
    }
    mediaIds.push(uploaded.mediaId)
  }
  flags = { ...flags, image: mediaIds }
  const build = buildDraft(config, flags, source.invocation)
  if (!build.ok) {
    settleSendAttempt(deps.env, attempt.attemptId)
    deps.io.err(build.error)
    return EXIT.usage
  }
  const capabilities = CAPABILITIES_V1.describe(build.platform)
  if (!capabilities) {
    settleSendAttempt(deps.env, attempt.attemptId)
    deps.io.err(`No capability contract is available for ${build.platform}.`)
    return EXIT.usage
  }
  const validation = validateDraft(build.draft, capabilities)
  if (!validation.ok) {
    settleSendAttempt(deps.env, attempt.attemptId)
    for (const issue of validation.errors) deps.io.err(`${issue.path}: ${issue.message}`)
    return EXIT.usage
  }
  for (const warning of validation.warnings) {
    deps.io.err(`Heads up (${warning.path}): ${warning.message}`)
  }
  emitSendWarnings(deps, flags, config)
  if (
    !flags.reply &&
    (flags.title.trim().endsWith('?') || flags.body.trim().endsWith('?'))
  ) {
    deps.io.err(
      'Heads up: this notification ends with a question but has no reply action. Add --reply (and optionally --choice) so it can be answered from the notification.',
    )
  }
  const waitSeconds = flags.noWait ? 0 : config.wait_seconds.value
  const idempotencyKey = attempt.idempotencyKey
  // Persist the retry identity before entering the ambiguous network boundary.
  // If the process is killed after the server accepts but before a response,
  // this is the only durable way to reconstruct the same Agent Event key.
  log(deps).info('send.attempt', {
    attempt_id: attempt.attemptId,
    idempotency_key: idempotencyKey,
    replay: attempt.replay,
  })
  let receipt: SubmissionReceipt
  try {
    receipt = await authed.client.submit(
      { idempotency_key: idempotencyKey, draft: build.draft },
      waitSeconds,
    )
  } catch (err) {
    const exit = reportError(deps, err)
    if (exit === EXIT.network) {
      deps.io.err(
        'The server may have accepted this Notification Request before the connection failed. ' +
          'Re-run the exact semantic send with `--retry`; the CLI will reuse its opaque attempt identity.',
      )
    }
    if (err instanceof ApiCallError && err.code === 'no_active_devices') {
      deps.io.err(
        'After setup succeeds, repeat this exact original Notification Request with `--retry`; ' +
          'the setup verification request does not replace this Agent Event.',
      )
    }
    if (!(exit === EXIT.network || (err instanceof ApiCallError && err.code === 'no_active_devices'))) {
      settleSendAttempt(deps.env, attempt.attemptId)
    } else {
      deps.io.err(`Opaque retry attempt: ${attempt.attemptId}. Re-run the exact semantic send with \`--retry\`; do not retry automatically.`)
    }
    return exit
  }
  settleSendAttempt(deps.env, attempt.attemptId)
  const receiptExit = receiptExitCode(receipt)
  // The single most useful line in the log: it ties the local invocation to
  // the server-side request id, which is what every later question about this
  // notification ("did it arrive?", "which device?") is asked in terms of.
  log(deps).info('send.submitted', {
    request_id: receipt.request_id,
    kind: flags.reply ? 'question' : (flags.kind ?? 'update'),
    title_chars: flags.title.length,
    overall: receipt.overall,
    replayed: receipt.replayed,
    agent_acknowledgement_required: receipt.agent_acknowledgement_required,
    deliveries: receipt.deliveries.length,
    wait_seconds: waitSeconds,
    exit: receiptExit,
  })
  log(deps).info('send.outcome', {
    request_id: receipt.request_id,
    overall: receipt.overall,
    // Per device, because "it said accepted but nothing arrived" is answered
    // by which device reached which state and why the provider said so.
    devices: receipt.deliveries.map((delivery) => ({
      device: delivery.device_name,
      state: delivery.state,
      attempts: delivery.attempts,
      provider_status: delivery.provider_status,
      provider_reason: delivery.provider_reason,
    })),
    ...(receipt.warnings.length > 0 ? { warnings: receipt.warnings } : {}),
  })
  if (!flags.json) {
    const quietOrdinarySuccess =
      !flags.reply &&
      receipt.overall === 'provider_accepted_all' &&
      receipt.warnings.length === 0
    if (!quietOrdinarySuccess) deps.io.out(formatReceipt(receipt))
  }

  // A zero wait can no longer reach here: --reply guarantees a positive one.
  if (!flags.reply || receiptExit !== EXIT.ok) {
    if (flags.json) {
      deps.io.out(
        flags.reply
          ? JSON.stringify(unansweredReplyResultJson(receipt, false))
          : JSON.stringify(receipt, null, 2),
      )
    }
    return receiptExit
  }

  try {
    const result = await waitForReply(authed.client, receipt.request_id, {
      timeoutSeconds: replyTimeout,
      afterSeq: 0,
      now: deps.now,
      sleep: deps.sleep,
    })
    recordReplies(deps, receipt.request_id, result.response.replies)
    if (flags.json) {
      deps.io.out(
        JSON.stringify(replyResultJson(result.response, result.degraded, receipt)),
      )
    } else if (result.response.replies.length > 0) {
      printReplies(deps, result.response.replies)
      printAcknowledgementStatus(deps, result.response)
    } else {
      printNoReply(deps, receipt.request_id, result.response.reply_expires_at)
      printAcknowledgementStatus(deps, result.response)
    }
    if (result.degraded) {
      log(deps).error('cli.error', {
        kind: 'network',
        operation: 'reply_wait',
        request_id: receipt.request_id,
        degraded: true,
        message: 'the reply wait ended while the server was unreachable or faulting',
      })
      deps.io.err(degradedWaitWarning(receipt.request_id))
      return EXIT.network
    }
    if (result.timedOut) {
      deps.io.err(
        `No reply yet. Retrieve it with \`notifai replies ${receipt.request_id}\` or retire the question with ` +
          `\`notifai close ${receipt.request_id}\`. ` +
          `This is a reply-wait timeout, not a Delivery or Companion Receipt failure — check with \`notifai status ${receipt.request_id}\`.`,
      )
    }
    return result.timedOut ? EXIT.noReply : EXIT.ok
  } catch (err) {
    // The send already succeeded durably; a wait fault must not read as "send
    // failed". Permanent poll errors (auth, closed window, not found) still
    // surface, but always name the durable request and point at recovery.
    if (err instanceof ApiCallError || err instanceof NetworkError) {
      log(deps).error('cli.error', {
        kind: err instanceof ApiCallError ? 'api' : 'network',
        operation: 'reply_wait',
        request_id: receipt.request_id,
        ...(err instanceof ApiCallError ? { status: err.status, code: err.code } : {}),
        message: err.message,
      })
      deps.io.err(
        `notifai: reply wait failed for ${receipt.request_id} (${err instanceof ApiCallError ? err.code : 'network'}: ${err.message}). ` +
          `Delivery and Companion Receipt are independent — check with \`notifai status ${receipt.request_id}\` and retry with \`notifai replies ${receipt.request_id}\`.`,
      )
      // JSON callers still get their one object: the durable receipt, no
      // replies, and `degraded: true` — "could not find out", not "no answer".
      if (flags.json) deps.io.out(JSON.stringify(unansweredReplyResultJson(receipt, true)))
      if (err instanceof ApiCallError) {
        if (err.code === 'auth_required' || err.code === 'machine_revoked') return EXIT.auth
        return err.status >= 500 || err.status === 429 || err.status === 408
          ? EXIT.network
          : EXIT.failed
      }
      return EXIT.network
    }
    return reportError(deps, err)
  }
}

function emitSendWarnings(
  deps: CommandDeps,
  flags: SendFlags,
  config: ReturnType<typeof loadConfig>,
): void {
  if (flags.title.length > 40) {
    deps.io.err(
      `Heads up: this title is ${flags.title.length} characters; notification titles work best around 40 characters or fewer.`,
    )
  }
  if (/^(?:update|done|question|failed|blocked)\s*(?:[·:—-]|$)/i.test(flags.title.trim())) {
    deps.io.err(
      'Heads up: keep the title to the specific substance. Put notification type in --kind; Project identity is inferred separately.',
    )
  }
  if (
    flags.collapseKey === undefined &&
    config.collapse_key.value !== null &&
    config.collapse_key.source.startsWith('global:')
  ) {
    deps.io.err(
      'Heads up: collapse_key comes from machine-global config, so unrelated notifications may replace each other. Prefer a project or command-specific --collapse-key.',
    )
  }
  if (flags.ttl !== undefined && flags.ttl > 259_200) {
    deps.io.err(
      'Heads up: this explicit --ttl is longer than 72 hours; stale notifications may arrive after they are useful.',
    )
  }
}

export async function repliesCommand(
  deps: CommandDeps,
  requestedId: string | undefined,
  flags: { wait?: number; after?: number; json?: boolean; pending?: boolean },
): Promise<number> {
  const waitSeconds = flags.wait ?? 0
  const afterSeq = flags.after ?? 0
  if (!isNonNegativeInteger(waitSeconds)) {
    deps.io.err('--wait must be a non-negative integer number of seconds.')
    return EXIT.usage
  }
  if (!isNonNegativeInteger(afterSeq)) {
    deps.io.err('--after must be a non-negative integer sequence number.')
    return EXIT.usage
  }

  if (flags.pending === true && requestedId !== undefined) {
    deps.io.err('Pass a request id or --pending, not both.')
    return EXIT.usage
  }
  let requestIds = requestedId === undefined ? [] : [requestedId]
  let lifecycleSessionId: string | undefined
  if (flags.pending === true) {
    const session = resolveCommandSession(deps)
    if (session === null) {
      deps.io.err('No active session pointer is available in this directory.')
      return EXIT.noReply
    }
    const sessionId = session.sessionId
    lifecycleSessionId = sessionId
    // Every delivered question in the session's queue, in registration order —
    // an agent may have several outstanding at once.
    const state = readSessionState(sessionId, deps.env)
    const pending = Array.isArray(state.pending) ? state.pending : []
    requestIds = pending
      .map((entry) => entry.request_id)
      .filter((id): id is string => id !== undefined)
    const unsent = pending.filter((entry) => entry.request_id === undefined)
    if (requestIds.length === 0) {
      // `--json` is a promise about stdout, and an empty result is still a
      // result: a caller that asked for machine-readable output must not have
      // to parse an English sentence to learn there was nothing pending.
      if (flags.json === true) {
        deps.io.out(
          JSON.stringify(
            {
              session_id: sessionId,
              pending: unsent.map((entry) => ({
                question: entry.question,
                ...(entry.question_id === undefined ? {} : { question_id: entry.question_id }),
              })),
              replies: [],
            },
            null,
            2,
          ),
        )
      } else if (unsent.length > 0) {
        for (const entry of unsent) {
          deps.io.out(
            entry.question_id === undefined
              ? `unpushed question: ${entry.question}`
              : `unpushed question ${entry.question_id}: ${entry.question}`,
          )
        }
        deps.io.out('Retire one with `notifai close <question_id>` so a later Stop will not send it.')
      } else {
        deps.io.err(`Session ${sessionId} has no pushed question pending.`)
      }
      return unsent.length > 0 ? EXIT.ok : EXIT.noReply
    }
    if (unsent.length > 0 && flags.json !== true) {
      for (const entry of unsent) {
        deps.io.out(
          entry.question_id === undefined
            ? `unpushed question: ${entry.question}`
            : `unpushed question ${entry.question_id}: ${entry.question}`,
        )
      }
    }
  }
  if (requestIds.length === 0) {
    deps.io.err('Pass a request id or --pending.')
    return EXIT.usage
  }

  const config = loadLoggedConfig(deps, {
    cwd: deps.cwd,
    env: deps.env,
    ...(lifecycleSessionId === undefined ? {} : { sessionId: lifecycleSessionId }),
  })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    let anyReplies = false
    const degradedRequestIds: string[] = []
    let allTimedOut = true
    const jsonBodies: object[] = []
    for (const requestId of requestIds) {
      try {
        const result = await waitForReply(authed.client, requestId, {
          timeoutSeconds: waitSeconds,
          afterSeq,
          now: deps.now,
          sleep: deps.sleep,
        })
        recordReplies(deps, requestId, result.response.replies)
        if (flags.json) {
          jsonBodies.push(replyResultJson(result.response, result.degraded))
        } else if (result.response.replies.length > 0) {
          if (flags.pending === true) deps.io.out(`pending request ${requestId}`)
          printReplies(deps, result.response.replies)
          printAcknowledgementStatus(deps, result.response)
        } else {
          printNoReply(deps, requestId, result.response.reply_expires_at)
          printAcknowledgementStatus(deps, result.response)
        }
        anyReplies ||= result.response.replies.length > 0
        if (result.degraded) degradedRequestIds.push(requestId)
        allTimedOut &&= result.timedOut
      } catch (err) {
        recordDegradedReplyWaits(deps, degradedRequestIds)
        return reportError(deps, err, { operation: 'reply_wait', request_id: requestId })
      }
    }
    if (flags.json) {
      // One request keeps the response shape agents already parse; several
      // (only possible via --pending) arrive as an array in queue order.
      deps.io.out(JSON.stringify(jsonBodies.length === 1 ? jsonBodies[0] : jsonBodies, null, 2))
    }
    if (degradedRequestIds.length > 0) {
      recordDegradedReplyWaits(deps, degradedRequestIds)
      // Name a request whose polls actually degraded, not merely the first item
      // in a multi-request queue that may have completed cleanly.
      deps.io.err(degradedWaitWarning(degradedRequestIds[0]!))
      return EXIT.network
    }
    if (anyReplies) return EXIT.ok
    return allTimedOut ? EXIT.noReply : EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}


function recordDegradedReplyWaits(deps: CommandDeps, requestIds: readonly string[]): void {
  if (requestIds.length === 0) return
  log(deps).error('cli.error', {
    kind: 'network',
    operation: 'reply_wait',
    request_ids: requestIds,
    degraded: true,
    message: 'the reply wait ended while the server was unreachable or faulting',
  })
}

/**
 * Shared by every surface that waits: "the user did not answer" and "I could
 * not find out" must not look the same, because agents branch on the exit code
 * and one of those two branches is safe to proceed from.
 *
 * Delivery / Companion Receipt / OS presentation are separate facts — a wait
 * fault is not evidence that the push failed.
 */
function degradedWaitWarning(requestId: string): string {
  return (
    `notifai: the wait for ${requestId} ended while the server was unreachable or faulting, ` +
    `so this is "could not find out", not "no answer" — the request is still durable and the ` +
    `reply may already be waiting (Provider Acceptance and Companion Receipt are independent). ` +
    `Retry with \`notifai replies ${requestId}\`.`
  )
}
function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}


/**
 * The one JSON object `send --reply --json` prints, whatever happens after the
 * durable submit. Embedding the receipt keeps stdout a single parseable line;
 * `replies` (from a wait) omits it because there is no submission to report.
 */
function replyResultJson(
  response: ListRepliesResponse,
  degraded: boolean,
  receipt?: SubmissionReceipt,
): object {
  return {
    type: 'reply_result',
    ...(receipt !== undefined ? { receipt } : {}),
    request_id: response.request_id,
    reply_expires_at: response.reply_expires_at,
    replies: response.replies,
    agent_acknowledgement_required: response.agent_acknowledgement_required,
    agent_acknowledgement: response.agent_acknowledgement,
    agent_acknowledgement_text_required: response.agent_acknowledgement_text_required,
    acknowledgement_command: acknowledgementCommand(
      response.request_id,
      response.agent_acknowledgement_required,
      response.agent_acknowledgement_text_required,
      response.agent_acknowledgement,
      response.replies.length > 0,
    ),
    degraded,
  }
}

/**
 * The reply_result for a reply send that has no answer to report — a receipt
 * failure, or a wait that faulted. Same shape, same single line; `degraded`
 * distinguishes "the wait could not find out" from "delivery already failed".
 */
function unansweredReplyResultJson(receipt: SubmissionReceipt, degraded: boolean): object {
  return {
    type: 'reply_result',
    receipt,
    request_id: receipt.request_id,
    replies: [],
    agent_acknowledgement_required: receipt.agent_acknowledgement_required,
    agent_acknowledgement_text_required: receipt.agent_acknowledgement_text_required,
    agent_acknowledgement: null,
    acknowledgement_command: null,
    degraded,
  }
}


function recordReplies(deps: CommandDeps, requestId: string, replies: readonly ReplyView[]): void {
  const logger = log(deps)
  for (const reply of replies) {
    logger.info('reply.received', {
      request_id: requestId,
      sequence: reply.seq,
      device: reply.device_name,
      text_chars: reply.text.length,
      answers_count: reply.answers?.length ?? 0,
      source: reply.source,
    })
  }
}

function printReplies(deps: CommandDeps, replies: ReplyView[]): void {
  for (const reply of replies) deps.io.out(`reply from ${reply.device_name}: ${reply.text}`)
  const contradiction = contradictingAnswer(replies)
  if (contradiction !== null) deps.io.err(contradiction)
}

/**
 * The correction note for a wait that saw more than one answer.
 *
 * A later reply that conflicts with an earlier one is a correction, so the
 * latest answer is the one that counts. The server retires the question on
 * the other devices the moment one answers, which makes this rare; it is
 * still reachable, because a device can answer between the first reply
 * landing and its retirement arriving.
 *
 * Ordered by seq, so `replies.at(-1)` is the answer to act on.
 */
export function contradictingAnswer(replies: ReplyView[]): string | null {
  const winner = replies.at(-1)
  if (winner === undefined || replies.length < 2) return null
  const key = (reply: ReplyView) =>
    reply.answers.length > 0 ? JSON.stringify(reply.answers) : reply.text
  const corrected = replies.slice(0, -1).filter((reply) => key(reply) !== key(winner))
  if (corrected.length === 0) return null
  const names = [...new Set(corrected.map((reply) => reply.device_name))].join(', ')
  return (
    `note: "${winner.text}" from ${winner.device_name} is the answer that counts — a later ` +
    `answer corrects an earlier one. Earlier differing answers from ${names} were superseded.`
  )
}

function printNoReply(deps: CommandDeps, requestId: string, expiresAt?: string | null): void {
  // A harness hook may have retired this question, in which case promising an
  // open window would send the caller back to wait for an answer the server
  // will now refuse.
  const closed = expiresAt != null && Date.parse(expiresAt) <= Date.now()
  deps.io.out(
    closed
      ? `no reply for request ${requestId}; the reply window has closed`
      : `no reply yet for request ${requestId}; the reply window remains open`,
  )
}

export async function statusCommand(
  deps: CommandDeps,
  requestId: string,
  flags: { json?: boolean },
): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const snapshot = await authed.client.evidence(requestId)
    recordObservedDeliveryProof(deps, snapshot, setupProofProject(deps, config.project.value))
    if (flags.json) {
      deps.io.out(JSON.stringify(snapshot, null, 2))
      return EXIT.ok
    }
    deps.io.out(`request ${snapshot.request_id} — ${snapshot.overall}`)
    let anyReplyReceived = false
    for (const d of snapshot.deliveries) {
      deps.io.out(`  ${d.device_name}:`)
      deps.io.out(`    Delivery: ${d.state} after ${d.attempts} attempt(s)`)
      deps.io.out(
        `    Provider Acceptance: ${d.state === 'provider_accepted' ? 'accepted' : 'not recorded'}`,
      )
      if (d.companion_receipt.state === 'observed') {
        const latency = d.companion_receipt.latency_ms
        deps.io.out(
          `    Companion Receipt (the app's delivery confirmation): observed at ${d.companion_receipt.observed_at}` +
            (latency === null ? '' : ` (${formatElapsed(latency)} after Provider Acceptance)`),
        )
      } else {
        deps.io.out(
          "    Companion Receipt (the app's delivery confirmation): unknown — not observed; this is not a failure or proof of non-receipt",
        )
      }
      // Notifai never learns whether the OS painted a banner; saying so stops
      // a reply-wait fault from being misread as "the phone never showed it".
      deps.io.out(
        '    OS presentation: not observed by Notifai — Provider Acceptance and Companion Receipt do not prove a banner was shown',
      )
      const replyEvent = d.events.find((e) => e.stage === 'reply_received')
      if (replyEvent) {
        anyReplyReceived = true
        deps.io.out(`    Reply received: yes (first at ${replyEvent.occurred_at})`)
      } else {
        deps.io.out('    Reply received: not yet recorded on this delivery')
      }
      for (const e of d.events) {
        deps.io.out(`      ${e.occurred_at}  ${e.stage}${e.reason ? ` (${e.reason})` : ''}`)
      }
    }
    deps.io.out(
      anyReplyReceived
        ? `  Reply wait: answers are on the server — collect with \`notifai replies ${snapshot.request_id}\` (a local wait fault does not erase them)`
        : `  Reply wait: no answer stored yet — a blocking wait failure is independent of Delivery above; retry with \`notifai replies ${snapshot.request_id}\``,
    )
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
}
