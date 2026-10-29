/**
 * The Claude Code hooks that make a question picker a device question.
 *
 * `PermissionRequest` runs while the picker is on screen. The handler links a
 * picker `notifai ask --wait` handed back to the question `ask` registered, or
 * refuses one that is not exactly it (`claude-picker-handback.ts`). Otherwise
 * it registers the picker's own questions for the User's devices, or links the
 * picker to the equal question this session already has open (the duplicate
 * guard in `question-guard.ts`). It then waits for the device answer and
 * returns it as the picker's own result; Claude Code then
 * closes the picker and the agent reads the answer as the tool's output. If
 * the terminal answers first Claude Code takes that answer and discards
 * anything this handler returns later. When the picker cannot reach devices
 * (not signed in, question routing off, a shape the devices cannot show) the
 * handler logs why and leaves the picker to the terminal, which always works.
 *
 * `PostToolUse` settles the other half. It confirms that a device answer
 * returned through the picker was the one Claude Code took, and carries the
 * acknowledgement instruction, or it records a terminal answer as the native
 * answer so the devices stop asking.
 *
 * Claude Code signals the waiting handler when the picker is cancelled: Esc,
 * the session ending, or (by its source) a Remote Control dialog expiry; on
 * 2.1.308 no `PostToolUse` follows. It sends no signal when the terminal
 * answers, when the picker auto-continues while the User is away, or when the
 * User chooses to chat instead; the first two run `PostToolUse` at once. A
 * cancellation says nothing about which, so the handler only marks the picker
 * cancelled and `PostToolUse` settles it from the picker's result: an
 * auto-continue is not an answer and the device question stays open; a
 * choice, typed text or notes are a terminal answer; anything else closes
 * without an answer and withdraws the device question. With no `PostToolUse`
 * within `CLAUDE_PICKER_CANCEL_SETTLE_MS`, the session owner withdraws it.
 * Otherwise the wait watches local state, which `PostToolUse`, `Stop` and the
 * next prompt all update.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { LifecycleEndState } from '@raidiant/notifai-protocol'
import {
  CLAUDE_PICKER_TURN,
  CLAUDE_QUESTION_TOOL,
  claudePickerAnswers,
  claudePickerUnanswered,
  claudeQuestionAnswered,
  claudeTerminalAnswers,
  isClaudeRegistration,
  pickerDigest,
  pickerForm,
  pickerHeading,
  pickerQuestions,
  pickerRefusal,
  reserveClaudeQuestion,
  type PickerQuestion,
} from './claude-question-bindings.js'
import {
  decideHandBack,
  handBackHolds,
  handBackShown,
  pickerSource,
  withoutHandBack,
  withoutHandBacks,
} from './claude-picker-handback.js'
import { ApiCallError } from './client.js'
import { CodexControlNotSent } from './codex-native-control.js'
import { admitBoundNativeAnswer, terminateCodexQuestions, type CodexQuestionRegistration } from './codex-question-bindings.js'
import { buildAskDraft } from './commands-ask.js'
import { makeClient, type CommandDeps } from './commands-core.js'
import { claudeHookSourcePid } from './commands-harness-context.js'
import { resolveDraftInvocation } from './commands-send-support.js'
import { loadConfig } from './config.js'
import { projectBinding, projectDisabled } from './project-enablement.js'
import type { ServiceIdentity } from './credentials.js'
import { acknowledgementContext, answerResumptionContext, answersContext, askerContext } from './hook-acknowledgements.js'
import { registerQuestion, type RegisteredQuestion } from './hook-lifecycle.js'
import { dropPendingQuestion, questionSubmissionAttempted } from './hook-question-state.js'
import { parkForRetirement, retireQueuedQuestions } from './hook-question-retirement.js'
import {
  pendingList,
  readSessionIncarnation,
  readSessionState,
  sessionHasEnded,
  updateSessionState,
} from './hook-session-state.js'
import type { AnsweredPending, HookContext, HookEnvelope, SessionState } from './hook-types.js'
import { TRANSPORT_LIMIT, quoted } from './injection-render.js'
import type { Logger } from './logging.js'
import {
  executeNativeAnswerOperation,
  hasSettledNativeAnswer,
  prepareNativeAnswerOperation,
  resolveNativeAnswerOperation,
  type NativeOperationOwner,
} from './native-answer-operation.js'
import { currentProcessIdentity, processIdentityLiveness, processStartTime, type ProcessIdentity } from './process-identity.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import { readAttendantLease } from './session-attendant-state.js'
import type { DeliveryLease } from './session-delivery.js'
import { drainSessionInputs, type NativeInputAnswers } from './session-inputs.js'

/** How often the waiting handler rereads local state. */
export const CLAUDE_PICKER_POLL_MS = 500

/** How long a staged answer may fail to hand over before the ordinary route takes it. */
export const CLAUDE_PICKER_HANDOVER_MS = 15_000

/** The native answer operation a terminal answer is recorded under. One picker, one terminal answer. */
export const CLAUDE_TERMINAL_OPERATION = 'terminal'

/** What the User's devices show for a picker answered in the terminal. */
export const CLAUDE_TERMINAL_ACKNOWLEDGEMENT = 'Answered in the agent session.'

/**
 * How long a cancelled picker waits for the `PostToolUse` that says what its
 * result meant before the session owner withdraws its device question. Esc,
 * "Chat about this" and a denial by another hook run no `PostToolUse`.
 */
export const CLAUDE_PICKER_CANCEL_SETTLE_MS = 5_000

