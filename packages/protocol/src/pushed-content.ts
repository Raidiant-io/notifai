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

/**
 * The questions as every push carries them: choice descriptions are left out,
 * because they are optional content that may not fit. `has_choice_descriptions`
 * says they exist, and the renderers add them back when they fit.
 */
export function pushedQuestions(questions: readonly QuestionT[]): QuestionT[] {
  return questions.map((question) =>
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
 * a candidate custom key: choice descriptions first (they sit on the answer
 * controls an expanded notification shows), then the Markdown Body. Shared by
 * the APNs and FCM renderers. `fits` sees the complete payload as sent.
 * Null when nothing fits, so the rendered payload stays exactly as built.
 */
export function withFittingContent(
  notifai: Record<string, unknown>,
  draft: NotificationDraftT,
  fits: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const body = draft.presentation.body
  const describes = hasChoiceDescriptions(draft)
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
  if (key === rest) return null
  return withToken(key, descriptionsMissing || bodyMissing)
}

