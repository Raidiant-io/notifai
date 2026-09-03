/** Hook-event domain handlers and the question escalation lifecycle. */
import type {
  ListRepliesResponse,
  MediaItemT,
  QuestionT,
  ReplyView,
  SourceContextT,
  SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { randomBytes } from 'node:crypto'
import { ApiCallError, isRetryableReplyPollError } from './client.js'
import { withFileLock } from './file-lock.js'
import { HARNESS_CAPABILITIES } from './harnesses.js'
import { gate, type GateReason } from './hook-gates.js'
import {
  acknowledgementBlockContext,
  amendAcceptedAnswers,
  answersContext,
  finishCommittedDelivery,
  holdForAcknowledgement,
  reconcileAcknowledgementObligations,
  resetAcknowledgementBlocks,
  settleAcceptedAnswers,
  stageAcceptedAnswers,
  stopAnswerOutput,
} from './hook-acknowledgements.js'
import { clearMatchingProjectSession, writeProjectSession } from './hook-project-sessions.js'
import { claimHandoffState, claimQuestionPush, releaseQuestionPush } from './hook-question-lock.js'
import {
  closeQuietly,
  drainOrphanRetirements,
  drainRetirements,
  finalizeReplies,
  orphanRetirements,
  pendingAnsweredByPrompt,
  retirePendings,
  retiringQuestion,
} from './hook-question-retirement.js'
import {
  clearFrozenSubmission,
  dropPendingQuestion,
  isSamePending,
  pendingQuestions,
  rememberQuestionState,
  sourceContextAtHookEvent,
  summarizeRequestIds,
} from './hook-question-state.js'
import {
  clearSessionState,
  markSessionEnded,
  pendingList,
  readSessionState,
  sessionHasEnded,
  sessionStatePath,
  updateSessionState,
  writeSessionState,
  writeSessionStateUnlocked,
} from './hook-session-state.js'
import { userPromptContextOutput } from './session-activation.js'
import type {
  AcceptedAnswerDelivery,
  AnsweredPending,
  EscalationDeliveryRoute,
  EscalationWaiterOptions,
  HookContext,
  HookEnvelope,
  HookOutcome,
  PendingQuestion,
  PendingSubmissionIntent,
  RetiringQuestion,
  SessionState,
} from './hook-types.js'
import {
  QUESTION_STOP_TEARDOWN_HEADROOM_SECONDS,
  QUESTION_SUBMISSION_COMPLETION_HEADROOM_SECONDS,
  QUESTION_WAITER_CEILING_SECONDS,
} from './question-timing.js'
import { buildDraft } from './send.js'

/**
 * The wire contract's shortest reply window. A question submitted with less
 * than this is rejected outright, and accepting one would in any case let the
 * server go on taking an answer after the waiter that owns it has returned.
 */
export const MIN_REPLY_WINDOW_SECONDS = 60

/**
 * The terminal-first wait: the question sits in the terminal for
 * `ask_grace_seconds` from when it was sent, and only then reaches companion
 * devices.
 *
 * A plain timer, and nothing else. It once polled an idle signal so it could
 * abandon the wait the moment the user touched the keyboard — necessary while
 * the wait blocked the terminal, because a user wanting to answer locally was
 * otherwise locked out of their own prompt. Presence no longer changes this
 * deterministic timer; whether the harness holds or wakes is a separate route
 * decision.
 *
 * The window is measured from registration, not from the turn's end: a
 * question the agent asked five minutes ago while it kept working has already
 * served its wait. A stamp from the future would otherwise consume the whole
 * ceiling and leave no room to answer, so it starts no later than now.
 */
async function awaitTerminalFirstWindow(
  ctx: HookContext,
  askedAt: number,
  ceilingAt: number,
): Promise<void> {
  const graceSeconds = ctx.config.ask_grace_seconds.value
  if (graceSeconds <= 0) return
  const until = Math.min(Math.min(askedAt, ctx.now()) + graceSeconds * 1000, ceilingAt)
  const remaining = until - ctx.now()
  if (remaining > 0) await ctx.sleep(remaining)
}

/**
 * A question is stored so a later hook can push it, and it reaches us from a
 * shell command, so its size is whatever the agent typed. The push itself is
 * bounded by the current 4096-byte push-provider envelopes; this bounds what
 * sits on disk in the meantime, and keeps one runaway agent from writing
 * megabytes per session.
 */
const MAX_STORED_QUESTION_CHARS = 2000

/**
 * One round of the waiter's reply poll. Short enough that several questions
 * still share one wall clock, long enough not to hammer the server.
 */
const REPLY_POLL_SECONDS = 5

/** Avoid hot-looping while a live observer cooperatively yields its claim. */
const CLAIM_HANDOFF_POLL_MS = 1_000

/**
 * Push a question and block for the answer.
 *
 * An answered question is closed the moment this wait sees the answer: the
 * first device to answer claims the question and the others are told. Until
 * that close, a later reply is a correction — so what this returns as "the"
 * answer is always the latest reply, with the full stream alongside for
 * free-text answers given in parts. An unanswered question stays open,
 * because nobody has acted on the silence yet and the next turn can still
 * collect the answer with `notifai replies`.
 */
/**
 * Put one registered question on the user's devices. Submission only — the
 * wait happens once, across every live question, in the caller.
 */
async function prepareQuestionSubmission(
  ctx: HookContext,
  options: {
    title: string
    summary: string
    body?: string
    questions: QuestionT[]
    media?: MediaItemT[] | undefined
    project?: string | undefined
    source?: SourceContextT | undefined
    /** How long the server keeps accepting an answer. */
    windowSeconds: number
    /** Absolute owner deadline persisted before submit. */
    ownerDeadlineAt: number
  },
): Promise<PendingSubmissionIntent | { error: string }> {
  const collapseKey = `notifai-hook-${randomBytes(8).toString('base64url')}`
  // A draft carrying `reply` is rejected outright if it targets a device that
  // cannot answer, so resolve the healthy companion platforms explicitly.
  const answerable = await answerableDevices(ctx)
  if (answerable.length === 0) {
    return { error: 'no device can answer a question yet; leaving this to the terminal' }
  }
  const build = buildDraft(
    ctx.config,
    {
      title: options.title,
      summary: options.summary,
      ...(options.body !== undefined ? { body: options.body } : {}),
      lifecycle: { tier: 'needs_you' },
      ...(options.project !== undefined ? { project: options.project } : {}),
      ...(options.media !== undefined ? { media: options.media } : {}),
      device: answerable,
      reply: true,
      replyWindow: Math.max(MIN_REPLY_WINDOW_SECONDS, options.windowSeconds),
      questions: options.questions,
      collapseKey,
    },
    options.source === undefined ? {} : { source: options.source },
  )
  if (!build.ok) return { error: build.error }

  return {
    request_id: `req_${randomBytes(18).toString('base64url')}`,
    idempotency_key: `hook-${randomBytes(12).toString('base64url')}`,
    collapse_key: collapseKey,
    device_ids: answerable,
    draft: build.draft,
    owner_deadline_at: options.ownerDeadlineAt,
  }
}

async function submitQuestion(
  ctx: HookContext,
  intent: PendingSubmissionIntent,
): Promise<SubmissionReceipt> {
  const receipt = await ctx.client.submit(
    {
      request_id: intent.request_id,
      idempotency_key: intent.idempotency_key,
      draft: intent.draft,
    },
    0,
  )
  if (receipt.request_id !== intent.request_id) {
    throw new Error(
      `server replay returned ${receipt.request_id}, expected reserved ${intent.request_id}`,
    )
  }
  return receipt
}

function canSubmitCompleteWindow(
  ctx: HookContext,
  intent: PendingSubmissionIntent,
  fallbackWindowSeconds: number,
): boolean {
  const frozenWindowSeconds =
    intent.draft.reply?.expires_in_seconds ?? fallbackWindowSeconds
  return (
    intent.owner_deadline_at - ctx.now() >=
    (frozenWindowSeconds + QUESTION_SUBMISSION_COMPLETION_HEADROOM_SECONDS) * 1000
  )
}

/**
 * The waiter's wait: one bounded poll across every live question at once.
 *
 * Each round polls all of them concurrently, so several questions cost the
 * same wall clock as one; the first round that finds any reply returns
 * everything found in that round, and whatever was not answered stays
 * registered. A question whose polling is permanently rejected drops out of
 * the round rather than failing the whole wait.
 */
async function waitForAnyReply(
  ctx: HookContext,
  requestIds: string[],
  timeoutSeconds: number,
  interruption?: () => 'ownership-ended' | 'new-question' | null,
): Promise<{
  byRequest: Map<string, ReplyView[]>
  degraded: boolean
  permanentFailures: Map<string, string>
  interrupted: 'ownership-ended' | 'new-question' | null
}> {
  const deadline = ctx.now() + timeoutSeconds * 1000
  let degraded = false
  let firstPoll = true
  const permanentFailures = new Map<string, string>()

  if (timeoutSeconds <= 0 || deadline <= ctx.now()) {
    return { byRequest: new Map(), degraded: false, permanentFailures, interrupted: null }
  }

  for (;;) {
    const beforePoll = interruption?.() ?? null
    if (beforePoll !== null) {
      return { byRequest: new Map(), degraded, permanentFailures, interrupted: beforePoll }
    }
    const remainingMs = Math.max(0, deadline - ctx.now())
    if (!firstPoll && remainingMs === 0) {
      return { byRequest: new Map(), degraded, permanentFailures, interrupted: null }
    }
    firstPoll = false
    const pollSeconds = Math.min(REPLY_POLL_SECONDS, Math.max(0, Math.ceil(remainingMs / 1000)))
    const results = await Promise.all(
      requestIds
        .filter((requestId) => !permanentFailures.has(requestId))
        .map(async (requestId) => {
          try {
            return { requestId, ...(await ctx.waitForFirstReply(requestId, pollSeconds)) }
          } catch (err) {
            if (isRetryableReplyPollError(err)) {
              return { requestId, replies: [] as ReplyView[], degraded: true }
            }
            return {
              requestId,
              replies: [] as ReplyView[],
              degraded: false,
              permanentFailure: replyPollFailure(err),
            }
          }
        }),
    )
    const byRequest = new Map<string, ReplyView[]>()
    for (const result of results) {
      degraded ||= result.degraded === true
      if (result.permanentFailure !== undefined) {
        permanentFailures.set(result.requestId, result.permanentFailure)
      }
      if (result.replies.length > 0) byRequest.set(result.requestId, result.replies)
    }
    const afterPoll = interruption?.() ?? null
    // SessionEnd or terminal-side retirement wins even if an in-flight poll
    // happened to return an answer. A newly registered question merely asks
    // this owner to yield; an answer already observed remains authoritative.
    if (afterPoll === 'ownership-ended') {
      return { byRequest: new Map(), degraded, permanentFailures, interrupted: afterPoll }
    }
    if (byRequest.size > 0 || permanentFailures.size === requestIds.length) {
      return { byRequest, degraded, permanentFailures, interrupted: null }
    }
    if (afterPoll === 'new-question') {
      return { byRequest: new Map(), degraded, permanentFailures, interrupted: afterPoll }
    }
  }
}

/**
 * Local lifecycle signal for a long-lived observer.
 *
 * SessionEnd and terminal-side retirement remove an owned request from pending
 * state; the detached process must stop instead of recreating that session.
 * A new unpushed question asks this owner to yield the session claim so the
 * successor Stop can submit it promptly.
 */
function waiterInterruption(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  requestIds: readonly string[],
): 'ownership-ended' | 'new-question' | null {
  if (sessionHasEnded(sessionId, env)) return 'ownership-ended'
  const pending = pendingList(readSessionState(sessionId, env))
  const owned = new Set(requestIds)
  // One question can be retired from the terminal while this observer owns
  // several. That is a per-question change, not whole-session cancellation;
  // the caller filters the changed set after each poll and keeps the rest.
  return pending.some(
    (entry) =>
      entry.request_id === undefined &&
      (entry.submission === undefined || !owned.has(entry.submission.request_id)),
  )
    ? 'new-question'
    : null
}

/** A non-retryable replies fault, with enough server identity to act on it. */
function replyPollFailure(err: unknown): string {
  return err instanceof ApiCallError
    ? `${err.code} (HTTP ${err.status}): ${err.message}`
    : String(err)
}

function permanentReplyFailureNote(failures: Map<string, string>): string | null {
  if (failures.size === 0) return null
  const details = [...failures].map(([requestId, failure]) => `${requestId}: ${failure}`).join('; ')
  return `reply polling stopped after a permanent server rejection (${details}); the affected question will be retired before its continuation owner exits`
}

/** Healthy Companion devices that advertise the current answer job. */
async function answerableDevices(ctx: HookContext): Promise<string[]> {
  const configured = ctx.config.devices.value
  const { devices } = await ctx.client.listDevices()
  return devices
    .filter(
      (device) =>
        (device.platform === 'ios' ||
          device.platform === 'macos' ||
          device.platform === 'android') &&
        device.registration_healthy &&
        device.capabilities?.includes('answer') === true &&
        device.derived_status !== 'must_update',
    )
    .filter((device) => configured === null || configured.includes(device.device_id))
    .map((device) => device.device_id)
}

const LATE_STOP_POLL_SECONDS = 4

const LATE_PROMPT_POLL_SECONDS = 3

/**
 * The one bound on answer deliveries, for every route.
 *
 * It caps two things that both used to be able to run away: how many times a
 * single accepted answer may be handed to a route before the journal gives up
 * on it, and how many answer-driven continuation generations one chain may
 * produce.
 */
export const MAX_CONTINUATION_COUNT = 3

/**
 * How many turns an answer may be *held* before it is settled unread.
 *
 * A hold is not a delivery: the route reported that it handed nothing over, so
 * the agent has not seen the answer and the wake-loop the continuation cap
 * exists to stop has not happened. Counting holds against that cap meant three
 * turns where a liveness probe could not reach a busy session were enough to
 * discard an answer the user had already given.
 *
 * It still has to end. A route that can never deliver would otherwise retry
 * every turn for the life of the session, so holds get their own, far looser
 * bound — loose because each one costs nothing and the answer is still wanted.
 */
export const MAX_HELD_DELIVERIES = 20

interface PendingPoll {
  /** The answer to act on: the latest reply, because a later one corrects. */
  reply: ReplyView | null
  /** Every reply in arrival order, for free-text answers given in parts. */
  replies: ReplyView[]
  degraded: boolean
  permanentFailure: string | null
}

/** One bounded recovery poll for a question that outlived its original wait. */
async function pollPendingReply(
  ctx: HookContext,
  pending: PendingQuestion,
  timeoutSeconds: number,
): Promise<PendingPoll> {
  if (pending.request_id === undefined) {
    return { reply: null, replies: [], degraded: false, permanentFailure: null }
  }
  try {
    const result = await ctx.waitForFirstReply(pending.request_id, timeoutSeconds)
    return {
      reply: result.replies.at(-1) ?? null,
      replies: result.replies,
      degraded: result.degraded === true,
      permanentFailure: null,
    }
  } catch (err) {
    return isRetryableReplyPollError(err)
      ? { reply: null, replies: [], degraded: true, permanentFailure: null }
      : { reply: null, replies: [], degraded: false, permanentFailure: replyPollFailure(err) }
  }
}

interface FinalizedPending {
  pending: PendingQuestion
  response: ListRepliesResponse | null
}

/** Close several windows concurrently without confusing failure with silence. */
async function finalizePendings(
  ctx: HookContext,
  pending: PendingQuestion[],
): Promise<FinalizedPending[]> {
  return Promise.all(
    pending.map(async (entry) => {
      const response = await finalizeReplies(ctx, entry.request_id!)
      ctx.log?.info('hook.retirement', {
        request_id: entry.request_id,
        attempted: true,
        proven: response !== null,
      })
      return { pending: entry, response }
    }),
  )
}

/** Convert a fenced final reply set into the exact answer handed to the model. */
function finalizedAnswer(finalized: FinalizedPending): AnsweredPending | null {
  const replies = finalized.response?.replies ?? []
  const reply = replies.at(-1)
  return reply === undefined
    ? null
    : {
        pending: finalized.pending,
        reply,
        replies,
        agent_acknowledgement_required:
          finalized.response?.agent_acknowledgement_required,
        agent_acknowledgement_text_required:
          finalized.response?.agent_acknowledgement_text_required,
      }
}

/** Persist and surface one answer without letting the two representations drift. */
function reportAnswer(
  ctx: HookContext,
  notes: string[],
  answered: AnsweredPending,
  late: boolean,
): void {
  ctx.log?.info('hook.answer', {
    answered: true,
    stage: 'queued',
    ...(late ? { late: true } : {}),
    request_id: answered.pending.request_id,
    device: answered.reply.device_name,
    text_chars: answered.reply.text.length,
  })
  notes.push(`${late ? 'late ' : ''}answer from ${answered.reply.device_name}: ${answered.reply.text}`)
}

/**
 * One bounded recovery poll across every delivered question, concurrently —
 * N questions must not multiply the hook's latency budget by N.
 */
async function pollPendingReplies(
  ctx: HookContext,
  live: PendingQuestion[],
  timeoutSeconds: number,
): Promise<{
  answered: AnsweredPending[]
  transientTrouble: boolean
  permanentFailures: Map<string, string>
}> {
  const polls = await Promise.all(
    live.map((entry) => pollPendingReply(ctx, entry, timeoutSeconds)),
  )
  const answered: AnsweredPending[] = []
  let transientTrouble = false
  const permanentFailures = new Map<string, string>()
  for (const [index, poll] of polls.entries()) {
    if (poll.reply !== null) {
      answered.push({ pending: live[index]!, reply: poll.reply, replies: poll.replies })
    }
    if (poll.degraded) transientTrouble = true
    if (poll.permanentFailure !== null) {
      permanentFailures.set(live[index]!.request_id!, poll.permanentFailure)
    }
  }
  return { answered, transientTrouble, permanentFailures }
}

/**
 * The frozen draft itself will never be accepted. Replaying it forever hides a
 * contract-skew (deleted fields, unexpected properties) as a recoverable wait.
 * Auth, conflicts, and timeouts are not this class.
 */
function isTerminalDraftRejection(err: ApiCallError): boolean {
  return err.status === 422 || (err.status === 400 && err.code === 'invalid_request')
}

// ---------------------------------------------------------------------------
// UserPromptSubmit — the user is at the keyboard
// ---------------------------------------------------------------------------

/**
 * Records presence. Retires a live question only when this prompt plausibly
 * answers it. Typing in the terminal is not by itself a resolution: the User
 * may be answering a different question on a device.
 */
export async function handleUserPromptSubmit(
  ctx: HookContext,
  envelope: HookEnvelope,
): Promise<HookOutcome> {
  const notes: string[] = []
  const sessionId = envelope.session_id
  if (!sessionId) return { notes }

  const state = readSessionState(sessionId, ctx.env)
  if (state.accepted !== undefined) {
    updateSessionState(sessionId, ctx.env, (current) => ({
      ...current,
      ...(ctx.harness === undefined ? {} : { harness: ctx.harness }),
      last_prompt_at: ctx.now(),
    }))
    if (envelope.cwd !== undefined && ctx.harness !== undefined) {
      writeProjectSession(envelope.cwd, ctx.env, sessionId, ctx.now(), ctx.harness)
    }
    const stdout = userPromptContextOutput(
      ctx.harness,
      answersContext(state.accepted.answers, state.accepted.remaining),
    )
    if (stdout !== undefined) {
      notes.push('the journaled device answer was added to the user\'s new turn')
      return {
        stdout,
        decided: false,
        notes,
        log: {
          stage: 'context-added',
          route: 'user-prompt-submit',
          request_ids: state.accepted.answers.flatMap(({ pending }) =>
            pending.request_id === undefined ? [] : [pending.request_id],
          ),
        },
      }
    }
    notes.push('a device answer is safely journaled; the next Stop will deliver it')
    return { notes }
  }
  const live = pendingList(state).filter((entry) => entry.request_id !== undefined)
  let lateAnswers: AnsweredPending[] = []
  if (live.length > 0) {
    const { answered, transientTrouble, permanentFailures } = await pollPendingReplies(
      ctx,
      live,
      LATE_PROMPT_POLL_SECONDS,
    )
    const finalized = await finalizePendings(
      ctx,
      answered.map((entry) => entry.pending),
    )
    lateAnswers = answered.map((entry) => {
      const response = finalized.find((candidate) =>
        isSamePending(candidate.pending, entry.pending),
      )?.response
      const replies = response?.replies.length ? response.replies : entry.replies
      if (response === null) {
        notes.push(
          `could not confirm the close fence for ${entry.pending.request_id}; preserving the durable answer already observed`,
        )
      }
      return {
        ...entry,
        replies,
        reply: replies.at(-1)!,
        agent_acknowledgement_required:
          response?.agent_acknowledgement_required ??
          entry.agent_acknowledgement_required,
        agent_acknowledgement_text_required:
          response?.agent_acknowledgement_text_required ??
          entry.agent_acknowledgement_text_required,
      }
    })
    if (answered.length > 0) {
      stageAcceptedAnswers(
        ctx,
        sessionId,
        lateAnswers,
        0,
      )
      for (const answer of lateAnswers) reportAnswer(ctx, notes, answer, true)
    }
    if (transientTrouble) {
      notes.push('could not check every pending question for a late answer before the prompt')
    }
    const permanentFailure = permanentReplyFailureNote(permanentFailures)
    if (permanentFailure !== null) notes.push(permanentFailure)
  }
  const matched = pendingAnsweredByPrompt(envelope.prompt, pendingList(state))
  for (const entry of matched) {
    ctx.log?.info('hook.retirement', {
      request_id: entry.request_id,
      question_id: entry.question_id,
      reason: 'prompt-matched',
      attempted: entry.request_id !== undefined,
      proven: false,
    })
  }
  // Park before dropping `pending`. If the process dies between these writes,
  // the next hook sees both copies and dedupes them; the old order could die in
  // the gap after erasing the only request/collapse/device identifiers.
  const updated = updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    const matchedNow = pendingAnsweredByPrompt(envelope.prompt, pendingList(current))
    const unmatched = pendingList(current).filter(
      (entry) => !matchedNow.some((item) => isSamePending(item, entry)),
    )
    for (const entry of matchedNow.filter((item) => item.request_id !== undefined)) {
      const retirement = retiringQuestion(entry, 'answered_elsewhere', envelope.cwd)
      if (
        retirement !== null &&
        !retiring.some((parked) => parked.request_id === retirement.request_id)
      ) {
        retiring.push(retirement)
      }
    }
    const unasked = unmatched.filter((entry) => entry.request_id === undefined)
    const stillLive = unmatched.filter((entry) => entry.request_id !== undefined)
    const remaining = [...stillLive, ...unasked]

    // Start from the whole document so fields introduced by a newer CLI remain
    // attached while this older writer applies the prompt transition it knows.
    const next: SessionState = {
      ...current,
      ...(ctx.harness === undefined ? {} : { harness: ctx.harness }),
      last_prompt_at: ctx.now(),
    }
    if (remaining.length > 0) next.pending = remaining
    else delete next.pending
    if (retiring.length > 0) next.retiring = retiring
    else delete next.retiring

    // The user typed, so whatever chain of answer-driven continuations was
    // running, a human has taken the turn and the consecutive count starts
    // over. Only a real prompt reaches here: the journal branch above returns
    // first, and a wake route's injected message always arrives while its own
    // answer is still journaled, so it can never pass for the user's presence.
    if (current.continuation !== undefined) {
      next.continuation = { ...current.continuation, count: 0 }
    }
    return matchedNow.reduce(
      (remembered, entry) => rememberQuestionState(
        remembered,
        entry,
        entry.request_id === undefined ? 'withdrawn' : 'retired',
      ),
      next,
    )
  })
  // The bridge that lets a plain `notifai ask` find the hook's canonical
  // session: an agent shell command gets no hook payload, and not every
  // harness exports an id in the same shape.
  if (envelope.cwd !== undefined && ctx.harness !== undefined) {
    writeProjectSession(envelope.cwd, ctx.env, sessionId, ctx.now(), ctx.harness)
  }

  if (lateAnswers.length > 0) {
    // UserPromptSubmit can add context to the turn already beginning. Keep the
    // accepted-answer journal until the agent acknowledges: if this process or
    // host dies around stdout, a later prompt or Stop safely replays it.
    const stdout = userPromptContextOutput(
      ctx.harness,
      answersContext(lateAnswers, 0),
    )
    if (stdout !== undefined) notes.push('the late device answer was added to the user\'s new turn')
    else notes.push('the late device answer will continue the agent at this turn’s Stop')
    return {
      notes,
      ...(stdout === undefined
        ? {}
        : {
            stdout,
            decided: false,
            log: {
              stage: 'context-added',
              route: 'user-prompt-submit',
              request_ids: lateAnswers.flatMap(({ pending }) =>
                pending.request_id === undefined ? [] : [pending.request_id],
              ),
            },
          }),
      settlementRequired: pendingList(updated).some((entry) => entry.request_id === undefined),
    }
  }
  const retired = await drainRetirements(ctx, sessionId, ctx.env)
  const orphaned = await drainOrphanRetirements(ctx, ctx.env, ctx.now())
  const swept = [...retired, ...orphaned]
  if (swept.length > 0) {
    notes.push(`retired question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
  }
  return {
    notes,
    settlementRequired: pendingList(updated).some((entry) => entry.request_id === undefined),
  }
}

// ---------------------------------------------------------------------------
// Stop — the turn ended; escalate a registered question
// ---------------------------------------------------------------------------

/**
 * Only engages for a question the agent explicitly registered with
 * `notifai ask`. Guessing from the last assistant message was the alternative
 * and it is not worth it: a false positive here hijacks the terminal.
 */
export async function handleStop(
  ctx: HookContext,
  envelope: HookEnvelope,
  processDeadlineAt = ctx.now() + QUESTION_WAITER_CEILING_SECONDS * 1000,
  route: EscalationDeliveryRoute = hookContinuationRoute(),
  recordStop = true,
): Promise<HookOutcome> {
  const sessionId = envelope.session_id
  if (!sessionId) {
    gate(ctx, 'held', 'no-session', { stage: 'queued' })
    return { notes: [] }
  }
  return runEscalationWaiter(ctx, {
    sessionId,
    envelope,
    route,
    processDeadlineAt,
    recordStop,
  })
}

/**
 * Acquire the per-session owner, waiting only when this Stop carries a
 * newly registered question. The live owner sees that state on its next reply
 * poll and yields; without this handoff the new question could sit unpushed for
 * the older question's complete answer window.
 */
async function acquireQuestionOwner(
  ctx: HookContext,
  sessionId: string,
  hardDeadlineAt: number,
): Promise<boolean> {
  if (sessionHasEnded(sessionId, ctx.env)) return false
  if (claimQuestionPush(sessionId, ctx.env, Date.now(), undefined, hardDeadlineAt)) return true

  while (ctx.now() < hardDeadlineAt) {
    const handoff = claimHandoffState(sessionId, ctx.env)
    if (!handoff.hasNewQuestion) return false
    const holderReleaseDeadlineAt = Math.min(
      hardDeadlineAt,
      handoff.ownerDeadlineAt === undefined
        ? hardDeadlineAt
        : handoff.ownerDeadlineAt + QUESTION_STOP_TEARDOWN_HEADROOM_SECONDS * 1000,
    )
    if (ctx.now() >= holderReleaseDeadlineAt) return false
    await ctx.sleep(
      Math.min(CLAIM_HANDOFF_POLL_MS, holderReleaseDeadlineAt - ctx.now()),
    )
    if (sessionHasEnded(sessionId, ctx.env)) return false
    if (claimQuestionPush(sessionId, ctx.env, Date.now(), undefined, hardDeadlineAt)) return true
  }
  return false
}

/**
 * Own one registered question pipeline from its terminal-first timer through
 * its final delivery or retirement. Hosts differ only in the injected route.
 */
export async function runEscalationWaiter(
  ctx: HookContext,
  options: EscalationWaiterOptions,
): Promise<HookOutcome> {
  const notes: string[] = []
  const { sessionId, envelope } = options
  const hardDeadlineAt =
    options.processDeadlineAt ?? ctx.now() + QUESTION_WAITER_CEILING_SECONDS * 1000

  if (sessionHasEnded(sessionId, ctx.env)) {
    notes.push('the Agent Session already ended; no answer observer was started')
    return { notes }
  }

  // This event marker is diagnostic evidence in its own right. Record it
  // before every early return so doctor can distinguish a working Stop route
  // from the prompt-only state that previously looked healthy.
  if (options.recordStop !== false) {
    updateSessionState(sessionId, ctx.env, (current) => ({
      ...current,
      ...(ctx.harness === undefined ? {} : { harness: ctx.harness }),
      last_stop_at: ctx.now(),
    }))
  }

  // The waiter, not its host, owns this lease. It spans grace, submission,
  // polling, close fencing, route delivery, and every retirement path.
  // Real clock, deliberately, not `ctx.now` — the claim answers whether
  // another process is alive right now, which an injected clock cannot know.
  if (!(await acquireQuestionOwner(ctx, sessionId, hardDeadlineAt))) {
    gate(ctx, 'held', 'claimed-elsewhere', { stage: 'queued' })
    notes.push('another hook is already handling this session; a newly registered question remains queued for the next owner')
    return { notes }
  }
  let settledAnswerThisPass = false
  try {
    let state = readSessionState(sessionId, ctx.env)
    if (state.accepted !== undefined) {
      const accepted = state.accepted
      if (envelope.stop_hook_active === true && pendingList(state).length > 0) {
        const due = await reconcileAcknowledgementObligations(
          ctx,
          sessionId,
          state.acknowledgement_due ?? [],
        )
        if (due.length > 0) {
          gate(ctx, 'held', 'acknowledgement-required', {
            request_ids: due.map((entry) => entry.request_id),
          })
          return {
            stdout: stopAnswerOutput(acknowledgementBlockContext(due)),
            notes,
            log: {
              stage: 'acknowledgement-required',
              request_ids: due.map((entry) => entry.request_id),
            },
          }
        }
        state = readSessionState(sessionId, ctx.env)
      }
      // Acknowledgement is per route, because routes end in different places.
      //
      // A blocking continuation ends at this process's stdout, which the
      // harness reads only after the process exits: the recursive Stop's
      // `stop_hook_active` is the acknowledgement, and persisting a separate
      // "offered" bit before stdout would recreate the crash gap this journal
      // exists to close. An out-of-band route ends at a write this process made
      // itself and recorded here. A socket write is not proof the model acted
      // on the answer — delivery is not consumption — but nothing later can
      // prove more, and an answer redelivered without end is strictly worse
      // than one settled on delivery. So a recorded delivery settles.
      const acknowledgementProvesDelivery =
        accepted.answers.length > 0 &&
        accepted.answers.every(
          ({ pending, agent_acknowledgement_required }) =>
            agent_acknowledgement_required === true &&
            pending.request_id !== undefined &&
            !(state.acknowledgement_due ?? []).some(
              (entry) => entry.request_id === pending.request_id,
            ),
        )
      const deliveryProven =
        accepted.delivered_at !== undefined ||
        envelope.stop_hook_active === true ||
        acknowledgementProvesDelivery
      if (!deliveryProven) {
        for (const answer of accepted.answers) reportAnswer(ctx, notes, answer, true)
        return await deliverAcceptedAnswers(
          ctx,
          sessionId,
          options.route,
          accepted,
          notes,
          envelope.cwd,
        )
      }
      settleAcceptedAnswers(ctx, sessionId, accepted, envelope.cwd)
      settledAnswerThisPass = true
      state = readSessionState(sessionId, ctx.env)
      const currentAcceptedIds = new Set(
        accepted.answers.flatMap(({ pending }) =>
          pending.request_id === undefined ? [] : [pending.request_id],
        ),
      )
      const due = await reconcileAcknowledgementObligations(
        ctx,
        sessionId,
        (state.acknowledgement_due ?? []).filter((entry) =>
          currentAcceptedIds.has(entry.request_id),
        ),
      )
      const held = holdForAcknowledgement(ctx, sessionId, due, notes)
      if (held !== null) return held
      state = readSessionState(sessionId, ctx.env)
    }

    if (state.accepted === undefined && (state.acknowledgement_due?.length ?? 0) > 0) {
      const due = await reconcileAcknowledgementObligations(
        ctx,
        sessionId,
        state.acknowledgement_due!,
      )
      const held = holdForAcknowledgement(ctx, sessionId, due, notes)
      if (held !== null) return held
      resetAcknowledgementBlocks(sessionId, ctx.env)
      state = readSessionState(sessionId, ctx.env)
    }

    const pending = pendingList(state)
    if (pending.length === 0) {
      const swept = [
        ...(await drainRetirements(ctx, sessionId, ctx.env)),
        ...(await drainOrphanRetirements(ctx, ctx.env, ctx.now())),
      ]
      if (swept.length > 0) {
        notes.push(`retired question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
      }
      gate(ctx, 'held', 'no-question', { stage: 'queued' })
      return { notes }
    }

    return await handleClaimedStop(
      ctx,
      envelope,
      sessionId,
      state,
      pending,
      notes,
      hardDeadlineAt,
      options.route,
      // Every route's successor turn-end, named the same way: the harness flag
      // for a blocking continuation, and the settle above for a route that woke
      // a brand-new turn out of band.
      envelope.stop_hook_active === true || settledAnswerThisPass,
    )
  } finally {
    releaseQuestionPush(sessionId, ctx.env)
  }
}

