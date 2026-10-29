/** Explicit question closure across remote and local lifecycle state. */
import type { CloseRepliesResponse, ListRepliesResponse } from '@raidiant/notifai-protocol'
import { setTimeout as sleep } from 'node:timers/promises'
import { DEFAULT_TIMEOUT_MS, type ApiClient } from './client.js'
import { printReplies } from './commands-send.js'
import { resolveCommandSession } from './command-session.js'
import { terminateCodexQuestions } from './codex-question-bindings.js'
import {
  EXIT,
  authedClient,
  loadLoggedConfig,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import { acknowledgementCommand, printAcknowledgementStatus } from './commands-send-support.js'
import { parkForRetirement, retireQueuedQuestions } from './hook-question-retirement.js'
import { acquireClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { dropPendingQuestion, inspectQuestionState, rememberQuestionState } from './hook-question-state.js'
import { readSessionState, sessionStatePath, updateSessionState } from './hook-session-state.js'
import { type PendingQuestion } from './hook-types.js'

/**
 * An explicit close is a retirement: whatever replies it returns go to the
 * command's caller, never through a claimed hand-off, so they are not selected
 * for delivery. The printed response keeps its released shape.
 */
async function retireReplies(client: ApiClient, requestId: string): Promise<ListRepliesResponse> {
  const response: Partial<CloseRepliesResponse> & ListRepliesResponse = {
    ...(await client.closeReplies(requestId, 'retire')),
  }
  delete response.close_disposition
  delete response.delivered_reply_seq
  return response
}

/** Withdrawal stops future admission. This separate fence lets an attempt
 * already admitted finish before we close its remote identity. The state lock
 * must stay free while the submitter promotes its receipt and retires it.
 */
async function awaitSubmissionCompletion(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
  const file = `${sessionStatePath(sessionId, env)}.submission`
  const deadline = Date.now() + 3 * DEFAULT_TIMEOUT_MS
  for (;;) {
    const token = acquireClaimFile(file, {}, Date.now())
    if (token !== null) {
      releaseClaimFile(file, token)
      return
    }
    if (Date.now() >= deadline) throw new Error('Question submission is still in flight; retirement is saved. Retry close to confirm remote closure.')
    await sleep(25)
  }
}

function forgetRetirement(sessionId: string, env: NodeJS.ProcessEnv, requestId: string): void {
  updateSessionState(sessionId, env, state => {
    const retiring = (state.retiring ?? []).filter(entry => entry.request_id !== requestId)
    let next = state
    for (const question of state.question_history ?? []) {
      if (question.frozen_request_id === requestId) {
        next = rememberQuestionState(next, { question_id: question.question_id, request_id: requestId }, 'retired')
      }
    }
    if (next === state && retiring.length === (state.retiring ?? []).length) return state
    next = { ...next }
    if (retiring.length > 0) next.retiring = retiring
    else delete next.retiring
    return next
  })
}

async function closeAdmittedQuestions(
  deps: CommandDeps,
  sessionId: string,
  requestIds: string[],
): Promise<{ code: number; closed: string[] }> {
  if (requestIds.length === 0) return { code: EXIT.ok, closed: [] }
  try {
    await awaitSubmissionCompletion(sessionId, deps.env)
    const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, sessionId })
    const authed = authedClient(deps, config)
    if (!authed) return { code: EXIT.auth, closed: [] }
    const closed: string[] = []
    for (const requestId of requestIds) {
      await retireReplies(authed.client, requestId)
      forgetRetirement(sessionId, deps.env, requestId)
      closed.push(requestId)
    }
    return { code: EXIT.ok, closed }
  } catch (err) {
    return { code: reportError(deps, err), closed: [] }
  }
}

