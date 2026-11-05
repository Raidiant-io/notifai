/**
 * Where the User talks to Codex, and how they approve Notifai's hooks there.
 *
 * Codex runs no new or changed hook until the User approves it, and each
 * surface asks differently:
 * - the Codex CLI: `/hooks` (and a "Hooks need review" prompt at start);
 * - the ChatGPT desktop app and the Codex IDE extension: a Review hooks icon
 *   in the message box opens a dialog with Allow all / Allow selected, and
 *   Settings → Hooks lists every hook with its switch.
 *
 * The client names itself in the environment Codex gives the agent's shell
 * and its hooks: the desktop app sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` to
 * `Codex Desktop`, the IDE extension to `codex_vscode`, T3 Code to `T3`;
 * the CLI sets none. `CODEX_THREAD_ID` says the command runs inside Codex at
 * all. Anything else is unknown, and gets the line that covers both.
 *
 * Apps with their own UI around Codex's app-server (T3 Code, Orca) offer no
 * hook review at all, so there the step is starting the Codex CLI in a
 * terminal, on the home Codex runs in.
 */

export type CodexSurface = 'cli' | 'app' | 'ide'

/** An app with its own UI around Codex's app-server, when it names itself. */
export type CodexHost = 't3' | 'orca'

/** Originators of the ChatGPT desktop app's Codex besides `Codex Desktop…`. */
const APP_ORIGINATORS: ReadonlySet<string> = new Set(['codex_work_desktop', 'codex_chatgpt_desktop'])

import { codexHostKind } from './codex-session-end.js'
import type { CodexHostKind } from './session-place.js'

/** The Codex surface this command runs in, from its environment; null when not known. */
export function codexSurface(env: NodeJS.ProcessEnv): CodexSurface | null {
  const override = env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE']?.trim()
  if (override !== undefined && override !== '') {
    if (override === 'codex_vscode') return 'ide'
    if (override.startsWith('Codex Desktop') || APP_ORIGINATORS.has(override)) return 'app'
    // T3 Code and other clients of Codex's app-server have their own UI.
    return null
  }
  // An Orca chat drives Codex's app-server without naming itself.
  if (env['ORCA_STRUCTURED_SESSION'] === '1') return null
  return (env['CODEX_THREAD_ID']?.trim() ?? '') !== '' ? 'cli' : null
}

/** The app around Codex's app-server, from its environment; null when none is known. */
export function codexHost(env: NodeJS.ProcessEnv): CodexHost | null {
  if (codexSurface(env) !== null) return null
  // T3 Code sets `T3`; earlier builds spelled it `T3 Code`.
  const override = env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE']?.trim() ?? ''
  if (override === 'T3' || override.startsWith('T3 ')) return 't3'
  return override === '' && env['ORCA_STRUCTURED_SESSION'] === '1' ? 'orca' : null
}

/**
 * Which Notifai logic a Codex session gets, from where it runs. Each route
 * runs only where it can work, so no surface pays for a probe, a send or a
 * wait it cannot use, and none falls back to a weaker route than its own.
 *
 * Signals: the environment Codex gives its hooks (`codexSurface`,
 * `codexHost`), and what kind of Codex process runs them (`hostKind`, from
 * its command line). The process kind outranks an inherited variable: a
 * Codex terminal started from a shell inside an Orca chat or T3 Code carries
 * that app's variables, yet it is a terminal.
 */
export interface CodexRouteProfile {
  surface: CodexSurface | null
  /** The app around Codex's app-server, when this process is one. */
  host: CodexHost | null
  hostKind: CodexHostKind
  /**
   * A device answer may close a question card by steering the shared Codex
   * server: only a thread that server runs (its hooks run in it), or where
   * that cannot be told. Never on Windows, whose socket transport fails.
   */
  steersCards: boolean
  /** Plain-text card answers read at the prompt: an app's own format, choice labels only, or none. */
  textAnswers: CodexHost | 'labels' | 'none'
  /** Orca's own chat routes (card answers by message, mirrored pausing questions). */
  orcaChat: boolean
}

