import type { CodexTerminalObservation, CodexTerminalConflict } from './codex-terminal-answers.js'
import type { RuntimeBuildReference } from './launch-self.js'
import type { InputWakeAttempt } from './session-input-wakes.js'
import type { NativeAnswerOperation } from './native-answer-operation.js'
import type { CodexQuestionRegistration } from './codex-question-bindings.js'
import type { ServiceIdentity } from './credentials.js'
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
import type { ProcessIdentity } from './process-identity.js'
import type { DeliveryLease } from './session-delivery.js'
import type { WriteGuard } from './wake-support.js'
/**
 * Harness hook handlers.
 *
 * The supported harnesses expose the same useful lifecycle joints: a turn-end
 * event and an event that fires when the user submits a prompt. Claude Code
 * and Codex can continue directly from a turn-end answer. Harnesses without a
 * proven exact-session continuation fail closed at question admission.
 *
 * Registration schedules background submission. Native observers and held Stop routes
 * own answer delivery separately; neither infers notification preference from
 * keyboard presence.
 */

/** Fields we read from harness hook JSON. Everything else is passed through. */
export interface HookEnvelope {
  session_id?: string
  /** Grok's native envelope; snake-case identity is only a compatibility alias. */
  sessionId?: string
  /** Private detached-observer handoff; must match the current local key. */
  grok_incarnation_key?: string
  promptId?: string
  subagentType?: string
  subagentId?: string
  phase?: string
  reason?: string
  /** OpenClaw's current transcript ID; session_id remains its stable sessionKey. */
  openclaw_native_thread_id?: string
  openclaw_session_id?: string
  openclaw_lifecycle_revision?: string
  /** OpenClaw's lifecycle reason, when its typed hook supplies one. */
  openclaw_reason?: string
  /** OpenClaw's previous transcript ID on a resumed session_start. */
  openclaw_resumed_from?: string
  /** Internal Gateway-service reconciliation of a prepared answer hand-off. */
  openclaw_request_ids?: string[]
  /** 2 from a Notifai Hermes plugin that renders its context as two prompt sections. */
  hermes_prompt_sections?: number
  /** Hermes reports distinct child session ids at turn start. */
  hermes_worker?: boolean
  /**
   * From a Notifai plugin whose harness compacted this conversation since its
   * last activation (OpenCode's `session.compacted`, Hermes rebuilding its
   * system prompt): the start of a compacted conversation, like Claude Code's
   * and Codex's `source: compact`.
   */
  compacted?: boolean
  cwd?: string
  hook_event_name?: string
  /** How a harness lifecycle began: startup, resume, clear, compact, or fork. */
  source?: string
  /** Set by the harness when this Stop follows a previous Stop continuation. */
  stop_hook_active?: boolean
  /** Grok's native spelling; normalized to stop_hook_active by the adapter. */
  stopHookActive?: boolean
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
  /** Claude Code's custom session title, on SessionStart and UserPromptSubmit when one is set. */
  session_title?: string
  /** Claude Code's permission mode (`default`, `auto`, `acceptEdits`, `plan`, ...), on the events that carry it. */
  permission_mode?: string
  /** Tool events: the tool, its input, and after it ran its response. */
  tool_name?: string
  /** Grok native tool-event spellings. */
  toolName?: string
  toolInput?: unknown
  tool_input?: unknown
  tool_response?: unknown
  tool_use_id?: string
  /** Codex's exact turn id on prompt, tool, Stop and Interrupt callbacks. */
  turn_id?: string
  /** Native Codex transcript; only typed lifecycle/question records are consumed. */
  transcript_path?: string
  /** Codex's model slug for this callback's turn. */
  model?: string
  /** Codex child hooks carry the root session_id but name the child here. */
  agent_id?: string
  agent_type?: string
}

