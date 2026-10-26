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

import { setupPhoneUrl as protocolSetupPhoneUrl } from '@raidiant/notifai-protocol'

/** The two platforms that can receive a notification. Mac is not one. */
export const COMPANION_PLATFORMS = ['iphone', 'android'] as const
export type CompanionPlatform = (typeof COMPANION_PLATFORMS)[number]

/**
 * What the User calls the device a Companion App runs on: the one noun every
 * setup line uses. Takes a device's platform (`ios`, `android`, `macos`, …)
 * or a store platform (`iphone`).
 */
export function deviceNoun(platform: string): string {
  switch (platform) {
    case 'ios':
    case 'iphone': return 'iPhone'
    case 'android': return 'Android phone'
    case 'macos': return 'Mac'
    case 'windows':
    case 'linux': return 'computer'
    default: return 'device'
  }
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

/**
 * The one line every no-plan surface says. Setup needs no plan; delivering
 * notifications does, and there is no free tier.
 */
export const NO_ACTIVE_PLAN_LINE = 'Notifai needs an active plan to deliver notifications.'

/** Where an Account without a plan chooses one. */
export function plansUrl(baseUrl: string): string {
  return `${dashboardOrigin(baseUrl)}/plans`
}

/**
 * Where a phone gets the Notifai app: straight to the store or download, with
 * no sign-in first, so a phone can open it from a QR. These mirror the links
 * on notifai.sh. Android is the free tester sign-up until Notifai is live on
 * Google Play; going live there changes `android` only.
 */
export const COMPANION_INSTALL_URLS: Readonly<Record<CompanionPlatform, string>> = Object.freeze({
  iphone: 'https://apps.apple.com/app/id6799027730',
  android: 'https://app.notifai.sh/test-android',
})

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

/**
 * The guided phone steps for a computer that is already connected: sign the
 * phone in by QR, allow notifications, choose a plan if needed. `email` lets
 * the page catch a browser signed in to another Account; `machine` names the
 * computer whose test notification the page sends when it is done, and
 * `name` is that computer's name, for the page to show.
 */
export function setupPhoneUrl(baseUrl: string, email: string | null, machineId: string | null, machineName: string | null = null): string {
  return protocolSetupPhoneUrl(dashboardOrigin(baseUrl), { email, machineId, machineName })
}
