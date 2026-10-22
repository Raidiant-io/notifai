/** Local association of registered questions with actual accepted Codex forms. */
import { isDeepStrictEqual } from 'node:util'
import type { QuestionT, ReplyAnswerT } from '@raidiant/notifai-protocol'
import type { ServiceIdentity } from './credentials.js'
import type { PendingQuestion, SessionState } from './hook-types.js'
import type { NativeTurnSnapshot } from './codex-native-turn.js'
import { readNativeTurnSnapshot } from './codex-native-turn.js'
import { readSessionIncarnation, sessionHasEnded } from './hook-session-state.js'
import { currentCodexTurn } from './session-attendant-state.js'
import { processIdentityLiveness } from './process-identity.js'

/** Exact native wording and the native label for each registered choice. */
export interface NativeQuestionShown {
  title: string
  labels: Record<string, string>
}

export interface CodexQuestionBinding {
  question: QuestionT
  /** Codex cards only. A Claude picker carries none: its hook receives the picker itself. */
  marker?: string
  /** Claude Code pickers only: the picker's own text and labels, which its answers are keyed by. */
  picker?: NativeQuestionShown
  /** Codex hook source: the card's actual text and each device choice's label. */
  card?: NativeQuestionShown
  native?: { turn_id: string; call_id: string; index: number }
  /** Marker bindings need a fresh snapshot; card hooks retain their accepted callback proof. */
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
  /** Exact invocation from a root tool callback; no content matching. */
  card_call_id?: string
  /** Exact card handed back by ask; old marker registrations remain readable. */
  card_handback?: true
  /** Wall-clock deadline for the accepted tool result. */
  card_accept_until?: number
  /** Absent for a card prevented before display because transport was missing. */
  card_allowed?: true
  /** Positive receipt evidence only; never an unconfirmed reserved ID. */
  confirmed_request_id?: string
  /** Ordinary presentation is sticky, including an uncertain stdout write. */
  ordinary_only?: true
  /** Explicit retirement/withdrawal cannot become native authority again. */
  terminated?: true
  /** Withdrawn before it left this machine because every item was answered in the terminal. */
  terminal_answered?: true
  /** The User dismissed the question on a device: no answer will come, so a form still showing it closes. */
  dismissed?: true
}

/** The text the native form must show for this question. */
export function nativeQuestionTitle(binding: CodexQuestionBinding): string {
  if (binding.card !== undefined) return binding.card.title
  return binding.marker === undefined ? binding.question.text : `[nf:${binding.marker}] ${binding.question.text}`
}

/** Invocation-local service permission; never stored or reused for later asks. */
export interface NativeQuestionAdmission {
  owner_key: string
  turn_id: string
  service: ServiceIdentity
  /** A Claude Code picker that is this question, one entry per question. */
  picker?: NativeQuestionShown[]
  handback?: NativeQuestionShown[]
  card?: { call_id: string; shown: NativeQuestionShown[]; allow: boolean; accepted?: true }
}

/** Read-only local eligibility. Registration repeats this under its lock. */
export function currentCodexQuestionContext(state: SessionState, sessionId: string, env: NodeJS.ProcessEnv):
  { owner_key: string; snapshot: NativeTurnSnapshot } | null {
  const owner = readSessionIncarnation(sessionId, env)
  const proof = state.codex_native_turn
  if (state.harness !== 'codex' || owner === null || proof?.key !== owner.key || sessionHasEnded(sessionId, env) ||
      owner.harness_process === undefined || processIdentityLiveness(owner.harness_process) !== 'alive' ||
      state.codex_tool_hook?.incarnation !== owner.incarnation || state.codex_tool_hook.root_observed?.turn_id !== proof.turn_id ||
      currentCodexTurn(sessionId, env, owner.key) !== proof.turn_id) return null
  const snapshot = readNativeTurnSnapshot(proof.transcript_path, sessionId, env)
  if (snapshot === null || snapshot.latest.id !== proof.turn_id || snapshot.latest.ended) return null
  return { owner_key: owner.key, snapshot }
}

/** Called by registration while holding the session lock. Capability absence
 * leaves the ordinary registration untouched and creates no native authority.
 */
