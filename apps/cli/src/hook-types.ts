/** Value-free contracts shared across hook state and lifecycle modules. */
import type {
  LifecycleEndState,
  MediaItemT,
  NotificationDraftT,
  QuestionT,
  ReplyView,
  SourceContextT,
} from '@raidiant/notifai-protocol'
import { type ApiClient } from './client.js'
import { type CliConfig } from './config.js'
import { type DeliveryRoute, type HookInstallableHarness } from './harnesses.js'
import type { Logger } from './logging.js'
/**
 * Harness hook handlers.
 *
 * The supported harnesses expose the same useful lifecycle joints: a turn-end
 * event and an event that fires when the user submits a prompt. Claude Code
 * and Codex can continue directly from a turn-end answer. Harnesses without a
 * proven exact-session continuation fail closed at question admission.
 *
 * Where the user is standing no longer decides anything here. It used to: the
 * old turn-end route held the terminal briefly and made keyboard presence an
 * input to whether it waited. The current policy is explicit instead: Claude
 * Code owns the complete answer window out of band, while Codex owns it by
 * holding the asking turn. Neither infers notification preference from
 * keystrokes.
 */

/** Fields we read from harness hook JSON. Everything else is passed through. */
export interface HookEnvelope {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  /** How a harness lifecycle began: startup, resume, clear, compact, or fork. */
  source?: string
  /** Set by the harness when this Stop follows a previous Stop continuation. */
  stop_hook_active?: boolean
  /** Cursor's stable per-conversation identifier. */
  conversation_id?: string
  /** Cursor's project roots; the first is the hook's configuration root. */
  workspace_roots?: string[]
  /** Cursor increments this after each stop-hook automatic follow-up. */
  loop_count?: number
  /** Cursor Stop completion state; cancellation must not auto-follow. */
  status?: string
  /** The prompt the user just submitted, when the harness includes it. */
  prompt?: string
}

export interface SessionState {
  /** Harness that owns this exact lifecycle state. */
  harness?: HookHarness
  /** Checkout whose hook definition activated this session; lifecycle diagnostics only. */
  activation_cwd?: string
  /** Codex Stop definition observed when this exact Agent Session activated. */
  codex_stop_definition_fingerprint?: string
  /** Cursor's documented session context path is lossy; bounded first-Stop fallback journal. */
  cursor_activation_claimed_at?: number
  cursor_activation_confirmed_at?: number
  /** Epoch ms of the user's last prompt in this session — our presence signal. */
  last_prompt_at?: number
  /** Epoch ms of the last observed Stop hook, distinct from prompt routing. */
  last_stop_at?: number
  /**
   * Questions registered by `notifai ask`, in registration order, each
   * awaiting escalation or its answer. A list, deliberately: registering a
   * question never ends an earlier one. Superseding is reply semantics — a
   * later reply corrects an earlier reply to the same question — never
   * question semantics; the single-slot model silently discarded a live
   * question the moment a second was registered (2026-08-09).
   */
  pending?: PendingQuestion[]
  /**
   * Bounded terminal history for stable `q_...` lookup after the live queue is
   * gone. It carries identities and lifecycle state only; question content
   * remains in the ordinary pending/retirement records under their existing
   * retention boundary.
   */
  question_history?: QuestionHistoryEntry[]
  /**
   * Questions that have been delivered to the user's devices and are now dead,
   * but whose retirement has not been confirmed yet.
   *
   * A retirement needs a network call and the moment we learn a question is
   * dead is not always a moment we can make one — the user's return to the
   * terminal is observed by a bare hook, and the machine may be offline.
   * Dropping the ids there is how a delivered question becomes permanently
   * unretirable, so they are parked here instead and every later hook with a
   * client drains them. Retirement is idempotent, so a duplicate attempt
   * costs nothing and a missed one costs a stale notification for ever.
   */
  retiring?: RetiringQuestion[]
  /**
   * Tracks bounded Stop continuations so a follow-up ask is delivered once.
   * `count` is how many answer generations have run consecutively without the
   * user taking a turn themselves; their next prompt starts it over.
   */
  continuation?: {
    answered_at: number
    count: number
  }
  /**
   * A phone answer durably captured but not yet acknowledged. It stays here
   * until a delivery is acknowledged — by the route's own write, or by the
   * successor Stop of a blocking continuation — so a crash before the answer
   * reaches the harness replays it instead of erasing it.
   */
  accepted?: AcceptedAnswerDelivery
  /**
   * Required Agent Acknowledgements that the resumed agent still owes. This is
   * separate from answer delivery: the answer journal may settle as soon as a
   * harness accepts the continuation, while this obligation must survive until
   * the service confirms the agent-authored follow-up exists.
   */
  acknowledgement_due?: AcknowledgementDue[]
  /** Consecutive turns this session has been held for an acknowledgement. */
  acknowledgement_blocks?: number
}

