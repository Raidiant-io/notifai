/**
 * Waking a Codex agent the User stopped in an Orca terminal, by typing
 * Notifai's wake there through Orca ("Build waking stopped agents in Orca
 * terminals this way, as a setting you can turn off? ON by default",
 * 2026-11-05; `wake.orca_terminal`).
 *
 * A Codex terminal holds its own thread: nothing outside it can start a turn
 * past a stop, and every route Orca has into a terminal is a write to it.
 * Typing goes through Orca's guarded sends only (`requireAgentStatus:
 * 'sendable'`): Orca itself refuses each write unless an agent runs in the
 * foreground and shows no permission prompt, so Notifai can never type into
 * a shell. The paste and its Enter are two such writes (Orca refuses a guarded
 * send that carries both), with the same guards Orca's own mailbox typer uses
 * before it types for an agent, and a few more:
 *
 * - the terminal runs Codex, at rest: recognised as Codex, idle, with no open
 *   dialog, and nothing changed on screen for 3 seconds;
 * - the screen is the one the User stopped it on (`StopScreen`, read when the
 *   stop happened): the same lines above the composer, so a `/new` or
 *   `/resume` in the same terminal is never typed into;
 * - the composer is positively empty: no `draft`, and the composer row holds
 *   nothing or exactly Codex's placeholder, as it did at the stop; two reads a
 *   second apart, and once more right before the paste;
 * - Enter goes only once the composer shows exactly the wake.
 *
 * Anything in the composer holds the wake (the caller looks again, then
 * leaves the input for the User's next message); it is never typed over. Nothing
 * is ever sent twice: a send whose effect cannot be confirmed is `unknown`.
 *
 * The hub runs this on macOS and Linux; the Orca runtime file and socket are
 * per user, read per request, and the token is never logged or kept.
 */
import { orcaRuntime, type OrcaRuntime } from './orca-runtime.js'
import { hookCodexRouteProfile } from './codex-surface.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import type { CodexHostKind } from './session-place.js'

/** Orca's own quiescence before it types for an agent (its "tui-idle ready" verdict). */
export const ORCA_TERMINAL_QUIET_MS = 3_000
/** Orca's wait between an agent prompt's paste and its Enter: this long with no output (`CLAUDE_AGENT_PROMPT_RENDER_QUIET_MS`). */
export const ORCA_PROMPT_RENDER_QUIET_MS = 1_500
const ORCA_PROMPT_RENDER_CAP_MS = 8_000
/** The first Orca build whose guarded sends were checked (both phases refused without an agent in the foreground). */
const ORCA_GUARDED_SEND_MIN = [1, 4, 248] as const
const SECOND_READ_MS = 1_000
const HANDLE = /^term_[A-Za-z0-9_-]{1,200}$/u
/** The placeholder Codex 0.152 and later shows in an empty composer (`chatwidget.rs` `PLACEHOLDER`). */
const CODEX_PLACEHOLDER = 'Ask Codex to do anything'

export type OrcaTerminalWake = 'sent' | 'held' | 'not-sent' | 'unknown'

/** What the terminal showed once the User stopped the turn: the lines above the composer, and the composer row. */
export interface StopScreen { above: string[]; composer: string }

/**
 * The Orca terminal a Codex TUI session runs in, from the environment Codex
 * gives its hooks. Only Orca's own terminal directly: a multiplexer or
 * another terminal app started inside it carries Orca's variables too.
 */
export function orcaTerminalOf(env: NodeJS.ProcessEnv, profile = hookCodexRouteProfile(env)): { handle: string; user_data?: string } | null {
  // Only a Codex terminal: an Orca chat's app-server, or an app, has its own route.
  if (profile.hostKind !== 'other' && profile.hostKind !== 'shared-server') return null
  if (env['TERM_PROGRAM'] !== 'Orca') return null
  if (['TMUX', 'STY', 'ZELLIJ'].some((name) => (env[name] ?? '') !== '')) return null
  if ((env['ORCA_ENVIRONMENT']?.trim() ?? '') !== '' || (env['ORCA_REMOTE_PAIRING']?.trim() ?? '') !== '') return null
  const handle = env['ORCA_TERMINAL_HANDLE']?.trim() ?? ''
  if (!HANDLE.test(handle)) return null
  const userData = env['ORCA_USER_DATA_PATH']?.trim()
  return { handle, ...(userData === undefined || userData === '' ? {} : { user_data: userData }) }
}
/** Remember the Orca terminal of the owner that runs in it; forget one this owner no longer runs in. */
export function recordOrcaTerminal(sessionId: string, env: NodeJS.ProcessEnv, ownerKey: string, hostKind?: (pid: number) => CodexHostKind): void {
  const terminal = orcaTerminalOf(env, hookCodexRouteProfile(env, hostKind))
  const current = readSessionState(sessionId, env).orca_terminal
  if (terminal === null) {
    if (current !== undefined) updateSessionState(sessionId, env, (state) => {
      const next = { ...state }
      delete next.orca_terminal
      return next
    })
    return
  }
  if (current?.key === ownerKey && current.handle === terminal.handle && current.user_data === terminal.user_data) return
  updateSessionState(sessionId, env, (state) => ({ ...state, orca_terminal: { key: ownerKey, ...terminal } }))
}

