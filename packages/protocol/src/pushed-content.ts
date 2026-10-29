/**
 * Optional content a push carries only when it fits. Internal to the push
 * envelope builders; not part of the package's public surface.
 */
import type { NotificationDraftT, QuestionT } from './notification.js'

/** True when some closed choice of this request carries a description. */
export function hasChoiceDescriptions(draft: NotificationDraftT): boolean {
  return (
    draft.reply?.questions.some((question) =>
      question.choices?.some((choice) => choice.description !== undefined),
    ) ?? false
  )
}

/** True when some question of this request carries a title or a detail. */
export function hasQuestionDetails(draft: NotificationDraftT): boolean {
  return (
    draft.reply?.questions.some((question) => question.title !== undefined || question.detail !== undefined) ??
    false
  )
}

/**
 * The questions as every push carries them: choice descriptions and question
 * titles and details are left out, because they are optional content that may
 * not fit. `has_choice_descriptions` says descriptions exist; the renderers
 * add everything back when it fits, and `has_question_details` only when
 * titles or details stay out.
 */
export function pushedQuestions(questions: readonly QuestionT[]): QuestionT[] {
  return questions.map(({ title: _title, detail: _detail, ...question }) =>
    question.choices === undefined
      ? question
      : {
          ...question,
          choices: question.choices.map(({ description: _description, ...choice }) => choice),
        },
  )
}

export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

/**
 * Optional content that rides in a push only when it fits, as a function of
 * a candidate custom key: the complete questions first, with their choice
 * descriptions, titles and details (they sit on the answer controls), then
 * the Markdown Body. Shared by the APNs and FCM renderers. `fits` sees the
 * complete payload as sent.
 * Null when nothing fits, so the rendered payload stays exactly as built.
 */
export function withFittingContent(
  notifai: Record<string, unknown>,
  draft: NotificationDraftT,
  fits: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const body = draft.presentation.body
  const describes = hasChoiceDescriptions(draft) || hasQuestionDetails(draft)
  if ((body === undefined && !describes) || draft.lifecycle?.tier === 'done') return null
  const { content_token: contentToken, ...rest } = notifai
  const hasMedia = (draft.presentation.media?.length ?? 0) > 0
  // The token stays while anything is still left to fetch.
  const withToken = (key: Record<string, unknown>, missing: boolean) =>
    contentToken !== undefined && (missing || hasMedia) ? { ...key, content_token: contentToken } : key

  let key: Record<string, unknown> = rest
  let descriptionsMissing = false
  if (describes) {
    const candidate = { ...key, questions: draft.reply!.questions }
    if (fits(withToken(candidate, body !== undefined))) key = candidate
    else descriptionsMissing = true
  }
  let bodyMissing = false
  if (body !== undefined) {
    const candidate = { ...key, body }
    if (fits(withToken(candidate, descriptionsMissing))) key = candidate
    else bodyMissing = true
  }
  // Only a push that leaves question titles or details out says they exist;
  // a flag on every form push would cost each one its bytes. When even the
  // flag does not fit, history brings them.
  if (descriptionsMissing && hasQuestionDetails(draft)) {
    const candidate = { ...key, has_question_details: true }
    if (fits(withToken(candidate, true))) key = candidate
  }
  if (key === rest) return null
  return withToken(key, descriptionsMissing || bodyMissing)
}

