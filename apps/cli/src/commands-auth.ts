import { type AccountAccessResponse } from '@raidiant/notifai-protocol'
import { sha256Hex } from '@raidiant/notifai-protocol/node'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { NetworkError } from './client.js'
import { type FlagOverrides } from './config.js'
import { checkApproveUrl } from './url-policy.js'
import {
  EXIT,
  SETUP_COMMAND,
  authedClient,
  loadLoggedConfig,
  makeClient,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import { setupAccessUrl } from './setup-destinations.js'
import type { ReadinessState } from './readiness.js'

// ---------------------------------------------------------------------------
// login / logout / auth status
// ---------------------------------------------------------------------------

/**
 * Keep the one-time confirmation secret out of the HTTP request that opens
 * the dashboard. URL fragments are browser-local and are not sent by GET,
 * prefetchers, referrers, or link scanners.
 */
export function pairingApprovalUrl(approveUrl: string, confirmationSecret: string): string {
  const url = new URL(approveUrl)
  url.hash = new URLSearchParams({ confirmation_secret: confirmationSecret }).toString()
  return url.toString()
}

/**
 * Why a sign-in stopped, in the shape the close line renders.
 *
 * Without it, `init` fell back to the state it had before the attempt — "this
 * machine is not paired … run `notifai init`" — so the last thing a User read
 * contradicted the correct line three lines above it and pointed back at the
 * command that had just failed, for a reason it never mentioned.
 */
export type LoginBlockedSink = (blocker: ReadinessState) => void

export async function loginCommand(
  deps: CommandDeps,
  flags: { name?: string; baseUrl?: string; open?: boolean },
  onBlocked?: LoginBlockedSink,
): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, flags: { base_url: flags.baseUrl } as FlagOverrides })
  const baseUrl = config.base_url.value
  const machineName = flags.name ?? os.hostname()
  const secret = randomBytes(32).toString('base64url')
  const pollVerifier = randomBytes(24).toString('base64url')
  const confirmationSecret = randomBytes(32).toString('base64url')
  const client = makeClient(deps, baseUrl, null)

  let begin
  try {
    begin = await client.beginPairing({
      machine_name: machineName,
      credential_hash: sha256Hex(secret),
      poll_verifier_hash: sha256Hex(pollVerifier),
      confirmation_hash: sha256Hex(confirmationSecret),
    })
  } catch (err) {
    return reportError(deps, err)
  }
  const approveUrl = pairingApprovalUrl(begin.approve_url, confirmationSecret)

  // The approval URL is the server's choice, and this machine is about to put
  // it in front of the user's browser. A compromised or misconfigured service
  // must not be able to aim that anywhere it likes, so the pairing stops here
  // rather than showing a link the user would reasonably trust.
  const approvable = checkApproveUrl(begin.approve_url, baseUrl, config.approve_origins.value)
  if (!approvable.ok) {
    deps.io.err(`Pairing stopped: ${approvable.reason}`)
    deps.io.err(
      'next: If you self-host with the dashboard on its own origin, allow it with ' +
        '`notifai config set approve_origins <origin>` and run `notifai login` again.',
    )
    return EXIT.auth
  }

  const interactive = deps.io.interactive === true
  if (interactive) {
    await deps.io.intro?.('Notifai sign in')
    await deps.io.note?.(`Code: ${begin.code}\n${approveUrl}`, 'Approve this machine')
  } else {
    deps.io.out(`Pairing code: ${begin.code}`)
    deps.io.out(`Approve this machine at: ${approveUrl}`)
    deps.io.out('Waiting for approval…')
  }
  if (flags.open !== false) deps.io.openUrl(approveUrl)

  const expiresAt = new Date(begin.expires_at).getTime()
  const intervalMs = Math.max(begin.poll_interval_seconds, 1) * 1000
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const approvalWaitMessage = (): string => {
    const remainingSec = Math.max(0, Math.ceil((expiresAt - now()) / 1000))
    const minutes = Math.floor(remainingSec / 60)
    const seconds = remainingSec % 60
    const remaining =
      minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`
    return `Waiting for approval… code ${begin.code} · ${remaining} left`
  }
  const spinner = interactive ? await deps.io.spinner?.(approvalWaitMessage()) : null
  while (now() < expiresAt) {
    await sleep(intervalMs)
    let poll
    try {
      poll = await client.pollPairing(begin.pairing_id, pollVerifier)
    } catch (err) {
      if (err instanceof NetworkError) {
        spinner?.message(`Connection lost — retrying… code ${begin.code}`)
        continue
      }
      spinner?.error('Pairing failed')
      return reportError(deps, err)
    }
    if (poll.status === 'approved' && poll.machine_id) {
      deps.store.save({ machineId: poll.machine_id, secret, baseUrl, machineName })
      if (interactive) {
        spinner?.stop(`Machine "${machineName}" approved`)
        await deps.io.outro?.(`Credential stored in ${deps.store.describe()}`)
      } else {
        deps.io.out(`Machine "${machineName}" approved. Credential stored in ${deps.store.describe()}.`)
      }
      return EXIT.ok
    }
    if (poll.status === 'denied') {
      spinner?.error('Pairing denied')
      deps.io.err('Pairing was denied from the dashboard.')
      return EXIT.auth
    }
    // Proof-gated: the server never returns this from lookup. Stop now instead
    // of waiting out TTL, and name init rather than a second pairing command.
    if (poll.status === 'no_active_plan') {
      // The server owns which access errand is current — requesting it today,
      // choosing a plan after cutover — so its line wins whenever it sends one.
      const next = poll.next_action ?? `Open ${setupAccessUrl(baseUrl)} to set up access, then retry.`
      spinner?.error('This account does not have access yet')
      deps.io.err('This account has no active plan or temporary Alpha access.')
      deps.io.err(`next: ${next}`)
      deps.io.err(`After access is granted, run \`${SETUP_COMMAND}\` again.`)
      onBlocked?.({
        id: 'auth',
        title: 'Access',
        status: 'gap',
        detail: 'this account does not have access to Notifai yet',
        remedy: { by: 'user-elsewhere', summary: next },
      })
      return EXIT.auth
    }
    if (poll.status === 'expired') break
    spinner?.message(approvalWaitMessage())
  }
  spinner?.error('Pairing expired')
  deps.io.err(`Pairing expired before it was approved. Run \`${SETUP_COMMAND}\` again.`)
  return EXIT.auth
}

