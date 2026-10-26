import { adoptHubNetwork, notifyCredentialChanged } from './hub-client.js'
import { finishBeforeExit } from './exit-work.js'
import { type AccountAccessResponse, type PollPairingResponse } from '@raidiant/notifai-protocol'
import { sha256Hex } from '@raidiant/notifai-protocol/node'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { renderPairingQr, terminalPairingQr, pairingQrPath, pairingQrTextPath } from './pairing-qr.js'
import { ApiCallError, NetworkError, isRetryableReplyPollError } from './client.js'
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
import { NO_ACTIVE_PLAN_LINE, plansUrl } from './setup-destinations.js'
import {
  clearPendingPairing,
  readPendingPairing,
  writePendingPairing,
  type PendingPairing,
} from './pending-pairing.js'
import type { ReadinessState } from './readiness.js'
import {
  NOT_YOUR_ACCOUNT_LINE,
  approveMessage,
  renewedApproveMessage,
  approveTerminalLines,
  connectedTerminalLine,
} from './setup-journey.js'

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

/**
 * The longest one approval wait may run by this computer's own clock, and the
 * approval lifetime this computer asks the service for. The service owns the
 * lifetime (thirty minutes; ten for a service that predates the request), but
 * its expiry is a timestamp from the service's clock: a computer whose clock
 * is hours behind, with the service unreachable, would otherwise keep waiting
 * for those hours.
 */
const PAIRING_WAIT_CEILING_MS = 30 * 60 * 1000

/** Why a machine approval is not (yet) a credential, as an agent reads it. */
export type PairingOutcome = 'pending' | 'denied' | 'expired' | 'not_started' | 'stopped'

/** A waiting approval is kept open once less than this is left of it. */
const EXTEND_WHEN_LEFT_MS = 60 * 1000

/**
 * How `init` runs an approval: it opens the approval page, keeps the approval
 * open while it waits, and stops after a bounded time instead of handing out
 * code after code. `notifai login` on its own keeps its earlier behavior.
 */
export interface GuidedApproval {
  /** Open the approval page in this computer's browser, once per approval. */
  open: boolean
  /**
   * How long setup waits for one approval before it stops. It counts from
   * when the approval began (a replacement code keeps the original start),
   * kept with the handshake on disk, so reruns and pauses between them never
   * restart it. Only a run after setup stopped starts a new wait.
   */
  stopAfterMs: number
  /**
   * Unattended runs only: until when to keep polling a pending approval. It
   * sees the state an agent would relay, so a message the User has not been
   * given yet returns at once.
   */
  waitUntil?: (pending: ReadinessState) => number
  /**
   * The approval landed; `email` is the Account it joined, when known, and
   * `browserOpened` says setup had opened the approval page in this
   * computer's browser.
   */
  onConnected?: (email: string | null, browserOpened: boolean) => void
}

/**
 * The conversation message an agent sends the User as written. It carries the
 * proof-bearing link and QR, so it never belongs in a Notification Request.
 */
export function pairingApprovalMessage(pairing: Pick<PendingPairing, 'code' | 'approve_url' | 'browser_opened' | 'renewed'>): string {
  const options = { code: pairing.code, url: pairing.approve_url, opened: pairing.browser_opened === true }
  return pairing.renewed === true ? renewedApproveMessage(options) : approveMessage(options)
}

/**
 * The name a computer gets when the User names none: its hostname, without
 * the `.local` that macOS appends for the local network. It is what the
 * approval screen and the setup notification show, so it should read like the
 * computer's name.
 */
