import type { ListRepliesResponse,QuestionT,ReplyAnswerT,ReplyView,SubmitNotificationRequestT } from '@raidiant/notifai-protocol'
import { execFileSync } from 'node:child_process'
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { pickerForm } from './claude-question-bindings.js'
import type { ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { globalConfigPath } from './config.js'
import { registerQuestion } from './hook-lifecycle.js'
import { readSessionState,updateSessionState } from './hook-session-state.js'
import type { PendingQuestion } from './hook-types.js'
import {
checkFormImage,
opencodeHandBackInput,
opencodeOwedAcknowledgement,
opencodePickerQuestions,
opencodeQuestionCommand,
opencodeQuestionRequest,
recommendedFirst,
type OpencodeQuestionOutbound,
type OpencodeQuestionRequest
} from './opencode-question.js'
import { disableProject,enableProject,projectBinding } from './project-enablement.js'

const SESSION = 'ses_opencode_parent'
const REQUEST: OpencodeQuestionRequest = {
  id: 'que_0001',
  sessionID: SESSION,
  questions: [
    { question: 'Which environment should I deploy to?', header: 'Target',
      options: [{ label: 'Staging', description: 'Safe' }, { label: 'Production', description: 'Live' }] },
    { question: 'Which checks should run first?', header: 'Checks', multiple: true,
      options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }, { label: 'End to end', description: '' }] },
  ],
}

function form() {
  const built = pickerForm(opencodePickerQuestions(REQUEST))
  if ('error' in built) throw new Error(built.error)
  return built
}

function reply(answers: ReplyView['answers'], seq = 1): ReplyView {
  return { reply_id: `rpl_${seq}`, seq, delivery_id: null, device_id: 'dev_1', device_name: 'Phone', text: 'answer',
    answers, source: null, created_at: '2026-10-20T00:00:00Z' }
}

