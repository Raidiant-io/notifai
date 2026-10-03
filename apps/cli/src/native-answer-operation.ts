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
import type { SessionState } from './hook-types.js'

/** A command obligation, never a second answer-delivery queue. */
export interface NativeAnswerOperation {
  question_id: string
  operation_id: string
  request_id: string
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
  requestId: string
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
    if (!isDeepStrictEqual(registration.service, owner.service) || !/^req_[A-Za-z0-9_-]+$/.test(registration.requestId)) {
      throw new Error('The native question does not belong to this service and Approved Machine.')
    }
    const operation: NativeAnswerOperation = {
      question_id: input.questionId, operation_id: input.operationId,
      request_id: registration.requestId, submission_id: randomBytes(24).toString('base64url'),
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
      current.request_id !== expected.request_id || !isDeepStrictEqual(current.answers, expected.answers) ||
      current.acknowledgement_text !== expected.acknowledgement_text ||
      !isDeepStrictEqual(current.service_identity, expected.service_identity)) {
    throw new Error('The durable native operation changed or disappeared; no new request was admitted.')
  }
  return current
}

/** Admit each non-blocking HTTP start under the owner fence, never await under a lock. */
function startPhase<T>(owner: NativeOperationOwner, env: NodeJS.ProcessEnv, operation: NativeAnswerOperation, start: () => Promise<T>): Promise<T> {
  const file = sessionStatePath(owner.sessionId, env)
  return withFileLock(`${file}.lock`, () => {
    assertOwner(owner, env)
    const current = matchingOperation(readSessionState(owner.sessionId, env), operation)
    if (!isDeepStrictEqual(current.service_identity, owner.service)) throw new Error('The Approved Machine changed.')
    return start()
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
  const report = await startPhase(owner, env, operation, () => client.recordHarnessAnswer(operation.request_id, {
    session_id: owner.sessionId, submission_id: operation.submission_id, answers: operation.answers,
  }))
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
    const result = await startPhase(owner, env, current, () => client.putAgentAcknowledgement(current.request_id, {
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
