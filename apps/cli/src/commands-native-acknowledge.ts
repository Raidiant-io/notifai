/**
 * The agent-written terminal-answer report an older skill still teaches.
 * Notifai records a terminal answer itself now, and an agent session that
 * started on an older CLI keeps sending this report after an update, so it
 * stays accepted: an answer Notifai already recorded is an idempotent success,
 * and anything it has not recorded is recorded exactly as before.
 */
import type { ReplyAnswerT } from '@raidiant/notifai-protocol'
import { isDeepStrictEqual } from 'node:util'
import { EXIT, authedClient, loadLoggedConfig, type CommandDeps } from './commands-core.js'
import { resolveActiveHarness } from './commands-harness-context.js'
import { admitBoundNativeAnswer, observeCodexQuestions } from './codex-question-bindings.js'
import { isClaudeRegistration } from './claude-question-bindings.js'
import { readNativeQuestionSnapshot } from './codex-native-turn.js'
import { findOwningSession, readSessionIncarnation, readSessionState, sessionHasEnded } from './hook-session-state.js'
import {
  NativeAnswerAlreadyRecorded, answersRecordedElsewhere, executeNativeAnswerOperation, prepareNativeAnswerOperation,
  resolveNativeAnswerOperation, type NativeAnswerOperation,
} from './native-answer-operation.js'
import { processIdentityLiveness } from './process-identity.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'

export interface NativeAcknowledgeFlags { operationId?: string; nativeAnswers?: string; text?: string; json?: boolean }

export const NATIVE_ANSWERS_DEPRECATION =
  'notifai: `acknowledge q_… --native-answers` is no longer needed. Notifai records a terminal answer itself; run nothing for it.'

