/** Codex card replies are user input. Hooks observe; the owner confirms and reports. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ReplyAnswerT } from '@raidiant/notifai-protocol'
import { ApiCallError } from './client.js'
import { dropPendingQuestion, questionSubmissionAttempted, rememberQuestionState } from './hook-question-state.js'
import { parkForRetirement } from './hook-question-retirement.js'
import type { CommandDeps } from './commands-core.js'
import type { ServiceIdentity } from './credentials.js'
import type { HookContext, HookEnvelope } from './hook-types.js'
import { admitBoundNativeAnswer, nativeQuestionTitle, observeCodexQuestions, terminateCodexQuestions } from './codex-question-bindings.js'
import { readNativeInputSnapshot, readNativeQuestionSnapshot } from './codex-native-turn.js'
import { pendingList, readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import {
  NativeAnswerAlreadyRecorded, answersRecordedElsewhere, executeNativeAnswerOperation, prepareNativeAnswerOperation,
  resolveNativeAnswerOperation,
} from './native-answer-operation.js'
import { processIdentityLiveness } from './process-identity.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import type { Logger } from './logging.js'

const OPEN = '<send_user_message_question_reply>'
const CLOSE = '</send_user_message_question_reply>'
export const CODEX_TERMINAL_RECEIPT = 'Answered in the agent session.'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface CodexTerminalReply { callId: string; index: number; question: string; answer: string }
export interface CodexTerminalObservation {
  question_id: string
  operation_id: string
  owner_key: string
  service_identity: ServiceIdentity
  answer: ReplyAnswerT
  /** The hook precedes commit. An older identical message cannot confirm it. */
  transcript: { file: string; identity: string; offset: number; turn_id: string; hash: string }
}
export interface CodexTerminalConflict { id: string; context: string; shown?: true }

/** Parse the whole envelope, never an example embedded in prose or tool output. */
export function parseCodexTerminalReplies(prompt: unknown): CodexTerminalReply[] {
  if (typeof prompt !== 'string') return []
  let text = prompt.trim()
  // Codex may prepend its IDE context before the user's actual request.
  if (text.startsWith('# Context from my IDE:')) {
    const marker = '\n## My request for Codex:\n'
    const at = text.indexOf(marker)
    if (at < 0) return []
    text = text.slice(at + marker.length).trim()
  }
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return []
  try {
    const value: unknown = JSON.parse(text.slice(OPEN.length, -CLOSE.length))
    if (!Array.isArray(value) || value.length === 0 || value.length > 10) return []
    const replies: CodexTerminalReply[] = []
    const seen = new Set<string>()
    for (const item of value) {
      if (item === null || typeof item !== 'object') return []
      // Exclude device answers and expirations, including unknown future markers.
      if ('notifai' in item) continue
      if (typeof item.questionItemId !== 'string' || typeof item.question !== 'string' ||
          typeof item.answer !== 'string' || !item.answer.trim()) return []
      const id: unknown = JSON.parse(item.questionItemId)
      if (!Array.isArray(id) || id.length !== 3 || id[0] !== 'request_user_input_async' ||
          typeof id[1] !== 'string' || !id[1] || !Number.isSafeInteger(id[2]) || id[2] < 0 || id[2] > 9) return []
      const key = JSON.stringify(id)
      if (seen.has(key)) return []
      seen.add(key)
      replies.push({ callId: id[1], index: id[2], question: item.question, answer: item.answer })
    }
    return replies
  } catch { return [] }
}

/** Only the live root hook may observe input for this Agent Session. */
function hookOwner(deps: CommandDeps, envelope: HookEnvelope) {
  if (!envelope.session_id || !envelope.turn_id || envelope.agent_id !== undefined || envelope.agent_type !== undefined) return null
  const owner = readSessionIncarnation(envelope.session_id, deps.env)
  return owner?.harness_process !== undefined && owner.harness_process.pid === Number(deps.env['NOTIFAI_HOOK_SOURCE_PID']) &&
    processIdentityLiveness(owner.harness_process) === 'alive' && !sessionHasEnded(envelope.session_id, deps.env) &&
    readSessionState(envelope.session_id, deps.env).harness === 'codex' ? owner : null
}

