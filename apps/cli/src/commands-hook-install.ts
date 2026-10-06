import { buildIdentity } from './distribution.js'
import { hookAdapterPath, resolveHookAdapterHome } from './hook-adapter.js'
/** Hook installation and uninstallation across supported harnesses. */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { atomicWriteFileSync } from './atomic-file.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import { stopShapeProblems } from './commands-hook-shape.js'
import { withTargetFileLock } from './file-lock.js'
import {
  HARNESS_LABELS,
  HOOK_INSTALLABLE_HARNESSES,
  type HookInstallableHarness,
} from './harnesses.js'
import { installHookAdapter, isNpxAdapterTarget, type HookAdapterTarget } from './hook-adapter.js'
import type { HookEvent } from './hook-events.js'
import { HOOK_EVENT_COMMAND_RE, HOOK_EVENT_TABLE, HOOK_EVENTS, requiredHookEvents } from './hook-events.js'
import {
  NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
  applyPlan,
  buildCursorHookConfig,
  buildHookConfig,
  cleanupEmptiedCodexLayer,
  codexCoexistenceNotes,
  codexHomeNote,
  codexLegacyProjectLayers,
  codexMachineLayerPaths,
  codexRepresentationProblems,
  codexTrustProblems,
  detectHarness,
  detectedHarnesses,
  findInstallations,
  findLegacyProjectInstallations,
  findObsoleteNotifaiPluginWiring,
  handlerEvent,
  isTomlSettingsPath,
  loadCursorSettings,
  loadSettings,
  machineHookFiles,
  mergeCursorHooks,
  mergeHooks,
  prepareCodexPluginCleanup,
  preparePlan,
  removeCursorHooks,
  removeHooks,
  settingsFile,
  stripObsoleteNotifaiPluginEnablement,
  withCodexLayerTransaction,
  type SettingsDocument,
} from './install-hooks.js'
import {
  OPENCLAW_PLUGIN_MANIFEST,
  OPENCLAW_PLUGIN_PACKAGE,
  enableOpenclawNotifaiConfigText,
  isOurOpenclawPlugin,
  openclawPluginLoadBlockers,
  openclawPluginLoadWarning,
  openclawConfigPath,
  openclawPluginManifest,
  openclawPluginPackage,
  openclawPluginSource,
  parseOpenclawConfig,
  removeOpenclawLoadPathConfigText,
  removeOpenclawNotifaiConfigText,
} from './openclaw-plugin.js'
import { isOurOpencodePlugin, opencodePluginSource } from './opencode-plugin.js'
import { installHermesPlugin, preflightHermesPlugin, uninstallHermesPlugin } from './hermes-plugin.js'
import { packageVersion } from './release.js'
import { CLI_PACKAGE_NAME, cliPackageSpec } from './cli-contract.js'
import { activeNpmCli } from './npm-invocation.js'
import { removeClaudeCommandRules } from './claude-command-approval.js'
export interface HooksInstallFlags {
  harness?: string
  /** Init owns the final setup result and suppresses per-harness close narration. */
  narrate?: boolean
  /** Test seam; production resolves the running CLI. */
  execPath?: string
  scriptPath?: string
}

/** True when this process is `npx` / `npm exec`, not a global or linked install. */
export function runningViaNpx(env: NodeJS.ProcessEnv, scriptPath: string): boolean {
  if (env['npm_command'] === 'exec') return true
  return scriptPath.includes(`${path.sep}_npx${path.sep}`)
}

function fileHookInstallTarget(
  target: HookAdapterTarget | undefined,
): { execPath: string; scriptPath: string } | undefined {
  if (target === undefined || target.kind === 'native' || isNpxAdapterTarget(target)) return undefined
  return target
}

function resolveHookAdapterTarget(deps: CommandDeps, flags: HooksInstallFlags): HookAdapterTarget {
  if (buildIdentity() !== null) return { kind: 'native', execPath: hookAdapterPath(resolveHookAdapterHome(deps.hookAdapterHome, deps.env, deps.hookPlatform), deps.hookPlatform) }
  if (deps.hookInstallTarget !== undefined && (deps.hookInstallTarget.kind === 'native' || isNpxAdapterTarget(deps.hookInstallTarget))) {
    return deps.hookInstallTarget
  }
  const fileTarget = fileHookInstallTarget(deps.hookInstallTarget)
  const execPath = flags.execPath ?? fileTarget?.execPath ?? process.execPath
  const scriptPath = flags.scriptPath ?? fileTarget?.scriptPath ?? process.argv[1] ?? 'notifai'
  if (runningViaNpx(deps.env, scriptPath)) {
    const version = packageVersion()
    const npmCli = activeNpmCli(deps.env)
    if (version === null) {
      throw new Error(
        `Could not read this CLI version, so an npx hook target cannot be pinned. Install \`${CLI_PACKAGE_NAME}\` globally and rerun \`notifai hooks install\`.`,
      )
    }
    if (npmCli === null) {
      throw new Error(
        `This process looks like npx but npm_execpath is missing. Install \`${CLI_PACKAGE_NAME}\` globally and rerun \`notifai hooks install\`.`,
      )
    }
    return { kind: 'npx', execPath, npmCli, spec: cliPackageSpec(version) }
  }
  return { execPath, scriptPath }
}

