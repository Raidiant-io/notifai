import { type AccountAccessResponse } from '@raidiant/notifai-protocol'
import { sha256Hex } from '@raidiant/notifai-protocol/node'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { renderPairingQr, terminalPairingQr, pairingQrPath, pairingQrTextPath } from './pairing-qr.js'
import { ApiCallError, NetworkError } from './client.js'
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
  type CommandSpinner,
} from './commands-core.js'
import { setupAccessUrl } from './setup-destinations.js'
import {
  clearPendingPairing,
  readPendingPairing,
  writePendingPairing,
  type PendingPairing,
} from './pending-pairing.js'
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
 *
 * Passing one also transfers the errand: whoever takes the blocker prints the
 * close, so this command stops after naming what stopped. A sign-in run on its
 * own has no such caller and states the errand itself.
 */
export type LoginBlockedSink = (blocker: ReadinessState) => void

/** Why a machine approval is not (yet) a credential, as an agent reads it. */
export type PairingOutcome = 'pending' | 'denied' | 'expired' | 'not_started'

/**
 * The state `init` reports when approval has been started and not finished.
 *
 * It is a `credential` gap whose remedy names the exact page and code, so an
 * agent can relay both without inventing wording, and whose command is the
 * same setup command — the next run resumes this very handshake rather than
 * starting a second one.
 */
export function pendingApprovalBlocker(pairing: PendingPairing, env?: NodeJS.ProcessEnv): ReadinessState {
  return {
    id: 'credential',
    title: 'This machine',
    status: 'gap',
    detail: `waiting for you to review and approve this computer (code ${pairing.code})`,
    technical: {
      pairing_outcome: 'pending' satisfies PairingOutcome,
      pairing: {
        approve_url: pairing.approve_url,
        ...(env ? { qr_path: pairingQrPath(env), qr_text_path: pairingQrTextPath(env) } : {}),
        alternatives: ['qr', 'notification', 'browser'],
        code: pairing.code,
        expires_at: pairing.expires_at,
      },
    },
    remedy: {
      by: 'user-here',
      summary: `scan the local QR to review this computer in Notifai and compare code ${pairing.code}; browser approval is also available at ${pairing.approve_url}`,
      command: SETUP_COMMAND,
      // The next run resumes this handshake through the same login path.
      interactive: true,
    },
  }
}

/**
 * The state `init` reports when an approval ended without a credential. Each
 * outcome is named, because "not paired" alone sends an agent straight back
 * into a new approval — and a User who just said no gets asked again.
 */
export function pairingOutcomeBlocker(
  outcome: Exclude<PairingOutcome, 'pending'>,
  detail: string,
): ReadinessState {
  return {
    id: 'credential',
    title: 'This machine',
    status: 'gap',
    detail,
    technical: { pairing_outcome: outcome },
    remedy: {
      by: 'user-here',
      summary:
        outcome === 'denied'
          ? 'approval was denied; start setup again only if you want to connect this computer'
          : 'start machine approval again',
      command: SETUP_COMMAND,
      interactive: true,
    },
  }
}

/**
 * Pair this machine with the User's Account.
 *
 * The handshake is one server-side pairing: this machine keeps the credential
 * and the confirmation secret, the User approves the code in their browser,
 * and polling collects the machine id. It is persisted between runs (see
 * `pending-pairing.ts`), which is what lets two very different callers share
 * it honestly:
 *
 * - A human at a terminal watches a spinner until the pairing resolves or
 *   expires, as before.
 * - An agent, or any run with nobody at the terminal, never waits on a
 *   person. It prints the page and the code, polls once, and returns — its
 *   caller relays the errand, and the next run picks the same pairing up
 *   where it was left. A shell tool that times out no longer strands an
 *   approval the User already gave.
 *
 * A resumed handshake is always asked about before it is replaced: the
 * service answers `approved` for an approved pairing even after its expiry,
 * so an approval given late is collected rather than duplicated. Only the
 * service's `expired`, `denied`, or unknown answer discards one.
 */
