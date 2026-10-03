/** Durable execution of an explicitly identified, agent-reported native answer. */
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  isRecordHarnessAnswerRequest,
  type PutAgentAcknowledgementResponse,
  type RecordHarnessAnswerResponse,
  type ReplyAnswerT,
} from '@raidiant/notifai-protocol'
import type { ApiClient } from './client.js'
import type { ServiceIdentity } from './credentials.js'
import { withFileLock } from './file-lock.js'
import {
  readSessionIncarnation, readSessionState, sessionHasEnded, sessionStatePath,
  writeSessionStateUnlocked,
} from './hook-session-state.js'
import type { PendingQuestion, SessionState } from './hook-types.js'

/** A command obligation, never a second answer-delivery queue. */
export interface NativeAnswerOperation {
  question_id: string
  operation_id: string
  /** Absent until ordinary submission confirms the original registration. */
  request_id?: string
  submission_id: string
  service_identity: ServiceIdentity
  answers: ReplyAnswerT[]
  acknowledgement_text: string
  report?: { reply_seq: number; reply_id: string }
  acknowledgement?: PutAgentAcknowledgementResponse['agent_acknowledgement']
}

export interface NativeOperationOwner {
  sessionId: string
  /** The current executing incarnation, renewed only by a new invocation. */
  key: string
  service: ServiceIdentity
}

export interface NativeOperationInput {
  questionId: string
  operationId: string
  answers?: ReplyAnswerT[]
  text?: string
}

/** Called inside the state transaction, only when creating a new operation.
 * The Codex binding adapter must prove the exact emitted native questions,
 * registered shape, current incarnation and original service/Machine here.
 * An explicit q_ selection alone is not native-form evidence.
 */
export type AdmitNativeAnswer = (state: SessionState, answers: ReplyAnswerT[]) => {
  requestId?: string
  service: ServiceIdentity
}

function assertOwner(owner: NativeOperationOwner, env: NodeJS.ProcessEnv): void {
  if (sessionHasEnded(owner.sessionId, env) || readSessionIncarnation(owner.sessionId, env)?.key !== owner.key) {
    throw new Error('The Agent Session incarnation changed; resume this operation from its current owner.')
  }
}

function normalizedAnswers(answers: ReplyAnswerT[], sessionId: string): ReplyAnswerT[] {
  if (!isRecordHarnessAnswerRequest({ session_id: sessionId, submission_id: 'validation', answers })) {
    throw new Error('Native answers must use the registered question and choice IDs with non-empty answers.')
  }
  const seen = new Set<string>()
  return answers.map(answer => {
    const text = answer.text?.trim()
    const choices = answer.choice_ids === undefined ? [] : [...answer.choice_ids].sort()
    if (seen.has(answer.question_id) || new Set(choices).size !== choices.length ||
        (text !== undefined && text.length === 0) || (choices.length === 0 && text === undefined)) {
      throw new Error('Native answers must be non-empty and cannot repeat question or choice IDs.')
    }
    seen.add(answer.question_id)
    return {
      question_id: answer.question_id,
      ...(choices.length === 0 ? {} : { choice_ids: choices }),
      ...(text === undefined ? {} : { text }),
    }
  }).sort((a, b) => a.question_id.localeCompare(b.question_id))
}

