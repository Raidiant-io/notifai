import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { clearAcknowledgementObligation } from './hook-acknowledgements.js'
import { processStartTime } from './process-identity.js'
import {
  DORMANT_MESSAGE_DEBT_MS,
  droppedMessagesPath,
  markSessionEnded,
  pruneAbandonedSessions,
  readSessionState,
  sessionStatePath,
  writeSessionState,
} from './hook-session-state.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-dormant-debt-')); roots.push(root)
  return { HOME: root, USERPROFILE: root, XDG_STATE_HOME: root } as NodeJS.ProcessEnv
}
const now = Date.UTC(2026, 9, 25)
const words = 'Please also check the Windows build.'
const message = (id: string, ageDays: number, queued = false) => ({
  message_id: id, recorded_at: now - ageDays * 24 * 3600 * 1000, text_required: true, ...(queued ? { queued_context: words } : {}),
})

it('drops a gone session\'s Session Message debt after 30 days, never sooner, and keeps no words of it', () => {
  const env = fixture()
  writeSessionState('ended-session', env, { harness: 'codex', message_acknowledgement_due: [message('sm_old', 31, true), message('sm_recent', 2)] })
  markSessionEnded('ended-session', env, now)
  pruneAbandonedSessions(env, now)
  expect(readSessionState('ended-session', env).message_acknowledgement_due?.map((entry) => entry.message_id)).toEqual(['sm_recent'])
  const trail = readFileSync(droppedMessagesPath(env), 'utf8')
  expect(JSON.parse(trail.trim())).toMatchObject({ message_id: 'sm_old', presented: false, reason: 'session_gone_30_days' })
  expect(trail).not.toContain('Windows')
  expect(DORMANT_MESSAGE_DEBT_MS).toBe(30 * 24 * 3600 * 1000)
})

it('keeps old debt while the session may still come back', () => {
  const env = fixture()
  writeSessionState('live-session', env, { harness: 'codex', message_acknowledgement_due: [message('sm_old', 45, true)] })
  // Its recorded harness is this very process, still running: not gone.
  const file = sessionStatePath('live-session', env).replace(/\.json$/, '.incarnation.json')
  writeFileSync(file, JSON.stringify({ key: 'k', incarnation: 'inc_0123456789ab', start: { wall: now, mono: '1' },
    harness_process: { pid: process.pid, start: processStartTime(process.pid) } }))
  pruneAbandonedSessions(env, now)
  expect(readSessionState('live-session', env).message_acknowledgement_due).toHaveLength(1)
  expect(existsSync(droppedMessagesPath(env))).toBe(false)
})

it('settles an acknowledgement the service recorded after the session ended, without recreating state', () => {
  const env = fixture()
  writeSessionState('ended-session', env, { harness: 'claude-code', message_acknowledgement_due: [message('sm_acked', 1)] })
  markSessionEnded('ended-session', env, now)
  expect(clearAcknowledgementObligation('ended-session', env, 'sm_acked')).toBe(true)
  expect(readSessionState('ended-session', env).message_acknowledgement_due).toBeUndefined()
  expect(clearAcknowledgementObligation('never-existed', env, 'sm_other')).toBe(false)
  expect(existsSync(sessionStatePath('never-existed', env))).toBe(false)
})