export function logoutCommand(deps: CommandDeps): number {
  deps.store.clear()
  deps.io.out('Machine credential removed. Revoke it in the dashboard too if the machine is untrusted.')
  return EXIT.ok
}

export function authStatusCommand(deps: CommandDeps, flags: { json?: boolean }): number {
  const credential = deps.store.load()
  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        credential
          ? {
              signed_in: true,
              machine_id: credential.machineId,
              machine_name: credential.machineName,
              base_url: credential.baseUrl,
              store: deps.store.describe(),
            }
          : { signed_in: false },
        null,
        2,
      ),
    )
    return credential ? EXIT.ok : EXIT.auth
  }
  if (!credential) {
    deps.io.err(`Not signed in. Run \`${SETUP_COMMAND}\`; it will coordinate machine login and device setup.`)
    return EXIT.auth
  }
  deps.io.out(`Signed in as machine "${credential.machineName}" (${credential.machineId})`)
  deps.io.out(`Server: ${credential.baseUrl}`)
  deps.io.out(`Credential store: ${deps.store.describe()}`)
  return EXIT.ok
}

/** Show the server's account access decision without attempting a product mutation. */
export async function accessStatusCommand(
  deps: CommandDeps,
  flags: { json?: boolean },
): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const access: AccountAccessResponse = await authed.client.accessStatus()
    if (flags.json) {
      deps.io.out(JSON.stringify(access, null, 2))
      return access.status === 'active' ? EXIT.ok : EXIT.failed
    }
    if (access.status === 'no_active_plan') {
      deps.io.out('This account does not have access to Notifai yet.')
      deps.io.out(`next: Open ${setupAccessUrl(authed.baseUrl)} to set up access, then retry.`)
      return EXIT.failed
    }
    const expiry = access.expires_at ? ` until ${access.expires_at}` : ''
    deps.io.out(`Access active (${access.reason})${expiry}`)
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}
