/**
 * Native queues carry a wake, never User words. The foreground consumer reads
 * the current pending inputs and claims one bounded batch immediately before
 * presentation. A late wake therefore cannot resurrect an acknowledged answer.
 */
import { codexCardAnswerHeld } from './codex-card-handback.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { markCodexOrdinaryPresentation } from './codex-question-bindings.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AttendanceMessage } from '@raidiant/notifai-protocol'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { answersContext, clearAcknowledgementObligation, recordMessageAcknowledgementDue } from './hook-acknowledgements.js'
import { retiringQuestion } from './hook-question-retirement.js'
import { readSessionIncarnation, readSessionState, recordSessionNotified, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { AcceptedAnswerDelivery, AnsweredPending, EscalationDeliveryRoute, SessionState } from './hook-types.js'
import { sessionMessageContext } from './injection-render.js'
import { currentProcessIdentity, processIdentityLiveness } from './process-identity.js'
import type { Logger } from './logging.js'
import { answerWriterGone, beginHandOff, readDeliveryJournal, type DeliveryLease, type NativeAnswerPresentation, type SequencerDeps } from './session-delivery.js'
import { CodexControlNotSent } from './codex-native-control.js'
import { connectCodexQueue, type QueueControl } from './codex-queue-control.js'
import { readNativeTurnSnapshot } from './codex-native-turn.js'
import { admitInputWake, detachInputWakes, electInputWake, observeInputWake, readInputWakes, reconcileInputWakes, recoverUncertainInputWake } from './session-input-wakes.js'
import { readAttendantLease, nativeTurnContinues } from './session-attendant-state.js'

export function sessionInputWake(token?: string): string {
  const notice = token === undefined ? 'Notifai — user input may be waiting for this session.' : `Notifai wake ${token}.`
  return `${notice} Use any Notifai input supplied with this turn. Only if none was supplied, run \`notifai receive\` once and follow what it prints. This wake comes from Notifai, not another session, and contains no note, answer, or approval.`
}

/** How long an accepted wake may sit unpresented in an idle session before it counts as lost. */
export const LOST_WAKE_MS = 60_000
export const WAKE_SEND_TIMEOUT_MS = 30_000

export interface WakeOptions {
  /**
   * Give this wake its own text. Claude Code drops a peer message identical
   * to a recent one, so a repeated fixed wake can be accepted and never shown.
   */
  unique?: boolean
  /**
   * Whether the session is positioned to have presented an accepted wake by
   * now. Asked only about a wake accepted at least `LOST_WAKE_MS` ago; one
   * replacement is sent, never a series.
   */
  replaceLost?: () => boolean
  /** Wall clock, milliseconds. */
  now?: () => number
  /** Internal transport deadline; callers never hold a delivery loop indefinitely. */
  sendTimeoutMs?: number
}

/** An accepted wake that has waited long enough to be replaced once. */
export function inputWakeOverdue(state: SessionState, now: number): boolean {
  const wake = state.input_wake
  return wake !== undefined && wake.queued && wake.replacement !== true &&
    wake.queued_at !== undefined && now - wake.queued_at >= LOST_WAKE_MS
}

/** The wait before the next wake after the first one shown without its input handed in. */
export const INPUT_WAKE_BACKOFF_BASE_MS = 5_000
/** The longest wait between wakes the agent is shown while input cannot be handed in. */
export const INPUT_WAKE_BACKOFF_CAP_MS = 5 * 60_000

/** How long the next wake waits after `count` wakes were shown with nothing handed in. */
export function inputWakeBackoffMs(count: number): number {
  return count < 1 ? 0 : Math.min(INPUT_WAKE_BACKOFF_CAP_MS, INPUT_WAKE_BACKOFF_BASE_MS * 2 ** Math.min(count - 1, 16))
}

/**
 * A wake was shown and its input could not be handed in (a service error, an
 * outage): waking again at once would spend a model turn per wake on the same
 * failure. A wall clock that moved backwards defers nothing.
 */
export function inputWakeDeferred(state: SessionState, now: number): boolean {
  const unanswered = state.input_wake_unanswered
  if (unanswered === undefined) return false
  const elapsed = now - unanswered.presented_at
  return elapsed >= 0 && elapsed < inputWakeBackoffMs(unanswered.count)
}

function clearUnansweredWakes(state: SessionState): SessionState {
  if (state.input_wake_unanswered === undefined) return state
  const next = { ...state }
  delete next.input_wake_unanswered
  return next
}

/** Failed transport attempts are paced independently of wakes the agent saw. */
export function inputWakeRetryDeferred(state: SessionState, now: number): boolean {
  const fault = state.input_wake_fault
  return fault !== undefined && fault.recovered_at === undefined && now >= fault.last_at && now < fault.retry_at
}

export function recordInputWakeFailure(sessionId: string, env: NodeJS.ProcessEnv,
  kind: NonNullable<SessionState['input_wake_fault']>['kind'], now = Date.now(), retryMs?: number): void {
  updateSessionState(sessionId, env, state => withInputWakeFailure(state, kind, now, retryMs))
}

function withInputWakeFailure(state: SessionState, kind: NonNullable<SessionState['input_wake_fault']>['kind'], now: number, retryMs?: number): SessionState {
  const previous = state.input_wake_fault
  // A cached check observed later must not move the fault backwards or
  // count its original failure twice.
  if (previous !== undefined && previous.last_at >= now) return state
  if (previous?.kind === kind && inputWakeRetryDeferred(state, now)) return state
  const continuing = previous?.kind === kind && previous.recovered_at === undefined
  const attempts = Math.min(32, continuing ? previous.attempts + 1 : 1)
  return { ...state, input_wake_fault: { kind, attempts, first_at: continuing ? previous.first_at : now,
    last_at: now, retry_at: now + (retryMs ?? inputWakeBackoffMs(attempts)) } }
}

function recoverInputWakeFault(state: SessionState, now: number): SessionState {
  return state.input_wake_fault === undefined || state.input_wake_fault.recovered_at !== undefined ? state
    : { ...state, input_wake_fault: { ...state.input_wake_fault, recovered_at: now } }
}

/** Agent-facing diagnostic, repeated only after a new failed attempt. */
export function inputWakeFaultContext(state: SessionState): string | null {
  const fault = state.input_wake_fault
  if (fault === undefined || (fault.reported_at ?? -1) >= fault.last_at) return null
  return 'Notifai could not wake this Agent Session for waiting User input. The input was kept for this turn; use any input supplied here, or run `notifai receive` once if none was supplied. Check `notifai doctor` for the delivery fault. Queue acceptance alone does not mean the agent read the answer.'
}

export function markInputWakeFaultReported(sessionId: string, env: NodeJS.ProcessEnv, lastAt: number, now = Date.now()): void {
  updateSessionState(sessionId, env, state => state.input_wake_fault?.last_at === lastAt
    ? { ...state, input_wake_fault: { ...state.input_wake_fault, reported_at: now } } : state)
}

/** Atomically coalesce native wakes until one actually reaches its consumer. */
export async function wakeSessionInputs(
  sessionId: string, env: NodeJS.ProcessEnv, send: (text: string, signal: AbortSignal) => Promise<boolean>, log?: Logger,
  options: WakeOptions = {},
): Promise<void> {
  const incarnation = readSessionIncarnation(sessionId, env)?.incarnation ?? `session:${sessionId}`
  const writer = currentProcessIdentity()
  if (writer === null || sessionHasEnded(sessionId, env)) return
  const now = options.now ?? Date.now
  const token = randomUUID()
  const lease = readAttendantLease(sessionId, env)
  let elected = false
  let replacement = false
  let unanswered: SessionState['input_wake_unanswered']
  updateSessionState(sessionId, env, (state) => {
    // A refused lease needs fresh attendance, not another prompt to the agent.
    if (lease !== null && state.input_delivery_fenced?.incarnation === lease.incarnation &&
        state.input_delivery_fenced.generation === lease.generation) return state
    if (inputWakeDeferred(state, now())) { unanswered = state.input_wake_unanswered; return state }
    if (inputWakeRetryDeferred(state, now())) return state
    if (state.input_wake?.incarnation === incarnation) {
      const lost = inputWakeOverdue(state, now()) && options.replaceLost?.() === true
      const unfinished = !state.input_wake.queued && state.input_wake.started_at !== undefined &&
        now() - state.input_wake.started_at >= LOST_WAKE_MS
      if (!lost && !unfinished && (state.input_wake.queued || processIdentityLiveness(state.input_wake.writer) !== 'gone')) return state
      if (!state.input_wake.queued) state = withInputWakeFailure(state, 'transport', now())
      replacement = lost
    }
    elected = true
    return { ...state, input_wake: { incarnation, token, queued: false, writer, started_at: now(), ...(replacement ? { replacement } : {}) } }
  })
  if (!elected) {
    log?.debug('delivery.handoff', { route: 'input-wake', stage: unanswered === undefined ? 'coalesced' : 'backoff', session: sessionId,
      ...(unanswered === undefined ? {} : { unanswered: unanswered.count,
        retry_in_ms: unanswered.presented_at + inputWakeBackoffMs(unanswered.count) - now() }) })
    return
  }
  let sent = false
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    sent = await Promise.race([
      send(options.unique === true ? sessionInputWake(token) : sessionInputWake(), abort.signal),
      new Promise<boolean>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(false) }, options.sendTimeoutMs ?? WAKE_SEND_TIMEOUT_MS) }),
    ])
    log?.info('delivery.handoff', { route: 'input-wake', stage: sent ? 'queued' : 'deferred', session: sessionId,
      ...(replacement ? { replacement } : {}) })
    if (sent) updateSessionState(sessionId, env, (state) => state.input_wake?.token === token
      ? { ...state, input_wake: { ...state.input_wake, queued: true, queued_at: now() } } : state)
  } catch {
    // Only the content-free wake failed. Preserve User input for retry and
    // the next foreground callback; never report it delivered here.
    log?.info('delivery.handoff', { route: 'input-wake', stage: 'failed', session: sessionId })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    abort.abort()
    if (!sent) updateSessionState(sessionId, env, (state) => {
      if (state.input_wake?.token !== token) return state
      const next = { ...withInputWakeFailure(state, 'transport', now()) }
      delete next.input_wake
      return next
    })
  }
}

