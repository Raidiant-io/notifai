/**
 * The words and the memory of one guided setup.
 *
 * `notifai init` walks the User through approving this computer, getting the
 * phone app and choosing a plan, most of which happens somewhere else: a
 * browser, a phone. An agent runs `init --json --wait <seconds>` again and
 * again while the User does that, and must say each thing once. So this
 * module keeps, per setup run, which message the agent was last given, since
 * when nothing has changed, and which pages setup already opened. A run ends
 * when setup finishes or stops; the next one starts fresh.
 *
 * The copy lives here so the agent's chat and the terminal say the same
 * thing in the same order.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { HARNESS_LABELS, HOOK_INSTALLABLE_HARNESSES, type HookInstallableHarness } from './harnesses.js'
import { codexHooksTerminalLine, codexNextStep, type CodexSurface } from './codex-surface.js'
import { COMPANION_INSTALL_URLS, deviceNoun, MAC_DOWNLOAD_URL } from './setup-destinations.js'

/** A wait with nothing changing ends here, with what is left. */
export const NO_PROGRESS_STOP_MS = 30 * 60 * 1000
/**
 * Approving this computer gets three approval lifetimes before setup stops,
 * counted from when the approval began (kept with the handshake, not the run).
 */
export const APPROVAL_STOP_MS = 90 * 60 * 1000
/** A phone that registered this recently and has not answered the notification prompt yet is waited for. */
export const NOTIFICATION_GRACE_MS = 2 * 60 * 1000
/** A run the agent has not continued for this long is over; the next one starts fresh. */
const RUN_IDLE_MS = 15 * 60 * 1000

export interface SetupRun {
  started_at: number
  updated_at: number
  /** Digest of the last message handed to the agent. */
  relayed?: string
  /** What the wait was last waiting for, and since when. */
  progress_key?: string
  progress_since?: number
  /** This computer was approved during this run. */
  connected_in_run?: boolean
  /**
   * Setup opened the approval page in this computer's browser and the
   * approval landed, so that page walks the phone steps next: the agent and
   * the terminal point at it instead of showing a second QR.
   */
  phone_in_browser?: boolean
  /** Pages this run opened, so a rerun does not open them again. */
  opened?: string[]
  /** When this run first saw each Device Installation. */
  first_seen?: Record<string, number>
}

function setupRunPath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'setup-run.json')
}

export function freshSetupRun(now: number): SetupRun {
  return { started_at: now, updated_at: now }
}

/** The run an agent is continuing, or a fresh one. */
export function loadSetupRun(env: NodeJS.ProcessEnv, now: number): SetupRun {
  const file = setupRunPath(env)
  if (!existsSync(file)) return freshSetupRun(now)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SetupRun
    if (typeof parsed.started_at !== 'number' || typeof parsed.updated_at !== 'number') return freshSetupRun(now)
    if (now - parsed.updated_at > RUN_IDLE_MS || parsed.updated_at > now) return freshSetupRun(now)
    return parsed
  } catch {
    return freshSetupRun(now)
  }
}

export function saveSetupRun(env: NodeJS.ProcessEnv, run: SetupRun, now: number): void {
  try {
    atomicWriteFileSync(setupRunPath(env), `${JSON.stringify({ ...run, updated_at: now })}\n`, {
      mode: 0o600,
      requireCurrentUserOwner: true,
    })
  } catch {
    // Without the record a message may be said twice; setup itself is unaffected.
  }
}

export function clearSetupRun(env: NodeJS.ProcessEnv): void {
  try { unlinkSync(setupRunPath(env)) } catch { /* Already absent. */ }
}

export function messageDigest(message: string): string {
  return createHash('sha256').update(message).digest('hex').slice(0, 32)
}

function appsChoicePath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'setup-apps.json')
}

/**
 * The agent apps the User chose for this computer, kept so the apps question
 * is asked once: a later setup run takes the answer, "none" included. Null
 * when the User was never asked.
 */
export function loadAppsChoice(env: NodeJS.ProcessEnv): HookInstallableHarness[] | null {
  try {
    const parsed = JSON.parse(readFileSync(appsChoicePath(env), 'utf8')) as { apps?: unknown }
    if (!Array.isArray(parsed.apps)) return null
    return HOOK_INSTALLABLE_HARNESSES.filter((app) => (parsed.apps as unknown[]).includes(app))
  } catch {
    return null
  }
}

