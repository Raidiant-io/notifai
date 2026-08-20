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
      const supportUrl = supportPageUrl(authed.baseUrl)
      let email: string | null = null
      try {
        email = (await authed.client.accessStatus()).email
      } catch {
        // Best-effort: the empty-state copy still points at /support without it.
      }
      deps.io.out(
        `No devices yet. Install Notifai from ${supportUrl}, ${sameAccountSignInLine(email)}, and allow notifications.`,
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

export function supportPageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/support`
}

/** Same-account line for the device hop; prefers the real email when known. */
export function sameAccountSignInLine(email: string | null | undefined): string {
  return email
    ? `sign in with the same email as this account (${email})`
    : 'sign in with the same email as this account'
}

export function deviceInstallRemedy(options: {
  baseUrl: string
  email: string | null
  devices: readonly RoutableDevice[]
}): string {
  const support = supportPageUrl(options.baseUrl)
  const sameEmail = sameAccountSignInLine(options.email)
  if (options.devices.length === 0) {
    return (
      `open the Companion App install steps at ${support} on a supported device, ` +
      `install Notifai, ${sameEmail}, and allow notifications`
    )
  }
  if (options.devices.some((d) => d.permission_status === 'denied')) {
    return "allow notifications for Notifai in the device's Settings"
  }
  return 'open Notifai on the device and allow its notification prompt'
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

export function readyCompanionDevices(devices: readonly RoutableDevice[]): RoutableDevice[] {
  return devices.filter(
    (device) =>
      (device.platform === 'ios' || device.platform === 'android') && deviceCanReceive(device),
  )
}