/**
 * Context the agent reads beside a picker that Claude Code continued while the
 * User was away (`askUserQuestionTimeout`, `CLAUDE_AFK_TIMEOUT_MS`). Nobody
 * answered, so the device question stays open and its answer takes the
 * ordinary route. Claude Code's own result already told the agent to proceed
 * with its best judgement.
 */
export function claudePickerAutoContinued(questionId: string): string {
  return `Notifai: the User did not answer. ${questionId} stays open on their devices; an answer arrives as your next message, so check then that the work it answers still applies.`
}

/** What a picker's result says it was, from the fields Claude Code adds to it. */
export type ClaudePickerResult = 'auto-continued' | 'follow-up' | 'answered' | 'unanswered'

export function classifyClaudePickerResult(toolResponse: unknown): ClaudePickerResult {
  if (typeof toolResponse !== 'object' || toolResponse === null) return 'unanswered'
  const { afkTimeoutMs, followUp, answers, annotations, response } = toolResponse as Record<string, unknown>
  if (typeof afkTimeoutMs === 'number') return 'auto-continued'
  if (followUp === true || (typeof followUp === 'object' && followUp !== null)) return 'follow-up'
  if (typeof response === 'string' && response.trim() !== '') return 'answered'
  const titles = [answers, annotations].flatMap((part) => typeof part === 'object' && part !== null ? Object.keys(part) : [])
  if (titles.some((title) => claudeQuestionAnswered(toolResponse, title))) return 'answered'
  return 'unanswered'
}

function sameProcess(a: ProcessIdentity | undefined, b: ProcessIdentity): boolean {
  return a !== undefined && a.pid === b.pid && a.start === b.start
}

function registrationOf(state: SessionState, questionId: string): CodexQuestionRegistration | undefined {
  return state.codex_question_bindings?.find((item) => item.question_id === questionId && isClaudeRegistration(item))
}

function withoutPicker(state: SessionState): SessionState {
  if (state.claude_picker === undefined) return state
  const next = { ...state }
  delete next.claude_picker
  return next
}

function withoutCancelledPicker(state: SessionState): SessionState {
  if (state.claude_picker_cancelled === undefined) return state
  const next = { ...state }
  delete next.claude_picker_cancelled
  return next
}

/**
 * Whether this session's app answers are a picker's to return: a live handler
 * waits on their picker, or `ask` just handed back the picker that will.
 */
export function claudePickerHolds(state: SessionState, now: number = Date.now()): boolean {
  const waiting = state.waiting_answers ?? []
  if (waiting.length === 0) return false
  const picker = state.claude_picker
  const live = picker !== undefined && processIdentityLiveness(picker.waiter) !== 'gone'
  return waiting.every((answer) => (live && answer.pending.question_id === picker.question_id) ||
    handBackHolds(state, answer.pending.question_id, now))
}

/**
 * Retire a picker's device question that nobody answered: the picker closed
 * without one. An answer already on its way, or already recorded, is left to
 * its own route. Local and durable; the network close is queued.
 */
export function withdrawPickerQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  questionId: string,
  end: LifecycleEndState = 'expired',
): 'withdrawn' | 'retiring' | 'answered' | 'gone' {
  const state = readSessionState(sessionId, env)
  const entry = pendingList(state).find((item) => item.question_id === questionId)
  if (entry === undefined) return 'gone'
  if (state.waiting_answers?.some((answer) => answer.pending.question_id === questionId) ||
      state.accepted?.answers.some((answer) => answer.pending.question_id === questionId) ||
      state.native_answer_operations?.some((op) => op.question_id === questionId) ||
      hasSettledNativeAnswer(state, questionId)) return 'answered'
  const reason = end === 'answered_elsewhere' ? 'answered_in_terminal' : 'form_closed'
  if (entry.request_id === undefined) {
    const { retiring } = retireQueuedQuestions(sessionId, env, questionId, reason)
    return retiring.length > 0 ? 'retiring' : 'withdrawn'
  }
  updateSessionState(sessionId, env, (current) => terminateCodexQuestions(current, new Set([questionId])))
  try {
    parkForRetirement(sessionId, env, entry, end, reason)
  } catch {
    // Incomplete identifiers cannot be retired on a device; dropping the
    // local record still stops this session waiting on it.
  }
  dropPendingQuestion(sessionId, env, entry, 'retired', { reason })
  return 'retiring'
}

