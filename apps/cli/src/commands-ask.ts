/** Validation and durable registration for the agent-facing ask command. */
import {
  CAPABILITIES_V1,
  QUESTION_TEXT_MAX_LENGTH,
  REPLY_MAX_QUESTIONS,
  validateDraft,
  type NotificationDraftT,
  type Platform,
  type QuestionT,
} from '@raidiant/notifai-protocol'
import { EXIT, authedClient, log, makeClient, type CommandDeps } from './commands-core.js'
import type { ServiceIdentity } from './credentials.js'
import { resolveAskingHarness } from './commands-harness-context.js'
import { codexSubagentShell } from './codex-subagent.js'
import {
  CODEX_FRESH_SESSION_USER_ACTION,
  CODEX_HOOK_APPROVAL_USER_ACTION,
  CODEX_STALE_STOP_DEFINITION_PROBLEM,
  CODEX_STOP_DEFINITION_NOT_SINGULAR_PROBLEM,
  activeQuestionRouteProblems,
} from './commands-hook-diagnostics.js'
import { resolveDraftInvocation, uploadImage } from './commands-send-support.js'
import { loadConfig, type CliConfig } from './config.js'
import { QuestionRegistrationChanged, registerQuestion, type RegisteredQuestion } from './hook-lifecycle.js'
import { captureCandidates, findOpenEqualQuestion } from './question-guard.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { PendingQuestion } from './hook-types.js'
import { CLAUDE_QUESTION_TOOL } from './claude-question-bindings.js'
import { CLAUDE_PICKER_MATCHER } from './hook-events.js'
import { handBackInput, recordHandBack, type ClaudePickerInput } from './claude-picker-handback.js'
import { processIdentityLiveness } from './process-identity.js'
import { connectCodexAnswerControl, type CodexAnswerUnavailable } from './codex-answer-control.js'
import { currentCodexQuestionContext, type NativeQuestionAdmission } from './codex-question-bindings.js'
import { hermesQuestionRouteReady } from './session-attendant-state.js'
import { codexRoutingTrustProblems, findInstallations, handlerEvent } from './install-hooks.js'
import { cardHandbackInput, cardShown } from './codex-card-handback.js'
import { CODEX_CARD_VERSION_FLOOR, codexCardHooksReady, codexCardToolOffered } from './codex-card-capability.js'
import { activeOpenclawGeneration } from './openclaw-session-access.js'
import { openclawGatewayReady } from './openclaw-gateway-readiness.js'
import { enableProjectUnlessDisabled, inferredProjectName, projectBinding, projectDisabled } from './project-enablement.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import { answerCannotReturnRemedy, heldAskWait, heldWaitRoute } from './commands-ask-wait.js'
import { opencodeHandBack } from './opencode-hand-back.js'
import {
  buildDraft,
  parseChoices,
  rejectAccidentalEscapedNewlines,
  slugify,
  validateMediaInputs,
  UNTITLED_FORM_TITLE,
  type ChoiceDescriptionInput,
  type ChoiceDetails,
  type DraftInvocation,
} from './send.js'
export interface AskFlags {
  /** Emit the registration and its turn obligation as one JSON object. */
  json?: boolean
  /**
   * Wait for the answer the way the agent would without Notifai. Where a
   * later answer can return to this Agent Session the agent ends its turn;
   * where none can, the command itself holds (`commands-ask-wait.ts`).
   */
  wait?: boolean
  /** The question's title: names the decision, as the `titles` guidance says. Always passed by current guidance. */
  title?: string
  choice?: string[]
  /** One-line consequence of each choice, attached to the `--choice` before it. */
  choiceDescription?: ChoiceDescriptionInput[]
  /** Exact label of the choice the agent recommends. */
  recommended?: string[]
  /** The single question is multi-select: several answers may be chosen. */
  multi?: boolean
  /** Optional standalone Markdown Body for focused detail. */
  body?: string
  /** Allow visible backslash-n sequences in `--body`. */
  literalBackslashN?: boolean
  /** Raw JSON for a multi-question form; replaces the positional question. */
  form?: string
  image?: string[]
  imageAlt?: string[]
  project?: string
  projectless?: boolean
  sessionLabel?: string
}

export interface AskFailure {
  ok: false
  registered: false
  code: string
  check_id: string
  exit_code: number
  remedy: string
  /** Distinguishes a harness limit from repairable routing while retaining released codes. */
  reason?: 'answer_cannot_return' | 'routing_not_ready'
  message: string
  user_action?: {
    code: string
    harness: string
    action: string
    message: string
  }
  request_user_input_async?: { questions: Array<{ title: string; options?: string[] }> }
}

/** One stable failure contract for every machine-readable ask refusal. */
export function reportAskFailure(
  deps: CommandDeps,
  flags: Pick<AskFlags, 'json'>,
  failure: Omit<AskFailure, 'ok' | 'registered'>,
): number {
  log(deps).error('cli.error', {
    kind: 'ask_admission',
    code: failure.code,
    check_id: failure.check_id,
    exit: failure.exit_code,
  })
  if (flags.json === true) {
    deps.io.out(JSON.stringify({ ok: false, registered: false, ...failure }, null, 2))
  } else {
    deps.io.err(failure.message)
    deps.io.err(`next: ${failure.remedy}`)
  }
  return failure.exit_code
}

function askFailure(
  deps: CommandDeps,
  flags: Pick<AskFlags, 'json'>,
  code: string,
  checkId: string,
  message: string,
  remedy: string,
  exitCode: number = EXIT.usage,
  details: Pick<AskFailure, 'user_action' | 'reason'> = {},
): number {
  return reportAskFailure(deps, flags, {
    code,
    check_id: checkId,
    exit_code: exitCode,
    remedy,
    message,
    ...details,
  })
}

/** Questions off keeps every route off the devices: nothing registers, nothing is held. */
function questionsOff(deps: CommandDeps, flags: Pick<AskFlags, 'json'>): number {
  // The code is the shipped one; scripts match it.
  return askFailure(
    deps,
    flags,
    'question_routing_disabled',
    'ask_notifications',
    'The User keeps questions off their devices: "Send questions to my devices" is off (ask_notifications=false). Nothing was registered.',
    'ask the way you would without Notifai: in the conversation, or in your own question form, which stays in the terminal; change the setting only if the User asks',
  )
}

/** One `--form` choice: a bare label, or a label with its consequence and recommendation. */
type AskFormChoice = string | { label: string; description?: string; recommended?: boolean }

/** The `--form` document: what an agent writes to ask several things at once. */
interface AskFormQuestion {
  /** With several questions, a word or two naming this question's own decision: its header in a terminal form. */
  title?: string
  text: string
  choices?: AskFormChoice[]
  multi?: boolean
}

const FORM_SHAPE =
  '--form must be JSON: {"title": "...", "summary": "...", "questions": [{"title"?, "text", "choices"?, "multi"?}], "body"?}; ' +
  'a choice is a label or {"label", "description"?, "recommended"?}.'

const TITLE_GUIDANCE = 'it names the decision in a few words and is never the question itself (`notifai guidance`)'

