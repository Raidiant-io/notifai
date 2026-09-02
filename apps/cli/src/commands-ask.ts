/** Validation and durable registration for the agent-facing ask command. */
import {
  CAPABILITIES_V1,
  QUESTION_TEXT_MAX_LENGTH,
  REPLY_MAX_QUESTIONS,
  validateDraft,
  type NotificationDraftT,
  type QuestionT,
} from '@raidiant/notifai-protocol'
import { EXIT, authedClient, log, type CommandDeps } from './commands-core.js'
import { resolveActiveHarness } from './commands-harness-context.js'
import {
  CODEX_FRESH_SESSION_USER_ACTION,
  CODEX_HOOK_APPROVAL_USER_ACTION,
  CODEX_STALE_STOP_DEFINITION_PROBLEM,
  CODEX_STOP_DEFINITION_NOT_SINGULAR_PROBLEM,
  activeQuestionRouteProblems,
} from './commands-hook-diagnostics.js'
import { resolveDraftInvocation, uploadImage } from './commands-send-support.js'
import { loadConfig, type CliConfig } from './config.js'
import { HERMES_QUESTION_ROUTING_UNAVAILABLE, isHookInstallableHarness } from './harnesses.js'
import { registerQuestion } from './hook-lifecycle.js'
import { readSessionState } from './hook-session-state.js'
import { codexTrustProblems, findInstallations } from './install-hooks.js'
import { inferInvocationContext } from './invocation-context.js'
import { enableProject, projectBinding } from './project-enablement.js'
import {
  CHOICE_USAGE,
  buildDraft,
  parseChoices,
  rejectAccidentalEscapedNewlines,
  slugify,
  validateMediaInputs,
  type DraftInvocation,
} from './send.js'
export interface AskFlags {
  /** Emit the registration and its turn obligation as one JSON object. */
  json?: boolean
  choice?: string[]
  /** The single question is multi-select: several answers may be chosen. */
  multi?: boolean
  /** Optional Markdown context appended after the question block. */
  body?: string
  /** Allow visible backslash-n sequences in `--body`. */
  literalBackslashN?: boolean
  /** Raw JSON for a multi-question form; replaces the positional question. */
  form?: string
  image?: string[]
  imageAlt?: string[]
  project?: string
  sessionLabel?: string
}

export interface AskFailure {
  ok: false
  registered: false
  code: string
  check_id: string
  exit_code: number
  remedy: string
  message: string
  user_action?: {
    code: string
    harness: string
    action: string
    message: string
  }
}