/** Whether a prompt is exactly a Notifai wake, with or without its own token. */
export function isSessionInputWake(prompt: string | undefined): boolean {
  return prompt !== undefined && (prompt === sessionInputWake() || inputWakeToken(prompt) !== null)
}

/** The token of a wake that carries one, when the prompt is exactly that wake. */
export function inputWakeToken(prompt: string | undefined): string | null {
  if (prompt === undefined) return null
  const matched = /^Notifai wake ([0-9a-f-]{36})\. /.exec(prompt)
  return matched !== null && prompt === sessionInputWake(matched[1]) ? matched[1]! : null
}

/**
 * A wake prompt reached the agent. It also counts as shown-but-unanswered
 * until a drain hands input in, which is what spaces out the next wake.
 */
export function observeSessionInputWake(sessionId: string, env: NodeJS.ProcessEnv, prompt: string | undefined, now = Date.now()): void {
  if (prompt !== undefined) {
    const matched = /^Notifai wake ([0-9a-f-]{36})\. /.exec(prompt)
    if (matched !== null) {
      const owned = readInputWakes({ sessionId, env }).find(a => a.token === matched[1] && a.text === prompt)
      if (owned !== undefined) observeInputWake({ sessionId, env }, owned.token)
      // A coalesced wake is settled only by its own token: an older wake
      // arriving late must not clear the one still outstanding.
      else if (inputWakeToken(prompt) === null) return
      updateSessionState(sessionId, env, (state) => {
        const next = { ...recoverInputWakeFault(state, now), input_wake_unanswered: { count: (state.input_wake_unanswered?.count ?? 0) + 1, presented_at: now } }
        if (state.input_wake?.token === matched[1]) delete next.input_wake
        return next
      })
      return
    }
  }
  if (prompt !== sessionInputWake()) return
  updateSessionState(sessionId, env, (state) => {
    const next = { ...recoverInputWakeFault(state, now), input_wake_unanswered: { count: (state.input_wake_unanswered?.count ?? 0) + 1, presented_at: now } }
    delete next.input_wake
    return next
  })
}