/** A title an older skill or script left out: the question still registers. */
export const MISSING_TITLE_NOTE =
  `notifai: pass --title (a form: its "title"); ${TITLE_GUIDANCE}. Until then the question is titled by the Agent Session name.`
const missingQuestionTitlesNote = (numbers: number[]): string =>
  `notifai: give each question of a form its own "title", a word or two naming its decision; ${numbers.map(n => `question ${n}`).join(', ')} ${numbers.length === 1 ? 'has' : 'have'} none.`

export interface BuiltQuestions {
  questions: QuestionT[]
  /**
   * The agent's title for the question, or the form's title for everything it
   * decides. Absent only for a form the agent opened itself, which is titled
   * by its heading, its headers or the Agent Session name (`buildAskDraft`).
   */
  title?: string
  /** With several questions, each question's own short title: its header in a terminal form. */
  headers?: string[]
  /** One line each for a title the agent left out, which current guidance always passes. */
  notes?: string[]
  /** Purpose-written plain text for the collapsed banner and list surfaces. */
  summary: string
  /** Optional standalone Markdown Body for focused detail. */
  body?: string
}

/**
 * Turn ask input into questions plus authored presentation content. Everything is
 * validated at registration because a later hook failure is easy to miss.
 *
 * The guidance has `ask` always pass a title (`--title`, or the form's
 * `"title"`), and a form with several questions a `"title"` per question. An
 * agent session or script from before titles leaves them out, so a missing
 * title is a note, not a usage error: the question takes the Agent Session
 * name, the rule a self-opened form follows, and an untitled question of
 * several is "Question N". A harness form the agent opened itself
 * (`selfOpened`) has no agent-written title: its hook titles it, without a note.
 */
export function buildQuestions(
  flags: AskFlags,
  question: string | undefined,
  options: { selfOpened?: boolean } = {},
): ({ ok: true } & BuiltQuestions) | { ok: false; error: string } {
  const titled = options.selfOpened !== true
  if (flags.form !== undefined) {
    if (question !== undefined || flags.choice?.length || flags.multi ||
        flags.choiceDescription?.length || flags.recommended?.length || flags.title !== undefined) {
      return {
        ok: false,
        error: '--form replaces the positional question, --title, --choice, --choice-description, --recommended, and --multi; the form carries the title in its "title" key.',
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(flags.form)
    } catch {
      return { ok: false, error: FORM_SHAPE }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `--form needs a "questions" array (1-${REPLY_MAX_QUESTIONS} entries).` }
    }
    const record = parsed as Record<string, unknown>
    const unknownKeys = Object.keys(record).filter(
      (key) => key !== 'title' && key !== 'summary' && key !== 'questions' && key !== 'body',
    )
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        error: `Unknown --form ${unknownKeys.length === 1 ? 'key' : 'keys'}: ${unknownKeys.join(', ')}.`,
      }
    }
    if (!Array.isArray(record['questions'])) {
      return { ok: false, error: `--form needs a "questions" array (1-${REPLY_MAX_QUESTIONS} entries).` }
    }
    if (typeof record['summary'] !== 'string' || record['summary'].trim() === '') {
      return { ok: false, error: '--form needs a non-empty one-line "summary" string.' }
    }
    if (record['title'] !== undefined && typeof record['title'] !== 'string') {
      return { ok: false, error: '"title" must be a string.' }
    }
    const formQuestions = record['questions']
    if (formQuestions.length < 1 || formQuestions.length > REPLY_MAX_QUESTIONS) {
      return {
        ok: false,
        error: `A form asks 1-${REPLY_MAX_QUESTIONS} questions; this one has ${formQuestions.length}.`,
      }
    }
    if (record['body'] !== undefined && typeof record['body'] !== 'string') {
      return { ok: false, error: '"body" must be a Markdown string.' }
    }
    if (flags.body !== undefined && record['body'] !== undefined) {
      return { ok: false, error: 'Pass the Markdown Body in either --body or the form "body" key, not both.' }
    }
    const questions: QuestionT[] = []
    const headers: string[] = []
    const untitled: number[] = []
    const usedIds = new Set<string>()
    for (const [index, entry] of formQuestions.entries()) {
      if (typeof entry !== 'object' || entry === null || typeof (entry as AskFormQuestion).text !== 'string') {
        return { ok: false, error: `Question ${index + 1} needs a "text" string.` }
      }
      const spec = entry as AskFormQuestion
      if (spec.title !== undefined && typeof spec.title !== 'string') {
        return { ok: false, error: `Question ${index + 1}: "title" must be a string.` }
      }
      if (spec.title !== undefined && spec.title.trim() !== '') headers.push(spec.title.trim())
      else if (titled && formQuestions.length > 1) {
        headers.push(`Question ${index + 1}`)
        untitled.push(index + 1)
      }
      const choices = formChoices(spec.choices)
      if ('error' in choices) return { ok: false, error: `Question ${index + 1}: ${choices.error}` }
      const built = buildOneQuestion(spec.text, choices.labels, choices.details, spec.multi === true, index, usedIds)
      if ('error' in built) return { ok: false, error: `Question ${index + 1}: ${built.error}` }
      questions.push(built.question)
    }
    const body = flags.body ?? (record['body'] as string | undefined)
    const title = typeof record['title'] === 'string' ? record['title'].trim() : undefined
    const notes = [
      ...(titled && (title === undefined || title === '') ? [MISSING_TITLE_NOTE] : []),
      ...(untitled.length > 0 ? [missingQuestionTitlesNote(untitled)] : []),
    ]
    return {
      ok: true,
      questions,
      ...(title !== undefined && title !== '' ? { title } : {}),
      ...(headers.length === questions.length ? { headers } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      summary: record['summary'],
      ...(body !== undefined ? { body } : {}),
    }
  }

  if (question === undefined || question.trim() === '') {
    return { ok: false, error: 'The question cannot be empty.' }
  }
  const built = buildOneQuestion(question, flags.choice, {
    ...(flags.choiceDescription !== undefined ? { descriptions: flags.choiceDescription } : {}),
    ...(flags.recommended !== undefined ? { recommended: flags.recommended } : {}),
  }, flags.multi === true, 0, new Set())
  if ('error' in built) return { ok: false, error: built.error }
  return {
    ok: true,
    questions: [built.question],
    ...(flags.title !== undefined && flags.title.trim() !== '' ? { title: flags.title.trim() } : titled ? { notes: [MISSING_TITLE_NOTE] } : {}),
    summary: built.question.text,
    ...(flags.body !== undefined ? { body: flags.body } : {}),
  }
}

/** `--form` choices as the same labels and details the flags produce. */
function formChoices(
  choices: unknown,
): { labels: string[] | undefined; details: ChoiceDetails } | { error: string } {
  if (choices === undefined) return { labels: undefined, details: {} }
  if (!Array.isArray(choices)) return { error: FORM_SHAPE }
  const labels: string[] = []
  const descriptions: ChoiceDescriptionInput[] = []
  const recommended: string[] = []
  for (const [index, choice] of choices.entries()) {
    if (typeof choice === 'string') {
      labels.push(choice)
      continue
    }
    if (typeof choice !== 'object' || choice === null || typeof (choice as { label?: unknown }).label !== 'string') {
      return { error: FORM_SHAPE }
    }
    const { label, description, recommended: isRecommended, ...rest } = choice as Record<string, unknown>
    if (Object.keys(rest).length > 0) return { error: `Unknown choice keys: ${Object.keys(rest).join(', ')}.` }
    if (description !== undefined && typeof description !== 'string') return { error: 'A choice "description" must be a string.' }
    if (isRecommended !== undefined && typeof isRecommended !== 'boolean') return { error: 'A choice "recommended" must be true or false.' }
    labels.push(label as string)
    if (description !== undefined) descriptions.push({ after: index + 1, text: description })
    if (isRecommended === true) recommended.push(label as string)
  }
  return { labels, details: { descriptions, recommended } }
}

