import { claudeHookFormFor } from './claude-hook-form.js'
import { buildIdentity } from './distribution.js'
/** Local integration diagnostics. No service, registry, installer or repair. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { inspectCliInstallations, nativeCoexistenceGap } from './cli-bin.js'
import { type CommandDeps } from './commands-core.js'
import { stopShapeProblems } from './commands-hook-shape.js'
import { stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { SOURCE_CONTEXT_HARNESSES, type HookInstallableHarness } from './harnesses.js'
import { HOOK_EVENTS, requiredHookEvents } from './hook-events.js'
import { hookAdapterTargetsArtifact, inspectHookAdapter, isNpxAdapterTarget, resolveHookAdapterHome } from './hook-adapter.js'
import { codexTrustProblems, findInstallations, handlerEvent, type Installation } from './install-hooks.js'
import { inspectSkillCopies, skillDestination } from './native-skills.js'
import { currentRuntimeBuild } from './launch-self.js'
import { canonicalPath } from './local-path.js'
import { nativeInstallationIdentity } from './native-installation-identity.js'
import { accountHome } from './platform.js'
import { packageVersion } from './release.js'
import { type SkillInspectionBudget } from './skill-integrity.js'

export function installationFaults(installation: Installation, platform?: NodeJS.Platform,
  claude?: { env: NodeJS.ProcessEnv; claudeCodeVersion?: () => string | null }): string[] {
  const events = installation.handlers.map(handler => handlerEvent(handler.command))
  return [
    ...(claude === undefined ? [] : claudeFormFaults(installation, platform, claude)),
    ...(installation.problems ?? []),
    ...requiredHookEvents(installation.harness, platform).filter(event => !events.includes(event))
      .map(event => `missing ${event}`),
    ...events.filter(event => event !== null && !(HOOK_EVENTS as readonly string[]).includes(event))
      .map(event => `unsupported ${event}`),
    ...stopShapeProblems(installation),
  ]
}

/**
 * Claude Code's hook form against what its installed version supports: shell
 * form after an upgrade past the exec-form floor, or exec form on a version
 * known to predate it. Either is repaired by reinstalling the hooks, which
 * `notifai update` does for any installation with a fault.
 */
export function claudeFormFaults(installation: Installation, platform: NodeJS.Platform | undefined,
  deps: { env: NodeJS.ProcessEnv; claudeCodeVersion?: () => string | null }): string[] {
  if (installation.harness !== 'claude-code' || (platform ?? process.platform) === 'win32') return []
  const exec = installation.handlers.some((handler) => handler.execForm === true)
  const decision = claudeHookFormFor(deps, exec)
  if (decision.form === 'exec' && !exec) return [`shell-form hooks, but Claude Code ${decision.version} runs exec-form hooks`]
  if (decision.form === 'shell' && exec) return [`exec-form hooks, but Claude Code ${decision.version} predates them`]
  return []
}

/** The selected home and Codex's source home; never enumerate other accounts. */
export function integrationInstallations(deps: CommandDeps) {
  const selected = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)
    .map(installation => ({ installation, env: deps.env }))
  if (deps.env['CODEX_HOME']) {
    const sourceEnv = { ...deps.env }
    delete sourceEnv['CODEX_HOME']
    for (const installation of findInstallations(sourceEnv, deps.hookAdapterHome, deps.hookPlatform)) {
      if (installation.harness === 'codex' && !selected.some(entry => entry.installation.file === installation.file)) {
        // Repair the source before its selected copy: a host may refresh from it.
        selected.unshift({ installation, env: sourceEnv })
      }
    }
  }
  return selected
}

export interface IntegrationFault {
  code: string
  file?: string
  /** Paths and detailed evidence stay local, never Notification Request copy. */
  detail: string
  remedy: string
}

function integrationCli(deps: CommandDeps) {
  const target = deps.hookInstallTarget
  const artifact = target !== undefined && !isNpxAdapterTarget(target) ? (target.kind === 'native' ? process.execPath : target.scriptPath) : buildIdentity() !== null ? process.execPath : process.argv[1]
  return inspectCliInstallations(deps.env, deps.hookPlatform, {
    ...(artifact === undefined ? {} : { runningArtifactPath: artifact }),
    currentVersion: deps.runningVersion === undefined ? packageVersion() : deps.runningVersion,
  })
}