export interface SessionState {
  /** Grok's model-visible guidance, re-armed on resume and compaction. */
  grok_activation_context?: string
  /** Grok compacted this session since its activation was last sent. */
  grok_compacted?: boolean
  /** Literal revision received from the loaded hook/module, scoped to this incarnation. */
  integration_observation?: { incarnation: string; revision: string }
  /** Immutable native builds serving live or resumable work in this session. */
  runtime_builds?: RuntimeBuildReference[]
  /** Exact native associations and sticky ordinary-presentation decisions. */
  codex_question_bindings?: CodexQuestionRegistration[]
  /** Never reuse a marker while any registration or operation is retained. */
  codex_question_marker_counter?: number
  /** Uncommitted card input; only rollout confirmation grants reporting authority. */
  codex_terminal_observations?: CodexTerminalObservation[]
  codex_terminal_conflicts?: CodexTerminalConflict[]
  /** Frozen harness reports and their independent report/receipt state. */
  native_answer_operations?: NativeAnswerOperation[]
  /** Content-free native lifecycle proof, scoped to the current owner. */
  codex_native_turn?: { key: string; turn_id: string; transcript_path: string; observed_at?: number }
  /**
   * This owner's Codex ran Notifai's card PreToolUse, so it offers
   * request_user_input_async under this model. Codex offers that tool only for
   * models whose catalog lists it, so the proof holds while the model does.
   */
  codex_card_tool?: { key: string; model: string; transcript_path: string }
  /** Exact incarnation observed executing the currently trusted Codex tool hook. */
  codex_tool_hook?: {
    incarnation: string; fingerprint: string
    /** Absent in historical records that could have been written by a child. */
    root_observed?: { turn_id: string; at: number }
  }
  /** Harness that owns this exact lifecycle state. */
  harness?: HookHarness
  /** Checkout whose hook definition activated this session; canonical session context. */
  activation_cwd?: string
  /** Codex Stop definition observed when this exact Agent Session activated. */
  codex_stop_definition_fingerprint?: string
  /**
   * Every Notifai handler of the Codex definition this exact Agent Session
   * loaded, by name (`codexHandlerFingerprints`). Absent for a session that
   * started before Notifai recorded it.
   */
  codex_handler_fingerprints?: Record<string, string>
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
   * A phone answer durably captured but not yet acknowledged. It stays here
   * until a delivery is acknowledged — by the route's own write, or by the
   * successor Stop of a blocking continuation — so a crash before the answer
   * reaches the harness replays it instead of erasing it.
   */
  accepted?: AcceptedAnswerDelivery
  /** Captured answers waiting for the same foreground drain as Session Messages. */
  waiting_answers?: AnsweredPending[]
  /** The title the User gave this session in the harness itself, as its hooks last reported it. */
  harness_session_title?: string
  /** Host lookup selectors captured by this exact session, never the shared Hub's launcher. */
  harness_title_env?: Record<string, string>
  /** Claude Code's permission mode, as this session's own hooks last reported it. */
  claude_permission_mode?: string
  /**
   * What this session's hooks last saw that a reopen needs (see
   * `session-reopen.ts`): the terminal it runs in and its permission mode.
   */
  reopen_launch?: { terminal: string | null; terminal_seen: string | null; orca_pane: boolean; permission_mode: string | null }
  /**
   * The Claude Code picker now on screen: the device question it registered,
   * the digest of the questions it shows, and the hook process waiting on its
   * app answer.
   */
  claude_picker?: { question_id: string; digest: string; opened_at: number; waiter: ProcessIdentity }
  /**
   * An app answer returned through a picker, until its tool result confirms
   * Claude Code took it. If the terminal answered or the picker was dismissed
   * at that instant, the same answer is still owed to the agent as context.
   */
  claude_picker_presented?: {
    question_id: string; request_id: string; answers: Record<string, string>
    /** The whole answer as ordinary context, for when the tool result never confirms it. */
    context: string
    /** What the agent still needs once the tool result did carry it: the acknowledgement it owes. */
    receipt: string
    at: number
  }
  /**
   * A picker Notifai closed with no answer of its own to return, because the
   * User dismissed its question on a device or answered there in a way the
   * picker could not carry. Its tool result says only that the picker got no
   * answer; this is the context that says why, read once.
   */
  claude_picker_closed?: { question_id: string; digest: string; context: string }
  /**
   * A picker whose waiting handler Claude Code cancelled. Every resolution
   * reaches the handler as a cancellation, so what the picker's result means
   * (an answer, an auto-continue while the User was away, a request for
   * another round, or nothing) is settled by its `PostToolUse`; with none
   * within the bound, the session owner withdraws the device question.
   */
  claude_picker_cancelled?: { question_id: string; digest: string; at: number }
  /**
   * Pickers `notifai ask --wait` handed back in this turn and not yet opened,
   * with when each was handed back. While one waits, a picker that is not
   * exactly it is refused (`claude-picker-handback.ts`).
   */
  claude_handbacks?: Array<{ question_id: string; at: number }>
  /** A content-free native wake is outstanding for this incarnation. */
  input_wake?: {
    incarnation: string; token: string; queued: boolean; writer: ProcessIdentity
    /** Bounds an unfinished reservation even if cleanup failed while the writer lived. */
    started_at?: number
    /** Wall-clock milliseconds when the harness accepted the wake. */
    queued_at?: number
    /** This wake already replaced one the harness accepted but never presented. */
    replacement?: boolean
  }
  /**
   * Wakes the agent was shown since input was last handed in. Each costs a
   * model turn, so the next wake waits `inputWakeBackoffMs(count)` after the
   * last one (see `inputWakeDeferred`). A handed-in input or a new one clears it.
   */
  input_wake_unanswered?: { count: number; presented_at: number }
  /** Durable diagnostic; answer text stays in the ordinary fenced input queue. */
  input_wake_fault?: {
    kind: 'transport' | 'codex-check' | 'codex-attach'
    attempts: number
    first_at: number
    last_at: number
    retry_at: number
    recovered_at?: number
    reported_at?: number
  }
  /** Refused delivery waits for fresh attendance before scheduling another wake. */
  input_delivery_fenced?: { incarnation: string; generation: number }
  /** Exact Codex wake ownership, including detached reconciliation records. */
  input_wake_attempts?: InputWakeAttempt[]
  input_wake_recovery?: { incarnation: string; inputIds: string[] }
  /**
   * Native-queue writes that committed, retained per request until the agent
   * acknowledges them. They never occupy the in-flight delivery slot or block
   * observation of a sibling question. Reply parts remain in their fenced order.
   */
  delivered_answers?: AnsweredPending[]
  /**
   * Required Agent Acknowledgements that the resumed agent still owes. This is
   * separate from answer delivery: the answer journal may settle as soon as a
   * harness accepts the continuation, while this obligation must survive until
   * the service confirms the agent-authored follow-up exists.
   */
  acknowledgement_due?: AcknowledgementDue[]
  /** Questions a held `ask --wait` submitted in the foreground, owned by one OpenClaw generation. */
  openclaw_foreground_replies?: Array<{ request_id: string; generation: string }>
  /**
   * Agent Acknowledgements owed for Session Messages (Session Notes and Answer
   * Edits) handed into this session. A sibling of `acknowledgement_due`, never
   * folded into it: released CLIs read that list and must keep finding exactly
   * the request debt they understand. The two meet only in memory, as
   * `OwedAcknowledgement`.
   */
  message_acknowledgement_due?: MessageAcknowledgementDue[]
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

export interface MessageAcknowledgementDue {
  message_id: string
  recorded_at: number
  /** OpenClaw reuses sessionKey across resets; only this generation received the message. */
  openclaw_generation?: string
  /** The account's snapshot taken when the Session Message was accepted. */
  text_required: boolean
  /**
   * Codex queue acceptance is storage, not presentation. Until this exact
   * context appears in UserPromptSubmit, Stop must let the working turn end
   * so Codex can start the queued turn. Never solicit an ID-only receipt.
   */
  queued_context?: string
}

/** Either kind of owed acknowledgement; exists only in memory. */
export type OwedAcknowledgement = AcknowledgementDue | MessageAcknowledgementDue

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
   * loop backstop: bounded by `MAX_ANSWER_DELIVERY_ATTEMPTS` in one place every route
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
  service_identity?: ServiceIdentity
  request_id: string
  idempotency_key: string
  collapse_key: string
  device_ids: string[]
  draft: NotificationDraftT
  owner_deadline_at: number
  /**
   * The submission attempt started under the session-state lock. Absence means
   * preparation only; presence means the reserved identity may be remote even
   * if the process crashed before receiving or persisting a receipt.
   */
  admitted_at?: number
}

