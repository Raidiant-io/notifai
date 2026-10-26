import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiCallError } from './client.js'
import { createLogger, readLogRecords } from './logging.js'
import { SessionLabelReconciler } from './session-label-reconciliation.js'
import { renameStoredSessionLabel, resolveSessionLabel } from './session-labels.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'label-upgrade-'))
  roots.push(root)
  const env = { HOME: root, CODEX_HOME: path.join(root, 'codex'), XDG_STATE_HOME: path.join(root, 'state') }
  mkdirSync(env.CODEX_HOME)
  const active = { sessionId: 'session-one', harness: 'codex', label: 'Codex' } as const
  const logger = createLogger({ env })
  const title = (name: string) => writeFileSync(path.join(env.CODEX_HOME, 'session_index.jsonl'), JSON.stringify({ id: active.sessionId, thread_name: name }))
  resolveSessionLabel({ env, sessionId: active.sessionId, harness: active.harness })
  const upgradeAgentSessionLabel = vi.fn(async (body: { session_id: string; label: string }) => ({ ...body, renamed_by: 'agent' as const, updated_at: '2026-01-01T00:00:00Z' }))
  return { env, active, logger, title, client: { upgradeAgentSessionLabel } }
}

describe('attendance label reconciliation', () => {
  it('bounds lookups, retries an old server after deployment, and caches the accepted transition', async () => {
    const f = fixture()
    const reconciler = new SessionLabelReconciler()
    const run = (now: number) => reconciler.reconcile(f.env, f.active, f.client, f.logger, now)
    await run(0)
    f.title('Repair the parser')
    await run(10)
    expect(f.client.upgradeAgentSessionLabel).not.toHaveBeenCalled()
    f.client.upgradeAgentSessionLabel.mockRejectedValueOnce(new ApiCallError(404, 'not_found', 'Old service'))
    await run(30_000)
    expect(f.client.upgradeAgentSessionLabel).toHaveBeenCalledTimes(1)
    await run(60_000)
    expect(f.client.upgradeAgentSessionLabel).toHaveBeenCalledTimes(1)
    await run(1_830_000)
    expect(f.client.upgradeAgentSessionLabel).toHaveBeenCalledTimes(2)
    f.title('Different host title')
    await run(1_860_000)
    expect(f.client.upgradeAgentSessionLabel).toHaveBeenCalledTimes(2)
    const records = readLogRecords(f.env, { session: f.active.sessionId }).records
    expect(records.map(r => r.data?.['outcome'])).toContain('upgraded')
    expect(JSON.stringify(records)).not.toContain('Repair the parser')
  })
  it('retries a durable upgrade after owner restart but never reconsiders an explicit name', async () => {
    const f = fixture()
    f.title('Repair the parser')
    f.client.upgradeAgentSessionLabel.mockRejectedValueOnce(new Error('offline'))
    await new SessionLabelReconciler().reconcile(f.env, f.active, f.client, f.logger, 0)
    await new SessionLabelReconciler().reconcile(f.env, f.active, f.client, f.logger, 0)
    expect(f.client.upgradeAgentSessionLabel).toHaveBeenCalledTimes(2)
    renameStoredSessionLabel({ env: f.env, sessionId: f.active.sessionId, label: 'Explicit task' })
    await new SessionLabelReconciler().reconcile(f.env, f.active, f.client, f.logger, 0)
    expect(f.client.upgradeAgentSessionLabel).toHaveBeenCalledTimes(2)
  })
  it('applies the same privacy checks to background host candidates', async () => {
    const f = fixture()
    f.title('/home/example/private-project')
    await new SessionLabelReconciler().reconcile(f.env, f.active, f.client, f.logger, 0)
    expect(f.client.upgradeAgentSessionLabel).not.toHaveBeenCalled()
    expect(resolveSessionLabel({ env: f.env, sessionId: f.active.sessionId })).toMatchObject({ source: 'fallback' })
    expect(JSON.stringify(readLogRecords(f.env).records)).not.toContain('/home/example/private-project')
  })
})