/**
 * The blocking Stop hook's own last meter: the answer becomes this process's
 * stdout, and the harness admits it as a new user turn. Exported because a
 * host adapter that has other routes still falls back to this one.
 */
export function hookContinuationRoute(): EscalationDeliveryRoute {
  return {
    kind: 'hook-continuation',
    deliver: async (event) => ({
      stdout: stopAnswerOutput(event.context),
      commitStdout: event.commitDelivery,
      notes: [],
      // The harness reads this stdout after the process exits, so only the
      // successor Stop can acknowledge it.
      acknowledgement: 'stdout',
    }),
  }
}

/**
 * Hand one accepted answer to a route and record what the attempt proved.
 *
 * Every delivery on every route passes through here, which is what makes the
 * cap below a backstop rather than a suggestion. A guard only one route
 * consults is not a backstop: that is how a single answer once reached a
 * session 250 times.
 */
async function deliverAcceptedAnswers(
  ctx: HookContext,
  sessionId: string,
  route: EscalationDeliveryRoute,
  accepted: AcceptedAnswerDelivery,
  notes: string[],
  cwd?: string,
): Promise<HookOutcome> {
  const { answers: answered, remaining } = accepted
  const requestIds = summarizeRequestIds(answered.map((entry) => entry.pending)).ids
  if (sessionHasEnded(sessionId, ctx.env)) {
    notes.push('the Agent Session ended before answer delivery; stopping this observer')
    return { notes }
  }
  const held = accepted.held_deliveries ?? 0
  if (held >= MAX_HELD_DELIVERIES) {
    gate(ctx, 'held', 'delivery-limit', {
      route: route.kind,
      held,
      limit: MAX_HELD_DELIVERIES,
      request_ids: requestIds,
    })
    settleAcceptedAnswers(ctx, sessionId, accepted, cwd)
    notes.push(
      `no route could hand the user's answer over in ${MAX_HELD_DELIVERIES} turns; not holding it any longer`,
    )
    return { notes }
  }
  const attempt = (accepted.delivery_attempts ?? 0) + 1
  if (attempt > MAX_CONTINUATION_COUNT) {
    gate(ctx, 'held', 'delivery-limit', {
      route: route.kind,
      attempts: accepted.delivery_attempts ?? 0,
      limit: MAX_CONTINUATION_COUNT,
      request_ids: requestIds,
    })
    // Settle rather than journal for ever. The answer has been offered as often
    // as any working route could need, it is already in the notes of each of
    // those turns, and the questions it answered still deserve retirement.
    settleAcceptedAnswers(ctx, sessionId, accepted, cwd)
    notes.push(
      `the user's answer reached the ${route.kind} route ${MAX_CONTINUATION_COUNT} times without being acknowledged; not delivering it again`,
    )
    return { notes }
  }
  // Count the attempt before making it: an attempt that dies mid-delivery still
  // happened, and a counter written afterwards could be evaded by crashing.
  amendAcceptedAnswers(ctx, sessionId, (current) => ({
    ...current,
    delivery_attempts: attempt,
  }))
  // Linearize delivery after the journal write. If SessionEnd acquired the
  // shared state lock in between, its durable marker wins and no wake starts.
  if (sessionHasEnded(sessionId, ctx.env)) {
    notes.push('the Agent Session ended before answer delivery; stopping this observer')
    return { notes }
  }
  ctx.log?.info('hook.gate', {
    verdict: 'proceeding',
    reason: 'answered',
    stage: 'routed',
    route: route.kind,
    answers: answered.length,
    request_ids: requestIds,
    journal_recorded_at: accepted.recorded_at,
    delivery_attempt: attempt,
  })
  let deliveryCommitted = false
  const commitDelivery = (): boolean => {
    if (deliveryCommitted) return true
    const file = sessionStatePath(sessionId, ctx.env)
    return withFileLock(`${file}.lock`, () => {
      if (sessionHasEnded(sessionId, ctx.env)) return false
      const current = readSessionState(sessionId, ctx.env)
      if (current.accepted === undefined) return false
      deliveryCommitted = true
      writeSessionStateUnlocked(file, sessionId, {
        ...current,
        accepted: { ...current.accepted, delivery_committed_at: ctx.now() },
      })
      return true
    })
  }
  let delivered = await route.deliver({
    context: answersContext(answered, remaining),
    answers: answered.length,
    remaining,
    request_ids: requestIds,
    journal_recorded_at: accepted.recorded_at,
    commitDelivery,
  })
  if (delivered.acknowledgement === 'delivered' && !deliveryCommitted) {
    delivered = {
      notes: [
        ...(delivered.notes ?? []),
        `the ${route.kind} route reported delivery without committing against SessionEnd; preserving the answer instead of accepting an unordered write`,
      ],
      log: { route: route.kind, stage: 'queued', reason: 'delivery-not-committed' },
      acknowledgement: 'held',
    }
  }
  const deliveredRoute =
    typeof delivered.log?.['route'] === 'string' ? delivered.log['route'] : route.kind
  const deliveredStage =
    typeof delivered.log?.['stage'] === 'string' ? delivered.log['stage'] : 'delivered'
  if (delivered.acknowledgement === 'delivered') {
    finishCommittedDelivery(ctx, sessionId, accepted, deliveredRoute)
  } else if (delivered.acknowledgement === 'held') {
    // Give the delivery attempt back and count the hold instead. The attempt
    // was counted before the call because one that dies mid-delivery still
    // happened and a counter written afterwards could be evaded by crashing —
    // but a route that *returns* `held` proves both that this process survived
    // and that nothing was handed over.
    amendAcceptedAnswers(ctx, sessionId, (current) => ({
      ...current,
      delivery_attempts: accepted.delivery_attempts ?? 0,
      held_deliveries: (current.held_deliveries ?? 0) + 1,
    }))
  }
  ctx.log?.info('hook.answer', {
    answered: true,
    stage: deliveredStage,
    route: deliveredRoute,
    acknowledgement: delivered.acknowledgement,
    delivery_attempt: attempt,
    request_ids: requestIds,
    answers: answered.length,
    journal_recorded_at: accepted.recorded_at,
    ...(delivered.log?.['reason'] === undefined ? {} : { reason: delivered.log['reason'] }),
  })
  const outcome: HookOutcome = { notes: [...notes, ...(delivered.notes ?? [])] }
  if (delivered.stdout !== undefined) outcome.stdout = delivered.stdout
  if (delivered.commitStdout !== undefined) outcome.commitStdout = delivered.commitStdout
  if (delivered.log !== undefined) outcome.log = delivered.log
  return outcome
}