/** Start the detached owner that submits, retires and reports this session's questions. */
function launchSessionWork(deps: CommandDeps, sessionId: string, cwd: string | undefined, logger: Logger): void {
  try {
    ;(deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({
      envelope: { session_id: sessionId, cwd: cwd ?? deps.cwd }, harness: 'claude-code', purpose: 'submission',
    })
  } catch (err) {
    logger.error('cli.error', { kind: 'question_submission_launch', session: sessionId,
      message: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The turn moved on or the picker was dismissed: no picker of this session is
 * still on screen. A handler that was waiting on one stops when it next looks,
 * and the device question it was holding is withdrawn unless already answered.
 */
export function closeClaudePicker(
  deps: Pick<CommandDeps, 'env' | 'cwd' | 'spawnQuestionSettlement'>,
  sessionId: string,
  logger: Logger,
  cwd?: string,
): void {
  const state = readSessionState(sessionId, deps.env)
  // A hand-back waits only for the turn it was handed back in.
  if (state.claude_handbacks !== undefined) updateSessionState(sessionId, deps.env, withoutHandBacks)
  const picker = state.claude_picker
  if (picker !== undefined) {
    updateSessionState(sessionId, deps.env, (current) =>
      current.claude_picker?.question_id === picker.question_id ? withoutPicker(current) : current)
    const outcome = withdrawPickerQuestion(sessionId, deps.env, picker.question_id)
    logger.info('hook.gate', { hook: 'picker-close', reason: outcome, question_ids: [picker.question_id], stage: 'picker-closed' })
    if (outcome === 'retiring') launchSessionWork(deps as CommandDeps, sessionId, cwd, logger)
  }
  // A cancelled picker whose result never came: the turn moved on without it.
  const cancelled = state.claude_picker_cancelled
  if (cancelled !== undefined) {
    const outcome = settleUnansweredCancelledPicker(sessionId, deps.env, cancelled)
    logger.info('hook.gate', { hook: 'picker-close', reason: outcome, question_ids: [cancelled.question_id], stage: 'picker-cancelled-unsettled' })
    if (outcome === 'retiring') launchSessionWork(deps as CommandDeps, sessionId, cwd, logger)
  }
}

/** Withdraw the device question of a cancelled picker that no `PostToolUse` settled. */
function settleUnansweredCancelledPicker(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  cancelled: NonNullable<SessionState['claude_picker_cancelled']>,
): ReturnType<typeof withdrawPickerQuestion> | 'settled' {
  let mine = false
  updateSessionState(sessionId, env, (state) => {
    mine = state.claude_picker_cancelled?.question_id === cancelled.question_id && state.claude_picker_cancelled.at === cancelled.at
    return mine ? withoutCancelledPicker(state) : state
  })
  return mine ? withdrawPickerQuestion(sessionId, env, cancelled.question_id) : 'settled'
}

/**
 * The session owner's half of a cancelled picker: give its `PostToolUse` the
 * bound to say what the result meant, then withdraw the device question of a
 * picker still unsettled. Run after every launch the cancelling handler made.
 */
export async function settleCancelledClaudePicker(
  ctx: { env: NodeJS.ProcessEnv; log?: Logger | undefined; now?: (() => number) | undefined; sleep: (milliseconds: number) => Promise<void> },
  sessionId: string,
): Promise<void> {
  const cancelled = readSessionState(sessionId, ctx.env).claude_picker_cancelled
  if (cancelled === undefined) return
  const now = ctx.now ?? Date.now
  const remaining = cancelled.at + CLAUDE_PICKER_CANCEL_SETTLE_MS - now()
  if (remaining > 0) await ctx.sleep(remaining)
  const outcome = settleUnansweredCancelledPicker(sessionId, ctx.env, cancelled)
  if (outcome === 'settled') return
  ctx.log?.info('hook.gate', { hook: 'question-submission', reason: outcome, question_ids: [cancelled.question_id], stage: 'picker-cancelled-unsettled' })
}

/**
 * An app answer that was returned through a picker and never confirmed by its
 * tool result, or why a picker was closed without one, as context for the
 * next prompt. Read once.
 */
export function takeOwedClaudePickerAnswer(sessionId: string, env: NodeJS.ProcessEnv): string | null {
  const known = readSessionState(sessionId, env)
  if (known.claude_picker_presented === undefined && known.claude_picker_closed === undefined) return null
  let context: string | null = null
  updateSessionState(sessionId, env, (state) => {
    if (state.claude_picker_presented === undefined && state.claude_picker_closed === undefined) return state
    context = [state.claude_picker_presented?.context, state.claude_picker_closed?.context].filter(Boolean).join('\n\n')
    const next = { ...state }
    delete next.claude_picker_presented
    delete next.claude_picker_closed
    return next
  })
  return context
}

function pickerDecision(toolInput: unknown, answers: Record<string, string>): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { ...(toolInput as Record<string, unknown>), answers } },
    },
  })
}

/**
 * Context the agent reads beside a picker result of "no answer", when a
 * device answer exists that could not come back through the picker. It
 * carries none of the answer: the ordinary route delivers that exactly once,
 * with its acknowledgement, as soon as the session is free to take it, which
 * a picker left open would prevent.
 */
export const CLAUDE_PICKER_ANSWER_FOLLOWS =
  'Notifai — the user answered this question on their device instead. That answer could not come back through the picker, ' +
  'so it reaches you as your next message. End your turn now and act on the answer when it arrives.'

/**
 * Context the agent reads beside a picker result of "no answer" when the User
 * dismissed the question on a device. It says only that the question expired:
 * the agent learns nothing more about a dismissal.
 */
export const CLAUDE_PICKER_DISMISSED =
  'Notifai — this question has expired, so it will not be answered. Carry on without an answer to it.'

/**
 * Close the picker with no answer of its own. Claude Code reports that the
 * User did not answer, without an error; the context saying why follows from
 * `PostToolUse`, or with the next prompt if that never runs.
 */
function pickerClosedDecision(toolInput: unknown): string {
  return pickerDecision(toolInput, {})
}

/**
 * Refuse the picker before it shows. Claude Code closes it and gives the agent
 * the message as the tool's error; no `PostToolUse` runs, so nothing is left
 * to settle, and the registered question stays as it was.
 */
function pickerDeniedDecision(message: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
  })
}

type Registered = { questionId: string } | { reason: string; detail?: Record<string, unknown> }

/**
 * Register the picker's questions for the User's devices. Every failure is a
 * reason to leave the picker to the terminal, never to block the agent.
 */
