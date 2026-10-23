/**
 * `notifai ask --wait` in an OpenCode root session: the hand-back.
 *
 * OpenCode cannot bring an answer back once its session goes idle, but its
 * own `question` form holds the turn until the User answers, and the plugin
 * carries that form to the User's devices. So instead of holding in the
 * command, `ask --wait` registers the question and hands back the exact
 * `question` input that asks it. The agent opens it unchanged; the form
 * command links the form to this registration by its `source`, and the
 * registration's title, Body and images are what the devices show.
 *
 * Nothing here submits: the form command submits once the form is open. A
 * hand-back that is never opened ends at the next Stop, like any OpenCode
 * question. A worker, a plugin too old to say whether the session is one, or
 * a question the form cannot ask unchanged holds in the command instead.
 */
import { randomBytes } from 'node:crypto'
import type { QuestionT } from '@raidiant/notifai-protocol'
import type { HeldWaitInput } from './commands-ask-wait.js'
import { buildAskDraft, reportAskFailure } from './commands-ask.js'
import { EXIT, authedClient, log, type CommandDeps } from './commands-core.js'
import { resolveDraftInvocation, uploadImage } from './commands-send-support.js'
import { QuestionRegistrationChanged, registerQuestion } from './hook-lifecycle.js'
import { readSessionState } from './hook-session-state.js'
import type { OpencodeFormInput, PendingQuestion } from './hook-types.js'
import { findInstallations } from './install-hooks.js'
import { opencodeHandBackInput, recommendedFirst } from './opencode-question.js'
import { findOpenEqualQuestion } from './question-guard.js'

const OPEN_STEP = 'Say in the conversation what each answer will make you do, then call the `question` tool with exactly the `open_form` input, unchanged. It reaches the User\'s devices with your title, Body and images, and holds your turn until the User answers.'

const ON_ANSWER = 'When the answer arrives, resume the matching work without asking the user to confirm again.'

/**
 * The hand-back for this `ask --wait`, or null when this shell or question
 * has none and the wait holds in the command.
 */
export function opencodeHandBack(deps: CommandDeps, input: HeldWaitInput): Promise<number> | null {
  // Native forms in a disabled cwd Project stay local; an explicit Projectless wait must submit directly.
  if (input.flags.projectless === true) return null
  const active = input.route.active
  if (active?.harness !== 'opencode' || active.worker !== false || active.sessionId === undefined) return null
  const sessionId = active.sessionId
  const state = readSessionState(sessionId, deps.env)
  if (state.harness !== 'opencode' || state.last_prompt_at === undefined) return null
  if (!findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).some((item) => item.harness === 'opencode')) return null
  if (deps.store.load() === null) return null
  const questions = recommendedFirst(input.built.questions)
  const questionId = `q_${randomBytes(12).toString('base64url')}`
  const handBack = opencodeHandBackInput(questions, input.built, questionId)
  if (handBack === null) return null
  const source = resolveDraftInvocation(deps, input.flags, active)
  if (!source.ok || source.invocation.source?.session_id !== sessionId) return null
  return handBackQuestion(deps, input, sessionId, questions, questionId, handBack, source.invocation)
}