/**
 * A subagent that asked a question on its root Agent Session's behalf: the
 * question is the root's, and its answer reaches the root, which acts on it.
 */
export interface QuestionAsker {
  /** The harness's own id for the subagent: Claude Code's agent id, Codex's thread id. */
  agent_id: string
  /** Claude Code's agent type, when its transcript records one. */
  agent_type?: string
  /** The task description the parent gave the subagent, when recorded. */
  description?: string
}

export interface PendingQuestion {
  /** Credential metadata frozen at registration; never contains the secret. */
  service_identity?: ServiceIdentity
  /** Set when a subagent asked this for its root Agent Session. */
  asked_by?: QuestionAsker
  /** Local commitment supplied by the asker, replayed with the answer. */
  resumes?: string
  /** Stable local identity across racing state writers and submit recovery. */
  question_id?: string
  /** One-line summary: the single question's text, or the set's first. */
  question: string
  /**
   * The title the User's devices show above the question: the agent's
   * `--title`, a form's `"title"`, or for a form the agent opened itself its
   * heading, its headers or the Agent Session name. Never the question.
   */
  title?: string
  /** With several questions, each question's own short title from `ask --form`: its header in a terminal form. */
  headers?: string[]
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
  /**
   * OpenCode only: the `question` form input `notifai ask --wait` handed back
   * for this question. The agent opens it unchanged, and only that form links.
   */
  opencode_hand_back?: OpencodeFormInput
  /**
   * OpenCode only: the form command carrying this question to the User's
   * devices. It submits and settles the question itself, so no other owner
   * may submit it while that process lives.
   */
  opencode_form_owner?: ProcessIdentity
}