function registerPickerQuestion(
  deps: CommandDeps,
  envelope: HookEnvelope,
  sessionId: string,
  ownerKey: string,
  picker: readonly PickerQuestion[],
  logger: Logger,
): Registered {
  const credential = deps.store.load()
  if (credential === null) return { reason: 'not-signed-in' }
  const service = { base_url: credential.baseUrl, machine_id: credential.machineId }
  const cwd = envelope.cwd ?? deps.cwd
  let config
  try {
    config = loadConfig({ cwd, env: deps.env, sessionId })
  } catch {
    return { reason: 'config-invalid' }
  }
  if (!config.ask_notifications.value) return { reason: 'question-notifications-off' }
  const shape = pickerForm(picker)
  if ('error' in shape) return { reason: 'unsupported-picker', detail: { shape: shape.error } }
  // A self-opened picker is titled by its heading, else its headers; with
  // neither, the draft takes the Agent Session name. Never the question.
  const heading = pickerHeading(envelope.tool_input)
  const form = heading === undefined ? shape : { ...shape, title: heading }
  // Hook stderr reaches nobody; a fallback-label heads-up has no reader here.
  const source = resolveDraftInvocation({ ...deps, cwd, io: { ...deps.io, err: () => undefined } }, {},
    { harness: 'claude-code', label: 'Claude Code', sessionId })
  if (!source.ok) return { reason: 'source-invalid' }
  const draft = buildAskDraft(config, form, {}, source.invocation, [], undefined, deps.env)
  if (!draft.ok) return { reason: 'invalid-draft', detail: { error: draft.error } }
  const presentation = draft.draft.presentation
  let registered: RegisteredQuestion
  try {
    registered = registerQuestion(
      sessionId,
      deps.env,
      {
        question: form.questions[0]!.text,
        title: presentation.title,
        summary: presentation.summary,
        service_identity: service,
        questions: form.questions,
        ...(presentation.body !== undefined ? { body: presentation.body } : {}),
        ...(draft.draft.project !== undefined ? { project: draft.draft.project } : {}),
        ...(draft.draft.source !== undefined ? { source: draft.draft.source } : {}),
      },
      (deps.now ?? Date.now)(),
      { owner_key: ownerKey, turn_id: CLAUDE_PICKER_TURN, service, picker: form.shown },
      { owner_key: ownerKey, machineStillMatches: () => {
        const current = deps.store.load()
        return current !== null && current.machineId === service.machine_id && current.baseUrl === service.base_url
      } },
    )
  } catch (err) {
    return { reason: 'registration-failed', detail: { error: err instanceof Error ? err.message : String(err) } }
  }
  const questionId = registered.question_id
  // Registration and its picker binding are one transaction; check anyway,
  // because an unbound device question would outlive the picker. A picker
  // linked to a question `ask` registered gets its binding the same way.
  if (registrationOf(readSessionState(sessionId, deps.env), questionId) === undefined) {
    if (registered.registered) withdrawPickerQuestion(sessionId, deps.env, questionId)
    return { reason: 'binding-missing' }
  }
  logger.info('ask.registered', {
    ok: true, origin: 'picker', session: sessionId, question_id: questionId, questions: form.questions.length,
    text_chars: form.questions[0]!.text.length, choices: form.questions[0]!.choices?.length ?? 0,
    ...(picker.every((question) => question.kind === undefined) ? {} : { kinds: picker.map((question) => question.kind ?? 'choice') }),
    has_body: form.body !== undefined, ...(registered.registered ? {} : { linked: true }),
  })
  return { questionId }
}

/**
 * The picker against this session's hand-backs (`claude-picker-handback.ts`):
 * bind it to the registration `ask` made, refuse it, or, with no hand-back
 * concerned, null for the ordinary registration. Signed out, nothing can reach
 * the devices, so the picker is never refused there.
 */
function linkHandedBackPicker(
  deps: CommandDeps,
  envelope: HookEnvelope,
  sessionId: string,
  ownerKey: string,
  picker: readonly PickerQuestion[],
  logger: Logger,
): Registered | 'refused' | null {
  const credential = deps.store.load()
  if (credential === null) return null
  const decision = decideHandBack(readSessionState(sessionId, deps.env), envelope.tool_input, picker)
  if (decision.kind === 'none') return null
  if (decision.kind === 'refuse') {
    deps.io.out(pickerDeniedDecision(decision.message))
    logger.info('hook.gate', { hook: 'permission-request', reason: decision.reason, question_ids: [decision.questionId], stage: 'picker-refused' })
    return 'refused'
  }
  const service = { base_url: credential.baseUrl, machine_id: credential.machineId }
  let linked: string | undefined
  updateSessionState(sessionId, deps.env, (state) => {
    const current = decideHandBack(state, envelope.tool_input, picker)
    if (current.kind !== 'link' || current.questionId !== decision.questionId) return state
    linked = current.questionId
    const bound = reserveClaudeQuestion(state, current.pending, {
      owner_key: ownerKey, turn_id: CLAUDE_PICKER_TURN, service, picker: handBackShown(picker, current.pending.questions!),
    })
    return withoutHandBack(bound, current.questionId)
  })
  if (linked === undefined || registrationOf(readSessionState(sessionId, deps.env), linked) === undefined) return { reason: 'binding-missing' }
  logger.info('hook.gate', { hook: 'permission-request', reason: 'linked', question_ids: [linked],
    stage: pickerSource(envelope.tool_input) === linked ? 'picker-handback-linked' : 'picker-handback-matched' })
  return { questionId: linked }
}