describe('OpenCode question forms as device questions', () => {
  it('accepts only an exact OpenCode question request', () => {
    expect(opencodeQuestionRequest(REQUEST)).toEqual({
      ...REQUEST,
      questions: [
        REQUEST.questions[0],
        { ...REQUEST.questions[1], options: REQUEST.questions[1]!.options.map(({ label }) => ({ label })) },
      ],
    })
    // OpenCode 2's plugin reports its form by the form's own ID.
    expect(opencodeQuestionRequest({ ...REQUEST, id: 'frm_16574734c001E9W7EPH87wAlrO' })?.id).toBe('frm_16574734c001E9W7EPH87wAlrO')
    expect(opencodeQuestionRequest({ ...REQUEST, id: 'not-a-question' })).toBeNull()
    expect(opencodeQuestionRequest({ ...REQUEST, sessionID: '' })).toBeNull()
    expect(opencodeQuestionRequest({ ...REQUEST, questions: [] })).toBeNull()
    expect(opencodeQuestionRequest({ ...REQUEST, questions: [{ question: 'x', options: [{ label: 3 }] }] })).toBeNull()
  })
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup(options: {
  enabled?: boolean; disabled?: boolean; signedIn?: boolean; signals?: NodeJS.Signals[]; settings?: string
  sleep?: (ms: number) => Promise<void>
  /** The plugin's first frame; by default an older plugin's already-open form. */
  first?: (root: string) => Record<string, unknown>
  /** Runs before the command starts, e.g. to register a hand-back. */
  before?: (root: string, env: NodeJS.ProcessEnv) => void
  /** The reply window has already ended, as after a device dismissal. */
  expired?: boolean
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-question-'))
  roots.push(root)
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  execFileSync('git', ['init', '-q'], { cwd: root })
  if (options.enabled !== false) enableProject(projectBinding(root, env)!)
  if (options.disabled === true) disableProject(projectBinding(root, env)!)
  if (options.settings !== undefined) {
    mkdirSync(path.dirname(globalConfigPath(env)), { recursive: true })
    writeFileSync(globalConfigPath(env), options.settings)
  }
  let answer: ReplyView | null = null
  let releasePoll: (() => void) | null = null
  const submitted: SubmitNotificationRequestT[] = []
  const closes: string[] = []
  const response = (replies: ReplyView[]): ListRepliesResponse => ({
    request_id: 'req_opencode', reply_expires_at: options.expired === true ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
    agent_acknowledgement_required: true, agent_acknowledgement_text_required: true, agent_acknowledgement: null, replies,
  })
  const uploads: Array<{ media_type: string }> = []
  const client = {
    capabilities: vi.fn(async () => ({ fields: [], notification_contract_fingerprint: 'fp' })),
    submit: vi.fn(async (body: SubmitNotificationRequestT) => {
      submitted.push(body)
      return { request_id: 'req_opencode', reply_expires_at: '2099-01-01T00:00:00Z', agent_acknowledgement_required: true,
        agent_acknowledgement_text_required: true, replayed: false, overall: 'provider_accepted_all', deliveries: [], warnings: [] }
    }),
    // A long poll: returns at once when an answer exists, otherwise when released.
    replies: vi.fn(async () => {
      if (answer === null) await new Promise<void>(resolve => { releasePoll = resolve; setTimeout(resolve, 50) })
      return response(answer === null ? [] : [answer])
    }),
    closeReplies: vi.fn(async (_id: string, disposition: string) => {
      closes.push(disposition)
      return { ...response(answer === null ? [] : [answer]), close_disposition: disposition,
        delivered_reply_seq: disposition === 'deliver' && answer !== null ? answer.seq : null }
    }),
    recordHarnessAnswer: vi.fn(async (_id: string, body: { answers: ReplyAnswerT[] }) => ({
      status: 'recorded', reply_seq: 7, complete: true, other_submissions: [],
      answer_version: { version_id: 'rpl_native', answers: body.answers },
    })),
    putAgentAcknowledgement: vi.fn(async (_id: string, body: { text: string }) => ({
      status: 'recorded', agent_acknowledgement: { text: body.text, created_at: '2026-10-20T00:00:01Z' },
    })),
    createMediaUpload: vi.fn(async (body: { media_type: string }) => {
      uploads.push(body)
      return { media_id: `med_${uploads.length}`, upload_url: 'https://upload.test', headers: {} }
    }),
    uploadMedia: vi.fn(async () => undefined),
  }
  const deps: CommandDeps = {
    cwd: root, env,
    io: { out: () => {}, err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => options.signedIn === false ? null
      : ({ machineId: 'mch_test', secret: 'test-secret', baseUrl: 'https://notifai.test', machineName: 'test' }),
    save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
    clientFactory: () => client as unknown as ApiClient,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const frames: OpencodeQuestionOutbound[] = []
  let buffered = ''
  const waiters: Array<() => void> = []
  output.on('data', chunk => {
    buffered += String(chunk)
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffered.slice(0, newline)) as OpencodeQuestionOutbound)
      buffered = buffered.slice(newline + 1)
      for (const waiter of waiters.splice(0)) waiter()
    }
  })
  const frame = async (type: OpencodeQuestionOutbound['type']): Promise<OpencodeQuestionOutbound> => {
    for (;;) {
      const found = frames.find(item => item.type === type)
      if (found !== undefined) return found
      await new Promise<void>(resolve => waiters.push(resolve))
    }
  }
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`)
  options.before?.(root, env)
  const run = opencodeQuestionCommand(deps, input, output, options.signals ?? [])
  send(options.first?.(root) ?? { type: 'ask', session_id: SESSION, cwd: root, request: REQUEST, session_label: 'Deploy the witness build' })
  return {
    output, root, env, deps, client, submitted, closes, frames, frame, send, run, input, uploads,
    answerWith: (value: ReplyView) => { answer = value; releasePoll?.() },
  }
}

describe('opencode-question command', () => {
  it('returns a device answer to the plugin and settles it once the form took it', async () => {
    const t = setup()
    expect(await t.frame('registered')).toEqual({ type: 'registered', request_id: 'req_opencode' })
    expect(t.submitted[0]!.draft.reply?.questions.map(question => question.text)).toEqual([
      'Which environment should I deploy to?', 'Which checks should run first?',
    ])
    expect(t.submitted[0]!.draft.source).toMatchObject({ session_id: SESSION, harness: 'opencode', session_label: 'Deploy the witness build' })
    const built = form()
    const [target, checks] = built.questions
    t.answerWith(reply([
      { question_id: target!.id, choice_ids: [target!.choices![1]!.id], text: null },
      { question_id: checks!.id, choice_ids: [checks!.choices![0]!.id], text: null },
    ]))
    expect(await t.frame('answer')).toEqual({
      type: 'answer', request_id: 'req_opencode', answers: [['Production'], ['Lint']],
      acknowledgement: 'notifai acknowledge req_opencode --text <text>',
      acknowledgement_context: 'Notifai: the answer to your question came from the user\'s device, for request req_opencode. ' +
        'Before the work it causes, run `notifai acknowledge req_opencode --text <text>` with non-empty text naming the concrete ' +
        'work this Agent Session will do itself because of the reply; a bare acknowledgement is insufficient. Once a request reports recorded or ' +
        'replayed, its acknowledgement is complete; do not repeat it for a later turn or unrelated event.',
    })
    t.send({ type: 'applied' })
    expect(await t.frame('done')).toEqual({ type: 'done', outcome: 'device-answer-delivered' })
    await t.run
    expect(t.closes).toEqual(['deliver'])
    expect(t.client.recordHarnessAnswer).not.toHaveBeenCalled()
  })
})

/** A form the current plugin asks about before OpenCode opens it. */
const CALL = 'call_question_1'
function formFrame(root: string, questions: unknown = REQUEST.questions, extras: Record<string, unknown> = {}) {
  return { type: 'form', session_id: SESSION, cwd: root, call_id: CALL, questions, extras, session_label: 'Deploy the witness build' }
}
const opened = (questions: unknown = REQUEST.questions) =>
  ({ type: 'opened', request: { ...REQUEST, questions, tool: { messageID: 'msg_1', callID: CALL } } })

/** What `notifai ask --wait` registers for OpenCode, as its hand-back. */
function registerHandBack(env: NodeJS.ProcessEnv, questions: QuestionT[], extra: Partial<PendingQuestion> = {}): string {
  const questionId = `q_handback${Math.random().toString(36).slice(2, 8)}`
  updateSessionState(SESSION, env, (state) => ({ ...state, harness: 'opencode', last_prompt_at: Date.now() - 1_000 }))
  const input = opencodeHandBackInput(questions, { title: 'Deploy target' }, questionId)
  if (input === null) throw new Error('not linkable')
  registerQuestion(SESSION, env, {
    question_id: questionId, question: questions[0]!.text, title: 'Deploy target', summary: questions[0]!.text,
    questions, body: 'Staging has the new migrations.', opencode_hand_back: input, ...extra,
  })
  return questionId
}
const DEPLOY: QuestionT[] = [{ id: 'target', text: 'Which environment should I deploy to?', choices: [
  { id: 'production', label: 'Production', description: 'Live' },
  { id: 'staging', label: 'Staging', recommended: true },
] }]

describe('a form asked about before it opens', () => {
  it('carries a form the agent opened itself, with its own title, Body and checked images', async () => {
    const t = setup({ first: (root) => {
      writeFileSync(path.join(root, 'diff.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))
      return formFrame(root, REQUEST.questions, { title: 'Release plan', body: 'The diff: ![diff](media:1)',
        images: [{ path: 'diff.png', alt: 'The diff' }] })
    } })
    const verdict = await t.frame('accepted') as { question_id: string }
    expect(verdict.question_id).toMatch(/^q_/)
    t.send(opened())
    await t.frame('registered')
    expect(t.uploads).toEqual([expect.objectContaining({ media_type: 'image/png' })])
    const draft = t.submitted[0]!.draft
    expect(draft.presentation).toMatchObject({ title: 'Release plan', media: [{ media_id: 'med_1', alt: 'The diff' }] })
    expect(draft.presentation.body).toContain('The diff: ![diff](media:med_1)')
    const built = form()
    t.answerWith(reply(built.questions.map((question) => ({ question_id: question.id, choice_ids: [question.choices![0]!.id], text: null }))))
    expect(await t.frame('answer')).toMatchObject({ answers: [['Staging'], ['Lint']] })
    t.send({ type: 'applied' })
    await t.run
    // Settled: the registration is history, so a form naming it is told it was answered.
    const state = readSessionState(SESSION, t.env)
    expect(state.pending ?? []).toEqual([])
    expect(state.question_history).toEqual([expect.objectContaining({ question_id: verdict.question_id, state: 'answered' })])
  })

  it('refuses a form that names a hand-back but asks something else, with the input to open', async () => {
    let questionId = ''
    const t = setup({
      before: (_root, env) => { questionId = registerHandBack(env, recommendedFirst(DEPLOY)) },
      first: (root) => formFrame(root, REQUEST.questions, { source: `notifai:${readSessionState(SESSION, t0Env(root)).pending![0]!.question_id}` }),
    })
    const refused = await t.frame('refused') as { message: string }
    const handBack = readSessionState(SESSION, t.env).pending![0]!.opencode_hand_back!
    expect(refused.message).toBe(
      `This is not the question \`notifai ask --wait\` handed back (\`${questionId}\`). To ask that one, open exactly this input: ${JSON.stringify(handBack)}. ` +
      `For a different question, run \`notifai ask --wait\` for it. If you no longer need \`${questionId}\`, run \`notifai close ${questionId}\`.`)
    await t.run
    expect(t.submitted).toEqual([])
  })
})

