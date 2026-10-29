import {
  CAPABILITY_DOCUMENTS_V1,
  estimateFcmPayloadBytes,
  projectIdentityPushBytes,
  validateDraft,
  type NotificationDraftT,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAskDraft, buildQuestions } from './commands-ask.js'
import { loadConfig } from './config.js'
import { makeClient, type CommandDeps } from './commands-core.js'
import { stateDir } from './config.js'
import { rememberedProjectIdentityPushBytes, rememberProjectIdentityPushBytes } from './project-push-identity.js'
import { questionPushOverflow } from './question-push-budget.js'

/**
 * Forms shaped like real ones: a title per question, two or three choices,
 * one recommended. `textLength` sets how wordy each question is.
 */
function sampleForm(count: number, textLength: number, options: { description?: string; body?: string } = {}): string {
  const sentence = 'Close the older tracking issue now that the replacement work shipped and its parts are done? '
  const text = (index: number) => `${index + 1}. ${sentence.repeat(4)}`.slice(0, textLength).trimEnd()
  return JSON.stringify({
    title: 'Old issues to retire',
    summary: `${count} old issues: keep or retire?`,
    ...(options.body === undefined ? {} : { body: options.body }),
    questions: Array.from({ length: count }, (_, index) => ({
      title: `Issue ${index + 1}`,
      text: text(index),
      choices: [
        { label: 'Close it', recommended: true, ...(options.description === undefined ? {} : { description: options.description }) },
        { label: 'Keep it for later' },
        ...(index % 3 === 0 ? [{ label: 'Ask me again next week' }] : []),
      ],
    })),
  })
}

/** Ten short yes/no checks: the kind of 10-question form that fits a phone push. */
function checklistForm(count: number): string {
  return JSON.stringify({
    title: 'Release checks',
    summary: `${count} release checks`,
    questions: Array.from({ length: count }, (_, index) => ({
      title: `Check ${index + 1}`,
      text: `Ship component ${index + 1} as it is today?`,
      choices: ['Yes', 'No'],
    })),
  })
}

function config() {
  return loadConfig({ cwd: '/', env: { HOME: '/nonexistent-notifai-home' } })
}

/** As `ask` builds it in a Project, from a linked worktree: the case the incident hit. */
function askDraft(form: string) {
  const built = buildQuestions({ form }, undefined)
  if (!built.ok) throw new Error(built.error)
  return buildAskDraft(config(), built, { project: 'notifai' }, {
    source: { session_id: 'a'.repeat(36), session_label: 'Gentle Salmon', harness: 'claude-code', branch: 'feature/cleanup', worktree: 'cleanup' },
  }, [])
}

describe('the phone push budget at registration', () => {
  it('accepts an 8-question form of ordinary length', () => {
    const draft = askDraft(sampleForm(8, 60))
    expect(draft).toMatchObject({ ok: true })
    expect(draft.ok && draft.draft.reply?.questions).toHaveLength(8)
  })

  it('accepts a 10-question form of short checks', () => {
    const draft = askDraft(checklistForm(10))
    expect(draft).toMatchObject({ ok: true })
    expect(draft.ok && draft.draft.reply?.questions).toHaveLength(10)
  })

  it.each([
    ['an 8-question form of about 110 characters a question', 8, sampleForm(8, 110)],
    ['a 10-question form of ordinary length', 10, sampleForm(10, 60)],
  ])('refuses %s, which an Android push cannot carry, with a remedy', (_name, count, form) => {
    expect(askDraft(form)).toMatchObject({
      ok: false,
      code: 'question_too_large',
      error: expect.stringMatching(new RegExp(`^This ${count}-question form is too large to reach a phone: Android notifications carry the questions in a 4096-byte FCM push, and this one needs about \\d+ bytes\\. Nothing was registered\\.$`)),
      remedy: expect.stringContaining('split the questions into smaller forms'),
    })
  })

  it('accepts the same questions split into two forms of four', () => {
    expect(askDraft(sampleForm(4, 110))).toMatchObject({ ok: true })
  })

  it('does not count the Body or choice descriptions, which the apps fetch when they do not fit', () => {
    expect(askDraft(sampleForm(7, 60, { description: 'd'.repeat(150), body: 'Background. '.repeat(400) })))
      .toMatchObject({ ok: true })
  })

  it('refuses a draft that raw validation accepts but the service refuses once it adds a collapse key and device stamp', () => {
    // The incident's gap: registration validated one platform without what
    // submission and the service add, so the refusal came in the background.
    const draft = askDraft(sampleForm(8, 60))
    if (!draft.ok) throw new Error(draft.error)
    let padded = draft.draft
    while (estimateFcmPayloadBytes(padded) < 4096 - 30) {
      padded = { ...padded, presentation: { ...padded.presentation, title: `${padded.presentation.title}x` } }
    }
    expect(validateDraft(padded, CAPABILITY_DOCUMENTS_V1).ok).toBe(true)
    expect(questionPushOverflow(padded)).toMatchObject({ platform: 'android', provider: 'FCM', limit: 4096 })
  })
})

