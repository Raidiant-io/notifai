/**
 * Waking a Codex agent the User stopped in an Orca terminal, by typing
 * Notifai's wake there through Orca ("Build waking stopped agents in Orca
 * terminals this way, as a setting you can turn off? ON by default",
 * 2026-11-05; `orca.wake_stopped_terminals`).
 *
 * A Codex terminal holds its own thread: nothing outside it can start a turn
 * past a stop, and every route Orca has into a terminal is a write to it.
 * This uses Orca's documented one (`terminal.send` with an agent prompt, what
 * `orca terminal send --enter --wait-submit` does) behind the guards Orca's
 * own mailbox typer applies before it types for an agent:
 *
 * - the terminal runs Codex, at rest: recognised as Codex, idle, with no
 *   open dialog or permission prompt (`terminal.show`, `terminal.agentStatus`);
 * - nothing changed on screen for 3 seconds;
 * - the composer is positively empty: no `draft`, and the screen shows
 *   Codex's `›` composer row, the same in two reads a second apart.
 *
 * Anything in the composer holds the wake (the caller looks again, then
 * leaves the input for the User's next message); it is never typed over. The
 * send is never repeated: a reply that does not confirm the turn started is
 * `unknown`, and the input then waits for the User's next message.
 *
 * The hub runs this on macOS and Linux; the Orca runtime file and socket are
 * per user, read per request, and the token is never logged or kept.
 */
import { randomUUID } from 'node:crypto'
import { orcaCapabilities, orcaRuntime, type OrcaRuntime } from './orca-runtime.js'
import { hookCodexRouteProfile } from './codex-surface.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import type { CodexHostKind } from './session-place.js'

/** What Orca must offer: prompt delivery with a receipt. */
export const ORCA_TERMINAL_CAPABILITIES = Object.freeze(['terminal.prompt-delivery.v1'])
/** Orca's own quiescence before it types for an agent (its "tui-idle ready" verdict). */
export const ORCA_TERMINAL_QUIET_MS = 3_000
const SECOND_READ_MS = 1_000
const HANDLE = /^term_[A-Za-z0-9_-]{1,200}$/u

export type OrcaTerminalWake = 'sent' | 'held' | 'not-sent' | 'unknown'

/** The Orca terminal a Codex terminal session runs in, from the environment Codex gives its hooks. */
export function orcaTerminalOf(env: NodeJS.ProcessEnv, profile = hookCodexRouteProfile(env)): { handle: string; user_data?: string } | null {
  // Only a Codex terminal: an Orca chat's app-server, or an app, has its own route.
  if (profile.hostKind !== 'other' && profile.hostKind !== 'shared-server') return null
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
type Read = Parameters<typeof emptyCodexComposer>[0]

/**
 * The placeholders Codex shows in an empty composer, as Orca matches them
 * (`terminal-composer-draft.ts`); 0.166 shows the first.
 */
const CODEX_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'Ask Codex to do anything', 'Ask a follow-up question', 'Explain this codebase', 'Summarize recent commits', 'Implement {feature}',
  'Find and fix a bug in @filename', 'Write tests for @filename', 'Improve documentation in @filename', 'Run /review on my current changes',
  'Use /skills to list available skills', 'Check recently modified functions for compatibility', 'How many files have been modified?',
  'Will this algorithm scale well?',
])

/**
 * Codex's composer, positively empty: Orca found no draft, and the screen's
 * last `›` row, just above the footer, holds nothing or only Codex's
 * placeholder. (With a draft Orca moves its text to `draft` and leaves the
 * bare glyph; without a recognisable composer nothing counts as empty.)
 */
