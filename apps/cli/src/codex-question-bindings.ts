/** Local association of registered questions with actual accepted Codex forms. */
import { isDeepStrictEqual } from 'node:util'
import type { QuestionT, ReplyAnswerT } from '@raidiant/notifai-protocol'
import type { ServiceIdentity } from './credentials.js'
import type { PendingQuestion, SessionState } from './hook-types.js'
import type { NativeTurnSnapshot } from './codex-native-turn.js'
import { readNativeQuestionSnapshot } from './codex-native-turn.js'
import { readSessionIncarnation, sessionHasEnded } from './hook-session-state.js'
import { currentCodexTurn } from './session-attendant-state.js'
import { processIdentityLiveness } from './process-identity.js'

export interface CodexQuestionBinding {
  question: QuestionT
  marker: string
  native?: { turn_id: string; call_id: string; index: number }
  /** Recomputed from a fresh full registration-turn snapshot before use. */
  verified?: true
  /** A second occurrence permanently removes this marker's authority. */
  ambiguous?: true
}

export interface CodexQuestionRegistration {
  question_id: string
  owner_key: string
  registration_turn_id: string
  transcript: { file: string; identity: string; registered_offset: number }
  service_identity: ServiceIdentity
  questions: CodexQuestionBinding[]
  /** Positive receipt evidence only; never an unconfirmed reserved ID. */
  confirmed_request_id?: string
  /** Ordinary presentation is sticky, including an uncertain stdout write. */
  ordinary_only?: true
  /** Explicit retirement/withdrawal cannot become native authority again. */
  terminated?: true
}

export function nativeQuestionTitle(binding: CodexQuestionBinding): string {
  return `[nf:${binding.marker}] ${binding.question.text}`
}

/** Called by registration while holding the session lock. Capability absence
 * leaves the ordinary registration untouched and creates no native authority.
 */
export function reserveCurrentCodexQuestion(state: SessionState, pending: PendingQuestion, sessionId: string, env: NodeJS.ProcessEnv): SessionState {
  const owner = readSessionIncarnation(sessionId, env)
  const proof = state.codex_native_turn
  if (state.harness !== 'codex' || owner === null || proof?.key !== owner.key || sessionHasEnded(sessionId, env) ||
      owner.harness_process === undefined || processIdentityLiveness(owner.harness_process) !== 'alive' ||
      state.codex_tool_hook?.incarnation !== owner.incarnation || state.codex_tool_hook.root_observed?.turn_id !== proof.turn_id ||
      currentCodexTurn(sessionId, env, owner.key) !== proof.turn_id) return state
  const snapshot = readNativeQuestionSnapshot(proof.transcript_path, sessionId, env)
  if (snapshot === null || snapshot.latest.id !== proof.turn_id) return state
  return reserveCodexQuestion(state, pending, owner.key, snapshot)
}

/** Caller holds the registration transaction and has proved the current owner.
 * Reservation and pending registration must be saved in that single write.
 * This creates no native question; only the agent's real tool call can do that.
 */
export function reserveCodexQuestion(
  state: SessionState, pending: PendingQuestion, key: string, snapshot: NativeTurnSnapshot,
): SessionState {
  if (state.harness !== 'codex' || pending.question_id === undefined || pending.service_identity === undefined ||
      snapshot.latest.ended || snapshot.questions === undefined || !snapshot.positions.has(snapshot.latest.id) ||
      pending.questions === undefined || pending.questions.length === 0 ||
      pending.questions.some(question => question.multi === true) ||
      state.codex_question_bindings?.some(item => item.question_id === pending.question_id)) return state
  const used = new Set((state.codex_question_bindings ?? []).flatMap(item => item.questions.map(q => q.marker)))
  // Avoid even an unrelated previously emitted marker visible in this turn.
  for (const emission of snapshot.questions) {
    for (const match of emission.title.matchAll(/\[nf:([0-9A-Z]+)\]/g)) used.add(match[1]!)
  }
  let counter = state.codex_question_marker_counter ?? 0
  if (!Number.isSafeInteger(counter) || counter < 0) return state
  const questions: CodexQuestionBinding[] = []
  for (const question of pending.questions) {
    let marker: string
    do {
      if (counter >= Number.MAX_SAFE_INTEGER) return state
      marker = (++counter).toString(36).toUpperCase().padStart(3, '0')
    } while (used.has(marker))
    used.add(marker)
    questions.push({ question: structuredClone(question), marker })
  }
  return { ...state, codex_question_marker_counter: counter, codex_question_bindings: [
    ...(state.codex_question_bindings ?? []), {
      question_id: pending.question_id, owner_key: key, registration_turn_id: snapshot.latest.id,
      transcript: { file: snapshot.file, identity: snapshot.identity, registered_offset: snapshot.size },
      service_identity: { ...pending.service_identity }, questions,
    },
  ] }
}