export function localIntegrationAssessment(deps: CommandDeps, harness?: HookInstallableHarness, budget?: SkillInspectionBudget) {
  return assessIntegration(deps, integrationCli(deps), harness, budget)
}

function assessIntegration(deps: CommandDeps, cli: ReturnType<typeof integrationCli>, harness?: HookInstallableHarness, budget?: SkillInspectionBudget) {
  const faults: IntegrationFault[] = []
  const coexistence = nativeCoexistenceGap(cli, deps.hookPlatform ?? process.platform)
  if (coexistence?.remedy?.by === 'user-here') faults.push({ code: 'legacy-native-coexistence', detail: coexistence.detail,
    remedy: `${coexistence.remedy.summary} ${coexistence.remedy.command}` })
  const adapter = inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform)
  const installations = integrationInstallations(deps)
  if (harness !== undefined && !installations.some(entry => entry.env === deps.env && entry.installation.harness === harness)) {
    faults.push({ code: 'hooks-missing', detail: 'The enabled lifecycle callback has no matching installed definition.',
      remedy: `notifai hooks install --harness ${harness}` })
  }
  if (cli.effective !== null && cli.current.version !== null && (cli.effective.version !== cli.current.version ||
      (cli.effective.artifact_path !== null && !hookAdapterTargetsArtifact(
        { execPath: process.execPath, scriptPath: cli.current.artifact_path }, cli.effective.artifact_path)))) {
    faults.push({ code: 'cli-drift', detail: 'The running CLI and effective command differ.', remedy: 'notifai doctor --json' })
  }
  if (installations.length > 0 || adapter.target !== null) {
    if (adapter.problems.length > 0 || (cli.effective?.artifact_path !== undefined &&
        cli.effective?.artifact_path !== null && !hookAdapterTargetsArtifact(adapter.target, cli.effective.artifact_path))) {
      faults.push({ code: 'adapter-drift', detail: 'The registered hook adapter does not match the effective CLI.', remedy: 'notifai doctor --json' })
    }
  }
  for (const { installation, env } of installations.filter(entry => harness === undefined || entry.installation.harness === harness)) {
    const problems = installationFaults(installation, deps.hookPlatform, deps)
    if (problems.length > 0) faults.push({ code: 'hooks-drift', file: installation.file, detail: `${installation.file}: ${problems.join('; ')}`,
      remedy: `notifai hooks install --harness ${installation.harness}` })
    if (installation.harness === 'codex' && codexTrustProblems([installation], env).length > 0) {
      faults.push({ code: 'native-approval-pending', detail: `Native approval is unresolved for ${installation.file}.`, remedy: '/hooks' })
    }
  }
  // Only a copy this harness loads concerns it. An unfinished bounded
  // inspection reports nothing rather than guessing.
  const skills = (deps.nativeSkills?.inspect ?? inspectSkillCopies)(deps.cwd, deps.env, budget)
  if (skills.error === undefined) for (const copy of skills.copies) {
    if (copy.condition !== 'current' && (harness === undefined || copy.harnesses.includes(harness))) faults.push({ code: 'skill-drift',
      detail: `Guidance at ${copy.path} differs from this CLI.`, remedy: 'notifai update --refresh-skill --json' })
  }
  return { cli, faults, installations }
}

const CHECK_INTERVAL_MS = 60_000

/** Retained native residents may finish their work, but only the active build
 * can judge the current installation. Recheck after inspection too: activation
 * can happen while an old observer is scanning. This grants no repair authority. */
function healthPublicationCurrent(deps: CommandDeps): () => boolean {
  if (buildIdentity() === null) return () => true
  const reference = currentRuntimeBuild(deps.env)
  return () => {
    const platform = deps.hookPlatform ?? process.platform
    const active = nativeInstallationIdentity(accountHome(deps.env, platform), platform === 'win32')
    return reference !== null && reference.installation_id === active.installationId && reference.build === active.build
  }
}