function pickerPresentation(input: {
  sessionId: string
  env: NodeJS.ProcessEnv
  lease: DeliveryLease | null
  incarnation: string
  ownerKey: string
  questionId: string
  toolInput: unknown
  writer: ProcessIdentity
  service: ServiceIdentity
  serviceCurrent(): boolean
  out(line: string): void
  wall(): number
}): NativeInputAnswers {
  const mine = (state: SessionState): boolean =>
    state.claude_picker?.question_id === input.questionId && sameProcess(state.claude_picker.waiter, input.writer)
  const registered = (state: SessionState): CodexQuestionRegistration | null => {
    const registration = registrationOf(state, input.questionId)
    return registration === undefined || registration.owner_key !== input.ownerKey ? null : registration
  }
  const answersFor = (answers: AnsweredPending[], state: SessionState): Record<string, string> | null => {
    const registration = registered(state)
    if (!mine(state) || answers.length !== 1 || registration === null) return null
    return claudePickerAnswers(registration, answers[0]!, input.service)
  }
  return {
    eligible: answer => answer.pending.question_id === input.questionId,
    group: (_answer, state) => {
      const answers = (state.waiting_answers ?? []).filter(answer => answer.pending.question_id === input.questionId)
      return answersFor(answers, state) === null ? null : answers
    },
    prepare: async () => null,
    prepareGroup: async (selected, state) => {
      const answers = answersFor(selected, state)
      if (answers === null) return null
      const validate = (latest: SessionState) => ({ state: latest, valid: isDeepStrictEqual(answersFor(selected, latest), answers) })
      const answer = selected[0]!
      return {
        presentation: {
          kind: 'claude-question',
          request_id: answer.pending.request_id!,
          question_id: answer.pending.question_id!,
          replies: answer.replies.map(reply => ({ reply_id: reply.reply_id, seq: reply.seq })),
          answers: [{ request_id: answer.pending.request_id!, question_id: answer.pending.question_id!,
            replies: answer.replies.map(reply => ({ reply_id: reply.reply_id, seq: reply.seq })),
          }],
          owner_key: input.ownerKey,
          incarnation: input.lease?.incarnation ?? input.incarnation,
          generation: input.lease?.generation ?? 0,
          service_identity: input.service,
          answers_sha256: createHash('sha256').update(JSON.stringify(answers)).digest('hex'),
        },
        validate,
        write: async mayWrite => {
          if (!input.serviceCurrent()) throw new CodexControlNotSent('The Approved Machine changed before the picker answer was returned')
          let valid = false
          updateSessionState(input.sessionId, input.env, latest => {
            valid = validate(latest).valid && mayWrite()
            if (!valid) return latest
            const skipped = claudePickerUnanswered(registered(latest)!, answers)
            return { ...latest, claude_picker_presented: {
              question_id: answer.pending.question_id!,
              request_id: answer.pending.request_id!,
              answers,
              context: answersContext(selected, pendingList(latest).length),
              receipt: (skipped.length === 0 ? '' : ` The user left ${skipped.map(quoted).join(' and ')} unanswered.`) +
                selected.map(entry => askerContext(entry.pending)).join('') + answerResumptionContext(selected) + acknowledgementContext(selected) + TRANSPORT_LIMIT,
              at: input.wall(),
            } }
          })
          if (!valid) throw new CodexControlNotSent('The picker closed before the answers were returned')
          input.out(pickerDecision(input.toolInput, answers))
        },
        close: () => undefined,
      }
    },
  }
}

/**
 * The Claude Code process showing this picker: the one that ran the hook.
 * Open in two places, a conversation has one primary host and standby places,
 * and each picker belongs to the place that shows it. A picker in a standby
 * place outlives a primary that exits first, so its waiter follows its own
 * process, never the session's host. Without a named source, the session's
 * host is the only process there is to follow.
 */
function pickerHost(deps: CommandDeps, sessionHost: ProcessIdentity): ProcessIdentity | null {
  const pid = claudeHookSourcePid(deps.env, deps.hookPlatform ?? process.platform)
  if (pid === undefined) return sessionHost
  const start = processStartTime(pid)
  return start === null ? null : { pid, start }
}

export interface ClaudePickerSeams {
  sleep?: (milliseconds: number) => Promise<void>
  /** Monotonic milliseconds. */
  monotonic?: () => number
  /** Resolves when Claude Code signalled this handler to stop. */
  signalled?: Promise<void>
  parentAlive?: () => boolean
}

/**
 * `PermissionRequest` for `AskUserQuestion`. Returns having written either one
 * decision or nothing; nothing leaves the picker to the terminal.
 *
 * Once the User answered on a device the picker never stays open: the hook
 * returns the answer as the picker's own result (`answered`), or, when it
 * cannot, closes the picker so the ordinary route can deliver it (`closed`).
 * A question the User dismissed on a device closes its picker too, saying so.
 * Only a picker nobody answered or dismissed on a device is left to the
 * terminal.
 *
 * A picker in a Project the User disabled stays in the terminal, as does a
 * subagent's: Claude Code does not give its subagents this tool, and
 * the device answer would be owed to the agent that owns the session's
 * Notification Requests, not to the subagent.
 */