describe('the input `ask --wait` hands back', () => {
  it('asks exactly the registered questions, recommended choice first, titled for the form', () => {
    const questions = recommendedFirst(DEPLOY)
    expect(opencodeHandBackInput(questions, { title: 'Deploy target' }, 'q_1')).toEqual({
      questions: [{ question: 'Which environment should I deploy to?', header: 'Deploy target',
        options: [{ label: 'Staging (Recommended)', description: '' }, { label: 'Production', description: 'Live' }] }],
      source: 'notifai:q_1',
    })
  })

  it('has none for a question the form cannot ask unchanged', () => {
    expect(opencodeHandBackInput([{ id: 'q', text: 'Pick?', choices: DEPLOY[0]!.choices!.map(choice => ({ ...choice, recommended: true })) }], {}, 'q_1')).toBeNull()
    const seven = Array.from({ length: 7 }, (_, index) => ({ id: `c${index}`, label: `Choice ${index}` }))
    expect(opencodeHandBackInput([{ id: 'pick', text: 'Pick one', choices: seven }], { title: 'Pick' }, 'q_1')).toBeNull()
  })
})

describe('form images', () => {
  it('accepts only a regular local file within the limit whose bytes match its type', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-image-'))
    roots.push(root)
    writeFileSync(path.join(root, 'ok.gif'), 'GIF89a....')
    writeFileSync(path.join(root, 'ok.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    mkdirSync(path.join(root, 'dir.png'))
    expect(checkFormImage(root, 'ok.gif')).toEqual({ path: path.join(root, 'ok.gif') })
    expect(checkFormImage(root, 'ok.jpg')).toEqual({ path: path.join(root, 'ok.jpg') })
    expect(checkFormImage(root, 'https://example.test/a.png')).toEqual({ error: 'image "https://example.test/a.png" must be a local file path.' })
    expect(checkFormImage(root, 'notes.txt')).toEqual({ error: 'image "notes.txt" must be a JPEG, PNG or GIF file.' })
    expect(checkFormImage(root, 'dir.png')).toEqual({ error: 'image "dir.png" is not a regular file.' })
    expect(checkFormImage(root, 'missing.png')).toEqual({ error: 'image "missing.png" does not exist.' })
  })
})

/** The isolated environment `setup` builds for a root, before the command starts. */
function t0Env(root: string): NodeJS.ProcessEnv {
  return { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
}

it('owes a text-off acknowledgement exactly as shown, never asking for words', () => {
  const owed = opencodeOwedAcknowledgement('req_quiet', 'notifai acknowledge req_quiet', false)
  expect(owed).toContain('run `notifai acknowledge req_quiet` exactly as shown; this account turned acknowledgement text off')
  expect(owed).not.toMatch(/saying what/)
})