export function emptyCodexComposer(read: { status?: unknown; tail?: unknown; source?: unknown; draft?: unknown }): boolean {
  if (read.source !== 'screen' || read.status !== 'running' || !Array.isArray(read.tail)) return false
  if (read.draft !== undefined) return false
  const lines = (read.tail as unknown[]).filter((line): line is string => typeof line === 'string' && line.trim() !== '')
  const at = lines.map((line) => line.trimStart().startsWith('›')).lastIndexOf(true)
  if (at < 0 || at < lines.length - 4) return false
  const rest = lines[at]!.trimStart().slice(1).replace(/\s+/gu, ' ').trim()
  return rest === '' || CODEX_PLACEHOLDERS.has(rest) || /^Try\s+["\u201C]/u.test(rest)
}

export async function wakeOrcaTerminal(input: {
  env: NodeJS.ProcessEnv; terminal: { handle: string; user_data?: string }; text: string
  remainingMs(): number
  /** Called once every guard passed, just before typing; false types nothing. */
  mayType(): Promise<boolean>
  runtime?: OrcaRuntime | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<OrcaTerminalWake> {
  const budget = (ms: number): number => Math.max(1, Math.min(ms, input.remainingMs()))
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const now = input.now ?? Date.now
  const runtime = input.runtime !== undefined ? input.runtime
    : orcaRuntime({ ...input.env, ...(input.terminal.user_data === undefined ? {} : { ORCA_USER_DATA_PATH: input.terminal.user_data }) })
  if (runtime === null) return 'not-sent'
  const capabilities = await orcaCapabilities(runtime, budget(2_000))
  if (capabilities === null || !ORCA_TERMINAL_CAPABILITIES.every((capability) => capabilities.has(capability))) return 'not-sent'
  const terminal = input.terminal.handle
  const look = async (): Promise<'ready' | 'held' | 'not-sent'> => {
    const shown = await runtime.call('terminal.show', { terminal }, budget(2_000))
    const show = shown.ok ? (shown.result as { terminal?: Show } | null)?.terminal : undefined
    if (show === undefined || show.agentIdentity !== 'codex' || show.connected === false || show.writable === false) return 'not-sent'
    // A dialog or prompt is open, or the screen is still changing: not at rest yet.
    if (show.agentWait !== null && show.agentWait !== undefined) return 'held'
    if (typeof show.lastOutputAt === 'number' && now() - show.lastOutputAt < ORCA_TERMINAL_QUIET_MS) return 'held'
    const status = await runtime.call('terminal.agentStatus', { terminal }, budget(2_000))
    const agent = status.ok ? (status.result as { agentStatus?: { isRunningAgent?: unknown; status?: unknown } } | null)?.agentStatus : undefined
    if (agent?.isRunningAgent !== true) return 'not-sent'
    // Working: the turn the User started takes the input at its next hook.
    if (agent.status === 'working') return 'not-sent'
    if (agent.status !== 'idle') return 'held'
    const read = async () => {
      const reply = await runtime.call('terminal.read', { terminal, screen: true }, budget(2_000))
      return reply.ok ? ((reply.result as { terminal?: Read } | null)?.terminal ?? {}) : {}
    }
    const first = await read()
    if (!emptyCodexComposer(first)) return typeof first.draft === 'string' && first.draft.trim() !== '' ? 'held' : 'not-sent'
    await sleep(SECOND_READ_MS)
    const second = await read()
    if (!emptyCodexComposer(second)) return typeof second.draft === 'string' && second.draft.trim() !== '' ? 'held' : 'not-sent'
    // The screen changed between the reads: someone is there.
    if (JSON.stringify(first.tail) !== JSON.stringify(second.tail)) return 'held'
    return 'ready'
  }
  const verdict = await look()
  if (verdict !== 'ready') return verdict
  if (input.remainingMs() < 12_000 || !(await input.mayType())) return 'not-sent'
  const waitSubmitMs = 8_000
  const reply = await runtime.call('terminal.send', {
    terminal, text: input.text, enter: true, agentPrompt: true, waitSubmitMs, client: { id: 'notifai', type: 'desktop' },
  }, budget(waitSubmitMs + 4_000), { orchestrationRequestId: randomUUID() })
  if (!reply.ok) return reply.code === 'timeout' || reply.code === 'connection_closed' ? 'unknown' : 'not-sent'
  const send = (reply.result as { send?: { accepted?: unknown; refusedReason?: unknown; prompt?: { stages?: unknown } } } | null)?.send
  if (send?.accepted !== true) return send?.refusedReason !== undefined ? 'not-sent' : 'unknown'
  const stages = Array.isArray(send.prompt?.stages) ? send.prompt.stages : []
  return stages.includes('turn_started') ? 'sent' : 'unknown'
}