function installationBytes(files: string[]): string {
  return JSON.stringify(files.map(file => {
    try { return [file, readFileSync(file, 'utf8')] } catch { return [file, null] }
  }))
}

function printHooksInstallClose(deps: CommandDeps, harness: HookInstallableHarness, file: string, changed = true): void {
  const label = HARNESS_LABELS[harness]
  const approvalNote = harness === 'codex' && codexTrustProblems(findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).filter(entry => entry.harness === 'codex'), deps.env).length === 0
    ? 'Your existing Codex hook approvals still match. ' : ''
  const activation = !changed
    ? approvalNote + 'Hook installation is unchanged; this write needs no restart. Continue the current Agent Session if its lifecycle and trust are ready; `notifai update --check --json` reports any remaining session requirement.'
    : harness === 'codex'
      ? codexTrustProblems(
          findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).filter(
            (installation) => installation.harness === 'codex',
          ),
          deps.env,
        ).length === 0
        ? 'Your existing Codex hook approvals still match. Start one fresh Codex session, send one prompt, and run `notifai doctor`.'
        : 'The changed Notifai handlers need approval. Open `/hooks` in Codex and approve or enable them, then start one fresh Codex session, send one prompt, and run `notifai doctor`.'
      : harness === 'cursor'
        ? 'Start one fresh Cursor conversation, send one prompt, finish its first turn, then run `notifai doctor`.'
        : harness === 'opencode'
          ? 'Restart OpenCode, start one fresh session, send one prompt, then run `notifai doctor`.'
          : harness === 'openclaw'
            ? 'Restart the OpenClaw Gateway, start one fresh Agent Session, send one prompt, then run `notifai doctor`.'
          : `Start one fresh ${label} session, send one prompt, then run \`notifai doctor\`.`
  if (deps.io.interactive === true && deps.io.note) {
    void deps.io.note(`${file}\n${activation}`, `${label} hooks installed`)
    return
  }
  deps.io.out(`Installed ${harness} hooks in ${file}`)
  deps.io.out(activation)
}