/** One stable failure contract for every machine-readable ask refusal. */
export function reportAskFailure(
  deps: CommandDeps,
  flags: Pick<AskFlags, 'json'>,
  failure: Omit<AskFailure, 'ok' | 'registered'>,
): number {
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
  flags: AskFlags,
  code: string,
  checkId: string,
  message: string,
  remedy: string,
  exitCode: number = EXIT.usage,
  details: Pick<AskFailure, 'user_action'> = {},
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

/** The `--form` document: what an agent writes to ask several things at once. */
interface AskFormQuestion {
  text: string
  choices?: string[]
  multi?: boolean
}

export interface BuiltQuestions {
  questions: QuestionT[]
  /**
   * Canonical Markdown body. The question already travels as the notification
   * title and as structured questions, so the body carries only the context —
   * repeating the question there put it on the lock screen and the reply
   * screen twice. Only when there is no context does the question text stand
   * in, because the wire requires a body.
   */
  body: string
}

/**
 * Turn ask input into questions plus their canonical body. Everything is
 * validated at registration because a later hook failure is easy to miss.
 */
export function buildQuestions(
  flags: AskFlags,
  question: string | undefined,
): { ok: true; questions: QuestionT[]; body: string } | { ok: false; error: string } {
  if (flags.form !== undefined) {
    if (question !== undefined || flags.choice?.length || flags.multi) {
      return { ok: false, error: '--form replaces the positional question, --choice, and --multi.' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(flags.form)
    } catch {
      return {
        ok: false,
        error: '--form must be JSON: {"questions": [{"text", "choices"?, "multi"?}], "body"?}.',
      }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `--form needs a "questions" array (1-${REPLY_MAX_QUESTIONS} entries).` }
    }
    const record = parsed as Record<string, unknown>
    const unknownKeys = Object.keys(record).filter((key) => key !== 'questions' && key !== 'body')
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        error: `Unknown --form ${unknownKeys.length === 1 ? 'key' : 'keys'}: ${unknownKeys.join(', ')}. Use "body" for Markdown context.`,
      }
    }
    if (!Array.isArray(record['questions'])) {
      return { ok: false, error: `--form needs a "questions" array (1-${REPLY_MAX_QUESTIONS} entries).` }
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
      return { ok: false, error: 'Pass form context in either --body or the form "body" key, not both.' }
    }
    const questions: QuestionT[] = []
    const usedIds = new Set<string>()
    for (const [index, entry] of formQuestions.entries()) {
      if (typeof entry !== 'object' || entry === null || typeof (entry as AskFormQuestion).text !== 'string') {
        return { ok: false, error: `Question ${index + 1} needs a "text" string.` }
      }
      const spec = entry as AskFormQuestion
      const built = buildOneQuestion(spec.text, spec.choices, spec.multi === true, index, usedIds)
      if ('error' in built) return { ok: false, error: `Question ${index + 1}: ${built.error}` }
      questions.push(built.question)
    }
    const context = flags.body ?? (record['body'] as string | undefined)
    return {
      ok: true,
      questions,
      body:
        context !== undefined && context.trim() !== ''
          ? context
          : questions.map((entry, index) => `${index + 1}. ${entry.text}`).join('\n'),
    }
  }

  if (question === undefined || question.trim() === '') {
    return { ok: false, error: 'The question cannot be empty.' }
  }
  const built = buildOneQuestion(question, flags.choice, flags.multi === true, 0, new Set())
  if ('error' in built) return { ok: false, error: built.error }
  const context = flags.body
  return {
    ok: true,
    questions: [built.question],
    body: context !== undefined && context.trim() !== '' ? context : built.question.text,
  }
}

function buildOneQuestion(
  text: string,
  choiceLabels: string[] | undefined,
  multi: boolean,
  index: number,
  usedIds: Set<string>,
): { question: QuestionT } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { error: 'the question text cannot be empty.' }
  if (trimmed.length > QUESTION_TEXT_MAX_LENGTH) {
    return {
      error:
        `a question must be readable where it is answered: keep it within ` +
        `${QUESTION_TEXT_MAX_LENGTH} characters and put the longer context in --body.`,
    }
  }
  const choices = parseChoices(choiceLabels)
  if (choices === 'invalid') return { error: CHOICE_USAGE }
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