export function codexRouteProfile(env: NodeJS.ProcessEnv, hostKind: CodexHostKind,
  platform: NodeJS.Platform = process.platform): CodexRouteProfile {
  const surface = codexSurface(env)
  const appServer = hostKind === 'app-server'
  // An app is only ever around its own app-server; anywhere else its variables were inherited.
  const host = appServer || hostKind === 'unknown' ? codexHost(env) : null
  const local = (env['ORCA_ENVIRONMENT']?.trim() ?? '') === '' && (env['ORCA_REMOTE_PAIRING']?.trim() ?? '') === ''
  return {
    surface, host, hostKind,
    steersCards: platform !== 'win32' && (hostKind === 'shared-server' || hostKind === 'unknown'),
    // A terminal, the Codex app and the IDE extension answer cards with Codex's envelope only.
    textAnswers: host !== null ? host
      : surface !== null || !(appServer || hostKind === 'unknown') ? 'none' : 'labels',
    orcaChat: host === 'orca' && appServer && local && (env['ORCA_AGENT_SESSION_ID']?.trim() ?? '') !== '',
  }
}

/** Where Codex runs, beyond its surface: what picks the approval step. */
export interface CodexApprovalPlace {
  host?: CodexHost | null
  /** The active `CODEX_HOME` when it is not `~/.codex`. */
  home?: string | null
  platform?: NodeJS.Platform | 'posix'
}

/** Both ways at once, for when the surface is not known. */
const BOTH = 'in the ChatGPT app or your editor, click the **Review hooks** icon by the message box; in the terminal, type `/hooks`'

/**
 * With no hook review in the surface itself, the step that approves the home
 * Codex runs in: `notifai doctor codex` in a terminal. Codex keys approval by
 * the home's path, so a separate home (one per account in T3 Code) needs its
 * own; the command finds the homes Notifai's hooks wait in and opens Codex's
 * own review in each, with no sign-in where the home has none of its own
 * (`codex-hook-review.ts`). Orca copies the hooks and their approval from
 * `~/.codex` into each of its account homes whenever it starts Codex there,
 * so one approval in `~/.codex` covers every Orca account.
 * Null where the surface's own step already approves the home it runs on, or
 * where neither the host nor a separate home is known.
 */
function terminalApproval(surface: CodexSurface | null, place: CodexApprovalPlace, off: boolean) {
  if (surface !== null) return null
  const orca = place.host === 'orca'
  // Orca's accounts take their approval from ~/.codex.
  const home = orca ? null : place.home ?? null
  if (home === null && (place.host ?? null) === null) return null
  const where = 'in a terminal on this machine'
  const review = home === null ? "Codex's own hook review" : "Codex's own hook review for this account"
  return {
    /** Who skips the hooks, and where the approval goes. */
    scope: orca ? ' in Orca' : home === null ? '' : ' in this Codex account',
    there: home === null ? '' : ' there',
    step: off
      ? `${where}, run \`${CODEX_REVIEW_COMMAND}\`: it opens ${review}, where you type \`/hooks\` to turn them on and approve them.`
      : `${where}, run \`${CODEX_REVIEW_COMMAND}\`: it opens ${review}, where you choose **Trust all and continue**.`,
    note: orca ? 'Orca copies the approval to its Codex accounts the next time it starts Codex.' : '',
  }
}

/** The one command that opens Codex's own hook review in each home that needs it (`codex-hook-review.ts`). */
export const CODEX_REVIEW_COMMAND = 'notifai doctor codex'

/** Codex's line in the done message's "To start" list. */
export function codexNextStep(surface: CodexSurface | null, needsApproval: boolean, place: CodexApprovalPlace = {}): string {
  const inChat = surface === 'app' || surface === 'ide'
  if (!needsApproval) return inChat ? 'start a new chat' : 'open a new session'
  const terminal = terminalApproval(surface, place, false)
  if (terminal !== null) return `**approve the Notifai hooks**, then open a new session: ${terminal.step}${terminal.note === '' ? '' : ` ${terminal.note}`}`
  if (surface === 'cli') return 'open a new session, type `/hooks` and **approve the Notifai hooks**'
  if (inChat) return 'start a new chat, click the **Review hooks** icon by the message box and **allow the Notifai hooks**'
  return `open a new session and **approve the Notifai hooks**: ${BOTH}`
}

/** During setup: Codex's hooks still wait for the User. Setup warns, never waits. */
export function codexHooksWarning(surface: CodexSurface | null, place: CodexApprovalPlace = {}): string {
  const terminal = terminalApproval(surface, place, false)
  if (terminal !== null) {
    return `⚠️ **Codex won't use Notifai${terminal.scope} until you approve its hooks${terminal.there}:** ${terminal.step}${terminal.note === '' ? '' : ` ${terminal.note}`}`
  }
  const how = surface === 'cli'
    ? 'type `/hooks` in Codex and approve them.'
    : surface === 'app' || surface === 'ide'
      ? 'click the **Review hooks** icon by the message box in Codex and allow them.'
      : `${BOTH}.`
  return `⚠️ **Codex won't use Notifai until you approve its hooks:** ${how}`
}

