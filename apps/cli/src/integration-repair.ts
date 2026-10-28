import { claudeHookFormFor } from './claude-hook-form.js'
import { sourceIntegrationRevision } from './integration-revision.js'
import { installedRevision, sessionHandlers, sessionHandlersLine } from './session-handlers.js'
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
import { buildHookConfig, buildCursorHookConfig, NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS, settingsFile, codexTrustFindings,
  codexHandlerFingerprints, findInstallations, machineHookFiles, summarizeCodexTrustFindings, type CodexTrustFinding,
  type Installation } from './install-hooks.js'
import { hookAdapterPath, inspectHookAdapter } from './hook-adapter.js'
import { opencodePluginLine, opencodePluginSourceFor, opencodeVersionFor } from './opencode-version.js'
import { openclawPluginSource } from './openclaw-plugin.js'
import { hermesPluginSource } from './hermes-plugin.js'
import { installationFaults } from './integration-health.js'

/** `before_handlers`, Codex only: the handlers on disk before the repair
 * rewrote them, which is what an owner session already running had loaded. */
type Requirement = { file: string; harness: Installation['harness']; before: string; expected: string; owner?: ActiveHarnessSession
  before_handlers?: Record<string, string> }
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
      item.owner.sessionId !== undefined && typeof item.owner.sessionId !== 'string') ||
    item.before_handlers !== undefined && (typeof item.before_handlers !== 'object' || item.before_handlers === null ||
      Object.values(item.before_handlers).some(value => typeof value !== 'string')))) throw new Error('Invalid integration repair requirements')
  return value.requirements
}
function save(file: string, requirements: Requirement[]): void {
  atomicWriteFileSync(file, JSON.stringify({ schema: 1, requirements }) + '\n', { requireCurrentUserOwner: true })
}

/** Render only the owned definition. The literal revision excludes unrelated
 * host config and stays stable across runtime-only updates. */
function desiredRevision(deps: CommandDeps, installation: Installation): string {
  // Codex proves activation per handler at SessionStart, never by revision
  // (session-handlers.ts). The field stays for the record's format.
  if (installation.harness === 'codex') return createHash('sha256').update(`codex\n${installation.file}`).digest('hex')
  const platform = deps.hookPlatform ?? process.platform
  const adapterPath = hookAdapterPath(deps.hookAdapterHome, platform)
  const target = inspectHookAdapter(deps.hookAdapterHome, platform).target
  const nodePath = platform === 'win32' && target?.kind !== 'native' ? target?.execPath : undefined
  const options = { adapterPath, platform, integrationScope: installation.file,
    ...(nodePath === undefined ? {} : { nodePath }) }
  const source = installation.harness === 'hermes' ? hermesPluginSource(adapterPath, nodePath, installation.file)
    : installation.harness === 'opencode' ? opencodePluginSourceFor(opencodePluginLine(opencodeVersionFor(deps), installation.opencodeLine),
      { ...options, timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS })
    : installation.harness === 'openclaw' ? openclawPluginSource({ ...options, timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS })
    : JSON.stringify(installation.harness === 'cursor' ? buildCursorHookConfig(options)
      : buildHookConfig({ ...options, harness: installation.harness,
        // The same decision the install makes from the same definition.
        ...(installation.harness === 'claude-code'
          ? { claudeForm: claudeHookFormFor(deps, installation.handlers.some((handler) => handler.execForm === true)).form }
          : {}) }))
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
        ...(owner?.harness === installation.harness ? { owner } : {}),
        ...(installation.harness === 'codex' ? { before_handlers: codexHandlerFingerprints([installation], deps.env) } : {}) })
      save(file, requirements)
    }
    return action()
  }, { waitMs: 1_000 })
}

/** The home variable that selects where each harness reads the recorded file,
 * and its value for that file. Only harnesses whose home a session manager can
 * select this way appear here. */
const HOME_VARIABLE: Partial<Record<Installation['harness'], (file: string) => [string, string]>> = {
  codex: file => ['CODEX_HOME', path.dirname(file)],
  'claude-code': file => ['CLAUDE_CONFIG_DIR', path.dirname(file)],
  grok: file => ['GROK_HOME', path.dirname(path.dirname(file))],
}

/** The recorded file inspected where it is, from any shell. It names exactly
 * one file Notifai wrote, so selecting its own home enumerates no other
 * account. Null when no home variable selects this very file; 'absent' when
 * the file no longer holds Notifai's hooks. */