function buildOneQuestion(
  text: string,
  choiceLabels: string[] | undefined,
  details: ChoiceDetails,
  multi: boolean,
  index: number,
  usedIds: Set<string>,
): { question: QuestionT } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { error: 'the question text cannot be empty.' }
  if ([...trimmed].length > QUESTION_TEXT_MAX_LENGTH) {
    return {
      error:
        `a question must be readable where it is answered: keep it within ` +
        `${QUESTION_TEXT_MAX_LENGTH} characters and put the longer explanation in --body.`,
    }
  }
  const parsed = parseChoices(choiceLabels, details)
  if (!parsed.ok) return { error: parsed.error }
  const choices = parsed.choices
  if (multi && choices === null) {
    return { error: '--multi needs answers to select between; add --choice.' }
  }
  let id = slugify(trimmed)
  if (id === '' || usedIds.has(id)) id = `q${index + 1}`
  usedIds.add(id)
  return {
    question: {
      id,
      text: trimmed,
      ...(choices !== null ? { choices } : {}),
      ...(multi ? { multi: true } : {}),
    },
  }
}

/**
 * The draft of a registered question. A form the agent opened itself wrote no
 * title: it is titled by its heading or headers (the caller's `built.title`),
 * otherwise by the Agent Session name. No route copies the question into the
 * title; the question is the Summary, shown once beneath it.
 */
export function buildAskDraft(
  config: CliConfig,
  built: BuiltQuestions,
  flags: AskFlags,
  invocation: DraftInvocation,
  mediaIds: string[],
  /** A held wait's window ends at its deadline; every other route keeps `reply_window_seconds`. */
  replyWindowSeconds?: number,
): { ok: true; draft: NotificationDraftT; platform: Platform } | { ok: false; error: string } {
  const result = buildDraft(
    config,
    {
      title: built.title ?? invocation.source?.session_label ?? UNTITLED_FORM_TITLE,
      summary: built.summary,
      ...(built.body !== undefined ? { body: built.body } : {}),
      ...(flags.project !== undefined ? { project: flags.project } : {}),
      ...(flags.projectless === true ? { projectless: true } : {}),
      ...(mediaIds.length > 0 ? { image: mediaIds } : {}),
      ...(flags.imageAlt !== undefined ? { imageAlt: flags.imageAlt } : {}),
      reply: true,
      ...(replyWindowSeconds !== undefined ? { replyWindow: replyWindowSeconds } : {}),
      questions: built.questions,
    },
    invocation,
  )
  if (!result.ok) return result
  const capabilities = CAPABILITIES_V1.describe(result.platform)
  if (capabilities === null) return { ok: false, error: 'No iOS capability contract is available.' }
  const validation = validateDraft(result.draft, capabilities)
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('\n'),
    }
  }
  return { ok: true, draft: result.draft, platform: result.platform }
}

function recordRegisteredQuestion(
  deps: CommandDeps,
  sessionId: string,
  built: BuiltQuestions,
  draft: NotificationDraftT,
  service: ServiceIdentity,
  json = false,
  wait = false,
  rootKey?: string,
): number | Promise<number> {
  const ordinary = () => persistRegisteredQuestion(deps, sessionId, built, draft, service, json, wait,
    undefined, rootKey, undefined, rootKey !== undefined)
  // A wait ends the turn, and Codex drops every open card at turn end, so a
  // waiting ask never links one. Codex offers no subagent the card at all.
  if (wait || rootKey !== undefined) return ordinary()
  if (!codexCardAsks(deps, sessionId) || built.questions.length > 10 || formsDisabledInProject(deps, sessionId)) return ordinary()
  if (built.questions.some(question => question.multi === true)) return ordinary()
  const local = currentCodexQuestionContext(readSessionState(sessionId, deps.env), sessionId, deps.env)
  if (local === null) return ordinary()
  const credential = deps.store.load()
  if (credential === null || credential.machineId !== service.machine_id || credential.baseUrl !== service.base_url) return ordinary()
  const persist = (nativeAdmission?: NativeQuestionAdmission, nativeUnavailable?: NativeUnavailable) =>
    persistRegisteredQuestion(deps, sessionId, built, draft, service, json, false, nativeAdmission, local.owner_key, nativeUnavailable)
  // Discovery is optional and bounded. Missing service support must not create
  // a hidden binding or block ordinary question registration. Do not cache it.
  const client = makeClient(deps, service.base_url, `Bearer nfm_${credential.machineId}.${credential.secret}`, { timeoutMs: 1500 })
  const supported = client.compatibility().then(
    support => Array.isArray(support?.server_capabilities) && support.server_capabilities.includes('harness_answers'),
    () => false,
  )
  // A device answer can close the native form only by steering this exact
  // turn through the server that owns the thread. Whether one is reachable is
  // fixed when Codex launches: an embedded (no-daemon) TUI never gains one.
  // Without it, a linked form would outlive its answer, so do not link.
  // The first `codex` launch from a daemon-hosted tool has taken ~2s cold, so
  // a tight budget misreads a slow server as an absent one. A missing socket
  // still fails fast, so sessions without a server do not pay this budget.
  // A server older than the card floor is reachable yet never linked; the
  // agent hears that reason so it asks in plain text rather than retrying.
  let unavailable: NativeUnavailable = { reason: 'no_owning_server_connection' }
  const reachable = (deps.codexAnswerControl ?? connectCodexAnswerControl)(
    sessionId, local.snapshot.latest.id, deps.env, performance.now() + NATIVE_PREFLIGHT_BUDGET_MS, undefined,
    report => { unavailable = report },
  ).then(control => {
    if (control === null) return false
    control.close()
    return true
  }, () => false)
  return Promise.all([supported, reachable]).then(([service_ok, transport_ok]) => persist(
    service_ok && transport_ok ? { owner_key: local.owner_key, turn_id: local.snapshot.latest.id, service, handback: cardShown(built.questions) } : undefined,
    service_ok && !transport_ok ? unavailable : undefined,
  ))
}

type NativeUnavailable = CodexAnswerUnavailable

const NATIVE_PREFLIGHT_BUDGET_MS = 3_000

/** Agent-facing only: the User never needs to hear about app-servers. */
function nativeUnavailableDetail(unavailable: NativeUnavailable): string {
  const cause = unavailable.reason === 'codex_version_unsupported'
    ? `This Codex session's app-server${unavailable.version === undefined ? ' did not report a version' : ` is ${unavailable.version}`}, ` +
      `older than the ${CODEX_CARD_VERSION_FLOOR} Notifai links cards on, so an answer from the user's devices cannot close a request_user_input_async form. `
    : 'No connection to this Codex session\'s app-server is available, so an answer from the user\'s devices cannot close a request_user_input_async form. '
  return cause +
    'Ask this question in plain text in the conversation and do not open request_user_input_async for it. ' +
    'Do not explain servers, daemons, versions or forms to the user.'
}