/** True while this Stop owner is still allowed a direct-wake wait. */
function ownerLeaseActive(entry: PendingQuestion, now: number): boolean {
  return entry.owner_deadline_at !== undefined && entry.owner_deadline_at > now
}

/** The complete per-session Stop decision, after this process owns the claim. */
async function handleClaimedStop(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  state: SessionState,
  pending: PendingQuestion[],
  notes: string[],
  hardDeadlineAt: number,
  route: EscalationDeliveryRoute,
  continuingFromAnswer: boolean,
): Promise<HookOutcome> {
  const live = pending.filter((entry) => entry.request_id !== undefined)
  const unasked = pending.filter((entry) => entry.request_id === undefined)
  let liveToEscalate = live

  if (
    ctx.harness !== undefined &&
    HARNESS_CAPABILITIES[ctx.harness].stopContinuation === 'unsupported'
  ) {
    for (const entry of live) await closeQuietly(ctx, entry.request_id!)
    await retirePendings(ctx, envelope, sessionId, pending, 'expired')
    // Not `no-question`: there was a question, and this says so. Reading the
    // log to find out why an ask never travelled is the whole reason these
    // reasons exist, and the wrong one sent that reader looking for a question
    // that was right there.
    gate(ctx, 'held', 'harness-cannot-continue', { harness: ctx.harness })
    notes.push(`${HARNESS_CAPABILITIES[ctx.harness].deliveryContract}; use a blocking \`notifai send --reply\` question`)
    return { notes }
  }

  if (live.length > 0) {
    const { answered, permanentFailures } = await pollPendingReplies(
      ctx,
      live,
      LATE_STOP_POLL_SECONDS,
    )
    const permanentFailure = permanentReplyFailureNote(permanentFailures)
    if (permanentFailure !== null) notes.push(permanentFailure)
    const permanentlyRejected = live.filter((entry) =>
      permanentFailures.has(entry.request_id!),
    )
    await Promise.all(permanentlyRejected.map((entry) => closeQuietly(ctx, entry.request_id!)))
    if (permanentlyRejected.length > 0) {
      await retirePendings(ctx, envelope, sessionId, permanentlyRejected, 'expired')
    }
    if (answered.length > 0) {
      const finalized = await finalizePendings(
        ctx,
        answered.map((entry) => entry.pending),
      )
      const authoritative = answered.map((entry) => {
        const response = finalized.find((candidate) =>
          isSamePending(candidate.pending, entry.pending),
        )?.response
        const replies = response?.replies.length ? response.replies : entry.replies
        if (response === null) {
          notes.push(
            `could not confirm the close fence for ${entry.pending.request_id}; delivering the durable answer already observed`,
          )
        }
        return {
        ...entry,
        replies,
        reply: replies.at(-1)!,
        agent_acknowledgement_required:
          response?.agent_acknowledgement_required ??
          entry.agent_acknowledgement_required,
        agent_acknowledgement_text_required:
          response?.agent_acknowledgement_text_required ??
          entry.agent_acknowledgement_text_required,
      }
      })
      const accepted = stageAcceptedAnswers(
        ctx,
        sessionId,
        authoritative,
        pending.length - authoritative.length - permanentlyRejected.length,
      )
      for (const answer of authoritative) reportAnswer(ctx, notes, answer, true)
      // Anything still unasked rides the next Stop: the agent is being resumed
      // with answers right now, and may not even need the rest afterwards.
      return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes, envelope.cwd)
    }
    const recoverableLive = live.filter(
      (entry) => !permanentFailures.has(entry.request_id!),
    )
    // A spent owner has already reached the end of the answer window it owned.
    // Passing those questions back into `escalate` starts a fresh ceiling and
    // can monopolize the per-session claim after expiry. Independent questions
    // whose lease is still running keep their successor wait.
    const stillOwned = recoverableLive.filter((entry) => ownerLeaseActive(entry, ctx.now()))
    liveToEscalate = stillOwned
    if (unasked.length === 0) {
      if (recoverableLive.length === 0) return { notes }
      if (stillOwned.length === 0) {
        const requestIdSummary = summarizeRequestIds(recoverableLive)
        ctx.log?.info('hook.answer', {
          answered: false,
          stage: 'queued',
          request_ids: requestIdSummary.ids,
          owner_spent: true,
        })
        notes.push(
          `${recoverableLive.length} question${recoverableLive.length === 1 ? ' is' : 's are'} still recorded after the previous answer owner ended; a later turn will reconcile ${recoverableLive.length === 1 ? 'it' : 'them'} without starting another full-window wait`,
        )
        return { notes }
      }
      return await escalate(
        ctx,
        envelope,
        sessionId,
        [],
        stillOwned,
        notes,
        hardDeadlineAt,
        route,
      )
    }
    // Questions registered after the earlier push still owe the user their
    // notification; fall through and escalate just those, plus any live
    // question whose owner lease is still running.
  }

  // A Stop answer may immediately produce a legitimate follow-up question.
  // Allow that new generation, but never re-run an old pending question and
  // never let answer continuations become an unbounded agent loop.
  if (envelope.stop_hook_active === true) {
    const continuation = state.continuation
    const isNew =
      continuation !== undefined &&
      unasked.some(
        (entry) => entry.asked_at !== undefined && entry.asked_at > continuation.answered_at,
      )
    if (!isNew) {
      gate(ctx, 'held', 'continuation-repeat')
      notes.push('already continuing from an answer; not asking again this turn')
      return { notes }
    }
  }
  // The cap is deliberately not keyed to `stop_hook_active`. That flag names one
  // route's continuation; a route that wakes a brand-new turn never sets it, and
  // a limit only one route consults bounds only that route. `continuingFromAnswer`
  // is the same event named for every route, so the chain of answer → follow-up
  // question → answer is bounded whatever delivered it.
  if (
    continuingFromAnswer &&
    state.continuation !== undefined &&
    state.continuation.count >= MAX_CONTINUATION_COUNT
  ) {
    gate(ctx, 'held', 'continuation-limit', {
      count: state.continuation.count,
      limit: MAX_CONTINUATION_COUNT,
      route: route.kind,
    })
    notes.push(
      `answer continuation limit (${MAX_CONTINUATION_COUNT}) reached; leaving the question in the terminal`,
    )
    return { notes }
  }
  // Silent to the user by design — they switched routing off, so saying so on
  // every turn would be nagging about their own setting. That silence is also
  // why it belongs in the log: from outside, "ask_notifications = false" and "a
  // bug ate my question" look exactly the same.
  if (!ctx.config.ask_notifications.value) {
    gate(ctx, 'held', 'notifications-off', { source: ctx.config.ask_notifications.source })
    return { notes }
  }
  gate(ctx, 'proceeding', 'proceeding', {
    unasked: unasked.length,
    already_live: liveToEscalate.length,
    grace_seconds: ctx.config.ask_grace_seconds.value,
  })
  return await escalate(
    ctx,
    envelope,
    sessionId,
    unasked,
    liveToEscalate,
    notes,
    hardDeadlineAt,
    route,
  )
}

