import { PLATFORMS, type Platform, type RoutableDevice } from '@raidiant/notifai-protocol'
import {
  EXIT,
  authedClient,
  loadLoggedConfig,
  makeClient,
  reportError,
  resolvedBaseUrl,
  type CommandDeps,
} from './commands-core.js'
import {
  COMPANION_INSTALL_URLS,
  companionPlatformLabel,
  type CompanionPlatform,
} from './setup-destinations.js'

// ---------------------------------------------------------------------------
// devices / capabilities
// ---------------------------------------------------------------------------

export async function devicesCommand(
  deps: CommandDeps,
  flags: { json?: boolean; platform?: string },
): Promise<number> {
  if (flags.platform !== undefined && !(PLATFORMS as readonly string[]).includes(flags.platform)) {
    deps.io.err(`Unknown platform "${flags.platform}" — use ${PLATFORMS.join(' or ')}.`)
    return EXIT.usage
  }
  const platform = flags.platform as Platform | undefined
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const result = await authed.client.listDevices()
    const devices =
      platform === undefined
        ? result.devices
        : result.devices.filter((device) => device.platform === platform)
    if (flags.json) {
      deps.io.out(JSON.stringify({ ...result, devices }, null, 2))
      return EXIT.ok
    }
    if (devices.length === 0) {
      if (platform !== undefined) {
        deps.io.out(`No ${platform} devices registered.`)
        return EXIT.ok
      }
      let email: string | null = null
      try {
        email = (await authed.client.accessStatus()).email
      } catch {
        // Best-effort: the empty-state copy still names the destination.
      }
      deps.io.out(
        `No devices yet. Get Notifai on your phone (${installLinks()}), ${sameAccountSignInLine(email)}, and allow notifications.`,
      )
      return EXIT.ok
    }
    for (const d of devices) {
      deps.io.out(
        `${d.device_id}  ${d.display_name}  ${d.platform}  ${d.status_message ?? 'Working'}`,
      )
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

/**
 * Devices as data, for surfaces that render them themselves.
 *
 * `devicesCommand` prints and returns an exit code, which is the right shape
 * for a command and the wrong one for a menu that wants to show names beside
 * checkboxes. Silent on every failure by design: the interactive app already
 * shows the credential and connectivity state on its status card, so a second
 * error line here would be reporting the same fault twice.
 */
export async function deviceInventory(deps: CommandDeps): Promise<RoutableDevice[] | null> {
  if (!deps.store.load()) return null
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return null
  try {
    return (await authed.client.listDevices()).devices
  } catch {
    return null
  }
}

/** Whether a device is in a state where a notification would actually arrive. */
export function canDeviceReceive(device: RoutableDevice): boolean {
  return deviceCanReceive(device)
}

export async function capabilitiesCommand(
  deps: CommandDeps,
  flags: { json?: boolean; platform?: Platform },
): Promise<number> {
  // Locally, and with the same message `send` gives. Spending a round trip to
  // have the server answer "Request validation failed" told the caller neither
  // which flag was wrong nor what it accepts.
  if (flags.platform !== undefined && !(PLATFORMS as readonly string[]).includes(flags.platform)) {
    deps.io.err(`Unknown platform "${flags.platform}" — use ${PLATFORMS.join(' or ')}.`)
    return EXIT.usage
  }
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const credential = deps.store.load()
  const baseUrl = resolvedBaseUrl(config, credential)
  const client = makeClient(deps, baseUrl, null)
  try {
    const doc = await client.capabilities(flags.platform ?? 'ios')
    if (flags.json) {
      deps.io.out(JSON.stringify(doc, null, 2))
      return EXIT.ok
    }
    deps.io.out(`${doc.platform} capability contract v${doc.schema_version} (payload limit ${doc.payload_limit_bytes} bytes)`)
    for (const field of doc.fields) {
      deps.io.out(`  ${field.path}: ${field.status}${field.reason ? ` — ${field.reason}` : ''}`)
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

/** Same-account line for the device hop; prefers the real email when known. */
export function sameAccountSignInLine(email: string | null | undefined): string {
  return email
    ? `sign in with the same email as this account (${email})`
    : 'sign in with the same email as this account'
}

/**
 * What is actually left to do on the phone.
 *
 * Three sub-states, three remedies. "Install the app" is useless advice to
 * someone who installed it and then declined the permission prompt, and
 * offering install steps to a registered device says this terminal did not
 * read the state it just fetched.
 */
export function deviceInstallRemedy(options: {
  email: string | null
  devices: readonly RoutableDevice[]
  platform?: CompanionPlatform
}): string {
  const sameEmail = sameAccountSignInLine(options.email)
  if (options.devices.length === 0) {
    const from = options.platform === undefined
      ? `get Notifai on your phone (${installLinks()})`
      : `get Notifai on your ${companionPlatformLabel(options.platform)} at ${COMPANION_INSTALL_URLS[options.platform]}`
    return `${from}, ${sameEmail}, and allow notifications`
  }
  if (options.devices.some((d) => d.support?.state === 'must_update' && d.support.affected_operation === 'receive_notifications')) {
    return 'update the Notifai app on the device'
  }
  if (options.devices.some((d) => d.permission_status === 'denied')) {
    return "allow notifications for Notifai in the device's Settings"
  }
  if (options.devices.some((d) => d.permission_status === 'not_determined')) {
    return 'open Notifai on the device and allow notifications when it asks'
  }
  // Notifications are allowed, so the prompt is not what is missing: the app
  // has not finished registering, which it does when it is opened.
  return 'open Notifai on the device so it can finish connecting'
}

/** Both phones' install links, for a line that cannot know which phone the User has. */
function installLinks(): string {
  return `iPhone: ${COMPANION_INSTALL_URLS.iphone}; Android: ${COMPANION_INSTALL_URLS.android}`
}

/**
 * The line an agent relays, word for word, when no phone can receive yet:
 * the same sub-states as `deviceInstallRemedy`, said to the User.
 */
export function deviceRelayMessage(options: { email: string | null; devices: readonly RoutableDevice[] }): string {
  const { devices } = options
  if (devices.length === 0) {
    return 'Now get the Notifai app on your phone: iPhone from the App Store at ' +
      `${COMPANION_INSTALL_URLS.iphone}, or Android through the free test at ${COMPANION_INSTALL_URLS.android}. ` +
      `Sign in with ${options.email ?? 'the email you approved this computer with'}, and allow notifications ` +
      "when it asks. Tell me when it's in."
  }
  const device = (pick: (d: RoutableDevice) => boolean) => devices.find(pick)
  const updating = device((d) => d.support?.state === 'must_update' && d.support.affected_operation === 'receive_notifications')
  if (updating) return `Update the Notifai app on your ${deviceNoun(updating)}, then tell me when that's done.`
  const denied = device((d) => d.permission_status === 'denied')
  if (denied) {
    const where = denied.platform === 'ios'
      ? 'Settings → Notifai → Notifications'
      : denied.platform === 'android'
        ? 'Settings → Apps → Notifai → Notifications'
        : 'its notification settings'
    return `Notifications are off for Notifai on your ${deviceNoun(denied)}. Turn them on in ${where}, ` +
      "then tell me when that's done."
  }
  const undecided = device((d) => d.permission_status === 'not_determined')
  if (undecided) {
    return `Open Notifai on your ${deviceNoun(undecided)} and allow notifications when it asks. ` +
      "Tell me when that's done."
  }
  return `Open Notifai on your ${deviceNoun(devices[0]!)} so it can finish connecting, then tell me when that's done.`
}

export function deviceNoun(device: RoutableDevice): string {
  switch (device.platform) {
    case 'ios': return 'iPhone'
    case 'android': return 'phone'
    case 'macos': return 'Mac'
    default: return 'computer'
  }
}

export function deviceCanReceive(device: RoutableDevice): boolean {
  const receiveIsFloored =
    device.support?.state === 'must_update' &&
    device.support.affected_operation === 'receive_notifications'
  return (
    !receiveIsFloored &&
    device.registration_healthy &&
    (device.permission_status === 'authorized' || device.permission_status === 'provisional')
  )
}

/** Every Companion App counts: the phones and the desktop app alike. */
export function readyCompanionDevices(devices: readonly RoutableDevice[]): RoutableDevice[] {
  return devices.filter(deviceCanReceive)
}