/** The input of OpenCode's `question` tool, as Notifai hands it back. */
export interface OpencodeFormInput {
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
  }>
  /** `notifai:<question_id>`: names the registration this form carries. */
  source: string
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
  /** Runs only after `stdout` was written: what the hand-off itself proved. */
  afterOutput?: () => Promise<void>
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
   * won and the route must hand nothing over. `subprocess` says the write is a
   * harness child the route starts (and must report through `writerGroup`).
   */
  commitDelivery(writer?: 'subprocess'): boolean
  /** Present for a claimed write: checked at the socket before its first byte. */
  writeGuard?: WriteGuard
  /** A subprocess writer's process group, reported the moment it exists. */
  writerGroup?(pgid: number): void
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
 *   socket, a session queue). Delivery is not consumption: the write proves the
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
  /** Store input locally and wake its consumer; this is not a hand-off. */
  defer?(accepted: AcceptedAnswerDelivery): Promise<void>
  deliver(event: ContinuationEvent): Promise<DeliveryOutcome>
}

export interface EscalationWaiterOptions {
  sessionId: string
  envelope: HookEnvelope
  route: EscalationDeliveryRoute
  processDeadlineAt?: number
  /** Stop owns diagnostics; a pre-Stop recovery owner must not impersonate it. */
  recordStop?: boolean
  /** Claude Code with the hub: hand the answer window to the hub after admission. */
  hubHandoff?: boolean
  /** Who runs this waiter; a background owner takes over from one that must not keep the questions. */
  owner?: 'stop' | 'detached' | 'hub'
}

export interface HookContext {
  client: ApiClient
  /** Metadata for this already-authenticated client; never the credential secret. */
  service_identity?: ServiceIdentity
  config: CliConfig
  env: NodeJS.ProcessEnv
  now: () => number
  /** Injected so tests advance a virtual clock instead of sleeping. */
  sleep: (milliseconds: number) => Promise<void>
  /**
   * Bounded wait for the first reply; injected so tests do not sleep.
   * `expiresAt` is when the question's window was due to close (epoch ms):
   * `closed` says the service closed it earlier with no reply (the User
   * dismissed it), so no answer can arrive.
   */
  waitForFirstReply: (
    requestId: string,
    timeoutSeconds: number,
    expiresAt?: number,
  ) => Promise<{ replies: ReplyView[]; timedOut: boolean; degraded?: boolean; closed?: boolean }>
  /** The active harness selects the native continuation output adapter. */
  harness?: HookHarness
  /**
   * The local record. A hook's decisions are invisible from everywhere else —
   * its stderr belongs to the harness and its usual outcome is to do nothing —
   * so this is the only account of why a question did or did not travel.
   */
  log?: Logger
  /**
   * Present where a Session Attendant can hold this session's lease: the
   * answer waiter then closes with `deliver` and claims each fenced answer
   * before its in-place write, so Answer Edits follow it in order.
   */
  answerClaims?: AnswerClaims
}

export interface AnswerClaims {
  /** The lease generation the live attendant holds right now, or null. */
  lease(): DeliveryLease | null
  /** This waiter as a writer: PID and start time, journaled before any write. */
  writer: ProcessIdentity
  /** Claim deadlines are measured on this clock, never the wall clock. */
  monotonic(): number
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
  /**
   * True when this process's `deliver` close selected this answer for a
   * claimed hand-off: whoever writes it claims a Delivery Attempt first, so a
   * later Answer Edit is handed off strictly after it.
   */
  delivery_claim?: true
}