/** An explicit `notifai receive`: any wake still queued is for input this reads now. */
export function forgetQueuedInputWake(sessionId: string, env: NodeJS.ProcessEnv): void {
  updateSessionState(sessionId, env, (state) => {
    if (state.input_wake === undefined) return state
    const next = { ...state }
    delete next.input_wake
    return next
  })
}

export function stageSessionAnswers(sessionId: string, env: NodeJS.ProcessEnv, accepted: AcceptedAnswerDelivery): void {
  updateSessionState(sessionId, env, (state) => {
    if (state.accepted?.recorded_at !== accepted.recorded_at) return state
    const waiting = [...(state.waiting_answers ?? [])]
    for (const answer of accepted.answers) {
      if (!waiting.some((entry) => entry.pending.request_id === answer.pending.request_id)) waiting.push(answer)
    }
    // New input earns a prompt wake, whatever became of the earlier ones.
    const next = { ...(waiting.length > (state.waiting_answers?.length ?? 0) ? clearUnansweredWakes(state) : state), waiting_answers: waiting }
    delete next.accepted
    return next
  })
  // A reply proves submission even when its HTTP receipt was lost. Wake a
  // dormant resident writer without depending on that missing receipt.
  recordSessionNotified(sessionId, env, accepted.recorded_at)
}

