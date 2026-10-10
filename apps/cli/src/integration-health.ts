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
import { type HookInstallableHarness } from './harnesses.js'
import { HOOK_EVENTS, requiredHookEvents } from './hook-events.js'
import { hookAdapterTargetsArtifact, inspectHookAdapter, isNpxAdapterTarget } from './hook-adapter.js'
import { codexTrustProblems, findInstallations, handlerEvent, type Installation } from './install-hooks.js'
import { conventionalSkillPath, discoverNotifaiSkills, skillInventoryIssue } from './native-skills.js'
import { packageVersion } from './release.js'
import { type SkillInspectionBudget } from './skill-integrity.js'

export function installationFaults(installation: Installation, platform?: NodeJS.Platform): string[] {
  const events = installation.handlers.map(handler => handlerEvent(handler.command))
  return [
    ...(installation.problems ?? []),
    ...requiredHookEvents(installation.harness, platform).filter(event => !events.includes(event))
      .map(event => `missing ${event}`),
    ...events.filter(event => event !== null && !(HOOK_EVENTS as readonly string[]).includes(event))
      .map(event => `unsupported ${event}`),
    ...stopShapeProblems(installation),
  ]
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
  /** Paths and detailed evidence stay local, never Notification Request copy. */
  detail: string
  remedy: string
}

export function localIntegrationAssessment(deps: CommandDeps, harness?: HookInstallableHarness, budget?: SkillInspectionBudget) {
  const target = deps.hookInstallTarget
  const artifact = target !== undefined && !isNpxAdapterTarget(target) ? (target.kind === 'native' ? process.execPath : target.scriptPath) : buildIdentity() !== null ? process.execPath : process.argv[1]
  const cli = inspectCliInstallations(deps.env, deps.hookPlatform, {
    ...(artifact === undefined ? {} : { runningArtifactPath: artifact }),
    currentVersion: deps.runningVersion === undefined ? packageVersion() : deps.runningVersion,
  })
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
    const problems = installationFaults(installation, deps.hookPlatform)
    if (problems.length > 0) faults.push({ code: 'hooks-drift', detail: `${installation.file}: ${problems.join('; ')}`,
      remedy: `notifai hooks install --harness ${installation.harness}` })
    if (installation.harness === 'codex' && codexTrustProblems([installation], env).length > 0) {
      faults.push({ code: 'native-approval-pending', detail: `Native approval is unresolved for ${installation.file}.`, remedy: '/hooks' })
    }
  }
  // The production synchronous adapter and its async list share discovery.
  // Custom adapters can provide inspect to exercise this same boundary in tests.
  const results = (['project', 'global'] as const).map(scope => ({ scope,
    ...(deps.nativeSkills?.inspect ?? discoverNotifaiSkills)(scope, deps.cwd, deps.env, budget) }))
  const inventory = { installed: results.flatMap(result => result.skills),
    errors: results.flatMap(result => result.error === undefined ? [] : [`${result.scope}: ${result.error}`]) }
  const issue = skillInventoryIssue(inventory)
  if (issue !== null) faults.push({ code: issue.code, detail: issue.detail, remedy: issue.remedy })
  else for (const skill of inventory.installed) {
    if (skill.condition !== 'managed-current') faults.push({ code: 'skill-drift',
      detail: `Receipt-backed guidance differs from this CLI at ${skill.path}.`, remedy: 'notifai update --refresh-skill --json' })
  }
  return { cli, faults, installations }
}

const CHECK_INTERVAL_MS = 60_000

/** Once per changed fault, across repeated callbacks and Projects on a machine. */
export function integrationFaultNotice(deps: CommandDeps, harness?: HookInstallableHarness, consume = true, force = false): string | undefined {
  try {
    const projectSkill = conventionalSkillPath('project', 'notifai', deps.cwd, deps.env)
    const key = createHash('sha256').update(JSON.stringify([harness, deps.env['CODEX_HOME'], deps.hookInstallTarget,
      existsSync(path.join(projectSkill, 'SKILL.md')) ? projectSkill : null])).digest('hex')
    const file = path.join(stateDir(deps.env), 'integration-health', `${key}.json`)
    return withFileLock(`${file}.lock`, () => {
      let previous: { checked_at?: number; reported?: string; fingerprint?: string; faults?: IntegrationFault[] } = {}
      try { previous = JSON.parse(readFileSync(file, 'utf8')) } catch { /* first check */ }
      const now = (deps.now ?? Date.now)()
      const cached = !force && typeof previous.checked_at === 'number' && now >= previous.checked_at &&
        now - previous.checked_at < CHECK_INTERVAL_MS && Array.isArray(previous.faults)
      // Reserve this interval before inspecting: a failed or size-bounded
      // scan must not be retried on every ordinary tool or resident probe.
      if (!cached) atomicWriteFileSync(file, JSON.stringify({ ...previous, checked_at: now,
        faults: Array.isArray(previous.faults) ? previous.faults : [] }))
      const faults = cached ? previous.faults! : localIntegrationAssessment(deps, harness,
        { maxFiles: 256, maxBytes: 2 * 1024 * 1024, deadlineAt: Date.now() + 75 }).faults
      const fingerprint = createHash('sha256').update(JSON.stringify(faults)).digest('hex')
      const shouldReport = faults.length > 0 && (consume ? previous.reported !== fingerprint : previous.fingerprint !== fingerprint)
      if (!cached || (consume && shouldReport)) atomicWriteFileSync(file, JSON.stringify({
        checked_at: cached ? previous.checked_at : now, fingerprint, faults,
        reported: faults.length === 0 || (consume && shouldReport) ? fingerprint : previous.reported,
      }))
      if (!shouldReport) return undefined
      // No file contents, paths, settings, or trust evidence enter agent copy.
      const codes = [...new Set(faults.map(fault => fault.code))].join(', ')
      return `Notifai local integration needs attention (${codes}). Run \`notifai doctor --json\` for the exact lost capability and remedy before relying on prompt note delivery. This diagnostic does not block ordinary sends. Report actionable faults to the Notification Request owner; honor User deferrals. Do not change installations, settings or native trust without authorization, restart unnecessarily, or send repeated warnings.`
    }, { waitMs: 0 })
  } catch {
    // Diagnostics never hold a turn, fail a hook, or block ordinary sending.
    return undefined
  }
}