/**
 * Only trusted card hooks can attach a hand-back to its accepted invocation.
 */
function codexCardOwner(deps: CommandDeps, sessionId: string): string | null {
  if (readSessionState(sessionId, deps.env).harness !== 'codex') return null
  const owner = readSessionIncarnation(sessionId, deps.env)
  if (owner?.harness_process === undefined || sessionHasEnded(sessionId, deps.env) ||
      processIdentityLiveness(owner.harness_process) !== 'alive') return null
  return codexCardHooksReady(deps) ? owner.key : null
}

/**
 * Whether `ask` should hand this question to the Codex card instead. Only
 * when the card hooks are ready and this session has proved it can call the
 * card: an agent sent to a tool it does not have cannot ask at all.
 */
function codexCardAsks(deps: CommandDeps, sessionId: string): boolean {
  const owner = codexCardOwner(deps, sessionId)
  return owner !== null && codexCardToolOffered(readSessionState(sessionId, deps.env), owner, sessionId, deps.env)
}

const KEEP_SESSION_OPEN = 'Keep this Agent Session open while the question waits: closing, clearing or switching it ends the question, so never suggest that.'

const ROUTE_NEUTRAL = 'Never say where the answer must arrive; it returns by whatever route the harness supports.'

const ON_ANSWER = 'Acknowledge it, then resume the committed work without asking the user to confirm again.'

/**
 * The end-the-turn wait: this Agent Session has a proven return path, so the
 * agent waits as it would without Notifai, by ending its turn, and the answer
 * wakes it.
 */
const END_TURN = 'Ask it in the conversation, say what each answer will make you do, then end your turn. The answer arrives as your next message.'

/**
 * A Codex subagent asks on its root's behalf (`codex-subagent.ts`): the
 * question is the root's and its answer wakes the root, never the subagent.
 * So the subagent never asks it in its own conversation and never waits for
 * it; it hands the question to its parent and ends its turn. Plain `ask`,
 * `ask --wait` and a duplicate all say the same.
 */
const WORKER_ASK = 'You are a subagent: this question belongs to the root Agent Session that started you, and its answer arrives there, never to you. Do not ask it in your own conversation or wait for it. Tell your parent the question id and what each answer will change, then end your turn.'

const WORKER_KEEP_ROOT_OPEN = 'The root Agent Session must stay open while the question waits: closing, clearing or switching it ends the question, so never suggest that.'

const WORKER_ON_ANSWER = 'The root Agent Session acknowledges the answer and resumes the work; you take no action on it.'

function workerAnsweredOutside(questionId: string): string {
  return `If the User answers in the conversation instead, the root retires the question with \`notifai close ${questionId}\`; include that in your report.`
}

/** The `next` block a subagent asking on its root's behalf gets, whatever else happened. */
function workerNext(questionId: string, nextStep?: string) {
  return {
    end_turn: true,
    in_this_turn: nextStep === undefined ? WORKER_ASK : `${WORKER_ASK} ${nextStep}`,
    route_neutral: ROUTE_NEUTRAL,
    keep_session_open: WORKER_KEEP_ROOT_OPEN,
    on_answer: WORKER_ON_ANSWER,
    answered_outside_notifai: workerAnsweredOutside(questionId),
  }
}

/** The human form of `workerNext`. */
function printWorkerNext(deps: CommandDeps, built: BuiltQuestions, questionId: string): void {
  deps.io.out(WORKER_KEEP_ROOT_OPEN)
  deps.io.out(WORKER_ASK)
  deps.io.out(`Tell your parent the question id (${questionId}) and what each answer will change:`)
  for (const [index, entry] of built.questions.entries()) {
    const questionPrefix = built.questions.length > 1 ? `Question ${index + 1}, ` : ''
    if (entry.choices !== undefined) {
      for (const choice of entry.choices) {
        deps.io.out(`- ${questionPrefix}If the answer is ${JSON.stringify(choice.label)}: the work it means.`)
      }
      deps.io.out(`- ${questionPrefix}For an unexpected typed answer: how it will decide the work.`)
    } else {
      deps.io.out(`- ${questionPrefix}For the free-text answer: how its content will decide the work.`)
    }
  }
  deps.io.out(WORKER_ON_ANSWER)
  deps.io.out(workerAnsweredOutside(questionId))
}

/** The human output's last line, after the commitments it asks for. */
const END_TURN_HUMAN = 'Then end your turn: the answer arrives as your next message.'

/** The picker wait: Claude Code's own form asks the registered question and returns its answer. */
const OPEN_FORM = `Say what each answer will make you do, then open ${CLAUDE_QUESTION_TOOL} with open_form.input unchanged, in this turn. It is your question in the conversation: never also ask it in prose.`

const OPEN_FORM_HUMAN = `Then open ${CLAUDE_QUESTION_TOOL} with this input unchanged, in this turn. It is your question in the conversation: never also ask it in prose.`

const OPEN_FORM_UNAVAILABLE = `If ${CLAUDE_QUESTION_TOOL} is unavailable, end your turn instead: the answer arrives as your next message.`

/** An explicit Projectless ask can run here, but native forms still follow the cwd Project. */
function formsDisabledInProject(deps: CommandDeps, sessionId: string): boolean {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env, sessionId })
  return projectDisabled(projectBinding(deps.cwd, deps.env, config.project.value))
}

/**
 * The picker `ask --wait` hands back on Claude Code, recorded as this turn's
 * hand-back, or null where the picker cannot carry the question and the agent
 * ends its turn instead. Without the picker hooks (an installation from before
 * they were installed on Windows) a device answer could never return through
 * the picker.
 */
function claudeHandBack(
  deps: CommandDeps,
  sessionId: string,
  question: Pick<PendingQuestion, 'question_id' | 'title' | 'headers' | 'questions'>,
): ClaudePickerInput | null {
  if (readSessionState(sessionId, deps.env).harness !== 'claude-code' || formsDisabledInProject(deps, sessionId)) return null
  if (!claudePickerHooksInstalled(deps)) return null
  const input = handBackInput(question)
  if (input === null) return null
  updateSessionState(sessionId, deps.env, (state) => recordHandBack(state, question.question_id!, (deps.now ?? Date.now)()))
  return input
}

/** Whether Claude Code runs both picker handlers: the one that holds the picker and the one that settles it. */
function claudePickerHooksInstalled(deps: CommandDeps): boolean {
  return findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).some((installation) =>
    installation.harness === 'claude-code' && (installation.problems ?? []).length === 0 &&
    (['permission-request', 'post-tool-use'] as const).every((event) => installation.handlers.some((handler) =>
      handlerEvent(handler.command) === event && handler.matcher === CLAUDE_PICKER_MATCHER)))
}