export async function loginCommand(
  deps: CommandDeps,
  flags: { name?: string; baseUrl?: string; open?: boolean; approval?: string; approvalEmail?: string },
  onBlocked?: LoginBlockedSink,
): Promise<number> {
  if (flags.approval !== undefined && !['qr', 'notification', 'browser'].includes(flags.approval)) {
    deps.io.err('Choose --approval qr, notification, or browser.')
    return EXIT.usage
  }
  if (flags.approvalEmail && flags.approval && flags.approval !== 'notification') {
    deps.io.err('--approval-email is for --approval notification.')
    return EXIT.usage
  }
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, flags: { base_url: flags.baseUrl } as FlagOverrides })
  const baseUrl = config.base_url.value
  const interactive = deps.io.interactive === true
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const client = makeClient(deps, baseUrl, null)

  const startPairing = async (): Promise<PendingPairing | number> => {
    const machineName = flags.name ?? os.hostname()
    const secret = randomBytes(32).toString('base64url')
    const pollVerifier = randomBytes(24).toString('base64url')
    const confirmationSecret = randomBytes(32).toString('base64url')
    let begin
    try {
      begin = await client.beginPairing({
        machine_name: machineName,
        credential_hash: sha256Hex(secret),
        poll_verifier_hash: sha256Hex(pollVerifier),
        confirmation_hash: sha256Hex(confirmationSecret),
      })
    } catch (err) {
      const code = reportError(deps, err)
      onBlocked?.(pairingOutcomeBlocker('not_started', `machine approval could not be started: ${err instanceof Error ? err.message : String(err)}`))
      return code
    }

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
      onBlocked?.(pairingOutcomeBlocker('not_started', `machine approval was refused: ${approvable.reason}`))
      return EXIT.auth
    }

    const started: PendingPairing = {
      pairing_id: begin.pairing_id,
      code: begin.code,
      approve_url: pairingApprovalUrl(begin.approve_url, confirmationSecret),
      base_url: baseUrl,
      machine_name: machineName,
      secret,
      poll_verifier: pollVerifier,
      expires_at: begin.expires_at,
      poll_interval_seconds: begin.poll_interval_seconds,
    }
    writePendingPairing(deps.env, started)
    return started
  }

  let route = flags.approval ?? (flags.approvalEmail ? 'notification' : 'qr')
  const announce = async (pairing: PendingPairing, resumed: boolean): Promise<boolean> => {
    const file = await renderPairingQr(deps.env, pairing.approve_url)
    deps.io.out(`Pairing code: ${pairing.code}`)
    if (route === 'qr') {
      if (interactive && deps.io.note) await deps.io.note(await terminalPairingQr(pairing.approve_url), 'Scan to approve in Notifai')
      else {
        deps.io.out('Scan to approve in Notifai:')
        deps.io.out(await terminalPairingQr(pairing.approve_url, false))
      }
      deps.io.out(`Local QR image: ${file}`)
    }
    if (interactive && flags.approval === undefined && flags.approvalEmail === undefined && deps.io.select) {
      route = await deps.io.select('Connect this computer', [
        { value: 'qr', label: 'Scan the QR', hint: 'Approve in your signed-in Notifai app' },
        { value: 'notification', label: 'Send approval notification', hint: 'Enter your Account email' },
        { value: 'browser', label: 'Use browser approval' },
      ]) ?? 'qr'
    }
    deps.io.out(`Browser alternative: ${pairing.approve_url}`)
    if (route === 'browser' && flags.open !== false) deps.io.openUrl(pairing.approve_url)
    if (route === 'notification') {
      const email = (flags.approvalEmail ?? (interactive ? await deps.io.text?.('Account email') : null))?.trim()
      if (!email) {
        deps.io.err('For an approval notification, run `notifai init --approval notification --approval-email <email>`; QR and browser approval use the same pairing.')
        return false
      }
      if (email.toLowerCase() !== pairing.approval_email?.toLowerCase()) {
        try { await client.requestPairingNotification(pairing.pairing_id, pairing.poll_verifier, email) }
        catch (err) { reportError(deps, err); return false }
        pairing.approval_email = email
        writePendingPairing(deps.env, pairing)
      }
      deps.io.out('Approval invitation requested. Review it if it arrives; QR and browser approval remain available.')
    }
    // The default QR does not open a browser or send an approval notification.
    void resumed
    return true
  }

  // A handshake started against another service, or under another machine
  // name, is not this one; only an identical errand is resumed.
  let pairing = readPendingPairing(deps.env, now())
  if (pairing !== null && (pairing.base_url !== baseUrl || (flags.name !== undefined && flags.name !== pairing.machine_name))) {
    clearPendingPairing(deps.env)
    pairing = null
  }
  let resumed = pairing !== null
  let active: PendingPairing
  if (pairing === null) {
    const started = await startPairing()
    if (typeof started === 'number') return started
    active = started
  } else {
    active = pairing
  }

  let expiresAt = Date.parse(active.expires_at)
  let intervalMs = Math.max(active.poll_interval_seconds, 1) * 1000
  const approvalWaitMessage = (): string => {
    const remainingSec = Math.max(0, Math.ceil((expiresAt - now()) / 1000))
    const minutes = Math.floor(remainingSec / 60)
    const seconds = remainingSec % 60
    const remaining =
      minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`
    return `Waiting for approval… code ${active.code} · ${remaining} left`
  }
  const progress: { spinner?: CommandSpinner | null } = {}
  let announced = false
  const announceActive = async (): Promise<boolean> => {
    if (announced) return true
    const ready = await announce(active, resumed)
    announced = true
    if (ready && interactive) progress.spinner = await deps.io.spinner?.(approvalWaitMessage()) ?? null
    return ready
  }

  // A resumed handshake the service no longer knows is replaced once, in the
  // same run, so the User is handed a fresh code instead of a dead end.
  const replaceStale = async (): Promise<boolean> => {
    progress.spinner?.stop('Previous approval expired')
    progress.spinner = null
    clearPendingPairing(deps.env)
    if (!resumed) return false
    const started = await startPairing()
    if (typeof started === 'number') return false
    active = started
    resumed = false
    expiresAt = Date.parse(active.expires_at)
    intervalMs = Math.max(active.poll_interval_seconds, 1) * 1000
    announced = false
    return true
  }

  for (;;) {
    let poll
    try {
      poll = await client.pollPairing(active.pairing_id, active.poll_verifier)
    } catch (err) {
      if (err instanceof NetworkError) {
        if (!await announceActive()) { onBlocked?.(pendingApprovalBlocker(active, deps.env)); return EXIT.auth }
        if (!interactive) {
          // The handshake is intact; only this check could not be made.
          deps.io.err(err.message)
          deps.io.out(`Waiting for approval. Run \`${SETUP_COMMAND}\` again once it is approved.`)
          onBlocked?.(pendingApprovalBlocker(active, deps.env))
          return EXIT.network
        }
        progress.spinner?.message(`Connection lost — retrying… code ${active.code}`)
        await sleep(intervalMs)
        continue
      }
      if (err instanceof ApiCallError && err.code === 'pairing_not_found' && resumed) {
        if (await replaceStale()) continue
        return EXIT.auth
      }
      progress.spinner?.error('Pairing failed')
      return reportError(deps, err)
    }
    if (poll.status === 'approved' && poll.machine_id) {
      deps.store.save({ machineId: poll.machine_id, secret: active.secret, baseUrl, machineName: active.machine_name })
      clearPendingPairing(deps.env)
      if (interactive) {
        progress.spinner?.stop(`Machine "${active.machine_name}" approved`)
        await deps.io.outro?.(`Credential stored in ${deps.store.describe()}`)
      } else {
        deps.io.out(`Machine "${active.machine_name}" approved. Credential stored in ${deps.store.describe()}.`)
      }
      return EXIT.ok
    }
    if (poll.status === 'denied') {
      clearPendingPairing(deps.env)
      progress.spinner?.error('Pairing denied')
      deps.io.err('Pairing was denied.')
      onBlocked?.(pairingOutcomeBlocker('denied', 'you denied this computer'))
      return EXIT.auth
    }
    // Proof-gated: the server never returns this from lookup. Stop now rather
    // than waiting out a TTL no approval can arrive within.
    if (poll.status === 'no_active_plan') {
      clearPendingPairing(deps.env)
      // The server owns which access errand is current — requesting it today,
      // choosing a plan after cutover — so its line wins whenever it sends one.
      const accessUrl = setupAccessUrl(baseUrl)
      const next = poll.next_action ?? `Open ${accessUrl} to set up access, then retry.`
      progress.spinner?.error('Pairing stopped')
      // One wall, said once. When a caller takes the blocker it closes the
      // visit on this exact errand, so repeating the destination here would
      // leave the User three phrasings of one step to choose between.
      if (onBlocked === undefined) {
        deps.io.err('This account has no active plan or temporary Alpha access.')
        deps.io.err(`next: ${next}`)
        deps.io.err(`After access is granted, run \`${SETUP_COMMAND}\` again.`)
      }
      onBlocked?.({
        id: 'auth',
        title: 'Access',
        status: 'gap',
        detail: 'this account does not have access to Notifai yet',
        technical: { access_url: accessUrl, next_action: next },
        remedy: { by: 'user-elsewhere', summary: next },
      })
      return EXIT.auth
    }
    if (poll.status === 'expired') {
      if (await replaceStale()) continue
      break
    }
    if (!await announceActive()) {
      onBlocked?.(pendingApprovalBlocker(active, deps.env))
      return EXIT.auth
    }
    // Still pending. Nobody at this terminal means nobody to wait for: hand
    // the errand back and let the next run resume the same handshake.
    if (!interactive) {
      deps.io.out(`Waiting for approval. Run \`${SETUP_COMMAND}\` again once it is approved.`)
      onBlocked?.(pendingApprovalBlocker(active, deps.env))
      return EXIT.auth
    }
    if (now() >= expiresAt) break
    progress.spinner?.message(approvalWaitMessage())
    await sleep(Math.min(intervalMs, Math.max(0, expiresAt - now())))
  }
  clearPendingPairing(deps.env)
  progress.spinner?.error('Pairing expired')
  deps.io.err(`Pairing expired before it was approved. Run \`${SETUP_COMMAND}\` again.`)
  onBlocked?.(pairingOutcomeBlocker('expired', 'the approval expired before it was given'))
  return EXIT.auth
}

