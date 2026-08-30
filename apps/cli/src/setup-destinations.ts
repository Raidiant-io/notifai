/**
 * Where a cross-surface setup errand is finished.
 *
 * Every handoff opens the destination for exactly one errand, carrying the
 * platform when this terminal already asked for it. The omnibus help page is
 * help: it covers access, two install routes, billing, refunds, deletion,
 * privacy and terms, and its own next step is to go somewhere else. Sending
 * someone there for a named gate makes them find it themselves.
 *
 * The server prints these same paths into `next_action`, which is the value
 * this CLI prefers whenever it has one. These builders are the fallback for
 * the paths where it does not, and they must stay spelled the same.
 */

/** The two platforms that can receive a notification. Mac is not one. */
export const COMPANION_PLATFORMS = ['iphone', 'android'] as const
export type CompanionPlatform = (typeof COMPANION_PLATFORMS)[number]

export function companionPlatformLabel(platform: CompanionPlatform): string {
  return platform === 'iphone' ? 'iPhone' : 'Android'
}

/**
 * The dashboard a reader can sign in to, which is not always the API origin.
 * Only the hosted deployment splits them; a self-host serves both from one.
 */
function dashboardOrigin(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized === 'https://api.notifai.sh') {
    return 'https://app.notifai.sh'
  }
  return normalized
}

/** Getting this Account access to Notifai, and nothing else. */
export function setupAccessUrl(baseUrl: string, platform?: CompanionPlatform): string {
  const base = `${dashboardOrigin(baseUrl)}/setup/access`
  return platform === undefined ? base : `${base}?platform=${platform}`
}

/** Installing the Companion App on one named platform. */
export function setupCompanionUrl(baseUrl: string, platform?: CompanionPlatform): string {
  const base = `${dashboardOrigin(baseUrl)}/setup/companion`
  return platform === undefined ? base : `${base}?platform=${platform}`
}

/** General help: billing, policies, and everything setup is not. */
export function supportPageUrl(baseUrl: string): string {
  return `${dashboardOrigin(baseUrl)}/support`
}