function healthScope(deps: CommandDeps, cli: ReturnType<typeof integrationCli>, harness?: HookInstallableHarness) {
  const resolved = (file: string | null | undefined) => file == null ? null : canonicalPath(file)
  const skills = SOURCE_CONTEXT_HARNESSES.flatMap(owner => (['global', 'project'] as const).map(scope => {
    const destination = skillDestination(scope, owner, deps.cwd, deps.env)
    return scope === 'project' && (destination === null || !existsSync(destination)) ? null : resolved(destination)
  }))
  return { schema: 2, harness, build: buildIdentity(), runtime: cli.current, executable: resolved(process.execPath),
    effective: cli.effective === null ? null : { command: resolved(cli.effective.command_path),
      artifact: resolved(cli.effective.artifact_path), version: cli.effective.version },
    adapterHome: resolved(resolveHookAdapterHome(deps.hookAdapterHome, deps.env, deps.hookPlatform)),
    codexHome: resolved(deps.env['CODEX_HOME']), skills,
    installations: integrationInstallations(deps).map(({ installation }) => resolved(installation.file)) }
}

/** The notice text. No file contents, paths, settings, or trust evidence enter agent copy. */
function faultNoticeText(faults: readonly IntegrationFault[]): string {
  const codes = [...new Set(faults.map(fault => fault.code))].join(', ')
  return `Notifai local integration needs attention (${codes}). Run \`notifai doctor --json\` for the exact lost capability and remedy before relying on prompt note delivery. This diagnostic does not block ordinary sends. Report actionable faults to the Notification Request owner; honor User deferrals. Do not change installations, settings or native trust without authorization, restart unnecessarily, or send repeated warnings.`
}

function healthDir(deps: CommandDeps): string {
  return path.join(stateDir(deps.env), 'integration-health')
}

/**
 * Where a hook finds the assessment for its harness and directory without
 * scanning anything: a pointer named only from values already in memory. The
 * assessment's own key needs the scan; the pointer records which key it was.
 */
function scopePointerFile(deps: CommandDeps, harness?: HookInstallableHarness): string {
  const key = createHash('sha256').update(JSON.stringify({
    schema: 1, harness: harness ?? null, cwd: deps.cwd, build: buildIdentity(), executable: process.execPath,
    adapterHome: deps.hookAdapterHome ?? null, codexHome: deps.env['CODEX_HOME'] ?? null,
  })).digest('hex')
  return path.join(healthDir(deps), `scope-${key}.json`)
}

interface HealthRecord { checked_at?: number; reported?: string; fingerprint?: string; faults?: IntegrationFault[] }

function readHealthRecord(file: string): HealthRecord {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  return typeof value === 'object' && value !== null ? value as HealthRecord : {}
}

/** The assessment record a scope pointer names, or null when there is none yet. */
function pointedHealthRecord(deps: CommandDeps, harness?: HookInstallableHarness): { file: string; record: HealthRecord } | null {
  try {
    const pointer: unknown = JSON.parse(readFileSync(scopePointerFile(deps, harness), 'utf8'))
    const scope = typeof pointer === 'object' && pointer !== null ? (pointer as { scope?: unknown }).scope : undefined
    if (typeof scope !== 'string' || !/^[0-9a-f]{64}$/.test(scope)) return null
    const file = path.join(healthDir(deps), `${scope}.json`)
    return { file, record: readHealthRecord(file) }
  } catch {
    return null
  }
}