/**
 * Remove this machine's credential. `--revoke` first revokes it on the
 * service, so a copy that left this machine stops working too; if the
 * service cannot be reached the credential is kept, because removing it
 * would leave an Approved Machine nobody here can revoke.
 */
export async function logoutCommand(deps: CommandDeps, flags: { revoke?: boolean } = {}): Promise<number> {
  const credential = deps.store.load()
  if (flags.revoke && credential) {
    const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
    try {
      await client.revokeMachine()
    } catch (err) {
      const alreadyGone = err instanceof ApiCallError && (err.code === 'machine_revoked' || err.status === 401)
      if (!alreadyGone) {
        const code = reportError(deps, err)
        deps.io.err('next: Retry `notifai logout --revoke`, or revoke this computer in the dashboard.')
        return code
      }
    }
  }
  deps.store.clear()
  clearPendingPairing(deps.env)
  if (flags.revoke && credential) {
    deps.io.out('This computer was signed out and its machine credential revoked.')
  } else if (flags.revoke) {
    deps.io.out('This computer was not signed in; there was nothing to revoke.')
  } else {
    deps.io.out('Machine credential removed. Run `notifai logout --revoke` or revoke it in the dashboard if a copy may exist elsewhere.')
  }
  return EXIT.ok
}

/**
 * The approval this computer is waiting for, so a signed-in Companion App on
 * the same machine can offer it to the User; the next `notifai login` or
 * `notifai init` collects the credential. The poll verifier and the
 * credential-to-be stay private to the CLI.
 */
