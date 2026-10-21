/** Codex's structured card is the source of its device question. */
import { buildAskDraft, buildQuestions } from './commands-ask.js'
import { makeClient, type CommandDeps } from './commands-core.js'
import { connectCodexAnswerControl } from './codex-answer-control.js'
import { codexCardHooksReady } from './codex-card-capability.js'
import { resolveDraftInvocation } from './commands-send-support.js'
import { loadConfig } from './config.js'
import { registerQuestion } from './hook-lifecycle.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { HookEnvelope } from './hook-types.js'
import type { Logger } from './logging.js'
import { processIdentityLiveness } from './process-identity.js'
import { projectBinding, projectDisabled } from './project-enablement.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import { currentCodexTurn, recordTurnStart } from './session-attendant-state.js'

/** Only the same live root process may register or confirm its own card. */
function cardOwner(deps: CommandDeps, envelope: HookEnvelope) {
  const sessionId = envelope.session_id
  if (sessionId === undefined || envelope.agent_id !== undefined || envelope.agent_type !== undefined ||
      envelope.tool_name !== 'request_user_input_async' || !envelope.turn_id || !envelope.tool_use_id) return null
  const owner = readSessionIncarnation(sessionId, deps.env)
  return owner?.harness_process !== undefined && owner.harness_process.pid === Number(deps.env['NOTIFAI_HOOK_SOURCE_PID']) &&
    processIdentityLiveness(owner.harness_process) === 'alive' && !sessionHasEnded(sessionId, deps.env) &&
    readSessionState(sessionId, deps.env).harness === 'codex' ? owner : null
}

