import { createHash } from 'node:crypto'
import path from 'node:path'
import { isFeaturesResponse, type MachineSetupIssue } from '@raidiant/notifai-protocol'
import { ApiCallError, type ApiClient } from './client.js'
import { codexTrustFindingsFrom, listCodexHooks, type ListCodexHooks } from './codex-hooks-list.js'
import { codexGlobalDir, findInstallations } from './install-hooks.js'
import { accountHome } from './platform.js'

const REFRESH_MS = 10 * 60_000
const TRUST_CHECK_MS = 60_000
const REQUEST_MS = 5_000
const RETRY_MS = 30_000

/** True: approval is missing; false: clean; null: no evidence either way. Never approves hooks. */
export type CodexHooksTrust = (env: NodeJS.ProcessEnv, cwd: string) => Promise<boolean | null>

export async function checkCodexHooksTrust(env: NodeJS.ProcessEnv, cwd: string, list: ListCodexHooks = listCodexHooks): Promise<boolean | null> {
  const installations = findInstallations(env).filter((installation) => installation.harness === 'codex')
  if (!installations.some((installation) => installation.handlers.length > 0)) return null
  const findings = codexTrustFindingsFrom(installations, env, await list(env, cwd))
  // Disabled hooks have a distinct kind; this reporter diagnoses approval only.
  if (findings.some((finding) => finding.state === 'new' || finding.state === 'changed')) return true
  return findings.length === 0 ? false : null
}

interface Home {
  env: NodeJS.ProcessEnv
  cwd: string
  sessions: Map<string, MachineSetupIssue['host']>
  pending: boolean
  checkedAt: number
  checking: boolean
}

export interface SetupIssuesHost {
  now(): number
  connection(): { client: Pick<ApiClient, 'features' | 'putMachineSetupIssues'>; key: string; signal: AbortSignal } | null
  checkTrust?: CodexHooksTrust
}

/** Separate from attendance: at most 32 homes, two bounded checks, and one snapshot request at a time. */
export class HubSetupIssues {
  private readonly homes = new Map<string, Home>()
  private checks = 0
  private key: string | null = null
  private supported = false
  private discoverAt = -Infinity
  private lastSnapshot: string | null = null
  /** A lost response can still mean the service stored the report; clearing must not depend on its receipt. */
  private mayHaveReported = false
  private reportedAt = -Infinity
  private retryAt = -Infinity
  private sending: Promise<void> | null = null
  private again = false
  private closing = false
  private abort = new AbortController()

  constructor(private readonly host: SetupIssuesHost) {}

  attend(sessionId: string, env: NodeJS.ProcessEnv, cwd: string, place: string): void {
    if (this.closing || sessionId.length === 0 || sessionId.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(sessionId)) return
    const home = path.resolve(codexGlobalDir(env))
    const params = this.params(home, env)
    if (params === null) return
    let entry = this.homes.get(home)
    if (entry === undefined) {
      if (this.homes.size >= 32) return
      entry = { env: { ...env, CODEX_HOME: home }, cwd, sessions: new Map(), pending: false, checkedAt: -Infinity, checking: false }
      this.homes.set(home, entry)
    }
    entry.sessions.set(sessionId, place === 't3' ? 't3' : place === 'codex-app' ? 'codex_app' : undefined)
    this.tick()
  }

  hooked(env: NodeJS.ProcessEnv): void {
    if (this.homes.delete(path.resolve(codexGlobalDir(env)))) this.publish()
  }

  ended(sessionId: string): void {
    for (const [home, entry] of this.homes) {
      entry.sessions.delete(sessionId)
      if (entry.sessions.size === 0) this.homes.delete(home)
    }
    this.publish()
  }

  tick(): void {
    if (this.closing) return
    for (const [home, entry] of this.homes) {
      if (this.checks >= 2) break
      if (entry.checking || this.host.now() - entry.checkedAt < TRUST_CHECK_MS) continue
      entry.checking = true
      this.checks += 1
      void this.check(home, entry)
    }
    this.publish()
  }