/** Local only. Another UserPromptSubmit hook can still block this message. */
export function observeCodexTerminalAnswers(deps: CommandDeps, envelope: HookEnvelope, logger: Logger): void {
  if (envelope.hook_event_name !== 'UserPromptSubmit') return
  const replies = parseCodexTerminalReplies(envelope.prompt)
  if (replies.length === 0) return
  const owner = hookOwner(deps, envelope)
  if (owner === null) return
  const sessionId = envelope.session_id!
  const snapshot = readNativeInputSnapshot(envelope.transcript_path, sessionId, deps.env)
  if (snapshot === null) return
  updateSessionState(sessionId, deps.env, original => {
    if (hookOwner(deps, envelope)?.key !== owner.key) return original
    const state = original.codex_question_bindings?.some(item => item.card_call_id === undefined)
      ? observeCodexQuestions(original, owner.key, readNativeQuestionSnapshot(envelope.transcript_path, sessionId, deps.env)) : original
    const observations = [...(state.codex_terminal_observations ?? [])]
    for (const reply of replies) {
      const matches = (state.codex_question_bindings ?? []).flatMap(registration =>
        registration.owner_key !== owner.key || registration.terminated === true ? [] : registration.questions.flatMap(binding =>
          binding.verified === true && binding.ambiguous !== true && binding.native?.call_id === reply.callId &&
          binding.native.index === reply.index && nativeQuestionTitle(binding) === reply.question ? [{ registration, binding }] : []))
      if (matches.length !== 1) continue
      const { registration, binding } = matches[0]!
      const labels = binding.card?.labels ?? Object.fromEntries((binding.question.choices ?? []).map(choice => [choice.id, choice.label]))
      const selected = Object.entries(labels).filter(([, label]) => label === reply.answer)
      if (selected.length > 1) continue
      const answer: ReplyAnswerT = { question_id: binding.question.id,
        ...(selected.length === 1 ? { choice_ids: [selected[0]![0]] } : { text: reply.answer.trim() }) }
      const operationId = `terminal:${reply.index}`
      const existing = state.native_answer_operations?.find(op => op.question_id === registration.question_id && op.operation_id === operationId)
      if (existing !== undefined && isDeepStrictEqual(existing.answers, [answer])) continue
      const observation: CodexTerminalObservation = {
        question_id: registration.question_id, operation_id: operationId, owner_key: owner.key,
        service_identity: registration.service_identity, answer,
        transcript: { file: snapshot.file, identity: snapshot.identity, offset: snapshot.size,
          turn_id: envelope.turn_id!, hash: hash(envelope.prompt!) },
      }
      if (!observations.some(item => item.question_id === observation.question_id && item.operation_id === operationId &&
          item.transcript.hash === observation.transcript.hash && item.transcript.identity === snapshot.identity && item.owner_key === owner.key)) {
        observations.push(observation)
      }
    }
    return { ...state, codex_terminal_observations: observations }
  })
  launchCodexTerminalReports(deps, envelope, logger)
}