async function handBackQuestion(
  deps: CommandDeps,
  input: HeldWaitInput,
  sessionId: string,
  questions: QuestionT[],
  questionId: string,
  handBack: OpencodeFormInput,
  invocation: Parameters<typeof buildAskDraft>[3],
): Promise<number> {
  const { flags, config } = input
  const built = { ...input.built, questions }
  const placeholders = (flags.image ?? []).map((_, index) => `med_pending_${index + 1}`)
  const preflight = buildAskDraft(config, built, flags, invocation, placeholders)
  if (!preflight.ok) {
    return reportAskFailure(deps, flags, { code: 'invalid_draft', check_id: 'draft', exit_code: EXIT.usage,
      message: preflight.error, remedy: 'fix the reported field and retry' })
  }
  // The duplicate guard runs before any upload; registration repeats it under the lock.
  const open = findOpenEqualQuestion(readSessionState(sessionId, deps.env), questions)
  if (open !== undefined) return reportOpen(deps, input, open)
  const authed = authedClient(deps, config)
  if (authed === null) {
    return reportAskFailure(deps, flags, { code: 'auth_required', check_id: 'credential', exit_code: EXIT.auth,
      message: 'Question routing is not paired on this machine.', remedy: 'run `notifai init --json`' })
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
      return reportAskFailure(deps, flags, { code: 'media_upload_failed', check_id: 'media', exit_code: uploaded.exit,
        message: uploaded.error ?? 'The image upload failed.', remedy: 'fix the reported image or network problem, then retry the same ask' })
    }
    mediaIds.push(uploaded.mediaId)
  }
  const ready = buildAskDraft(config, built, flags, invocation, mediaIds)
  if (!ready.ok) {
    return reportAskFailure(deps, flags, { code: 'invalid_draft', check_id: 'draft', exit_code: EXIT.usage,
      message: ready.error, remedy: 'fix the reported field and retry' })
  }
  const { draft } = ready
  let registered
  try {
    registered = registerQuestion(sessionId, deps.env, {
      question_id: questionId,
      question: questions[0]!.text,
      title: draft.presentation.title,
      summary: draft.presentation.summary,
      service_identity: authed.service,
      questions,
      ...(draft.presentation.body === undefined ? {} : { body: draft.presentation.body }),
      ...(draft.project === undefined ? {} : { project: draft.project }),
      ...(draft.source === undefined ? {} : { source: draft.source }),
      ...(draft.presentation.media === undefined ? {} : { media: draft.presentation.media }),
      opencode_hand_back: handBack,
    }, (deps.now ?? Date.now)(), undefined, {
      machineStillMatches: () => {
        const current = deps.store.load()
        return current !== null && current.machineId === authed.service.machine_id && current.baseUrl === authed.service.base_url
      },
    })
  } catch (err) {
    const changed = err instanceof QuestionRegistrationChanged
    return reportAskFailure(deps, flags, {
      code: changed ? (err.reason === 'credential' ? 'auth_required' : 'session_changed') : 'registration_failed',
      check_id: changed ? (err.reason === 'credential' ? 'credential' : 'question_registration') : 'question_registration',
      exit_code: changed && err.reason === 'credential' ? EXIT.auth : EXIT.failed,
      message: changed ? err.message : `Could not register the question: ${err instanceof Error ? err.message : String(err)}`,
      remedy: changed ? 'retry the same ask from the current Agent Session and intended signed-in machine'
        : 'retire an older pending question if the limit was reached, then retry the same ask',
    })
  }
  if (!registered.registered) {
    const existing = findOpenEqualQuestion(readSessionState(sessionId, deps.env), questions)
    if (existing !== undefined) return reportOpen(deps, input, existing)
  }
  log(deps).info('ask.registered', { ok: true, session: sessionId, question_id: questionId, questions: questions.length,
    media: draft.presentation.media?.length ?? 0, hand_back: 'opencode-question' })
  return printHandBack(deps, input, questionId, questions, handBack, true)
}

/** This question is already open in this session: its own hand-back again, or the form that carries it. */
function reportOpen(deps: CommandDeps, input: HeldWaitInput, open: PendingQuestion): number {
  log(deps).info('ask.registered', { ok: true, question_id: open.question_id, linked: true, questions: input.built.questions.length })
  if (open.opencode_hand_back !== undefined) {
    return printHandBack(deps, input, open.question_id!, open.questions ?? input.built.questions, open.opencode_hand_back, false)
  }
  const message = `This question is already open in this Agent Session as ${open.question_id}, in a \`question\` form: nothing new was registered. Its answer arrives in that form.`
  if (input.flags.json === true) {
    deps.io.out(JSON.stringify({ registered: false, already_open: { question_id: open.question_id }, question_id: open.question_id,
      message, status: `notifai status ${open.question_id}` }, null, 2))
  } else {
    deps.io.out(message)
  }
  return EXIT.ok
}

function printHandBack(
  deps: CommandDeps,
  input: HeldWaitInput,
  questionId: string,
  questions: readonly QuestionT[],
  handBack: OpencodeFormInput,
  registered: boolean,
): number {
  const close = `If you no longer need this question, run \`notifai close ${questionId}\`.`
  const message = registered
    ? `Question registered (${questionId}) for OpenCode's \`question\` form: it reaches the User's devices once you open the form.`
    : `This question is already open in this Agent Session as ${questionId}: nothing new was registered, and a new Body or images were not applied.`
  if (input.flags.json === true) {
    deps.io.out(JSON.stringify({
      registered,
      ...(registered ? {} : { already_open: { question_id: questionId } }),
      question_id: questionId,
      message,
      questions: questions.map((entry) => ({
        id: entry.id,
        text: entry.text,
        ...(entry.choices === undefined ? {} : { choices: entry.choices }),
        ...(entry.multi === true ? { multi: true } : {}),
      })),
      open_form: { tool: 'question', input: handBack },
      status: `notifai status ${questionId}`,
      close: `notifai close ${questionId}`,
      next: { end_turn: false, in_this_turn: OPEN_STEP, on_answer: ON_ANSWER, if_not_opened: close },
    }, null, 2))
    return EXIT.ok
  }
  deps.io.out(message)
  deps.io.out('Say in the conversation what each answer will make you do:')
  for (const [index, entry] of questions.entries()) {
    const prefix = questions.length > 1 ? `Question ${index + 1}, ` : ''
    for (const choice of entry.choices ?? []) {
      deps.io.out(`- ${prefix}If the answer is ${JSON.stringify(choice.label)}: state the concrete work you will resume.`)
    }
    deps.io.out(`- ${prefix}For an unexpected typed answer: state how it will determine the concrete work you resume.`)
  }
  deps.io.out('Then call the `question` tool with exactly this input, unchanged; it holds your turn until the User answers:')
  deps.io.out(JSON.stringify(handBack))
  deps.io.out(ON_ANSWER)
  deps.io.out(close)
  return EXIT.ok
}
