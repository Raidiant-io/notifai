/** Explicit question closure across remote and local lifecycle state. */
import { resolveCommandSession } from './command-session.js'
import {
  EXIT,
  authedClient,
  loadLoggedConfig,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import { acknowledgementCommand, printAcknowledgementStatus } from './commands-send-support.js'
import { parkForRetirement } from './hook-question-retirement.js'
import { dropPendingQuestion, withdrawUnpushedQuestions } from './hook-question-state.js'
import { readSessionState } from './hook-session-state.js'
import { type PendingQuestion } from './hook-types.js'

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

  const local = await closeLocalQuestion(deps, requestId!, flags.json === true)
  if (local !== null) return local

  const lifecycleSession = resolveCommandSession(deps, requestId!)
  const config = loadLoggedConfig(deps, {
    cwd: deps.cwd,
    env: deps.env,
    ...(lifecycleSession === null ? {} : { sessionId: lifecycleSession.sessionId }),
  })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const response = await authed.client.closeReplies(requestId!)
    forgetClosedQuestion(deps, requestId!)
    if (flags.json) {
      deps.io.out(
        JSON.stringify(
          {
            ...response,
            acknowledgement_command: acknowledgementCommand(
              response.request_id,
              response.agent_acknowledgement_required,
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
      if (response.replies.length > 0) printAcknowledgementStatus(deps, response)
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

/**
 * Retire this session's outstanding questions, including registrations the
 * Stop hook has not pushed yet. Unpushed entries only exist locally: dropping
 * them is the whole retirement. Live ones still need their reply window closed.
 */
async function closePendingQuestions(deps: CommandDeps, json: boolean): Promise<number> {
  const lifecycleSession = resolveCommandSession(deps)
  if (lifecycleSession === null) {
    deps.io.err('No active session pointer is available in this directory.')
    return EXIT.noReply
  }
  const sessionId = lifecycleSession.sessionId
  const pending = readSessionState(sessionId, deps.env).pending ?? []
  if (pending.length === 0) {
    if (json) {
      deps.io.out(
        JSON.stringify({ session_id: sessionId, withdrawn: [], closed: [] }, null, 2),
      )
    } else {
      deps.io.err(`Session ${sessionId} has no registered question pending.`)
    }
    return EXIT.noReply
  }

  const withdrawn = withdrawUnpushedQuestions(sessionId, deps.env)
  const live = (readSessionState(sessionId, deps.env).pending ?? []).filter(
    (entry): entry is PendingQuestion & { request_id: string } =>
      entry.request_id !== undefined,
  )

  const closed: string[] = []
  if (live.length > 0) {
    const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, sessionId })
    const authed = authedClient(deps, config)
    if (!authed) return EXIT.auth
    for (const entry of live) {
      try {
        await authed.client.closeReplies(entry.request_id)
        parkClosedQuestion(sessionId, deps.env, entry)
        dropPendingQuestion(sessionId, deps.env, entry)
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

/**
 * Close one outstanding question by the stable id `notifai ask` returned, or
 * by a request id already on a device. Unpushed entries only exist locally.
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
    dropPendingQuestion(sessionId, deps.env, entry, 'withdrawn')
    const output = {
      session_id: sessionId,
      withdrawn: [
        {
          question: entry.question,
          ...(entry.question_id === undefined ? {} : { question_id: entry.question_id }),
        },
      ],
      closed: [] as string[],
    }
    if (json) deps.io.out(JSON.stringify(output, null, 2))
    else {
      deps.io.out(
        `Withdrew unpushed question ${entry.question_id ?? id} so a later Stop will not send it.`,
      )
    }
    return EXIT.ok
  }

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, sessionId })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const response = await authed.client.closeReplies(entry.request_id)
    parkClosedQuestion(sessionId, deps.env, entry)
    dropPendingQuestion(sessionId, deps.env, entry)
    if (json) {
      deps.io.out(
        JSON.stringify(
          {
            ...response,
            question_id: entry.question_id,
            acknowledgement_command: acknowledgementCommand(
              response.request_id,
              response.agent_acknowledgement_required,
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
      if (response.replies.length > 0) printAcknowledgementStatus(deps, response)
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
  dropPendingQuestion(sessionId, deps.env, entry)
}

function parkClosedQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  entry: PendingQuestion,
): void {
  try {
    parkForRetirement(sessionId, env, entry, 'expired')
  } catch {
    // Incomplete identifiers cannot be retired on a device; dropping the
    // local record is still the right way to stop a later Stop from waiting.
  }
}
