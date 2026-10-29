import { CAPABILITY_DOCUMENTS_V1, estimateFcmPayloadBytes, validateDraft } from '@raidiant/notifai-protocol'
import { describe, expect, it } from 'vitest'
import { buildAskDraft, buildQuestions } from './commands-ask.js'
import { loadConfig } from './config.js'
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

/** As `ask` builds it in a Project, from a linked worktree: the case the incident hit. */
function askDraft(form: string) {
  const built = buildQuestions({ form }, undefined)
  if (!built.ok) throw new Error(built.error)
  const config = loadConfig({ cwd: '/', env: { HOME: '/nonexistent-notifai-home' } })
  return buildAskDraft(config, built, { project: 'notifai' }, {
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
    expect(askDraft(sampleForm(8, 60, { description: 'd'.repeat(150), body: 'Background. '.repeat(400) })))
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
