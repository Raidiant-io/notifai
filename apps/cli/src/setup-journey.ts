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
import { COMPANION_INSTALL_URLS, deviceNoun } from './setup-destinations.js'

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
    ? 'Connect Notifai to which agent apps? I found none on this computer. Pick the ones you use.'
    : `Connect Notifai to these agent apps? Found on this computer: ${appNames(detected)}. Keep these or pick others.`
}

export const APPS_QUESTION = 'Connect Notifai to which agent apps?'

/**
 * The approval message. The QR itself is not part of it: the agent shows the
 * one at `technical.pairing.qr_text_path` (or the image) right after it.
 */
export function approveMessage(options: { code: string; url: string; opened: boolean }): string {
  const finish = options.opened
    ? `Finish in the browser I opened ([link](${options.url}) if it didn't open)`
    : `Open this on your computer: [link](${options.url})`
  return `**Connect this computer**: code **${options.code}**\n\n${finish}, or scan this with the Notifai app:`
}

/**
 * A code that could not be kept open any longer (two hours) was replaced. The
 * open page cannot follow a new code, so setup opened the new one.
 */
export function renewedApproveMessage(options: { code: string; url: string; opened: boolean }): string {
  const finish = options.opened
    ? `Finish in the browser tab I just opened ([link](${options.url}) if it didn't open).`
    : `Open this on your computer: [link](${options.url}).`
  return `That code expired. New one: **${options.code}**. ${finish}\n\n_Or scan this with the Notifai app:_`
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
  return "This computer wasn't approved in 90 minutes, so I've stopped. **Tell me when you want to try again.**"
}

export const DENIED_MESSAGE = 'Stopped: you declined this computer. Ask me anytime to try again.'

export function phoneWebMessage(email: string | null, url: string, opened: boolean): string {
  const account = email === null ? '' : ` to **${email}**`
  const next = opened
    ? `Now your phone: finish in the browser I opened ([link](${url}) if it didn't open).`
    : `Now your phone: open this on your computer: [link](${url}).`
  return `**This computer is already connected**${account}. ${next}\n\n_I'll carry on once it's done._`
}

/** Right after a browser approval: the page that approved walks the phone steps. */
export const PHONE_IN_BROWSER_MESSAGE = 'Now your phone: follow the page in your browser.'

export function noPhoneMessage(email: string | null): string {
  return '**Now get Notifai on your phone**\n\n' +
    `- iPhone: [App Store](${COMPANION_INSTALL_URLS.iphone})\n` +
    `- Android: [free test](${COMPANION_INSTALL_URLS.android})\n\n` +
    `Sign in as **${email ?? 'the email you approved this computer with'}** and allow notifications.\n\n` +
    "_I'll carry on once your phone is connected._"
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
    `_Or on the web: [${linkText(plansUrl)}](${plansUrl})_\n\n` +
    "I'll send you a test notification as soon as it's active."
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
  /** Codex hooks still need the User's approval in `/hooks`. */
  codexNeedsApproval: boolean
  /** Apps that now run Notifai's commands without asking. */
  commandApps: readonly HookInstallableHarness[]
}

/** Codex runs no Notifai hook until the User approves them in `/hooks`; setup warns, never waits. */
export const CODEX_HOOKS_WARNING = "⚠️ **Codex won't use Notifai until you approve it:** type `/hooks` in Codex and approve the Notifai hooks."

export function appsBlock(facts: Pick<DoneFacts, 'apps' | 'codexNeedsApproval' | 'commandApps'>): string {
  if (facts.apps.length === 0) return ''
  return '**To start using it:**\n' + facts.apps.map((app) => `- **${HARNESS_LABELS[app]}**: ${NEXT_STEP[app]}`).join('\n') +
    (facts.apps.includes('codex') && facts.codexNeedsApproval
      ? `\n\n${CODEX_HOOKS_WARNING}`
      : '') +
    (facts.commandApps.length > 0 ? `\n\n_${appNames(facts.commandApps)} can now run Notifai's commands without asking._` : '')
}

export function doneMessage(facts: DoneFacts): string {
  const account = facts.email === null ? '' : ` for **${facts.email}**`
  const warning = facts.notificationsOff === null
    ? ''
    : `⚠️ **Notifications are off on your ${deviceNoun(facts.notificationsOff)}**, so nothing will pop up. ` +
      `Turn them on: ${notificationSettingsPath(facts.notificationsOff)}.\n\n`
  return `✅ **Notifai is set up**${account}. You can answer your agents from your phone.\n\n${warning}${appsBlock(facts)}`.trimEnd()
}

export function doneTerminalLines(facts: DoneFacts): { title: string; lines: string[] } {
  const lines = ['You can answer your agents from your phone.']
  if (facts.notificationsOff !== null) {
    lines.push(`⚠ Notifications are off on your ${deviceNoun(facts.notificationsOff)}: ${notificationSettingsPath(facts.notificationsOff)}`)
  }
  if (facts.apps.length > 0) {
    lines.push(`To start: ${facts.apps.map((app) => `${HARNESS_LABELS[app]}: ${NEXT_STEP[app]}`).join(' · ')}`)
  }
  if (facts.apps.includes('codex') && facts.codexNeedsApproval) {
    lines.push("⚠ Codex won't use Notifai until you approve it: type /hooks in Codex and approve the Notifai hooks.")
  }
  if (facts.commandApps.length > 0) lines.push(`${appNames(facts.commandApps)} can now run Notifai's commands without asking.`)
  return { title: facts.email === null ? 'Notifai is set up' : `Notifai is set up for ${facts.email}`, lines }
}

/** What a wait that ended without progress leaves for later. */
export type Leftover = 'phone' | 'plan' | 'notifications' | 'test-notification'

export function partialMessage(left: Leftover, email: string | null, phoneUrl: string): string {
  const account = email === null ? '' : ` for **${email}**`
  const body = left === 'plan'
    ? `**Almost there.** Everything is set up${account} except your plan.\n\n` +
      'Choose one in the Notifai app on your phone and your agents can reach you right away.'
    : left === 'phone'
      ? `**Almost there.** This computer and your agent apps are set up${account}. Your phone is the only thing left.\n\n` +
        `Finish it any time at [${linkText(phoneUrl)}](${phoneUrl}).`
      : `**Almost there.** Everything is set up${account} except your phone, which can't receive yet.\n\n` +
        'Open Notifai on it so it can reconnect.'
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