/** Count every marker occurrence before shape filtering. A changed-options
 * duplicate is still ambiguous. Missing/truncated/replaced evidence removes
 * current eligibility without forgetting the original tuple or ambiguity.
 */
export function observeCodexQuestions(state: SessionState, key: string, snapshot: NativeTurnSnapshot | null): SessionState {
  if (state.codex_question_bindings === undefined) return state
  return { ...state, codex_question_bindings: state.codex_question_bindings.map(registration => {
    const covered = registration.terminated !== true && registration.owner_key === key && snapshot !== null &&
      snapshot.file === registration.transcript.file && snapshot.identity === registration.transcript.identity &&
      snapshot.size >= registration.transcript.registered_offset && snapshot.positions.has(registration.registration_turn_id)
    return { ...registration, questions: registration.questions.map(binding => {
      const next = { ...binding }
      delete next.verified
      if (!covered || binding.ambiguous === true) return next
      const matches = snapshot.questions?.filter(emission => emission.accepted && emission.title.includes(`[nf:${binding.marker}]`)) ?? []
      // Count multiple copies of the token in a single title as ambiguous too.
      if (matches.length > 1 || matches.some(emission => emission.title.split(`[nf:${binding.marker}]`).length !== 2)) {
        return { ...next, ambiguous: true as const }
      }
      const emission = matches[0]
      if (emission === undefined || emission.offset < registration.transcript.registered_offset ||
          emission.turn_id !== registration.registration_turn_id ||
          emission.title !== nativeQuestionTitle(binding) ||
          !isDeepStrictEqual(emission.options, binding.question.choices?.map(choice => choice.label))) return next
      const native = { turn_id: emission.turn_id, call_id: emission.call_id, index: emission.index }
      if (binding.native !== undefined && !isDeepStrictEqual(binding.native, native)) return { ...next, ambiguous: true as const }
      return { ...next, native, verified: true as const }
    }) }
  }) }
}

/** Mark in the same transaction that consumes the ordinary app answer. */
export function markCodexOrdinaryPresentation(state: SessionState, questionIds: ReadonlySet<string>): SessionState {
  if (!state.codex_question_bindings?.some(item => questionIds.has(item.question_id))) return state
  return { ...state, codex_question_bindings: state.codex_question_bindings.map(item =>
    questionIds.has(item.question_id) ? { ...item, ordinary_only: true } : item) }
}

/** Explicit cancellation only, in the transaction selecting the questions. */
export function terminateCodexQuestions(state: SessionState, ids: ReadonlySet<string>): SessionState {
  if (state.codex_question_bindings === undefined) return state
  return { ...state, codex_question_bindings: state.codex_question_bindings.map(binding =>
    ids.has(binding.question_id) || (binding.confirmed_request_id !== undefined && ids.has(binding.confirmed_request_id))
      ? { ...binding, terminated: true } : binding),
  }
}

/** Reservation protects early native answers before the emission observer runs.
 * Apply after matching all pending questions, so sibling ambiguity is preserved.
 */
export function mayRetireFromPrompt(state: SessionState, pending: PendingQuestion): boolean {
  return !state.codex_question_bindings?.some(item => item.question_id === pending.question_id)
}

/** The caller refreshes observation under the owner fence before admission.
 * A fresh native answer remains reportable after ordinary app presentation.
 */
export function admitBoundNativeAnswer(
  state: SessionState, questionId: string, key: string, service: ServiceIdentity, answers: ReplyAnswerT[],
): { requestId?: string; service: ServiceIdentity } {
  const registration = state.codex_question_bindings?.find(item => item.question_id === questionId)
  if (registration === undefined || registration.terminated === true || registration.owner_key !== key || !isDeepStrictEqual(registration.service_identity, service)) {
    throw new Error('The native question is not registered to this owner and Approved Machine.')
  }
  if (answers.length === 0 || new Set(answers.map(answer => answer.question_id)).size !== answers.length) throw new Error('Native answers must name distinct registered questions.')
  for (const answer of answers) {
    const binding = registration.questions.find(item => item.question.id === answer.question_id)
    const choices = answer.choice_ids ?? []
    if (binding?.verified !== true || binding.native === undefined || binding.ambiguous === true ||
        new Set(choices).size !== choices.length || (binding.question.multi !== true && choices.length > 1) ||
        choices.some(id => !binding.question.choices?.some(choice => choice.id === id)) ||
        (choices.length === 0 && !answer.text?.trim())) {
      throw new Error('The answer does not match one verified native question and its registered choices.')
    }
  }
  return { service: registration.service_identity,
    ...(registration.confirmed_request_id === undefined ? {} : { requestId: registration.confirmed_request_id }) }
}
