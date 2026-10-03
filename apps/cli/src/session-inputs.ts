/**
 * Native queues carry a wake, never User words. The foreground consumer reads
 * the current pending inputs and claims one bounded batch immediately before
 * presentation. A late wake therefore cannot resurrect an acknowledged answer.
 */
import { randomUUID } from 'node:crypto'
import { markCodexOrdinaryPresentation } from './codex-question-bindings.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AttendanceMessage } from '@raidiant/notifai-protocol'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { answersContext, clearAcknowledgementObligation, recordMessageAcknowledgementDue } from './hook-acknowledgements.js'
import { retiringQuestion } from './hook-question-retirement.js'
import { readSessionIncarnation, readSessionState, recordSessionNotified, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { AcceptedAnswerDelivery, EscalationDeliveryRoute, SessionState } from './hook-types.js'
import { sessionMessageContext } from './injection-render.js'
import { currentProcessIdentity, processIdentityLiveness } from './process-identity.js'
import type { Logger } from './logging.js'
import { answerWriterGone, beginHandOff, readDeliveryJournal, type DeliveryLease, type SequencerDeps } from './session-delivery.js'
import { connectCodexQueue, NativeQueueNotSent, type QueueControl } from './codex-queue-control.js'
import { readNativeTurnSnapshot } from './codex-native-turn.js'
import { admitInputWake, detachInputWakes, electInputWake, observeInputWake, readInputWakes, reconcileInputWakes, recoverUncertainInputWake } from './session-input-wakes.js'
import { readAttendantLease, nativeTurnContinues } from './session-attendant-state.js'

export function sessionInputWake(token?: string): string {
  if (token !== undefined) return `Notifai wake ${token}. Use any Notifai input supplied with this turn. Only if none was supplied, run \`notifai receive\` once; if it is empty, continue your work. This wake contains no note, answer, or approval.`
  return `Notifai — user input may be waiting for this session. Run \`notifai receive\` before continuing. If no input remains, continue your work. This wake-up contains no note, answer, or approval.`
}

/** Atomically coalesce native wakes until one actually reaches its consumer. */
export async function wakeSessionInputs(
  sessionId: string, env: NodeJS.ProcessEnv, send: (text: string) => Promise<boolean>, log?: Logger,
): Promise<void> {
  const incarnation = readSessionIncarnation(sessionId, env)?.incarnation ?? `session:${sessionId}`
  const writer = currentProcessIdentity()
  if (writer === null || sessionHasEnded(sessionId, env)) return
  const token = randomUUID()
  let elected = false
  updateSessionState(sessionId, env, (state) => {
    if (state.input_wake?.incarnation === incarnation &&
        (state.input_wake.queued || processIdentityLiveness(state.input_wake.writer) !== 'gone')) return state
    elected = true
    return { ...state, input_wake: { incarnation, token, queued: false, writer } }
  })
  if (!elected) {
    log?.debug('delivery.handoff', { route: 'input-wake', stage: 'coalesced', session: sessionId })
    return
  }
  let sent = false
  try {
    sent = await send(sessionInputWake())
    log?.info('delivery.handoff', { route: 'input-wake', stage: sent ? 'queued' : 'deferred', session: sessionId })
    if (sent) updateSessionState(sessionId, env, (state) => state.input_wake?.token === token
      ? { ...state, input_wake: { ...state.input_wake, queued: true } } : state)
  } finally {
    if (!sent) updateSessionState(sessionId, env, (state) => {
      if (state.input_wake?.token !== token) return state
      const next = { ...state }
      delete next.input_wake
      return next
    })
  }
}

export function observeSessionInputWake(sessionId: string, env: NodeJS.ProcessEnv, prompt: string | undefined): void {
  if (prompt !== undefined) {
    const matched = /^Notifai wake ([0-9a-f-]{36})\. /.exec(prompt)
    if (matched !== null) {
      const owned = readInputWakes({ sessionId, env }).find(a => a.token === matched[1] && a.text === prompt)
      if (owned !== undefined) observeInputWake({ sessionId, env }, owned.token)
      return
    }
  }
  if (prompt !== sessionInputWake()) return
  updateSessionState(sessionId, env, (state) => {
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
    const next = { ...state, waiting_answers: waiting }
    delete next.accepted
    return next
  })
  // A reply proves submission even when its HTTP receipt was lost. Wake a
  // dormant resident writer without depending on that missing receipt.
  recordSessionNotified(sessionId, env, accepted.recorded_at)
}

/** The existing route wakes the exact owner, but no longer owns answer text. */
export function sessionInputRoute(sessionId: string, env: NodeJS.ProcessEnv, route: EscalationDeliveryRoute, log?: Logger, wakeOwner: 'producer' | 'attendant' = 'producer'): EscalationDeliveryRoute {
  return { ...route, defer: async (accepted) => {
    stageSessionAnswers(sessionId, env, accepted)
    // A live resident owns scheduling; its completion probe also covers the
    // case where no more tool callbacks occur. Preserve return when absent.
    if (wakeOwner === 'attendant') {
      const owner = readSessionIncarnation(sessionId, env)
      const lease = readAttendantLease(sessionId, env)
      if (owner !== null && lease?.incarnation === owner.incarnation) return
    }
    await wakeSessionInputs(sessionId, env, async (text) => {
      const result = await route.deliver({
        context: text, answers: 0, remaining: 0, request_ids: [], journal_recorded_at: accepted.recorded_at,
        commitDelivery: () => !sessionHasEnded(sessionId, env),
      })
      return result.acknowledgement === 'delivered'
    }, log)
  } }
}

function messagesPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.inputs.json`)
}

/** Cache only: the service remains authoritative and claims fence stale copies. */
export function stageSessionMessages(sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease, messages: readonly AttendanceMessage[]): void {
  updateSessionState(sessionId, env, state => {
    atomicWriteFileSync(messagesPath(sessionId, env), JSON.stringify({ session_id: sessionId, ...lease, messages }))
    return state
  })
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
  const generic = readSessionState(input.sessionId, input.env).input_wake
  if (generic?.incarnation === owner.incarnation && (generic.queued || processIdentityLiveness(generic.writer) !== 'gone')) return true
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
        if (!input.mayWrite() || !input.mayWake()) throw new NativeQueueNotSent('Wake authorization changed before send')
        return control.add(token, text)
      },
    } })
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

/** One stdout document, at most 20 inputs, with ownership checked at the byte. */
async function drainSessionInputsOnce(input: {
  sequencer: SequencerDeps
  lease: DeliveryLease | null
  mayWrite(): boolean
  write(text: string): void
}): Promise<boolean> {
  const { sequencer: deps, lease } = input
  const { answers, messages } = pendingSessionInputs(deps.sessionId, deps.env, lease)
  if (answers.length + messages.length === 0 || !input.mayWrite()) return false
  // An unfenced answer has no server claim to reject a stale local copy.
  // Reconcile it before presentation; inability to check must defer it.
  for (const answer of answers.filter((entry) => entry.delivery_claim !== true)) {
    try {
      const result = await deps.client.agentAcknowledgement(answer.pending.request_id!, { waitSeconds: 0 })
      if (result.agent_acknowledgement !== null) clearAcknowledgementObligation(deps.sessionId, deps.env, answer.pending.request_id!)
    } catch { return false }
  }
  const claimUntil = deps.monotonic() + 750
  const handOff = await beginHandOff(deps, {
    lease, lockWaitMs: 0, stopAtRefusal: true, mayWrite: input.mayWrite,
    mayClaim: () => deps.monotonic() < claimUntil,
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
  const terminal = new Set(handOff.refused.filter((entry) => entry.reason === 'not_claimable' || entry.reason === 'not_found')
    .flatMap((entry) => entry.subject.type === 'answer' ? [entry.subject.request_id] : []))
  if (terminal.size > 0) updateSessionState(deps.sessionId, deps.env, (latest) => ({
    ...latest, waiting_answers: (latest.waiting_answers ?? []).filter((answer) => !terminal.has(answer.pending.request_id!)),
  }))
  const ids = new Set(handOff.claimed.map((claim) => claim.subject.type === 'answer' ? claim.subject.request_id : claim.subject.message_id))
  // A concurrent consumer may have drained an unclaimed answer while this
  // reader waited for the delivery lock. Re-read while holding that lock.
  const current = readSessionState(deps.sessionId, deps.env)
  const readyAnswers = answers.filter((answer) =>
    current.waiting_answers?.some((entry) => entry.pending.request_id === answer.pending.request_id) &&
    current.acknowledgement_due?.some((entry) => entry.request_id === answer.pending.request_id) &&
    (answer.delivery_claim !== true || ids.has(answer.pending.request_id!)))
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
    if (!handOff.begin(() => !sessionHasEnded(deps.sessionId, deps.env))) {
      await handOff.finish('not-written')
      return false
    }
    began = true
    // Persist consumption before stdout; an ambiguous output is never replayed.
    const consumed = new Set(readyAnswers.map((answer) => answer.pending.request_id))
    updateSessionState(deps.sessionId, deps.env, (latest) => {
      latest = markCodexOrdinaryPresentation(latest, new Set(readyAnswers.flatMap(answer =>
        answer.pending.question_id === undefined ? [] : [answer.pending.question_id])))
      const retiring = [...(latest.retiring ?? [])]
      for (const answer of readyAnswers) {
        const entry = retiringQuestion(answer.pending, 'answered')
        if (entry !== null && !retiring.some((item) => item.request_id === entry.request_id)) retiring.push(entry)
      }
      return { ...latest, waiting_answers: (latest.waiting_answers ?? []).filter((answer) => !consumed.has(answer.pending.request_id)), retiring }
    })
    for (const message of readyMessages) recordMessageAcknowledgementDue(deps.sessionId, deps.env, {
      message_id: message.message_id, recorded_at: deps.wall(), text_required: message.agent_acknowledgement_text_required,
    })
    if (!input.mayWrite() || !handOff.writable()) {
      restoreUnwritten()
      await handOff.finish('aborted')
      return false
    }
    outputAttempted = true
    input.write(text)
    if (readyAnswers.length > 0) updateSessionState(deps.sessionId, deps.env, (latest) => ({
      ...latest, continuation: { answered_at: deps.wall(), count: (latest.continuation?.count ?? 0) + 1 },
    }))
    await handOff.finish('written')
    deps.log?.info('delivery.handoff', {
      route: 'input-drain', stage: 'presented', answers: readyAnswers.length, messages: readyMessages.length,
      request_ids: readyAnswers.map((answer) => answer.pending.request_id), message_ids: readyMessages.map((message) => message.message_id),
      oldest_message_age_ms: Math.max(0, ...readyMessages.map((message) => deps.wall() - Date.parse(message.created_at))),
    })
    return true
  } catch (error) {
    if (began && !outputAttempted) restoreUnwritten()
    await handOff.finish(outputAttempted ? 'failed' : began ? 'aborted' : 'not-written')
    throw error
  }
}


export async function drainSessionInputs(input: Parameters<typeof drainSessionInputsOnce>[0]): Promise<boolean> {
  try { return await drainSessionInputsOnce(input) }
  finally {
    // Delivery bookkeeping has released its sequencer before native cleanup.
    await reconcileSessionInputWakes(input.sequencer.sessionId, input.sequencer.env)
      .catch(() => undefined)
  }
}