export interface AcknowledgementDue {
  request_id: string
  recorded_at: number
  /**
   * Whether this request's acknowledgement must carry text. Absent on state
   * written before the obligation started recording it; treated as true, which
   * is the default the service ships.
   */
  text_required?: boolean
}

export interface AcceptedAnswerDelivery {
  answers: AnsweredPending[]
  remaining: number
  recorded_at: number
  /**
   * Epoch ms when a route's own write handed this answer to the harness, with
   * the route that performed it. Recorded so that "this answer was delivered"
   * is a fact on the journal rather than something inferred from a harness flag
   * that only one route ever sets.
   */
  delivered_at?: number
  delivered_route?: string
  /**
   * How many times this answer has been handed to any route. The route-agnostic
   * loop backstop: bounded by `MAX_CONTINUATION_COUNT` in one place every route
   * passes through.
   */
  delivery_attempts?: number
  /**
   * Linearization point between delivery and SessionEnd. Once recorded, the
   * route began first; before it, SessionEnd cancellation wins.
   */
  delivery_committed_at?: number
  /** Turns this answer has been held without being handed to the agent. */
  held_deliveries?: number
}

/** A delivered question awaiting its retirement push. */
export interface RetiringQuestion {
  /** Stable local identity retained through remote retirement. */
  question_id?: string
  request_id: string
  collapse_key: string
  /** The Device Installations that actually received the question. */
  device_ids: string[]
  /** Shown if the companion has no history entry to correlate against. */
  question: string
  project?: string
  source?: SourceContextT
  state: LifecycleEndState
}

/**
 * A retirement that outlived its session.
 *
 * Per-session parking assumes some later hook in the SAME session will hold a
 * client, and `SessionEnd` is exactly where that assumption breaks: it may not
 * touch the network, and no hook for that session ever fires again. Deleting
 * the state there lost the only copy of the delivered question's ids, so the
 * phone kept an answerable question nobody was listening to. These entries are
 * moved to a machine-global queue instead, drained by whichever session's hook
 * next holds a client.
 */
export interface OrphanRetirement extends RetiringQuestion {
  /** Epoch ms when the entry was orphaned; entries beyond the TTL are dropped. */
  enqueued_at: number
}

/** A fully prepared question submission whose ownership deadline is fixed. */
export interface PendingSubmissionIntent {
  request_id: string
  idempotency_key: string
  collapse_key: string
  device_ids: string[]
  draft: NotificationDraftT
  owner_deadline_at: number
}

export interface PendingQuestion {
  /** Stable local identity across racing state writers and submit recovery. */
  question_id?: string
  /** One-line summary: the single question's text, or the set's first. */
  question: string
  /** Purpose-written plain text for native banners and notification lists. */
  summary: string
  /**
   * Epoch ms when `notifai ask` registered this. The grace window runs from
   * here, not from the turn's end: a question the agent asked five minutes ago
   * while it kept working has already served its wait in the terminal.
   */
  asked_at?: number
  /**
   * The full question set as `notifai ask` validated it: generated ids,
   * texts, choices, multi flags. What actually rides the push.
   */
  questions?: QuestionT[]
  /** Optional standalone Markdown Body composed when the question was registered. */
  body?: string
  /** Final ordered media collection; uploads complete before registration. */
  media?: MediaItemT[]
  /** Final Project and Source Context frozen at registration. */
  project?: string
  source?: SourceContextT
  /** Set once the question has actually been pushed, so it can be retired. */
  request_id?: string
  collapse_key?: string
  /** Exact fanout of the live question; routing config may change afterwards. */
  device_ids?: string[]
  /** Absolute end of the server reply window. */
  reply_deadline_at?: number
  /**
   * Absolute process-owner deadline. It begins before submission and includes
   * startup headroom, so it must be later than `reply_deadline_at`. Absent on
   * state written before ownership was persisted — treated as already spent
   * instead of inventing a fresh multi-day claim.
   */
  owner_deadline_at?: number
  /** Frozen before the first network byte, so an ambiguous submit is replayable. */
  submission?: PendingSubmissionIntent
}

export type QuestionDeliveryState =
  | 'local'
  | 'frozen'
  | 'live'
  | 'answered'
  | 'withdrawn'
  | 'retired'

export type QuestionTerminalState = Extract<QuestionDeliveryState, 'answered' | 'withdrawn' | 'retired'>