/** The escalation itself, split out so the claim is released on every path. */
async function escalate(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  unasked: PendingQuestion[],
  alreadyLive: PendingQuestion[],
  notes: string[],
  hardDeadlineAt: number,
  route: EscalationDeliveryRoute,
): Promise<HookOutcome> {
  // The questions still owe the user their terminal-first window before
  // anything reaches their devices — measured from the oldest registration,
  // because that is the question that has waited longest.
  const ceilingAt = hardDeadlineAt
  if (unasked.length > 0 && alreadyLive.length === 0) {
    const oldest = Math.min(...unasked.map((entry) => entry.asked_at ?? ctx.now()))
    await awaitTerminalFirstWindow(ctx, oldest, ceilingAt)
    ctx.log?.debug('hook.gate', {
      verdict: 'grace',
      reason: 'elapsed' satisfies GateReason,
      waited_from: oldest,
      grace_seconds: ctx.config.ask_grace_seconds.value,
    })
  }
  // Phase one: every registered question reaches the user's devices, each as
  // its own notification — one ask never stands in for another.
  const submitted: PendingQuestion[] = []
  const admissionAnswers: AnsweredPending[] = []
  for (const entry of unasked) {
    // The service owns how long the answer is accepted. This process begins
    // before submission, so its larger maximum-window budget includes startup
    // headroom and remains alive through the complete committed window.
    const replyWindowSeconds = ctx.config.reply_window_seconds.value
    if (
      ceilingAt - ctx.now() <
      (replyWindowSeconds + QUESTION_SUBMISSION_COMPLETION_HEADROOM_SECONDS) * 1000
    ) {
      notes.push(
        'too little owner lifetime remains for the complete configured answer window; leaving this question frozen for a successor owner',
      )
      continue
    }
    const ownerDeadlineAt = ceilingAt
    const questions = pendingQuestions(entry)
    const eventSource = sourceContextAtHookEvent(entry.source, envelope.cwd)
    let intent = entry.submission
    if (intent === undefined) {
      const prepared = await prepareQuestionSubmission(ctx, {
        title: entry.title,
        summary: entry.summary,
        ...(entry.body !== undefined ? { body: entry.body } : {}),
        questions,
        ...(entry.media !== undefined ? { media: entry.media } : {}),
        ...(entry.project !== undefined ? { project: entry.project } : {}),
        ...(eventSource !== undefined ? { source: eventSource } : {}),
        windowSeconds: replyWindowSeconds,
        ownerDeadlineAt,
      })
      if ('error' in prepared) {
        ctx.log?.error('hook.pushed', { ok: false, message: prepared.error })
        notes.push(prepared.error)
        continue
      }
      intent = prepared
      // Durable before submit. If the server commits and the response is lost,
      // the reserved request id still lets this owner poll and finalize the
      // exact card; a successor can also replay the frozen draft/key.
      updateSessionState(sessionId, ctx.env, (current) => {
        const list = pendingList(current)
        const index = list.findIndex((candidate) => isSamePending(candidate, entry))
        if (index < 0) return current
        const next = [...list]
        next[index] = { ...next[index]!, submission: prepared }
        return { ...current, pending: next }
      })
    } else if (intent.owner_deadline_at <= ctx.now()) {
      // The frozen wire identity survives a crashed owner, but its local owner
      // lease does not. Re-arm only the local deadline; request id, key,
      // targets, and draft remain byte-identical for idempotent replay.
      intent = { ...intent, owner_deadline_at: ceilingAt }
      const rearmed = intent
      updateSessionState(sessionId, ctx.env, (current) => {
        const list = pendingList(current)
        const index = list.findIndex((candidate) => isSamePending(candidate, entry))
        if (index < 0) return current
        const next = [...list]
        next[index] = { ...next[index]!, submission: rearmed }
        return { ...current, pending: next }
      })
    }
    if (ctx.now() >= intent.owner_deadline_at) {
      notes.push('the owner lifetime ended before submission; preserving the frozen intent')
      continue
    }
    if (!canSubmitCompleteWindow(ctx, intent, replyWindowSeconds)) {
      notes.push(
        'setup consumed the admission allowance; preserving the frozen intent instead of publishing an answer window this owner cannot observe completely',
      )
      continue
    }
    if (sessionHasEnded(sessionId, ctx.env)) {
      notes.push('the Agent Session ended before submission; preserving no live observer')
      continue
    }
    let receipt: SubmissionReceipt | undefined
    let admissionConfirmed = false
    try {
      receipt = await submitQuestion(ctx, intent)
      admissionConfirmed = true
    } catch (caught) {
      let err: unknown = caught
      if (err instanceof ApiCallError && isTerminalDraftRejection(err)) {
        ctx.log?.error('hook.pushed', {
          ok: false,
          request_id: intent.request_id,
          status: err.status,
          code: err.code,
          message: err.message,
        })
        if (entry.submission !== undefined) {
          notes.push(
            `question submission was rejected (${err.code}, HTTP ${err.status}); reminting the draft in the current contract instead of replaying the frozen one`,
          )
          clearFrozenSubmission(sessionId, ctx.env, entry)
          const reminted = await prepareQuestionSubmission(ctx, {
            title: entry.title,
            summary: entry.summary,
            ...(entry.body !== undefined ? { body: entry.body } : {}),
            questions,
            ...(entry.media !== undefined ? { media: entry.media } : {}),
            ...(entry.project !== undefined ? { project: entry.project } : {}),
            ...(eventSource !== undefined ? { source: eventSource } : {}),
            windowSeconds: replyWindowSeconds,
            ownerDeadlineAt,
          })
          if ('error' in reminted) {
            dropPendingQuestion(sessionId, ctx.env, entry)
            notes.push(reminted.error)
            continue
          }
          intent = reminted
          updateSessionState(sessionId, ctx.env, (current) => {
            const list = pendingList(current)
            const index = list.findIndex((candidate) => isSamePending(candidate, entry))
            if (index < 0) return current
            const next = [...list]
            next[index] = { ...next[index]!, submission: reminted }
            return { ...current, pending: next }
          })
          try {
            if (!canSubmitCompleteWindow(ctx, intent, replyWindowSeconds)) {
              notes.push(
                'draft recovery consumed the admission allowance; preserving the frozen intent for a successor owner',
              )
              continue
            }
            if (sessionHasEnded(sessionId, ctx.env)) {
              notes.push('the Agent Session ended before recovered submission')
              continue
            }
            receipt = await submitQuestion(ctx, intent)
            admissionConfirmed = true
          } catch (retryErr) {
            if (retryErr instanceof ApiCallError && isTerminalDraftRejection(retryErr)) {
              dropPendingQuestion(sessionId, ctx.env, entry)
              notes.push(
                `reminted draft was also rejected (${retryErr.code}, HTTP ${retryErr.status}); retiring the question so it is not retried forever`,
              )
              ctx.log?.error('hook.pushed', {
                ok: false,
                request_id: intent.request_id,
                status: retryErr.status,
                code: retryErr.code,
                message: retryErr.message,
              })
              continue
            }
            err = retryErr
          }
        } else {
          dropPendingQuestion(sessionId, ctx.env, entry)
          notes.push(
            `question submission was rejected (${err.code}, HTTP ${err.status}); retiring it because the current draft will never be accepted`,
          )
          continue
        }
      }
      if (!admissionConfirmed && err instanceof ApiCallError && err.status < 500 && err.status !== 408) {
        notes.push(
          `question submission was rejected (${err.code}, HTTP ${err.status}); preserving it for recovery`,
        )
        ctx.log?.error('hook.pushed', {
          ok: false,
          request_id: intent.request_id,
          status: err.status,
          code: err.code,
          message: err.message,
        })
        continue
      }
      if (!admissionConfirmed) {
        notes.push(`question submission response was ambiguous; recovering ${intent.request_id}`)
        ctx.log?.error('hook.pushed', { ok: false, request_id: intent.request_id, message: String(err) })
      }
    }
    if (admissionConfirmed) {
      ctx.log?.info('hook.pushed', {
        ok: true,
        request_id: intent.request_id,
        devices: intent.device_ids.length,
        questions: questions.length,
        text_chars: questions[0]!.text.length,
      })
    }
    const committedReplyDeadline =
      receipt?.reply_expires_at === null || receipt?.reply_expires_at === undefined
        ? intent.owner_deadline_at
        : Date.parse(receipt.reply_expires_at)
    const live: PendingQuestion = {
      ...entry,
      ...(intent.draft.source !== undefined ? { source: intent.draft.source } : {}),
      request_id: intent.request_id,
      collapse_key: intent.collapse_key,
      device_ids: intent.device_ids,
      // The server's committed answer deadline is authoritative. The local
      // owner deadline starts earlier and includes startup headroom, so it may
      // be later but must never be earlier.
      reply_deadline_at: Number.isFinite(committedReplyDeadline)
        ? committedReplyDeadline
        : intent.owner_deadline_at,
      owner_deadline_at: intent.owner_deadline_at,
    }
    if (intent.draft.source === undefined) delete live.source
    delete live.submission
    if (live.reply_deadline_at! > live.owner_deadline_at!) {
      const response = await finalizeReplies(ctx, live.request_id!)
      if (response === null) {
        // Closing was unreachable, so the question is still potentially live.
        // Preserve it in the exact session instead of demoting it to the orphan
        // retirement queue, whose later close has no route for an answer.
        updateSessionState(sessionId, ctx.env, (current) => {
          const list = pendingList(current)
          const index = list.findIndex((candidate) => isSamePending(candidate, entry))
          if (index < 0) {
            // Terminal input removed this registration while the anomalous
            // close was in flight. Preserve retirement identity exactly as
            // normal submit promotion does; the observer must not become the
            // only remaining record of a live card.
            const retirement = retiringQuestion(
              live,
              'answered_elsewhere',
              envelope.cwd,
            )!
            const retiring = [...(current.retiring ?? [])]
            if (!retiring.some((parked) => parked.request_id === retirement.request_id)) {
              retiring.push(retirement)
            }
            return { ...current, retiring }
          }
          const next = [...list]
          next[index] = live
          return { ...current, pending: next }
        })
        submitted.push(live)
        notes.push(
          'the server committed an answer deadline beyond this process owner and immediate closure was unreachable; preserving the live question for exact-session recovery',
        )
        continue
      } else if (response.replies.length > 0) {
        admissionAnswers.push({
          pending: live,
          reply: response.replies.at(-1)!,
          replies: response.replies,
          agent_acknowledgement_required: response.agent_acknowledgement_required,
          agent_acknowledgement_text_required:
            response.agent_acknowledgement_text_required,
        })
      }
      dropPendingQuestion(sessionId, ctx.env, entry)
      notes.push(
        'the server committed an answer deadline beyond this process owner; closed the anomalous window instead of abandoning it early',
      )
      continue
    }
    // Record what is now live on the user's devices BEFORE any wait. If we
    // only learned these ids afterwards, a question that timed out would
    // leave no trace, and the user returning to the terminal could never
    // retire it — the notification would stay answerable for an hour with
    // nobody listening.
    if (admissionConfirmed) {
      updateSessionState(sessionId, ctx.env, (current) => {
        const list = pendingList(current)
        const index = list.findIndex(
          (candidate) => isSamePending(candidate, entry) && candidate.request_id === undefined,
        )
        if (index >= 0) {
          const next = [...list]
          next[index] = live
          return { ...current, pending: next }
        }
        // The entry vanished while the submit was in flight (the user's prompt
        // wiped the queue). The delivered notification must still be retirable,
        // so park it rather than lose its only identifiers.
        const retirement = retiringQuestion(live, 'answered_elsewhere', envelope.cwd)!
        const retiring = [...(current.retiring ?? [])]
        if (!retiring.some((parked) => parked.request_id === retirement.request_id)) {
          retiring.push(retirement)
        }
        return { ...current, retiring }
      })
    }
    if (sessionHasEnded(sessionId, ctx.env)) {
      // SessionEnd may have raced either the submit or promotion. Its snapshot
      // usually already queued the frozen intent; this idempotent add closes
      // the other ordering where the request committed just after cleanup.
      orphanRetirements(
        ctx.env,
        [retiringQuestion(live, 'expired', envelope.cwd)!],
        ctx.now(),
      )
      notes.push('the Agent Session ended during submission; queued the question for retirement')
      continue
    }
    submitted.push(live)
  }

  if (admissionAnswers.length > 0) {
    const accepted = stageAcceptedAnswers(
      ctx,
      sessionId,
      admissionAnswers,
      pendingList(readSessionState(sessionId, ctx.env)).length,
    )
    for (const answer of admissionAnswers) reportAnswer(ctx, notes, answer, false)
    return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes, envelope.cwd)
  }

  const staleLive = alreadyLive.filter(
    (entry) =>
      entry.reply_deadline_at === undefined || entry.reply_deadline_at <= ctx.now(),
  )
  const finalizedStale = await finalizePendings(ctx, staleLive)
  const staleAnswers = finalizedStale
    .map(finalizedAnswer)
    .filter((entry): entry is AnsweredPending => entry !== null)
  const staleSilence = finalizedStale
    .filter((entry) => entry.response !== null && entry.response.replies.length === 0)
    .map((entry) => entry.pending)
  const staleUnproven = finalizedStale.filter((entry) => entry.response === null)
  if (staleSilence.length > 0) {
    await retirePendings(ctx, envelope, sessionId, staleSilence, 'expired')
    notes.push(
      `expired ${staleSilence.length} question${staleSilence.length === 1 ? '' : 's'} whose continuation owner had ended`,
    )
  }
  if (staleUnproven.length > 0) {
    notes.push(
      `could not finalize ${staleUnproven.length} expired question${staleUnproven.length === 1 ? '' : 's'}; preserving ownership for recovery`,
    )
  }
  if (staleAnswers.length > 0) {
    const remaining = Math.max(
      0,
      pendingList(readSessionState(sessionId, ctx.env)).length - staleAnswers.length,
    )
    const accepted = stageAcceptedAnswers(ctx, sessionId, staleAnswers, remaining)
    for (const answer of staleAnswers) reportAnswer(ctx, notes, answer, true)
    return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes, envelope.cwd)
  }
  const waitingOn = [
    ...alreadyLive.filter(
      (entry) => entry.reply_deadline_at !== undefined && entry.reply_deadline_at > ctx.now(),
    ),
    ...submitted,
  ]
  if (waitingOn.length === 0) return { notes }

  // Phase two: keep the same owner alive across every committed answer window.
  // Different questions may expire at different times, so finalize each one at
  // its own server deadline and continue waiting on the rest. Reserving time by
  // closing early would make the advertised reply window untrue.
  let activeWaiting = waitingOn
  let timeoutSeconds = 0
  let waited: Awaited<ReturnType<typeof waitForAnyReply>>
  for (;;) {
    const nextReplyDeadline = Math.min(
      ...activeWaiting.map((entry) => entry.reply_deadline_at!),
    )
    const waitDeadline = Math.min(ceilingAt, nextReplyDeadline)
    timeoutSeconds = Math.max(0, Math.ceil((waitDeadline - ctx.now()) / 1000))
    waited = await waitForAnyReply(
      ctx,
      activeWaiting.map((entry) => entry.request_id!),
      timeoutSeconds,
      () =>
        waiterInterruption(
          sessionId,
          ctx.env,
          activeWaiting.map((entry) => entry.request_id!),
        ),
    )
    if (waited.interrupted !== null) {
      notes.push(
        waited.interrupted === 'new-question'
          ? 'yielding the answer owner so a newly registered question can be sent now'
          : 'answer ownership ended locally; stopping this observer without delivering into a closed session',
      )
      return { notes }
    }
    const currentRequestIds = new Set(
      pendingList(readSessionState(sessionId, ctx.env)).flatMap((entry) =>
        [entry.request_id, entry.submission?.request_id].filter(
          (requestId): requestId is string => requestId !== undefined,
        ),
      ),
    )
    const removedDuringPoll = activeWaiting.filter(
      (entry) => !currentRequestIds.has(entry.request_id!),
    )
    for (const entry of removedDuringPoll) {
      waited.byRequest.delete(entry.request_id!)
      waited.permanentFailures.delete(entry.request_id!)
    }
    if (removedDuringPoll.length > 0) {
      notes.push(
        `${removedDuringPoll.length} question${removedDuringPoll.length === 1 ? ' changed' : 's changed'} outside this observer; continuing with the independently live questions`,
      )
      activeWaiting = activeWaiting.filter((entry) => currentRequestIds.has(entry.request_id!))
      if (activeWaiting.length === 0) return { notes }
    }
    const permanentFailure = permanentReplyFailureNote(waited.permanentFailures)
    if (permanentFailure !== null) notes.push(permanentFailure)
    if (waited.byRequest.size > 0) break

    // A permanent rejection is authoritative immediately. Time-based expiry is
    // authoritative only when this owner reached that question's committed
    // server deadline; reaching the process ceiling first preserves the record.
    const expired = activeWaiting.filter(
      (entry) =>
        entry.reply_deadline_at === undefined ||
        entry.reply_deadline_at <= waitDeadline ||
        waited.permanentFailures.has(entry.request_id!),
    )
    const stillAnswerable = activeWaiting.filter((entry) => !expired.includes(entry))
    const finalized = await finalizePendings(ctx, expired)
    const finalAnswers = finalized
      .map(finalizedAnswer)
      .filter((entry): entry is AnsweredPending => entry !== null)
    const confirmedSilent = finalized
      .filter((entry) => entry.response !== null && entry.response.replies.length === 0)
      .map((entry) => entry.pending)
    const unproven = finalized.filter((entry) => entry.response === null)
    if (confirmedSilent.length > 0) {
      await retirePendings(ctx, envelope, sessionId, confirmedSilent, 'expired')
    }
    if (unproven.length > 0) {
      notes.push(
        `could not finalize ${unproven.length} question${unproven.length === 1 ? '' : 's'}; preserving ownership rather than risking a lost late answer`,
      )
    }
    if (finalAnswers.length > 0) {
      const remaining = Math.max(
        0,
        pendingList(readSessionState(sessionId, ctx.env)).length - finalAnswers.length,
      )
      const accepted = stageAcceptedAnswers(ctx, sessionId, finalAnswers, remaining)
      for (const answer of finalAnswers) reportAnswer(ctx, notes, answer, false)
      return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes, envelope.cwd)
    }
    if (stillAnswerable.length > 0 && waitDeadline < ceilingAt) {
      activeWaiting = stillAnswerable
      continue
    }

    const requestIdSummary = summarizeRequestIds(waitingOn)
    ctx.log?.info('hook.answer', {
      answered: false,
      stage: 'queued',
      request_ids: requestIdSummary.ids,
      degraded: waited.degraded,
      permanent_failures: waited.permanentFailures.size,
      waited_seconds: timeoutSeconds,
    })
    if (stillAnswerable.length > 0) {
      notes.push(
        `${stillAnswerable.length} question${stillAnswerable.length === 1 ? ' remains' : 's remain'} answerable after the process owner ended; preserving ${stillAnswerable.length === 1 ? 'it' : 'them'} for recovery`,
      )
    } else if (waited.permanentFailures.size === 0 && confirmedSilent.length > 0) {
      notes.push(
        waited.degraded
          ? 'could not reach the server before the answer deadline; expired questions were retired so no answer can be lost later'
          : 'no answer in time; the question expired with its continuation owner',
      )
    }
    return { notes }
  }

  const polledAnswered = activeWaiting.filter((entry) => waited.byRequest.has(entry.request_id!))
  const finalizedAnswered = await finalizePendings(ctx, polledAnswered)
  const answered: AnsweredPending[] = []
  for (const finalized of finalizedAnswered) {
    const entry = finalized.pending
    const replies = waited.byRequest.get(entry.request_id!)
    if (replies === undefined) continue
    // The fenced set wins because it includes corrections that committed
    // while close was waiting for earlier writers. If finalization itself was
    // unreachable, never discard the durable reply already observed.
    const finalReplies = finalized.response?.replies ?? []
    const authoritative = finalReplies.length > 0 ? finalReplies : replies
    answered.push({
      pending: entry,
      reply: authoritative.at(-1)!,
      replies: authoritative,
      agent_acknowledgement_required:
        finalized.response?.agent_acknowledgement_required,
      agent_acknowledgement_text_required:
        finalized.response?.agent_acknowledgement_text_required,
    })
    if (finalized.response === null) {
      notes.push(
        `could not confirm the close fence for ${entry.request_id}; delivering the durable answer already observed`,
      )
    }
  }
  const accepted = stageAcceptedAnswers(
    ctx,
    sessionId,
    answered,
    Math.max(
      0,
      pendingList(readSessionState(sessionId, ctx.env)).length - answered.length,
    ),
  )
  for (const answer of answered) reportAnswer(ctx, notes, answer, false)
  return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes, envelope.cwd)
}

