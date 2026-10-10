import { loadedIntegrationObserved, sourceIntegrationRevision } from './integration-revision.js'
/** Narrow write-ahead requirements for owned hook repairs. Runtime selection
 * remains the Installation transaction's responsibility. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import type { CommandDeps } from './commands-core.js'
import { resolveActiveHarness, type ActiveHarnessSession } from './commands-harness-context.js'
import { sessionHasEnded } from './hook-session-state.js'
import { activeQuestionRouteProblems } from './commands-hook-diagnostics.js'
import { codexToolHookReady, CODEX_TOOL_HOOK_RECOVERY } from './codex-tool-messages.js'
import { stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { isHookInstallableHarness, questionRoutingCapability } from './harnesses.js'
import { buildHookConfig, buildCursorHookConfig, NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS, settingsFile, codexTrustProblems, type Installation } from './install-hooks.js'
import { hookAdapterPath, inspectHookAdapter } from './hook-adapter.js'
import { opencodePluginSource } from './opencode-plugin.js'
import { openclawPluginSource } from './openclaw-plugin.js'
import { hermesPluginSource } from './hermes-plugin.js'
import { installationFaults } from './integration-health.js'

type Requirement = { file: string; harness: Installation['harness']; before: string; expected: string; owner?: ActiveHarnessSession }
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const location = (deps: CommandDeps) => path.join(stateDir(deps.env), 'integration-repair.json')
function read(file: string): Requirement[] {
  if (!existsSync(file)) return []
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Unverified integration repair requirements')
  const bytes = readFileSync(file, 'utf8')
  const value = JSON.parse(bytes)
  if (value?.schema !== 1 || !Array.isArray(value.requirements) || value.requirements.some((item: Requirement) =>
    !item || typeof item.file !== 'string' || !path.isAbsolute(item.file) || !isHookInstallableHarness(item.harness) ||
    !/^[a-f0-9]{64}$/.test(item.before) || !/^[a-f0-9]{64}$/.test(item.expected) || item.owner !== undefined &&
    (item.owner.harness !== item.harness || typeof item.owner.label !== 'string' ||
      item.owner.sessionId !== undefined && typeof item.owner.sessionId !== 'string'))) throw new Error('Invalid integration repair requirements')
  return value.requirements
}
function save(file: string, requirements: Requirement[]): void {
  atomicWriteFileSync(file, JSON.stringify({ schema: 1, requirements }) + '\n', { requireCurrentUserOwner: true })
}

/** Render only the owned definition. The literal revision excludes unrelated
 * host config and stays stable across runtime-only updates. */
function desiredRevision(deps: CommandDeps, installation: Installation): string {
  const platform = deps.hookPlatform ?? process.platform
  const adapterPath = hookAdapterPath(deps.hookAdapterHome, platform)
  const target = inspectHookAdapter(deps.hookAdapterHome, platform).target
  const nodePath = platform === 'win32' && target?.kind !== 'native' ? target?.execPath : undefined
  const options = { adapterPath, platform, integrationScope: installation.file,
    ...(nodePath === undefined ? {} : { nodePath }) }
  const source = installation.harness === 'hermes' ? hermesPluginSource(adapterPath, nodePath, installation.file)
    : installation.harness === 'opencode' ? opencodePluginSource({ ...options, timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS })
    : installation.harness === 'openclaw' ? openclawPluginSource({ ...options, timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS })
    : JSON.stringify(installation.harness === 'cursor' ? buildCursorHookConfig(options)
      : buildHookConfig({ ...options, harness: installation.harness }))
  const revision = sourceIntegrationRevision(source)
  if (!revision) throw new Error('Owned hook definition has no verifiable revision')
  return revision
}

/** Caller holds the captured integration publication fence. Intent precedes
 * every owned write, so interruption cannot turn an unfinished repair into an
 * unrelated diagnostic. A second repair never replaces the original owner. */
