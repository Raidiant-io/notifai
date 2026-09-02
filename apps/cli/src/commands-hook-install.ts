/** Hook installation and uninstallation across supported harnesses. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from 'node:fs'
import path from 'node:path'
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
import { HOOK_EVENTS, requiredHookEvents } from './hook-events.js'
import {
  NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
  applyPlan,
  buildCursorHookConfig,
  buildHookConfig,
  cleanupEmptiedCodexLayer,
  codexCoexistenceNotes,
  codexHomeNote,
  codexLayerDir,
  codexLayerPaths,
  codexRepresentationProblems,
  detectHarness,
  detectedHarnesses,
  findInstallations,
  handlerEvent,
  hookDefinitionFiles,
  loadCursorSettings,
  loadSettings,
  mergeCursorHooks,
  mergeHooks,
  removeCursorHooks,
  removeHooks,
  settingsFile,
  withCodexLayerTransaction,
} from './install-hooks.js'
import {
  OPENCLAW_PLUGIN_MANIFEST,
  OPENCLAW_PLUGIN_PACKAGE,
  isOurOpenclawPlugin,
  mergeOpenclawNotifaiEntry,
  openclawConfigPath,
  openclawPluginManifest,
  openclawPluginPackage,
  openclawPluginSource,
  parseOpenclawConfig,
  removeOpenclawNotifaiEntry,
} from './openclaw-plugin.js'
import { isOurOpencodePlugin, opencodePluginSource } from './opencode-plugin.js'
import { packageVersion } from './release.js'
export interface HooksInstallFlags {
  harness?: string
  global?: boolean
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
  if (target === undefined || isNpxAdapterTarget(target)) return undefined
  return target
}

function resolveHookAdapterTarget(deps: CommandDeps, flags: HooksInstallFlags): HookAdapterTarget {
  if (deps.hookInstallTarget !== undefined && isNpxAdapterTarget(deps.hookInstallTarget)) {
    return deps.hookInstallTarget
  }
  const fileTarget = fileHookInstallTarget(deps.hookInstallTarget)
  const execPath = flags.execPath ?? fileTarget?.execPath ?? process.execPath
  const scriptPath = flags.scriptPath ?? fileTarget?.scriptPath ?? process.argv[1] ?? 'notifai'
  if (runningViaNpx(deps.env, scriptPath)) {
    const version = packageVersion()
    const npmCli = deps.env['npm_execpath']
    if (version === null) {
      throw new Error(
        'Could not read this CLI version, so an npx hook target cannot be pinned. Install `@raidiant/notifai` globally and rerun `notifai hooks install`.',
      )
    }
    if (typeof npmCli !== 'string' || npmCli === '') {
      throw new Error(
        'This process looks like npx but npm_execpath is missing. Install `@raidiant/notifai` globally and rerun `notifai hooks install`.',
      )
    }
    return { kind: 'npx', execPath, npmCli, spec: `@raidiant/notifai@${version}` }
  }
  return { execPath, scriptPath }
}

function printHooksInstallClose(deps: CommandDeps, harness: HookInstallableHarness, file: string): void {
  const label = HARNESS_LABELS[harness]
  const activation =
    harness === 'codex'
      ? 'Approve the Notifai handlers in `/hooks` if Codex asks, then start one fresh Codex session, send one prompt, and run `notifai doctor`.'
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
  const adapterTarget = resolveHookAdapterTarget(deps, flags)
  const scriptPath =
    flags.scriptPath ?? fileHookInstallTarget(adapterTarget)?.scriptPath ?? process.argv[1] ?? 'notifai'
  const hookPlatform = deps.hookPlatform ?? process.platform
  const nodePath = adapterTarget.execPath
  let adapterPath: string
  try {
    adapterPath = installHookAdapter(adapterTarget, deps.hookAdapterHome, hookPlatform).path
  } catch (err) {
    deps.io.err(`Could not prepare the stable hook adapter: ${String(err)}`)
    return EXIT.failed
  }
  const wantGlobal = flags.global === true
  const existing = findInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform).filter(
    (installation) => installation.harness === harness,
  )
  const otherScope = existing.filter((installation) => installation.global !== wantGlobal)
  if (!wantGlobal && otherScope.some((installation) => installation.global)) {
    const globalInstallations = otherScope.filter((installation) => installation.global)
    const globalInstallation = globalInstallations[0]
    const installedEvents = new Set(
      globalInstallation?.handlers
        .map((handler) => handlerEvent(handler.command))
        .filter((event): event is HookEvent =>
          event !== null && (HOOK_EVENTS as readonly string[]).includes(event),
        ) ?? [],
    )
    if (
      globalInstallations.length !== 1 ||
      globalInstallations.some((installation) => (installation.problems?.length ?? 0) > 0) ||
      globalInstallations.some(
        (installation) => stopShapeProblems(installation, deps.hookPlatform).length > 0,
      ) ||
      !requiredHookEvents(harness).every((event) => installedEvents.has(event))
    ) {
      return hooksInstallCommand(deps, { ...flags, global: true, harness })
    }
    const globalFile = globalInstallation?.file
    if (flags.narrate !== false) {
      deps.io.out(
        `${HARNESS_LABELS[harness]} hooks already cover this machine (${globalFile}). This project does not need its own copy. To wire only this project: notifai hooks uninstall --harness ${harness} --global && notifai hooks install --harness ${harness}`,
      )
    }
    return EXIT.ok
  }
  if (wantGlobal && otherScope.some((installation) => !installation.global)) {
    if (hooksUninstallCommand(deps, { ...flags, global: false, harness }) !== EXIT.ok) {
      return EXIT.failed
    }
  }
  const codexPaths =
    harness === 'codex'
      ? codexLayerPaths(wantGlobal, deps.cwd, deps.env, hookPlatform)
      : null
  const settingsTarget =
    codexPaths?.configToml ?? settingsFile(harness, wantGlobal, deps.cwd, deps.env, hookPlatform)

  // OpenCode's adapter is a generated plugin module rather than a handler
  // merged into a settings document, so it owns the whole file.
  if (harness === 'opencode') {
    return installOpencodePlugin(deps, settingsTarget, {
      adapterPath,
      timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
      platform: hookPlatform,
      nodePath,
      ...(flags.narrate === undefined ? {} : { narrate: flags.narrate }),
    })
  }
  if (harness === 'openclaw') {
    return installOpenclawPlugin(deps, settingsTarget, {
      adapterPath,
      timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
      platform: hookPlatform,
      nodePath,
      global: wantGlobal,
      ...(flags.narrate === undefined ? {} : { narrate: flags.narrate }),
    })
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
            nodePath,
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
    if (flags.narrate !== false) printHooksInstallClose(deps, harness, settingsTarget)
    return EXIT.ok
  }

  const installInto = (file: string): { file: string; foreignStopCount: number } => {
    const document = loadSettings(file)
    const foreignStopCount = foreignStopHandlers(document).length
    const result = mergeHooks(
      document,
      buildHookConfig({
        adapterPath,
        harness,
        platform: hookPlatform,
        nodePath,
      }),
      scriptPath,
    )
    applyPlan(file, result.document)
    return { file, foreignStopCount }
  }

  let installed: { file: string; foreignStopCount: number }
  try {
    installed =
      codexPaths === null
        ? withTargetFileLock(settingsTarget, () => installInto(settingsTarget))
        : withCodexLayerTransaction(codexPaths, (inspection) => {
            const staleTarget =
              inspection.writeTarget === inspection.paths.hooksJson
                ? inspection.paths.configToml
                : inspection.paths.hooksJson
            const staleEvents =
              staleTarget === inspection.paths.hooksJson
                ? inspection.ourJsonEvents
                : inspection.ourTomlEvents
            if (staleEvents.length > 0) {
              const staleDocument = loadSettings(staleTarget)
              const stripped = removeHooks(staleDocument, scriptPath)
              if (stripped.replaced.length > 0) applyPlan(staleTarget, stripped.document)
            }
            return installInto(inspection.writeTarget)
          })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }

  if (harness === 'codex') {
    const layer = flags.global ? null : codexLayerDir(deps.cwd)
    if (layer !== null) mkdirSync(layer, { recursive: true })
  }
  if (flags.narrate !== false) printHooksInstallClose(deps, harness, installed.file)
  if (installed.foreignStopCount > 0) {
    const label = HARNESS_LABELS[harness]
    deps.io.out(
      `This layer already has a Stop handler that Notifai does not own. ${label} may run it alongside Notifai's handler; Notifai preserves it but has not assessed its behavior.`,
    )
  }
  if (harness === 'codex') {
    for (const problem of codexRepresentationProblems(deps.cwd, deps.env, hookPlatform)) {
      deps.io.out(problem)
    }
    for (const note of codexCoexistenceNotes(deps.cwd, deps.env, hookPlatform)) {
      deps.io.out(note)
    }
    if (flags.global) {
      const home = codexHomeNote(deps.env, hookPlatform)
      if (home !== null) deps.io.out(home)
    }
  }
  return EXIT.ok
}

function foreignStopHandlers(document: { hooks?: Record<string, { hooks?: { command: string }[] }[]> }): { command: string }[] {
  const groups = document.hooks?.['Stop']
  if (!Array.isArray(groups)) return []
  return groups
    .flatMap((group) => group.hooks ?? [])
    .filter(
      (handler) =>
        !/ hook (session-start|subagent-start|activation-stop|user-prompt-submit|stop|session-end)\b/.test(
          handler.command,
        ),
    )
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
  if (options.narrate !== false) printHooksInstallClose(deps, 'opencode', file)
  return EXIT.ok
}

function installOpenclawPlugin(
  deps: CommandDeps,
  file: string,
  options: {
    adapterPath: string
    timeoutSeconds: number
    platform?: NodeJS.Platform
    nodePath?: string
    global: boolean
    narrate?: boolean
  },
): number {
  const pluginDir = path.dirname(file)
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
    writeOpenclawEnablement(deps, pluginDir, options.global)
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  if (options.narrate !== false) printHooksInstallClose(deps, 'openclaw', file)
  return EXIT.ok
}

function writeOpenclawEnablement(deps: CommandDeps, pluginDir: string, global: boolean): void {
  const configFile = openclawConfigPath(deps.env, deps.hookPlatform)
  withTargetFileLock(configFile, () => {
    let config: Record<string, unknown> = {}
    if (existsSync(configFile)) {
      assertOwnedRegularFile(configFile)
      config = parseOpenclawConfig(readFileSync(configFile, 'utf8'))
    }
    const merged = mergeOpenclawNotifaiEntry(config, pluginDir, global)
    atomicWriteFileSync(configFile, `${JSON.stringify(merged, null, 2)}\n`, {
      mode: 0o600,
      preserveMode: true,
      requireCurrentUserOwner: true,
    })
  })
}

function uninstallOpenclawPlugin(deps: CommandDeps, file: string): number {
  const pluginDir = path.dirname(file)
  try {
    const removed = withTargetFileLock(file, () => {
      if (!existsSync(file)) return false
      assertOwnedRegularFile(file)
      if (!isOurOpenclawPlugin(readFileSync(file, 'utf8'))) {
        deps.io.out(`Left ${file} alone: Notifai did not write it.`)
        return false
      }
      rmSync(file, { force: true })
      rmSync(path.join(pluginDir, OPENCLAW_PLUGIN_MANIFEST), { force: true })
      rmSync(path.join(pluginDir, OPENCLAW_PLUGIN_PACKAGE), { force: true })
      if (existsSync(pluginDir) && readdirSync(pluginDir).length === 0) {
        rmdirSync(pluginDir)
      }
      return true
    })
    if (removed) {
      const configFile = openclawConfigPath(deps.env, deps.hookPlatform)
      if (existsSync(configFile)) {
        withTargetFileLock(configFile, () => {
          assertOwnedRegularFile(configFile)
          const config = parseOpenclawConfig(readFileSync(configFile, 'utf8'))
          const next = removeOpenclawNotifaiEntry(config, pluginDir)
          atomicWriteFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, {
            mode: 0o600,
            preserveMode: true,
            requireCurrentUserOwner: true,
          })
        })
      }
      deps.io.out(`Removed the Notifai OpenClaw plugin at ${file}`)
    } else if (!existsSync(file)) {
      deps.io.out(`Nothing to remove: ${file} does not exist.`)
    }
    return EXIT.ok
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
}

export function hooksUninstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  const scriptPath = flags.scriptPath ?? process.argv[1] ?? 'notifai'
  const global = flags.global ?? false
  const codexPaths =
    harness === 'codex'
      ? codexLayerPaths(global, deps.cwd, deps.env, deps.hookPlatform)
      : null
  const file =
    codexPaths?.configToml ?? settingsFile(harness, global, deps.cwd, deps.env, deps.hookPlatform)
  if (harness === 'opencode') {
    try {
      return withTargetFileLock(file, () => {
        if (!existsSync(file)) {
          deps.io.out(`Nothing to remove: ${file} does not exist.`)
          return EXIT.ok
        }
        assertOwnedRegularFile(file)
        // We own the whole file, but only if we wrote it.
        if (!isOurOpencodePlugin(readFileSync(file, 'utf8'))) {
          deps.io.out(`Left ${file} alone: Notifai did not write it.`)
          return EXIT.ok
        }
        rmSync(file, { force: true })
        deps.io.out(`Removed the Notifai OpenCode plugin at ${file}`)
        return EXIT.ok
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
  }
  if (harness === 'openclaw') {
    return uninstallOpenclawPlugin(deps, file)
  }
  if (harness === 'cursor') {
    let stripped: ReturnType<typeof removeCursorHooks> | null
    try {
      stripped = withTargetFileLock(file, () => {
        if (!existsSync(file)) return null
        const document = loadCursorSettings(file)
        const result = removeCursorHooks(document, scriptPath)
        applyPlan(file, result.document)
        return result
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    if (stripped === null) {
      deps.io.out(`Nothing to remove: ${file} does not exist.`)
      return EXIT.ok
    }
    deps.io.out(
      stripped.replaced.length > 0
        ? `Removed Notifai hooks (${stripped.replaced.join(', ')}) from ${file}`
        : `No Notifai hooks found in ${file}`,
    )
    return EXIT.ok
  }
  const removeInstalledHooks = (): { existing: string[]; removedAny: boolean } => {
    const files =
      codexPaths === null
        ? hookDefinitionFiles(harness, global, deps.cwd, deps.env, deps.hookPlatform)
        : [codexPaths.hooksJson, codexPaths.configToml]
    const existing = files.filter((candidate) => existsSync(candidate))
    let removedAny = false
    for (const candidate of existing) {
      const removeFromCandidate = () => {
        const document = loadSettings(candidate)
        const result = removeHooks(document, scriptPath)
        if (result.replaced.length > 0) applyPlan(candidate, result.document)
        return result
      }
      const stripped =
        codexPaths === null
          ? withTargetFileLock(candidate, removeFromCandidate)
          : removeFromCandidate()
      if (stripped.replaced.length > 0) {
        removedAny = true
        deps.io.out(`Removed Notifai hooks (${stripped.replaced.join(', ')}) from ${candidate}`)
      }
    }
    return { existing, removedAny }
  }

  let result: { existing: string[]; removedAny: boolean }
  try {
    result =
      codexPaths === null
        ? removeInstalledHooks()
        : withCodexLayerTransaction(codexPaths, (inspection) => {
            const stripped = removeInstalledHooks()
            cleanupEmptiedCodexLayer(inspection.paths)
            return stripped
          })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  if (result.existing.length === 0) {
    deps.io.out(`Nothing to remove: ${file} does not exist.`)
    return EXIT.ok
  }
  if (!result.removedAny) {
    deps.io.out(`No Notifai hooks found in ${result.existing.join(', ')}`)
  }
  return EXIT.ok
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
