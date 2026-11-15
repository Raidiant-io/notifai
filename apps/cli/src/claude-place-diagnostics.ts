import { readFileSync } from 'node:fs'
import { parseDescriptor, systemClaudeWakeAdapters } from './claude-wake.js'
import { childWatching, parseAdoptionRecord } from './hub-adoption.js'
import { readSessionIncarnation } from './hook-session-state.js'
import { descriptorStartMatches, processStartTime } from './process-identity.js'
import { attendantStatusPath } from './session-attendant-state.js'
import { claudeHostName, claudePlaceDecision, claudePlaceSignals, placeReceiveRefusal } from './session-place.js'

/** Diagnose only the exact live Claude process; another session cannot fail this check. */
export function claudePlaceCheck(env: NodeJS.ProcessEnv, sessionId: string, pid: number,
  hostName: (pid: number) => string | null = claudeHostName) {
  const descriptor = parseDescriptor(systemClaudeWakeAdapters(env).readDescriptor(pid))
  const start = processStartTime(pid)
  if (descriptor === null || descriptor.pid !== pid || descriptor.sessionId !== sessionId || start === null ||
      !descriptorStartMatches(descriptor.procStart, { pid, start })) return null
  let status: Record<string, unknown> = {}
  try { status = JSON.parse(readFileSync(attendantStatusPath(sessionId, env), 'utf8')) as Record<string, unknown> } catch { /* No attendance yet. */ }
  const recorded = parseAdoptionRecord(status['adoption'])
  const owner = readSessionIncarnation(sessionId, env)?.harness_process
  const sameOwner = owner?.pid === pid && owner.start === start
  const decision = claudePlaceDecision({ ...claudePlaceSignals(env), hostName: hostName(pid) })
  const refusal = sameOwner ? null : placeReceiveRefusal(decision.place)
  const child = childWatching(env, sessionId, pid)
  const attached = sameOwner && child && status['phase'] !== 'exited'
  return {
    name: 'session place',
    harnesses: ['claude-code' as const],
    ok: refusal === null && attached,
    reportOnly: true,
    detail: refusal === 'place-unproven'
      ? 'This running Claude Code session has no proven interactive host. Held answers and notes stay with their recorded owner; update Notifai for host support, then check again.'
      : refusal !== null
        ? 'This scripted Claude Code run cannot take over held answers or notes. Resume the conversation in its interactive app or terminal.'
        : !attached
          ? 'This running Claude Code conversation is recognized, but its Session Attendant has not reattached. Its next turn end, prompt or resume can reconnect it; an already-idle conversation needs a prompt. Do not restart or clear it.'
          : `This Claude Code conversation is attended in ${decision.place}; its own inputs can use the verified Session Child.`,
    technical: { session_id: sessionId, harness_process: { pid, start }, ...decision,
      recorded_place: recorded?.place ?? null, recorded_owner: owner ?? null,
      recorded_phase: typeof status['phase'] === 'string' ? status['phase'] : null,
      session_child: child, transfer_refusal: refusal, attached },
  }
}
