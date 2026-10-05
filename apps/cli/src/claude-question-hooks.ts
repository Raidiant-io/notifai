/**
 * The Claude Code hooks that link a registered question to its picker.
 *
 * `PermissionRequest` runs while the picker is on screen. For a picker that
 * shows exactly one registered question set, this handler waits for the app
 * answer and returns it as the picker's own result; Claude Code then closes the
 * picker and the agent reads the answer as the tool's output. If the terminal
 * answers first Claude Code takes that answer and discards anything this
 * handler returns later. An unregistered picker is left alone.
 *
 * `PostToolUse` settles the other half. It confirms that an app answer
 * returned through the picker was the one Claude Code took, and carries the
 * acknowledgement instruction, or it tells the agent how to report the answer
 * the User gave in the terminal.
 *
 * Claude Code signals the waiting handler when the picker is dismissed or the
 * session ends, but not when the terminal answers or the User chooses to chat
 * instead. So the wait watches local state, which `PostToolUse`, `Stop` and
 * the next prompt all update.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CLAUDE_QUESTION_TOOL,
  claudePickerAnswers,
  claudeTerminalAnswers,
  isClaudeRegistration,
  matchClaudePicker,
  observeClaudePicker,
} from './claude-question-bindings.js'
import { CodexControlNotSent } from './codex-native-control.js'
import type { CodexQuestionRegistration } from './codex-question-bindings.js'
import { makeClient, type CommandDeps } from './commands-core.js'
import type { ServiceIdentity } from './credentials.js'
import { acknowledgementContext, answersContext } from './hook-acknowledgements.js'
import {
  pendingList,
  readSessionIncarnation,
  readSessionState,
  sessionHasEnded,
  updateSessionState,
} from './hook-session-state.js'
import type { AnsweredPending, HookEnvelope, SessionState } from './hook-types.js'
import { TRANSPORT_LIMIT } from './injection-render.js'
import type { Logger } from './logging.js'
import { currentProcessIdentity, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { readAttendantLease } from './session-attendant-state.js'
import type { DeliveryLease } from './session-delivery.js'
import { drainSessionInputs, type NativeInputAnswers } from './session-inputs.js'

/** How often the waiting handler rereads local state. */
export const CLAUDE_PICKER_POLL_MS = 500

/** How long a staged answer may fail to hand over before the ordinary route takes it. */
export const CLAUDE_PICKER_HANDOVER_MS = 15_000

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

/** Whether a live handler is waiting to return this session's app answer through a picker. */
export function claudePickerHolds(state: SessionState): boolean {
  const picker = state.claude_picker
  if (picker === undefined || processIdentityLiveness(picker.waiter) === 'gone') return false
  const waiting = state.waiting_answers ?? []
  return waiting.length > 0 && waiting.every((answer) => answer.pending.question_id === picker.question_id)
}

/** The picker was resolved or abandoned some other way: stop any handler still waiting on it. */
export function closeClaudePicker(sessionId: string, env: NodeJS.ProcessEnv): void {
  if (readSessionState(sessionId, env).claude_picker === undefined) return
  updateSessionState(sessionId, env, withoutPicker)
}

/**
 * An app answer that was returned through a picker and never confirmed by its
 * tool result, as context for the next prompt. Read once.
 */