  private async check(home: string, entry: Home): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        (this.host.checkTrust ?? checkCodexHooksTrust)(entry.env, entry.cwd),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), REQUEST_MS + 1_000) }),
      ])
      if (this.closing || this.homes.get(home) !== entry) return
      if (result === false) this.homes.delete(home)
      else if (result === true) entry.pending = true
    } catch { /* Unknown: keep existing evidence, never invent a warning. */ }
    finally {
      clearTimeout(timer)
      entry.checking = false
      entry.checkedAt = this.host.now()
      this.checks -= 1
      this.tick()
    }
  }

  private params(home: string, env: NodeJS.ProcessEnv): MachineSetupIssue['params'] | null {
    const relative = path.relative(accountHome(env), home)
    const underHome = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    const display = underHome ? `~/${relative.split(path.sep).join('/')}` : home
    if (display.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(display)) return null
    const platform = process.platform
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return null
    if (!(display.startsWith('~/') || display.startsWith('/') || (platform === 'win32' && /^[a-z]:[\\/]/i.test(display)))) return null
    return { codex_home: display, platform }
  }

  private snapshot(): MachineSetupIssue[] {
    return [...this.homes.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([home, entry]): MachineSetupIssue[] => {
      if (!entry.pending) return []
      const params = this.params(home, entry.env)
      if (params === null) return []
      const hosts = new Set(entry.sessions.values())
      const host = hosts.size === 1 ? [...hosts][0] : undefined
      return [{
        key: `codex_hooks_unapproved:${createHash('sha256').update(`codex_hooks_unapproved\0${home}`).digest('hex')}`,
        kind: 'codex_hooks_unapproved', harness: 'codex', ...(host === undefined ? {} : { host }),
        session_ids: [...entry.sessions.keys()].sort().slice(0, 100),
        lost: ['session_notes', 'answer_wake'], fixer: 'user_at_computer', params,
      }]
    })
  }

  private publish(): void {
    if (this.closing) return
    if (this.sending !== null) { this.again = true; return }
    this.sending = this.send(false).finally(() => {
      this.sending = null
      if (this.again) { this.again = false; this.publish() }
    })
  }

  private async send(final: boolean): Promise<void> {
    const issues = final ? [] : this.snapshot()
    const snapshot = JSON.stringify(issues)
    if (!final && issues.length === 0 && !this.mayHaveReported) return
    const connection = this.host.connection()
    if (connection === null) return
    if (this.key !== connection.key) {
      this.key = connection.key
      this.supported = false
      this.discoverAt = this.retryAt = -Infinity
      this.lastSnapshot = null
      this.mayHaveReported = false
    }
    const now = this.host.now()
    if (!final && now < this.retryAt) return
    const signal = AbortSignal.any([connection.signal, this.abort.signal, AbortSignal.timeout(REQUEST_MS)])
    try {
      if (now >= this.discoverAt) {
        const response = await connection.client.features({ signal })
        if (signal.aborted) return
        this.supported = isFeaturesResponse(response) && response.features.includes('setup_issues')
        this.discoverAt = now + REFRESH_MS
      }
      if (!this.supported || signal.aborted) return
      if (!final && snapshot === this.lastSnapshot && (issues.length === 0 || now - this.reportedAt < REFRESH_MS)) return
      if (issues.length > 0) this.mayHaveReported = true
      await connection.client.putMachineSetupIssues({ issues }, { signal })
      if (signal.aborted) return
      this.lastSnapshot = snapshot
      this.mayHaveReported = issues.length > 0
      this.reportedAt = this.host.now()
    } catch (err) {
      if (err instanceof ApiCallError && (err.status === 404 || err.status === 405)) {
        this.supported = false
        this.discoverAt = now + REFRESH_MS
      }
      this.retryAt = now + RETRY_MS
    }
  }

  /** Cancel the old snapshot before clearing it, so a late report cannot resurrect an issue. */
  async stop(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.abort.abort()
    await this.sending
    this.abort = new AbortController()
    await this.send(true)
  }
}