// ---------------------------------------------------------------------------
// SessionEnd — local cleanup only
// ---------------------------------------------------------------------------

/**
 * Claude Code gives SessionEnd hooks a 1.5-second shared budget and Codex 1
 * second, so this cannot make a network call. It drops the local marker — but
 * first moves anything still live on the user's devices into the global
 * retirement queue, because this file was the only record of those ids and no
 * hook for this session will ever run again. A question whose
 * agent just exited can receive no answer, so it is orphaned as `expired`.
 */
export function handleSessionEnd(
  env: NodeJS.ProcessEnv,
  envelope: HookEnvelope,
  now: number = Date.now(),
): HookOutcome {
  const notes: string[] = []
  const sessionId = envelope.session_id
  if (!sessionId) return { notes, log: { outcome: 'ignored', reason: 'missing-session-id' } }
  // Publish cancellation before reading or clearing anything. In-flight Stop
  // writers use the same session lock, so none can recreate state after this.
  markSessionEnded(sessionId, env, now)
  if (envelope.cwd !== undefined) clearMatchingProjectSession(envelope.cwd, env, sessionId)

  const state = readSessionState(sessionId, env)
  let stateWithHistory = state
  for (const entry of pendingList(state)) {
    stateWithHistory = rememberQuestionState(
      stateWithHistory,
      entry,
      entry.request_id === undefined && entry.submission === undefined ? 'withdrawn' : 'retired',
    )
  }
  for (const answer of state.accepted?.answers ?? []) {
    stateWithHistory = rememberQuestionState(stateWithHistory, answer.pending, 'answered')
  }
  for (const retirement of state.retiring ?? []) {
    stateWithHistory = rememberQuestionState(
      stateWithHistory,
      retirement,
      retirement.state === 'answered' ? 'answered' : 'retired',
    )
  }
  const orphans: RetiringQuestion[] = [...(state.retiring ?? [])]
  const retirementCandidates = [
    ...pendingList(state),
    ...(state.accepted?.answers.map((entry) => entry.pending) ?? []),
  ]
  for (const entry of retirementCandidates) {
    try {
      const orphan = retiringQuestion(entry, 'expired', envelope.cwd)
      if (
        orphan !== null &&
        !orphans.some((candidate) => candidate.request_id === orphan.request_id)
      ) {
        orphans.push(orphan)
      }
    } catch (err) {
      notes.push(err instanceof Error ? err.message : String(err))
      // Preserve the only identifiers instead of turning an explicit corrupt
      // state into an unretirable question during SessionEnd cleanup.
      return {
        notes,
        log: { outcome: 'preserved', reason: 'incomplete-question-identifiers' },
      }
    }
  }
  if (orphans.length > 0) {
    orphanRetirements(env, orphans, now)
    notes.push(
      `queued ${orphans.length} question${orphans.length > 1 ? 's' : ''} for retirement on the next hook`,
    )
  }
  if (state.accepted !== undefined || (state.acknowledgement_due?.length ?? 0) > 0) {
    const preserved: SessionState = { ...stateWithHistory }
    delete preserved.pending
    delete preserved.retiring
    delete preserved.acknowledgement_blocks
    if ((preserved.acknowledgement_due?.length ?? 0) === 0) {
      delete preserved.acknowledgement_due
    }
    writeSessionState(sessionId, env, preserved)
    notes.push(
      state.accepted !== undefined
        ? 'preserved an accepted device answer for this exact session to resume'
        : 'preserved required Agent Acknowledgement obligations for this exact session',
    )
    return {
      notes,
      log: {
        outcome: state.accepted !== undefined ? 'answer-preserved' : 'acknowledgement-preserved',
        queued_retirements: orphans.length,
        accepted_answers: state.accepted?.answers.length ?? 0,
        acknowledgement_due: state.acknowledgement_due?.length ?? 0,
      },
    }
  }
  const history = stateWithHistory.question_history
  clearSessionState(sessionId, env)
  if ((history?.length ?? 0) > 0) {
    writeSessionState(sessionId, env, { question_history: history! })
  }
  return { notes, log: { outcome: 'cleaned', queued_retirements: orphans.length } }
}