/** Persist the immutable body/key before any HTTP. Identity-only calls never create. */
export function prepareNativeAnswerOperation(
  owner: NativeOperationOwner, env: NodeJS.ProcessEnv, input: NativeOperationInput,
  admit: AdmitNativeAnswer,
): NativeAnswerOperation {
  if (!/^q_[A-Za-z0-9_-]+$/.test(input.questionId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.operationId)) {
    throw new Error('Native reporting requires an exact q_ identity and a 1–64 character operation ID.')
  }
  const answers = input.answers === undefined ? undefined : normalizedAnswers(input.answers, owner.sessionId)
  const text = input.text?.trim()
  if (text !== undefined && (text.length === 0 || text.length > AGENT_ACKNOWLEDGEMENT_MAX_LENGTH)) {
    throw new Error(`The authored acknowledgement must contain 1–${AGENT_ACKNOWLEDGEMENT_MAX_LENGTH} characters.`)
  }
  const file = sessionStatePath(owner.sessionId, env)
  return withFileLock(`${file}.lock`, () => {
    assertOwner(owner, env)
    const state = readSessionState(owner.sessionId, env)
    const operations = state.native_answer_operations ?? []
    const existing = operations.find(op => op.question_id === input.questionId && op.operation_id === input.operationId)
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.service_identity, owner.service) ||
          (answers !== undefined && !isDeepStrictEqual(answers, existing.answers)) ||
          (text !== undefined && text !== existing.acknowledgement_text)) {
        throw new Error('This operation already names a different owner or body; do not change an operation on retry.')
      }
      return structuredClone(existing)
    }
    if (answers === undefined || text === undefined) {
      throw new Error('A new native operation requires explicit answers and an authored acknowledgement; identity-only calls resume existing operations.')
    }
    const registration = admit(state, answers)
    if (!isDeepStrictEqual(registration.service, owner.service) ||
        (registration.requestId !== undefined && !/^req_[A-Za-z0-9_-]+$/.test(registration.requestId))) {
      throw new Error('The native question does not belong to this service and Approved Machine.')
    }
    const operation: NativeAnswerOperation = {
      question_id: input.questionId, operation_id: input.operationId,
      ...(registration.requestId === undefined ? {} : { request_id: registration.requestId }),
      submission_id: randomBytes(24).toString('base64url'),
      service_identity: { ...owner.service }, answers, acknowledgement_text: text,
    }
    writeSessionStateUnlocked(file, owner.sessionId, { ...state, native_answer_operations: [...operations, operation] })
    return structuredClone(operation)
  })
}

function matchingOperation(state: SessionState, expected: NativeAnswerOperation): NativeAnswerOperation {
  const current = state.native_answer_operations?.find(op =>
    op.question_id === expected.question_id && op.operation_id === expected.operation_id)
  if (current === undefined || current.submission_id !== expected.submission_id ||
      (expected.request_id !== undefined && current.request_id !== expected.request_id) || !isDeepStrictEqual(current.answers, expected.answers) ||
      current.acknowledgement_text !== expected.acknowledgement_text ||
      !isDeepStrictEqual(current.service_identity, expected.service_identity)) {
    throw new Error('The durable native operation changed or disappeared; no new request was admitted.')
  }
  return current
}

/** Fill the target once, from confirmed ordinary submission evidence. The
 * caller recovers the original submission outside this transaction, after
 * preparation has frozen the answer. A reserved/frozen request ID is not a
 * receipt. The adapter must reject terminated or differently owned questions.
 */
export function resolveNativeAnswerOperation(
  owner: NativeOperationOwner, env: NodeJS.ProcessEnv, operation: NativeAnswerOperation,
  confirmed: (state: SessionState) => { requestId: string; service: ServiceIdentity } | null,
): NativeAnswerOperation {
  const file = sessionStatePath(owner.sessionId, env)
  return withFileLock(`${file}.lock`, () => {
    assertOwner(owner, env)
    const state = readSessionState(owner.sessionId, env)
    const current = matchingOperation(state, operation)
    if (!isDeepStrictEqual(current.service_identity, owner.service)) throw new Error('The Approved Machine changed.')
    // Another invocation may have resolved while this one recovered submission.
    // Its confirmed target is immutable; no callback may replace it.
    if (current.request_id !== undefined) return structuredClone(current)
    const receipt = confirmed(state)
    if (receipt === null) throw new Error('The original question submission is not confirmed; retry the same operation.')
    if (!/^req_[A-Za-z0-9_-]+$/.test(receipt.requestId) || !isDeepStrictEqual(receipt.service, current.service_identity)) {
      throw new Error('The confirmed question belongs to a different service or Approved Machine.')
    }
    const next = { ...current, request_id: receipt.requestId }
    writeSessionStateUnlocked(file, owner.sessionId, {
      ...state, native_answer_operations: state.native_answer_operations!.map(op => op === current ? next : op),
    })
    return structuredClone(next)
  })
}