/** Also retried at tool boundaries if a rollout flush or service call was delayed. */
export function launchCodexTerminalReports(deps: CommandDeps, envelope: HookEnvelope, logger: Logger): void {
  if (hookOwner(deps, envelope) === null) return
  const state = readSessionState(envelope.session_id!, deps.env)
  if (!state.codex_terminal_observations?.length && !state.native_answer_operations?.some(op =>
    op.operation_id.startsWith('terminal:') && op.acknowledgement === undefined)) return
  try {
    ;(deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({
      envelope: { session_id: envelope.session_id!, cwd: envelope.cwd ?? deps.cwd }, harness: 'codex', purpose: 'submission',
    })
  } catch (error) {
    logger.error('cli.error', { kind: 'question_submission_launch', message: error instanceof Error ? error.message : String(error) })
  }
}

function conflict(sessionId: string, env: NodeJS.ProcessEnv, id: string, question: string, first: unknown, second: unknown): void {
  updateSessionState(sessionId, env, state => {
    if (state.codex_terminal_conflicts?.some(item => item.id === id)) return state
    return { ...state, codex_terminal_conflicts: [...(state.codex_terminal_conflicts ?? []), { id,
      context: `Notifai — conflicting answers for ${question}: ${JSON.stringify(first)}; ${JSON.stringify(second)}. Preserve both and ask which governs before dependent work.` }] }
  })
}

/** Emit conflicts at the next real root hook, never to the detached owner's stdout. */
export function takeCodexTerminalConflictContext(deps: CommandDeps, envelope: HookEnvelope): string | null {
  if (hookOwner(deps, envelope) === null ||
      !readSessionState(envelope.session_id!, deps.env).codex_terminal_conflicts?.some(item => item.shown !== true)) return null
  const contexts: string[] = []
  updateSessionState(envelope.session_id!, deps.env, state => ({ ...state,
    codex_terminal_conflicts: (state.codex_terminal_conflicts ?? []).map(item => {
      if (item.shown === true) return item
      contexts.push(item.context)
      return { ...item, shown: true as const }
    }) }))
  return contexts.length === 0 ? null : contexts.join('\n\n')
}

/** Detached owner only: no report until the exact user input is committed. */
export async function reportCodexTerminalAnswers(ctx: Pick<HookContext, 'client' | 'env' | 'log' | 'service_identity'>, sessionId: string, waitForCommit = false): Promise<void> {
  const incarnation = readSessionIncarnation(sessionId, ctx.env)
  if (incarnation === null || sessionHasEnded(sessionId, ctx.env)) return
  const initial = readSessionState(sessionId, ctx.env)
  if (initial.harness !== 'codex' || (!initial.codex_terminal_observations?.length &&
      !initial.native_answer_operations?.some(op => op.operation_id.startsWith('terminal:') && op.acknowledgement === undefined))) return
  const service = ctx.service_identity
  if (service === undefined) return
  const owner = { sessionId, key: incarnation.key, service }
  const commitDeadline = performance.now() + (waitForCommit ? 2_000 : 0)
  for (const observation of initial.codex_terminal_observations ?? []) {
    if (observation.owner_key !== owner.key || !isDeepStrictEqual(service, observation.service_identity)) continue
    const proof = observation.transcript
    let snapshot = readNativeInputSnapshot(proof.file, sessionId, ctx.env)
    // The hook runs before Codex appends input. Wait only in the detached owner;
    // later owner polls and tool callbacks retry a delayed flush or lost response.
    while (performance.now() < commitDeadline && (snapshot === null || snapshot.identity === proof.identity) &&
        !snapshot?.userMessages?.some(message => message.offset >= proof.offset && (message.turn_id === null || message.turn_id === proof.turn_id) && message.hash === proof.hash)) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (readSessionIncarnation(sessionId, ctx.env)?.key !== owner.key || sessionHasEnded(sessionId, ctx.env)) return
      snapshot = readNativeInputSnapshot(proof.file, sessionId, ctx.env)
    }
    if (snapshot?.identity !== proof.identity || snapshot.tailStart > proof.offset || !snapshot.userMessages?.some(message =>
      message.offset >= proof.offset && (message.turn_id === null || message.turn_id === proof.turn_id) && message.hash === proof.hash)) continue
    try {
      const state = readSessionState(sessionId, ctx.env)
      const existing = state.native_answer_operations?.find(op => op.question_id === observation.question_id && op.operation_id === observation.operation_id)
      // An agent on an older skill may have reported this item itself first.
      const reported = answersRecordedElsewhere(state, observation.question_id, observation.operation_id).get(observation.answer.question_id)
      if (reported !== undefined) {
        if (!isDeepStrictEqual(reported, observation.answer)) {
          conflict(sessionId, ctx.env, `${observation.question_id}:${observation.operation_id}:${proof.hash}`, observation.question_id,
            { origin: 'terminal', answers: [reported] }, { origin: 'terminal', answers: [observation.answer] })
        }
      } else if (existing !== undefined && !isDeepStrictEqual(existing.answers, [observation.answer])) {
        conflict(sessionId, ctx.env, `${observation.question_id}:${observation.operation_id}:${proof.hash}`, observation.question_id,
          { origin: 'terminal', answers: existing.answers }, { origin: 'terminal', answers: [observation.answer] })
      } else {
        prepareNativeAnswerOperation(owner, ctx.env, { questionId: observation.question_id, operationId: observation.operation_id,
          answers: [observation.answer], text: CODEX_TERMINAL_RECEIPT },
        (current, actual) => {
          if (answersRecordedElsewhere(current, observation.question_id, observation.operation_id).has(observation.answer.question_id)) {
            throw new NativeAnswerAlreadyRecorded()
          }
          return admitBoundNativeAnswer(current, observation.question_id, owner.key, service, actual)
        },
        current => current.codex_question_bindings?.some(item => item.question_id === observation.question_id && item.card_call_id === undefined)
          ? observeCodexQuestions(current, owner.key, readNativeQuestionSnapshot(proof.file, sessionId, ctx.env)) : current)
      }
      updateSessionState(sessionId, ctx.env, current => ({ ...current,
        codex_terminal_observations: (current.codex_terminal_observations ?? []).filter(item => !isDeepStrictEqual(item, observation)) }))
    } catch (error) {
      ctx.log?.info('hook.gate', { hook: 'question-submission', stage: 'card-terminal-confirmation', reason: 'retry-later',
        error: error instanceof Error ? error.message : String(error) })
    }
  }
  // Like a picker answered during its terminal-only window, a complete card
  // that never left this machine needs no device question or network receipt.
  updateSessionState(sessionId, ctx.env, state => {
    if (readSessionIncarnation(sessionId, ctx.env)?.key !== owner.key || sessionHasEnded(sessionId, ctx.env)) return state
    let next = state
    for (const registration of state.codex_question_bindings ?? []) {
      if (registration.owner_key !== owner.key || registration.terminated === true ||
          !isDeepStrictEqual(registration.service_identity, service) || registration.confirmed_request_id !== undefined) continue
      const pending = pendingList(next).find(item => item.question_id === registration.question_id)
      if (pending === undefined || questionSubmissionAttempted(pending)) continue
      const operations = (next.native_answer_operations ?? []).filter(op => op.question_id === registration.question_id && op.operation_id.startsWith('terminal:'))
      if (!registration.questions.every(binding => operations.some(op => op.answers.some(answer => answer.question_id === binding.question.id)))) continue
      // The same state lock fences HTTP admission, so an in-flight submission
      // is never mistaken for a question that stayed on this machine.
      const withdrawn = terminateCodexQuestions({ ...next,
        pending: pendingList(next).filter(item => item !== pending),
        native_answer_operations: (next.native_answer_operations ?? []).filter(op => op.question_id !== registration.question_id),
      }, new Set([registration.question_id]))
      next = rememberQuestionState({ ...withdrawn, codex_question_bindings: (withdrawn.codex_question_bindings ?? []).map(item =>
        item.question_id === registration.question_id ? { ...item, terminal_answered: true as const } : item) }, pending, 'withdrawn')
    }
    return next
  })
  for (const operation of readSessionState(sessionId, ctx.env).native_answer_operations ?? []) {
    if (!operation.operation_id.startsWith('terminal:') || operation.acknowledgement !== undefined ||
        !isDeepStrictEqual(operation.service_identity, service)) continue
    try {
      const resolved = resolveNativeAnswerOperation(owner, ctx.env, operation, state => {
        const registration = state.codex_question_bindings?.find(item => item.question_id === operation.question_id && item.terminated !== true)
        return registration?.confirmed_request_id === undefined ? null : { requestId: registration.confirmed_request_id, service: registration.service_identity }
      })
      const { report } = await executeNativeAnswerOperation(owner, ctx.env, resolved, ctx.client)
      for (const other of report.other_submissions) {
        // Partial answers to different items do not conflict. Compare only overlap.
        const different = other.answers.some(answer => operation.answers.some(actual => actual.question_id === answer.question_id &&
          (!isDeepStrictEqual([...(actual.choice_ids ?? [])].sort(), [...answer.choice_ids].sort()) || (actual.text ?? null) !== answer.text)))
        if (different) conflict(sessionId, ctx.env, `${operation.submission_id}:${other.version_id}`, operation.question_id,
          { origin: 'terminal', answers: operation.answers }, { origin: other.origin, answers: other.answers })
      }
    } catch (error) {
      const permanent = error instanceof ApiCallError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
      ctx.log?.info('hook.gate', { hook: 'question-submission', stage: 'card-terminal-report', reason: permanent ? 'refused' : 'retry-later',
        error: error instanceof Error ? error.message : String(error) })
      if (permanent) {
        // Once the answer was reported, keep its receipt obligation; never erase
        // that accepted answer because acknowledgement temporarily failed.
        const state = readSessionState(sessionId, ctx.env)
        if (state.native_answer_operations?.some(op => op.submission_id === operation.submission_id && op.report !== undefined)) continue
        const pending = pendingList(state).find(item => item.question_id === operation.question_id)
        if (pending === undefined) continue
        updateSessionState(sessionId, ctx.env, current => ({ ...terminateCodexQuestions(current, new Set([operation.question_id])),
          native_answer_operations: (current.native_answer_operations ?? []).filter(op => op.submission_id !== operation.submission_id) }))
        parkForRetirement(sessionId, ctx.env, pending, 'answered_elsewhere')
        dropPendingQuestion(sessionId, ctx.env, pending)
      }
    }
  }
}