function recordedScope(deps: CommandDeps, requirement: Requirement):
  { installation: Installation; env: NodeJS.ProcessEnv } | 'absent' | null {
  const home = HOME_VARIABLE[requirement.harness]?.(requirement.file)
  if (home === undefined) return null
  const env = { ...deps.env, [home[0]]: home[1] }
  if (!machineHookFiles(requirement.harness, env, deps.hookPlatform).includes(requirement.file)) return null
  const installation = findInstallations(env, deps.hookAdapterHome, deps.hookPlatform)
    .find(item => item.harness === requirement.harness && item.file === requirement.file)
  return installation === undefined ? 'absent' : { installation, env }
}

/** Resolve only against the changed scope's real trust and callback evidence.
 * Unrelated pre-existing defects never become migration requirements. Caller
 * holds the publication fence through this final synchronous assessment. */
export function pendingHookRepairs(deps: CommandDeps,
  installations: Array<{ installation: Installation; env: NodeJS.ProcessEnv }>,
  /** Codex trust, from Codex's own hooks/list where the caller could ask it. */
  codexTrust: (installations: Installation[], env: NodeJS.ProcessEnv) => CodexTrustFinding[] = codexTrustFindings): string[] {
  const file = location(deps)
  return withFileLock(`${file}.lock`, () => {
    const remaining: Requirement[] = [], pending: string[] = []
    for (let requirement of read(file)) {
      const inScope = installations.find(item => item.installation.file === requirement.file)
      const selected = inScope ?? recordedScope(deps, requirement)
      if (selected === null || selected === 'absent') {
        remaining.push(requirement)
        pending.push(selected === 'absent'
          ? `The changed ${requirement.harness} integration at ${requirement.file} no longer holds Notifai's hooks; run notifai hooks install --harness ${requirement.harness} where that file is the active ${requirement.harness} configuration.`
          : `The changed ${requirement.harness} integration at ${requirement.file} is outside this inspection scope; run notifai update --resume --json where that file is the active ${requirement.harness} configuration.`)
        continue
      }
      const { installation, env } = selected
      const faults = installationFaults(installation, deps.hookPlatform, { ...deps, env })
      if (faults.length > 0) {
        remaining.push(requirement)
        // This run repairs only what its own scope loads.
        pending.push(inScope ? `The owned ${requirement.harness} hook repair remains incomplete.`
          : `The owned ${requirement.harness} hook repair at ${requirement.file} remains incomplete; run notifai update --resume --json where that file is the active ${requirement.harness} configuration.`)
        continue
      }
      // If publication never happened, an unchanged healthy definition needs
      // no activation proof. Retrying repairs a still-damaged definition first.
      if (digest(installation.file) === requirement.before) continue
      // Codex handlers carry no revision since new installs stopped stamping it.
      const revision = installation.harness === 'codex' ? requirement.expected : installedRevision(installation)
      if (revision === null) {
        remaining.push(requirement)
        pending.push(`The ${requirement.harness} hooks at ${requirement.file} carry no single Notifai revision, so their activation cannot be verified; run notifai hooks install --harness ${requirement.harness} where that file is the active configuration.`)
        continue
      }
      // The healthy definition present supersedes the recorded one: a later
      // install, another build, or a host refreshing this copy from its source
      // replaced it, and nothing will ever republish the recorded revision.
      // Trust and activation proof now bind to what the harness will load.
      if (revision !== requirement.expected) requirement = { ...requirement, expected: revision }
      const problems: string[] = []
      if (installation.harness === 'codex' && summarizeCodexTrustFindings(codexTrust([installation], env)).length > 0) {
        const home = path.dirname(installation.file)
        problems.push(`native-approval-pending: Codex has not approved Notifai's changed hooks in ${home}. ${env['CODEX_HOME']
          ? `Open /hooks in a Codex session whose CODEX_HOME is ${home}` : 'Start codex, open /hooks'} and approve the Notifai handlers.`)
      }
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
        // Approval is per handler on disk, never per session: an approved
        // handler still runs only in sessions that loaded it.
        const line = owner.sessionId === undefined ? sessionHandlersLine({ harness: owner.harness as Installation['harness'],
          label: owner.label, state: 'unknown', missing: [], changed: [], blocking: [] })
          : sessionHandlersLine(sessionHandlers(env, { ...owner, sessionId: owner.sessionId }, [installation], {
            ...(installation.harness === 'codex'
              // The original owner was running when the repair began, so it
              // holds the definition from before; a replacement holds its own.
              ? owner === requirement.owner && requirement.before_handlers !== undefined ? { loaded: requirement.before_handlers } : {}
              : { expected: requirement.expected }),
          }))
        if (line !== null) problems.push(line)
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