async function routeCard(deps: CommandDeps, envelope: HookEnvelope, logger: Logger, accepted: boolean): Promise<string | null> {
  const sessionId = envelope.session_id
  if (envelope.tool_name !== 'request_user_input_async' || sessionId === undefined ||
      envelope.agent_id !== undefined || envelope.agent_type !== undefined || !envelope.turn_id || !envelope.tool_use_id) return null
  const owner = cardOwner(deps, envelope)
  if (owner === null || !codexCardHooksReady(deps)) return null
  const cwd = envelope.cwd ?? deps.cwd
  const config = loadConfig({ cwd, env: deps.env, sessionId })
  if (projectDisabled(projectBinding(cwd, deps.env, config.project.value)) || !config.ask_notifications.value) return null
  const credential = deps.store.load()
  if (credential === null) return null
  const raw = (envelope.tool_input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(entry => typeof entry?.title === 'string' &&
      (entry.options === undefined || (Array.isArray(entry.options) && entry.options.every((option: unknown) => typeof option === 'string'))))) return null
  const form = buildQuestions({ form: JSON.stringify({ summary: raw[0].title,
    questions: raw.map(entry => ({ text: entry.title, ...(entry.options === undefined ? {} : { choices: entry.options }) })) }) }, undefined)
  if (!form.ok) return null
  const source = resolveDraftInvocation({ ...deps, cwd }, {}, { harness: 'codex', label: 'Codex', sessionId })
  if (!source.ok) return null
  const draft = buildAskDraft(config, form, {}, source.invocation, [])
  if (!draft.ok) return null
  const service = { machine_id: credential.machineId, base_url: credential.baseUrl }
  recordTurnStart(sessionId, deps.env, owner.key, envelope.turn_id)
  if (currentCodexTurn(sessionId, deps.env, owner.key) !== envelope.turn_id) return null
  const [supported, transport] = await Promise.all([
    makeClient(deps, service.base_url, `Bearer nfm_${credential.machineId}.${credential.secret}`, { timeoutMs: 1500 })
      .compatibility().then(value => value?.server_capabilities?.includes('harness_answers') === true, () => false),
    (deps.codexAnswerControl ?? connectCodexAnswerControl)(sessionId, envelope.turn_id, deps.env, performance.now() + 3000)
      .then(control => { if (control === null) return false; control.close(); return true }, () => false),
  ])
  const allow = supported && transport
  if (!accepted && allow) {
    // Do not publish before acceptance. A device answer must never race a
    // card's creation or a later foreign PreToolUse denial.
    deps.io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: 'Notifai registers this card on the User\'s devices once Codex accepts it; never also notifai ask it.' } }))
    return null
  }
  if (accepted && !allow) return null
  const shown = raw.map((entry, index) => ({ title: entry.title,
    labels: Object.fromEntries((form.questions[index]!.choices ?? []).map((choice, position) => [choice.id, entry.options[position]])) }))
  const questionId = registerQuestion(sessionId, deps.env, {
    question: form.questions[0]!.text, summary: draft.draft.presentation.summary, questions: form.questions, service_identity: service,
    ...(draft.draft.presentation.body === undefined ? {} : { body: draft.draft.presentation.body }),
    ...(draft.draft.project === undefined ? {} : { project: draft.draft.project }),
    ...(draft.draft.source === undefined ? {} : { source: draft.draft.source }),
  }, (deps.now ?? Date.now)(), { owner_key: owner.key, turn_id: envelope.turn_id, service,
    card: { call_id: envelope.tool_use_id, shown, allow, ...(accepted ? { accepted: true } : {}) } }, { owner_key: owner.key, machineStillMatches: () => {
    const current = deps.store.load()
    return current?.machineId === service.machine_id && current.baseUrl === service.base_url
  } })
  const registration = readSessionState(sessionId, deps.env).codex_question_bindings?.find(item => item.question_id === questionId)
  if (registration === undefined || registration.owner_key !== owner.key || cardOwner(deps, envelope)?.key !== owner.key ||
      currentCodexTurn(sessionId, deps.env, owner.key) !== envelope.turn_id) return null
  try {
    ;(deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({ envelope: { session_id: sessionId, cwd }, harness: 'codex', purpose: 'submission' })
  } catch (error) {
    logger.error('cli.error', { kind: 'question_submission_launch', session: sessionId, question_id: questionId,
      message: error instanceof Error ? error.message : String(error) })
  }
  logger.info('ask.registered', { session: sessionId, question_id: questionId, origin: 'codex-card', questions: form.questions.length })
  if (registration.card_allowed === true) {
    return `This card is registered as ${questionId} on the User's devices; never also notifai ask it. ` +
        'Notifai records a terminal answer itself. An answer from a device arrives in the card with its own acknowledgement command; run it before dependent work.'
  }
  const questionText = raw.map(entry => [entry.title, ...(entry.options ?? []).map((option: string) => `- ${option}`)].join('\n')).join('\n\n')
  deps.io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `The question is registered as ${questionId} on the User's devices instead of this card. Ask it in plain conversation text with these same choices and continue independent work; dependent work waits for the answer. Do not register it again with notifai ask. If the User answers in the conversation, run notifai close ${questionId} to retire the device question.\n\n${questionText}` } }))
  return null
}

/**
 * Codex runs this callback only for a card tool it offered, so it proves the
 * tool exists for this owner under this turn's model. `ask` points at the card
 * only with that proof; without it, `ask` registers an ordinary question.
 */
function observeCardTool(deps: CommandDeps, envelope: HookEnvelope): void {
  const owner = cardOwner(deps, envelope)
  const { model, transcript_path: transcript } = envelope
  if (owner === null || typeof model !== 'string' || model === '' || typeof transcript !== 'string') return
  updateSessionState(envelope.session_id!, deps.env, state => {
    const proof = state.codex_card_tool
    if (cardOwner(deps, envelope)?.key !== owner.key ||
        (proof?.key === owner.key && proof.model === model && proof.transcript_path === transcript)) return state
    return { ...state, codex_card_tool: { key: owner.key, model, transcript_path: transcript } }
  })
}

export async function codexPreToolUse(deps: CommandDeps, envelope: HookEnvelope, logger: Logger): Promise<void> {
  observeCardTool(deps, envelope)
  await routeCard(deps, envelope, logger, false)
}

/** Only a real accepted tool result can create a device-visible linked card. */
export async function codexCardPostToolUse(deps: CommandDeps, envelope: HookEnvelope, logger: Logger): Promise<string | null> {
  let response = envelope.tool_response
  if (typeof response === 'string') {
    try { response = JSON.parse(response) as unknown } catch { return null }
  }
  if (typeof response !== 'object' || response === null || (response as { accepted?: unknown }).accepted !== true) return null
  return routeCard(deps, envelope, logger, true)
}