export async function acknowledgeNativeAnswer(deps: CommandDeps, questionId: string, flags: NativeAcknowledgeFlags): Promise<number> {
  deps.io.err(NATIVE_ANSWERS_DEPRECATION)
  let operationSaved = false
  const fail = (message: string, exit: number = EXIT.failed): number => {
    const retry = operationSaved && flags.operationId !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(flags.operationId) && /^q_[A-Za-z0-9_-]+$/.test(questionId)
      ? `notifai acknowledge ${questionId} --operation-id ${flags.operationId} --json` : undefined
    const next = `Do not claim the native answer was synchronized or repeat dependent work. ${operationSaved ? 'Retry this saved operation' : 'Retry the original command with the actual answers, authored text and same operation ID'} after the reported problem is resolved; never register a replacement question.`
    if (flags.json) deps.io.out(JSON.stringify({ ok: false, question_id: questionId, message, ...(retry === undefined ? {} : { retry }), next }))
    else { deps.io.err(message); deps.io.err(next); if (retry !== undefined) deps.io.err(`Retry: ${retry}`) }
    return exit
  }
  if (flags.operationId === undefined) return fail('A native answer requires --operation-id; use a new label for a distinct submission and the same label on retry.', EXIT.usage)
  const now = deps.now ?? Date.now
  const active = resolveActiveHarness(deps.env, deps.cwd, now())
  const harness = active.active?.harness
  if (active.contested.length > 1 || (harness !== 'codex' && harness !== 'claude-code') || !active.active?.sessionId) {
    return fail('Native reporting requires the exact, unambiguous active Codex or Claude Code Agent Session.', EXIT.usage)
  }
  const sessionId = active.active.sessionId
  const localOwner = findOwningSession(questionId, deps.env)
  if (localOwner.ambiguous || localOwner.sessionId !== sessionId) return fail('This native question does not belong to the active Agent Session.', EXIT.usage)
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  if (incarnation === null || sessionHasEnded(sessionId, deps.env) || incarnation.harness_process === undefined ||
      processIdentityLiveness(incarnation.harness_process) !== 'alive') return fail('The native question owner is not running.')
  try {
    const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, sessionId })
    const authed = authedClient(deps, config)
    if (authed === null) return EXIT.auth
    const owner = { sessionId, key: incarnation.key, service: authed.service }
    const assertCurrentCredential = (): void => {
      const credential = deps.store.load()
      if (credential === null || credential.baseUrl !== owner.service.base_url || credential.machineId !== owner.service.machine_id) {
        throw new Error('The Approved Machine changed; retry from the original service and Machine.')
      }
    }
    const answers: unknown = flags.nativeAnswers === undefined ? undefined : JSON.parse(flags.nativeAnswers)
    if (answers !== undefined && !Array.isArray(answers)) return fail('--native-answers must be an array of actual answers with registered question/choice IDs.', EXIT.usage)
    const operationId = flags.operationId
    const itemId = (answer: unknown): unknown => typeof answer === 'object' && answer !== null ? (answer as { question_id?: unknown }).question_id : undefined
    // What Notifai has not recorded itself, or null when it recorded every reported item.
    const unrecorded = (): unknown[] | undefined | null => {
      const state = readSessionState(sessionId, deps.env)
      if (state.native_answer_operations?.some(op => op.question_id === questionId && op.operation_id === operationId)) return answers
      if (state.codex_question_bindings?.some(item => item.question_id === questionId && item.terminal_answered === true)) return null
      const elsewhere = answersRecordedElsewhere(state, questionId, operationId)
      if (elsewhere.size === 0) return answers
      if (answers === undefined) return null
      const remaining = answers.filter(answer => !elsewhere.has(itemId(answer) as string))
      return remaining.length === 0 ? null : remaining
    }
    const alreadyRecorded = (): number => {
      const next = 'Notifai already recorded this terminal answer, so the devices stop asking. Continue with the work it asks for; do not repeat work it already triggered.'
      if (flags.json) deps.io.out(JSON.stringify({ ok: true, question_id: questionId, operation_id: operationId, already_recorded: true, next }, null, 2))
      else { deps.io.out(`Notifai already recorded the terminal answer for ${questionId}.`); deps.io.out(next) }
      return EXIT.ok
    }
    let operation: NativeAnswerOperation | undefined
    for (let attempt = 0; operation === undefined; attempt++) {
      const remaining = unrecorded()
      if (remaining === null) return alreadyRecorded()
      try {
        operation = prepareNativeAnswerOperation(owner, deps.env, {
          questionId, operationId,
          ...(remaining === undefined ? {} : { answers: remaining as ReplyAnswerT[] }),
          ...(flags.text === undefined ? {} : { text: flags.text }),
        }, (state, actualAnswers) => {
          const elsewhere = answersRecordedElsewhere(state, questionId, operationId)
          if (actualAnswers.some(answer => elsewhere.has(answer.question_id))) throw new NativeAnswerAlreadyRecorded()
          return admitBoundNativeAnswer(state, questionId, owner.key, owner.service, actualAnswers)
        }, state => {
          const registration = state.codex_question_bindings?.find(item => item.question_id === questionId)
          // A Claude Code picker was verified by the hook that received it; there is no transcript to reread.
          if (harness === 'claude-code' || (registration !== undefined && isClaudeRegistration(registration))) return state
          const snapshot = readNativeQuestionSnapshot(registration?.transcript.file, sessionId, deps.env)
          return observeCodexQuestions(state, owner.key, snapshot)
        })
      } catch (error) {
        // Notifai recorded an item between the check and the locked admission.
        if (!(error instanceof NativeAnswerAlreadyRecorded) || attempt >= 2) throw error
      }
    }
    operationSaved = true
    const completedBeforeInvocation = operation.acknowledgement !== undefined
    if (operation.request_id === undefined) {
      // Preparation above is durable before recovery launches any HTTP. This
      // reuses ordinary admission/receipt promotion and its existing claim.
      const state = readSessionState(sessionId, deps.env)
      const pending = state.pending?.find(item => item.question_id === questionId)
      if (pending === undefined || !isDeepStrictEqual(pending.service_identity, owner.service)) {
        throw new Error('The original submission has no live registration or confirmed receipt; its saved native operation remains unresolved.')
      }
      assertCurrentCredential()
      ;(deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({ envelope: { session_id: sessionId, cwd: deps.cwd }, harness, purpose: 'submission' })
      // A bounded wait keeps offline/unavailable routing explicit. A retry
      // keeps this body, service key and original question; it never calls ask.
      const deadline = now() + 3_000
      for (let attempt = 0; attempt < 30 && now() < deadline; attempt++) {
        operation = prepareNativeAnswerOperation(owner, deps.env, { questionId, operationId: flags.operationId }, () => { throw new Error('Existing native operation disappeared.') })
        if (operation.request_id !== undefined) break
        await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(100)
      }
      operation = resolveNativeAnswerOperation(owner, deps.env, operation, current => {
        const bound = current.codex_question_bindings?.find(item => item.question_id === questionId)
        return bound?.confirmed_request_id === undefined ? null : { requestId: bound.confirmed_request_id, service: bound.service_identity }
      })
    }
    const result = await executeNativeAnswerOperation(owner, deps.env, operation, {
      recordHarnessAnswer: (id, body) => { assertCurrentCredential(); return authed.client.recordHarnessAnswer(id, body) },
      putAgentAcknowledgement: (id, body) => { assertCurrentCredential(); return authed.client.putAgentAcknowledgement(id, body) },
    })
    const next = completedBeforeInvocation
      ? 'This operation was already acknowledged. Do not repeat work it already triggered. Review the other submissions and pause further dependent action if answers conflict.'
      : 'The native answer and authored acknowledgement are recorded. Review other submissions before dependent action; if answers conflict, preserve both and clarify. Do not close the original question or remove its app answer watcher.'
    const output = { ok: true, question_id: questionId, operation_id: flags.operationId, request_id: operation.request_id,
      report: result.report, acknowledgement: result.acknowledgement, already_acknowledged: completedBeforeInvocation, next }
    if (flags.json) deps.io.out(JSON.stringify(output, null, 2))
    else {
      deps.io.out(`Native answer ${result.report.status} and Agent Acknowledgement recorded for ${questionId}.`)
      if (result.report.other_submissions.length > 0) deps.io.out(JSON.stringify({ other_submissions: result.report.other_submissions }, null, 2))
      deps.io.out(next)
    }
    return EXIT.ok
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
