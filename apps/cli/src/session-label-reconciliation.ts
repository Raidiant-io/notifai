import { ApiCallError, type ApiClient } from './client.js'
import { readHarnessSessionTitle, sessionTitleEnvironment, type HostTitleSource } from './harness-session-title.js'
import type { ActiveHarnessSession } from './commands-harness-context.js'
import type { Logger } from './logging.js'
import { resolveSessionLabel, storedSessionLabel } from './session-labels.js'

type LabelClient = Pick<ApiClient, 'upgradeAgentSessionLabel'>

const LOOKUP_INTERVAL_MS = 30_000
const UNSUPPORTED_RETRY_MS = 30 * 60_000

/** One attendance owner's bounded reconciliation state for one exact session. */
export class SessionLabelReconciler {
  private nextAt = 0
  private busy = false
  private completed: { client: LabelClient; label: string } | undefined
  private diagnostic = ''

  async reconcile(env: NodeJS.ProcessEnv, active: ActiveHarnessSession, client: LabelClient | null, logger: Logger, now = Date.now()): Promise<void> {
    const session = active.sessionId
    if (session === undefined || client === null || this.busy || now < this.nextAt) return
    this.nextAt = now + LOOKUP_INTERVAL_MS
    this.busy = true
    try {
      const stored = storedSessionLabel(session, env)
      // Never invent an Agent Session or reconsider an explicit/semantic name.
      if (stored === undefined || stored.source === 'explicit' ||
          (stored.source === 'harness' && stored.previous_source !== 'fallback')) return
      if (this.completed?.client === client && this.completed.label === stored.label) return
      let candidate: HostTitleSource | 'stored-upgrade' | 'none' = 'stored-upgrade'
      let label = stored.label
      if (stored.source === 'fallback') {
        candidate = 'none'
        const title = readHarnessSessionTitle(sessionTitleEnvironment(session, env), active, {
          resolved: (source) => { candidate = source },
        })
        if (title === undefined) { this.report(logger, session, candidate, 'no-title'); return }
        const resolved = resolveSessionLabel({ env, sessionId: session, harness: active.harness, harnessLabel: title })
        if (!resolved.ok || resolved.source !== 'harness' || resolved.previousSource !== 'fallback') {
          this.report(logger, session, candidate, 'preserved-or-rejected')
          return
        }
        label = resolved.label
      }
      this.report(logger, session, candidate, 'upgrade-pending')
      const response = await client.upgradeAgentSessionLabel({ session_id: session, label })
      this.completed = { client, label }
      this.report(logger, session, candidate, response.label === label && response.renamed_by !== 'user' ? 'upgraded' : 'authoritative-name-preserved')
    } catch (err) {
      // New CLI + old server: keep the durable transition for a later retry;
      // attendance and ordinary submissions continue with their existing wire.
      const unsupported = err instanceof ApiCallError && (err.status === 404 || err.status === 405)
      if (unsupported) this.nextAt = now + UNSUPPORTED_RETRY_MS
      this.report(logger, session, 'none', unsupported ? 'upgrade-unavailable' : 'retry-pending')
    } finally {
      this.busy = false
    }
  }

  private report(logger: Logger, session: string, candidate: string, outcome: string): void {
    const key = `${candidate}:${outcome}`
    if (this.diagnostic === key) return
    this.diagnostic = key
    logger.info('session.label', { session, candidate_source: candidate, outcome })
  }
}