/**
 * The duplicate guard found this question already open in this Agent Session,
 * or answered with the answer not yet handed to the agent: nothing new was
 * registered, and the earlier registration keeps its own Body and images. A
 * duplicate is success, so an agent retrying after a crash is told nothing to
 * fix; it asks in the conversation and carries on, as after any `ask`.
 */
function reportAlreadyOpen(
  deps: CommandDeps,
  sessionId: string,
  built: BuiltQuestions,
  questionId: string,
  json: boolean,
  wait = false,
  worker = false,
): number {
  log(deps).info('ask.registered', { ok: true, session: sessionId, question_id: questionId, linked: true, questions: built.questions.length })
  const open = captureCandidates(readSessionState(sessionId, deps.env)).find((pending) => pending.question_id === questionId)
  const questions = open?.questions ?? built.questions
  const message = worker
    ? `This question is already open in the root Agent Session as ${questionId}: nothing new was registered, and a new Body or images were not applied. Its answer arrives in the root Agent Session, not to you.`
    : `This question is already open in this Agent Session as ${questionId}: nothing new was registered, and a new Body or images were not applied. Its answer comes back into this Agent Session.`
  const handBack = wait && !worker && open !== undefined ? claudeHandBack(deps, sessionId, open) : null
  const inThisTurn = handBack !== null
    ? `${OPEN_FORM} ${OPEN_FORM_UNAVAILABLE}`
    : wait
      ? END_TURN
      : 'Ask the question in the conversation and explain what each answer will change, then continue independent work; dependent work waits for the answer.'
  const answeredOutside = `If they answer in the conversation instead, run \`notifai close ${questionId}\` to retire this question.`
  if (json) {
    deps.io.out(JSON.stringify({
      registered: false,
      already_open: { question_id: questionId },
      question_id: questionId,
      message,
      questions: questions.map((entry) => ({
        id: entry.id,
        text: entry.text,
        ...(entry.choices === undefined ? {} : { choices: entry.choices }),
        ...(entry.multi === true ? { multi: true } : {}),
      })),
      ...(handBack === null ? {} : { open_form: { tool: CLAUDE_QUESTION_TOOL, input: handBack } }),
      status: `notifai status ${questionId}`,
      close: `notifai close ${questionId}`,
      next: worker ? workerNext(questionId) : {
        end_turn: wait && handBack === null,
        in_this_turn: inThisTurn,
        route_neutral: ROUTE_NEUTRAL,
        keep_session_open: KEEP_SESSION_OPEN,
        on_answer: ON_ANSWER,
        ...(handBack === null ? { answered_outside_notifai: answeredOutside } : {}),
      },
    }, null, 2))
    return EXIT.ok
  }
  deps.io.out(message)
  if (worker) {
    deps.io.out(`Inspect \`notifai status ${questionId}\` for submission evidence; never register a replacement to check this question.`)
    printWorkerNext(deps, built, questionId)
    return EXIT.ok
  }
  if (handBack !== null) {
    deps.io.out(`Inspect \`notifai status ${questionId}\` for submission evidence; never register a replacement to check this question.`)
    deps.io.out(KEEP_SESSION_OPEN)
    deps.io.out(`Say what each answer will make you do. ${OPEN_FORM_HUMAN}`)
    deps.io.out(JSON.stringify(handBack))
    deps.io.out(OPEN_FORM_UNAVAILABLE)
    return EXIT.ok
  }
  deps.io.out(`${inThisTurn} Inspect \`notifai status ${questionId}\` for submission evidence; never register a replacement to check this question.`)
  deps.io.out(KEEP_SESSION_OPEN)
  deps.io.out(answeredOutside)
  return EXIT.ok
}