function buildAskDraft(
  config: CliConfig,
  built: BuiltQuestions,
  flags: AskFlags,
  invocation: DraftInvocation,
  mediaIds: string[],
): { ok: true; draft: NotificationDraftT } | { ok: false; error: string } {
  const result = buildDraft(
    config,
    {
      title: built.questions[0]!.text,
      body: built.body,
      ...(flags.project !== undefined ? { project: flags.project } : {}),
      ...(mediaIds.length > 0 ? { image: mediaIds } : {}),
      ...(flags.imageAlt !== undefined ? { imageAlt: flags.imageAlt } : {}),
      reply: true,
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
  return { ok: true, draft: result.draft }
}

function recordRegisteredQuestion(
  deps: CommandDeps,
  sessionId: string,
  built: BuiltQuestions,
  draft: NotificationDraftT,
  json = false,
): number {
  let questionId: string
  try {
    questionId = registerQuestion(
      sessionId,
      deps.env,
      {
        question: built.questions[0]!.text,
        questions: built.questions,
        body: draft.presentation.body,
        ...(draft.project !== undefined ? { project: draft.project } : {}),
        ...(draft.source !== undefined ? { source: draft.source } : {}),
        ...(draft.presentation.media !== undefined ? { media: draft.presentation.media } : {}),
      },
      (deps.now ?? Date.now)(),
    )
  } catch (err) {
    log(deps).error('ask.registered', { ok: false, session: sessionId, message: String(err) })
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
  log(deps).info('ask.registered', {
    ok: true,
    session: sessionId,
    question_id: questionId,
    questions: built.questions.length,
    text_chars: built.questions[0]!.text.length,
    choices: built.questions[0]!.choices?.length ?? 0,
    media: draft.presentation.media?.length ?? 0,
  })
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
          request_id: null,
          provider_acceptance: 'not_available',
          questions: built.questions.map((entry) => ({
            id: entry.id,
            text: entry.text,
            ...(entry.choices === undefined ? {} : { choices: entry.choices }),
            ...(entry.multi === true ? { multi: true } : {}),
          })),
          status: `notifai status ${questionId}`,
          close: `notifai close ${questionId}`,
          next: {
            end_turn: true,
            in_this_turn:
              'Ask the question in the conversation and say what concrete work each possible answer will make you resume, then end the turn.',
            route_neutral:
              'Never say where the answer must arrive; it returns by whatever route the harness supports.',
            on_answer:
              'Acknowledge it, then resume the committed work without asking the user to confirm again.',
            answered_outside_notifai: `If they answer in the conversation instead, run \`notifai close ${questionId}\` before ending the turn so a later Stop will not send this question.`,
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
      deps.io.out(`${prefix}${entry.text} — ${kind}: ${entry.choices.map((choice) => choice.label).join(' / ')}`)
    } else if (built.questions.length > 1) {
      deps.io.out(`${prefix}${entry.text} — free text`)
    }
  }
  deps.io.out(
    built.questions.length > 1
      ? `${built.questions.length} questions registered locally as one form (${questionId}); they have not been submitted as a Notification Request and have no Provider Acceptance yet. Ask them in the conversation, state the concrete work you will resume for their answers, then end your turn.`
      : `Question registered locally (${questionId}); it has not been submitted as a Notification Request and has no Provider Acceptance yet. Ask it in the conversation, state the concrete work you will resume when the answer arrives, then end your turn.`,
  )
  deps.io.out(
    `Question settlement runs after registration. Inspect the original identity with \`notifai status ${questionId}\`; never register a replacement to check whether this one was sent.`,
  )
  deps.io.out('Before ending this turn, pre-commit in your own words to the work you will resume:')
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
    'A Notifai answer cannot answer a harness permission prompt or interactive picker; leave those to the harness and user.',
  )
  deps.io.out(
    `If they answer in this conversation instead, retire it with \`notifai close ${questionId}\` so a later Stop will not send it.`,
  )
  return EXIT.ok
}

async function uploadAskMedia(
  deps: CommandDeps,
  config: CliConfig,
  sessionId: string,
  built: BuiltQuestions,
  flags: AskFlags,
  invocation: DraftInvocation,
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
  return recordRegisteredQuestion(deps, sessionId, built, ready.draft, flags.json === true)
}

/**
 * Registers a question for turn-end routing. Returns immediately so the agent
 * can ask in prose and end its turn; the terminal keeps the question to itself
 * for `ask_grace_seconds` before it reaches any device.
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
  const built = buildQuestions(flags, question)
  if (!built.ok) {
    return askFailure(deps, flags, 'invalid_input', 'questions', built.error, 'fix the question input and retry')
  }
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
  const explicitProject = flags.project ?? explicitUseConfig.project.value ?? inferInvocationContext(deps.cwd).project
  if (explicitProject !== null) {
    const binding = projectBinding(deps.cwd, deps.env, explicitProject)
    if (binding !== null) enableProject(binding)
  }
  if (deps.store.load() === null) {
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
  const { active, contested } = resolveActiveHarness(deps.env, deps.cwd, now)
  let sessionId: string | undefined
  if (active !== null) {
    if (contested.length > 1) {
      return askFailure(
        deps,
        flags,
        'session_identity_ambiguous',
        'exact_session',
        `Several harness sessions could own this shell (${contested.map((candidate) => candidate.label).join(', ')}).`,
        'run the ask from a shell with one exact active harness session',
      )
    }
    if (!isHookInstallableHarness(active.harness)) {
      const capability = HERMES_QUESTION_ROUTING_UNAVAILABLE
      return askFailure(
        deps,
        flags,
        'question_routing_unavailable',
        'hook_contract',
        `${active.label}: ${capability.deliveryContract}`,
        'use a blocking `notifai send --reply` question',
      )
    }
    const exactState = active.sessionId === undefined
      ? null
      : readSessionState(active.sessionId, deps.env)
    const installationCwd = exactState?.activation_cwd ?? deps.cwd
    const installationDeps = installationCwd === deps.cwd ? deps : { ...deps, cwd: installationCwd }
    const installations = findInstallations(installationCwd, deps.env, deps.hookAdapterHome, deps.hookPlatform)
    const activeInstalled = installations.some(
      (installation) => installation.harness === active.harness,
    )
    if (!activeInstalled) {
      return askFailure(
        deps,
        flags,
        'hooks_not_installed',
        'hook_installation',
        `Notifai ${active.label} hooks are not installed for this project.`,
        `run \`notifai init --json\` from this ${active.label} session`,
      )
    }
    if (active.sessionId === undefined) {
      return askFailure(
        deps,
        flags,
        'session_identity_missing',
        'exact_session',
        `The active ${active.label} shell does not expose an exact session id.`,
        'use a blocking `notifai send --reply` question',
      )
    }
    const matchingInstallations = installations.filter(
      (installation) => installation.harness === active.harness,
    )
    const trustProblems = active.harness === 'codex'
      ? codexTrustProblems(matchingInstallations, deps.env)
      : []
    if (trustProblems.length > 0) {
      return askFailure(
        deps,
        flags,
        'codex_hook_approval_required',
        'hook_trust',
        `Question routing is not ready: ${trustProblems.join('; ')}. This question was not registered. Do not replace it with a short \`notifai send --reply\` wait: that command cannot resume this Agent Session after its reply timeout.`,
        'open `/hooks` in Codex and approve or enable the Notifai handlers',
        EXIT.usage,
        { user_action: CODEX_HOOK_APPROVAL_USER_ACTION },
      )
    }
    const routeProblems = activeQuestionRouteProblems(installationDeps, active, installations)
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
        'start one fresh Codex session, send one prompt in it, then retry `notifai ask --json`',
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
        `Question routing is not ready: ${routeProblems.join('; ')}`,
        'run `notifai init --json` and follow its question-routing remedy',
      )
    }
    const state = exactState ?? readSessionState(active.sessionId, deps.env)
    if (state.harness !== active.harness || state.last_prompt_at === undefined) {
      return askFailure(
        deps,
        flags,
        'session_not_activated',
        'user_prompt_submit',
        `This exact ${active.label} session has not fired UserPromptSubmit.`,
        `send one prompt in this ${active.label} session, then retry \`notifai ask --json\``,
      )
    }
    if (state.last_stop_at === undefined) {
      return askFailure(
        deps,
        flags,
        'stop_not_observed',
        'stop_hook',
        `This exact ${active.label} session has fired UserPromptSubmit, but its Stop hook has not been observed.`,
        `end one harmless turn, send a new prompt, then retry \`notifai ask --json\``,
      )
    }
    sessionId = active.sessionId
  } else {
    return askFailure(
      deps,
      flags,
      'session_identity_missing',
      'exact_session',
      'Could not prove which live Agent Session owns this command.',
      'run it from a supported harness with exact Agent Session identity, or use a blocking `notifai send --reply` question',
    )
  }
  if (!sessionId) {
    return askFailure(deps, flags, 'session_identity_missing', 'exact_session', 'No exact active Agent Session is available.', 'use a blocking `notifai send --reply` question')
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
  if (!routingConfig.ask_notifications.value) {
    return askFailure(
      deps,
      flags,
      'question_routing_disabled',
      'ask_notifications',
      'Question routing is disabled by ask_notifications=false.',
      'enable question routing or use a blocking `notifai send --reply` question',
    )
  }
  const source = resolveDraftInvocation(deps, flags, active)
  if (!source.ok) {
    return askFailure(deps, flags, 'invalid_source', 'source_context', source.error, 'remove the conflicting source override and retry')
  }
  if (source.invocation.source?.session_id !== sessionId) {
    return askFailure(
      deps,
      flags,
      'session_identity_mismatch',
      'exact_session',
      `The inferred session does not match the exact active ${active.label} session.`,
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
  if ((flags.image?.length ?? 0) > 0) {
    return uploadAskMedia(
      deps,
      routingConfig,
      sessionId,
      built,
      flags,
      source.invocation,
    )
  }
  return recordRegisteredQuestion(deps, sessionId, built, preflight.draft, flags.json === true)
}
