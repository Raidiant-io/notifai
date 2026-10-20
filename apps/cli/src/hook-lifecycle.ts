/** Hook-event domain handlers and the question escalation lifecycle. */
import type {
  CloseDisposition,
  CloseRepliesResponse,
  ListRepliesResponse,
  MediaItemT,
  QuestionT,
  ReplyView,
  SourceContextT,
  SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { randomBytes } from 'node:crypto'
import {
  confirmNativeAnswerTarget,
  hasSettledNativeAnswer,
  questionsAwaitingAnswer,
  recordConfirmedNativeAnswerTarget,
} from './native-answer-operation.js'
import { markCodexOrdinaryPresentation, mayRetireFromPrompt, nativeFormMayAnswer, reserveCurrentCodexQuestion, type NativeQuestionAdmission } from './codex-question-bindings.js'
import { isDeepStrictEqual } from 'node:util'
import { currentCodexTurn } from './session-attendant-state.js'
import { reserveClaudeQuestion } from './claude-question-bindings.js'
import { ApiCallError, isRetryableReplyPollError, RequestCancelledError } from './client.js'
import { withFileLock } from './file-lock.js'
import { HARNESS_CAPABILITIES } from './harnesses.js'
import { gate } from './hook-gates.js'
import {
  acknowledgementBlockContext,
  amendAcceptedAnswers,
  answersContext,
  classifyJournaledAcknowledgements,
  finishCommittedDelivery,
  holdForAcknowledgement,
  owedAcknowledgements,
  observeQueuedMessagePrompt,
  presentedMessageAcknowledgements,
  reconcileAcknowledgementObligations,
  recoverQueuedAnswers,
  resetAcknowledgementBlocks,
  settleAcceptedAnswers,
  stageAcceptedAnswers,
  stopAnswerOutput,
} from './hook-acknowledgements.js'
import { clearMatchingProjectSession, writeProjectSession } from './hook-project-sessions.js'
import {
  acquireClaimFile,
  releaseClaimFile,
  claimHandoffState,
  claimQuestionPush,
  questionPushHeld,
  QUESTION_OWNER_SUPERSEDE_WAIT_MS,
  releaseQuestionPush,
  supersedeQuestionOwner,
  type QuestionOwnerRole,
} from './hook-question-lock.js'
import {
  closeQuietly,
  drainOrphanRetirements,
  drainRetirements,
  finalizeReplies,
  selectedForClaimedDelivery,
  orphanRetirements,
  pendingAnsweredByPrompt,
  retirePendings,
  retiringQuestion,
} from './hook-question-retirement.js'
import {
  admitQueuedQuestion,
  replaceFrozenSubmission,
  dropPendingQuestion,
  isSamePending,
  pendingQuestions,
  questionSubmissionAttempted,
  queuedQuestionStillEligible,
  rememberQuestionState,
  sourceContextAtHookEvent,
  summarizeRequestIds,
} from './hook-question-state.js'
import {
  clearSessionStateUnlocked,
  endsIncarnation,
  markSessionEnded,
  pendingList,
  readSessionState,
  readSessionIncarnation,
  readSessionEndMarker,
  recordDroppedAnswersUnlocked,
  sessionHasEnded,
  sessionStatePath,
  updateSessionState,
  writeSessionStateUnlocked,
  recordSessionNotified,
} from './hook-session-state.js'
import { currentProcessIdentity, pidExists, processIdentityLiveness } from './process-identity.js'
import { userPromptContextOutput } from './session-activation.js'
import {
  answersAlreadyWritten,
  beginHandOff,
  recordUnclaimedHandOffs,
  recoverDeliveryJournal,
  sweepDeliveryJournals,
  type HandOff,
  type SequencerDeps,
} from './session-delivery.js'
import { WRITE_ABORTED_REASON } from './wake-support.js'
import type {
  AcceptedAnswerDelivery,
  AnsweredPending,
  DeliveryOutcome,
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
 * One unanswered question uses the server's full hold window. Concurrent
 * questions retain the bounded collection interval so one unanswered peer
 * cannot hold an already available answer behind its full network wait.
 */
const REPLY_POLL_SECONDS = 25
const CONCURRENT_REPLY_POLL_SECONDS = 5

/**
 * How often a natively answered question is checked for a device correction.
 * The User already answered; a correction is rare and may wait a minute.
 */
export const CORRECTION_POLL_MS = 60_000

/** Longest rest between interruption checks while only corrections are watched. */
const CORRECTION_IDLE_SLICE_MS = 5_000

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
      title: options.questions[0]!.text,
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

function submitQuestion(
  ctx: HookContext,
  sessionId: string,
  entry: PendingQuestion,
  intent: PendingSubmissionIntent,
  notes: string[],
): Promise<SubmissionReceipt> | null {
  try {
    const attempt = admitQueuedQuestion(sessionId, ctx.env, entry, intent, ctx.now(), async () => {
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
      recordConfirmedNativeAnswerTarget(sessionId, ctx.env, { ...entry, request_id: receipt.request_id })
      // Starts attendance: the hub (or, off macOS and Linux, the dormant attendant) begins watching for answers.
      recordSessionNotified(sessionId, ctx.env, ctx.now())
      return receipt
    }, ctx.service_identity)
    if (attempt === null) notes.push('the question was retired or its Approved Machine changed before submission; not uploading it')
    return attempt
  } catch (err) {
    // Only synchronous local admission failed. The callback returns a promise,
    // so transport failures stay on the caller's ambiguous-response path.
    notes.push(`could not admit the queued question; preserving it without upload: ${String(err)}`)
    return null
  }
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
 *
 * A question the Agent already answered natively is only watched for a device
 * correction: an immediate check at most every CORRECTION_POLL_MS, never a long
 * poll, so it holds none of the server's shared long-poll capacity. The set is
 * reread every round because the native answer usually lands mid-wait.
 */
async function waitForAnyReply(
  ctx: HookContext,
  requestIds: string[],
  timeoutSeconds: number,
  interruption?: () => WaiterInterruption | null,
  correctionOnly: () => ReadonlySet<string> = () => new Set(),
  liveRequests: () => ReadonlySet<string> = () => new Set(requestIds),
): Promise<{
  byRequest: Map<string, ReplyView[]>
  degraded: boolean
  permanentFailures: Map<string, string>
  interrupted: WaiterInterruption | null
}> {
  const deadline = ctx.now() + timeoutSeconds * 1000
  let degraded = false
  let firstPoll = true
  const permanentFailures = new Map<string, string>()
  const lastCorrectionPollAt = new Map<string, number>()

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
    const corrections = correctionOnly()
    const nextCorrectionAt = (requestId: string): number =>
      (lastCorrectionPollAt.get(requestId) ?? -Infinity) + CORRECTION_POLL_MS
    const live = liveRequests()
    const polling = requestIds.filter((requestId) => live.has(requestId) && !permanentFailures.has(requestId))
    if (polling.length === 0) {
      return { byRequest: new Map(), degraded, permanentFailures, interrupted: null }
    }
    const holdSeconds = polling.filter((requestId) => !corrections.has(requestId)).length > 1
      ? CONCURRENT_REPLY_POLL_SECONDS : REPLY_POLL_SECONDS
    const pollSeconds = Math.min(holdSeconds, Math.max(0, Math.ceil(remainingMs / 1000)))
    const due = polling.filter((requestId) => !corrections.has(requestId) || nextCorrectionAt(requestId) <= ctx.now())
    if (due.length === 0) {
      // Only correction watches remain and none is due: rest, but stay
      // responsive to SessionEnd and newly registered questions.
      const nextDue = Math.min(...polling.map(nextCorrectionAt))
      await ctx.sleep(Math.max(0, Math.min(nextDue - ctx.now(), deadline - ctx.now(), CORRECTION_IDLE_SLICE_MS)))
      continue
    }
    const results = await Promise.all(
      due
        .map(async (requestId) => {
          const correction = corrections.has(requestId)
          if (correction) lastCorrectionPollAt.set(requestId, ctx.now())
          try {
            return { requestId, ...(await ctx.waitForFirstReply(requestId, correction ? 0 : pollSeconds)) }
          } catch (err) {
            // Our own requests were cancelled (the hub hands over, or the
            // credential changed): nothing was learnt; check ownership now.
            if (err instanceof RequestCancelledError) return { requestId, replies: [] as ReplyView[], degraded: true, cancelled: true }
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
    // A successor that took this owner's claim observes that answer itself:
    // nothing here consumed or closed it.
    if (afterPoll === 'ownership-ended' || afterPoll === 'handed-off') {
      return { byRequest: new Map(), degraded, permanentFailures, interrupted: afterPoll }
    }
    if (byRequest.size > 0 || permanentFailures.size === requestIds.length) {
      return { byRequest, degraded, permanentFailures, interrupted: null }
    }
    if (afterPoll === 'new-question') {
      return { byRequest: new Map(), degraded, permanentFailures, interrupted: afterPoll }
    }
    // Every poll was cancelled and this owner still holds the session: its
    // requests stay cancelled until it is run again, so pause, never spin.
    if (results.every((result) => 'cancelled' in result && result.cancelled === true)) {
      await ctx.sleep(Math.max(0, Math.min(1_000, deadline - ctx.now())))
    }
  }
}

/** Why a long-lived answer owner stops waiting before an answer or its deadline. */
type WaiterInterruption = 'ownership-ended' | 'new-question' | 'handed-off'

/** A session host that still exists is re-identified (PID and start) at most this often. */
const SESSION_HOST_IDENTITY_CHECK_MS = 60_000
const sessionHostCheckedAt = new Map<string, number>()

/**
 * Positive local evidence that the process hosting this session incarnation
 * is gone, read from the process table: its PID is free, or (at most once a
 * minute) a different process now has it. A session whose host is gone is
 * closed, whether or not a SessionEnd hook or the hub recorded it.
 */
function sessionHostGone(sessionId: string, env: NodeJS.ProcessEnv, now: number): boolean {
  const host = readSessionIncarnation(sessionId, env)?.harness_process
  if (host === undefined) return false
  if (!pidExists(host.pid)) return true
  const checkedAt = sessionHostCheckedAt.get(sessionId)
  if (checkedAt !== undefined && now - checkedAt < SESSION_HOST_IDENTITY_CHECK_MS) return false
  sessionHostCheckedAt.set(sessionId, now)
  return processIdentityLiveness(host) === 'gone'
}

/**
 * Local lifecycle signal for a long-lived observer.
 *
 * SessionEnd and terminal-side retirement remove an owned request from pending
 * state; the detached process must stop instead of recreating that session.
 * A host process that is gone closes the session the same way, here, rather
 * than at the end of the answer window. A newly registered or submitted
 * question asks a native observer to hand off to an owner whose lifetime
 * covers the later answer window, and a successor that took this owner's
 * claim (a newer runtime, or the hub) ends this observer at once.
 */
function waiterInterruption(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  requestIds: readonly string[],
  attemptedLocal: ReadonlySet<string>,
  watchHost: { now: () => number } | null = null,
): WaiterInterruption | null {
  if (watchHost !== null && !sessionHasEnded(sessionId, env) && sessionHostGone(sessionId, env, watchHost.now())) {
    const incarnation = readSessionIncarnation(sessionId, env)
    if (incarnation !== null && !endsIncarnation(readSessionEndMarker(sessionId, env), incarnation)) {
      handleSessionEnd(env, { session_id: sessionId }, Date.now())
    }
  }
  if (sessionHasEnded(sessionId, env)) return 'ownership-ended'
  if (!questionPushHeld(sessionId, env)) return 'handed-off'
  const pending = pendingList(readSessionState(sessionId, env))
  const owned = new Set(requestIds)
  if (pending.some((entry) => entry.request_id !== undefined
    ? !owned.has(entry.request_id)
    : !attemptedLocal.has(entry.question_id ?? entry.question))) return 'new-question'
  if (!pending.some((entry) => {
    const requestId = entry.request_id ?? entry.submission?.request_id
    return requestId !== undefined && owned.has(requestId)
  })) {
    // A terminal-side close removes the durable ownership while a request is
    // in flight. Do not keep polling its stale snapshot until server expiry.
    return 'ownership-ended'
  }
  // One question can be retired from the terminal while this observer owns
  // several. That is a per-question change, not whole-session cancellation;
  // the caller filters the changed set after each poll and keeps the rest.
  return null
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
        device.registration_healthy &&
        device.capabilities?.includes('answer') === true &&
        device.derived_status !== 'must_update',
    )
    .filter((device) => configured === null || configured.includes(device.device_id))
    .map((device) => device.device_id)
}

const LATE_STOP_POLL_SECONDS = 4

const LATE_PROMPT_POLL_SECONDS = 3

/** Maximum delivery attempts for the same accepted answer, independent of conversation length. */
export const MAX_ANSWER_DELIVERY_ATTEMPTS = 3

/**
 * How many turns an answer may be *held* before it is settled unread.
 *
 * A hold is not a delivery: the route reported that it handed nothing over, so
 * the agent has not seen the answer and the wake-loop the delivery cap
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
  response: ListRepliesResponse | CloseRepliesResponse | null
}

/**
 * How an answer-collecting close names each question: `deliver` only when
 * the answer's writer will claim the fenced answer before writing it in
 * place — a Claude inbox write or a Codex thread-queue write while this
 * session's attendant holds a lease, or a native form (picker or card) that
 * may still return it. Otherwise no disposition, exactly as released CLIs
 * close.
 */
function answerCloseDisposition(
  ctx: HookContext,
  route: EscalationDeliveryRoute,
  sessionId: string,
): (entry: PendingQuestion) => CloseDisposition | undefined {
  // An immediate reply can beat the attendant's first lease exchange. These
  // queues require a claim before writing, so preserve its selection at close.
  if ((ctx.harness === 'openclaw' || ctx.harness === 'hermes' || ctx.harness === 'grok') && route.kind === 'session-queue') return () => 'deliver'
  const claims = ctx.answerClaims
  if (!claimableRoute(route) || claims === undefined) return () => undefined
  // A native form writes only a selected answer, and it may be answered
  // before the attendant's first lease exchange: decided by the question's
  // own registration, not by how far the lease has got.
  return (entry) => claims.lease() != null || nativeFormMayAnswer(readSessionState(sessionId, ctx.env), entry.question_id)
    ? 'deliver' : undefined
}

/** Routes that write into the running session itself, so a claim can cover the write. */
function claimableRoute(route: EscalationDeliveryRoute): boolean {
  return route.kind === 'inbox-socket' || route.kind === 'session-queue'
}

/** The claim marker for an answer its own `deliver` close selected. */
function claimMarker(
  response: ListRepliesResponse | CloseRepliesResponse | null | undefined,
): { delivery_claim?: true } {
  return selectedForClaimedDelivery(response) ? { delivery_claim: true } : {}
}

/** Close several windows concurrently without confusing failure with silence. */
async function finalizePendings(
  ctx: HookContext,
  sessionId: string,
  pending: PendingQuestion[],
  disposition?: (entry: PendingQuestion) => CloseDisposition | undefined,
): Promise<FinalizedPending[]> {
  return Promise.all(
    pending.map(async (entry) => {
      const response = await finalizeReplies(ctx, entry.request_id!, disposition?.(entry))
      if (response !== null && response.request_id === entry.request_id) {
        recordConfirmedNativeAnswerTarget(sessionId, ctx.env, entry)
      }
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
        ...claimMarker(finalized.response),
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
  state: SessionState,
): Promise<{
  answered: AnsweredPending[]
  transientTrouble: boolean
  permanentFailures: Map<string, string>
}> {
  const polls = await Promise.all(
    // A natively answered question is only checked for a correction: no wait.
    live.map((entry) =>
      pollPendingReply(ctx, entry, hasSettledNativeAnswer(state, entry.question_id) ? 0 : timeoutSeconds)),
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
  const sessionId = envelope.session_id
  if (!sessionId) return { notes: [] }
  if (ctx.harness === 'codex') {
    const presented = observeQueuedMessagePrompt(sessionId, ctx.env, envelope.prompt)
    if (presented.length > 0) ctx.log?.info('delivery.handoff', {
      route: 'session-queue', stage: 'prompt-observed', message_ids: presented,
    })
  }
  // Owed Session Message acknowledgements come before any resumed work: a
  // session resumed after SessionEnd has no Stop to remind it first.
  const reminder: PromptReminder = { text: await messageAcknowledgementReminder(ctx, sessionId), used: false }
  const outcome = await answerPrompt(ctx, envelope, sessionId, reminder)
  if (reminder.text === null || reminder.used || outcome.stdout !== undefined || sessionHasEnded(sessionId, ctx.env)) {
    return outcome
  }
  const stdout = userPromptContextOutput(ctx.harness, reminder.text)
  if (stdout === undefined) return outcome
  outcome.notes.push('an owed Session Message acknowledgement was added to the user\'s new turn')
  return {
    ...outcome,
    stdout,
    decided: false,
    log: { ...outcome.log, stage: outcome.log?.['stage'] ?? 'acknowledgement-reminded' },
  }
}

interface PromptReminder {
  text: string | null
  used: boolean
}

/** Context for the new turn, carrying the owed-acknowledgement reminder once. */
function withReminder(reminder: PromptReminder, context: string): string {
  if (reminder.text === null) return context
  reminder.used = true
  return `${context}\n\n${reminder.text}`
}

/**
 * The instruction for Session Message acknowledgements still owed after asking
 * the service, or null when none is.
 */
async function messageAcknowledgementReminder(ctx: HookContext, sessionId: string): Promise<string | null> {
  const generation = ctx.harness === 'openclaw' ? readSessionIncarnation(sessionId, ctx.env)?.openclaw_generation : undefined
  const owed = presentedMessageAcknowledgements(readSessionState(sessionId, ctx.env))
    .filter((entry) => ctx.harness !== 'openclaw' || (generation !== undefined && entry.openclaw_generation === generation))
  if (owed.length === 0) return null
  const still = await reconcileAcknowledgementObligations(ctx, sessionId, owed)
  return still.length === 0 ? null : acknowledgementBlockContext(still)
}

async function answerPrompt(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  reminder: PromptReminder,
): Promise<HookOutcome> {
  const notes: string[] = []

  recoverQueuedAnswers(sessionId, ctx.env)
  let state = readSessionState(sessionId, ctx.env)
  if (state.accepted !== undefined || (state.delivered_answers?.length ?? 0) > 0) {
    // A successful command can clear local debt before the next Stop, and a
    // interrupted command can leave debt after the service recorded its
    // acknowledgement. Reconcile both before replaying recovery context.
    await reconcileAcknowledgementObligations(ctx, sessionId, state.acknowledgement_due ?? [])
    if (sessionHasEnded(sessionId, ctx.env)) {
      notes.push('the Agent Session ended before answer delivery; stopping this observer')
      return { notes }
    }
    state = readSessionState(sessionId, ctx.env)
    if (
      state.accepted !== undefined &&
      acceptedAnswersAwaitingAcknowledgement(state.accepted, state).length === 0
    ) {
      settleAcceptedAnswers(ctx, sessionId, state.accepted, envelope.cwd)
      state = readSessionState(sessionId, ctx.env)
    }
  }
  if (state.accepted !== undefined) {
    // A journaled write of this batch already began (claimed, or recorded
    // after an unclaimed hand-off): adding it to this turn would hand it over
    // twice. It settles instead; its acknowledgement stays owed.
    const written = answersAlreadyWritten(
      sessionId,
      ctx.env,
      state.accepted.answers.flatMap(({ pending }) => (pending.request_id === undefined ? [] : [pending.request_id])),
    )
    if (written.length > 0) {
      settleAcceptedAnswers(ctx, sessionId, state.accepted, envelope.cwd)
      ctx.log?.info('hook.answer', {
        answered: true,
        stage: 'replay-suppressed',
        route: 'user-prompt-submit',
        journal: written.map((entry) => `${entry.requestId}:${entry.stage}`),
      })
      notes.push('an earlier hand-off of the journaled answer already began its write; not adding it to this turn')
      state = readSessionState(sessionId, ctx.env)
    }
  }
  if (state.accepted !== undefined) {
    const answers = [
      ...(state.delivered_answers ?? []),
      ...acceptedAnswersAwaitingAcknowledgement(state.accepted, state),
    ]
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
      withReminder(reminder, prepareOrdinaryAnswersContext(ctx, sessionId, answers, state.accepted.remaining)),
    )
    if (stdout !== undefined) {
      notes.push('the journaled device answer was added to the user\'s new turn')
      const selected = unclaimedSelectedAnswers(sessionId, ctx.env, answers)
      return {
        stdout,
        decided: false,
        notes,
        ...(selected.length === 0
          ? {}
          : { afterOutput: () => reportHandedOffAfterTheFact(ctx, sessionId, selected) }),
        log: {
          stage: 'context-added',
          route: 'user-prompt-submit',
          request_ids: answers.flatMap(({ pending }) =>
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
  // Grok discards allowed UserPromptSubmit context. Leave collection and close
  // to its Stop owner, which selects the native continuation or claimed queue.
  // Closing here would lose the delivery selection needed by the leader route.
  if (live.length > 0 && ctx.harness !== 'grok') {
    const { answered, transientTrouble, permanentFailures } = await pollPendingReplies(
      ctx,
      live,
      LATE_PROMPT_POLL_SECONDS,
      state,
    )
    const finalized = await finalizePendings(
      ctx,
      sessionId,
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
  const matched = pendingAnsweredByPrompt(envelope.prompt, pendingList(state)).filter(entry => mayRetireFromPrompt(state, entry))
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
    const matchedNow = pendingAnsweredByPrompt(envelope.prompt, pendingList(current)).filter(entry => mayRetireFromPrompt(current, entry))
    const unmatched = pendingList(current).filter(
      (entry) => !matchedNow.some((item) => isSamePending(item, entry)),
    )
    for (const entry of matchedNow.filter(questionSubmissionAttempted)) {
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

    return matchedNow.reduce(
      (remembered, entry) => rememberQuestionState(
        remembered,
        entry,
        questionSubmissionAttempted(entry) ? 'retired' : 'withdrawn',
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
      withReminder(
        reminder,
        prepareOrdinaryAnswersContext(ctx, sessionId, [...(readSessionState(sessionId, ctx.env).delivered_answers ?? []), ...lateAnswers], questionsAwaitingAnswer(updated).length),
      ),
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
      settlementRequired: needsQuestionSettlement(updated, ctx.harness),
    }
  }
  const retired = await drainRetirements(ctx, sessionId, ctx.env)
  const orphaned = await drainOrphanRetirements(ctx, ctx.env, ctx.now())
  await sweepDeliveryJournalsFor(ctx)
  const swept = [...retired, ...orphaned]
  if (swept.length > 0) {
    notes.push(`retired question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
  }
  const delivered = readSessionState(sessionId, ctx.env).delivered_answers ?? []
  const stdout = delivered.length > 0
    ? userPromptContextOutput(ctx.harness, withReminder(reminder, prepareOrdinaryAnswersContext(ctx, sessionId, delivered, questionsAwaitingAnswer(updated).length)))
    : undefined
  return {
    notes,
    ...(stdout === undefined ? {} : {
      stdout,
      log: { stage: 'context-added', route: 'user-prompt-submit', request_ids: summarizeRequestIds(delivered.map((entry) => entry.pending)).ids },
    }),
    settlementRequired: needsQuestionSettlement(updated, ctx.harness),
  }
}

/** Legacy prompt/Stop context routes bypass the common drain. Select ordinary
 * presentation durably before returning any answer bytes to those writers.
 */
function prepareOrdinaryAnswersContext(ctx: HookContext, sessionId: string, answers: AnsweredPending[], remaining: number): string {
  if (ctx.harness === 'codex') {
    const ids = new Set(answers.flatMap(answer => answer.pending.question_id === undefined ? [] : [answer.pending.question_id]))
    updateSessionState(sessionId, ctx.env, state => markCodexOrdinaryPresentation(state, ids))
  }
  return answersContext(answers, remaining)
}

function settledNativeRequestIds(state: SessionState): Set<string> {
  return new Set(pendingList(state).flatMap((entry) =>
    entry.request_id !== undefined && hasSettledNativeAnswer(state, entry.question_id) ? [entry.request_id] : []))
}

/** The "still waiting" count beside delivered answers: registered questions
 * with neither a delivered answer nor a reported native one. */
function stillAwaitingAnswer(state: SessionState, answered: AnsweredPending[]): number {
  return questionsAwaitingAnswer(state)
    .filter((entry) => !answered.some(({ pending }) => isSamePending(pending, entry))).length
}

function needsQuestionSettlement(state: SessionState, harness: HookContext['harness']): boolean {
  return pendingList(state).some((entry) => entry.request_id === undefined || harness === 'codex')
}

/** Absence of debt proves consumption only for an explicitly classified answer. */
function acceptedAnswersAwaitingAcknowledgement(
  accepted: AcceptedAnswerDelivery,
  state: SessionState,
): AnsweredPending[] {
  return accepted.answers.filter(({ pending, agent_acknowledgement_required }) =>
    agent_acknowledgement_required !== true ||
    pending.request_id === undefined ||
    (state.acknowledgement_due ?? []).some((entry) => entry.request_id === pending.request_id),
  )
}

// ---------------------------------------------------------------------------
// Answer ownership — observe registered questions through a harness delivery route
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
  hubHandoff = false,
  owner: QuestionOwnerRole = 'stop',
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
    hubHandoff,
    owner,
  })
}

/**
 * Acquire the per-session owner, waiting only when this Stop carries a
 * newly registered question. The live owner sees that state on its next reply
 * poll and yields; without this handoff the new question could sit unpushed for
 * the older question's complete answer window.
 *
 * A background owner (detached, or the hub) also takes over from an owner
 * that must not keep the session's questions: one from an older runtime, one
 * that outlived its own window, or, for the hub, a detached one
 * (`supersedeQuestionOwner`). A Stop hook never waits for that.
 */
async function acquireQuestionOwner(
  ctx: HookContext,
  sessionId: string,
  hardDeadlineAt: number,
  owner: QuestionOwnerRole,
): Promise<boolean> {
  if (sessionHasEnded(sessionId, ctx.env)) return false
  const claim = (): boolean => claimQuestionPush(sessionId, ctx.env, Date.now(), undefined, hardDeadlineAt, owner)
  if (claim()) return true

  if (owner !== 'stop') {
    const supersedeUntil = Math.min(hardDeadlineAt, ctx.now() + QUESTION_OWNER_SUPERSEDE_WAIT_MS)
    let logged = false
    while (ctx.now() < supersedeUntil) {
      const step = supersedeQuestionOwner(sessionId, ctx.env, owner)
      if (step.action === 'none') break
      if (!logged) {
        logged = true
        ctx.log?.info('hook.answer', { stage: 'owner-superseded', action: step.action, reason: step.reason, holder_pid: step.pid })
      }
      await ctx.sleep(Math.min(CLAIM_HANDOFF_POLL_MS, Math.max(0, supersedeUntil - ctx.now())))
      if (sessionHasEnded(sessionId, ctx.env)) return false
      if (claim()) return true
    }
  }

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
    if (claim()) return true
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
  // Detached observers have no harness stdout consumer for Stop reminders.
  // They must neither spend reminder attempts nor block fresh answer collection.
  const canRemind = options.recordStop !== false
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
  const owner = options.owner ?? 'stop'
  if (!(await acquireQuestionOwner(ctx, sessionId, hardDeadlineAt, owner))) {
    gate(ctx, 'held', 'claimed-elsewhere', { stage: 'queued' })
    notes.push('another hook is already handling this session; a newly registered question remains queued for the next owner')
    return { notes }
  }
  try {
    recoverQueuedAnswers(sessionId, ctx.env)
    let state = readSessionState(sessionId, ctx.env)
    if (state.accepted !== undefined) {
      const accepted = state.accepted
      if (canRemind && envelope.stop_hook_active === true && pendingList(state).length > 0) {
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
        acceptedAnswersAwaitingAcknowledgement(accepted, state).length === 0
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
      const held = canRemind ? holdForAcknowledgement(ctx, sessionId, due, notes) : null
      if (held !== null) return held
      state = readSessionState(sessionId, ctx.env)
    }

    if (
      state.accepted === undefined && owedAcknowledgements(state).length > 0 &&
      canRemind
    ) {
      const due = await reconcileAcknowledgementObligations(
        ctx,
        sessionId,
        owedAcknowledgements(state),
      )
      const held = canRemind ? holdForAcknowledgement(ctx, sessionId, due, notes) : null
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
      await sweepDeliveryJournalsFor(ctx)
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
      pending,
      notes,
      hardDeadlineAt,
      options.route,
      // After admission the Stop hook hands the answer window to a successor:
      // Codex's detached owner, or for Claude Code the hub, whose session
      // child writes the inbox as the harness's own child.
      options.recordStop !== false && ((ctx.harness === 'codex' && options.route.kind === 'session-queue') ||
        (ctx.harness === 'claude-code' && options.hubHandoff === true)),
      owner,
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
  if (route.kind === 'session-queue' || route.defer !== undefined) {
    accepted = classifyJournaledAcknowledgements(sessionId, ctx.env) ?? accepted
    const ids = new Set(accepted.answers.map((answer) => answer.pending.request_id))
    await reconcileAcknowledgementObligations(
      ctx, sessionId,
      (readSessionState(sessionId, ctx.env).acknowledgement_due ?? []).filter((entry) => ids.has(entry.request_id)),
    )
    if (sessionHasEnded(sessionId, ctx.env)) {
      notes.push('the Agent Session ended before answer delivery; stopping this observer')
      return { notes }
    }
    const unresolved = acceptedAnswersAwaitingAcknowledgement(accepted, readSessionState(sessionId, ctx.env))
    if (unresolved.length === 0) {
      settleAcceptedAnswers(ctx, sessionId, accepted, cwd)
      return {
        notes,
        log: { stage: 'acknowledgement-reconciled', request_ids: [...ids] },
        settlementRequired: pendingList(readSessionState(sessionId, ctx.env)).length > 0,
      }
    }
    accepted = { ...accepted, answers: unresolved }
    // Keep the complete fenced batch in storage until queue completion, so
    // acknowledged members still retain any unconfirmed retirement work.
  }
  const { answers: answered, remaining } = accepted
  const requestIds = summarizeRequestIds(answered.map((entry) => entry.pending)).ids
  if (sessionHasEnded(sessionId, ctx.env)) {
    notes.push('the Agent Session ended before answer delivery; stopping this observer')
    return { notes }
  }
  const replayed = await suppressWrittenReplay(ctx, sessionId, accepted, notes, cwd)
  if (replayed !== null) return replayed
  if (route.defer !== undefined) {
    await route.defer(accepted)
    return {
      notes,
      log: { stage: 'input-staged', route: route.kind, answers: accepted.answers.length },
      settlementRequired: pendingList(readSessionState(sessionId, ctx.env)).length > 0,
    }
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
  if (attempt > MAX_ANSWER_DELIVERY_ATTEMPTS) {
    gate(ctx, 'held', 'delivery-limit', {
      route: route.kind,
      attempts: accepted.delivery_attempts ?? 0,
      limit: MAX_ANSWER_DELIVERY_ATTEMPTS,
      request_ids: requestIds,
    })
    // Settle rather than journal for ever. The answer has been offered as often
    // as any working route could need, it is already in the notes of each of
    // those turns, and the questions it answered still deserve retirement.
    settleAcceptedAnswers(ctx, sessionId, accepted, cwd)
    notes.push(
      `the user's answer reached the ${route.kind} route ${MAX_ANSWER_DELIVERY_ATTEMPTS} times without being acknowledged; not delivering it again`,
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
      let current = readSessionState(sessionId, ctx.env)
      if (current.accepted === undefined) return false
      const acceptedBeforeCommit = current.accepted
      deliveryCommitted = true
      if (ctx.harness === 'codex') current = markCodexOrdinaryPresentation(current,
        new Set(answered.flatMap(answer => answer.pending.question_id === undefined ? [] : [answer.pending.question_id])))
      writeSessionStateUnlocked(file, sessionId, {
        ...current,
        accepted: { ...acceptedBeforeCommit, delivery_committed_at: ctx.now() },
      })
      return true
    })
  }
  // Answers a `deliver` close selected are claimed first, under this session's
  // delivery lock, so an Answer Edit can only follow the write. A claim that
  // cannot be had never withholds the answer: it is written unclaimed, as
  // released CLIs write it, and its edits simply wait.
  const handOff = await claimAnswerHandOff(ctx, sessionId, route, answered)
  let delivered: DeliveryOutcome
  try {
    delivered = await route.deliver({
      context: answersContext(answered, remaining),
      answers: answered.length,
      remaining,
      request_ids: requestIds,
      journal_recorded_at: accepted.recorded_at,
      commitDelivery:
        handOff === null
          ? commitDelivery
          : (writer) => handOff.begin(commitDelivery, { subprocess: writer === 'subprocess' }),
      ...(handOff === null || handOff.claimed.length === 0
        ? {}
        : {
            writeGuard: { writable: () => handOff.writable(), remainingMs: () => handOff.remainingMs() },
            writerGroup: (pgid: number) => handOff.recordGroup(pgid),
          }),
    })
  } catch (err) {
    await handOff?.finish('failed')
    throw err
  }
  await handOff?.finish(
    delivered.acknowledgement === 'delivered'
      ? 'written'
      : delivered.log?.['reason'] === 'write-unconfirmed'
        ? 'failed'
      : delivered.log?.['reason'] === WRITE_ABORTED_REASON
        ? 'aborted'
        : 'not-written',
  )
  if (delivered.acknowledgement === 'delivered' && deliveryCommitted) {
    await reportUnclaimedHandOff(ctx, sessionId, answered, handOff)
  }
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
  if (route.kind === 'session-queue' && delivered.acknowledgement === 'delivered') {
    outcome.settlementRequired = pendingList(readSessionState(sessionId, ctx.env)).length > 0
  }
  return outcome
}

/**
 * A restart must never write an answer twice. When this session's delivery
 * journal shows that an earlier hand-off of any answer in the batch already
 * began its write — completed (`written`) or possibly (`writing`, `failed`) —
 * the batch settles without another write. Journal recovery reports the
 * earlier attempt's outcome; an unconfirmed one is never retried.
 */
async function suppressWrittenReplay(
  ctx: HookContext,
  sessionId: string,
  accepted: AcceptedAnswerDelivery,
  notes: string[],
  cwd?: string,
): Promise<HookOutcome | null> {
  const requestIds = accepted.answers.flatMap(({ pending }) =>
    pending.request_id === undefined ? [] : [pending.request_id],
  )
  const written = answersAlreadyWritten(sessionId, ctx.env, requestIds)
  if (written.length === 0) return null
  if (ctx.answerClaims !== undefined) {
    try {
      await recoverDeliveryJournal(answerSequencer(ctx, sessionId, ctx.answerClaims))
    } catch {
      // Reporting is recovery's to retry; suppression does not depend on it.
    }
  }
  settleAcceptedAnswers(ctx, sessionId, accepted, cwd)
  ctx.log?.info('hook.answer', {
    answered: true,
    stage: 'replay-suppressed',
    request_ids: requestIds,
    journal: written.map((entry) => `${entry.requestId}:${entry.stage}`),
  })
  notes.push('an earlier hand-off of this answer already began its write; not writing it again')
  return { notes, log: { stage: 'replay-suppressed', request_ids: requestIds } }
}

/**
 * The Answer Edit release rule needs the fenced answer's outcome. A selected
 * answer written without a claim (the lease moved, the lock stayed busy, the
 * claim was refused) is recorded after the fact as handed off, so its edits
 * follow it instead of waiting on an attempt that never existed.
 */
async function reportUnclaimedHandOff(
  ctx: HookContext,
  sessionId: string,
  answered: AnsweredPending[],
  handOff: HandOff | null,
): Promise<void> {
  const claimed = new Set(
    (handOff?.claimed ?? []).flatMap((attempt) =>
      attempt.subject.type === 'answer' ? [attempt.subject.request_id] : [],
    ),
  )
  const unclaimed = answered.flatMap(({ pending, delivery_claim }) =>
    delivery_claim === true && pending.request_id !== undefined && !claimed.has(pending.request_id)
      ? [pending.request_id]
      : [],
  )
  await reportHandedOffAfterTheFact(ctx, sessionId, unclaimed)
}

/**
 * Journal, then record, selected answers already written without a claim. A
 * record that fails stays in this session's delivery journal, so the next
 * hand-off here or the machine-wide sweep records it later.
 */
export async function reportHandedOffAfterTheFact(
  ctx: HookContext,
  sessionId: string,
  requestIds: readonly string[],
): Promise<void> {
  if (requestIds.length === 0) return
  const writer = ctx.answerClaims?.writer ?? currentProcessIdentity()
  if (writer === null) return
  await recordUnclaimedHandOffs(
    {
      sessionId,
      env: ctx.env,
      client: ctx.client,
      monotonic: ctx.answerClaims?.monotonic ?? (() => performance.now()),
      wall: ctx.now,
      sleep: ctx.sleep,
      writer,
      ...(ctx.log === undefined ? {} : { log: ctx.log }),
    },
    requestIds,
  )
}

function answerSequencer(ctx: HookContext, sessionId: string, claims: NonNullable<HookContext['answerClaims']>): SequencerDeps {
  return {
    sessionId,
    env: ctx.env,
    client: ctx.client,
    monotonic: claims.monotonic,
    wall: ctx.now,
    sleep: ctx.sleep,
    writer: claims.writer,
    ...(ctx.log === undefined ? {} : { log: ctx.log }),
  }
}

/**
 * Selected answers this prompt hands off in its context without a claim; the
 * ones a claimed write already covered are left to that attempt.
 */
function unclaimedSelectedAnswers(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  answers: readonly AnsweredPending[],
): string[] {
  const selected = answers.flatMap(({ pending, delivery_claim }) =>
    delivery_claim === true && pending.request_id !== undefined ? [pending.request_id] : [],
  )
  const covered = new Set(answersAlreadyWritten(sessionId, env, selected).map((entry) => entry.requestId))
  return selected.filter((requestId) => !covered.has(requestId))
}

/** The machine-wide journal sweep, from a hook that already holds a client. */
/**
 * Retire what closed sessions queued, at once: the hub runs this when it learns
 * of a close, so a question on the User's devices does not wait for some later
 * hook in another session.
 */
export async function drainClosedSessionRetirements(ctx: HookContext): Promise<string[]> {
  const retired = await drainOrphanRetirements(ctx, ctx.env, ctx.now())
  await sweepDeliveryJournalsFor(ctx)
  return retired
}

async function sweepDeliveryJournalsFor(ctx: HookContext): Promise<void> {
  const writer = ctx.answerClaims?.writer ?? currentProcessIdentity()
  if (writer === null) return
  try {
    await sweepDeliveryJournals({
      env: ctx.env,
      client: ctx.client,
      writer,
      now: ctx.now(),
      ...(ctx.log === undefined ? {} : { log: ctx.log }),
    })
  } catch {
    // Housekeeping never fails a hook; the next sweep retries.
  }
}

/** How long a waiter waits for the attendant to re-acquire a moved lease. */
const ANSWER_CLAIM_RETRY_MS = 2_000
const ANSWER_CLAIM_ROUNDS = 3

/**
 * Claim every selected answer of this batch for one in-place write, or null
 * when nothing may be claimed: no attendant lease, a route that does not write
 * in place, or a delivery lock another writer kept.
 */
async function claimAnswerHandOff(
  ctx: HookContext,
  sessionId: string,
  route: EscalationDeliveryRoute,
  answered: AnsweredPending[],
): Promise<HandOff | null> {
  const claims = ctx.answerClaims
  const subjects = answered.flatMap(({ pending, delivery_claim }) =>
    delivery_claim === true && pending.request_id !== undefined
      ? [{ type: 'answer' as const, request_id: pending.request_id }]
      : [],
  )
  if (claims === undefined || subjects.length === 0 || !claimableRoute(route)) return null
  const deps = answerSequencer(ctx, sessionId, claims)
  for (let round = 1; ; round += 1) {
    const lease = claims.lease()
    const handOff = lease === null ? null : await beginHandOff(deps, { lease, subjects })
    if (handOff === null) {
      ctx.log?.info('delivery.claimed', {
        subject: 'answer',
        request_ids: subjects.map((subject) => subject.request_id),
        claimed: false,
        reason: lease === null ? 'no-attendant-lease' : 'delivery-lock-busy',
      })
      if (lease === null && round < ANSWER_CLAIM_ROUNDS) {
        await ctx.sleep(ANSWER_CLAIM_RETRY_MS)
        continue
      }
      return null
    }
    // A lease that moved between the close and this claim is re-read once the
    // attendant has had a moment to re-acquire; any other refusal is final.
    const fenced =
      handOff.claimed.length === 0 &&
      handOff.refused.every((refusal) => refusal.reason === 'generation_fenced')
    if (!fenced || round >= ANSWER_CLAIM_ROUNDS) {
      // Grok sends one interjection for the complete batch. A partial claim
      // cannot authorize the other answers included in that same write.
      if ((ctx.harness === 'hermes' && handOff.claimed.length !== subjects.length) ||
          (ctx.harness === 'grok' && handOff.claimed.length !== answered.length)) {
        await handOff.finish('not-written')
        return null
      }
      return handOff
    }
    await handOff.finish('not-written')
    await ctx.sleep(ANSWER_CLAIM_RETRY_MS)
  }
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
  pending: PendingQuestion[],
  notes: string[],
  hardDeadlineAt: number,
  route: EscalationDeliveryRoute,
  handoffToDetachedOwner: boolean,
  owner: QuestionOwnerRole,
): Promise<HookOutcome> {
  const live = pending.filter((entry) => entry.request_id !== undefined)
  const unasked = pending.filter((entry) => entry.request_id === undefined)

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
      readSessionState(sessionId, ctx.env),
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
        sessionId,
        answered.map((entry) => entry.pending),
        answerCloseDisposition(ctx, route, sessionId),
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
        ...claimMarker(response),
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
        notes,
        hardDeadlineAt,
        route,
        handoffToDetachedOwner,
        owner,
      )
    }
    // Questions registered after the earlier push still owe the user their
    // notification; fall through and escalate just those, plus any live
    // question whose owner lease is still running.
  }

  gate(ctx, 'proceeding', 'proceeding', {
    unasked: unasked.length,
    already_live: live.length,
    grace_seconds: ctx.config.ask_grace_seconds.value,
  })
  return await escalate(
    ctx,
    envelope,
    sessionId,
    notes,
    hardDeadlineAt,
    route,
    handoffToDetachedOwner,
    owner,
  )
}

/** Submit independently of the long-lived answer owner, preserving frozen identities. */
export async function submitSessionQuestions(
  ctx: HookContext,
  envelope: HookEnvelope,
  hardDeadlineAt = ctx.now() + QUESTION_WAITER_CEILING_SECONDS * 1000,
  notes: string[] = [],
): Promise<PendingQuestion[]> {
  const sessionId = envelope.session_id
  if (sessionId === undefined || sessionHasEnded(sessionId, ctx.env)) return []
  if (!ctx.config.ask_notifications.value) {
    gate(ctx, 'held', 'notifications-off', { source: ctx.config.ask_notifications.source })
    return []
  }
  const lock = `${sessionStatePath(sessionId, ctx.env)}.submission`
  // This lock spans admission only, never reply polling or harness delivery.
  const lockDeadline = Math.min(hardDeadlineAt, ctx.now() + 60_000)
  let token = acquireClaimFile(lock, {}, Date.now())
  while (token === null && ctx.now() < lockDeadline && !sessionHasEnded(sessionId, ctx.env)) {
    await ctx.sleep(Math.min(50, lockDeadline - ctx.now()))
    token = acquireClaimFile(lock, {}, Date.now())
  }
  if (token === null) {
    notes.push('question submission is already owned; the durable registration remains available for recovery')
    return []
  }
  try {
    const ceilingAt = hardDeadlineAt
    const state = readSessionState(sessionId, ctx.env)
    const pending = pendingList(state)
    if (pending.length > 0 && pending.every((entry) => entry.request_id === undefined)) {
      await awaitTerminalFirstWindow(ctx, Math.min(...pending.map((entry) => entry.asked_at ?? ctx.now())), ceilingAt)
    }
    // Phase one: every registered question reaches the user's devices, each as
    // its own notification — one ask never stands in for another.
    const submitted: PendingQuestion[] = []
    for (const entry of pendingList(readSessionState(sessionId, ctx.env)).filter((entry) => entry.request_id === undefined)) {
      if (entry.service_identity !== undefined && (
        entry.service_identity.machine_id !== ctx.service_identity?.machine_id ||
        entry.service_identity.base_url !== ctx.service_identity?.base_url
      )) {
        notes.push('the registered question belongs to a different Approved Machine; preserving it without uploading')
        continue
      }
      if (!queuedQuestionStillEligible(sessionId, ctx.env, entry)) {
        notes.push('the question was retired before submission; not uploading it')
        continue
      }
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
        if (entry.service_identity !== undefined) prepared.service_identity = entry.service_identity
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
        const attempt = submitQuestion(ctx, sessionId, entry, intent, notes)
        if (attempt === null) continue
        receipt = await attempt
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
            if (readSessionState(sessionId, ctx.env).native_answer_operations?.some(op => op.question_id === entry.question_id)) {
              notes.push('the original submission was rejected; preserving its native answer operation without minting a replacement question')
              continue
            }
            notes.push(
              `question submission was rejected (${err.code}, HTTP ${err.status}); reminting the draft in the current contract instead of replaying the frozen one`,
            )
            const reminted = await prepareQuestionSubmission(ctx, {
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
              // Preserve the original intent; preparation can race an early
              // native answer and is not proof that its obligation disappeared.
              notes.push(reminted.error)
              continue
            }
            if (entry.service_identity !== undefined) reminted.service_identity = entry.service_identity
            if (!replaceFrozenSubmission(sessionId, ctx.env, entry, intent, reminted)) {
              notes.push('the original submission changed or has a native answer obligation; no replacement was admitted')
              continue
            }
            intent = reminted
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
              const attempt = submitQuestion(ctx, sessionId, entry, intent, notes)
              if (attempt === null) continue
              receipt = await attempt
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
      // Record what is now live on the user's devices BEFORE any wait. If we
      // only learned these ids afterwards, a question that timed out would
      // leave no trace, and the user returning to the terminal could never
      // retire it — the notification would stay answerable for an hour with
      // nobody listening.
      if (admissionConfirmed) {
        updateSessionState(sessionId, ctx.env, (current) => {
          current = confirmNativeAnswerTarget(current, live)
          const list = pendingList(current)
          const index = list.findIndex(
            (candidate) => isSamePending(candidate, entry) && candidate.request_id === undefined &&
              (candidate.service_identity === undefined || (
                candidate.service_identity.machine_id === ctx.service_identity?.machine_id &&
                candidate.service_identity.base_url === ctx.service_identity?.base_url
              )),
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
          return rememberQuestionState({ ...current, retiring }, live, 'retired')
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
      if (!pendingList(readSessionState(sessionId, ctx.env)).some((candidate) => isSamePending(candidate, entry))) {
        // A local close won after admission. Never resurrect the queue or wait
        // for an answer to a retired question; settle its reserved remote id.
        await drainRetirements(ctx, sessionId, ctx.env)
        continue
      }
      submitted.push(live)
    }

    return submitted
  } finally {
    releaseClaimFile(lock, token)
  }
}

/** Merge this admission's uncertain receipts with fresh confirmed state. */
function observableQuestions(state: SessionState, submitted: PendingQuestion[], now: number): PendingQuestion[] {
  return pendingList(state).flatMap((entry) => {
    if (entry.request_id !== undefined) return ownerLeaseActive(entry, now) ? [entry] : []
    const attempted = submitted.findLast((candidate) =>
      isSamePending(candidate, entry) && candidate.request_id === entry.submission?.request_id)
    return attempted === undefined ? [] : [attempted]
  })
}

/**
 * The observer that sees its session close holds a client, so it records the
 * end with the service at once instead of leaving the expiry to the next
 * hook: the service expires the session's open questions, drops answers the
 * agent never read, and retires them silently from every device. Only the
 * incarnation this close ended is reported. The service accepts an end from
 * the lease holder alone and ending twice changes nothing, so this and the
 * Session Attendant's own report never conflict.
 */
async function reportSessionClosed(ctx: HookContext, sessionId: string, notes: string[]): Promise<void> {
  const marker = readSessionEndMarker(sessionId, ctx.env)
  const incarnation = readSessionIncarnation(sessionId, ctx.env)
  if (marker === null || incarnation === null || marker.ends !== incarnation.key) return
  try {
    await ctx.client.attend(sessionId, { incarnation: incarnation.incarnation, state: 'ended' }, { waitSeconds: 0 })
    notes.push('recorded the closed session with the service; its questions expire now')
    ctx.log?.info('hook.retirement', { session_closed: true, attempted: true, proven: true })
  } catch (err) {
    // The queued retirements and the attendant's report remain the fallback.
    ctx.log?.info('hook.retirement', {
      session_closed: true,
      attempted: true,
      proven: false,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The escalation itself, split out so the claim is released on every path. */
async function escalate(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  notes: string[],
  hardDeadlineAt: number,
  route: EscalationDeliveryRoute,
  handoffToDetachedOwner: boolean,
  owner: QuestionOwnerRole,
): Promise<HookOutcome> {
  const ceilingAt = hardDeadlineAt
  const attemptedLocal = new Set(pendingList(readSessionState(sessionId, ctx.env))
    .filter((entry) => entry.request_id === undefined).map((entry) => entry.question_id ?? entry.question))
  const submitted = await submitSessionQuestions(ctx, envelope, hardDeadlineAt, notes)
  // Another submitter may have promoted a question while this owner waited.
  // The durable queue, not either caller's earlier snapshot, is authoritative.
  const live = observableQuestions(readSessionState(sessionId, ctx.env), submitted, ctx.now())
  const anomalous = live.filter((entry) => entry.reply_deadline_at !== undefined &&
    entry.reply_deadline_at > ceilingAt)
  if (anomalous.length > 0) notes.push('server committed an answer deadline beyond this process owner; reconciling the anomalous window')
  const staleLive = live.filter(
    (entry) =>
      entry.reply_deadline_at === undefined || entry.reply_deadline_at <= ctx.now() || anomalous.includes(entry),
  )
  const finalizedStale = await finalizePendings(ctx, sessionId, staleLive, answerCloseDisposition(ctx, route, sessionId))
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
      `could not finalize ${staleUnproven.length} question${staleUnproven.length === 1 ? '' : 's'}; preserving the live question and observing for recovery`,
    )
  }
  if (staleAnswers.length > 0) {
    const remaining = stillAwaitingAnswer(readSessionState(sessionId, ctx.env), staleAnswers)
    const accepted = stageAcceptedAnswers(ctx, sessionId, staleAnswers, remaining)
    for (const answer of staleAnswers) reportAnswer(ctx, notes, answer, true)
    return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes, envelope.cwd)
  }
  // A terminal close can race the remote close fence. Retain its remote identity
  // for retirement without resurrecting a removed local question.
  const remaining = pendingList(readSessionState(sessionId, ctx.env))
  const removed = staleUnproven.filter(({ pending }) => !remaining.some((entry) => isSamePending(entry, pending)))
  if (removed.length > 0) await retirePendings(ctx, envelope, sessionId, removed.map(({ pending }) => pending), 'answered_elsewhere')
  const waitingState = readSessionState(sessionId, ctx.env)
  const waitingOn = observableQuestions(waitingState, submitted, ctx.now()).filter(
    (entry) => entry.reply_deadline_at !== undefined && entry.reply_deadline_at > ctx.now(),
  )
  if (waitingOn.length === 0) return { notes }

  // Codex has a durable exact-thread queue route. Release the short Stop hook
  // after admission so a detached owner, independent of the TUI process, can
  // observe the entire committed answer window. The owner lease and pending
  // request identities remain in session state for that successor.
  if (handoffToDetachedOwner) {
    return { notes, settlementRequired: true }
  }

  // Phase two: keep the same owner alive across every committed answer window.
  // Different questions may expire at different times, so finalize each one at
  // its own server deadline and continue waiting on the rest. Reserving time by
  // closing early would make the advertised reply window untrue.
  let activeWaiting = waitingOn
  const knownRequestIds = new Set([
    ...pendingList(waitingState).flatMap((entry) => entry.request_id === undefined ? [] : [entry.request_id]),
    ...waitingOn.map((entry) => entry.request_id!),
  ])
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
          [...knownRequestIds],
          attemptedLocal,
          // The hub learns of a closed session from its child; any other
          // long-lived owner reads the process table itself.
          owner === 'hub' ? null : { now: () => ctx.now() },
        ),
      () => settledNativeRequestIds(readSessionState(sessionId, ctx.env)),
      () => new Set(pendingList(readSessionState(sessionId, ctx.env)).flatMap((entry) => {
        const requestId = entry.request_id ?? entry.submission?.request_id
        return requestId === undefined ? [] : [requestId]
      })),
    )
    if (waited.interrupted === 'new-question') {
      // Native observers can renew their process ceiling for a later question.
      // A held Stop keeps its actual stdout owner and includes the new live ID.
      if (route.kind === 'session-queue' || route.defer !== undefined) {
        notes.push('yielding the answer owner to include the newly registered question')
        return { notes, settlementRequired: true }
      }
      for (const entry of pendingList(readSessionState(sessionId, ctx.env))) {
        if (entry.request_id === undefined) attemptedLocal.add(entry.question_id ?? entry.question)
      }
      submitted.push(...await submitSessionQuestions(ctx, envelope, hardDeadlineAt, notes))
      activeWaiting = observableQuestions(readSessionState(sessionId, ctx.env), submitted, ctx.now())
      for (const entry of activeWaiting) knownRequestIds.add(entry.request_id!)
      if (activeWaiting.length === 0) return { notes }
      continue
    }
    if (waited.interrupted === 'handed-off') {
      notes.push('handed this session\'s questions to a newer answer owner; stopping this one')
      ctx.log?.info('hook.answer', { answered: false, stage: 'owner-handed-off' })
      return { notes }
    }
    if (waited.interrupted === 'ownership-ended') {
      notes.push('answer ownership ended locally; stopping this observer without delivering into a closed session')
      if (sessionHasEnded(sessionId, ctx.env)) await reportSessionClosed(ctx, sessionId, notes)
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
    const finalized = await finalizePendings(ctx, sessionId, expired, answerCloseDisposition(ctx, route, sessionId))
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
      const remaining = stillAwaitingAnswer(readSessionState(sessionId, ctx.env), finalAnswers)
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
  const finalizedAnswered = await finalizePendings(ctx, sessionId, polledAnswered, answerCloseDisposition(ctx, route, sessionId))
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
      ...claimMarker(finalized.response),
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
    stillAwaitingAnswer(readSessionState(sessionId, ctx.env), answered),
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
 *
 * A closed session is closed: nothing is kept for it to resume. An answer the
 * agent never read is dropped and named in the end marker, and owed Agent
 * Acknowledgements are cancelled, because a closed session cannot write one.
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
  const ending = markSessionEnded(sessionId, env, now)
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
  for (const answer of [...(state.accepted?.answers ?? []), ...(state.delivered_answers ?? []), ...(state.waiting_answers ?? [])]) {
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
    ...(state.delivered_answers?.map((entry) => entry.pending) ?? []),
    ...(state.waiting_answers?.map((entry) => entry.pending) ?? []),
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
      `queued ${orphans.length} question${orphans.length > 1 ? 's' : ''} for retirement`,
    )
  }
  return withFileLock(`${sessionStatePath(sessionId, env)}.lock`, () => {
    const marker = readSessionEndMarker(sessionId, env)
    if (marker?.stamp?.mono !== ending.stamp?.mono ||
        (readSessionIncarnation(sessionId, env)?.key ?? null) !== ending.ends) {
      return { notes, log: { outcome: 'preserved', reason: 'session-resumed-during-cleanup' } }
    }
    // Re-read under the lock: a receipt committed after the end marker
    // belongs to this close too.
    const state = readSessionState(sessionId, env)
    const history = stateWithHistory.question_history
    const dropped = unreadAnswerRequestIds(state)
    if (dropped.length > 0) {
      recordDroppedAnswersUnlocked(sessionId, env, ending, dropped)
      notes.push(
        `dropped ${dropped.length} unread device answer${dropped.length === 1 ? '' : 's'} with the closed session`,
      )
    }
    const log = {
      queued_retirements: orphans.length,
      ...(dropped.length === 0 ? {} : { dropped_answers: dropped.length }),
    }
    if ((state.native_answer_operations?.length ?? 0) > 0 || (state.codex_question_bindings?.length ?? 0) > 0) {
      // An agent-reported terminal answer still owes its own report; it is
      // not a delivery into this session. Everything owed to the agent goes.
      const preserved: SessionState = {
        ...state,
        ...(history === undefined ? {} : { question_history: history }),
      }
      for (const field of CLOSED_SESSION_DROPS) delete preserved[field]
      writeSessionStateUnlocked(sessionStatePath(sessionId, env), sessionId, preserved)
      notes.push('preserved native answer reports for this exact session')
      return { notes, log: { outcome: 'native-report-preserved', ...log } }
    }
    clearSessionStateUnlocked(sessionId, env)
    if ((history?.length ?? 0) > 0) {
      writeSessionStateUnlocked(sessionStatePath(sessionId, env), sessionId, { question_history: history! })
    }
    return { notes, log: { outcome: 'cleaned', ...log } }
  })
}

/** What a closed session never keeps: live questions, answers and owed acknowledgements. */
const CLOSED_SESSION_DROPS = [
  'accepted',
  'waiting_answers',
  'delivered_answers',
  'acknowledgement_due',
  'message_acknowledgement_due',
  'acknowledgement_blocks',
  'input_wake',
  'pending',
  'retiring',
] as const satisfies ReadonlyArray<keyof SessionState>

/**
 * Accepted device answers the agent never read: journaled but not yet handed
 * to the harness. An answer whose delivery committed may have been read; it
 * is not called dropped.
 */
function unreadAnswerRequestIds(state: SessionState): string[] {
  const accepted = state.accepted
  const unread = [
    ...(accepted !== undefined && accepted.delivered_at === undefined && accepted.delivery_committed_at === undefined
      ? accepted.answers
      : []),
    ...(state.waiting_answers ?? []),
  ]
  return [...new Set(unread.flatMap(({ pending }) => {
    const requestId = pending.request_id ?? pending.submission?.request_id
    return requestId === undefined ? [] : [requestId]
  }))]
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

export class QuestionRegistrationChanged extends Error {
  constructor(readonly reason: 'credential' | 'owner') {
    super(reason === 'credential'
      ? 'The Approved Machine changed before question registration completed.'
      : 'The Agent Session ended or changed before question registration completed.')
  }
}

interface QuestionRegistrationGuard {
  /** Captured before optional asynchronous discovery; a new turn is allowed. */
  owner_key?: string
  machineStillMatches: () => boolean
}

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
  nativeAdmission?: NativeQuestionAdmission,
  guard?: QuestionRegistrationGuard,
): string {
  let full: 'unasked' | 'live' | null = null
  let stored = false
  let questionId = question.question_id ?? `q_${randomBytes(12).toString('base64url')}`
  updateSessionState(sessionId, env, (state) => {
    // Revalidate after acquiring the lock: discovery and lock contention can
    // outlive the owner or its Approved Machine. Neither may adopt this ask.
    if (guard !== undefined) {
      if (!guard.machineStillMatches()) throw new QuestionRegistrationChanged('credential')
      if (guard.owner_key !== undefined) {
        const owner = readSessionIncarnation(sessionId, env)
        if (owner?.key !== guard.owner_key || sessionHasEnded(sessionId, env) ||
            owner.harness_process === undefined || processIdentityLiveness(owner.harness_process) !== 'alive') {
          throw new QuestionRegistrationChanged('owner')
        }
      }
    }
    if (nativeAdmission?.card !== undefined) {
      if (currentCodexTurn(sessionId, env, nativeAdmission.owner_key) !== nativeAdmission.turn_id) {
        throw new QuestionRegistrationChanged('owner')
      }
      const existing = state.codex_question_bindings?.find(registration => registration.owner_key === nativeAdmission.owner_key &&
        registration.registration_turn_id === nativeAdmission.turn_id && registration.card_call_id === nativeAdmission.card!.call_id)
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing.service_identity, nativeAdmission.service) ||
            !isDeepStrictEqual(existing.questions.map(binding => binding.question), question.questions) ||
            !isDeepStrictEqual(existing.questions.map(binding => binding.card), nativeAdmission.card.shown)) {
          throw new Error('The same Codex card invocation changed after question registration.')
        }
        questionId = existing.question_id
        stored = true
        return state
      }
    }
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
    stored = true
    const registered = { asked_at: now, ...question, question_id: questionId, question: question.question.slice(0, MAX_STORED_QUESTION_CHARS) }
    // Each reservation ignores an admission that is not its own harness's.
    return reserveClaudeQuestion(reserveCurrentCodexQuestion({
      ...state,
      pending: [
        ...pending,
        registered,
      ],
    }, registered, sessionId, env, nativeAdmission), registered, nativeAdmission)
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
  // updateSessionState skips its callback when SessionEnd won the lock.
  if (!stored) throw new QuestionRegistrationChanged('owner')
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
