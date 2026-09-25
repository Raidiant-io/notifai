/** Agent-authored acknowledgement submission and local obligation clearing. */
import {
  AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  SESSION_MESSAGE_ID_PREFIX,
} from '@raidiant/notifai-protocol'
import { resolveCommandSession } from './command-session.js'
import {
  EXIT,
  authedClient,
  loadLoggedConfig,
  log,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import type { ApiClient } from './client.js'
import { clearAcknowledgementObligation } from './hook-acknowledgements.js'

/**
 * Record the one Agent Acknowledgement associated with a replied-to request
 * (`req_…`) or a Session Message handed into the session (`sm_…`), dispatched
 * by the identifier's prefix.
 *
 * `--text` is optional here because the acknowledgement is not: an account may
 * turn the agent's written reply off, and the receipt must still be recorded so
 * the user sees that an agent read the answer. The service holds the account's
 * snapshot, so it — not this process — decides whether text was owed.
 */
export async function acknowledgeCommand(
  deps: CommandDeps,
  id: string,
  flags: { text?: string; json?: boolean },
): Promise<number> {
  const requestId = id
  const subject = id.startsWith(SESSION_MESSAGE_ID_PREFIX) ? 'message' : 'request'
  const text = flags.text?.trim() ?? ''
  if (flags.text !== undefined && text.length === 0) {
    deps.io.err('--text must contain non-whitespace text. Drop it to acknowledge without text.')
    return EXIT.usage
  }
  if (text.length > AGENT_ACKNOWLEDGEMENT_MAX_LENGTH) {
    deps.io.err(
      `--text must be at most ${AGENT_ACKNOWLEDGEMENT_MAX_LENGTH} characters after trimming. Shorten it: an acknowledgement is a receipt, not a report.`,
    )
    return EXIT.usage
  }

  const logger = log(deps)
  const lifecycleSession = resolveCommandSession(deps, requestId)
  const config = loadLoggedConfig(deps, {
    cwd: deps.cwd,
    env: deps.env,
    ...(lifecycleSession === null ? {} : { sessionId: lifecycleSession.sessionId }),
  })
  logger.info('acknowledgement.attempted', {
    ...(subject === 'message' ? { message_id: id } : { request_id: id }),
    characters: text.length,
  })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  if (subject === 'message') {
    return acknowledgeMessage(deps, authed.client, id, text, flags.json === true, lifecycleSession?.sessionId ?? null)
  }
  try {
    const result = await authed.client.putAgentAcknowledgement(
      requestId,
      text.length > 0 ? { text } : {},
    )
    const output = {
      request_id: requestId,
      outcome: result.status,
      acknowledgement: result.agent_acknowledgement,
      agent_acknowledgement_required: true,
    }
    logger.info('acknowledgement.outcome', {
      request_id: requestId,
      outcome: result.status,
      text_chars: result.agent_acknowledgement.text.length,
      created_at: result.agent_acknowledgement.created_at,
      agent_acknowledgement_required: true,
    })
    if (lifecycleSession !== null) {
      clearAcknowledgementObligation(lifecycleSession.sessionId, deps.env, requestId)
    }
    if (flags.json) deps.io.out(JSON.stringify(output, null, 2))
    else {
      deps.io.out(
        `Agent Acknowledgement ${result.status} for ${requestId} at ${result.agent_acknowledgement.created_at}.`,
      )
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err, { operation: 'agent_acknowledgement', request_id: requestId })
  }
}

async function acknowledgeMessage(
  deps: CommandDeps,
  client: ApiClient,
  messageId: string,
  text: string,
  json: boolean,
  sessionId: string | null,
): Promise<number> {
  const logger = log(deps)
  try {
    const result = await client.putSessionMessageAcknowledgement(messageId, text.length > 0 ? { text } : {})
    logger.info('acknowledgement.outcome', {
      message_id: messageId,
      outcome: result.status,
      text_chars: result.agent_acknowledgement.text.length,
      created_at: result.agent_acknowledgement.created_at,
    })
    if (sessionId !== null) clearAcknowledgementObligation(sessionId, deps.env, messageId)
    if (json) {
      deps.io.out(
        JSON.stringify(
          { message_id: messageId, outcome: result.status, acknowledgement: result.agent_acknowledgement },
          null,
          2,
        ),
      )
    } else {
      deps.io.out(
        `Agent Acknowledgement ${result.status} for ${messageId} at ${result.agent_acknowledgement.created_at}.`,
      )
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err, { operation: 'session_message_acknowledgement', message_id: messageId })
  }
}
