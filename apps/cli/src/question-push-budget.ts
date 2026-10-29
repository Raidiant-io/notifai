/**
 * Whether a question fits the push that carries it to a phone.
 *
 * iPhone (APNs) and Android (FCM) pushes are capped at 4096 bytes, and shipped
 * Companion Apps read the questions and choice labels from the push itself.
 * The service refuses a draft whose push would not fit (422
 * `payload_too_large`), and it checks every platform a question may route to.
 * `notifai ask` must refuse such a form at registration: once registered, a
 * refusal arrives in the background, where only `notifai status` can show it.
 */
import {
  CAPABILITY_DOCUMENTS_V1,
  estimateDeliveredPayloadBytes,
  type NotificationDraftT,
} from '@raidiant/notifai-protocol'
import type { ProjectIdentityPushBytes } from './project-push-identity.js'

/** The background submitter's collapse key: `notifai-hook-` and 8 random bytes in base64url. */
const SUBMISSION_COLLAPSE_KEY_PLACEHOLDER = `notifai-hook-${'x'.repeat(11)}`

export interface QuestionPushOverflow {
  platform: string
  provider: 'APNs' | 'FCM'
  /** Estimated bytes, with what the service adds at its longest. */
  bytes: number
  limit: number
}

/**
 * The tightest platform this draft overflows, or null when it fits all of
 * them. Every routed platform counts: the User's devices can change between
 * registration and submission. The service's own rule sizes the push
 * (`estimateDeliveredPayloadBytes`): with `projectIdentity`, the bytes the
 * service last reported for this Project's name and avatar; without it, the
 * longest identity a Project can have.
 */
export function questionPushOverflow(
  draft: NotificationDraftT,
  projectIdentity?: ProjectIdentityPushBytes,
): QuestionPushOverflow | null {
  const submitted: NotificationDraftT = draft.delivery.collapse_key === null
    ? { ...draft, delivery: { ...draft.delivery, collapse_key: SUBMISSION_COLLAPSE_KEY_PLACEHOLDER } }
    : draft
  let worst: QuestionPushOverflow | null = null
  for (const document of CAPABILITY_DOCUMENTS_V1) {
    if (document.payload_limit_bytes === null) continue
    if (document.platform !== 'ios' && document.platform !== 'android') continue
    const provider = document.platform === 'android' ? 'FCM' : 'APNs'
    const bytes = projectIdentity === undefined || submitted.project === undefined
      ? estimateDeliveredPayloadBytes(submitted, document.platform)
      : estimateDeliveredPayloadBytes(submitted, document.platform, { projectIdentity: null }) +
        projectIdentity[document.platform]
    if (bytes <= document.payload_limit_bytes) continue
    if (worst === null || bytes - document.payload_limit_bytes > worst.bytes - worst.limit) {
      worst = { platform: document.platform, provider, bytes, limit: document.payload_limit_bytes }
    }
  }
  return worst
}

const PLATFORM_NAMES: Record<string, string> = { ios: 'iPhone', android: 'Android' }

/** The refusal `ask` prints, naming the platform and the size. */
export function questionPushOverflowMessage(overflow: QuestionPushOverflow, questions: number): string {
  const what = questions > 1 ? `This ${questions}-question form` : 'This question'
  const platform = PLATFORM_NAMES[overflow.platform] ?? overflow.platform
  return `${what} is too large to reach a phone: ${platform} notifications carry the questions in a ` +
    `${overflow.limit}-byte ${overflow.provider} push, and this one needs about ${overflow.bytes} bytes. Nothing was registered.`
}

export const QUESTION_PUSH_OVERFLOW_REMEDY =
  'split the questions into smaller forms (for example two forms of 4), or shorten question texts, choice labels, ' +
  'the title or the summary, then ask again; the Body and choice descriptions do not count toward this limit'