// ---------------------------------------------------------------------------
// ask — register a question for the turn's end
// ---------------------------------------------------------------------------

/**
 * Registrations still waiting for their first push. More than this in one turn
 * means an agent is looping, not asking, and related questions belong in one
 * `ask --form` instead.
 *
 * Deliberately counts only unasked entries. A question already on the user's
 * devices is waiting on a person, not on the agent, and an answer stays
 * accepted for a day — so counting live questions here would have turned a
 * patient user into a reason the agent could no longer ask anything.
 */
export const MAX_PENDING_QUESTIONS = 4

/**
 * Everything this session has open at once, asked or not. The lock screen is
 * the shared resource being protected here, not the agent's turn.
 */
export const MAX_LIVE_QUESTIONS = 10

/**
 * A session may hold several registered questions at once: a new `ask` never
 * ends an earlier one. Each reaches the user as its own notification and is
 * answerable independently. Superseding is reply semantics — a later reply
 * corrects an earlier reply to the same question (that correction model lives
 * server-side) — never question semantics: the old single-slot model silently
 * discarded a question the moment a second was registered, and the user was
 * pointed at a notification that never existed (2026-08-09).
 *
 * The queue is keyed on the session, not the project: several agents may be
 * running in one project at once, and their questions must never interfere.
 */