export function takeOwedClaudePickerAnswer(sessionId: string, env: NodeJS.ProcessEnv): string | null {
  if (readSessionState(sessionId, env).claude_picker_presented === undefined) return null
  let context: string | null = null
  updateSessionState(sessionId, env, (state) => {
    if (state.claude_picker_presented === undefined) return state
    context = state.claude_picker_presented.context
    const next = { ...state }
    delete next.claude_picker_presented
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
  const answersFor = (answer: AnsweredPending, state: SessionState): Record<string, string> | null => {
    const registration = registrationOf(state, input.questionId)
    return registration === undefined || registration.owner_key !== input.ownerKey || !mine(state)
      ? null
      : claudePickerAnswers(registration, answer, input.service)
  }
  return {
    eligible: (answer, state) => answersFor(answer, state) !== null,
    prepare: async (answer, state) => {
      const answers = answersFor(answer, state)
      if (answers === null) return null
      const reply = answer.reply
      const validate = (latest: SessionState) => ({
        state: latest,
        valid: isDeepStrictEqual(answersFor(answer, latest), answers),
      })
      return {
        presentation: {
          kind: 'claude-question',
          request_id: answer.pending.request_id!,
          question_id: input.questionId,
          replies: [{ reply_id: reply.reply_id, seq: reply.seq }],
          owner_key: input.ownerKey,
          incarnation: input.lease?.incarnation ?? input.incarnation,
          generation: input.lease?.generation ?? 0,
          service_identity: input.service,
          answers_sha256: createHash('sha256').update(JSON.stringify(answers)).digest('hex'),
        },
        validate,
        write: async (mayWrite) => {
          if (!input.serviceCurrent()) throw new CodexControlNotSent('The Approved Machine changed before the picker answer was returned')
          let valid = false
          updateSessionState(input.sessionId, input.env, (latest) => {
            valid = validate(latest).valid && mayWrite()
            if (!valid) return latest
            // Kept until the tool result confirms Claude Code took this answer.
            return {
              ...latest,
              claude_picker_presented: {
                question_id: input.questionId,
                request_id: answer.pending.request_id!,
                answers,
                context: answersContext([answer], pendingList(latest).length),
                receipt: acknowledgementContext([answer]) + TRANSPORT_LIMIT,
                at: input.wall(),
              },
            }
          })
          if (!valid) throw new CodexControlNotSent('The picker closed before the answer was returned')
          input.out(pickerDecision(input.toolInput, answers))
        },
        close: () => undefined,
      }
    },
  }
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
 */
export async function claudePermissionRequest(
  deps: CommandDeps,
  envelope: HookEnvelope,
  logger: Logger,
  seams: ClaudePickerSeams = {},
): Promise<'answered' | 'left-to-terminal' | 'not-bound'> {
  const sessionId = envelope.session_id
  if (envelope.tool_name !== CLAUDE_QUESTION_TOOL || sessionId === undefined || envelope.agent_id !== undefined) return 'not-bound'
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  const writer = currentProcessIdentity()
  if (incarnation === null || writer === null || sessionHasEnded(sessionId, deps.env) ||
      incarnation.harness_process === undefined || processIdentityLiveness(incarnation.harness_process) !== 'alive') return 'not-bound'
  const now = deps.now ?? Date.now
  let questionId: string | null = null
  updateSessionState(sessionId, deps.env, (state) => {
    const match = matchClaudePicker(state, incarnation.key, envelope.tool_input)
    if (match === null || match.ordinary_only === true) return state
    questionId = match.question_id
    return {
      ...observeClaudePicker(state, match.question_id, envelope.tool_use_id),
      claude_picker: { question_id: match.question_id, opened_at: now(), waiter: writer },
    }
  })
  if (questionId === null) return 'not-bound'
  const bound: string = questionId
  logger.info('hook.gate', { hook: 'permission-request', reason: 'proceeding', question_id: bound, stage: 'picker-waiting' })

  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const monotonic = seams.monotonic ?? (() => performance.now())
  const parentAlive = seams.parentAlive ?? (() => processIdentityLiveness(incarnation.harness_process!) === 'alive')
  let stopped = false
  void seams.signalled?.then(() => { stopped = true })
  const release = (): void => {
    updateSessionState(sessionId, deps.env, (state) =>
      state.claude_picker?.question_id === bound && sameProcess(state.claude_picker.waiter, writer) ? withoutPicker(state) : state)
  }
  const leave = (stage: string): 'left-to-terminal' => {
    release()
    logger.info('hook.gate', { hook: 'permission-request', reason: 'proceeding', question_id: bound, stage })
    return 'left-to-terminal'
  }

  let stagedSince: number | null = null
  for (;;) {
    if (stopped) return leave('picker-dismissed')
    if (sessionHasEnded(sessionId, deps.env) || !parentAlive()) return leave('session-ended')
    const state = readSessionState(sessionId, deps.env)
    // Another hook resolved the picker: the terminal answered, the turn moved on, or a newer picker opened.
    if (state.claude_picker?.question_id !== bound || !sameProcess(state.claude_picker.waiter, writer)) {
      logger.info('hook.gate', { hook: 'permission-request', reason: 'proceeding', question_id: bound, stage: 'picker-resolved-elsewhere' })
      return 'left-to-terminal'
    }
    const registration = registrationOf(state, bound)
    if (registration === undefined || registration.terminated === true || registration.ordinary_only === true) return leave('question-closed')
    const waiting = state.waiting_answers?.find((answer) => answer.pending.question_id === bound)
    if (waiting === undefined) {
      // An accepted answer leaves the pending list a moment before it is
      // staged for presentation; in between it is neither, and still coming.
      const accepted = state.accepted?.answers.some((answer) => answer.pending.question_id === bound) === true
      if (accepted) {
        stagedSince ??= monotonic()
        if (monotonic() - stagedSince >= CLAUDE_PICKER_HANDOVER_MS) return leave('handover-timed-out')
      } else if (!pendingList(state).some((pending) => pending.question_id === bound)) {
        return leave('question-settled')
      } else {
        stagedSince = null
      }
    } else {
      const credential = deps.store.load()
      const service = credential === null ? null : { base_url: credential.baseUrl, machine_id: credential.machineId }
      // An answer the picker cannot carry belongs to the ordinary route at once.
      if (credential === null || service === null || claudePickerAnswers(registration, waiting, service) === null) {
        return leave('answer-needs-ordinary-route')
      }
      stagedSince ??= monotonic()
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
        const drained = await drainSessionInputs({
          lease,
          mayWrite,
          nativeOnly: true,
          nativeAnswers: pickerPresentation({
            sessionId, env: deps.env, lease, incarnation: incarnation.incarnation, ownerKey: incarnation.key,
            questionId: bound, toolInput: envelope.tool_input,
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
          logger.info('hook.gate', { hook: 'permission-request', reason: 'answered', question_id: bound, stage: 'picker-answered' })
          return 'answered'
        }
      }
      if (monotonic() - stagedSince >= CLAUDE_PICKER_HANDOVER_MS) return leave('handover-timed-out')
    }
    await sleep(CLAUDE_PICKER_POLL_MS)
  }
}

function additionalContext(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
}

/**
 * `PostToolUse` for `AskUserQuestion`: the picker has an answer. Writes at
 * most one context line telling the agent what that answer obliges.
 */
export function claudePostToolUse(deps: CommandDeps, envelope: HookEnvelope, logger: Logger): void {
  const sessionId = envelope.session_id
  if (envelope.tool_name !== CLAUDE_QUESTION_TOOL || sessionId === undefined || envelope.agent_id !== undefined) return
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  if (incarnation === null) return
  const given = typeof envelope.tool_response === 'object' && envelope.tool_response !== null
    ? (envelope.tool_response as { answers?: unknown }).answers
    : undefined
  let context: string | null = null
  let stage = 'unbound'
  updateSessionState(sessionId, deps.env, (state) => {
    if (state.claude_picker === undefined && state.claude_picker_presented === undefined &&
        matchClaudePicker(state, incarnation.key, envelope.tool_input) === null) return state
    const next = withoutPicker(state)
    const presented = next.claude_picker_presented
    if (presented !== undefined) {
      delete next.claude_picker_presented
      const taken = typeof given === 'object' && given !== null &&
        Object.entries(presented.answers).every(([title, value]) => (given as Record<string, unknown>)[title] === value)
      if (taken) {
        stage = 'app-answer-confirmed'
        context = `Notifai — that answer came from the user's device, for request ${presented.request_id}.${presented.receipt}`
      } else {
        // Claude Code took the terminal's answer instead; the device answer is still the User's.
        stage = 'app-answer-beside-terminal'
        context = `${presented.context} The picker was answered in the terminal at the same moment. Both answers are the user's own; if they differ, ask which one governs before acting on either.`
      }
      return next
    }
    const registration = matchClaudePicker(next, incarnation.key, envelope.tool_input)
    if (registration === null) return next
    stage = 'terminal-answer'
    const answers = claudeTerminalAnswers(registration, envelope.tool_response)
    const typed = answers === null || answers.some((answer) => answer.text !== undefined)
    const reported = typed ? `'<actual answers JSON>'` : `'${JSON.stringify(answers)}'`
    context = `Notifai — the user answered registered question ${registration.question_id} in the terminal picker. ` +
      'Before any work that depends on it, record that answer so their devices stop asking: ' +
      `\`notifai acknowledge ${registration.question_id} --operation-id native-1 --native-answers ${reported} --text <text>\` ` +
      'with text saying what concrete work the answer sets in motion.' +
      (typed ? ' Fill in the answers you actually read, using the registered question and choice ids, or the typed text.' : '')
    return next
  })
  logger.info('hook.gate', { hook: 'post-tool-use', reason: 'proceeding', stage })
  if (context !== null) deps.io.out(additionalContext(context))
}
