import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { orcaRuntime, orcaUserDataPath, type OrcaRuntime } from './orca-runtime.js'

const CHAT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u

export interface OrcaChatFacts {
  chat: string
  cli: string
  user_data: string
}

export function readOrcaChatFacts(value: unknown): OrcaChatFacts | null {
  if (value === null || typeof value !== 'object') return null
  const { chat, cli, user_data: userData } = value as Partial<OrcaChatFacts>
  return typeof chat === 'string' && CHAT_ID.test(chat) &&
    typeof cli === 'string' && cli.length <= 4096 && path.isAbsolute(cli) &&
    typeof userData === 'string' && userData.length <= 4096 && path.isAbsolute(userData)
    ? { chat, cli, user_data: userData } : null
}

/**
 * A candidate from a main-session hook. The host later proves the native
 * binding. A bot's own chat qualifies too: it refuses mail from itself, so
 * its wake goes in as a chat message instead (`systemOrcaReopenHost`).
 */
export function orcaReopenFacts(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): OrcaChatFacts | null {
  if (env['ORCA_STRUCTURED_SESSION'] !== '1' || env['ORCA_AGENT_HOOKS_DISABLED'] === '1' ||
      ['ORCA_ENVIRONMENT', 'ORCA_REMOTE_PAIRING', 'ORCA_PAIRING_CODE'].some(key => Boolean(env[key]?.trim()))) return null
  if (platform === 'linux') {
    try { if (/microsoft/iu.test(readFileSync('/proc/version', 'utf8'))) return null } catch { return null }
  }
  return readOrcaChatFacts({ chat: env['ORCA_AGENT_SESSION_ID'], cli: env['ORCA_CLI_COMMAND'], user_data: orcaUserDataPath(env, platform) })
}

export type OrcaChatReach = 'open' | 'closed' | 'replaced' | 'empty' | 'unavailable'

/**
 * A mail address follows /clear. Check the exact member and its current
 * provider session before using that address. A released chat still has an
 * Orca place, while an explicitly closed chat has none.
 */
export async function orcaChatReach(chat: OrcaChatFacts, sessionId: string, harness: 'claude-code' | 'codex',
  runtime = orcaRuntime({ ORCA_USER_DATA_PATH: chat.user_data })): Promise<OrcaChatReach> {
  if (runtime === null) return 'unavailable'
  const address = `orca_session_id:${chat.chat}`
  const [where, history, show] = await Promise.all([
    runtime.call('orchestration.partyLocation', { address }, 2_000),
    runtime.call('agentSession.history', { sessionId: chat.chat, direction: 'tail', limit: 1 }, 2_000),
    runtime.call('agent.show', { id: address }, 2_000),
  ])
  if (!where.ok) return 'unavailable'
  const location = where.result as { location?: { sessionId?: unknown; kind?: unknown } | null; lost?: unknown } | null
  if (location?.lost === 'chat') return 'closed'
  if (location?.location?.kind !== 'chat' || typeof location.location.sessionId !== 'string') return 'unavailable'
  if (location.location.sessionId !== chat.chat) return 'replaced'
  if (!history.ok || !show.ok) return 'unavailable'
  const snapshot = history.result as {
    providerSession?: { key?: unknown; id?: unknown }; page?: { sessionId?: unknown; fence?: unknown }
  } | null
  const current = snapshot?.providerSession
  // /clear can leave the same Orca member open with no provider session
  // until its next prompt, even though the prior provider session is gone.
  if (current === undefined && snapshot?.page?.sessionId === chat.chat && Number.isSafeInteger(snapshot.page.fence)) return 'empty'
  if (current?.key !== 'session_id' || typeof current.id !== 'string') return 'unavailable'
  if (current.id !== sessionId) return 'replaced'
  const places = show.result as { kind?: unknown; places?: unknown } | null
  if (places?.kind !== 'chat' || !Array.isArray(places.places)) return 'unavailable'
  if (places.places.length === 0) return 'closed'
  const provider = harness === 'claude-code' ? 'claude' : 'codex'
  return places.places.some(place => place?.kind === 'chat' && place.hostId === 'local' && place.agent === provider)
    ? 'open' : 'unavailable'
}