/** The existing route wakes the exact owner, but no longer owns answer text. */
export function sessionInputRoute(sessionId: string, env: NodeJS.ProcessEnv, route: EscalationDeliveryRoute, log?: Logger, wakeOwner: 'producer' | 'attendant' = 'producer', wake: WakeOptions = {}, staged?: (sessionId: string) => void): EscalationDeliveryRoute {
  return { ...route, defer: async (accepted) => {
    stageSessionAnswers(sessionId, env, accepted)
    staged?.(sessionId)
    // A live resident owns scheduling; its completion probe also covers the
    // case where no more tool callbacks occur. Preserve return when absent.
    if (wakeOwner === 'attendant') {
      const owner = readSessionIncarnation(sessionId, env)
      const lease = readAttendantLease(sessionId, env)
      if (owner !== null && lease?.incarnation === owner.incarnation) return
    }
    await wakeSessionInputs(sessionId, env, async (text, signal) => {
      const result = await route.deliver({
        context: text, answers: 0, remaining: 0, request_ids: [], journal_recorded_at: accepted.recorded_at,
        commitDelivery: () => !signal.aborted && !sessionHasEnded(sessionId, env),
        writeGuard: { writable: () => !signal.aborted && !sessionHasEnded(sessionId, env), remainingMs: () => WAKE_SEND_TIMEOUT_MS },
      })
      return result.acknowledgement === 'delivered'
    }, log, wake)
  } }
}

function messagesPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.inputs.json`)
}

/** Cache only: the service remains authoritative and claims fence stale copies. */
export function stageSessionMessages(sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease, messages: readonly AttendanceMessage[]): void {
  // Nothing changed since the last exchange (the usual idle case): no locked,
  // fsynced rewrite of the state and message files every exchange.
  const cached = readSessionMessageCache(sessionId, env, lease)
  if (cached !== null && JSON.stringify(cached) === JSON.stringify(messages) &&
      readSessionState(sessionId, env).input_delivery_fenced === undefined) return
  updateSessionState(sessionId, env, state => {
    const known = new Set(readSessionMessagesFile(sessionId, env).map(m => (m as { message_id?: unknown } | null)?.message_id))
    atomicWriteFileSync(messagesPath(sessionId, env), JSON.stringify({ session_id: sessionId, ...lease, messages }))
    // The resident stages only after a fresh authenticated attendance exchange.
    // This also rearms a temporarily expired lease renewed at the same generation.
    // A new message earns a prompt wake, whatever became of the earlier ones.
    const next = messages.some(m => !known.has(m.message_id)) ? clearUnansweredWakes(state) : { ...state }
    delete next.input_delivery_fenced
    return next
  })
}

/** Every staged Session Message, whatever lease staged it; empty when none (or unreadable). */
export function readSessionMessagesFile(sessionId: string, env: NodeJS.ProcessEnv): unknown[] {
  try {
    const data = JSON.parse(readFileSync(messagesPath(sessionId, env), 'utf8')) as { messages?: unknown }
    return Array.isArray(data.messages) ? data.messages : []
  } catch { return [] }
}

export function readSessionMessages(sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease): AttendanceMessage[] {
  return readSessionMessageCache(sessionId, env, lease) ?? []
}
function readSessionMessageCache(sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease): AttendanceMessage[] | null {
  try {
    const data = JSON.parse(readFileSync(messagesPath(sessionId, env), 'utf8'))
    if (data.session_id !== sessionId || data.incarnation !== lease.incarnation || data.generation !== lease.generation || !Array.isArray(data.messages)) return null
    if (!data.messages.every((m: AttendanceMessage) => typeof m.message_id === 'string' && /^sm_[A-Za-z0-9_-]+$/.test(m.message_id) &&
      typeof m.created_at === 'string' && typeof m.agent_acknowledgement_text_required === 'boolean' &&
      (m.kind === 'note' ? typeof m.body === 'string' : m.kind === 'answer_edit' && typeof m.request_id === 'string' && typeof m.text === 'string' && Array.isArray(m.answers)))) return null
    return data.messages
  } catch { return null }
}

function pendingSessionInputs(sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease | null, state = readSessionState(sessionId, env), cachedMessages?: AttendanceMessage[]) {
  const written = new Set(readDeliveryJournal(sessionId, env)
    .filter((entry) => ['writing', 'written', 'failed'].includes(entry.stage))
    .map((entry) => entry.subject.type === 'answer' ? entry.subject.request_id : entry.subject.message_id))
  const owed = new Set(state.acknowledgement_due?.map((entry) => entry.request_id))
  const answers = (state.waiting_answers ?? []).filter((answer) =>
    !codexCardAnswerHeld(state, answer.pending.question_id) &&
    answer.pending.request_id !== undefined && !written.has(answer.pending.request_id) &&
    owed.has(answer.pending.request_id)).slice(0, 20)
  // Answers precede their edits; notes retain the service's immutable order.
  const messages = (cachedMessages ?? (lease === null ? [] : readSessionMessages(sessionId, env, lease)))
    .filter((message) => !written.has(message.message_id)).slice(0, 20 - answers.length)
  return { answers, messages }
}

export function hasSessionInputs(sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease | null): boolean {
  const { answers, messages } = pendingSessionInputs(sessionId, env, lease)
  return answers.length + messages.length > 0
}

/** Read-only under the state lock. Unknown cache state is not an empty inbox. */
export function pendingInputRevisionIds(sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease | null, state?: SessionState): string[] | null {
  const cached = lease === null ? [] : readSessionMessageCache(sessionId, env, lease)
  if (cached === null) return null
  const { answers, messages } = pendingSessionInputs(sessionId, env, lease, state, cached)
  return [
    ...answers.map(a => `answer:${a.pending.request_id!}:${a.replies.map(r => r.seq).join(',')}`),
    ...messages.map(m => `message:${m.message_id}`),
  ]
}

/** Optional exact queue integration. False means capability was unavailable
 * before election, so the existing supported CLI wake remains the fallback. */
export async function wakeCodexSessionInputs(input: {
  sessionId: string; env: NodeJS.ProcessEnv; lease: DeliveryLease
  mayWrite(): boolean; mayWake(): boolean; unknownAllowed?(): boolean
  connect?: typeof connectCodexQueue
}): Promise<boolean> {
  const owner = readSessionIncarnation(input.sessionId, input.env)
  if (owner === null || owner.incarnation !== input.lease.incarnation || !input.mayWrite()) return true
  const state = readSessionState(input.sessionId, input.env)
  const generic = state.input_wake
  if (generic?.incarnation === owner.incarnation) {
    if (!generic.queued && generic.started_at !== undefined && Date.now() - generic.started_at >= LOST_WAKE_MS) return false
    if (generic.queued || processIdentityLiveness(generic.writer) !== 'gone') return true
  }
  // A wake shown without its input handed in holds the queue wake as well.
  if (inputWakeDeferred(state, Date.now())) return true
  const initial = pendingInputRevisionIds(input.sessionId, input.env, input.lease)
  if (initial === null || (initial.length === 0 && !readInputWakes(input).some(a => !['consumed', 'cancelled'].includes(a.phase)))) return true
  const control = await (input.connect ?? connectCodexQueue)(input.sessionId, input.env, performance.now() + 2_000)
  if (control === null) {
    const pending = pendingInputRevisionIds(input.sessionId, input.env, input.lease)
    return pending === null || readInputWakes(input).some(a => a.incarnation === owner.incarnation &&
      !['consumed', 'cancelled'].includes(a.phase) && a.inputIds.some(id => pending.includes(id)))
  }
  try {
    // Mutating lifecycle/attendant observers run outside the wake-state lock.
    const allowed = input.mayWrite() && input.mayWake()
    const native = () => {
      const proof = readSessionState(input.sessionId, input.env).codex_native_turn
      return proof?.key === owner.key ? readNativeTurnSnapshot(proof.transcript_path, input.sessionId, input.env) : null
    }
    const gate = { ...input, owner: { key: owner.key, incarnation: owner.incarnation, generation: input.lease.generation },
      namespace: control.namespace, control, native,
      pendingIds: () => {
        const lease = readAttendantLease(input.sessionId, input.env)
        return lease?.incarnation === input.lease.incarnation && lease.generation === input.lease.generation
          ? pendingInputRevisionIds(input.sessionId, input.env, lease) : null
      },
      mayWake: () => { const observed = native(); return allowed && (observed === null ? input.unknownAllowed?.() === true : observed.latest.ended && nativeTurnContinues(input.sessionId, input.env, owner.key, observed)) },
      text: (token: string) => sessionInputWake(token) }
    detachInputWakes(gate)
    await reconcileInputWakes(input, control)
    if (!allowed || !input.mayWrite()) return true
    const elected = electInputWake(gate) ?? await recoverUncertainInputWake(gate)
    if (elected !== null) await admitInputWake({ ...gate, token: elected.token, control: {
      ...control, add: async (token, text) => {
        // Recovery may have awaited a native lookup. Refresh in-process lease
        // authority at the actual byte boundary, outside every state lock.
        if (!input.mayWrite() || !input.mayWake()) throw new CodexControlNotSent('Wake authorization changed before send')
        return control.add(token, text)
      },
    } })
    if (elected !== null && readInputWakes(input).some(attempt => attempt.token === elected.token && ['unknown', 'cancelled'].includes(attempt.phase))) {
      recordInputWakeFailure(input.sessionId, input.env, 'transport')
    }
    return true
  } finally { control.close() }
}

/** Hook drains and the resident observer both call this bounded cleanup path.
 * It never elects a wake, claims input, or acquires the delivery sequencer. */
export async function reconcileSessionInputWakes(sessionId: string, env: NodeJS.ProcessEnv, connect: typeof connectCodexQueue = connectCodexQueue): Promise<void> {
  const scope = { sessionId, env }
  const attempts = readInputWakes(scope)
  if (!attempts.some(a => !['consumed', 'cancelled'].includes(a.phase))) return
  const lease = readAttendantLease(sessionId, env)
  // Losing the lease does not prove cached Session Messages disappeared.
  if (lease !== null || attempts.every(a => a.generation === null)) {
    detachInputWakes({ ...scope, pendingIds: () => {
      const current = readAttendantLease(sessionId, env)
      if (current?.incarnation !== lease?.incarnation || current?.generation !== lease?.generation) return null
      return pendingInputRevisionIds(sessionId, env, current)
    } })
  }
  if (!readInputWakes(scope).some(a => a.detached && !['consumed', 'cancelled'].includes(a.phase) && (a.nextCheckAt ?? 0) <= Date.now())) return
  const control: QueueControl | null = await connect(sessionId, env, performance.now() + 750)
  if (control === null) return
  try { await reconcileInputWakes(scope, control) } finally { control.close() }
}

export interface PreparedInputAnswer {
  presentation: NativeAnswerPresentation
  /** Refresh exact binding evidence inside the final consumption transaction. */
  validate(state: SessionState): { state: SessionState; valid: boolean }
  write(mayWrite: () => boolean): Promise<void>
  close(): void
}

export interface NativeInputAnswers {
  eligible(answer: AnsweredPending, state: SessionState): boolean
  /** An indivisible native form: all members must be ready and claimed before any output. */
  group?(answer: AnsweredPending, state: SessionState): AnsweredPending[] | null
  prepareGroup?(answers: AnsweredPending[], state: SessionState, deadline: number): Promise<PreparedInputAnswer | null>
  /** No answer bytes. Null chooses ordinary presentation of the same prefix. */
  prepare(answer: AnsweredPending, state: SessionState, deadline: number): Promise<PreparedInputAnswer | null>
}

function samePendingAnswer(state: SessionState, answer: AnsweredPending): boolean {
  return !codexCardAnswerHeld(state, answer.pending.question_id) && state.acknowledgement_due?.some(entry => entry.request_id === answer.pending.request_id) === true &&
    state.waiting_answers?.some(entry => isDeepStrictEqual(entry, answer)) === true
}

/** One ordered prefix, at most 20 inputs, with ownership checked at the byte. */
async function drainSessionInputsOnce(input: {
  sequencer: SequencerDeps
  lease: DeliveryLease | null
  mayWrite(): boolean
  write(text: string): void
  nativeAnswers?: NativeInputAnswers
  /**
   * Present one native-eligible answer or one complete native group, or nothing. For a writer whose
   * only output is the native form's own result, so an ordinary prefix must
   * never be written through it. Members are taken wherever they stand:
   * answers to independent questions carry no order between them.
   */
  nativeOnly?: boolean
}): Promise<boolean> {
  const { sequencer: deps, lease } = input
  const initial = readSessionState(deps.sessionId, deps.env)
  const batch = pendingSessionInputs(deps.sessionId, deps.env, lease, initial)
  const eligibleAt = input.nativeAnswers === undefined ? -1 : batch.answers.findIndex(answer =>
    answer.delivery_claim === true && input.nativeAnswers!.eligible(answer, initial))
  if (input.nativeOnly === true && eligibleAt < 0) return false
  const nativeAt = input.nativeOnly === true ? 0 : eligibleAt
  const nativeGroup = input.nativeOnly === true && input.nativeAnswers?.group !== undefined
    ? input.nativeAnswers.group(batch.answers[eligibleAt]!, initial) : null
  if (input.nativeOnly === true && input.nativeAnswers?.group !== undefined &&
      (nativeGroup === null || nativeGroup.length === 0 || new Set(nativeGroup.map(a => a.pending.request_id)).size !== nativeGroup.length ||
       nativeGroup.some(a => !batch.answers.some(b => isDeepStrictEqual(a, b))))) return false
  const answers = input.nativeOnly === true
    ? nativeGroup ?? [batch.answers[eligibleAt]!]
    : nativeAt < 0 ? batch.answers : batch.answers.slice(0, nativeAt === 0 ? 1 : nativeAt)
  const messages = nativeAt < 0 ? batch.messages : []
  if (answers.length + messages.length === 0 || !input.mayWrite()) return false
  // An unfenced answer has no server claim to reject a stale local copy.
  // Reconcile it before presentation; inability to check must defer it.
  for (const answer of answers.filter((entry) => entry.delivery_claim !== true)) {
    try {
      const result = await deps.client.agentAcknowledgement(answer.pending.request_id!, { waitSeconds: 0 })
      if (result.agent_acknowledgement !== null) clearAcknowledgementObligation(deps.sessionId, deps.env, answer.pending.request_id!)
    } catch { return false }
  }
  // Recovery runs before the first claim. Start this short batching window
  // afterward so a slow previous report cannot prevent all new claims. The
  // caller's whole-operation deadline still fences recovery and presentation.
  let claimUntil: number | undefined
  const handOff = await beginHandOff(deps, {
    lease, lockWaitMs: 0, stopAtRefusal: true, mayWrite: input.mayWrite,
    mayClaim: () => {
      claimUntil ??= deps.monotonic() + (nativeGroup === null ? 750 : 1_500)
      return deps.monotonic() < claimUntil
    },
    subjects: [
      ...answers.filter((answer) => answer.delivery_claim === true).map((answer) => ({ type: 'answer' as const, request_id: answer.pending.request_id! })),
      ...messages.map((message) => ({ type: 'session_message' as const, message_id: message.message_id })),
    ],
    earlierAnswerWriterGone: (subject) => {
      const message = subject.type === 'session_message' ? messages.find((entry) => entry.message_id === subject.message_id) : undefined
      return message?.kind === 'answer_edit' && answerWriterGone(deps.sessionId, deps.env, message.request_id)
    },
  })
  if (handOff === null) return false
  if (lease !== null && handOff.refused.some(entry => entry.reason === 'generation_fenced')) {
    updateSessionState(deps.sessionId, deps.env, state => ({ ...state, input_delivery_fenced: lease }))
  }
  const terminal = new Set(handOff.refused.filter((entry) => entry.reason === 'not_claimable' || entry.reason === 'not_found')
    .flatMap((entry) => entry.subject.type === 'answer' ? [entry.subject.request_id] : []))
  if (terminal.size > 0) updateSessionState(deps.sessionId, deps.env, (latest) => ({
    ...latest, waiting_answers: (latest.waiting_answers ?? []).filter((answer) => !terminal.has(answer.pending.request_id!)),
  }))
  const ids = new Set(handOff.claimed.map((claim) => claim.subject.type === 'answer' ? claim.subject.request_id : claim.subject.message_id))
  // A concurrent consumer may have drained an unclaimed answer while this
  // reader waited for the delivery lock. Re-read while holding that lock.
  const current = readSessionState(deps.sessionId, deps.env)
  if (answers.some(answer => current.waiting_answers?.some(entry =>
    entry.pending.request_id === answer.pending.request_id && !isDeepStrictEqual(entry, answer)))) {
    await handOff.finish('not-written')
    return false
  }
  const readyAnswers = answers.filter((answer) =>
    samePendingAnswer(current, answer) &&
    (answer.delivery_claim !== true || ids.has(answer.pending.request_id!)))
  if (nativeGroup !== null && readyAnswers.length !== answers.length) {
    await handOff.finish('not-written')
    return false
  }
  const readyMessages = messages.filter((message) => ids.has(message.message_id))
  if (readyAnswers.length + readyMessages.length === 0 || !input.mayWrite() || !handOff.writable()) {
    await handOff.finish('not-written')
    return false
  }
  const text = [
    ...(readyAnswers.length === 0 ? [] : [answersContext(readyAnswers, current.pending?.length ?? 0)]),
    ...readyMessages.map(sessionMessageContext),
  ].join('\n\n')
  let began = false
  let outputAttempted = false
  let consumedState = false
  let prepared: PreparedInputAnswer | null = null
  const restoreUnwritten = (): void => {
    updateSessionState(deps.sessionId, deps.env, (latest) => ({
      ...latest, waiting_answers: [
        ...readyAnswers.filter((answer) => latest.acknowledgement_due?.some((owed) => owed.request_id === answer.pending.request_id) &&
          !latest.waiting_answers?.some((entry) => entry.pending.request_id === answer.pending.request_id)),
        ...(latest.waiting_answers ?? []),
      ],
    }))
    for (const message of readyMessages) {
      if (!current.message_acknowledgement_due?.some((entry) => entry.message_id === message.message_id)) {
        clearAcknowledgementObligation(deps.sessionId, deps.env, message.message_id)
      }
    }
  }
  try {
    if (nativeGroup !== null && input.nativeAnswers?.prepareGroup !== undefined) {
      prepared = await input.nativeAnswers.prepareGroup(readyAnswers, current, deps.monotonic() + handOff.remainingMs())
    } else if (nativeAt === 0 && readyAnswers.length === 1 && input.nativeAnswers !== undefined) {
      prepared = await input.nativeAnswers.prepare(readyAnswers[0]!, current, deps.monotonic() + handOff.remainingMs())
    }
    if (input.nativeOnly === true && prepared === null) {
      await handOff.finish('not-written')
      return false
    }
    if (!handOff.begin(() => !sessionHasEnded(deps.sessionId, deps.env),
      prepared === null ? {} : { presentation: prepared.presentation })) {
      await handOff.finish('not-written')
      return false
    }
    began = true
    // Persist the selected revision and consumption before bytes. A changed
    // revision remains pending for a fresh handoff, never this prepared write.
    const consumed = new Set(readyAnswers.map((answer) => answer.pending.request_id))
    updateSessionState(deps.sessionId, deps.env, (latest) => {
      if (prepared !== null) {
        const checked = prepared.validate(latest)
        latest = checked.state
        if (!checked.valid) return latest
      }
      if (!input.mayWrite() || !handOff.writable() || !readyAnswers.every(answer => samePendingAnswer(latest, answer))) return latest
      if (prepared === null) latest = markCodexOrdinaryPresentation(latest, new Set(readyAnswers.flatMap(answer =>
        answer.pending.question_id === undefined ? [] : [answer.pending.question_id])))
      const retiring = [...(latest.retiring ?? [])]
      for (const answer of readyAnswers) {
        const entry = retiringQuestion(answer.pending, 'answered')
        if (entry !== null && !retiring.some((item) => item.request_id === entry.request_id)) retiring.push(entry)
      }
      consumedState = true
      return { ...latest, waiting_answers: (latest.waiting_answers ?? []).filter((answer) => !consumed.has(answer.pending.request_id)), retiring }
    })
    if (!consumedState) {
      await handOff.finish('aborted')
      return false
    }
    for (const message of readyMessages) recordMessageAcknowledgementDue(deps.sessionId, deps.env, {
      message_id: message.message_id, recorded_at: deps.wall(), text_required: message.agent_acknowledgement_text_required,
    })
    if (!input.mayWrite() || !handOff.writable()) {
      restoreUnwritten()
      await handOff.finish('aborted')
      return false
    }
    outputAttempted = true
    const fault = inputWakeFaultContext(current)
    if (prepared === null) {
      input.write(fault === null ? text : `${fault}\n\n${text}`)
      if (fault !== null) markInputWakeFaultReported(deps.sessionId, deps.env, current.input_wake_fault!.last_at, deps.wall())
    }
    else await prepared.write(() => input.mayWrite() && handOff.writable())
    await handOff.finish('written')
    deps.log?.info('delivery.handoff', {
      route: prepared === null ? 'input-drain' : 'native-answer', stage: 'presented', answers: readyAnswers.length, messages: readyMessages.length,
      request_ids: readyAnswers.map((answer) => answer.pending.request_id), message_ids: readyMessages.map((message) => message.message_id),
      oldest_message_age_ms: Math.max(0, ...readyMessages.map((message) => deps.wall() - Date.parse(message.created_at))),
    })
    return true
  } catch (error) {
    // Only the native transport can positively prove that no bytes left. Do
    // not echo now: a new handoff must reacquire claims and recheck revisions.
    if (prepared !== null && error instanceof CodexControlNotSent) outputAttempted = false
    if (consumedState && !outputAttempted) restoreUnwritten()
    await handOff.finish(outputAttempted ? 'failed' : began ? 'aborted' : 'not-written')
    if (prepared !== null && error instanceof CodexControlNotSent) return false
    throw error
  } finally { prepared?.close() }
}


export async function drainSessionInputs(input: Parameters<typeof drainSessionInputsOnce>[0]): Promise<boolean> {
  try {
    const presented = await drainSessionInputsOnce(input)
    // Input reached the agent: what remains is woken for promptly again.
    if (presented) updateSessionState(input.sequencer.sessionId, input.sequencer.env, state =>
      recoverInputWakeFault(clearUnansweredWakes(state), input.sequencer.wall()))
    return presented
  } finally {
    // Delivery bookkeeping has released its sequencer before native cleanup.
    await reconcileSessionInputWakes(input.sequencer.sessionId, input.sequencer.env)
      .catch(() => undefined)
  }
}