type Show = { agentIdentity?: unknown; agentWait?: unknown; lastOutputAt?: unknown; connected?: unknown; writable?: unknown }
type Read = { status?: unknown; tail?: unknown; source?: unknown; draft?: unknown }

/**
 * Codex at rest on screen with an empty composer: Orca found no draft, and
 * the last `›` row, just above the footer, holds nothing or exactly Codex's
 * placeholder (Orca's own matcher also takes old rotating placeholders and
 * any `Try "…"` row, which a User's draft can look like). With a draft, Orca
 * moves the text to `draft` and leaves the bare glyph. Null otherwise.
 */
export function codexRestingScreen(read: Read): StopScreen | null {
  if (read.source !== 'screen' || read.status !== 'running' || !Array.isArray(read.tail) || read.draft !== undefined) return null
  const lines = (read.tail as unknown[]).filter((line): line is string => typeof line === 'string' && line.trim() !== '')
  const at = lines.map((line) => line.trimStart().startsWith('›')).lastIndexOf(true)
  if (at < 1 || at < lines.length - 4) return null
  const composer = lines[at]!.trimStart().slice(1).replace(/\s+/gu, ' ').trim()
  if (composer !== '' && composer !== CODEX_PLACEHOLDER) return null
  // The conversation's own last lines: Codex's indented status rows (a background terminal, a hint) come and go.
  const above = lines.slice(0, at).filter((line) => !/^\s/u.test(line)).slice(-3).map((line) => line.trimEnd())
  return above.length === 0 ? null : { above, composer }
}

const draftOf = (read: Read): string | null => typeof read.draft === 'string' && read.draft.trim() !== '' ? read.draft : null
const sameText = (a: string, b: string): boolean => a.replace(/\s+/gu, '') === b.replace(/\s+/gu, '')

/** Orca's build, from `status.get`: at least the first one whose guarded sends were checked. */
function guardedSendsChecked(version: unknown): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(typeof version === 'string' ? version : '')
  if (match === null) return false
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let index = 0; index < 3; index += 1) if (parts[index] !== ORCA_GUARDED_SEND_MIN[index]) return parts[index]! > ORCA_GUARDED_SEND_MIN[index]!
  return true
}

/** One look at the terminal, as the wake's guards see it. */
async function look(runtime: OrcaRuntime, terminal: string, now: () => number, budget: (ms: number) => number):
  Promise<{ verdict: 'ready'; screen: StopScreen; tail: string } | { verdict: 'held' | 'not-sent' }> {
  const shown = await runtime.call('terminal.show', { terminal }, budget(2_000))
  const show = shown.ok ? (shown.result as { terminal?: Show } | null)?.terminal : undefined
  if (show === undefined || show.agentIdentity !== 'codex' || show.connected === false || show.writable === false) return { verdict: 'not-sent' }
  // A dialog or prompt is open, or the screen is still changing: not at rest yet.
  if (show.agentWait !== null && show.agentWait !== undefined) return { verdict: 'held' }
  if (typeof show.lastOutputAt !== 'number' || now() - show.lastOutputAt < ORCA_TERMINAL_QUIET_MS) return { verdict: 'held' }
  const status = await runtime.call('terminal.agentStatus', { terminal }, budget(2_000))
  const agent = status.ok ? (status.result as { agentStatus?: { isRunningAgent?: unknown; status?: unknown } } | null)?.agentStatus : undefined
  if (agent?.isRunningAgent !== true) return { verdict: 'not-sent' }
  // Working: the turn the User started takes the input at its next hook.
  if (agent.status === 'working') return { verdict: 'not-sent' }
  if (agent.status !== 'idle') return { verdict: 'held' }
  const reply = await runtime.call('terminal.read', { terminal, screen: true }, budget(2_000))
  const read: Read = reply.ok ? ((reply.result as { terminal?: Read } | null)?.terminal ?? {}) : {}
  const screen = codexRestingScreen(read)
  if (screen === null) return { verdict: draftOf(read) !== null || read.source === 'screen' ? 'held' : 'not-sent' }
  return { verdict: 'ready', screen, tail: JSON.stringify(read.tail) }
}

/** What the terminal shows right after a stop, for `wakeOrcaTerminal` to compare with later. */
export async function readStopScreen(input: { env: NodeJS.ProcessEnv; terminal: { handle: string; user_data?: string }; runtime?: OrcaRuntime | null }):
  Promise<StopScreen | null> {
  const runtime = input.runtime !== undefined ? input.runtime
    : orcaRuntime({ ...input.env, ...(input.terminal.user_data === undefined ? {} : { ORCA_USER_DATA_PATH: input.terminal.user_data }) })
  if (runtime === null) return null
  const shown = await runtime.call('terminal.show', { terminal: input.terminal.handle }, 2_000)
  if (!shown.ok || (shown.result as { terminal?: Show } | null)?.terminal?.agentIdentity !== 'codex') return null
  const reply = await runtime.call('terminal.read', { terminal: input.terminal.handle, screen: true }, 2_000)
  return reply.ok ? codexRestingScreen((reply.result as { terminal?: Read } | null)?.terminal ?? {}) : null
}