/** Called only while committing a successful submit receipt or an accepted
 * app reply, never for an attempted submission, retirement or history row.
 * Resolve in that same transaction so cleanup cannot erase the only proof.
 * A late receipt enriches existing obligations without resurrecting a question.
 */
export function confirmNativeAnswerTarget(state: SessionState, question: PendingQuestion): SessionState {
  if (question.question_id === undefined || question.service_identity === undefined ||
      question.request_id === undefined) return state
  const requestId = question.request_id
  if (!/^req_[A-Za-z0-9_-]+$/.test(requestId)) return state
  const operationMatch = state.native_answer_operations?.some(op => op.question_id === question.question_id &&
    op.request_id === undefined && isDeepStrictEqual(op.service_identity, question.service_identity))
  const bindingMatch = state.codex_question_bindings?.some(binding => binding.question_id === question.question_id &&
    binding.confirmed_request_id === undefined && isDeepStrictEqual(binding.service_identity, question.service_identity))
  if (!operationMatch && !bindingMatch) return state
  return { ...state, ...(operationMatch ? { native_answer_operations: state.native_answer_operations!.map(op =>
    op.question_id === question.question_id && op.request_id === undefined &&
    isDeepStrictEqual(op.service_identity, question.service_identity)
      ? { ...op, request_id: requestId } : op) } : {}),
    ...(bindingMatch ? { codex_question_bindings: state.codex_question_bindings!.map(binding =>
      binding.question_id === question.question_id && binding.confirmed_request_id === undefined &&
      isDeepStrictEqual(binding.service_identity, question.service_identity)
        ? { ...binding, confirmed_request_id: requestId } : binding) } : {}),
  }
}

/** A response may arrive after SessionEnd. Unlike a normal lifecycle writer,
 * this can only enrich an existing immutable obligation, never restore state.
 */
export function recordConfirmedNativeAnswerTarget(sessionId: string, env: NodeJS.ProcessEnv, question: PendingQuestion): void {
  const file = sessionStatePath(sessionId, env)
  withFileLock(`${file}.lock`, () => {
    const current = readSessionState(sessionId, env)
    const next = confirmNativeAnswerTarget(current, question)
    if (next !== current) writeSessionStateUnlocked(file, sessionId, next)
  })
}

/** Admit each non-blocking HTTP start under the owner fence, never await under a lock. */
function startPhase<T>(owner: NativeOperationOwner, env: NodeJS.ProcessEnv, operation: NativeAnswerOperation, start: (current: NativeAnswerOperation) => Promise<T>): Promise<T> {
  const file = sessionStatePath(owner.sessionId, env)
  return withFileLock(`${file}.lock`, () => {
    assertOwner(owner, env)
    const current = matchingOperation(readSessionState(owner.sessionId, env), operation)
    if (!isDeepStrictEqual(current.service_identity, owner.service)) throw new Error('The Approved Machine changed.')
    return start(structuredClone(current))
  })
}

/** A late receipt may finish the identical obligation after end/resume, but
 * cannot create a new operation, restore deleted state, or admit another phase.
 */
function mergeReceipt(owner: NativeOperationOwner, env: NodeJS.ProcessEnv, operation: NativeAnswerOperation, update: (op: NativeAnswerOperation) => NativeAnswerOperation): NativeAnswerOperation {
  const file = sessionStatePath(owner.sessionId, env)
  return withFileLock(`${file}.lock`, () => {
    const state = readSessionState(owner.sessionId, env)
    const current = matchingOperation(state, operation)
    const next = update(current)
    writeSessionStateUnlocked(file, owner.sessionId, {
      ...state, native_answer_operations: state.native_answer_operations!.map(op => op === current ? next : op),
    })
    return next
  })
}

