import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ListRepliesResponse, ReplyAnswerT, ReplyView, SubmitNotificationRequestT } from '@raidiant/notifai-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickerForm } from './claude-question-bindings.js'
import type { ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { globalConfigPath } from './config.js'
import {
  OPENCODE_NATIVE_ACKNOWLEDGEMENT,
  opencodeDeviceAnswers,
  opencodeNativeAnswers,
  opencodePickerQuestions,
  opencodeQuestionCommand,
  opencodeQuestionRequest,
  sweepAbandonedOpencodeForms,
  type OpencodeQuestionOutbound,
  type OpencodeQuestionRequest,
} from './opencode-question.js'
import { enableProject, projectBinding } from './project-enablement.js'

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
  enabled?: boolean; signedIn?: boolean; signals?: NodeJS.Signals[]; settings?: string
  sleep?: (ms: number) => Promise<void>
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-question-'))
  roots.push(root)
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  execFileSync('git', ['init', '-q'], { cwd: root })
  if (options.enabled !== false) enableProject(projectBinding(root, env)!)
  if (options.settings !== undefined) {
    mkdirSync(path.dirname(globalConfigPath(env)), { recursive: true })
    writeFileSync(globalConfigPath(env), options.settings)
  }
  let answer: ReplyView | null = null
  let releasePoll: (() => void) | null = null
  const submitted: SubmitNotificationRequestT[] = []
  const closes: string[] = []
  const response = (replies: ReplyView[]): ListRepliesResponse => ({
    request_id: 'req_opencode', reply_expires_at: '2099-01-01T00:00:00Z', agent_acknowledgement_required: true,
    agent_acknowledgement_text_required: true, agent_acknowledgement: null, replies,
  })
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
  const run = opencodeQuestionCommand(deps, input, output, options.signals ?? [])
  send({ type: 'ask', session_id: SESSION, cwd: root, request: REQUEST, session_label: 'Deploy the witness build' })
  return {
    output, root, env, deps, client, submitted, closes, frames, frame, send, run, input,
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
    [{ enabled: false }, 'project-not-enabled'],
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