/** Retire a question so a late answer is rejected rather than silently lost. */
export async function closeCommand(
  deps: CommandDeps,
  requestId: string | undefined,
  flags: { json?: boolean; pending?: boolean } = {},
): Promise<number> {
  if (flags.pending === true && requestId !== undefined) {
    deps.io.err('Pass a question or request id or --pending, not both.')
    return EXIT.usage
  }
  if (flags.pending !== true && requestId === undefined) {
    deps.io.err('Pass a question or request id or --pending.')
    return EXIT.usage
  }

  if (flags.pending === true) {
    return closePendingQuestions(deps, flags.json === true)
  }

  const questionId = requestId!.startsWith('q_') ? requestId! : undefined
  if (questionId !== undefined) {
    const lookup = inspectQuestionState(questionId, deps.env)
    if (!lookup.found) {
      deps.io.err(lookup.ambiguous
        ? `Question ${questionId} appears in more than one local Agent Session; refusing to guess.`
        : `No local registration state exists for ${questionId}. Use the original request id if available.`)
      return EXIT.failed
    }
  }

  const bindingOwner = resolveCommandSession(deps, requestId!)
  if (bindingOwner !== null) revokeNativeBindings(bindingOwner.sessionId, deps.env, new Set([requestId!]))

  const local = await closeLocalQuestion(deps, requestId!, flags.json === true)
  if (local !== null) return local

  // Answer delivery removes the pending entry but retains its stable identity.
  // Re-read after local retirement: promotion or delivery may have raced it.
  if (questionId !== undefined) {
    const lookup = inspectQuestionState(questionId, deps.env)
    if (!lookup.found) {
      deps.io.err(`Cannot resolve question ${questionId} uniquely; use the original request id if available.`)
      return EXIT.failed
    }
    const question = lookup.question
    if (question.state === 'withdrawn' && question.submitted === false) {
      if (flags.json) deps.io.out(JSON.stringify(question, null, 2))
      else deps.io.out(`Question ${questionId} was already withdrawn without submission.`)
      return EXIT.ok
    }
    const resolved = question.request_id ?? question.frozen_request_id
    if (resolved === null) {
      deps.io.err(`Question ${questionId} has no remote request identity; inspect its status before retrying.`)
      return EXIT.failed
    }
    if (question.frozen_request_id !== null) {
      try { await awaitSubmissionCompletion(lookup.session_id, deps.env) }
      catch (err) { return reportError(deps, err) }
    }
    requestId = resolved
  }

  const lifecycleSession = resolveCommandSession(deps, requestId!)
  const config = loadLoggedConfig(deps, {
    cwd: deps.cwd,
    env: deps.env,
    ...(lifecycleSession === null ? {} : { sessionId: lifecycleSession.sessionId }),
  })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const response = await retireReplies(authed.client, requestId!)
    forgetClosedQuestion(deps, requestId!)
    if (lifecycleSession !== null) forgetRetirement(lifecycleSession.sessionId, deps.env, requestId!)
    if (flags.json) {
      deps.io.out(
        JSON.stringify(
          {
            ...response,
            ...(questionId === undefined ? {} : { question_id: questionId }),
            agent_acknowledgement_required: response.replies.length > 0 || response.agent_acknowledgement_required,
            acknowledgement_command: acknowledgementCommand(
              response.request_id,
              response.agent_acknowledgement_text_required,
              response.agent_acknowledgement,
              response.replies.length > 0,
            ),
          },
          null,
          2,
        ),
      )
    } else {
      deps.io.out(`Closed the reply window for ${requestId}.`)
      if (response.replies.length > 0) {
        printReplies(deps, response.replies)
        printAcknowledgementStatus(deps, response)
      }
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

/**
 * Retire this session's outstanding questions, including registrations the
 * Stop hook has not pushed yet. Preparations are withdrawn locally; admitted
 * attempts keep retirement debt. Live ones need their reply window closed.
 */
async function closePendingQuestions(deps: CommandDeps, json: boolean): Promise<number> {
  const lifecycleSession = resolveCommandSession(deps)
  if (lifecycleSession === null) {
    if (json) deps.io.out(JSON.stringify({ state: 'nothing_pending', session_id: null, withdrawn: [], closed: [] }))
    else deps.io.out('No active Agent Session has a registered question pending.')
    return EXIT.ok
  }
  const sessionId = lifecycleSession.sessionId
  const initial = readSessionState(sessionId, deps.env)
  const pending = initial.pending ?? []
  if (pending.length === 0 && (initial.retiring ?? []).length === 0) {
    if (json) {
      deps.io.out(
        JSON.stringify({ state: 'nothing_pending', session_id: sessionId, withdrawn: [], closed: [] }, null, 2),
      )
    } else {
      deps.io.err(`Session ${sessionId} has no registered question pending.`)
    }
    return EXIT.ok
  }

  const { withdrawn, retiring } = retireQueuedQuestions(sessionId, deps.env, undefined, 'closed')
  const admitted = await closeAdmittedQuestions(deps, sessionId,
    [...new Set([...(initial.retiring ?? []), ...retiring].map(entry => entry.request_id))])
  if (admitted.code !== EXIT.ok) return admitted.code
  let live: (PendingQuestion & { request_id: string })[] = []
  updateSessionState(sessionId, deps.env, state => {
    live = (state.pending ?? []).filter((entry): entry is PendingQuestion & { request_id: string } => entry.request_id !== undefined)
    return terminateCodexQuestions(state, new Set(live.flatMap(entry =>
      entry.question_id === undefined ? [entry.request_id] : [entry.question_id, entry.request_id])))
  })

  const closed: string[] = [...admitted.closed]
  if (live.length > 0) {
    const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, sessionId })
    const authed = authedClient(deps, config)
    if (!authed) return EXIT.auth
    for (const entry of live) {
      try {
        await retireReplies(authed.client, entry.request_id)
        parkClosedQuestion(sessionId, deps.env, entry)
        dropPendingQuestion(sessionId, deps.env, entry, 'retired', { reason: 'closed' })
        closed.push(entry.request_id)
      } catch (err) {
        return reportError(deps, err, { operation: 'close', request_id: entry.request_id })
      }
    }
  }

  const output = {
    session_id: sessionId,
    withdrawn: withdrawn.map((entry) => ({
      question: entry.question,
      ...(entry.question_id === undefined ? {} : { question_id: entry.question_id }),
    })),
    closed,
  }
  if (json) deps.io.out(JSON.stringify(output, null, 2))
  else {
    if (withdrawn.length > 0) {
      deps.io.out(
        withdrawn.length === 1
          ? 'Withdrew 1 unpushed question so a later Stop will not send it.'
          : `Withdrew ${withdrawn.length} unpushed questions so a later Stop will not send them.`,
      )
    }
    for (const requestId of closed) {
      deps.io.out(`Closed the reply window for ${requestId}.`)
    }
  }
  return EXIT.ok
}