export function registerQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  question: PendingQuestion,
  now: number = Date.now(),
): string {
  let full: 'unasked' | 'live' | null = null
  const questionId = question.question_id ?? `q_${randomBytes(12).toString('base64url')}`
  updateSessionState(sessionId, env, (state) => {
    const pending = pendingList(state)
    const unasked = pending.filter((entry) => entry.request_id === undefined)
    if (unasked.length >= MAX_PENDING_QUESTIONS) {
      full = 'unasked'
      return state
    }
    if (pending.length >= MAX_LIVE_QUESTIONS) {
      full = 'live'
      return state
    }
    return {
      ...state,
      pending: [
        ...pending,
        {
          asked_at: now,
          ...question,
          question_id: questionId,
          question: question.question.slice(0, MAX_STORED_QUESTION_CHARS),
        },
      ],
    }
  })
  if (full === 'unasked') {
    throw new Error(
      `${MAX_PENDING_QUESTIONS} questions are already waiting to be asked. ` +
        'Combine related questions into one `notifai ask --form` instead of registering more.',
    )
  }
  if (full === 'live') {
    throw new Error(
      `${MAX_LIVE_QUESTIONS} questions from this session are already open. ` +
        'Retire the ones you no longer need with `notifai close <question_id>` or `notifai close --pending` before asking another.',
    )
  }
  return questionId
}

/** Parses hook JSON from stdin, tolerating an empty or malformed body. */
export function parseHookInput(raw: string): HookEnvelope {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookEnvelope) : {}
  } catch {
    return {}
  }
}