/**
 * What a wake did: `sent` (Orca took it), `refused` (nothing was sent) or
 * `unknown` (no receipt, so it may have been sent). `detail` names the route
 * that took it or why each route refused, for the log: never command output
 * or the wake text.
 */
export interface OrcaWakeResult { outcome: 'sent' | 'refused' | 'unknown'; detail: string }

export interface OrcaReopenHost {
  reach(chat: OrcaChatFacts, sessionId: string, harness: 'claude-code' | 'codex'): Promise<OrcaChatReach>
  wake(chat: OrcaChatFacts, text: string): Promise<OrcaWakeResult>
}

type MailReply = { ok?: unknown; result?: { messageId?: unknown }; error?: { code?: unknown } } | null

function mailReply(stdout: string): MailReply {
  try { return JSON.parse(stdout) as MailReply } catch { return null } // A missing receipt cannot prove the mail was refused.
}

type MailResult = { outcome: 'sent' | 'refused' | 'unknown'; exit: number | null; code: string | null }

/** Orca mail to the chat itself, as the chat. Orca allows local commands from released chats. */
function mailWake(chat: OrcaChatFacts, text: string, env: NodeJS.ProcessEnv): Promise<MailResult> {
  return new Promise(resolve => {
    // Only this chat's own Orca profile and caller ID belong on the invocation.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('ORCA_')))
    childEnv['ORCA_USER_DATA_PATH'] = chat.user_data
    childEnv['ORCA_AGENT_SESSION_ID'] = chat.chat
    execFile(chat.cli, ['orchestration', 'send', '--to', `orca_session_id:${chat.chat}`,
      '--subject', 'Notifai', '--body', text, '--json'],
    { env: childEnv, timeout: 8_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
      const exit = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      const reply = mailReply(stdout)
      const raw = reply?.error?.code
      const code = typeof raw === 'string' && /^[a-z0-9_.-]{1,64}$/u.test(raw) ? raw : null
      if (error === null && reply?.ok === true && typeof reply.result?.messageId === 'string') resolve({ outcome: 'sent', exit, code })
      else resolve({ outcome: reply?.ok === false ? 'refused' : 'unknown', exit, code })
    })
  })
}

export function systemOrcaReopenHost(env: NodeJS.ProcessEnv, runtime?: OrcaRuntime | null, wall: () => number = Date.now): OrcaReopenHost {
  return {
    reach: (chat, sessionId, harness) => orcaChatReach(chat, sessionId, harness, runtime),
    wake: async (chat, text) => {
      const mail = await mailWake(chat, text, env)
      if (mail.outcome === 'sent') return { outcome: 'sent', detail: 'mail' }
      const mailed = `mail-${mail.outcome}:${mail.code ?? 'no-code'}:exit-${mail.exit ?? 'none'}`
      if (mail.outcome === 'unknown') return { outcome: 'unknown', detail: mailed }
      // Nothing was sent. A bot refuses mail from its own chat ("You are
      // already in that chat"), so the wake goes in as a chat message, as the
      // User typing it there would: Orca brings the released chat back for
      // it, in the same provider session.
      // Loaded only here: the chat-answer module is heavy, and most importers of this one never wake a chat.
      const { sendOrcaChatWake } = await import('./orca-chat-answers.js')
      const deadline = performance.now() + 10_000
      const sent = await sendOrcaChatWake({ env, chat: { session_id: chat.chat, user_data: chat.user_data }, text, wall,
        remainingMs: () => deadline - performance.now(),
        runtime: runtime !== undefined ? runtime : orcaRuntime({ ORCA_USER_DATA_PATH: chat.user_data }) })
      return { outcome: sent === 'sent' ? 'sent' : sent === 'unknown' ? 'unknown' : 'refused', detail: `${mailed};chat-message-${sent}` }
    },
  }
}
