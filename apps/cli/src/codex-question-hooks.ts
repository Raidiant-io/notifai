/** Codex's structured card is the source of its device question. */
import { QUESTION_TEXT_MAX_LENGTH } from '@raidiant/notifai-protocol'
import { fit, fitChoiceLabels, oneLine, plainTextMarkdown, withoutRecommendedSuffix } from './claude-question-bindings.js'
import { matchCodexCardHandback } from './codex-card-handback.js'
import { buildAskDraft, buildQuestions } from './commands-ask.js'
import { makeClient, type CommandDeps } from './commands-core.js'
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

/** Route-neutral: a device answer closes the card only where Notifai reaches the thread's own server. */
const CARD_ANSWERS = 'Notifai records a terminal answer itself. A device answer arrives with its own acknowledgement command; run it before dependent work.'

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
  recordTurnStart(sessionId, deps.env, owner.key, envelope.turn_id)
  const service = { machine_id: credential.machineId, base_url: credential.baseUrl }
  const handback = matchCodexCardHandback(sessionId, deps.env, envelope, owner.key, service, accepted, (deps.now ?? Date.now)())
  // A card that is not a hand-back of this turn is a card of its own. It is
  // never refused; ask's still-open registration stays on the devices.
  const unmatched = handback?.reason === 'mismatch' ? handback.registration.question_id : undefined
  if (handback !== null && unmatched === undefined) {
    const id = handback.registration.question_id
    const delivery = handback.registration.confirmed_request_id === undefined
      ? 'Device delivery is not confirmed yet.' : 'Device registration is confirmed.'
    if (handback.reason !== undefined) {
      // Only this question's own exact card, after the question settled: it
      // would ask the User again what they already answered or let expire.
      if (accepted) return null
      const reason = handback.reason === 'expired' ? `${id} has expired without an answer: carry on without it, or ask in the conversation.`
        : handback.reason === 'answered' ? `${id} was already answered; it arrives as your next input. Do not ask it again.`
        : `${id} was already answered, and that answer was delivered to you. Do not ask it again.`
      deps.io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
      return null
    }
    const context = `This card uses the existing registration ${id}. ${delivery} Never also notifai ask it. ${CARD_ANSWERS}`
    if (accepted) return context
    deps.io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }))
    return null
  }
  const unsupported = (detail?: string) => {
    logger.info('hook.gate', { stage: 'form-terminal-only', form: 'codex-card', reason: 'unsupported-shape', session: sessionId,
      ...(detail === undefined ? {} : { detail }) })
    return null
  }
  const raw = (envelope.tool_input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(entry => typeof entry?.title === 'string' &&
      (entry.options === undefined || (Array.isArray(entry.options) && entry.options.every((option: unknown) => typeof option === 'string'))))) return unsupported()
  // A card question or option can be longer than a device holds. As for a
  // Claude Code picker, the device gets a shortened one and the Body keeps the
  // full wording; the card itself opens unchanged.
  const texts = raw.map(entry => fit(entry.title as string, QUESTION_TEXT_MAX_LENGTH))
  if (raw.some(entry => entry.options !== undefined && new Set(entry.options).size !== entry.options.length)) {
    return unsupported('duplicate-option')
  }
  const recommended = raw.map(entry => (entry.options as string[] | undefined)?.map(withoutRecommendedSuffix))
  const choices = raw.map((entry, index) => {
    const options = entry.options as string[] | undefined
    if (options === undefined) return undefined
    const markers = recommended[index]!
    const singleRecommendation = markers.filter(label => label !== null).length === 1
    const labels = fitChoiceLabels(options.map((option, position) => singleRecommendation ? markers[position] ?? option : option))
    return labels.map((label, position) => ({ label,
      ...(singleRecommendation && markers[position] !== null ? { recommended: true } : {}),
    }))
  })
  // As for a picker, only a question the device shows shortened appears in the
  // Body: its full wording with its lines kept, and its options when shortened.
  const sections = raw.flatMap((entry, index) => {
    const title = entry.title as string
    const options = (entry.options as string[] | undefined) ?? []
    const reworded = texts[index] !== oneLine(title) || /[\r\n]/u.test(title.trim())
    const shortenedOptions = options.some((option, position) => choices[index]![position]!.label !== option)
    if (!reworded && !shortenedOptions) return []
    return [[
      ...(raw.length > 1 ? [`**${texts[index]}**`] : []),
      ...(reworded ? [plainTextMarkdown(title)] : []),
      ...(shortenedOptions ? [options.map(option => `- ${oneLine(option)}`).join('\n')] : []),
    ].join('\n\n')]
  })
  const body = sections.length === 0 ? undefined : sections.join('\n\n')
  // A card has no heading and no headers, so the draft titles it by the Agent Session name.
  const form = buildQuestions({ form: JSON.stringify({ summary: texts[0],
    questions: raw.map((_entry, index) => ({ text: texts[index], ...(choices[index] === undefined ? {} : { choices: choices[index] }) })),
    ...(body === undefined ? {} : { body }) }) }, undefined,
  { selfOpened: true })
  if (!form.ok) return unsupported(form.error)
  const source = resolveDraftInvocation({ ...deps, cwd }, {}, { harness: 'codex', label: 'Codex', sessionId })
  if (!source.ok) return null
  const draft = buildAskDraft(config, form, {}, source.invocation, [], undefined, deps.env)
  if (!draft.ok) return null
  recordTurnStart(sessionId, deps.env, owner.key, envelope.turn_id)
  if (currentCodexTurn(sessionId, deps.env, owner.key) !== envelope.turn_id) return null
  // A device answer closes the card when Notifai reaches the server that owns
  // the thread. Without that route the card still registers, so the question
  // shows on both ends: the answer reaches the agent at its next tool call (or
  // by a wake when idle) and Codex clears the card when the turn ends.
  const supported = await makeClient(deps, service.base_url, `Bearer nfm_${credential.machineId}.${credential.secret}`, { timeoutMs: 1500 })
    .compatibility().then(value => value === null ? null : value.server_capabilities?.includes('harness_answers') === true, () => null)
  // A failed probe is not a capability withdrawal. Both leave a new native
  // card usable, without creating a competing ordinary device question.
  if (supported !== true) {
    logger.info('hook.gate', { stage: 'form-terminal-only', form: 'codex-card', session: sessionId,
      reason: supported === null ? 'compatibility-unavailable' : 'harness-answers-unsupported' })
    return null
  }
  if (!accepted) {
    // Do not publish before acceptance. A device answer must never race a
    // card's creation or a later foreign PreToolUse denial.
    deps.io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: 'Notifai registers this card on the User\'s devices once Codex accepts it; never also notifai ask it.' } }))
    return null
  }
  const shown = raw.map((entry, index) => ({ title: entry.title,
    labels: Object.fromEntries((form.questions[index]!.choices ?? []).map((choice, position) => [choice.id, entry.options[position]])) }))
  const { question_id: questionId, registered: fresh } = registerQuestion(sessionId, deps.env, {
    question: form.questions[0]!.text, title: draft.draft.presentation.title, summary: draft.draft.presentation.summary,
    questions: form.questions, service_identity: service,
    ...(draft.draft.presentation.body === undefined ? {} : { body: draft.draft.presentation.body }),
    ...(draft.draft.project === undefined ? {} : { project: draft.draft.project }),
    ...(draft.draft.source === undefined ? {} : { source: draft.draft.source }),
  }, (deps.now ?? Date.now)(), { owner_key: owner.key, turn_id: envelope.turn_id, service,
    card: { call_id: envelope.tool_use_id, shown, allow: true, accepted: true } }, { owner_key: owner.key, machineStillMatches: () => {
    const current = deps.store.load()
    return current?.machineId === service.machine_id && current.baseUrl === service.base_url
  } })
  const registration = readSessionState(sessionId, deps.env).codex_question_bindings?.find(item => item.question_id === questionId)
  if (registration === undefined || registration.owner_key !== owner.key || cardOwner(deps, envelope)?.key !== owner.key ||
      currentCodexTurn(sessionId, deps.env, owner.key) !== envelope.turn_id) return null
  const linked = !fresh
  // An equal question another card of this session already carries keeps that card.
  if (registration.card_call_id !== envelope.tool_use_id) {
    return `This card repeats ${questionId}, which another card already carries to the User's devices; an answer arrives once, for that question.`
  }
  try {
    ;(deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({ envelope: { session_id: sessionId, cwd }, harness: 'codex', purpose: 'submission' })
  } catch (error) {
    logger.error('cli.error', { kind: 'question_submission_launch', session: sessionId, question_id: questionId,
      message: error instanceof Error ? error.message : String(error) })
  }
  logger.info('ask.registered', { session: sessionId, question_id: questionId, origin: 'codex-card', questions: form.questions.length,
    ...(linked ? { linked: true } : {}) })
  const queued = linked
    ? `This card is the question already registered as ${questionId}. Never also notifai ask it. Keep using the native card. ${CARD_ANSWERS}`
    : `Notifai queued this card as ${questionId} for device registration; delivery is not confirmed yet. Never also notifai ask it. ` +
      `Keep using the native card. ${CARD_ANSWERS}`
  return unmatched === undefined || unmatched === questionId ? queued
    : `${queued} It is not the card notifai ask handed back for ${unmatched}, which stays open on its own: open that card unchanged, ` +
      `or close it with notifai close ${unmatched} if this card replaces it.`
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