/** Replay the immutable report to refresh competing submissions, then finish
 * only this answer's acknowledgement. No ordinary debt, watcher or input state
 * is cleared. A lost response simply leaves the same phase safe to retry.
 */
export async function executeNativeAnswerOperation(
  owner: NativeOperationOwner, env: NodeJS.ProcessEnv, operation: NativeAnswerOperation,
  client: Pick<ApiClient, 'recordHarnessAnswer' | 'putAgentAcknowledgement'>,
): Promise<{ report: RecordHarnessAnswerResponse; acknowledgement: NativeAnswerOperation['acknowledgement'] }> {
  const submitted = await startPhase(owner, env, operation, async current => {
    if (current.request_id === undefined) throw new Error('The original question submission is not confirmed; retry the same operation.')
    const report = await client.recordHarnessAnswer(current.request_id, {
      session_id: owner.sessionId, submission_id: current.submission_id, answers: current.answers,
    })
    return { report, operation: current, requestId: current.request_id }
  })
  operation = submitted.operation
  const { report, requestId } = submitted
  if (report == null || !['recorded', 'replayed'].includes(report.status) ||
      !Number.isSafeInteger(report.reply_seq) || report.reply_seq < 1 ||
      !/^rpl_[A-Za-z0-9_-]+$/.test(report.answer_version?.version_id ?? '') ||
      report.answer_version.origin !== 'harness' || report.answer_version.provenance !== 'agent-reported' ||
      report.answer_version.status !== 'presented' || report.answer_version.source !== 'reply' ||
      report.answer_version.base_version !== null || typeof report.complete !== 'boolean' ||
      !Array.isArray(report.other_submissions) || ![report.answer_version, ...report.other_submissions].every(version =>
        version != null && typeof version.version_id === 'string' &&
        ['harness', 'companion'].includes(version.origin) && Array.isArray(version.answers) &&
        version.answers.every(answer => answer != null && typeof answer.question_id === 'string' &&
          Array.isArray(answer.choice_ids) && answer.choice_ids.every(choice => typeof choice === 'string') &&
          (answer.text === null || typeof answer.text === 'string')))) {
    throw new Error('Native answer report receipt is incomplete; retry the same operation.')
  }
  const reported = normalizedAnswers(report.answer_version.answers.map(answer => ({
    question_id: answer.question_id,
    ...(answer.choice_ids.length === 0 ? {} : { choice_ids: answer.choice_ids }),
    ...(answer.text === null ? {} : { text: answer.text }),
  })), owner.sessionId)
  if (!isDeepStrictEqual(reported, operation.answers)) throw new Error('Native answer report does not confirm the submitted answers.')
  const receipt = { reply_seq: report.reply_seq, reply_id: report.answer_version.version_id }
  let current = mergeReceipt(owner, env, operation, op => {
    if (op.report !== undefined && !isDeepStrictEqual(op.report, receipt)) throw new Error('Native answer report identity changed.')
    return { ...op, report: receipt }
  })
  if (current.acknowledgement === undefined) {
    const result = await startPhase(owner, env, current, () => client.putAgentAcknowledgement(requestId, {
      session_id: owner.sessionId, reply_seq: receipt.reply_seq, text: current.acknowledgement_text,
    }))
    if (result == null || !['recorded', 'replayed'].includes(result.status) ||
        result.agent_acknowledgement == null ||
        result.agent_acknowledgement.text !== current.acknowledgement_text ||
        typeof result.agent_acknowledgement.created_at !== 'string' ||
        !Number.isFinite(Date.parse(result.agent_acknowledgement.created_at))) {
      throw new Error('Native acknowledgement receipt is incomplete or changed; retry the same operation.')
    }
    current = mergeReceipt(owner, env, operation, op => {
      if (op.acknowledgement !== undefined && !isDeepStrictEqual(op.acknowledgement, result.agent_acknowledgement)) {
        throw new Error('Native acknowledgement receipt changed.')
      }
      return { ...op, acknowledgement: result.agent_acknowledgement }
    })
  }
  return { report, acknowledgement: current.acknowledgement }
}