export async function wakeOrcaTerminal(input: {
  env: NodeJS.ProcessEnv; terminal: { handle: string; user_data?: string }; text: string
  /** The screen at the stop; without it nothing is typed. */
  stopScreen: StopScreen | null | undefined
  remainingMs(): number
  /**
   * Between the paste and its Enter: `render-quiet` waits as Orca's own
   * agent prompt does (the paste on screen, then 1.5 s with no output);
   * a number waits that many milliseconds once the paste shows.
   */
  enterAfter?: 'render-quiet' | number
  runtime?: OrcaRuntime | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<OrcaTerminalWake> {
  const budget = (ms: number): number => Math.max(1, Math.min(ms, input.remainingMs()))
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const now = input.now ?? Date.now
  if (input.stopScreen === null || input.stopScreen === undefined) return 'not-sent'
  const runtime = input.runtime !== undefined ? input.runtime
    : orcaRuntime({ ...input.env, ...(input.terminal.user_data === undefined ? {} : { ORCA_USER_DATA_PATH: input.terminal.user_data }) })
  if (runtime === null) return 'not-sent'
  const status = await runtime.call('status.get', {}, budget(2_000))
  if (!status.ok || !guardedSendsChecked((status.result as { appVersion?: unknown } | null)?.appVersion)) return 'not-sent'
  const terminal = input.terminal.handle
  const stop = input.stopScreen
  // Two looks a second apart, then a third right before the paste: Codex, at rest, empty, on the stop's screen, unchanged.
  const looks: string[] = []
  for (const wait of [0, SECOND_READ_MS, 0]) {
    if (wait > 0) await sleep(wait)
    const seen = await look(runtime, terminal, now, budget)
    if (seen.verdict !== 'ready') return seen.verdict
    // Other lines above the composer: the terminal no longer shows the stop (a `/new`, a `/resume`, a resize).
    if (JSON.stringify(seen.screen.above) !== JSON.stringify(stop.above)) return 'not-sent'
    if (seen.screen.composer !== stop.composer) return 'held'
    if (looks.length > 0 && looks.at(-1) !== seen.tail) return 'held'
    looks.push(seen.tail)
  }
  if (input.remainingMs() < 12_000) return 'not-sent'
  const read = async (): Promise<Read> => {
    const reply = await runtime.call('terminal.read', { terminal, screen: true }, budget(2_000))
    return reply.ok ? ((reply.result as { terminal?: Read } | null)?.terminal ?? {}) : {}
  }
  const guarded = async (params: Record<string, unknown>) => {
    const reply = await runtime.call('terminal.send', { terminal, ...params, requireAgentStatus: 'sendable', client: { id: 'notifai', type: 'desktop' } }, budget(4_000))
    const send = reply.ok ? (reply.result as { send?: { accepted?: unknown; refusedReason?: unknown } } | null)?.send : undefined
    return reply.ok ? (send?.accepted === true ? 'accepted' : 'refused') : (reply.code === 'timeout' || reply.code === 'connection_closed' ? 'lost' : 'refused')
  }
  // The paste: bracketed, as Orca's own prompt writer sends it, with any escape character neutralised.
  const pasted = await guarded({ text: `\x1b[200~${input.text.replace(/\x1b/gu, '\u241b')}\x1b[201~` })
  if (pasted === 'refused') return 'not-sent'
  if (pasted === 'lost') return 'unknown'
  // Enter only once the composer shows exactly the wake: anything else is the User's, and stays theirs.
  const shows = async (): Promise<boolean> => {
    const draft = draftOf(await read())
    return draft !== null && sameText(draft, input.text)
  }
  const pastedAt = now()
  let visible = false
  while (now() - pastedAt < 3_000 && !(visible = await shows())) await sleep(100)
  if (!visible) return 'unknown'
  const enterAfter = input.enterAfter ?? 'render-quiet'
  if (enterAfter === 'render-quiet') {
    const since = now()
    for (;;) {
      const shown = await runtime.call('terminal.show', { terminal }, budget(2_000))
      const last = shown.ok ? (shown.result as { terminal?: Show } | null)?.terminal?.lastOutputAt : undefined
      if (typeof last === 'number' && now() - last >= ORCA_PROMPT_RENDER_QUIET_MS) break
      if (now() - since >= ORCA_PROMPT_RENDER_CAP_MS) break
      await sleep(100)
    }
  } else await sleep(enterAfter)
  if (!(await shows())) return 'unknown'
  const entered = await guarded({ enter: true })
  if (entered !== 'accepted') return 'unknown'
  // The turn started: Codex is working.
  const enteredAt = now()
  while (now() - enteredAt < 8_000) {
    const reply = await runtime.call('terminal.agentStatus', { terminal }, budget(2_000))
    const agent = reply.ok ? (reply.result as { agentStatus?: { status?: unknown } } | null)?.agentStatus : undefined
    if (agent?.status === 'working') return 'sent'
    await sleep(250)
  }
  return 'unknown'
}