export async function claudePermissionRequest(
  deps: CommandDeps,
  envelope: HookEnvelope,
  logger: Logger,
  seams: ClaudePickerSeams = {},
): Promise<'answered' | 'closed' | 'refused' | 'left-to-terminal' | 'not-bound'> {
  const sessionId = envelope.session_id
  if (envelope.tool_name !== CLAUDE_QUESTION_TOOL || sessionId === undefined) return 'not-bound'
  const terminalOnly = (reason: string, detail: Record<string, unknown> = {}): 'not-bound' => {
    logger.info('hook.gate', { hook: 'permission-request', reason, ...detail, stage: 'picker-terminal-only' })
    return 'not-bound'
  }
  if (envelope.agent_id !== undefined) return terminalOnly('subagent')
  // Nothing reaches the devices from a Project the User disabled.
  try {
    const cwd = envelope.cwd ?? deps.cwd
    const config = loadConfig({ cwd, env: deps.env, sessionId })
    if (projectDisabled(projectBinding(cwd, deps.env, config.project.value))) return terminalOnly('project-disabled')
    if (!config.ask_notifications.value) return terminalOnly('question-notifications-off')
  } catch {
    return terminalOnly('config-invalid')
  }
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  const writer = currentProcessIdentity()
  const host = incarnation?.harness_process === undefined ? null : pickerHost(deps, incarnation.harness_process)
  if (incarnation === null || writer === null || host === null || sessionHasEnded(sessionId, deps.env) ||
      processIdentityLiveness(host) !== 'alive') {
    return terminalOnly('session-not-live')
  }
  if (readSessionState(sessionId, deps.env).harness !== 'claude-code') return terminalOnly('session-not-admitted')
  if (deps.store.load() === null) return terminalOnly('not-signed-in')
  const picker = pickerQuestions(envelope.tool_input)
  const digest = pickerDigest(envelope.tool_input)
  const handedBack = linkHandedBackPicker(deps, envelope, sessionId, incarnation.key, picker ?? [], logger)
  if (handedBack === 'refused') return 'refused'
  const shape = picker === null ? null : pickerForm(picker)
  if (picker === null || digest === null || shape === null || 'error' in shape) {
    deps.io.out(pickerDeniedDecision(shape !== null && 'error' in shape ? pickerRefusal(shape.error)
      : 'Notifai cannot carry this picker to the User\'s devices. Run `notifai ask --wait` for this question instead: it registers the question and tells you how to wait.'))
    logger.info('hook.gate', { hook: 'permission-request', reason: 'unsupported-picker', stage: 'form-refused-unlinkable',
      ...(shape !== null && 'error' in shape ? { detail: shape.error } : {}) })
    return 'refused'
  }
  const registered = handedBack ?? registerPickerQuestion(deps, envelope, sessionId, incarnation.key, picker, logger)
  if ('reason' in registered) return terminalOnly(registered.reason, registered.detail)
  const questionId = registered.questionId
  const now = deps.now ?? Date.now
  let replaced: string | undefined
  updateSessionState(sessionId, deps.env, (state) => {
    replaced = state.claude_picker?.question_id
    return { ...state, claude_picker: { question_id: questionId, digest, opened_at: now(), waiter: writer } }
  })
  // A picker on screen means any earlier one is gone; its question goes with it.
  if (replaced !== undefined && replaced !== questionId) withdrawPickerQuestion(sessionId, deps.env, replaced)
  launchSessionWork(deps, sessionId, envelope.cwd, logger)
  logger.info('hook.gate', { hook: 'permission-request', reason: 'proceeding', question_ids: [questionId], stage: 'picker-waiting' })

  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const monotonic = seams.monotonic ?? (() => performance.now())
  const parentAlive = seams.parentAlive ?? (() => processIdentityLiveness(host) === 'alive')
  let stopped = false
  void seams.signalled?.then(() => { stopped = true })
  const holding = (state: SessionState): boolean =>
    state.claude_picker?.question_id === questionId && sameProcess(state.claude_picker.waiter, writer)
  const release = (): void => {
    updateSessionState(sessionId, deps.env, (state) => holding(state) ? withoutPicker(state) : state)
  }
  const leave = (stage: string, withdraw = false): 'left-to-terminal' => {
    release()
    const outcome = withdraw ? withdrawPickerQuestion(sessionId, deps.env, questionId) : undefined
    logger.info('hook.gate', { hook: 'permission-request', reason: outcome ?? 'proceeding', question_ids: [questionId], stage })
    if (outcome === 'retiring') launchSessionWork(deps, sessionId, envelope.cwd, logger)
    return 'left-to-terminal'
  }

  /**
   * A device answer exists that this picker cannot return: close the picker
   * instead of leaving it on screen. While it is open the session cannot take
   * the ordinary route's wake, so the answer would wait for someone at the
   * terminal. The device question stays answered and the answer stays queued.
   */
  const close = (context: string, reason: string, stage: string): 'closed' => {
    updateSessionState(sessionId, deps.env, (state) => {
      const next = holding(state) ? withoutPicker(state) : state
      return { ...next, claude_picker_closed: { question_id: questionId, digest, context } }
    })
    deps.io.out(pickerClosedDecision(envelope.tool_input))
    logger.info('hook.gate', { hook: 'permission-request', reason, question_ids: [questionId], stage })
    return 'closed'
  }
  const closeForAnswer = (stage: string): 'closed' => close(CLAUDE_PICKER_ANSWER_FOLLOWS, 'answer-follows', stage)
  const answerOnItsWay = (state: SessionState): boolean =>
    state.waiting_answers?.some(answer => answer.pending.question_id === questionId) === true ||
    state.accepted?.answers.some(answer => answer.pending.question_id === questionId) === true

  /**
   * Claude Code cancelled this handler: the picker resolved without its
   * decision. Esc and a Remote Control expiry look the same here; any result
   * the picker has is in its `PostToolUse`, so mark the picker cancelled and
   * let that hook settle it; the owner withdraws it if nothing does within the
   * bound.
   */
  const cancelled = (): 'left-to-terminal' => {
    updateSessionState(sessionId, deps.env, (state) => holding(state)
      ? { ...withoutPicker(state), claude_picker_cancelled: { question_id: questionId, digest, at: now() } }
      : state)
    logger.info('hook.gate', { hook: 'permission-request', reason: 'awaiting-tool-result', question_ids: [questionId], stage: 'picker-cancelled' })
    launchSessionWork(deps, sessionId, envelope.cwd, logger)
    return 'left-to-terminal'
  }

  let stagedSince: number | null = null
  for (;;) {
    if (stopped) return cancelled()
    // A session ending, or this handler's own timeout: the picker has no answer to wait for.
    if (sessionHasEnded(sessionId, deps.env) || !parentAlive()) return leave('session-ended', true)
    const state = readSessionState(sessionId, deps.env)
    // Another hook resolved the picker: the terminal answered, the turn moved on, or a newer picker opened.
    if (!holding(state)) {
      logger.info('hook.gate', { hook: 'permission-request', reason: 'proceeding', question_ids: [questionId], stage: 'picker-resolved-elsewhere' })
      return 'left-to-terminal'
    }
    const registration = registrationOf(state, questionId)
    // The User dismissed the question on a device: nobody will answer it there, so the session must not wait on it.
    if (registration?.dismissed === true && !answerOnItsWay(state)) return close(CLAUDE_PICKER_DISMISSED, 'expired', 'question-expired')
    if (registration === undefined || registration.terminated === true || registration.ordinary_only === true) {
      return answerOnItsWay(state) ? closeForAnswer('question-closed') : leave('question-closed')
    }
    if (!answerOnItsWay(state)) {
      // Nobody answered on a device: the question expired or was retired, and the terminal still can.
      if (!pendingList(state).some(pending => pending.question_id === questionId)) return leave('question-settled')
      stagedSince = null
      await sleep(CLAUDE_PICKER_POLL_MS)
      continue
    }
    stagedSince ??= monotonic()
    const waiting = state.waiting_answers?.find(answer => answer.pending.question_id === questionId)
    if (waiting !== undefined) {
      const credential = deps.store.load()
      const service = credential === null ? null : { base_url: credential.baseUrl, machine_id: credential.machineId }
      // Not this picker's answer to give (unclaimed, or another Machine's): it can only go the ordinary route.
      if (credential === null || service === null || claudePickerAnswers(registration, waiting, service) === null) {
        return closeForAnswer('answer-needs-ordinary-route')
      }
      const lease = readAttendantLease(sessionId, deps.env)
      if (lease === null || lease.incarnation === incarnation.incarnation) {
        const deadlineAt = now() + 2_000
        // The same ownership a foreground receive requires: this session's
        // current lease, or none at all when attendance never started.
        const mayWrite = (): boolean => {
          const current = readAttendantLease(sessionId, deps.env)
          if (stopped || now() >= deadlineAt || sessionHasEnded(sessionId, deps.env)) return false
          return lease === null
            ? current === null
            : current?.incarnation === lease.incarnation && current.generation === lease.generation
        }
        let written = false
        try {
          const drained = await drainSessionInputs({
            lease,
            mayWrite,
            nativeOnly: true,
            nativeAnswers: pickerPresentation({
              sessionId, env: deps.env, lease, incarnation: incarnation.incarnation, ownerKey: incarnation.key,
              questionId, toolInput: envelope.tool_input,
              writer, service, serviceCurrent: () => isDeepStrictEqual(deps.store.load(), credential),
              out: (line) => { written = true; deps.io.out(line) }, wall: now,
            }),
            sequencer: {
              sessionId, env: deps.env, writer, log: logger,
              client: makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`, {
                timeoutMs: 750, deadlineAt, now,
              }),
              monotonic, wall: now, recoveryDeadline: monotonic() + 500,
              sleep: async (ms) => { if (now() < deadlineAt) await sleep(Math.min(ms, Math.max(0, deadlineAt - now()))) },
            },
            // Never reached: a native-only drain writes through the picker or not at all.
            write: () => undefined,
          })
          if (drained && written) {
            logger.info('hook.gate', { hook: 'permission-request', reason: 'answered', question_ids: [questionId], stage: 'picker-answered' })
            return 'answered'
          }
        } catch (err) {
          // The decision is already on its way to Claude Code: a second one would never be read.
          if (written) return 'answered'
          logger.info('hook.gate', { hook: 'permission-request', reason: 'retry', question_ids: [questionId], stage: 'picker-handover-failed',
            error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    // Staged and still not handed over, or still being staged: stop holding the session.
    if (monotonic() - stagedSince >= CLAUDE_PICKER_HANDOVER_MS) return closeForAnswer('handover-timed-out')
    await sleep(CLAUDE_PICKER_POLL_MS)
  }
}

function additionalContext(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
}

/**
 * Record the terminal's answer to a picker's device question as its native
 * answer, so the devices stop asking and show what was chosen. A question that
 * never left this machine is withdrawn instead. Local only: the detached
 * session owner sends the report.
 */
function recordTerminalAnswer(
  deps: CommandDeps,
  sessionId: string,
  ownerKey: string,
  questionId: string,
  toolResponse: unknown,
): string {
  const state = readSessionState(sessionId, deps.env)
  const registration = registrationOf(state, questionId)
  const entry = pendingList(state).find(item => item.question_id === questionId)
  if (registration === undefined || entry === undefined) return 'question-gone'
  if (!questionSubmissionAttempted(entry)) {
    return withdrawPickerQuestion(sessionId, deps.env, questionId, 'answered_elsewhere')
  }
  const answers = claudeTerminalAnswers(registration, toolResponse)
  if (answers === null) return withdrawPickerQuestion(sessionId, deps.env, questionId, 'answered_elsewhere')
  try {
    prepareNativeAnswerOperation(
      { sessionId, key: ownerKey, service: registration.service_identity }, deps.env,
      { questionId, operationId: CLAUDE_TERMINAL_OPERATION, answers, text: CLAUDE_TERMINAL_ACKNOWLEDGEMENT },
      (current, actual) => admitBoundNativeAnswer(current, questionId, ownerKey, registration.service_identity, actual),
    )
  } catch {
    return withdrawPickerQuestion(sessionId, deps.env, questionId, 'answered_elsewhere')
  }
  return 'native-answer-recorded'
}

/**
 * `PostToolUse` for `AskUserQuestion`: the picker has a result. Writes at most
 * one context line telling the agent what that result obliges. A result that
 * is not an answer (an auto-continue while the User was away) leaves the
 * device question open; a request for another round, or no answer at all,
 * withdraws it.
 */
export function claudePostToolUse(deps: CommandDeps, envelope: HookEnvelope, logger: Logger): void {
  const sessionId = envelope.session_id
  if (envelope.tool_name !== CLAUDE_QUESTION_TOOL || sessionId === undefined || envelope.agent_id !== undefined) return
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  if (incarnation === null) return
  const given = typeof envelope.tool_response === 'object' && envelope.tool_response !== null
    ? (envelope.tool_response as { answers?: unknown }).answers
    : undefined
  const digest = pickerDigest(envelope.tool_input)
  const result = classifyClaudePickerResult(envelope.tool_response)
  let context: string | null = null
  let stage = 'unbound'
  let settled: string | undefined
  updateSessionState(sessionId, deps.env, (state) => {
    const presented = state.claude_picker_presented
    if (presented !== undefined) {
      const next = withoutPicker(state)
      delete next.claude_picker_presented
      const taken = typeof given === 'object' && given !== null &&
        Object.entries(presented.answers).every(([title, value]) => (given as Record<string, unknown>)[title] === value)
      if (taken) {
        stage = 'app-answer-confirmed'
        context = `Notifai — that answer came from the user's device, for request ${presented.request_id}.${presented.receipt}`
      } else {
        // Claude Code took the terminal's answer instead; the device answer is still the User's.
        stage = 'app-answer-beside-terminal'
        context = `${presented.context} The picker was also answered in the conversation at the same moment. If the two answers differ, ask which one governs before acting on either.`
      }
      return next
    }
    const closed = state.claude_picker_closed
    if (closed !== undefined && closed.digest === digest) {
      const next = { ...state }
      delete next.claude_picker_closed
      stage = 'picker-closed-context'
      context = closed.context
      return next
    }
    // The picker this result belongs to: still held, or cancelled and waiting for this result.
    const picker = state.claude_picker?.digest === digest ? state.claude_picker
      : state.claude_picker_cancelled?.digest === digest ? state.claude_picker_cancelled : undefined
    if (picker === undefined) return state
    settled = picker.question_id
    stage = `picker-${result}`
    return withoutCancelledPicker(withoutPicker(state))
  })
  let outcome: string | undefined
  if (settled !== undefined) {
    switch (result) {
      case 'auto-continued':
        // Not an answer: the question stays open and its answer takes the ordinary route.
        context = claudePickerAutoContinued(settled)
        outcome = 'question-stays-open'
        break
      case 'answered':
        outcome = recordTerminalAnswer(deps, sessionId, incarnation.key, settled, envelope.tool_response)
        break
      default:
        // Another round was asked for, or the picker closed with nothing: the User is at the terminal.
        outcome = withdrawPickerQuestion(sessionId, deps.env, settled)
    }
    if (outcome === 'native-answer-recorded' || outcome === 'retiring') launchSessionWork(deps, sessionId, envelope.cwd, logger)
  }
  logger.info('hook.gate', { hook: 'post-tool-use', reason: outcome ?? 'proceeding', stage,
    ...(settled === undefined ? {} : { question_ids: [settled] }) })
  if (context !== null) deps.io.out(additionalContext(context))
}

/**
 * Send the native reports that terminal answers left for this session, from
 * the detached session owner. A report the service refuses for good retires
 * the question instead, so its devices stop asking either way; anything else
 * stays saved for the next owner to retry.
 */
export async function reportClaudeTerminalAnswers(ctx: Pick<HookContext, 'client' | 'env' | 'log'>, sessionId: string): Promise<void> {
  const state = readSessionState(sessionId, ctx.env)
  const incarnation = readSessionIncarnation(sessionId, ctx.env)
  if (incarnation === null || sessionHasEnded(sessionId, ctx.env)) return
  for (const operation of state.native_answer_operations ?? []) {
    if (operation.operation_id !== CLAUDE_TERMINAL_OPERATION || operation.acknowledgement !== undefined) continue
    const registration = registrationOf(state, operation.question_id)
    if (registration === undefined) continue
    const owner: NativeOperationOwner = { sessionId, key: incarnation.key, service: operation.service_identity }
    if (operation.request_id === undefined && registration.confirmed_request_id === undefined) continue
    try {
      const resolved = resolveNativeAnswerOperation(owner, ctx.env, operation, current => {
        const bound = registrationOf(current, operation.question_id)
        return bound?.confirmed_request_id === undefined ? null : { requestId: bound.confirmed_request_id, service: bound.service_identity }
      })
      await executeNativeAnswerOperation(owner, ctx.env, resolved, ctx.client)
      ctx.log?.info('hook.gate', { hook: 'question-submission', reason: 'reported', question_ids: [operation.question_id], stage: 'picker-terminal-reported' })
    } catch (err) {
      const permanent = err instanceof ApiCallError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)
      ctx.log?.info('hook.gate', { hook: 'question-submission', reason: permanent ? 'refused' : 'retry-later',
        question_ids: [operation.question_id], stage: 'picker-terminal-report-failed',
        error: err instanceof Error ? err.message : String(err) })
      if (!permanent) continue
      updateSessionState(sessionId, ctx.env, current => ({ ...current,
        native_answer_operations: (current.native_answer_operations ?? []).filter(op => op !== operation &&
          !(op.question_id === operation.question_id && op.operation_id === operation.operation_id)) }))
      withdrawPickerQuestion(sessionId, ctx.env, operation.question_id, 'answered_elsewhere')
    }
  }
}
