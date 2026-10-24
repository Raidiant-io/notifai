import type { ReadinessState } from './readiness.js'
import { NO_ACTIVE_PLAN_LINE } from './setup-destinations.js'

/**
 * What an agent says to the User about one readiness state, word for word.
 *
 * The CLI knows each gap better than any script an agent carries, so every
 * gap brings its own line and the agent relays it unchanged: the words cannot
 * drift from the state they describe. A state that is not a gap, and needs no
 * User, has nothing to say (null).
 */
export function relayMessage(state: ReadinessState): string | null {
  if (state.message !== undefined) return state.message
  const userAction = state.remedy?.by === 'user-here' ? state.remedy.user_action?.message : undefined
  if (userAction !== undefined) return userAction
  if (state.status !== 'gap') return null
  const technical = (state.technical ?? {}) as {
    pairing_outcome?: unknown
    pairing?: { message?: unknown }
    access_url?: unknown
  }
  switch (state.id) {
    case 'credential':
      if (typeof technical.pairing?.message === 'string') return technical.pairing.message
      if (technical.pairing_outcome === 'denied') {
        return "You declined connecting this computer, so I've stopped. Ask me again whenever you want to set it up."
      }
      if (technical.pairing_outcome === 'expired') {
        return "That code expired before it was approved, so I'll get you a new one."
      }
      if (technical.pairing_outcome === 'not_started') return UNREACHABLE
      break
    case 'server':
      return UNREACHABLE
    case 'auth':
      if (typeof technical.access_url === 'string') {
        return `${NO_ACTIVE_PLAN_LINE} Choose one at ${technical.access_url}, then ask me to finish setting up.`
      }
      break
  }
  return stuck(state)
}

const UNREACHABLE =
  "I can't reach Notifai from this computer right now. I'll try again when you ask; nothing you set up so far is lost."

/** Any other gap: what Notifai said, and what it asks for. */
function stuck(state: ReadinessState): string {
  const summary = state.remedy?.summary
  const next = summary ? ` ${summary.charAt(0).toUpperCase()}${summary.slice(1).replace(/\.$/, '')}.` : ''
  return `I couldn't finish setting up Notifai. It said: "${state.detail}".${next}`
}