export function saveAppsChoice(env: NodeJS.ProcessEnv, apps: readonly HookInstallableHarness[], now: number): void {
  try {
    atomicWriteFileSync(appsChoicePath(env), `${JSON.stringify({ apps, chosen_at: new Date(now).toISOString() })}\n`, {
      mode: 0o600,
      requireCurrentUserOwner: true,
    })
  } catch {
    // Without the record a later run asks again; setup itself is unaffected.
  }
}

/** A browser opened from here would open on the remote machine, not in front of the User. */
export function isSshSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['SSH_CONNECTION']?.trim() || env['SSH_TTY']?.trim())
}

/** `--apps`: comma-separated agent app ids, or `detected`. */
export function parseApps(value: string, detected: readonly HookInstallableHarness[]): HookInstallableHarness[] | string {
  const ids = value.split(',').map((id) => id.trim()).filter((id) => id !== '')
  if (ids.length === 1 && ids[0] === 'detected') return [...detected]
  const unknown = ids.filter((id) => !(HOOK_INSTALLABLE_HARNESSES as readonly string[]).includes(id))
  if (unknown.length > 0) {
    return `Unknown agent app "${unknown[0]}". Use comma-separated ids from: ${HOOK_INSTALLABLE_HARNESSES.join(', ')}, or \`detected\`.`
  }
  return HOOK_INSTALLABLE_HARNESSES.filter((id) => ids.includes(id))
}

