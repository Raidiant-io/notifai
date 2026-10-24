/** A held native Cursor Stop is an exact conversation continuation channel.
 * Attendance lasts only while this hook can return followup_message. No idle
 * process is advertised after the native output channel closes or times out.
 */
import { setTimeout as delay } from 'node:timers/promises'
import type { CommandDeps } from './commands-core.js'
import { makeClient } from './commands-core.js'
import type { HookEnvelope } from './hook-types.js'
import type { Logger } from './logging.js'
import { readSessionIncarnation, readSessionState, rotateSessionIncarnation, sessionHasEnded, sessionNotified } from './hook-session-state.js'
import { acquireClaimFile, readClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { attendantClaimPath, writeAttendantStatus } from './session-attendant-state.js'
import { currentProcessIdentity, processIdentityLiveness, processStartTime } from './process-identity.js'
import { CURSOR_STOP_TIMEOUT_SECONDS } from './hook-events.js'
import { runSessionAttendant } from './session-attendant.js'
import { handOffSessionMessages } from './session-message-handoff.js'
import { findInstallations, loadCursorSettings } from './install-hooks.js'

export async function attendCursorStop(deps: CommandDeps, envelope: HookEnvelope, logger: Logger, deadlineAt: number): Promise<void> {
  const sessionId = envelope.session_id
  if (!sessionId || envelope.status !== 'completed' || !sessionNotified(sessionId, deps.env)) return
  const record = readSessionIncarnation(sessionId, deps.env)
  const promptAt = readSessionState(sessionId, deps.env).last_prompt_at
  const writer = currentProcessIdentity()
  const pid = Number(deps.env['NOTIFAI_HOOK_SOURCE_PID'])
  const start = processStartTime(pid)
  const credential = deps.store.load()
  if (record === null || writer === null || start === null || credential === null) return
  const host = { pid, start }
  const fingerprint = (): string | null => {
    const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).filter((i) => i.harness === 'cursor')
    if (!installations.length || installations.some((i) => (i.problems ?? []).length > 0)) return null
    const stops = installations.flatMap((i) => i.handlers.filter((h) => h.event === 'stop').map((h) => {
      const definition = loadCursorSettings(i.file).hooks?.['stop']?.[h.handlerIndex]
      return { handler: h, definition }
    }))
    if (stops.length !== 1 || stops[0]?.definition?.timeout !== CURSOR_STOP_TIMEOUT_SECONDS ||
        stops[0]?.definition?.loop_limit !== null) return null
    return JSON.stringify(stops)
  }
  const installed = fingerprint()
  if (installed === null) return
  const file = attendantClaimPath(sessionId, deps.env)
  const token = acquireClaimFile(file, { incarnation: record.incarnation })
  if (token === null) return
  const wall = deps.now ?? Date.now
  const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
  let finish!: () => void
  const signalled = new Promise<void>((resolve) => { finish = resolve })
  const timer = setTimeout(finish, Math.max(0, deadlineAt - wall() - 5000))
  process.once('SIGTERM', finish)
  process.once('SIGINT', finish)
  let written = false
  try {
    await runSessionAttendant({
      sessionId, incarnation: record.incarnation,
      incarnationNow: () => readSessionIncarnation(sessionId, deps.env)?.incarnation ?? null,
      rotateIncarnation: (expected) => rotateSessionIncarnation(sessionId, deps.env, expected)?.incarnation ?? null,
      probe: () => sessionHasEnded(sessionId, deps.env) ? { state: 'ended', reason: 'session-end-hook' }
        : processIdentityLiveness(host) !== 'alive' ? { state: 'ended', reason: 'harness-gone' }
        : { state: 'running', activity: 'idle' },
      claimHeld: () => readClaimFile(file)?.['token'] === token,
      notified: () => sessionNotified(sessionId, deps.env),
      gates: () => !written && readSessionState(sessionId, deps.env).last_prompt_at === promptAt && wall() < deadlineAt - 5000 && fingerprint() === installed
        ? { ok: true } : { ok: false, reason: 'cursor-stop-closed' },
      client: () => client,
      serverSupportsAttendance: async (api) => (await api.compatibility()).server_capabilities.includes('session_attendance'),
      acceptsMessages: true,
      onMessages: (messages, attendant) => handOffSessionMessages(messages, attendant, {
        sequencer: { sessionId, env: deps.env, client, writer, log: logger,
          monotonic: () => performance.now(), wall, sleep: (ms) => delay(ms) },
        write: async (text, begin, guard) => {
          if (written || !guard.writable() || !begin()) return { status: 'aborted', reason: 'cursor-stop-closed' }
          deps.io.out(JSON.stringify({ followup_message: text }))
          written = true
          finish()
          return { status: 'written', route: 'tool-hook' }
        },
      }),
      clock: { monotonic: () => performance.now(), wall, sleep: (ms, signal) => delay(ms, undefined, { signal }) },
      logger, signalled, finalState: async () => 'withdrawn',
      writeStatus: (status) => writeAttendantStatus(sessionId, deps.env, status),
    })
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGTERM', finish)
    process.removeListener('SIGINT', finish)
    releaseClaimFile(file, token)
  }
}