/** Explicit cancellation revokes association locally even if the remote close
 * needs retry. Natural expiry only ends the app window, not the native form.
 */
function revokeNativeBindings(sessionId: string, env: NodeJS.ProcessEnv, ids: ReadonlySet<string>): void {
  updateSessionState(sessionId, env, state => terminateCodexQuestions(state, ids))
}

/**
 * Close one outstanding question by the stable id `notifai ask` returned, or
 * by a request id already on a device. Admission decides whether a queued
 * entry can be withdrawn silently or needs its reserved remote id retired.
 * Returns null when this directory's session has no matching registration, so
 * the caller can still close a live request id against the service.
 */
async function closeLocalQuestion(
  deps: CommandDeps,
  id: string,
  json: boolean,
): Promise<number | null> {
  const lifecycleSession = resolveCommandSession(deps, id)
  if (lifecycleSession === null) return null
  const sessionId = lifecycleSession.sessionId
  const entry = (readSessionState(sessionId, deps.env).pending ?? []).find(
    (candidate) => candidate.question_id === id || candidate.request_id === id,
  )
  if (entry === undefined) return null

  if (entry.request_id === undefined) {
    const { withdrawn, retiring } = retireQueuedQuestions(sessionId, deps.env, entry.question_id, 'closed')
    // Admission may have completed and promoted this entry after the first
    // read. Re-resolve it so the live close path owns that ordering.
    if (withdrawn.length === 0 && retiring.length === 0) {
      const current = (readSessionState(sessionId, deps.env).pending ?? []).find(
        (candidate) => candidate.question_id === id || candidate.request_id === id,
      )
      if (current?.request_id !== undefined) return closeLocalQuestion(deps, current.request_id, json)
      if (json) deps.io.out(JSON.stringify({ state: 'nothing_pending', question_id: id, withdrawn: [], closed: [] }))
      else deps.io.out('This question is no longer pending.')
      return EXIT.ok
    }
    const output = {
      session_id: sessionId,
      withdrawn: withdrawn.map((item) => ({
        question: item.question,
        ...(item.question_id === undefined ? {} : { question_id: item.question_id }),
      })),
      closed: [] as string[],
    }
    const admitted = await closeAdmittedQuestions(deps, sessionId, retiring.map(item => item.request_id))
    if (admitted.code !== EXIT.ok) return admitted.code
    output.closed = admitted.closed
    if (json) deps.io.out(JSON.stringify(output, null, 2))
    else {
      deps.io.out(
        retiring.length > 0
          ? `Closed the reply window for ${admitted.closed.join(', ')}.`
          : `Withdrew unpushed question ${entry.question_id ?? id} so a later Stop will not send it.`,
      )
    }
    return EXIT.ok
  }

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, sessionId })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const response = await retireReplies(authed.client, entry.request_id)
    parkClosedQuestion(sessionId, deps.env, entry)
    dropPendingQuestion(sessionId, deps.env, entry, 'retired', { reason: 'closed' })
    if (json) {
      deps.io.out(
        JSON.stringify(
          {
            ...response,
            agent_acknowledgement_required: response.replies.length > 0 || response.agent_acknowledgement_required,
            question_id: entry.question_id,
            acknowledgement_command: acknowledgementCommand(
              response.request_id,
              response.agent_acknowledgement_text_required,
              response.agent_acknowledgement,
              response.replies.length > 0,
            ),
          },
          null,
          2,
        ),
      )
    } else {
      deps.io.out(`Closed the reply window for ${entry.request_id}.`)
      if (response.replies.length > 0) {
        printReplies(deps, response.replies)
        printAcknowledgementStatus(deps, response)
      }
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err, { operation: 'close', request_id: entry.request_id })
  }
}

function forgetClosedQuestion(deps: CommandDeps, requestId: string): void {
  const lifecycleSession = resolveCommandSession(deps, requestId)
  if (lifecycleSession === null) return
  const sessionId = lifecycleSession.sessionId
  const entry = (readSessionState(sessionId, deps.env).pending ?? []).find(
    (candidate) => candidate.request_id === requestId,
  )
  if (entry === undefined) return
  parkClosedQuestion(sessionId, deps.env, entry)
  dropPendingQuestion(sessionId, deps.env, entry, 'retired', { reason: 'closed' })
}

function parkClosedQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  entry: PendingQuestion,
): void {
  try {
    parkForRetirement(sessionId, env, entry, 'expired', 'closed')
  } catch {
    // Incomplete identifiers cannot be retired on a device; dropping the
    // local record is still the right way to stop a later Stop from waiting.
  }
}