function pendingApprovalView(deps: CommandDeps): { pending_approval?: Record<string, string> } {
  const now = (deps.now ?? Date.now)()
  const pending = readPendingPairing(deps.env, now)
  if (pending === null || !(Date.parse(pending.expires_at) > now)) return {}
  return {
    pending_approval: {
      code: pending.code,
      approve_url: pending.approve_url,
      base_url: pending.base_url,
      machine_name: pending.machine_name,
      expires_at: pending.expires_at,
    },
  }
}

/** What a Companion App on this machine hands the CLI after approving it. */
interface AdoptedCredentialInput {
  machine_id: string
  secret: string
  base_url: string
  machine_name: string
}

const ADOPT_MACHINE_ID = /^mac_[A-Za-z0-9_-]+$/
const ADOPT_SECRET = /^[A-Za-z0-9_-]{32,}$/

function parseAdoptInput(raw: string): AdoptedCredentialInput | string {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return 'standard input is not JSON'
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'standard input is not a JSON object'
  const input = value as Record<string, unknown>
  const machineId = input['machine_id']
  const secret = input['secret']
  const baseUrl = input['base_url']
  const machineName = input['machine_name']
  if (typeof machineId !== 'string' || !ADOPT_MACHINE_ID.test(machineId)) return 'machine_id is missing or malformed'
  if (typeof secret !== 'string' || !ADOPT_SECRET.test(secret)) return 'secret is missing or malformed'
  if (typeof machineName !== 'string' || machineName.trim() === '') return 'machine_name is missing'
  if (typeof baseUrl !== 'string') return 'base_url is missing'
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return 'base_url is not a URL'
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
    return 'base_url must be an http or https origin without credentials'
  }
  return { machine_id: machineId, secret, base_url: url.origin, machine_name: machineName.trim() }
}