export interface QuestionHistoryEntry {
  question_id: string
  state: QuestionTerminalState
  /** Present only after local promotion proves the Notification Request exists. */
  request_id?: string
  /** Reserved idempotent identity that was never locally promoted. */
  frozen_request_id?: string
}

export interface HookOutcome {
  /** Written to stdout verbatim — the harness parses this as output. */
  stdout?: string
  /** Commit a blocking continuation immediately before the harness stdout write. */
  commitStdout?: () => boolean
  /** Whether stdout takes over the turn, rather than adding prompt context. */
  decided?: boolean
  /** Diagnostics; harnesses surface hook stderr in the transcript. */
  notes: string[]
  /** Structured lifecycle detail that belongs on hook.end without user text. */
  log?: Record<string, unknown>
  /** An unpushed registration survived UserPromptSubmit and needs its own owner. */
  settlementRequired?: boolean
}

/** An accepted continuation ready for whichever host owns the last meter. */
export interface ContinuationEvent {
  context: string
  answers: number
  remaining: number
  request_ids: string[]
  journal_recorded_at: number
  /**
   * Must be called immediately before the route's irreversible harness write.
   * It atomically orders that write against SessionEnd; false means cancellation
   * won and the route must hand nothing over.
   */
  commitDelivery(): boolean
}

/**
 * How much a route's own return proves about where the answer ended up.
 *
 * Acknowledgement belongs to the delivery, not to the harness envelope: routes
 * end in different places, so no single field on a hook payload can speak for
 * all of them. `stop_hook_active` is the harness confirming that a *blocking
 * continuation* was admitted; it stays false for ever on a route that starts a
 * brand-new turn instead of continuing this one, so a journal keyed to it alone
 * never settles and every later turn-end redelivers the same answer.
 *
 * - `delivered` — the route completed a write to the harness itself (an inbox
 *   socket, a cold resume). Delivery is not consumption: the write proves the
 *   harness accepted the message, never that the model acted on it. But nothing
 *   later will ever prove more, and redelivering an answer without end is
 *   strictly worse than settling on the write, so the journal settles here.
 * - `stdout` — the answer is this process's stdout, which the harness reads only
 *   after this process exits. Nothing this process can write is proof, so the
 *   journal waits for the successor Stop's `stop_hook_active`, and a crash
 *   before stdout replays the answer instead of losing it.
 * - `held` — the route handed nothing over; the journal replays the answer.
 */
export type DeliveryAcknowledgement = 'delivered' | 'stdout' | 'held'

/** What a route returns: the hook's outcome plus what the attempt proved. */
export interface DeliveryOutcome {
  stdout?: string
  /** Deferred SessionEnd fence for a blocking stdout continuation. */
  commitStdout?: () => boolean
  notes?: string[]
  log?: Record<string, unknown>
  acknowledgement: DeliveryAcknowledgement
}

/** Host adapter injected into the waiter; no route is implemented by the waiter. */
export interface EscalationDeliveryRoute {
  kind: Exclude<DeliveryRoute, 'unsupported'>
  deliver(event: ContinuationEvent): Promise<DeliveryOutcome>
}

export interface EscalationWaiterOptions {
  sessionId: string
  envelope: HookEnvelope
  route: EscalationDeliveryRoute
  processDeadlineAt?: number
  /** Stop owns diagnostics; a pre-Stop recovery owner must not impersonate it. */
  recordStop?: boolean
}

export interface HookContext {
  client: ApiClient
  config: CliConfig
  env: NodeJS.ProcessEnv
  now: () => number
  /** Injected so tests advance a virtual clock instead of sleeping. */
  sleep: (milliseconds: number) => Promise<void>
  /** Bounded wait for the first reply; injected so tests do not sleep. */
  waitForFirstReply: (
    requestId: string,
    timeoutSeconds: number,
  ) => Promise<{ replies: ReplyView[]; timedOut: boolean; degraded?: boolean }>
  /** The active harness selects the native continuation output adapter. */
  harness?: HookHarness
  /**
   * The local record. A hook's decisions are invisible from everywhere else —
   * its stderr belongs to the harness and its usual outcome is to do nothing —
   * so this is the only account of why a question did or did not travel.
   */
  log?: Logger
}

export type HookHarness = HookInstallableHarness

/** One answered registered question, with everything the agent needs to read it. */
export interface AnsweredPending {
  pending: PendingQuestion
  reply: ReplyView
  replies: ReplyView[]
  /** Immutable server snapshot for this request, known after a replies/close response. */
  agent_acknowledgement_required?: boolean | undefined
  /** Whether that acknowledgement must carry text; the account's snapshot. */
  agent_acknowledgement_text_required?: boolean | undefined
}
