import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ListRepliesResponse, QuestionT, ReplyAnswerT, ReplyView, SubmitNotificationRequestT } from '@raidiant/notifai-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickerForm } from './claude-question-bindings.js'
import { CLAUDE_PICKER_DISMISSED } from './claude-question-hooks.js'
import type { ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { globalConfigPath } from './config.js'
import { registerQuestion } from './hook-lifecycle.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import type { PendingQuestion } from './hook-types.js'
import {
  OPENCODE_FORM_UNCARRIABLE,
  OPENCODE_NATIVE_ACKNOWLEDGEMENT,
  checkFormImage,
  opencodeHandBackInput,
  recommendedFirst,
  opencodeDeviceAnswers,
  opencodeNativeAnswers,
  opencodePickerQuestions,
  opencodeQuestionCommand,
  opencodeQuestionRequest,
  sweepAbandonedOpencodeForms,
  type OpencodeQuestionOutbound,
  type OpencodeQuestionRequest,
} from './opencode-question.js'
import { disableProject, enableProject, projectBinding, projectEnablementState } from './project-enablement.js'

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
    expect(opencodeQuestionRequest({ ...REQUEST, id: 'not-a-question' })).toBeNull()
    expect(opencodeQuestionRequest({ ...REQUEST, sessionID: '' })).toBeNull()
    expect(opencodeQuestionRequest({ ...REQUEST, questions: [] })).toBeNull()
    expect(opencodeQuestionRequest({ ...REQUEST, questions: [{ question: 'x', options: [{ label: 3 }] }] })).toBeNull()
  })

  it('returns a device answer as the form\'s own labels and typed text', () => {
    const built = form()
    const [target, checks] = built.questions
    const staging = target!.choices!.find(choice => choice.label === 'Staging')!.id
    const lint = checks!.choices!.find(choice => choice.label === 'Lint')!.id
    const tests = checks!.choices!.find(choice => choice.label === 'Tests')!.id
    expect(opencodeDeviceAnswers(built, reply([
      { question_id: target!.id, choice_ids: [staging], text: null },
      { question_id: checks!.id, choice_ids: [lint, tests], text: 'and the smoke test' },
    ]))).toEqual([['Staging'], ['Lint', 'Tests', 'and the smoke test']])
    // A partial answer is not the form's answer.
    expect(opencodeDeviceAnswers(built, reply([{ question_id: target!.id, choice_ids: [staging], text: null }]))).toBeNull()
  })

  it('reports an answer given in OpenCode as choices or typed text', () => {
    const built = form()
    const [target, checks] = built.questions
    expect(opencodeNativeAnswers(built, [['Production'], ['Tests', 'my own check']])).toEqual([
      { question_id: target!.id, choice_ids: [target!.choices!.find(choice => choice.label === 'Production')!.id] },
      { question_id: checks!.id, choice_ids: [checks!.choices!.find(choice => choice.label === 'Tests')!.id], text: 'my own check' },
    ])
    expect(opencodeNativeAnswers(built, [['Wait until Monday'], ['Lint']])?.[0]).toEqual({
      question_id: target!.id, text: 'Wait until Monday',
    })
    expect(opencodeNativeAnswers(built, [['Production']])).toBeNull()
    expect(opencodeNativeAnswers(built, [[], ['Lint']])).toBeNull()
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
    })
    t.send({ type: 'applied' })
    expect(await t.frame('done')).toEqual({ type: 'done', outcome: 'device-answer-delivered' })
    await t.run
    expect(t.closes).toEqual(['deliver'])
    expect(t.client.recordHarnessAnswer).not.toHaveBeenCalled()
  })

  it('records an answer given in OpenCode so the devices stop asking', async () => {
    const t = setup()
    await t.frame('registered')
    t.send({ type: 'native', answers: [['Staging'], ['Tests', 'End to end']] })
    expect(await t.frame('done')).toEqual({ type: 'done', outcome: 'native-answer-recorded' })
    await t.run
    const built = form()
    expect(t.client.recordHarnessAnswer).toHaveBeenCalledWith('req_opencode', expect.objectContaining({
      session_id: SESSION,
      answers: [
        { question_id: built.questions[0]!.id, choice_ids: [built.questions[0]!.choices![0]!.id] },
        { question_id: built.questions[1]!.id, choice_ids: [built.questions[1]!.choices![1]!.id, built.questions[1]!.choices![2]!.id] },
      ],
    }))
    expect(t.client.putAgentAcknowledgement).toHaveBeenCalledWith('req_opencode', {
      session_id: SESSION, reply_seq: 7, text: OPENCODE_NATIVE_ACKNOWLEDGEMENT,
    })
    // Nothing in OpenCode waits for a later answer, so the window closes.
    expect(t.closes).toEqual(['retire'])
  })

  it('withdraws the device question when the form is dismissed', async () => {
    const t = setup()
    await t.frame('registered')
    t.send({ type: 'dismissed' })
    expect(await t.frame('done')).toEqual({ type: 'done', outcome: 'dismissed' })
    await t.run
    expect(t.closes).toEqual(['retire'])
  })

  it('withdraws the device question when OpenCode closes, and returns nothing later', async () => {
    const t = setup()
    await t.frame('registered')
    t.input.end()
    await t.run
    expect(t.frames.at(-1)).toEqual({ type: 'done', outcome: 'session-closed' })
    expect(t.closes).toEqual(['retire'])
    expect(t.frames.some(item => item.type === 'answer')).toBe(false)
  })

  it('keeps a device answer the form no longer accepts from being reported as delivered', async () => {
    const t = setup()
    await t.frame('registered')
    const built = form()
    t.answerWith(reply(built.questions.map(question => ({ question_id: question.id, choice_ids: [question.choices![0]!.id], text: null }))))
    await t.frame('answer')
    t.send({ type: 'stale' })
    expect(await t.frame('done')).toEqual({ type: 'done', outcome: 'form-already-settled' })
    await t.run
  })

  it('registers a form in a Project with no record, and leaves the Project as it was', async () => {
    const t = setup({ enabled: false })
    expect(await t.frame('registered')).toEqual({ type: 'registered', request_id: 'req_opencode' })
    expect(t.submitted).toHaveLength(1)
    expect(projectEnablementState(projectBinding(t.root, t.env))).toBe('unset')
    t.input.end()
    await t.run
  })

  it('holds the form in OpenCode for the terminal-first delay before it reaches the devices', async () => {
    const slept: Array<{ ms: number; submitted: number }> = []
    const t = setup({ settings: 'ask_grace_seconds = 30\n', sleep: async (ms) => {
      slept.push({ ms, submitted: t.submitted.length })
    } })
    expect(await t.frame('registered')).toEqual({ type: 'registered', request_id: 'req_opencode' })
    expect(slept).toEqual([{ ms: 30_000, submitted: 0 }])
    expect(t.submitted).toHaveLength(1)
    t.input.end()
    await t.run
  })

  it.each([
    [{ type: 'native', answers: [['Staging'], ['Lint']] }],
    [{ type: 'dismissed' }],
  ])('keeps a form settled in OpenCode during its delay off the devices: %o', async (settledWith) => {
    const t = setup({ settings: 'ask_grace_seconds = 30\n', sleep: () => new Promise<void>(() => {}) })
    t.send(settledWith)
    expect(await t.frame('terminal')).toEqual({ type: 'terminal', reason: 'settled-in-opencode' })
    await t.run
    expect(t.submitted).toEqual([])
    expect(t.client.recordHarnessAnswer).not.toHaveBeenCalled()
  })

  it.each([
    [{ disabled: true }, 'project-disabled'],
    [{ settings: 'ask_notifications = false\n' }, 'question-notifications-off'],
    [{ signedIn: false }, 'not-signed-in'],
  ])('leaves the form to OpenCode alone when %o', async (options, reason) => {
    const t = setup(options)
    expect(await t.frame('terminal')).toEqual({ type: 'terminal', reason })
    await t.run
    expect(t.submitted).toEqual([])
  })

  it('treats a hang-up as the session closing', async () => {
    const t = setup({ signals: ['SIGHUP'] })
    await t.frame('registered')
    process.emit('SIGHUP', 'SIGHUP')
    await t.run
    expect(t.frames.at(-1)).toEqual({ type: 'done', outcome: 'session-closed' })
    expect(t.closes).toEqual(['retire'])
    expect(process.listenerCount('SIGHUP')).toBe(0)
  })

  it('withdraws a form whose command died with OpenCode, and only that one', async () => {
    const t = setup()
    await t.frame('registered')
    const dir = path.join(t.env.XDG_STATE_HOME, 'notifai', 'opencode-questions')
    const [file] = readdirSync(dir)
    const live = JSON.parse(readFileSync(path.join(dir, file!), 'utf8')) as { owner: { pid: number } }
    expect(live).toMatchObject({ request_id: 'req_opencode', session_id: SESSION, machine_id: 'mch_test', owner: { pid: process.pid } })
    expect(await sweepAbandonedOpencodeForms(t.deps)).toBe(0)
    expect(t.closes).toEqual([])
    expect(await sweepAbandonedOpencodeForms(t.deps, { liveness: () => 'gone' })).toBe(1)
    expect(t.closes).toEqual(['retire'])
    expect(readdirSync(dir)).toEqual([])
    t.input.end()
    await t.run
  })

  it('withdraws, instead of crashing, when OpenCode vanishes mid-write', async () => {
    const t = setup()
    await t.frame('registered')
    t.output.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(await t.run).toBe(0)
    expect(t.closes).toEqual(['retire'])
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

  it('links the form `ask --wait` handed back, and submits that registration as it was asked', async () => {
    let questionId = ''
    const t = setup({
      before: (_root, env) => { questionId = registerHandBack(env, recommendedFirst(DEPLOY)) },
      first: (root) => {
        const pending = readSessionState(SESSION, t0Env(root)).pending![0]!
        return formFrame(root, pending.opencode_hand_back!.questions, { source: pending.opencode_hand_back!.source })
      },
    })
    expect(await t.frame('accepted')).toEqual({ type: 'accepted', question_id: questionId })
    const handBack = readSessionState(SESSION, t.env).pending![0]!.opencode_hand_back!
    expect(handBack.questions[0]!.options.map((option) => option.label)).toEqual(['Staging (Recommended)', 'Production'])
    t.send(opened(handBack.questions))
    await t.frame('registered')
    expect(t.submitted[0]!.draft.presentation).toMatchObject({ title: 'Deploy target', body: 'Staging has the new migrations.' })
    expect(t.submitted[0]!.draft.reply?.questions[0]!.choices!.map((choice) => choice.id)).toEqual(['staging', 'production'])
    // The device answers with the registration's ids; the form gets its own labels.
    t.answerWith(reply([{ question_id: 'target', choice_ids: ['staging'], text: null }]))
    expect(await t.frame('answer')).toMatchObject({ answers: [['Staging (Recommended)']] })
    t.send({ type: 'applied' })
    await t.run
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

  it('refuses any other form while a hand-back waits for its own', async () => {
    let questionId = ''
    const t = setup({
      before: (_root, env) => { questionId = registerHandBack(env, recommendedFirst(DEPLOY)) },
      first: (root) => formFrame(root),
    })
    expect((await t.frame('refused') as { message: string }).message).toContain(`handed back (\`${questionId}\`)`)
    await t.run
  })

  it.each([
    ['answered', '`q_ended` was already answered, and that answer was delivered to you. Do not ask it again.'],
    ['retired', '`q_ended` has expired without an answer: carry on without it, or ask in the conversation.'],
    ['withdrawn', '`q_ended` has expired without an answer: carry on without it, or ask in the conversation.'],
  ] as const)('refuses a form naming a question that is %s', async (ended, message) => {
    const t = setup({
      before: (_root, env) => updateSessionState(SESSION, env, (state) => ({ ...state, question_history: [{ question_id: 'q_ended', state: ended }] })),
      first: (root) => formFrame(root, REQUEST.questions, { source: 'notifai:q_ended' }),
    })
    expect(await t.frame('refused')).toEqual({ type: 'refused', message })
    await t.run
  })

  it('refuses a form the devices cannot show, but only where forms reach them', async () => {
    const wide = [{ question: 'Pick one', header: 'Pick', options: [{ label: 'Only', description: '' }] }]
    const routed = setup({ first: (root) => formFrame(root, wide) })
    expect(await routed.frame('refused')).toEqual({ type: 'refused', message: OPENCODE_FORM_UNCARRIABLE })
    await routed.run
    const off = setup({ settings: 'ask_notifications = false\n', first: (root) => formFrame(root, wide) })
    expect(await off.frame('terminal')).toEqual({ type: 'terminal', reason: 'question-notifications-off' })
    await off.run
    const signedOut = setup({ signedIn: false, first: (root) => formFrame(root, wide) })
    expect(await signedOut.frame('terminal')).toEqual({ type: 'terminal', reason: 'not-signed-in' })
    await signedOut.run
  })

  it('refuses an image whose bytes are not the image its name says, before anything leaves the machine', async () => {
    const t = setup({ first: (root) => {
      writeFileSync(path.join(root, 'id_ed25519.png'), '-----BEGIN OPENSSH PRIVATE KEY-----\n')
      return formFrame(root, REQUEST.questions, { images: [{ path: 'id_ed25519.png', alt: 'key' }] })
    } })
    expect((await t.frame('refused') as { message: string }).message)
      .toBe('Notifai cannot carry this form to the User\'s devices: image "id_ed25519.png" is not the PNG image its name says. Fix that and open the form again, or ask in the conversation.')
    await t.run
    expect(t.uploads).toEqual([])
    expect(readSessionState(SESSION, t.env).pending ?? []).toEqual([])
  })

  it('releases its registration when the form never opens', async () => {
    const t = setup({ first: (root) => formFrame(root) })
    await t.frame('accepted')
    t.input.end()
    await t.run
    expect(t.frames.at(-1)).toEqual({ type: 'done', outcome: 'form-not-opened' })
    expect(readSessionState(SESSION, t.env).pending ?? []).toEqual([])
    expect(t.submitted).toEqual([])
  })

  it('closes the form unanswered, saying only that it expired, when the device question ends', async () => {
    const t = setup({ expired: true, first: (root) => formFrame(root) })
    await t.frame('accepted')
    t.send(opened())
    expect(await t.frame('expired')).toEqual({ type: 'expired', context: CLAUDE_PICKER_DISMISSED })
    expect(CLAUDE_PICKER_DISMISSED).not.toMatch(/dismiss/i)
    t.send({ type: 'applied' })
    expect(await t.frame('done')).toEqual({ type: 'done', outcome: 'expired' })
    await t.run
    expect(t.closes).toEqual(['retire'])
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

  it('carries free text and ten questions through the OpenCode form', () => {
    const questions: QuestionT[] = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, text: `Question ${i}?`,
      ...(i === 0 ? {} : { choices: [{ id: 'a', label: 'First', recommended: true }, { id: 'b', label: 'Second' }] }) }))
    const input = opencodeHandBackInput(questions, {}, 'q_many')
    expect(input?.questions).toHaveLength(10)
    expect(input?.questions[0]?.options).toEqual([])
    expect(input?.questions[1]?.options.map(option => option.label)).toEqual(['First (Recommended)', 'Second'])
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