export function withHookRepairIntent<T>(deps: CommandDeps, installation: Installation,
  owner: ActiveHarnessSession | null, action: () => T): T {
  const file = location(deps)
  return withFileLock(`${file}.lock`, () => {
    const requirements = read(file)
    const target = { ...installation, file: settingsFile(installation.harness, deps.env, deps.hookPlatform) }
    const expected = desiredRevision(deps, target)
    const existing = requirements.find(item => item.file === target.file)
    if (existing) {
      // A newly authorized generation may replace the intended definition;
      // retain the original affected owner until a real callback proves it.
      existing.expected = expected
      save(file, requirements)
    } else {
      requirements.push({ file: target.file, harness: installation.harness, before: digest(installation.file), expected,
        ...(owner?.harness === installation.harness ? { owner } : {}) })
      save(file, requirements)
    }
    return action()
  }, { waitMs: 1_000 })
}

/** Resolve only against the changed scope's real trust and callback evidence.
 * Unrelated pre-existing defects never become migration requirements. Caller
 * holds the publication fence through this final synchronous assessment. */
export function pendingHookRepairs(deps: CommandDeps,
  installations: Array<{ installation: Installation; env: NodeJS.ProcessEnv }>): string[] {
  const file = location(deps)
  return withFileLock(`${file}.lock`, () => {
    const remaining: Requirement[] = [], pending: string[] = []
    for (const requirement of read(file)) {
      const selected = installations.find(item => item.installation.file === requirement.file)
      if (!selected) {
        remaining.push(requirement)
        pending.push(`The changed ${requirement.harness} integration is outside this inspection scope; resume in its original context.`)
        continue
      }
      const { installation, env } = selected
      const faults = installationFaults(installation, deps.hookPlatform)
      if (faults.length > 0) {
        remaining.push(requirement)
        pending.push(`The owned ${requirement.harness} hook repair remains incomplete.`)
        continue
      }
      // If publication never happened, an unchanged healthy definition needs
      // no activation proof. Retrying repairs a still-damaged definition first.
      if (digest(installation.file) === requirement.before) continue
      const problems: string[] = []
      if (installation.harness === 'codex' && codexTrustProblems([installation], env).length > 0) {
        problems.push('native-approval-pending: Changed Codex hooks require approval through /hooks.')
      }
      const revision = sourceIntegrationRevision(['hermes', 'openclaw', 'opencode'].includes(installation.harness)
        ? readFileSync(installation.file, 'utf8') : JSON.stringify(installation.handlers))
      if (revision !== requirement.expected) problems.push(`The intended ${requirement.harness} definition changed before verification; inspect its owned repair.`)
      let owner = requirement.owner
      if (owner?.sessionId && sessionHasEnded(owner.sessionId, env)) {
        // SessionEnd ends this activation requirement, not its question/ack
        // records. Verify a replacement only in the same configured scope;
        // never transfer the ended owner's outstanding work.
        const current = resolveActiveHarness(deps.env, deps.cwd, (deps.now ?? Date.now)())
        const replacement = current.contested.length === 0 ? current.active : null
        if (selected.env === deps.env && replacement?.harness === owner.harness && replacement.sessionId &&
            replacement.sessionId !== owner.sessionId && !sessionHasEnded(replacement.sessionId, deps.env)) owner = replacement
        else {
          problems.push(`The original ${owner.label} session ended before activation was verified; resume from a verified session in the same integration scope.`)
          owner = undefined
        }
      }
      if (owner) {
        if (revision !== requirement.expected || owner.sessionId === undefined || !loadedIntegrationObserved(owner.sessionId, requirement.expected, env)) {
          problems.push(`The changed ${owner.label} definition has not been observed in this Agent Session. Preserve existing work and verify a real lifecycle callback after the harness loads the repaired definition.`)
        }
      }
      if (owner && isHookInstallableHarness(owner.harness) &&
          questionRoutingCapability(owner.harness, deps.hookPlatform).stopContinuation !== 'unsupported') {
        problems.push(...activeQuestionRouteProblems({ ...deps, env }, owner, [installation]))
        if (owner.harness === 'codex' && (deps.hookPlatform ?? process.platform) !== 'win32' &&
            (owner.sessionId === undefined || !codexToolHookReady({ ...deps, env }, owner.sessionId))) {
          problems.push(CODEX_TOOL_HOOK_RECOVERY)
        }
      }
      if (problems.length > 0) { remaining.push(requirement); pending.push(...problems) }
    }
    save(file, remaining)
    return [...new Set(pending)]
  }, { waitMs: 1_000 })
}