/** Once per changed fault, across repeated callbacks and Projects on a machine. */
export function integrationFaultNotice(deps: CommandDeps, harness?: HookInstallableHarness, consume = true, force = false): string | undefined {
  try {
    const current = healthPublicationCurrent(deps)
    if (!current()) return undefined
    const cli = integrationCli(deps)
    const key = createHash('sha256').update(JSON.stringify(healthScope(deps, cli, harness))).digest('hex')
    const file = path.join(healthDir(deps), `${key}.json`)
    return withFileLock(`${file}.lock`, () => {
      if (!current()) return undefined
      let previous: HealthRecord = {}
      try { previous = readHealthRecord(file) } catch { /* first check */ }
      const now = (deps.now ?? Date.now)()
      const cached = !force && typeof previous.checked_at === 'number' && now >= previous.checked_at &&
        now - previous.checked_at < CHECK_INTERVAL_MS && Array.isArray(previous.faults)
      // Reserve this interval before inspecting: a failed or size-bounded
      // scan must not be retried on every ordinary tool or resident probe.
      if (!cached) atomicWriteFileSync(file, JSON.stringify({ ...previous, checked_at: now,
        faults: Array.isArray(previous.faults) ? previous.faults : [] }))
      const faults = cached ? previous.faults! : assessIntegration(deps, cli, harness,
        { maxFiles: 256, maxBytes: 2 * 1024 * 1024, deadlineAt: Date.now() + 75 }).faults
      if (!current()) return undefined
      const fingerprint = createHash('sha256').update(JSON.stringify(faults)).digest('hex')
      const shouldReport = faults.length > 0 && (consume ? previous.reported !== fingerprint : previous.fingerprint !== fingerprint)
      if (!cached || (consume && shouldReport)) atomicWriteFileSync(file, JSON.stringify({
        checked_at: cached ? previous.checked_at : now, fingerprint, faults,
        reported: faults.length === 0 || (consume && shouldReport) ? fingerprint : previous.reported,
      }))
      // Let hooks find this assessment without repeating the scan.
      // Hooks for other scopes share this pointer. Publish it under its own
      // lock; while a sibling holds that lock it is publishing an assessment
      // just as current, so this one keeps its notice and skips the hint.
      if (!cached) {
        const pointer = scopePointerFile(deps, harness)
        try {
          withFileLock(`${pointer}.lock`, () => atomicWriteFileSync(pointer, JSON.stringify({ scope: key })), { waitMs: 0 })
        } catch { /* A sibling publishes the pointer. */ }
      }
      if (!shouldReport) return undefined
      return faultNoticeText(faults)
    }, { waitMs: 0 })
  } catch {
    // Diagnostics never hold a turn, fail a hook, or block ordinary sending.
    return undefined
  }
}

/**
 * Refresh the assessment a later prompt will read, off the prompt path: turn
 * end runs this. It scans only when the recorded assessment is older than the
 * check interval, and never consumes the notice.
 */
export function refreshIntegrationHealth(deps: CommandDeps, harness?: HookInstallableHarness): void {
  const pointed = pointedHealthRecord(deps, harness)
  const now = (deps.now ?? Date.now)()
  const checkedAt = pointed?.record.checked_at
  if (typeof checkedAt === 'number' && now >= checkedAt && now - checkedAt < CHECK_INTERVAL_MS) return
  integrationFaultNotice(deps, harness, false)
}

/** A recorded assessment older than this no longer speaks for the installation. */
const CACHED_NOTICE_MAX_AGE_MS = 60 * 60_000

/**
 * The fault notice for a prompt-path hook, read from the last assessment of
 * this harness and directory. It never scans the installation: turn end and
 * the Session Attendant refresh it. The notice lock is taken without waiting,
 * and only when there is a notice to emit.
 */
export function cachedIntegrationFaultNotice(deps: CommandDeps, harness?: HookInstallableHarness): string | undefined {
  try {
    const pointed = pointedHealthRecord(deps, harness)
    if (pointed === null) return undefined
    const now = (deps.now ?? Date.now)()
    const owed = (record: HealthRecord): record is HealthRecord & { faults: IntegrationFault[]; fingerprint: string } =>
      typeof record.checked_at === 'number' && now >= record.checked_at && now - record.checked_at < CACHED_NOTICE_MAX_AGE_MS &&
      Array.isArray(record.faults) && record.faults.length > 0 && typeof record.fingerprint === 'string' &&
      record.reported !== record.fingerprint
    if (!owed(pointed.record)) return undefined
    const current = healthPublicationCurrent(deps)
    if (!current()) return undefined
    return withFileLock(`${pointed.file}.lock`, () => {
      const record = readHealthRecord(pointed.file)
      if (!owed(record) || !current()) return undefined
      atomicWriteFileSync(pointed.file, JSON.stringify({ ...record, reported: record.fingerprint }))
      return faultNoticeText(record.faults)
    }, { waitMs: 0 })
  } catch {
    // Diagnostics never hold a turn, fail a hook, or block ordinary sending.
    return undefined
  }
}