export function reserveCurrentCodexQuestion(state: SessionState, pending: PendingQuestion, sessionId: string, env: NodeJS.ProcessEnv,
  admission?: NativeQuestionAdmission): SessionState {
  if (admission === undefined || !isDeepStrictEqual(admission.service, pending.service_identity)) return state
  if (admission.handback !== undefined) {
    const owner = readSessionIncarnation(sessionId, env)
    if (state.harness !== 'codex' || owner?.key !== admission.owner_key || sessionHasEnded(sessionId, env) ||
        currentCodexTurn(sessionId, env, owner.key) !== admission.turn_id || pending.question_id === undefined ||
        pending.questions?.length !== admission.handback.length ||
        state.codex_question_bindings?.some(item => item.question_id === pending.question_id)) return state
    return { ...state, codex_question_bindings: [...(state.codex_question_bindings ?? []), {
      question_id: pending.question_id, owner_key: owner.key, registration_turn_id: admission.turn_id,
      transcript: { file: '', identity: 'codex-card-hook', registered_offset: 0 },
      service_identity: { ...admission.service }, card_handback: true,
      questions: pending.questions.map((question, index) => ({ question: structuredClone(question),
        card: structuredClone(admission.handback![index]!) })),
    }] }
  }
  if (admission.card !== undefined) {
    const owner = readSessionIncarnation(sessionId, env)
    if (state.harness !== 'codex' || owner?.key !== admission.owner_key || sessionHasEnded(sessionId, env) ||
        currentCodexTurn(sessionId, env, owner.key) !== admission.turn_id || pending.question_id === undefined ||
        pending.questions?.length !== admission.card.shown.length || admission.card.shown.length === 0 ||
        state.codex_question_bindings?.some(item => item.question_id === pending.question_id)) return state
    return { ...state, codex_question_bindings: [...(state.codex_question_bindings ?? []), {
      question_id: pending.question_id, owner_key: owner.key, registration_turn_id: admission.turn_id,
      transcript: { file: '', identity: 'codex-card-hook', registered_offset: 0 },
      service_identity: { ...admission.service }, card_call_id: admission.card.call_id,
      ...(admission.card.allow ? { card_allowed: true as const } : { ordinary_only: true as const }),
      questions: pending.questions.map((question, index) => ({ question: structuredClone(question),
        card: structuredClone(admission.card!.shown[index]!),
        ...(admission.card!.allow && admission.card!.accepted === true ? { verified: true as const,
          native: { turn_id: admission.turn_id, call_id: admission.card!.call_id, index } } : {}),
      })),
    }] }
  }
  // Read existing marker bindings for installed older skills, but issue none.
  return state
}

/** Count every marker occurrence before shape filtering. A changed-options
 * duplicate is still ambiguous. Missing/truncated/replaced evidence removes
 * current eligibility without forgetting the original tuple or ambiguity.
 */
export function observeCodexQuestions(state: SessionState, key: string, snapshot: NativeTurnSnapshot | null): SessionState {
  if (state.codex_question_bindings === undefined) return state
  return { ...state, codex_question_bindings: state.codex_question_bindings.map(registration => {
    // A hook-sourced card is verified by its exact PostToolUse acceptance
    // receipt. A bounded transcript is neither its identity nor its authority.
    if (registration.card_call_id !== undefined || registration.card_handback === true) return registration
    const covered = registration.terminated !== true && registration.owner_key === key && snapshot !== null &&
      snapshot.file === registration.transcript.file && snapshot.identity === registration.transcript.identity &&
      snapshot.size >= registration.transcript.registered_offset && snapshot.positions.has(registration.registration_turn_id)
    return { ...registration, questions: registration.questions.map(binding => {
      const next = { ...binding }
      delete next.verified
      if (!covered || binding.ambiguous === true || binding.marker === undefined) return next
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

/**
 * Whether a native form (a Claude Code picker or a Codex card) may still
 * return this question's answer. That form writes only an answer its close
 * selected for claimed delivery, so the close must select it whatever the
 * attendant's lease is doing at that instant. The registration is written in
 * the same transaction as the question, so no answer can arrive before it.
 */
export function nativeFormMayAnswer(state: SessionState, questionId: string | undefined): boolean {
  return questionId !== undefined && state.codex_question_bindings?.some(item =>
    item.question_id === questionId && item.ordinary_only !== true && item.terminated !== true) === true
}

/** The User dismissed these questions on a device. Written before they retire, so a waiting form sees why. */
export function markNativeQuestionsDismissed(state: SessionState, questionIds: ReadonlySet<string>): SessionState {
  if (!state.codex_question_bindings?.some(item => questionIds.has(item.question_id))) return state
  return { ...state, codex_question_bindings: state.codex_question_bindings.map(item =>
    questionIds.has(item.question_id) ? { ...item, dismissed: true as const } : item) }
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
  return !state.codex_question_bindings?.some(item => item.question_id === pending.question_id &&
    (item.card_call_id === undefined || item.card_allowed === true))
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
