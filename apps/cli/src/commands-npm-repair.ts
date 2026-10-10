import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { EXIT, type CommandDeps } from './commands-core.js'
import { buildIdentity, Distribution } from './distribution.js'
import { RELEASE_PUBLIC_KEYS } from './release-trust.js'
import { managedInstallation } from './native-installation.js'
import { resolveHookAdapterHome } from './hook-adapter.js'
import { nativeInstallationIdentity } from './native-installation-identity.js'
import { installationAccess, npmAdapterWindowsAccess } from './installation-access.js'
import { completeNpmReplacement, inspectNpmReplacement, npmReplacementConfirmation, npmReplacementEnvironment, prepareNpmReplacement, replaceNpmPackage, verifyCompletedNpmPackage, type NpmReplacementContext } from './npm-replacement.js'
import { inspectWindowsNpmManager, type WindowsNpmManager } from './windows-npm-manager.js'
import { assertNpmMaintenanceQuiet, assertNpmScopeDirectories, captureNpmMaintenanceScope, inspectWindowsNpmReaders, type NpmMaintenanceScope } from './windows-npm-maintenance.js'
import { RuntimeRetention } from './runtime-retention.js'
import { currentProcessIdentity, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { sameLocalPath } from './local-path.js'
import type { NativeInstallFlags } from './commands-native-installation.js'

interface PreparedScope {
  schema: 1
  app: NpmMaintenanceScope
  manager: WindowsNpmManager
  native: { id: string; build: string; generation: number; channel: 'stable' | 'beta' }
  candidate: { build: string; inventory_sha256: string }
}

function textFile(file: string, limit: number): string {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Repair input must be a bounded regular file')
  return readFileSync(file, 'utf8')
}

/** Explicit, agent-run repair. Approval names the prepared operation; fresh
 * observations, not the approval flag, decide whether npm may run. No hook,
 * send, doctor or integration-resume path starts a manager operation. */
export async function npmRepairCommand(deps: CommandDeps, flags: NativeInstallFlags): Promise<number> {
  const emit = (value: Record<string, unknown>, message: string) => deps.io.out(flags.json || !deps.io.interactive ? JSON.stringify(value, null, 2) : message)
  let operation: string | undefined
  try {
    if (process.platform !== 'win32' || !flags.migrateNpm || (flags.prepare === true) === (flags.resume !== undefined) ||
        flags.upgrade || flags.channel !== undefined || flags.version !== undefined ||
        flags.prepare && (!flags.scope || !flags.node || !flags.artifact || flags.confirm) ||
        flags.resume && (!flags.confirm || flags.scope || flags.node || flags.artifact)) {
      throw new Error('Use install --migrate-npm --prepare --scope <observation.json> --node <node.exe> --artifact <adapter.tgz>, or --resume <operation> --confirm <digest>')
    }
    const build = buildIdentity()
    if (!build || build.sourceDirty) throw new Error('Use the verified standalone repair candidate')
    const installation = managedInstallation(deps), before = installation.inspect()
    if (!before.active || !before.channel || before.uninstall_pending && !before.bootstrap_pending || flags.prepare && before.pending) throw new Error('Finish the pending native operation before preparing npm repair')
    const home = resolveHookAdapterHome(deps.hookAdapterHome, deps.env, 'win32')
    const root = path.join(home, '.notifai'), launcher = path.join(path.dirname(process.execPath), 'notifai.exe')
    const access = installationAccess(launcher), distribution = new Distribution(RELEASE_PUBLIC_KEYS, deps.fetchImpl)
    const native = nativeInstallationIdentity(home)
    let prepared: PreparedScope
    const context: NpmReplacementContext = {
      installationRoot: root, launcher, access, distribution, packageAccess: npmAdapterWindowsAccess(launcher), env: deps.env,
      verifyEnvironment(prefix, node, npm) {
        assertNpmScopeDirectories(prepared.app)
        const manager = inspectWindowsNpmManager(node)
        if (!sameLocalPath(prefix, prepared.app.prefix.path, 'win32') ||
            !sameLocalPath(node, prepared.manager.node, 'win32') || !sameLocalPath(npm, prepared.manager.npm, 'win32') ||
            !sameLocalPath(manager.node, prepared.manager.node, 'win32') || !sameLocalPath(manager.npm, prepared.manager.npm, 'win32') ||
            manager.version !== prepared.manager.version || manager.sha256 !== prepared.manager.sha256) throw new Error('The prepared npm toolchain changed')
        const now = installation.inspect(), current = installation.activeRelease(now.active?.generation)
        if (now.pending || now.uninstall_pending || now.channel !== prepared.native.channel ||
            nativeInstallationIdentity(home).installationId !== prepared.native.id ||
            current.build !== prepared.native.build && current.build !== prepared.candidate.build ||
            current.build === prepared.native.build && current.generation !== prepared.native.generation) throw new Error('The assessed native installation changed')
        installation.assertForwardTransition(prepared.candidate.build, current.generation, prepared.native.channel)
        const report = JSON.parse(execFileSync(current.launcher, ['self-check', '--json'], {
          env: deps.env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        })) as { ok?: boolean; capabilities?: { npm_adapter_routes?: number } }
        if (!report.ok || report.capabilities?.npm_adapter_routes !== 1) throw new Error('The existing native runtime cannot serve the npm launcher')
      },
    }
    if (flags.prepare) {
      const active = installation.activeRelease(before.active.generation)
      const app = captureNpmMaintenanceScope(JSON.parse(textFile(path.resolve(flags.scope!), 8192)))
      // Read-only scope admission; a busy preparation is fine, uncertain
      // process/storage visibility is not an executable repair plan.
      if (inspectWindowsNpmReaders(app).uncertain) throw new Error('The relevant process population cannot be inspected in this scope')
      const manager = inspectWindowsNpmManager(path.resolve(flags.node!))
      const directory = path.resolve(flags.directory ?? path.dirname(process.execPath))
      const signedInventory = textFile(path.resolve(flags.inventory ?? path.join(directory, 'inventory.json')), 256 * 1024)
      // Stage the exact paired runtime before asking for a pause. Installation
      // authenticates every byte; this step does not activate it.
      const candidate = installation.stage({ directory, signedInventory })
      installation.assertForwardTransition(candidate, active.generation, before.channel)
      const { createHash } = await import('node:crypto')
      prepared = { schema: 1, app, manager, native: { id: native.installationId, build: active.build,
        generation: active.generation, channel: before.channel },
      candidate: { build: candidate, inventory_sha256: createHash('sha256').update(signedInventory).digest('hex') } }
      const result = await prepareNpmReplacement({ prefix: app.prefix.path, node: manager.node, npm: manager.npm,
        artifact: path.resolve(flags.artifact!), signedInventory, scope: JSON.stringify(prepared) }, context)
      operation = result.directory
      const receipt = inspectNpmReplacement(operation, context)
      emit({ ok: true, code: 'npm_repair_prepared', operation, confirmation: npmReplacementConfirmation(receipt),
        version: receipt.target.version, dependency_files: result.dependency_files, scope: app.observation,
        next_step: 'Your agent must obtain approval for this exact replacement, observe the named producers and possible JavaScript readers stopped, and keep them stopped through runtime activation and command verification. Preparation is not evidence of a safe window.' },
      'Repair is prepared and the original package is preserved. Your agent can now arrange the scoped pause and resume this operation.')
      return EXIT.ok
    }
    operation = path.resolve(flags.resume!)
    const receipt = inspectNpmReplacement(operation, context)
    if (flags.confirm !== npmReplacementConfirmation(receipt)) throw new Error('Confirmation must name the exact prepared scope, artifact and dependency replacement')
    if (receipt.phase === 'complete') {
      emit({ ok: true, code: 'npm_repair_already_complete', operation, completed_version: receipt.target.version }, 'This scoped repair already completed. No package or runtime was changed.')
      return EXIT.ok
    }
    prepared = JSON.parse(receipt.scope) as PreparedScope
    if (prepared.schema !== 1 || !prepared.native || !prepared.manager || !prepared.candidate ||
        !/^[a-f0-9]{64}$/.test(prepared.candidate.build) || !/^[a-f0-9]{64}$/.test(prepared.candidate.inventory_sha256) ||
        receipt.target.inventory_sha256 !== prepared.candidate.inventory_sha256) throw new Error('Uncertain prepared npm repair policy')
    const coordinator = currentProcessIdentity()
    if (!coordinator) throw new Error('Repair coordinator identity is unavailable')
    const quiet = (scope: string, _dependencies: number, manager?: ProcessIdentity): undefined => {
      if (scope !== receipt.scope) throw new Error('Maintenance scope changed')
      assertNpmScopeDirectories(prepared.app)
      const retention = new RuntimeRetention(root, prepared.native.id, access)
      assertNpmMaintenanceQuiet({ scope: prepared.app, census: inspectWindowsNpmReaders(prepared.app, manager), coordinator,
        ...(manager ? { manager } : {}), owners: prepared.app.states.map(state => retention.inspectOwners(path.join(state.path, 'sessions'))),
        liveness: processIdentityLiveness })
    }
    if (receipt.phase === 'package_verified') verifyCompletedNpmPackage(operation, context)
    else {
      const result = await replaceNpmPackage(operation, context, quiet)
      if (result.failure || result.exit_code !== 0) throw new Error(result.failure ?? 'Npm replacement did not finish; maintain the pause and resume the recorded operation')
    }
    // No new target selection and no reopening producers between replacing the
    // package and activating its paired runtime. Recovery repeats this boundary.
    quiet(receipt.scope, 0)
    const now = installation.inspect()
    if (nativeInstallationIdentity(home).installationId !== prepared.native.id || now.channel !== prepared.native.channel ||
        now.active?.active !== prepared.native.build && now.active?.active !== prepared.candidate.build) throw new Error('The assessed native installation changed')
    const directory = path.join(root, 'versions', prepared.candidate.build)
    const signedInventory = textFile(path.join(directory, 'inventory.json'), 256 * 1024)
    const { createHash } = await import('node:crypto')
    if (createHash('sha256').update(signedInventory).digest('hex') !== prepared.candidate.inventory_sha256) throw new Error('The paired runtime inventory changed')
    const activation = installation.installCandidate({ directory, signedInventory, source: now.source!, channel: prepared.native.channel,
      version: receipt.target.version, upgrade: true })
    if (activation.launcher_update_pending) throw new Error('The package is verified but native launcher repair remains pending; keep the scoped pause')
    const entry = path.join(receipt.prefix, 'node_modules', '@raidiant', 'notifai', 'bin', 'notifai.mjs')
    context.verifyEnvironment(receipt.prefix, receipt.node.file, receipt.npm.file)
    const probe = JSON.parse(execFileSync(prepared.manager.node, [entry, 'self-check', '--json'], {
      env: npmReplacementEnvironment(operation, deps.env), encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })) as { ok?: boolean; build?: { version?: string } }
    if (!probe.ok || probe.build?.version !== receipt.target.version) throw new Error('The replacement route did not verify the selected native runtime')
    completeNpmReplacement(operation, context)
    emit({ ok: true, code: 'npm_repair_complete', operation, version: receipt.target.version,
      package_verified: true, runtime_active: true, command_verified: true,
      next_step: 'The paused producers may reopen. Run their ordinary command and repair only changed owned harness integration with notifai update --resume --json.' },
    'The npm command now reaches the verified native runtime. The paused apps may reopen.')
    return EXIT.ok
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ ok: false, code: 'npm_repair_pending', ...(operation ? { operation } : {}), message,
      next_step: 'Your agent must resolve the named observation or maintenance condition, then resume the same prepared operation. Keep any approved pause in place until command verification succeeds.' }, message)
    return EXIT.failed
  }
}