export function defaultMachineName(hostname: string): string {
  const name = hostname.replace(/\.local\.?$/i, '')
  return name.length > 0 ? name : hostname
}

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
        message: pairingApprovalMessage(pairing),
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
          : outcome === 'stopped'
            ? 'nobody approved this computer in 90 minutes; start setup again when the User asks'
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
  flags: { name?: string; baseUrl?: string; open?: boolean; approval?: string; approvalEmail?: string; guided?: GuidedApproval },
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
    const machineName = flags.name ?? defaultMachineName(os.hostname())
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
        lifetime_seconds: PAIRING_WAIT_CEILING_MS / 1000,
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
        'next: When the User self-hosts the dashboard on its own origin and asks you to allow it, run ' +
          '`notifai config set approve_origins <origin>`, then `notifai login` again.',
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
      wait_started_at: new Date(now()).toISOString(),
    }
    writePendingPairing(deps.env, started)
    return started
  }

  let route = flags.approval ?? (flags.approvalEmail ? 'notification' : 'qr')
  // What a check made while a prompt was open found, for the loop to act on.
  const observed: { latest: { poll: PollPairingResponse } | { error: unknown } | null } = { latest: null }

  /**
   * Ask the person at this terminal something while the approval keeps being
   * checked. A prompt waits on the keyboard for ever, and the approval is
   * given somewhere else — a phone, a browser — so nothing typed here may
   * stand between that approval and this command noticing it. Any answer
   * other than pending, or the end of the wait, dismisses the prompt.
   */
  const askWhileWatching = async (
    ask: (signal: AbortSignal) => Promise<string | null>,
  ): Promise<{ answer: string | null } | 'settled'> => {
    const dismiss = new AbortController()
    let answered = false
    const watch = async (): Promise<void> => {
      for (;;) {
        await sleep(Math.min(intervalMs, Math.max(0, waitEndsAt() - now())))
        if (answered) return
        if (now() >= waitEndsAt()) break
        try {
          const poll = await client.pollPairing(active.pairing_id, active.poll_verifier)
          if (answered) return
          if (poll.status === 'pending') continue
          observed.latest = { poll }
        } catch (error) {
          if (answered) return
          if (isRetryableReplyPollError(error)) continue
          observed.latest = { error }
        }
        break
      }
      dismiss.abort()
    }
    void watch()
    const answer = await ask(dismiss.signal)
    answered = true
    return dismiss.signal.aborted ? 'settled' : { answer }
  }

  /** `settled` when the approval resolved, or its wait ended, while the User was being asked. */
  const announceGuided = async (pairing: PendingPairing, guidance: GuidedApproval): Promise<void> => {
    const file = await renderPairingQr(deps.env, pairing.approve_url)
    // The approval notification is its own route: nothing opens here.
    if (guidance.open && route !== 'notification' && pairing.browser_opened !== true) {
      deps.io.openUrl(pairing.approve_url)
      pairing.browser_opened = true
      writePendingPairing(deps.env, pairing)
    }
    const opened = pairing.browser_opened === true
    if (interactive) {
      for (const line of approveTerminalLines({ code: pairing.code, url: pairing.approve_url, opened, renewed: pairing.renewed === true })) deps.io.out(line)
      deps.io.out('  Or scan this with the Notifai app:')
      deps.io.out(await terminalPairingQr(pairing.approve_url))
      return
    }
    deps.io.out(`Pairing code: ${pairing.code}`)
    deps.io.out(`${opened ? 'Opened the approval page' : 'Approval page'}: ${pairing.approve_url}`)
    deps.io.out(`Local QR image: ${file}`)
  }

  const announce = async (pairing: PendingPairing, resumed: boolean): Promise<'ready' | 'blocked' | 'settled'> => {
    if (flags.guided !== undefined) {
      await announceGuided(pairing, flags.guided)
      return route === 'notification' ? await requestNotification(pairing) : 'ready'
    }
    const file = await renderPairingQr(deps.env, pairing.approve_url)
    deps.io.out(`Pairing code: ${pairing.code}`)
    if (route === 'qr') {
      if (interactive && deps.io.note) await deps.io.note(await terminalPairingQr(pairing.approve_url), 'Scan to approve in Notifai')
      else {
        deps.io.out('Scan to approve in Notifai:')
        deps.io.out(await terminalPairingQr(pairing.approve_url, false))
      }
      // A person here already sees the QR above; the image is for an agent to show.
      if (!interactive) deps.io.out(`Local QR image: ${file}`)
    }
    if (interactive && flags.approval === undefined && flags.approvalEmail === undefined && deps.io.select) {
      const io = deps.io
      const choice = await askWhileWatching(async (signal) => await io.select?.('How do you want to approve it?', [
        { value: 'qr', label: 'Scan the QR', hint: 'with your phone\'s camera or the Notifai app' },
        { value: 'notification', label: 'Send approval notification', hint: 'Enter your Account email' },
        { value: 'browser', label: 'Use browser approval' },
      ], signal) ?? null)
      if (choice === 'settled') return 'settled'
      route = choice.answer ?? 'qr'
    }
    deps.io.out(`Browser alternative: ${pairing.approve_url}`)
    if (route === 'browser' && flags.open !== false) deps.io.openUrl(pairing.approve_url)
    if (route === 'notification') return await requestNotification(pairing)
    // The default QR does not open a browser or send an approval notification.
    void resumed
    return 'ready'
  }

  async function requestNotification(pairing: PendingPairing): Promise<'ready' | 'blocked' | 'settled'> {
    let typed: string | null = null
    if (flags.approvalEmail === undefined && interactive && deps.io.text) {
      const io = deps.io
      const entry = await askWhileWatching(async (signal) => await io.text?.('Account email', signal) ?? null)
      if (entry === 'settled') return 'settled'
      typed = entry.answer
    }
    const email = (flags.approvalEmail ?? typed)?.trim()
    if (!email) {
      deps.io.err('For an approval notification, run `notifai init --approval notification --approval-email <email>`; QR and browser approval use the same pairing.')
      return 'blocked'
    }
    if (email.toLowerCase() !== pairing.approval_email?.toLowerCase()) {
      try { await client.requestPairingNotification(pairing.pairing_id, pairing.poll_verifier, email) }
      catch (err) { reportError(deps, err); return 'blocked' }
      pairing.approval_email = email
      writePendingPairing(deps.env, pairing)
    }
    deps.io.out('Approval invitation requested. Review it if it arrives; QR and browser approval remain available.')
    return 'ready'
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
  let waitStartedAt = now()
  const guided = flags.guided
  // The User asked again after setup stopped waiting (or the handshake
  // predates the record): a new wait for the same code starts now.
  if (guided !== undefined && (active.wait_started_at === undefined || active.wait_stopped === true)) {
    active.wait_started_at = new Date(now()).toISOString()
    delete active.wait_stopped
    writePendingPairing(deps.env, active)
  }
  /** When setup stops waiting for this approval. */
  const stopAt = (): number => {
    const since = Date.parse(active.wait_started_at ?? '')
    return (Number.isNaN(since) ? waitStartedAt : since) + (guided?.stopAfterMs ?? 0)
  }
  // A guided approval is kept open while it is waited for; an older service
  // that cannot do that ends the wait at the approval's expiry.
  let canExtend = guided !== undefined
  // When this run stops waiting: the approval's expiry, or the ceiling.
  const waitEndsAt = (): number => guided === undefined
    ? Math.min(expiresAt, waitStartedAt + PAIRING_WAIT_CEILING_MS)
    : canExtend ? stopAt() : Math.min(expiresAt, stopAt())

  /** Keep the approval open, with the same code, once it is about to expire. */
  const extendIfDue = async (force = false): Promise<boolean> => {
    if (!canExtend) return false
    if (!force && expiresAt - now() > EXTEND_WHEN_LEFT_MS) return false
    try {
      const extended = await client.extendPairing(active.pairing_id, active.poll_verifier, PAIRING_WAIT_CEILING_MS / 1000)
      active.expires_at = extended.expires_at
      active.poll_interval_seconds = extended.poll_interval_seconds
      expiresAt = Date.parse(extended.expires_at)
      intervalMs = Math.max(extended.poll_interval_seconds, 1) * 1000
      writePendingPairing(deps.env, active)
      return true
    } catch (err) {
      // Unreachable now is retried at the next check. Anything else is final
      // for this approval: an older service without extension, an approval
      // that is no longer pending, or one too old to keep open.
      if (!(err instanceof NetworkError || isRetryableReplyPollError(err))) canExtend = false
      return false
    }
  }
  const approvalWaitMessage = (): string => {
    if (guided !== undefined) return `Waiting… code ${active.code}`
    const remainingSec = Math.max(0, Math.ceil((expiresAt - now()) / 1000))
    const minutes = Math.floor(remainingSec / 60)
    const seconds = remainingSec % 60
    const remaining =
      minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`
    return `Waiting for approval… code ${active.code} · ${remaining} left`
  }
  const progress: { spinner?: CommandSpinner | null } = {}
  let announced = false
  const announceActive = async (): Promise<'ready' | 'blocked' | 'settled'> => {
    if (announced) return 'ready'
    const outcome = await announce(active, resumed)
    announced = true
    if (outcome === 'ready' && interactive) progress.spinner = await deps.io.spinner?.(approvalWaitMessage()) ?? null
    return outcome
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
    waitStartedAt = now()
    announced = false
    return true
  }

  /** A guided approval that expired anyway gets a new code, while the run still waits. */
  const renew = async (): Promise<boolean> => {
    progress.spinner?.stop(`Code ${active.code} expired`)
    progress.spinner = null
    const since = active.wait_started_at
    clearPendingPairing(deps.env)
    const started = await startPairing()
    if (typeof started === 'number') return false
    active = started
    active.renewed = true
    // A new code, the same wait: the stop still counts from the first one.
    if (since !== undefined) active.wait_started_at = since
    writePendingPairing(deps.env, active)
    resumed = false
    canExtend = true
    expiresAt = Date.parse(active.expires_at)
    intervalMs = Math.max(active.poll_interval_seconds, 1) * 1000
    announced = false
    return true
  }

  /**
   * Nobody approved within the bounded wait. The handshake stays saved, so an
   * approval given after this is collected by the next run.
   */
  const stopWaiting = (): number => {
    progress.spinner?.error('Not approved in 90 minutes')
    progress.spinner = null
    active.wait_stopped = true
    writePendingPairing(deps.env, active)
    if (interactive) deps.io.err("This computer wasn't approved in 90 minutes, so setup stopped. Run `notifai init` again when you want to try again.")
    onBlocked?.(pairingOutcomeBlocker('stopped', 'nobody approved this computer in 90 minutes'))
    return EXIT.auth
  }

  for (;;) {
    let poll
    const carried = observed.latest
    observed.latest = null
    try {
      if (carried !== null && 'error' in carried) throw carried.error
      poll = carried?.poll ?? await client.pollPairing(active.pairing_id, active.poll_verifier)
    } catch (err) {
      // A person at this terminal rides out a dropped connection or a
      // temporary service failure; an unattended run reports it at once.
      if (err instanceof NetworkError || (interactive && isRetryableReplyPollError(err))) {
        const announcement = await announceActive()
        if (announcement === 'settled') continue
        if (announcement === 'blocked') { onBlocked?.(pendingApprovalBlocker(active, deps.env)); return EXIT.auth }
        if (!interactive) {
          // The handshake is intact; only this check could not be made.
          deps.io.err(err instanceof Error ? err.message : String(err))
          deps.io.out(`Waiting for approval. Run \`${SETUP_COMMAND}\` again once it is approved.`)
          onBlocked?.(pendingApprovalBlocker(active, deps.env))
          return EXIT.network
        }
        // The approval cannot be given past its deadline, so retrying past it
        // only leaves the User watching a spinner. The handshake stays saved:
        // an approval that did land is collected by the next run.
        if (now() >= waitEndsAt()) {
          progress.spinner?.error('Could not reach Notifai')
          deps.io.err(`Could not check approval before the wait ended: ${err instanceof Error ? err.message : String(err)}`)
          deps.io.err(`next: Once this computer is online, run \`${SETUP_COMMAND}\` again. An approval you already gave is picked up; otherwise you get a new code.`)
          onBlocked?.(pendingApprovalBlocker(active, deps.env))
          return EXIT.network
        }
        progress.spinner?.message(`Connection lost — retrying… code ${active.code}`)
        await sleep(Math.min(intervalMs, Math.max(0, waitEndsAt() - now())))
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
      // A running hub drops the previous credential before this returns, and
      // reaches the service the way this sign-in just did.
      await notifyCredentialChanged(deps.env)
      await adoptHubNetwork(deps.env)
      if (guided !== undefined) {
        // Name the Account: a signed-in app that is not the User's own could
        // have scanned the QR.
        let email: string | null = null
        try {
          email = (await makeClient(deps, baseUrl, `Bearer nfm_${poll.machine_id}.${active.secret}`).accessStatus()).email ?? null
        } catch {
          // Best-effort: the line still says the computer is connected.
        }
        const connected = connectedTerminalLine(email, active.machine_name)
        if (progress.spinner) progress.spinner.stop(connected)
        else deps.io.out(connected)
        if (interactive) deps.io.out(NOT_YOUR_ACCOUNT_LINE)
        guided.onConnected?.(email, active.browser_opened === true)
      } else if (onBlocked !== undefined) {
        // Inside setup, which carries on and closes with what is now true:
        // where the credential lives is a detail no one acts on here.
        const connected = `This computer is connected to your account as "${active.machine_name}".`
        if (progress.spinner) progress.spinner.stop(connected)
        else deps.io.out(connected)
      } else if (interactive) {
        if (progress.spinner) progress.spinner.stop(`Machine "${active.machine_name}" approved`)
        else deps.io.out(`Machine "${active.machine_name}" approved`)
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
    // Proof-gated: the server never returns this from lookup. A current
    // service approves computers without a plan and never sends it; an older
    // one may, so stop rather than wait out a TTL no approval can arrive in.
    if (poll.status === 'no_active_plan') {
      clearPendingPairing(deps.env)
      const accessUrl = plansUrl(baseUrl)
      const next = `Choose one at ${accessUrl}`
      progress.spinner?.error('Pairing stopped')
      // One line, said once. When a caller takes the blocker it closes the
      // visit on this exact errand.
      if (onBlocked === undefined) deps.io.err(`no_active_plan: ${NO_ACTIVE_PLAN_LINE} ${next}`)
      onBlocked?.({
        id: 'auth',
        title: 'Plan',
        status: 'gap',
        detail: NO_ACTIVE_PLAN_LINE,
        technical: { plan_required: true, access_url: accessUrl, next_action: next },
        remedy: { by: 'user-elsewhere', summary: next },
      })
      return EXIT.auth
    }
    if (poll.status === 'expired') {
      if (guided !== undefined) {
        // The service keeps an expired approval for a while; reopening it
        // keeps the code the User may be looking at.
        if (await extendIfDue(true)) continue
        if (now() >= stopAt()) return stopWaiting()
        if (await renew()) continue
        return EXIT.auth
      }
      if (await replaceStale()) continue
      break
    }
    const announcement = await announceActive()
    if (announcement === 'settled') continue
    if (announcement === 'blocked') {
      onBlocked?.(pendingApprovalBlocker(active, deps.env))
      return EXIT.auth
    }
    if (guided !== undefined) {
      if (now() >= stopAt()) return stopWaiting()
      // A person here is waited for until the run stops; an agent until its
      // own wait is up, or at once when it has something new to relay.
      const until = interactive
        ? stopAt()
        : Math.min(guided.waitUntil?.(pendingApprovalBlocker(active, deps.env)) ?? now(), stopAt())
      if (now() >= until) {
        onBlocked?.(pendingApprovalBlocker(active, deps.env))
        return EXIT.auth
      }
      await extendIfDue()
      progress.spinner?.message(approvalWaitMessage())
      await sleep(Math.min(intervalMs, until - now()))
      continue
    }
    // Still pending. Nobody at this terminal means nobody to wait for: hand
    // the errand back and let the next run resume the same handshake.
    if (!interactive) {
      deps.io.out(`Waiting for approval. Run \`${SETUP_COMMAND}\` again once it is approved.`)
      onBlocked?.(pendingApprovalBlocker(active, deps.env))
      return EXIT.auth
    }
    if (now() >= waitEndsAt()) break
    progress.spinner?.message(approvalWaitMessage())
    await sleep(Math.min(intervalMs, Math.max(0, waitEndsAt() - now())))
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
  // The hub acknowledges that it dropped the credential, or is terminated:
  // nothing is sent with it after sign-out.
  await notifyCredentialChanged(deps.env)
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
    finishBeforeExit(notifyCredentialChanged(deps.env).then(() => adoptHubNetwork(deps.env)))
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
      deps.io.out(`${NO_ACTIVE_PLAN_LINE} Choose one at ${plansUrl(authed.baseUrl)}`)
      return EXIT.failed
    }
    const expiry = access.expires_at ? ` until ${access.expires_at}` : ''
    deps.io.out(`Access active (${access.reason})${expiry}`)
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}