describe("the phone push budget with the Project identity the service reported", () => {
  /** What a service reports for a Project with no name and a generated avatar. */
  const generated = {
    name: null,
    imageUrl: 'https://api.notifai.sh/api/v1/projects/proj_AAAAAAAAAAAAAAAAAAAAAA/avatar.png?rev=generated%3Av1',
    avatarRevision: 'generated:v1',
  }
  const custom = { name: 'Notifai', imageUrl: 'x'.repeat(500), avatarRevision: `med_${'A'.repeat(22)}` }

  function remember(identity: typeof generated | typeof custom): void {
    const draft = askDraft(sampleForm(1, 60))
    if (!draft.ok) throw new Error(draft.error)
    rememberProjectIdentityPushBytes(process.env, config().base_url.value, 'notifai', {
      ios: projectIdentityPushBytes(draft.draft, 'ios', identity),
      android: projectIdentityPushBytes(draft.draft, 'android', identity),
    })
  }

  afterEach(() => rmSync(path.join(stateDir(process.env), 'project-push-identity.json'), { force: true }))

  it('accepts a 10-question form of ordinary length in a Project with a generated avatar', () => {
    remember(generated)
    const draft = askDraft(sampleForm(10, 60))
    expect(draft).toMatchObject({ ok: true })
    expect(draft.ok && draft.draft.reply?.questions).toHaveLength(10)
  })

  it('accepts 8 titled questions of ordinary length in a Project with a custom image', () => {
    remember(custom)
    expect(askDraft(sampleForm(8, 60))).toMatchObject({ ok: true })
  })

  it.each([
    ['in a Project with a custom image', 60, custom],
    ['of about 110 characters a question, whatever the Project', 110, generated],
  ] as const)('still refuses a 10-question form %s', (_name, length, identity) => {
    remember(identity)
    expect(askDraft(sampleForm(10, length))).toMatchObject({ ok: false, code: 'question_too_large' })
  })

  it("sizes a Project it has not heard about for the longest identity", () => {
    expect(askDraft(sampleForm(10, 60))).toMatchObject({ ok: false, code: 'question_too_large' })
  })

  it('learns the bytes from every accepted submission in a Project', async () => {
    const baseUrl = 'https://notifai.invalid'
    const receipt = { request_id: 'req_x', project_identity_push_bytes: { ios: 180, android: 210 } } as unknown as SubmissionReceipt
    const deps = {
      env: process.env,
      clientFactory: () => ({ submit: async () => receipt }),
    } as unknown as CommandDeps
    const client = makeClient(deps, baseUrl, null)
    const draft = { project: 'notifai' } as unknown as NotificationDraftT
    await client.submit({ idempotency_key: 'learn-identity', draft }, 0)
    expect(rememberedProjectIdentityPushBytes(process.env, baseUrl, 'notifai')).toEqual({ ios: 180, android: 210 })
    expect(rememberedProjectIdentityPushBytes(process.env, 'https://other.invalid', 'notifai')).toBeUndefined()
  })
})