function persistRegisteredQuestion(
  deps: CommandDeps,
  sessionId: string,
  built: BuiltQuestions,
  draft: NotificationDraftT,
  service: ServiceIdentity,
  json = false,
  wait = false,
  nativeAdmission?: NativeQuestionAdmission,
  ownerKey?: string,
  nativeUnavailable?: NativeUnavailable,
  worker = false,
): number {
  let registered: RegisteredQuestion
  const credential = deps.store.load()
  if (credential === null || credential.machineId !== service.machine_id || credential.baseUrl !== service.base_url) {
    return askFailure(deps, { json }, 'auth_required', 'credential',
      'The Approved Machine changed before question registration completed.',
      'retry the same ask from the intended signed-in machine', EXIT.auth)
  }
  try {
    registered = registerQuestion(
      sessionId,
      deps.env,
      {
        question: built.questions[0]!.text,
        title: draft.presentation.title,
        ...(built.headers !== undefined ? { headers: built.headers } : {}),
        summary: draft.presentation.summary,
        service_identity: service,
        questions: built.questions,
        ...(draft.presentation.body !== undefined ? { body: draft.presentation.body } : {}),
        ...(draft.project !== undefined ? { project: draft.project } : {}),
        ...(draft.source !== undefined ? { source: draft.source } : {}),
        ...(draft.presentation.media !== undefined ? { media: draft.presentation.media } : {}),
      },
      (deps.now ?? Date.now)(),
      nativeAdmission,
      { ...(ownerKey === undefined ? {} : { owner_key: ownerKey }), machineStillMatches: () => {
        const current = deps.store.load()
        return current !== null && current.machineId === service.machine_id && current.baseUrl === service.base_url
      } },
    )
  } catch (err) {
    if (err instanceof QuestionRegistrationChanged) {
      return askFailure(deps, { json }, err.reason === 'credential' ? 'auth_required' : 'session_changed',
        err.reason === 'credential' ? 'credential' : 'question_registration', err.message,
        'retry the same ask from the current Agent Session and intended signed-in machine',
        err.reason === 'credential' ? EXIT.auth : EXIT.failed)
    }
    return askFailure(
      deps,
      { json },
      'registration_failed',
      'question_registration',
      `Could not register the question: ${err instanceof Error ? err.message : String(err)}`,
      'retire an older pending question if the limit was reached, then retry the same ask',
      EXIT.failed,
    )
  }
  if (!registered.registered) return reportAlreadyOpen(deps, sessionId, built, registered.question_id, json, wait, worker)
  const questionId = registered.question_id
  log(deps).info('ask.registered', {
    ok: true,
    session: sessionId,
    question_id: questionId,
    questions: built.questions.length,
    text_chars: built.questions[0]!.text.length,
    choices: built.questions[0]!.choices?.length ?? 0,
    media: draft.presentation.media?.length ?? 0,
    ...(nativeUnavailable === undefined ? {} : { native_unavailable: nativeUnavailable.reason,
      ...('version' in nativeUnavailable && nativeUnavailable.version !== undefined ? { codex_version: nativeUnavailable.version } : {}) }),
  })
  const harness = readSessionState(sessionId, deps.env).harness
  let submission: 'scheduled' | 'launch-failed' = 'scheduled'
  try {
    if (harness === undefined) throw new Error('The admitted Agent Session lost its harness identity')
    ;(deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({
      envelope: { session_id: sessionId, cwd: deps.cwd }, harness, purpose: 'submission',
    })
  } catch (err) {
    submission = 'launch-failed'
    log(deps).error('cli.error', { kind: 'question_submission_launch', session: sessionId, question_id: questionId, outcome: submission,
      message: err instanceof Error ? err.message : String(err) })
  }
  const nextStep = submission === 'scheduled'
    ? wait || worker
      ? 'Background submission is scheduled; this does not confirm submission or delivery, so check status before reporting either.'
      : 'Background submission is scheduled; this does not confirm submission or delivery, so check status before reporting either. Continue independent work: the answer comes back into this Agent Session.'
    : 'Background startup failed. Keep this registration; ordinary lifecycle hooks can recover it. Inspect status before relying on submission.'
  const native = readSessionState(sessionId, deps.env).codex_question_bindings?.find(binding =>
    binding.question_id === questionId && binding.card_handback === true && binding.ordinary_only !== true &&
    binding.owner_key === readSessionIncarnation(sessionId, deps.env)?.key)
  const nativeInstruction = 'Open the handed-back card unchanged after saying what each answer will make you do. It is your question in the conversation; never also ask it in prose. Notifai records a terminal answer itself; acknowledge a device answer with the command it carries.'
  const openForm = native === undefined ? undefined : { tool: 'request_user_input_async', input: cardHandbackInput(native) }
  const handBack = wait && !worker
    ? claudeHandBack(deps, sessionId, {
      question_id: questionId, title: draft.presentation.title, questions: built.questions,
      ...(built.headers !== undefined ? { headers: built.headers } : {}),
    })
    : null
  // The block below is the densest guidance this CLI prints, and until now it
  // was prose only: an agent could not read back the choice ids it must branch
  // on without asking the server for them. The JSON form carries the same
  // obligation as data.
  if (json) {
    deps.io.out(
      JSON.stringify(
        {
          registered: true,
          question_id: questionId,
          state: 'local',
          submitted: false,
          submission,
          request_id: null,
          provider_acceptance: 'not_available',
          questions: built.questions.map((entry) => ({
            id: entry.id,
            text: entry.text,
            ...(entry.choices === undefined ? {} : { choices: entry.choices }),
            ...(entry.multi === true ? { multi: true } : {}),
          })),
          ...(openForm === undefined ? {} : { open_form: openForm }),
          ...(native === undefined && nativeUnavailable !== undefined ? { native_question_unavailable: {
            reason: nativeUnavailable.reason, detail: nativeUnavailableDetail(nativeUnavailable),
            ...('version' in nativeUnavailable && nativeUnavailable.version !== undefined ? { codex_version: nativeUnavailable.version } : {}),
            ...(nativeUnavailable.reason === 'codex_version_unsupported' ? { codex_version_floor: CODEX_CARD_VERSION_FLOOR } : {}),
          } } : {}),
          ...(handBack === null ? {} : { open_form: { tool: CLAUDE_QUESTION_TOOL, input: handBack } }),
          status: `notifai status ${questionId}`,
          close: `notifai close ${questionId}`,
          next: worker ? workerNext(questionId, nextStep) : {
            end_turn: wait && handBack === null,
            in_this_turn: handBack !== null
              ? `${OPEN_FORM} ${OPEN_FORM_UNAVAILABLE} ${nextStep}`
              : wait
                ? `${END_TURN} ${nextStep}`
                : `${native === undefined ? 'Ask the question in the conversation and explain what each answer will change.' : nativeInstruction} ${nextStep}`,
            route_neutral: ROUTE_NEUTRAL,
            keep_session_open: KEEP_SESSION_OPEN,
            on_answer: ON_ANSWER,
            ...(handBack !== null ? {} : { answered_outside_notifai: native === undefined
              ? `If they answer in the conversation instead, run \`notifai close ${questionId}\` to retire this question.`
              : `If the User answers in the card, Notifai records it mechanically. If the card drops and they answer in the conversation, run \`notifai close ${questionId}\` to retire this question.` }),
          },
        },
        null,
        2,
      ),
    )
    return EXIT.ok
  }
  for (const [index, entry] of built.questions.entries()) {
    const prefix = built.questions.length > 1 ? `${index + 1}. ` : ''
    if (entry.choices !== undefined) {
      const kind = entry.multi === true ? 'answers offered (several may be chosen)' : 'answers offered'
      deps.io.out(`${prefix}${entry.text} — ${kind}: ${entry.choices
        .map((choice) => choice.recommended === true ? `${choice.label} (recommended)` : choice.label).join(' / ')}`)
    } else if (built.questions.length > 1) {
      deps.io.out(`${prefix}${entry.text} — free text`)
    }
  }
  deps.io.out(
    built.questions.length > 1
      ? `${built.questions.length} questions registered as one form (${questionId}); background submission is ${submission}. Provider Acceptance is not confirmed yet.`
      : `Question registered (${questionId}); background submission is ${submission}. Provider Acceptance is not confirmed yet.`,
  )
  deps.io.out(
    `${nextStep} Inspect \`notifai status ${questionId}\` for submission evidence; never register a replacement to check this question.`,
  )
  if (worker) {
    printWorkerNext(deps, built, questionId)
    return EXIT.ok
  }
  deps.io.out(KEEP_SESSION_OPEN)
  deps.io.out(handBack !== null
    ? 'Say what each answer will make you do:'
    : wait
      ? 'Ask it in the conversation and say what each answer will make you do:'
      : native === undefined ? 'Ask in the conversation and explain what each answer will change:' : 'Before opening the card, explain what each answer will change:')
  for (const [index, entry] of built.questions.entries()) {
    const questionPrefix = built.questions.length > 1 ? `Question ${index + 1}, ` : ''
    if (entry.choices !== undefined) {
      for (const choice of entry.choices) {
        deps.io.out(
          `- ${questionPrefix}If the answer is ${JSON.stringify(choice.label)}: state the concrete work you will resume.`,
        )
      }
      deps.io.out(
        `- ${questionPrefix}For an unexpected typed answer: state how it will determine the concrete work you resume.`,
      )
    } else {
      deps.io.out(
        `- ${questionPrefix}For the free-text answer: state how its content will determine the concrete work you resume.`,
      )
    }
  }
  deps.io.out(
    'When the answer arrives, resume the matching work without asking the user to confirm again. Frame this as work you will resume, not as approval you receive.',
  )
  deps.io.out(
    'A Notifai answer cannot answer a harness permission prompt; leave those to the harness and user.',
  )
  if (handBack !== null) {
    deps.io.out(OPEN_FORM_HUMAN)
    deps.io.out(JSON.stringify(handBack))
    deps.io.out(OPEN_FORM_UNAVAILABLE)
    return EXIT.ok
  }
  if (wait) {
    deps.io.out(`If they answer in this conversation instead, retire it with \`notifai close ${questionId}\`.`)
    deps.io.out(END_TURN_HUMAN)
    return EXIT.ok
  }
  if (native !== undefined) {
    deps.io.out(nativeInstruction)
    deps.io.out(`Open ${openForm!.tool} with this input:`)
    deps.io.out(JSON.stringify(openForm!.input))
  } else {
    if (nativeUnavailable !== undefined) deps.io.out(nativeUnavailableDetail(nativeUnavailable))
    deps.io.out(`If they answer in this conversation instead, retire it with \`notifai close ${questionId}\`.`)
  }
  return EXIT.ok
}

async function uploadAskMedia(
  deps: CommandDeps,
  config: CliConfig,
  sessionId: string,
  built: BuiltQuestions,
  flags: AskFlags,
  invocation: DraftInvocation,
  service: ServiceIdentity,
  rootKey?: string,
): Promise<number> {
  const authed = authedClient(deps, config)
  if (!authed) {
    return askFailure(
      deps,
      flags,
      'auth_required',
      'credential',
      'Question routing is not paired on this machine.',
      'run `notifai init --json`',
      EXIT.auth,
    )
  }
  if (authed.service.base_url !== service.base_url || authed.service.machine_id !== service.machine_id) {
    return askFailure(deps, flags, 'machine_changed', 'credential',
      'The Approved Machine changed before the question media upload started.',
      'retry the same ask from the intended signed-in machine', EXIT.auth)
  }
  const mediaIds: string[] = []
  for (const image of flags.image ?? []) {
    if (image.startsWith('med_')) {
      mediaIds.push(image)
      continue
    }
    const uploaded = await uploadImage(deps, authed.client, image, config.media_origins.value)
    if (!uploaded.ok) {
      if (uploaded.error !== null) deps.io.err(uploaded.error)
      return askFailure(
        deps,
        flags,
        'media_upload_failed',
        'media',
        uploaded.error ?? 'The image upload failed.',
        'fix the reported image or network problem, then retry the same ask',
        uploaded.exit,
      )
    }
    mediaIds.push(uploaded.mediaId)
  }
  const ready = buildAskDraft(config, built, flags, invocation, mediaIds)
  if (!ready.ok) {
    return askFailure(deps, flags, 'invalid_draft', 'draft', ready.error, 'fix the reported field and retry')
  }
  return recordRegisteredQuestion(deps, sessionId, built, ready.draft, service, flags.json === true, flags.wait === true, rootKey)
}

/**
 * Registers and starts submission immediately, without waiting for turn end.
 * The exact harness keeps ownership of answer delivery while work continues.
 */
export function askCommand(
  deps: CommandDeps,
  question: string | undefined,
  flags: AskFlags,
): number | Promise<number> {
  // Validate before route discovery. A malformed question belongs to the
  // caller and should not be hidden behind whichever harness setup issue
  // happens to exist on this machine.
  const escapedBody = rejectAccidentalEscapedNewlines(flags.body, flags.literalBackslashN)
  if (escapedBody !== null) {
    return askFailure(deps, flags, 'invalid_input', 'body', escapedBody, 'fix the body and retry')
  }
  if (flags.projectless === true && flags.project !== undefined) {
    return askFailure(deps, flags, 'invalid_input', 'project', 'Choose either --project or --projectless, not both.', 'pass one Project selection and retry')
  }
  const built = buildQuestions(flags, question)
  if (!built.ok) {
    return askFailure(deps, flags, 'invalid_input', 'questions', built.error, 'fix the question input and retry')
  }
  for (const note of built.notes ?? []) deps.io.err(note)
  const mediaInputError = validateMediaInputs(flags.image, flags.imageAlt)
  if (mediaInputError !== null) {
    return askFailure(deps, flags, 'invalid_input', 'media', mediaInputError, 'fix the media flags and retry')
  }
  let explicitUseConfig: CliConfig
  try {
    explicitUseConfig = loadConfig({ cwd: deps.cwd, env: deps.env })
  } catch (err) {
    return askFailure(deps, flags, 'config_invalid', 'configuration', `Question routing configuration is invalid: ${String(err)}`, 'fix the reported Notifai configuration and retry')
  }
  const explicitProject = flags.project ?? explicitUseConfig.project.value ?? inferredProjectName(deps.cwd, deps.env)
  const explicitBinding = explicitProject === null ? null : projectBinding(deps.cwd, deps.env, explicitProject)
  if (explicitBinding !== null) {
    let decision: 'enabled' | 'disabled'
    try {
      decision = flags.projectless === true
        ? (projectDisabled(explicitBinding) ? 'disabled' : 'enabled')
        : enableProjectUnlessDisabled(explicitBinding)
    } catch (err) {
      return askFailure(
        deps,
        flags,
        'project_enablement_failed',
        'project_enablement',
        `Project Enablement could not be saved: ${String(err)}`,
        'check filesystem permissions or sandbox access for the Notifai state directory, then retry the same ask',
        EXIT.failed,
      )
    }
    if (decision === 'disabled') {
      return askFailure(
        deps,
        flags,
        'project_disabled',
        'project_enablement',
        `Notifai is disabled for Project "${explicitBinding.project}": nothing from it reaches the User's devices. Nothing was registered.`,
        'if the User asked for Notifai here, run `notifai project enable`, then ask again; otherwise ask in the conversation, as you would without Notifai',
      )
    }
  }
  const credential = deps.store.load()
  if (credential === null) {
    return askFailure(
      deps,
      flags,
      'auth_required',
      'credential',
      'Question routing is not paired on this machine.',
      'run `notifai init --json`',
      EXIT.auth,
    )
  }
  // An agent calling this gets no hook payload. Harness-native environment
  // markers identify the active owner, while UserPromptSubmit adds the hook's
  // canonical id to the directory's concurrent-session index.
  const now = (deps.now ?? Date.now)()
  const { active, contested } = resolveAskingHarness(deps.env, deps.cwd, now, deps.hookPlatform ?? process.platform)
  // Where no later answer can come back (no harness, conflicting markers,
  // Cursor, OpenCode, OpenClaw off macOS, Hermes off its classic CLI), plain
  // `ask` is refused and `ask --wait` holds in this command; an OpenCode root
  // session's `ask --wait` hands back its `question` form instead.
  // Questions off keeps every route off the devices first.
  const held = heldWaitRoute(active, contested, deps.hookPlatform ?? process.platform)
  if (held !== null) {
    if (!explicitUseConfig.ask_notifications.value) return questionsOff(deps, flags)
    if (flags.wait !== true) {
      return askFailure(
        deps, flags, held.code, held.checkId,
        `${held.reason.trim().replace(/[.!?]$/, '')}. Nothing was registered.`,
        answerCannotReturnRemedy(held),
        EXIT.usage,
        { reason: 'answer_cannot_return' },
      )
    }
    const waitInput = { question, built, flags, config: explicitUseConfig, route: held }
    return opencodeHandBack(deps, waitInput) ?? heldAskWait(deps, waitInput)
  }
  // From here the harness has a return path. Its routing must be ready, for
  // `ask` and `ask --wait` alike: a wait is never a way round admission.
  const sessionId = active!.sessionId!
  {
    const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)
    const activeInstalled = installations.some(
      (installation) => installation.harness === active!.harness,
    )
    if (!activeInstalled) {
      return askFailure(
        deps,
        flags,
        'hooks_not_installed',
        'hook_installation',
        `Notifai ${active!.label} hooks are not installed in this active harness home.`,
        `run \`notifai init --json\` from this ${active!.label} session`,
      )
    }
    const matchingInstallations = installations.filter(
      (installation) => installation.harness === active!.harness,
    )
    const trustProblems = active!.harness === 'codex'
      ? codexRoutingTrustProblems(matchingInstallations, deps.env)
      : []
    if (trustProblems.length > 0) {
      return askFailure(
        deps,
        flags,
        'codex_hook_approval_required',
        'hook_trust',
        `Question routing is not ready: ${trustProblems.join('; ')}. This question was not registered. Neither \`notifai ask\` nor \`notifai ask --wait\` works until the User approves the hooks.`,
        'open `/hooks` in Codex and approve or enable the Notifai handlers',
        EXIT.usage,
        { user_action: CODEX_HOOK_APPROVAL_USER_ACTION },
      )
    }
    const routeProblems = activeQuestionRouteProblems(deps, active!, installations)
    if (routeProblems.includes(CODEX_STOP_DEFINITION_NOT_SINGULAR_PROBLEM)) {
      return askFailure(
        deps,
        flags,
        'codex_stop_definition_invalid',
        'hook_installation',
        `Question routing is not ready: ${CODEX_STOP_DEFINITION_NOT_SINGULAR_PROBLEM}. This question was not registered.`,
        'run `notifai hooks install --harness codex`, then re-run `notifai doctor`',
      )
    }
    if (routeProblems.includes(CODEX_STALE_STOP_DEFINITION_PROBLEM)) {
      return askFailure(
        deps,
        flags,
        'codex_fresh_session_required',
        'stop_hook',
        `Question routing is not ready: ${CODEX_STALE_STOP_DEFINITION_PROBLEM}. This question was not registered.`,
        'start one fresh Codex session, send one prompt in it, then retry the same ask with the original question and every flag',
        EXIT.usage,
        { user_action: CODEX_FRESH_SESSION_USER_ACTION },
      )
    }
    if (routeProblems.length > 0) {
      return askFailure(
        deps,
        flags,
        'question_routing_unavailable',
        'hook_contract',
        `Question routing is not ready: ${routeProblems.join('; ')}. Nothing was registered.`,
        'run `notifai init --json` and follow its question-routing remedy',
        EXIT.usage,
        { reason: 'routing_not_ready' },
      )
    }
    const state = readSessionState(sessionId, deps.env)
    if (active!.harness === 'openclaw' &&
        activeOpenclawGeneration(sessionId, deps.env) === null) {
      return askFailure(
        deps, flags, 'openclaw_generation_stale', 'exact_session',
        'This OpenClaw tool subprocess cannot prove the current Gateway session generation.',
        'run the same notifai ask from a current OpenClaw turn after the Notifai plugin has recorded it; if it is refused again, ask in the conversation',
      )
    }
    if (active!.harness === 'openclaw' && !openclawGatewayReady(deps.env)) {
      return askFailure(
        deps, flags, 'openclaw_gateway_unready', 'hook_contract',
        'The local OpenClaw Gateway service has not proved a matching CLI, a live process and the installed Notifai plugin generation.',
        'apply the installed plugin with `openclaw plugins reload notifai` (or start the Gateway), then run `notifai doctor`',
      )
    }
    if (state.harness !== active!.harness ||
        (active!.harness !== 'hermes' && state.last_prompt_at === undefined)) {
      // A Codex subagent asks for its root (`codex-subagent.ts`). Where that
      // root is not live and activated below this shell, or the process tree
      // cannot be read (Windows), it stays refused; it cannot send a prompt
      // of its own, so its parent asks instead.
      if (active!.harness === 'codex' && codexSubagentShell(deps.env)) {
        return askFailure(
          deps,
          flags,
          'session_not_activated',
          'user_prompt_submit',
          'This Codex subagent cannot ask the User: Notifai cannot place it inside a live, activated Agent Session that started it.',
          'give the question to your parent agent, which can ask it',
        )
      }
      return askFailure(
        deps,
        flags,
        'session_not_activated',
        'user_prompt_submit',
        `This exact ${active!.label} Agent Session has not activated question routing. Nothing was registered.`,
        active!.harness === 'hermes'
          ? 'ask in the conversation: this Hermes session has no active classic CLI plugin writer; a background review cannot be activated by another prompt'
          : `send one prompt in this ${active!.label} session, then retry the same notifai ask${flags.wait === true ? ' --wait' : ''} with the original question and every flag; if this harness cannot run that prompt hook, ask in the conversation`,
      )
    }
    if (active!.harness === 'hermes' &&
        !hermesQuestionRouteReady(sessionId, deps.env, now)) {
      return askFailure(
        deps, flags, 'question_routing_unavailable', 'plugin_writer',
        'This exact Hermes classic CLI session has no current attending plugin writer.',
        'ask in the conversation here; in an interactive Hermes classic CLI, enable the Notifai plugin in a fresh session, then retry the same ask with its original question and every flag, including --wait if used',
      )
    }
  }
  let routingConfig: CliConfig
  try {
    routingConfig = loadConfig({ cwd: deps.cwd, env: deps.env, sessionId })
  } catch (err) {
    return askFailure(
      deps,
      flags,
      'config_invalid',
      'configuration',
      `Question routing configuration is invalid: ${String(err)}`,
      'fix the reported Notifai configuration and retry',
    )
  }
  if (!routingConfig.ask_notifications.value) return questionsOff(deps, flags)
  const source = resolveDraftInvocation(deps, flags, active!)
  if (!source.ok) {
    return askFailure(
      deps,
      flags,
      'invalid_source',
      'source_context',
      source.error,
      /session-name store|session's name/u.test(source.error)
        ? 'inspect the named session-name store, isolate or remove the invalid record, and retry'
        : 'remove the conflicting source override and retry',
    )
  }
  if (source.invocation.source?.session_id !== sessionId) {
    return askFailure(
      deps,
      flags,
      'session_identity_mismatch',
      'exact_session',
      `The inferred session does not match the exact active ${active!.label} session.`,
      'remove NOTIFAI_SESSION_ID and retry from the exact active session',
    )
  }

  // Placeholders let every body, source, project, media, and payload limit fail
  // before an upload starts. The real ids replace them only after this passes.
  const placeholders = (flags.image ?? []).map((_, index) => `med_pending_${index + 1}`)
  const preflight = buildAskDraft(routingConfig, built, flags, source.invocation, placeholders)
  if (!preflight.ok) {
    return askFailure(deps, flags, 'invalid_draft', 'draft', preflight.error, 'fix the reported field and retry')
  }
  // The duplicate guard runs before any upload, so a repeat of an open question
  // costs no media round trip; registration repeats it under the session lock.
  const open = findOpenEqualQuestion(readSessionState(sessionId, deps.env), built.questions)
  const rootKey = active!.harness === 'codex' ? active!.rootKey : undefined
  if (open !== undefined) {
    return reportAlreadyOpen(deps, sessionId, built, open.question_id!, flags.json === true, flags.wait === true, rootKey !== undefined)
  }
  if ((flags.image?.length ?? 0) > 0) {
    return uploadAskMedia(
      deps,
      routingConfig,
      sessionId,
      built,
      flags,
      source.invocation,
      { base_url: credential.baseUrl, machine_id: credential.machineId },
      rootKey,
    )
  }
  return recordRegisteredQuestion(deps, sessionId, built, preflight.draft,
    { base_url: credential.baseUrl, machine_id: credential.machineId }, flags.json === true, flags.wait === true, rootKey)
}