/** The same warning for a person reading a terminal: no Markdown. */
export function codexHooksTerminalLine(surface: CodexSurface | null, place: CodexApprovalPlace = {}): string {
  return codexHooksWarning(surface, place).replace('⚠️', '⚠').replace(/\*\*|`/g, '')
}

/**
 * Outside setup (`doctor`, a refused `ask`, a send from a thread whose hooks
 * are not approved): the line the agent ends its reply with. The agent
 * carries on meanwhile; nothing waits for the approval. In the Codex CLI, app
 * and editor, the usual step already runs in the home Codex uses.
 *
 * `off`: some hooks are turned off. The startup prompt lists only new and
 * changed hooks, so turning them on takes `/hooks`.
 */
export function codexHooksReminder(
  surface: CodexSurface | null,
  options: { off?: boolean } & CodexApprovalPlace = {},
): string {
  const off = options.off === true
  const terminal = terminalApproval(surface, options, off)
  if (terminal !== null) {
    const step = terminal.step.charAt(0).toUpperCase() + terminal.step.slice(1)
    return off
      ? `**Keep in mind:** Codex won't use Notifai${terminal.scope} until you turn its hooks on and approve them${terminal.there}. ${step}${terminal.note === '' ? '' : ` ${terminal.note}`}`
      : `**Keep in mind:** Codex won't use Notifai${terminal.scope} until you approve its hooks${terminal.there}. ${step}${terminal.note === '' ? '' : ` ${terminal.note}`}`
  }
  if (off) {
    const how = surface === 'cli'
      ? 'Type `/hooks` to do both.'
      : surface === 'app' || surface === 'ide'
        ? 'Open Settings → **Hooks** in Codex to do both.'
        : 'In the ChatGPT app or your editor, open Settings → **Hooks**; in the terminal, type `/hooks`.'
    return `**Keep in mind:** Codex won't use Notifai until you turn its hooks on and approve them. ${how}`
  }
  const how = surface === 'cli'
    ? 'Type `/hooks` and approve them.'
    : surface === 'app' || surface === 'ide'
      ? 'Click the **Review hooks** icon by the message box and allow them.'
      : 'In the ChatGPT app or your editor, click the **Review hooks** icon by the message box; in the terminal, type `/hooks`.'
  return `**Keep in mind:** Codex won't use Notifai until you approve its hooks. ${how}`
}

/**
 * A terminal command that runs `command` (the Codex CLI) on `home`: the hand-typed
 * fallback where `notifai doctor codex` cannot start Codex itself.
 * PowerShell, the Windows default: `$env:` would otherwise stay set for the
 * rest of that window, so a later plain `codex` there would run in `home`.
 */
export function codexOnHomeCommand(home: string, platform: NodeJS.Platform | 'posix', command: string): string {
  if (platform === 'win32') return `$env:CODEX_HOME='${home.replace(/'/g, "''")}'; ${command}; Remove-Item Env:CODEX_HOME`
  const quoted = /^[\w@%+=:,./-]+$/.test(home) ? home : `'${home.replace(/'/g, `'\\''`)}'`
  return `CODEX_HOME=${quoted} ${command}`
}

const hookHostKinds = new Map<string, CodexHostKind>()

/**
 * The route profile of the Codex process that runs this hook
 * (`NOTIFAI_HOOK_SOURCE_PID`). Its kind is read once per process: a process's
 * command line is fixed for its life. `hostKind` is a test seam.
 */
export function hookCodexRouteProfile(env: NodeJS.ProcessEnv, hostKind?: (pid: number) => CodexHostKind,
  platform: NodeJS.Platform = process.platform): CodexRouteProfile {
  const pid = Number(env['NOTIFAI_HOOK_SOURCE_PID'])
  let kind: CodexHostKind = 'unknown'
  if (Number.isSafeInteger(pid) && pid > 0) {
    const key = `${pid}`
    kind = hookHostKinds.get(key) ?? (hostKind ?? codexHostKind)(pid)
    if (hostKind === undefined && kind !== 'unknown') hookHostKinds.set(key, kind)
  }
  return codexRouteProfile(env, kind, platform)
}