/**
 * Store a machine credential that a Companion App on this machine already
 * obtained, so one sign-in sets up both. The CLI stays the only writer of its
 * credential store. The secret arrives on standard input only, never argv,
 * and an existing different credential is never replaced: sign out first.
 */
export function authAdoptCommand(
  deps: CommandDeps,
  flags: { stdin?: boolean; json?: boolean },
  readInput: () => string,
): number {
  const fail = (exitCode: number, code: string, message: string, extra: Record<string, unknown> = {}): number => {
    if (flags.json) deps.io.out(JSON.stringify({ adopted: false, error: { code, message }, ...extra }, null, 2))
    else deps.io.err(message)
    return exitCode
  }
  if (!flags.stdin) {
    return fail(EXIT.usage, 'input_required', 'Pass --stdin and write the credential JSON to standard input.')
  }
  let raw: string
  try {
    raw = readInput()
  } catch (err) {
    return fail(EXIT.usage, 'input_unreadable', `Could not read standard input: ${String(err)}`)
  }
  const input = parseAdoptInput(raw)
  if (typeof input === 'string') return fail(EXIT.usage, 'invalid_credential', `Credential not adopted: ${input}.`)

  const existing = deps.store.load()
  if (existing && (existing.machineId !== input.machine_id || existing.secret !== input.secret)) {
    return fail(
      EXIT.failed,
      'already_signed_in',
      `This computer is already signed in as machine "${existing.machineName}" (${existing.machineId}). Run \`notifai logout --revoke\` first to replace it.`,
      { machine_id: existing.machineId },
    )
  }
  const credential = existing ?? {
    machineId: input.machine_id,
    secret: input.secret,
    baseUrl: input.base_url,
    machineName: input.machine_name,
  }
  if (!existing) {
    try {
      deps.store.save(credential)
    } catch (err) {
      return fail(EXIT.failed, 'store_failed', `Credential not adopted: ${err instanceof Error ? err.message : String(err)}.`)
    }
  }
  clearPendingPairing(deps.env)
  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        {
          adopted: true,
          machine_id: credential.machineId,
          machine_name: credential.machineName,
          base_url: credential.baseUrl,
          store: deps.store.describe(),
        },
        null,
        2,
      ),
    )
  } else {
    deps.io.out(`Signed in as machine "${credential.machineName}" (${credential.machineId})`)
  }
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
          : { signed_in: false, ...pendingApprovalView(deps) },
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