function joinNames(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export function appNames(apps: readonly HookInstallableHarness[]): string {
  return joinNames(apps.map((app) => HARNESS_LABELS[app]))
}

/**
 * An app as the apps question names it. Codex also runs inside the ChatGPT
 * desktop app, and many people know it only as ChatGPT, so the question says
 * so once. Elsewhere it stays "Codex".
 */
export function appChoiceName(app: HookInstallableHarness): string {
  return app === 'codex' ? 'Codex (CLI, IDE or ChatGPT app)' : HARNESS_LABELS[app]
}

/** What each agent app needs once setup is done. */
const NEXT_STEP: Record<HookInstallableHarness, string> = {
  'claude-code': 'open a new session',
  codex: 'open a new session',
  cursor: 'start a new chat',
  opencode: 'restart it',
  openclaw: 'open a new session',
  hermes: 'open a new session',
  grok: 'open a new session',
}

/** The one question an agent asks: which agent apps to connect. */
export function appsQuestionMessage(detected: readonly HookInstallableHarness[]): string {
  return detected.length === 0
    ? '**Which agent apps should Notifai connect?**\n\nI found none on this computer. Pick the ones you use.'
    : `**Which agent apps should Notifai connect?**\n\nFound on this computer: ${joinNames(detected.map(appChoiceName))}. Keep these, or pick others.`
}

export const APPS_QUESTION = 'Connect Notifai to which agent apps?'

/**
 * The approval message. The QR itself is not part of it: the agent shows the
 * one at `technical.pairing.qr_text_path` (or the image) right after it.
 *
 * Agent messages keep one idea per paragraph, separated by a blank line: a
 * single line break renders as a space in Markdown, so the code and the
 * action would run together.
 */
export function approveMessage(options: { code: string; url: string; opened: boolean }): string {
  const open = options.opened
    ? `**Connect this computer** in the browser I opened.\n\nCheck the code: **${options.code}**\n\nDidn't open? [Open the approval page](${options.url})`
    : `**Connect this computer:** [open the approval page](${options.url}) on your computer.\n\nCheck the code: **${options.code}**`
  return `${open}\n\nOr scan this with the Notifai app:`
}

/**
 * A code that could not be kept open any longer (two hours) was replaced. The
 * open page cannot follow a new code, so setup opened the new one.
 */
export function renewedApproveMessage(options: { code: string; url: string; opened: boolean }): string {
  const open = options.opened
    ? `**That code expired.** I opened a new approval page.\n\nCheck the new code: **${options.code}**\n\nDidn't open? [Open the approval page](${options.url})`
    : `**That code expired.** [Open the new approval page](${options.url}) on your computer.\n\nCheck the new code: **${options.code}**`
  return `${open}\n\nOr scan this with the Notifai app:`
}

/** The terminal's approval lines; a replacement code is named once, as the new one. */
export function approveTerminalLines(options: { code: string; url: string; opened: boolean; renewed?: boolean }): string[] {
  if (options.renewed === true) {
    return options.opened
      ? [`That code expired. New one: ${options.code}`, `  Opened a new browser tab for it. Didn't open? ${options.url}`]
      : [`That code expired. New one: ${options.code}`, `  Open this on your computer: ${options.url}`]
  }
  return options.opened
    ? [`Opened your browser to connect this computer. Code: ${options.code}`, `  Didn't open? ${options.url}`]
    : [`Connect this computer. Code: ${options.code}`, `  Open this on your computer: ${options.url}`]
}

export function connectedMessage(email: string | null): string {
  return email === null
    ? '✓ **Connected.**\n\n_Not your Account? Tell me and I\'ll disconnect it._'
    : `✓ **Connected** to **${email}**.\n\n_Not your Account? Tell me and I'll disconnect it._`
}

export function connectedTerminalLine(email: string | null, machine: string): string {
  return email === null ? `Connected as "${machine}".` : `Connected to ${email} as "${machine}".`
}

export const NOT_YOUR_ACCOUNT_LINE = '  Not your Account? Run notifai logout --revoke'

export function expiredStopMessage(): string {
  return "**Setup stopped:** this computer wasn't approved within 90 minutes.\n\nAsk me any time to try again."
}

export const DENIED_MESSAGE = '**Setup stopped:** you declined this computer.\n\nAsk me any time to try again.'

export function phoneWebMessage(email: string | null, url: string, opened: boolean): string {
  const account = email === null ? '' : ` to **${email}**`
  const next = opened
    ? `**Now your phone:** follow the page I opened in your browser.\n\nDidn't open? [Open the phone setup page](${url})`
    : `**Now your phone:** [open the phone setup page](${url}) on your computer.`
  return `This computer is already connected${account}.\n\n${next}`
}

/** Right after a browser approval: the page that approved walks the phone steps. */
export const PHONE_IN_BROWSER_MESSAGE = '**Now your phone:** follow the page in your browser.'
export const PHONE_IN_BROWSER_TERMINAL_LINE = 'Now your phone: follow the page in your browser.'

export function noPhoneMessage(email: string | null): string {
  return '**Now set up your phone**\n\n' +
    `1. Get the Notifai app: [iPhone](${COMPANION_INSTALL_URLS.iphone}) or [Android (free test)](${COMPANION_INSTALL_URLS.android})\n` +
    `2. Sign in as **${email ?? 'the email you approved this computer with'}**\n` +
    '3. Allow notifications'
}

function linkText(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

export function planMessage(plansUrl: string): string {
  return '**Last step: choose a plan** in the Notifai app on your phone.\n\n' +
    `Or on the web: [${linkText(plansUrl)}](${plansUrl})\n\n` +
    "I'll send a test notification once it's active."
}

export type PhoneKind = 'iphone' | 'android' | 'other'

export function notificationSettingsPath(kind: PhoneKind): string {
  return kind === 'iphone'
    ? 'Settings → Notifai → Notifications'
    : kind === 'android'
      ? 'Settings → Apps → Notifai → Notifications'
      : 'its notification settings'
}

export function phoneKind(platform: unknown): PhoneKind {
  return platform === 'ios' ? 'iphone' : platform === 'android' ? 'android' : 'other'
}

export interface DoneFacts {
  email: string | null
  /** The phone whose notifications are off, when they are. */
  notificationsOff: PhoneKind | null
  apps: readonly HookInstallableHarness[]
  /** Codex hooks still need the User's approval. */
  codexNeedsApproval: boolean
  /** The Codex surface setup runs in, which decides how approval is worded; null or absent when not known. */
  codexSurface?: CodexSurface | null
  /** Apps that now run Notifai's commands without asking. */
  commandApps: readonly HookInstallableHarness[]
  /** This computer is a Mac, so the desktop app can run here too. */
  mac?: boolean
}

export const MAC_APP_LINE = `Want notifications on your Mac? [Download the desktop app here](${MAC_DOWNLOAD_URL})`

/** Codex's step in the done message carries its hook approval, so it reads as a step, not a footnote. */
function nextStep(app: HookInstallableHarness, facts: Pick<DoneFacts, 'codexNeedsApproval' | 'codexSurface'>): string {
  return app === 'codex' ? codexNextStep(facts.codexSurface ?? null, facts.codexNeedsApproval) : NEXT_STEP[app]
}

export function appsBlock(facts: Pick<DoneFacts, 'apps' | 'codexNeedsApproval' | 'codexSurface' | 'commandApps'>): string {
  if (facts.apps.length === 0) return ''
  const step = (app: HookInstallableHarness) => nextStep(app, facts)
  return '**To start:**\n\n' + facts.apps.map((app) => `- **${HARNESS_LABELS[app]}**: ${step(app)}`).join('\n') +
    (facts.commandApps.length > 0 ? `\n\n_${appNames(facts.commandApps)} can now run Notifai's commands without asking._` : '')
}

export function doneMessage(facts: DoneFacts): string {
  const account = facts.email === null ? '' : ` for **${facts.email}**`
  const warning = facts.notificationsOff === null
    ? ''
    : `⚠️ **Notifications are off on your ${deviceNoun(facts.notificationsOff)}.** ` +
      `Turn them on in ${notificationSettingsPath(facts.notificationsOff)}.\n\n`
  const mac = facts.mac === true ? `\n\n${MAC_APP_LINE}` : ''
  return `✅ **Notifai is set up**${account}.\n\nYou can answer your agents from your phone.\n\n${warning}${appsBlock(facts)}`.trimEnd() + mac
}

export function doneTerminalLines(facts: DoneFacts): { title: string; lines: string[] } {
  const lines = ['You can answer your agents from your phone.']
  if (facts.notificationsOff !== null) {
    lines.push(`⚠ Notifications are off on your ${deviceNoun(facts.notificationsOff)}: ${notificationSettingsPath(facts.notificationsOff)}`)
  }
  if (facts.apps.length > 0) {
    lines.push(`To start: ${facts.apps.map((app) => `${HARNESS_LABELS[app]}: ${nextStep(app, { ...facts, codexNeedsApproval: false })}`).join(' · ')}`)
  }
  if (facts.apps.includes('codex') && facts.codexNeedsApproval) lines.push(codexHooksTerminalLine(facts.codexSurface ?? null))
  if (facts.commandApps.length > 0) lines.push(`${appNames(facts.commandApps)} can now run Notifai's commands without asking.`)
  if (facts.mac === true) lines.push(`Want notifications on your Mac? Download the desktop app: ${MAC_DOWNLOAD_URL}`)
  return { title: facts.email === null ? 'Notifai is set up' : `Notifai is set up for ${facts.email}`, lines }
}

/** What a wait that ended without progress leaves for later. */
export type Leftover = 'phone' | 'plan' | 'notifications' | 'test-notification'

export function partialMessage(left: Leftover, email: string | null, phoneUrl: string): string {
  const account = email === null ? '' : ` for **${email}**`
  const body = left === 'plan'
    ? `**Almost there:** everything is set up${account} except your plan.\n\n` +
      '**Choose a plan** in the Notifai app on your phone, and your agents can reach you.'
    : left === 'phone'
      ? `**Almost there:** this computer and your agent apps are set up${account}. Only your phone is left.\n\n` +
        `Finish it any time: [${linkText(phoneUrl)}](${phoneUrl})`
      : `**Almost there:** everything is set up${account}, but your phone can't receive yet.\n\n` +
        '**Open Notifai on your phone** so it can reconnect.'
  // No promise of a test notification: finishing later in the app, or over
  // SSH, sends none (only the browser's setup page does).
  return body
}

export function partialTerminalLines(left: Leftover, email: string | null, phoneUrl: string): string[] {
  const account = email === null ? '' : ` for ${email}`
  return left === 'plan'
    ? [`Almost there. Set up${account}, except your plan.`, 'Choose a plan in the Notifai app on your phone.']
    : [`Almost there. Set up${account}, except your phone.`, `Finish your phone any time: ${phoneUrl}`]
}