export function hooksInstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  if (flags.harness === undefined) {
    const detected = detectedHarnesses(deps.cwd, deps.env)
    if (detected.length === 0) {
      deps.io.err(`Could not tell which harness you mean — pass --harness <${HOOK_INSTALLABLE_HARNESSES.join('|')}>.`)
      return EXIT.usage
    }
    let ok = true
    for (const harness of detected) {
      if (hooksInstallCommand(deps, { ...flags, harness }) !== EXIT.ok) ok = false
    }
    return ok ? EXIT.ok : EXIT.failed
  }
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  if (harness === 'hermes') {
    try {
      preflightHermesPlugin(deps.env)
      const target = resolveHookAdapterTarget(deps, flags)
      const adapter = installHookAdapter(target, deps.hookAdapterHome, deps.hookPlatform, deps.env)
      const file = installHermesPlugin(adapter.path, deps.env,
        (deps.hookPlatform ?? process.platform) === 'win32' && target.kind !== 'native' ? target.execPath : undefined)
      deps.io.out(`Installed the Notifai Hermes plugin at ${file}. Start a fresh local classic CLI Agent Session; its live attendant can route questions after activation.`)
      return EXIT.ok
    } catch (err) {
      deps.io.err(`Could not install Hermes plugin: ${String(err)}`)
      return EXIT.failed
    }
  }
  const adapterTarget = resolveHookAdapterTarget(deps, flags)
  const scriptPath =
    flags.scriptPath ?? fileHookInstallTarget(adapterTarget)?.scriptPath ?? process.argv[1] ?? 'notifai'
  const hookPlatform = deps.hookPlatform ?? process.platform
  const nodePath = adapterTarget.kind === 'native' ? undefined : adapterTarget.execPath
  const codexPaths = harness === 'codex' ? codexMachineLayerPaths(deps.env, hookPlatform) : null
  let adapterPath: string
  try {
    // Refuse unsupported plugin configuration before even updating the adapter.
    // The authoritative plan is made again under the layer lock below.
    if (codexPaths !== null) prepareCodexPluginCleanup(codexPaths.configToml)
    if (harness === 'openclaw') {
      const configFile = openclawConfigPath(deps.env, hookPlatform)
      if (existsSync(configFile)) {
        assertOwnedRegularFile(configFile)
        parseOpenclawConfig(readFileSync(configFile, 'utf8'), configFile)
      }
    }
    adapterPath = installHookAdapter(adapterTarget, deps.hookAdapterHome, hookPlatform, deps.env).path
  } catch (err) {
    deps.io.err(`Could not prepare hook installation: ${String(err)}`)
    return EXIT.failed
  }
  // Codex is the one harness whose layer holds two candidate files, so its
  // transaction anchors on `config.toml` and the inspection names the target.
  const settingsTarget = codexPaths?.configToml ?? settingsFile(harness, deps.env, hookPlatform)
  const comparedFiles = codexPaths === null ? [settingsTarget] : [codexPaths.configToml, codexPaths.hooksJson]
  const beforeInstall = installationBytes(comparedFiles)

  // OpenCode's adapter is a generated plugin module rather than a handler
  // merged into a settings document, so it owns the whole file.
  if (harness === 'opencode') {
    return finishInstall(
      deps,
      harness,
      scriptPath,
      installOpencodePlugin(deps, settingsTarget, {
        adapterPath,
        timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
        platform: hookPlatform,
        ...(nodePath === undefined ? {} : { nodePath }),
        ...(flags.narrate === undefined ? {} : { narrate: flags.narrate }),
      }),
    )
  }
  if (harness === 'openclaw') {
    return finishInstall(
      deps,
      harness,
      scriptPath,
      installOpenclawPlugin(deps, settingsTarget, {
        adapterPath,
        timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
        platform: hookPlatform,
        ...(nodePath === undefined ? {} : { nodePath }),
        ...(flags.narrate === undefined ? {} : { narrate: flags.narrate }),
      }),
    )
  }
  if (harness === 'grok') {
    return finishInstall(
      deps,
      harness,
      scriptPath,
      installGrokHooks(deps, settingsTarget, { adapterPath, platform: hookPlatform, ...(nodePath === undefined ? {} : { nodePath }) }, flags.narrate),
    )
  }

  if (harness === 'cursor') {
    try {
      withTargetFileLock(settingsTarget, () => {
        const document = loadCursorSettings(settingsTarget)
        const result = mergeCursorHooks(
          document,
          buildCursorHookConfig({
            adapterPath,
            harness: 'cursor',
            platform: hookPlatform,
            ...(nodePath === undefined ? {} : { nodePath }),
          }),
          scriptPath,
        )
        applyPlan(settingsTarget, result.document)
        return result
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    if (flags.narrate !== false) printHooksInstallClose(deps, harness, settingsTarget, beforeInstall !== installationBytes(comparedFiles))
    return finishInstall(deps, harness, scriptPath, EXIT.ok)
  }

  const prepareInstall = (
    file: string,
    document: SettingsDocument = loadSettings(file),
    previous?: string | null,
  ): { file: string; foreignStopCount: number; apply: () => void } => {
    const foreignStopCount = foreignStopHandlers(document).length
    const result = mergeHooks(
      document,
      buildHookConfig({
        adapterPath,
        harness,
        platform: hookPlatform,
        ...(nodePath === undefined ? {} : { nodePath }),
      }),
      scriptPath,
      { preserveIdentities: harness === 'codex' },
    )
    // JSON settings can carry leftover native plugin enablement in the same
    // document as hooks. Strip it in this write so a crash cannot leave both
    // firing. Codex plugin cleanup is planned and persisted first below.
    const next = isTomlSettingsPath(file)
      ? result.document
      : stripObsoleteNotifaiPluginEnablement(result.document).document
    return { file, foreignStopCount, apply: preparePlan(file, next, previous) }
  }

  let installed: { file: string; foreignStopCount: number }
  let migratedOwnedInline = false
  let disabledPlugins: string[] = []
  try {
    installed =
      codexPaths === null
        ? withTargetFileLock(settingsTarget, () => {
            const plan = prepareInstall(settingsTarget)
            plan.apply()
            return plan
          })
        : withCodexLayerTransaction(codexPaths, (inspection) => {
            const cleanup = prepareCodexPluginCleanup(inspection.paths.configToml)
            const documentAfterCleanup = (file: string): SettingsDocument =>
              file === inspection.paths.configToml
                ? cleanup.source === null ? {} : parseToml(cleanup.source) as SettingsDocument
                : loadSettings(file)
            const previousAfterCleanup = (file: string): string | null | undefined =>
              file === inspection.paths.configToml ? cleanup.source : undefined
            const target = inspection.writeTarget
            const plan = prepareInstall(target, documentAfterCleanup(target), previousAfterCleanup(target))
            const staleTarget = target === inspection.paths.hooksJson
              ? inspection.paths.configToml : inspection.paths.hooksJson
            const stale = removeHooks(documentAfterCleanup(staleTarget), scriptPath)
            const removeStale = stale.replaced.length === 0 ? null : preparePlan(
              staleTarget, stale.document, previousAfterCleanup(staleTarget),
            )
            // All syntax/preservation plans are validated before writing. Retire
            // the native plugin FIRST and never restore it on a later failure:
            // an interruption can leave no new wiring, never two firing paths.
            cleanup.apply()
            disabledPlugins = cleanup.removed
            const before = existsSync(target) ? readFileSync(target, 'utf8') : null
            plan.apply()
            const written = readFileSync(target, 'utf8')
            try {
              removeStale?.()
            } catch (err) {
              // Roll back only our document write, never native enablement or
              // an external writer's configuration.
              if (readFileSync(target, 'utf8') === written) {
                if (before === null) rmSync(target, { force: true })
                else atomicWriteFileSync(target, before)
              }
              throw err
            }
            migratedOwnedInline = removeStale !== null && staleTarget === inspection.paths.configToml
            return plan
          })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }

  if (disabledPlugins.length > 0) {
    deps.io.out(`Disabled leftover Notifai native plugin wiring (${disabledPlugins.join(', ')}) so it cannot fire beside document hooks`)
  }
  if (migratedOwnedInline) {
    deps.io.out(
      'Moved Notifai Codex handlers from config.toml to hooks.json. Codex keys approval by source path, so open `/hooks` and approve the new handlers.',
    )
  }
  if (flags.narrate !== false) printHooksInstallClose(deps, harness, installed.file, beforeInstall !== installationBytes(comparedFiles))
  if (installed.foreignStopCount > 0) {
    const label = HARNESS_LABELS[harness]
    deps.io.out(
      `This layer already has a Stop handler that Notifai does not own. ${label} may run it alongside Notifai's handler; Notifai preserves it but has not assessed its behavior.`,
    )
  }
  if (harness === 'codex') {
    for (const problem of codexRepresentationProblems(deps.env, hookPlatform)) {
      deps.io.out(problem)
    }
    for (const note of codexCoexistenceNotes(deps.env, hookPlatform)) {
      deps.io.out(note)
    }
    const home = codexHomeNote(deps.env, hookPlatform)
    if (home !== null) deps.io.out(home)
  }
  return finishInstall(deps, harness, scriptPath, EXIT.ok)
}

/**
 * Clear this Project's leftover Notifai wiring, once the Machine installation
 * this run just wrote is proven current.
 *
 * Order matters and is the whole reason this is not part of the write above: a
 * legacy Project handler is still routing questions until the Machine one can
 * be shown to have every required event, a sound Stop shape, and no structural
 * problem. Removing it first would leave a window with no working route, and
 * removing it after a failed install would leave none at all.
 */
function finishInstall(
  deps: CommandDeps,
  harness: HookInstallableHarness,
  scriptPath: string,
  code: number,
): number {
  if (code !== EXIT.ok) return code
  if (!machineInstallationIsCurrent(deps, harness)) return code
  removeLegacyProjectInstallations(deps, harness, scriptPath)
  return code
}

/** Whether exactly one complete, undamaged Machine installation is in place. */
function machineInstallationIsCurrent(deps: CommandDeps, harness: HookInstallableHarness): boolean {
  const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).filter(
    (installation) => installation.harness === harness,
  )
  if (installations.length !== 1) return false
  const installation = installations[0]!
  if ((installation.problems?.length ?? 0) > 0) return false
  if (stopShapeProblems(installation).length > 0) return false
  const installed = new Set(
    installation.handlers
      .map((handler) => handlerEvent(handler.command))
      .filter((event): event is HookEvent =>
        event !== null && (HOOK_EVENTS as readonly string[]).includes(event),
      ),
  )
  return requiredHookEvents(harness, deps.hookPlatform).every((event) => installed.has(event))
}

function foreignStopHandlers(document: { hooks?: Record<string, { hooks?: { command: string }[] }[]> }): { command: string }[] {
  const groups = document.hooks?.['Stop']
  if (!Array.isArray(groups)) return []
  return groups
    .flatMap((group) => group.hooks ?? [])
    .filter((handler) => !HOOK_EVENT_COMMAND_RE.test(handler.command))
}

/**
 * Writes the OpenCode plugin, replacing any Notifai plugin already there —
 * including one a different checkout wrote, matched on the managed marker for
 * the same reason command hooks are.
 */
function installOpencodePlugin(
  deps: CommandDeps,
  file: string,
  options: {
    adapterPath: string
    timeoutSeconds: number
    platform?: NodeJS.Platform
    nodePath?: string
    narrate?: boolean
  },
): number {
  const beforeInstall = installationBytes([file])
  try {
    withTargetFileLock(file, () => {
      if (existsSync(file)) {
        assertOwnedRegularFile(file)
        const existing = readFileSync(file, 'utf8')
        if (!isOurOpencodePlugin(existing)) {
          throw new Error(`${file} exists and was not written by Notifai; move it aside first.`)
        }
      }
      atomicWriteFileSync(file, opencodePluginSource(options), {
        mode: 0o600,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
    })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  if (options.narrate !== false) printHooksInstallClose(deps, 'opencode', file, beforeInstall !== installationBytes([file]))
  return EXIT.ok
}

/** Grok merges global hook files. This entire file is ours; leave foreign files untouched. */
function installGrokHooks(
  deps: CommandDeps,
  file: string,
  options: { adapterPath: string; platform: NodeJS.Platform; nodePath?: string },
  narrate: boolean | undefined,
): number {
  const before = installationBytes([file])
  try {
    withTargetFileLock(file, () => {
      if (existsSync(file)) {
        assertOwnedRegularFile(file)
        if (!isOurGrokHookFile(readFileSync(file, 'utf8'))) {
          throw new Error(`${file} exists and was not written by Notifai; move it aside first.`)
        }
      }
      atomicWriteFileSync(file, `${JSON.stringify({ hooks: buildHookConfig({
        adapterPath: options.adapterPath,
        harness: 'grok',
        platform: options.platform,
        ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
      }) }, null, 2)}\n`, {
        mode: 0o600,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
    })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  if (narrate !== false) printHooksInstallClose(deps, 'grok', file, before !== installationBytes([file]))
  return EXIT.ok
}

function isOurGrokHookFile(source: string): boolean {
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { return false }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const document = parsed as Record<string, unknown>
  if (Object.keys(document).length !== 1 || typeof document['hooks'] !== 'object' || document['hooks'] === null || Array.isArray(document['hooks'])) return false
  const events = Object.entries(document['hooks'] as Record<string, unknown>)
  const knownEvents = new Set<string>(HOOK_EVENT_TABLE.flatMap((row) => row.document === null ? [] : [row.document]))
  return events.length > 0 && events.every(([event, groups]) =>
    knownEvents.has(event) && Array.isArray(groups) && groups.length > 0 && groups.every((group) =>
      typeof group === 'object' && group !== null && !Array.isArray(group) &&
      Object.keys(group).every((key) => key === 'matcher' || key === 'hooks') &&
      (group.matcher === undefined || typeof group.matcher === 'string') &&
      Array.isArray(group.hooks) && group.hooks.length > 0 && group.hooks.every((handler: unknown) =>
        isOurGrokHookHandler(handler),
      ),
    ),
  )
}

function isOurGrokHookHandler(handler: unknown): boolean {
  if (typeof handler !== 'object' || handler === null || Array.isArray(handler)) return false
  const fields = handler as Record<string, unknown>
  const command = fields['command']
  return Object.keys(fields).every((key) => key === 'type' || key === 'command' || key === 'timeout') &&
    fields['type'] === 'command' && typeof command === 'string' &&
    (fields['timeout'] === undefined || typeof fields['timeout'] === 'number') &&
    HOOK_EVENT_COMMAND_RE.test(command) && command.includes('--owner notifai --harness grok')
}

function installOpenclawPlugin(
  deps: CommandDeps,
  file: string,
  options: {
    adapterPath: string
    timeoutSeconds: number
    platform?: NodeJS.Platform
    nodePath?: string
    narrate?: boolean
  },
): number {
  const pluginDir = path.dirname(file)
  const comparedFiles = [file, path.join(pluginDir, OPENCLAW_PLUGIN_MANIFEST), path.join(pluginDir, OPENCLAW_PLUGIN_PACKAGE), openclawConfigPath(deps.env, deps.hookPlatform)]
  const beforeInstall = installationBytes(comparedFiles)
  let blockers: ReturnType<typeof openclawPluginLoadBlockers> = []
  try {
    withTargetFileLock(file, () => {
      if (existsSync(file)) {
        assertOwnedRegularFile(file)
        const existing = readFileSync(file, 'utf8')
        if (!isOurOpenclawPlugin(existing)) {
          throw new Error(`${file} exists and was not written by Notifai; move it aside first.`)
        }
      }
      atomicWriteFileSync(file, openclawPluginSource(options), {
        mode: 0o600,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
      atomicWriteFileSync(path.join(pluginDir, OPENCLAW_PLUGIN_MANIFEST), openclawPluginManifest(), {
        mode: 0o600,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
      atomicWriteFileSync(path.join(pluginDir, OPENCLAW_PLUGIN_PACKAGE), openclawPluginPackage(), {
        mode: 0o600,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
    })
    blockers = writeOpenclawEnablement(deps)
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  const warning = openclawPluginLoadWarning(blockers)
  if (warning !== null) deps.io.err(warning)
  if (options.narrate !== false) printHooksInstallClose(deps, 'openclaw', file, beforeInstall !== installationBytes(comparedFiles))
  return EXIT.ok
}

function writeOpenclawEnablement(deps: CommandDeps): ReturnType<typeof openclawPluginLoadBlockers> {
  const configFile = openclawConfigPath(deps.env, deps.hookPlatform)
  return withTargetFileLock(configFile, () => {
    if (existsSync(configFile)) assertOwnedRegularFile(configFile)
    const source = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '{}\n'
    const config = parseOpenclawConfig(source, configFile)
    const nextSource = enableOpenclawNotifaiConfigText(source, configFile)
    atomicWriteFileSync(configFile, nextSource, {
      mode: 0o600,
      preserveMode: true,
      requireCurrentUserOwner: true,
    })
    return openclawPluginLoadBlockers(config)
  })
}

function removeEmptyOpenclawPluginDirectory(pluginDir: string): void {
  try {
    if (!lstatSync(pluginDir).isDirectory() || readdirSync(pluginDir).length !== 0) return
    rmdirSync(pluginDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return
    throw err
  }
}

/**
 * Delete a Notifai-written plugin module and everything generated beside it.
 *
 * Returns what happened rather than narrating, because uninstall and migration
 * cleanup say different things about the same outcome.
 */
function removeNotifaiPluginFile(
  harness: 'opencode' | 'openclaw',
  file: string,
): 'removed' | 'absent' | 'foreign' {
  const pluginDir = path.dirname(file)
  const outcome = withTargetFileLock(file, () => {
    if (!existsSync(file)) return 'absent'
    assertOwnedRegularFile(file)
    const source = readFileSync(file, 'utf8')
    // We own the whole file, but only if we wrote it.
    const ours = harness === 'openclaw' ? isOurOpenclawPlugin(source) : isOurOpencodePlugin(source)
    if (!ours) return 'foreign'
    rmSync(file, { force: true })
    if (harness === 'openclaw') {
      rmSync(path.join(pluginDir, OPENCLAW_PLUGIN_MANIFEST), { force: true })
      rmSync(path.join(pluginDir, OPENCLAW_PLUGIN_PACKAGE), { force: true })
    }
    return 'removed'
  })
  if (harness === 'openclaw' && outcome === 'removed') {
    removeEmptyOpenclawPluginDirectory(pluginDir)
  }
  return outcome
}

/** Apply a minimal JSONC edit to OpenClaw's config. */
function editOpenclawConfig(
  deps: CommandDeps,
  edit: (source: string, configFile: string) => string,
): void {
  const configFile = openclawConfigPath(deps.env, deps.hookPlatform)
  if (!existsSync(configFile)) return
  withTargetFileLock(configFile, () => {
    assertOwnedRegularFile(configFile)
    const source = readFileSync(configFile, 'utf8')
    const next = edit(source, configFile)
    if (next === source) return
    atomicWriteFileSync(configFile, next, {
      mode: 0o600,
      preserveMode: true,
      requireCurrentUserOwner: true,
    })
  })
}

interface HandlerRemoval {
  /** Files that existed and were inspected, whoever owns their contents. */
  existing: string[]
  removed: { file: string; events: string[] }[]
}

/** Strip only Notifai's handlers from each settings document that exists. */
function stripNotifaiHandlers(
  files: readonly string[],
  scriptPath: string,
  cursor: boolean,
): HandlerRemoval {
  const existing = files.filter((candidate) => existsSync(candidate))
  const removed: { file: string; events: string[] }[] = []
  for (const candidate of existing) {
    const strip = () => {
      if (cursor) {
        const result = removeCursorHooks(loadCursorSettings(candidate), scriptPath)
        if (result.replaced.length > 0) applyPlan(candidate, result.document)
        return result
      }
      const result = removeHooks(loadSettings(candidate), scriptPath)
      if (isTomlSettingsPath(candidate)) {
        if (result.replaced.length > 0) applyPlan(candidate, result.document)
        return result
      }
      const cleaned = stripObsoleteNotifaiPluginEnablement(result.document)
      // The command rules were granted for this wiring; they leave with it.
      const rules = removeClaudeCommandRules(cleaned.document)
      if (result.replaced.length > 0 || cleaned.removed.length > 0 || rules.changed) {
        applyPlan(candidate, rules.document)
      }
      return result
    }
    const result = withTargetFileLock(candidate, strip)
    if (result.replaced.length > 0) removed.push({ file: candidate, events: result.replaced })
  }
  return { existing, removed }
}

export function hooksUninstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  if (harness === 'hermes') {
    try {
      deps.io.out(uninstallHermesPlugin(deps.env)
        ? 'Removed the Notifai Hermes plugin through Hermes.'
        : 'No Notifai Hermes plugin is installed.')
      return EXIT.ok
    } catch (err) {
      deps.io.err(`Could not remove Hermes plugin: ${String(err)}`)
      return EXIT.failed
    }
  }
  const scriptPath = flags.scriptPath ?? process.argv[1] ?? 'notifai'
  const codexPaths =
    harness === 'codex' ? codexMachineLayerPaths(deps.env, deps.hookPlatform) : null
  const file = codexPaths?.configToml ?? settingsFile(harness, deps.env, deps.hookPlatform)
  try {
    if (harness === 'openclaw') {
      const configFile = openclawConfigPath(deps.env, deps.hookPlatform)
      if (existsSync(configFile)) {
        assertOwnedRegularFile(configFile)
        parseOpenclawConfig(readFileSync(configFile, 'utf8'), configFile)
      }
    }
    if (harness === 'grok') {
      for (const candidate of machineHookFiles(harness, deps.env, deps.hookPlatform)) {
        const outcome = withTargetFileLock(candidate, () => {
          if (!existsSync(candidate)) return 'absent' as const
          assertOwnedRegularFile(candidate)
          if (!isOurGrokHookFile(readFileSync(candidate, 'utf8'))) return 'foreign' as const
          rmSync(candidate, { force: true })
          return 'removed' as const
        })
        if (outcome === 'removed') deps.io.out(`Removed the Notifai Grok hooks at ${candidate}`)
        else if (outcome === 'foreign') deps.io.out(`Left ${candidate} alone: Notifai did not write it.`)
      }
    } else if (harness === 'opencode' || harness === 'openclaw') {
      const outcome = removeNotifaiPluginFile(harness, file)
      if (harness === 'openclaw' && outcome !== 'foreign') {
          editOpenclawConfig(deps, (source, configFile) =>
            removeOpenclawNotifaiConfigText(source, configFile, path.dirname(file)),
          )
      }
      if (outcome === 'removed') {
        deps.io.out(`Removed the Notifai ${HARNESS_LABELS[harness]} plugin at ${file}`)
      } else if (outcome === 'foreign') {
        deps.io.out(`Left ${file} alone: Notifai did not write it.`)
      } else {
        deps.io.out(`Nothing to remove: ${file} does not exist.`)
      }
    } else if (harness === 'cursor') {
      const result = stripNotifaiHandlers([file], scriptPath, true)
      if (result.existing.length === 0) {
        deps.io.out(`Nothing to remove: ${file} does not exist.`)
      } else if (result.removed.length > 0) {
        for (const entry of result.removed) {
          deps.io.out(`Removed Notifai hooks (${entry.events.join(', ')}) from ${entry.file}`)
        }
      } else {
        deps.io.out(`No Notifai hooks found in ${file}`)
      }
    } else {
      const files = machineHookFiles(harness, deps.env, deps.hookPlatform)
      const result =
        codexPaths === null
          ? stripNotifaiHandlers(files, scriptPath, false)
          : withCodexLayerTransaction(codexPaths, (inspection) => {
              const cleanup = prepareCodexPluginCleanup(inspection.paths.configToml)
              const existing = files.filter((candidate) => existsSync(candidate))
              const plans = existing.map((candidate) => {
                const source = candidate === inspection.paths.configToml ? cleanup.source : undefined
                const document = source === undefined ? loadSettings(candidate)
                  : source === null ? {} : parseToml(source) as SettingsDocument
                const result = removeHooks(document, scriptPath)
                return {
                  file: candidate,
                  events: result.replaced,
                  apply: result.replaced.length === 0 ? () => {} : preparePlan(candidate, result.document, source),
                }
              })
              cleanup.apply()
              for (const plan of plans) plan.apply()
              cleanupEmptiedCodexLayer(inspection.paths)
              return { existing, removed: plans.filter((plan) => plan.events.length > 0) }
            })
      if (result.existing.length === 0) {
        deps.io.out(`Nothing to remove: ${file} does not exist.`)
      } else if (result.removed.length > 0) {
        for (const entry of result.removed) {
          deps.io.out(`Removed Notifai hooks (${entry.events.join(', ')}) from ${entry.file}`)
        }
      } else {
        deps.io.out(`No Notifai hooks found in ${result.existing.join(', ')}`)
      }
    }
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  // Uninstall means no Notifai lifecycle wiring is left anywhere this Project
  // can reach, not just in the one file the Machine installation used.
  removeLegacyProjectInstallations(deps, harness, scriptPath)
  const leftoverPlugin = findObsoleteNotifaiPluginWiring(deps.env, deps.hookPlatform).filter(
    (entry) => entry.harness === harness,
  )
  if (leftoverPlugin.length > 0) {
    deps.io.err(
      leftoverPlugin
        .map(
          (entry) =>
            `Obsolete native plugin wiring still enabled (${entry.keys.join(', ')}) in ${entry.file}; document hooks and a leftover plugin must never both fire. Uninstall is not complete while that plugin remains. Disable that Notifai plugin and rerun \`notifai hooks uninstall --harness ${entry.harness}\`.`,
        )
        .join('\n'),
    )
    return EXIT.failed
  }
  return EXIT.ok
}

/**
 * Remove Notifai's own Project-scoped definitions discoverable from this
 * Project. Foreign handlers sharing those files are never touched, and a file
 * Notifai did not write is never deleted.
 */
export function removeLegacyProjectInstallations(
  deps: CommandDeps,
  harness: HookInstallableHarness,
  scriptPath: string,
): void {
  const legacy = findLegacyProjectInstallations(
    deps.cwd,
    deps.env,
    deps.hookAdapterHome,
    deps.hookPlatform,
  ).filter((installation) => installation.harness === harness)
  if (legacy.length === 0) return
  try {
    if (harness === 'opencode' || harness === 'openclaw') {
      for (const installation of legacy) {
        if (removeNotifaiPluginFile(harness, installation.file) !== 'removed') continue
        if (harness === 'openclaw') {
          editOpenclawConfig(deps, (source, configFile) =>
            removeOpenclawLoadPathConfigText(source, configFile, path.dirname(installation.file)),
          )
        }
        deps.io.out(
          `Removed the leftover Project-scoped Notifai ${HARNESS_LABELS[harness]} plugin at ${installation.file}`,
        )
      }
      return
    }
    const files = legacy.map((installation) => installation.file)
    const result = stripNotifaiHandlers(files, scriptPath, harness === 'cursor')
    for (const entry of result.removed) {
      deps.io.out(
        `Removed leftover Project-scoped Notifai hooks (${entry.events.join(', ')}) from ${entry.file}`,
      )
    }
    if (harness === 'codex') {
      for (const paths of codexLegacyProjectLayers(deps.cwd)) cleanupEmptiedCodexLayer(paths)
    }
  } catch (err) {
    deps.io.err(`Could not remove leftover Project-scoped ${harness} hooks: ${String(err)}`)
  }
}

function assertOwnedRegularFile(file: string): void {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${file} is not a regular file; refusing to read or replace it.`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${file} is owned by uid ${stat.uid}, not the current user.`)
  }
}

function resolveHarness(deps: CommandDeps, requested: string | undefined): HookInstallableHarness | null {
  if (requested !== undefined) {
    if ((HOOK_INSTALLABLE_HARNESSES as readonly string[]).includes(requested)) return requested as HookInstallableHarness
    deps.io.err(
      `Unknown harness "${requested}". Supported: ${HOOK_INSTALLABLE_HARNESSES.join(', ')}.`,
    )
    return null
  }
  const detected = detectHarness(deps.cwd, deps.env)
  if (!detected) {
    deps.io.err(`Could not tell which harness to install for — pass --harness <${HOOK_INSTALLABLE_HARNESSES.join('|')}>.`)
    return null
  }
  return detected
}

/**
 * Which harnesses to wire. An explicit `--harness` still wins as a singleton.
 * Otherwise: every detected harness, or a human picker when detection is empty
 * or names more than one.
 */
export async function pickHarnessesToInstall(
  deps: CommandDeps,
  requested?: string,
): Promise<HookInstallableHarness[] | null> {
  if (requested !== undefined) {
    const harness = resolveHarness(deps, requested)
    return harness === null ? null : [harness]
  }
  const detected = detectedHarnesses(deps.cwd, deps.env)
  if (detected.length === 1) return detected
  if (deps.io.interactive === true && deps.io.multiselect) {
    const picked = await deps.io.multiselect(
      'Which agent harnesses should Notifai wire here?',
      HOOK_INSTALLABLE_HARNESSES.map((name) => ({
        value: name,
        label: HARNESS_LABELS[name],
        ...(detected.includes(name) ? { hint: 'detected on this machine' } : {}),
      })),
      detected,
    )
    if (picked === null) return null
    const unknown = picked.filter((name) => !(HOOK_INSTALLABLE_HARNESSES as readonly string[]).includes(name))
    if (unknown.length > 0) {
      deps.io.err(`Unknown harness "${unknown[0]}". Supported: ${HOOK_INSTALLABLE_HARNESSES.join(', ')}.`)
      return null
    }
    return picked as HookInstallableHarness[]
  }
  if (detected.length === 0) {
    deps.io.err(
      `Could not tell which harness to wire. Run: notifai hooks install --harness <${HOOK_INSTALLABLE_HARNESSES.join('|')}>`,
    )
    return null
  }
  return detected
}
