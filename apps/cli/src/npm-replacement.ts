import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { withFileLock } from './file-lock.js'
import type { InstallationAccess } from './installation-access.js'
import { inspectLegacyNpmPackage, snapshotLegacyNpmPackage, assertNpmReplacementState, type LegacyNpmPackage } from './legacy-npm-package.js'
import { prepareNpmAdapterArchive, type NpmReplacementTarget } from './npm-adapter-archive.js'
import { isSemVer } from './version.js'
import { canonicalPath } from './local-path.js'
import { inspectNpmAdapterRoute } from './npm-adapter-route.js'
import { verifyNpmAdapterArtifact, type NpmAdapterAccessCheck } from './npm-adapter-verification.js'
import { runNpmManager, type NpmManagerResult } from './npm-conversion-process.js'
import { currentProcessIdentity, normalizeProcessStart, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import type { Distribution } from './release-distribution.js'

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
interface FileProof { file: string; identity: string; sha256: string }
interface ReplacementReceipt {
  schema: 1
  token: string
  prefix: string
  snapshot_sha256: string
  target: NpmReplacementTarget
  node: FileProof
  npm: FileProof
  /** The agent names the assessed application, execution view and state root. */
  scope: string
  phase: 'prepared' | 'replacing' | 'package_verified'
  coordinator: ProcessIdentity | null
  manager: ProcessIdentity | null
  may_have_run: boolean
}
export interface NpmReplacementContext {
  /** Independently verified existing native installation, shared by every
   * agent-run repair in this account and execution domain. */
  installationRoot: string
  launcher: string
  access: InstallationAccess
  packageAccess: NpmAdapterAccessCheck
  distribution: Pick<Distribution, 'verifyInventory'>
  env: NodeJS.ProcessEnv
  signal?: AbortSignal | undefined
  /** Independently establish the absolute Node/npm distribution, dependencies,
   * physical prefix and existing native adapter support. Hashes below detect
   * changes to already trusted files; they do not establish that trust. */
  verifyEnvironment: (prefix: string, node: string, npm: string) => undefined
}
function operationDirectory(prefix: string, context: NpmReplacementContext): string {
  if (!path.isAbsolute(context.installationRoot)) throw new Error('Npm maintenance needs the verified native installation root')
  const stat = lstatSync(realpathSync(prefix), { bigint: true })
  if (!stat.isDirectory() || stat.ino <= 0n) throw new Error('Npm prefix identity is unavailable')
  return path.join(realpathSync(context.installationRoot), 'npm-maintenance', digest(`${stat.dev}:${stat.ino}`))
}
function fileProof(file: string): FileProof {
  file = realpathSync(file)
  const stat = lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.ino <= 0n || stat.size > 256n * 1024n * 1024n) throw new Error('Unverified npm manager file')
  return { file, identity: `${stat.dev}:${stat.ino}`, sha256: digest(readFileSync(file)) }
}
function assertFile(proof: FileProof) {
  if (JSON.stringify(fileProof(proof.file)) !== JSON.stringify(proof)) throw new Error('Prepared npm manager changed')
}
function synchronous(action: () => unknown): void {
  const result = action()
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {})
    throw new Error('Npm maintenance checks must complete synchronously')
  }
}
function tarball(directory: string, access: InstallationAccess, target: NpmReplacementTarget): string {
  const file = path.join(directory, 'adapter.tgz'), stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid prepared npm artifact')
  access.check(file, false)
  if (digest(readFileSync(file)) !== target.archive_sha256) throw new Error('Npm artifact does not match the pinned release')
  return file
}
function environment(directory: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }
  for (const key of Object.keys(result)) if (/^(node_|npm_|npm_config_|bun_)/i.test(key)) delete result[key]
  result['TEMP'] = result['TMP'] = path.join(directory, 'tmp')
  return result
}
function args(directory: string, prefix: string, npm: string): string[] {
  return [npm, 'install', '--global', '--prefix', prefix, '--cache', path.join(directory, 'cache'),
    '--userconfig', path.join(directory, 'user.npmrc'), '--globalconfig', path.join(directory, 'global.npmrc'),
    '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--update-notifier=false', '--loglevel=error', path.join(directory, 'adapter.tgz')]
}
function preserved(directory: string, original: LegacyNpmPackage, context: NpmReplacementContext): void {
  const root = path.join(directory, 'original')
  for (const folder of ['', 'shims', ...original.directories.map(item => path.join('package', item.path))]) {
    const file = path.join(root, folder), stat = lstatSync(file)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Npm preservation directory changed')
    context.access.check(file, true)
  }
  for (const [folder, files] of [['package', original.files], ['shims', original.shims]] as const) {
    for (const item of files) {
      const file = path.join(root, folder, item.path), stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) throw new Error('Preserved npm file changed')
      context.access.check(file, false)
      if (digest(readFileSync(file)) !== item.sha256) throw new Error('Preserved npm bytes changed')
    }
  }
}
function adapter(directory: string, context: NpmReplacementContext, target: NpmReplacementTarget) {
  const prefix = path.join(directory, 'prepared')
  const proof = verifyNpmAdapterArtifact(path.join(prefix, 'node_modules/@raidiant/notifai'), context.distribution, context.packageAccess)
  if (proof.manifest.adapter_version !== target.version || digest(proof.signedInventory) !== target.inventory_sha256 || !['notifai', 'notifai.cmd', 'notifai.ps1'].every(name =>
    inspectNpmAdapterRoute(path.join(prefix, name), proof, { platform: 'win32', checkAccess: context.packageAccess })?.kind === 'global')) {
    throw new Error('Prepared npm adapter or command routes are not verified')
  }
  return proof
}
function save(directory: string, receipt: ReplacementReceipt, context: NpmReplacementContext): void {
  atomicWriteFileSync(path.join(directory, 'operation.json'), `${JSON.stringify(receipt)}\n`, {
    requireCurrentUserOwner: true, prepareTemporary: context.access.beforePublish,
  })
}
function read(directory: string, context: NpmReplacementContext): ReplacementReceipt {
  context.access.check(directory, true)
  const file = path.join(directory, 'operation.json'), stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('Invalid npm maintenance receipt')
  context.access.check(file, false)
  const value = JSON.parse(readFileSync(file, 'utf8')) as ReplacementReceipt
  const identity = (item: ProcessIdentity | null) => item === null || Number.isSafeInteger(item?.pid) && item.pid > 0 &&
    typeof item.start === 'string' && /^windows-filetime:\d+$/.test(item.start)
  if (value?.schema !== 1 || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/.test(value.token) ||
      typeof value.prefix !== 'string' || !path.isAbsolute(value.prefix) || typeof value.scope !== 'string' || !value.scope.trim() || value.scope.length > 1024 ||
      !/^[a-f0-9]{64}$/.test(value.snapshot_sha256) || !value.target || typeof value.target.version !== 'string' || !isSemVer(value.target.version) ||
      !/^[a-f0-9]{64}$/.test(value.target.inventory_sha256) || !/^[a-f0-9]{64}$/.test(value.target.archive_sha256) ||
      !['prepared', 'replacing', 'package_verified'].includes(value.phase) || typeof value.may_have_run !== 'boolean' ||
      !identity(value.coordinator) || !identity(value.manager) ||
      ![value.node, value.npm].every(item => item && typeof item.file === 'string' && path.isAbsolute(item.file) &&
        typeof item.identity === 'string' && /^\d+:\d+$/.test(item.identity) && /^[a-f0-9]{64}$/.test(item.sha256))) {
    throw new Error('Invalid npm maintenance receipt')
  }
  return value
}

/** Agent-run preparation, before the approved app pause. The caller supplies
 * independently trusted manager files and establishes the affected app view.
 * No legacy package file changes here and no preparation result proves idle. */
export async function prepareNpmReplacement(input: { prefix: string; node: string; npm: string;
  artifact: string; signedInventory: string; scope: string }, context: NpmReplacementContext): Promise<{ directory: string; dependency_files: number }> {
  if (process.platform !== 'win32' || ![input.prefix, input.node, input.npm, input.artifact].every(file => path.isAbsolute(file)) ||
      !input.scope.trim() || input.scope.length > 1024) throw new Error('Invalid Windows npm maintenance preparation')
  const prefix = realpathSync(input.prefix), directory = canonicalPath(operationDirectory(prefix, context))
  const relative = path.relative(prefix, directory)
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Prepare npm maintenance outside the npm prefix')
  try { lstatSync(directory); throw new Error('Npm maintenance directory already exists') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  synchronous(() => context.verifyEnvironment(prefix, input.node, input.npm))
  const node = fileProof(input.node), npm = fileProof(input.npm)
  const original = inspectLegacyNpmPackage(prefix, context.packageAccess)
  // A second preparer can pass the early absence check during assessment.
  // Reserve once, under the existing short installation lock, before writing.
  withFileLock(path.join(context.installationRoot, 'installation.lock'), () => {
    try { lstatSync(directory); throw new Error('Npm maintenance directory already exists') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    context.access.directory(directory)
  }, { waitMs: 5000, strictRelease: true })
  // Incomplete preparation stays outside the live prefix for inspection. It
  // cannot be executed: operation.json is published only after all checks.
  for (const child of ['tmp', 'cache', 'prepared']) context.access.directory(path.join(directory, child))
  const artifact = path.join(directory, 'adapter.tgz')
  const source = lstatSync(input.artifact)
  if (!source.isFile() || source.isSymbolicLink() || source.size > 16 * 1024 * 1024) throw new Error('Invalid npm artifact source')
  const prepared = await prepareNpmAdapterArchive(readFileSync(input.artifact), input.signedInventory, context.distribution)
  atomicWriteFileSync(artifact, prepared.bytes, { requireCurrentUserOwner: true, prepareTemporary: context.access.beforePublish })
  tarball(directory, context.access, prepared.target)
  for (const name of ['user.npmrc', 'global.npmrc']) atomicWriteFileSync(path.join(directory, name), '', {
    requireCurrentUserOwner: true, prepareTemporary: context.access.beforePublish,
  })
  const snapshot = snapshotLegacyNpmPackage(original, path.join(directory, 'original'), context.access)
  const result = await runNpmManager({ launcher: context.launcher, executable: node.file,
    signal: context.signal,
    args: args(directory, path.join(directory, 'prepared'), npm.file), cwd: directory, env: environment(directory, context.env),
    admit() { assertFile(node); assertFile(npm); synchronous(() => context.verifyEnvironment(prefix, node.file, npm.file)) } })
  if (result.failure || result.exit_code !== 0) throw new Error('Npm adapter preparation failed; the legacy package was preserved')
  adapter(directory, context, prepared.target)
  save(directory, { schema: 1, token: randomUUID(), prefix, snapshot_sha256: snapshot,
    target: prepared.target, node, npm, scope: input.scope,
    phase: 'prepared', coordinator: null, manager: null, may_have_run: false }, context)
  return { directory, dependency_files: original.dependency_files }
}

/** Execute or repair forward under the same cooperative maintenance scope.
 * This internal API deliberately requires an observing policy, not an idle
 * flag. The agent obtains the exact pause and dependency-replacement approval;
 * verifyMaintenance must observe the assessed state root and process census
 * anew before each GO. No package success claims runtime or hook completion. */
export async function replaceNpmPackage(directory: string, context: NpmReplacementContext,
  verifyMaintenance: (scope: string, dependencyFiles: number) => undefined): Promise<NpmManagerResult> {
  if (process.platform !== 'win32' || !path.isAbsolute(directory)) throw new Error('Windows npm maintenance requires an absolute operation directory')
  directory = realpathSync(directory)
  const coordinator = currentProcessIdentity()
  const start = coordinator && normalizeProcessStart(coordinator.start)
  if (!coordinator || !start || !/^\d+$/.test(start)) throw new Error('Npm maintenance coordinator identity is unavailable')
  const owner = { pid: coordinator.pid, start: `windows-filetime:${start}` }
  const lock = path.join(directory, 'operation.lock')
  const receipt = withFileLock(lock, () => {
    const receipt = read(directory, context)
    if (canonicalPath(operationDirectory(receipt.prefix, context)) !== directory) throw new Error('Npm operation is outside its canonical prefix slot')
    for (const process of [receipt.coordinator, receipt.manager]) if (process && processIdentityLiveness(process) !== 'gone') throw new Error('The previous npm operation has not been proved stopped')
    receipt.coordinator = owner
    save(directory, receipt, context)
    return receipt
  }, { waitMs: 5000, strictRelease: true })
  // The receipt remains on every error, including before GO. Never infer a
  // complete multi-file manager operation from a zero exit code alone.
  try {
    const originalFile = path.join(directory, 'original/snapshot.json')
    context.access.check(originalFile, false)
    if (lstatSync(originalFile).size > 4 * 1024 * 1024) throw new Error('Npm preservation metadata exceeds its bounds')
    const bytes = readFileSync(originalFile)
    if (digest(bytes) !== receipt.snapshot_sha256) throw new Error('Npm preservation metadata changed')
    const original = JSON.parse(bytes.toString('utf8')) as LegacyNpmPackage
    if (original.prefix !== receipt.prefix || original.directory !== path.join(receipt.prefix, 'node_modules/@raidiant/notifai')) throw new Error('Npm preservation scope changed')
    const replacement = adapter(directory, context, receipt.target)
    tarball(directory, context.access, receipt.target)
    for (const name of ['user.npmrc', 'global.npmrc']) {
      context.access.check(path.join(directory, name), false)
      if (readFileSync(path.join(directory, name)).length) throw new Error('Prepared npm configuration changed')
    }
    preserved(directory, original, context)
    assertFile(receipt.node); assertFile(receipt.npm)
    synchronous(() => context.verifyEnvironment(receipt.prefix, receipt.node.file, receipt.npm.file))
    synchronous(() => verifyMaintenance(receipt.scope, original.dependency_files))
    const recovering = receipt.may_have_run
    return await runNpmManager({ launcher: context.launcher, executable: receipt.node.file,
      signal: context.signal,
      args: args(directory, receipt.prefix, receipt.npm.file), cwd: directory, env: environment(directory, context.env),
      admit(manager) {
        receipt.manager = manager
        receipt.phase = 'replacing'
        // Write before GO; interruption from this point must assume npm ran.
        receipt.may_have_run = true
        save(directory, receipt, context)
        assertFile(receipt.node); assertFile(receipt.npm)
        synchronous(() => context.verifyEnvironment(receipt.prefix, receipt.node.file, receipt.npm.file))
        synchronous(() => verifyMaintenance(receipt.scope, original.dependency_files))
        assertNpmReplacementState(original, replacement, recovering, context.packageAccess)
        tarball(directory, context.access, receipt.target)
        for (const name of ['user.npmrc', 'global.npmrc']) {
          context.access.check(path.join(directory, name), false)
          if (readFileSync(path.join(directory, name)).length) throw new Error('Prepared npm configuration changed')
        }
      },
    }).then(result => {
      if (result.failure || result.exit_code !== 0) return result
      const installed = verifyNpmAdapterArtifact(original.directory, context.distribution, context.packageAccess)
      if (digest(installed.signedInventory) !== receipt.target.inventory_sha256 || !['notifai', 'notifai.cmd', 'notifai.ps1'].every(name =>
        inspectNpmAdapterRoute(path.join(receipt.prefix, name), installed, { platform: 'win32', checkAccess: context.packageAccess })?.kind === 'global')) {
        throw new Error('Npm replacement returned without verified command routes')
      }
      receipt.phase = 'package_verified'
      save(directory, receipt, context)
      return result
    })
  } finally {
    withFileLock(lock, () => {
      const current = read(directory, context)
      if (current.token !== receipt.token || JSON.stringify(current.coordinator) !== JSON.stringify(owner)) throw new Error('Npm operation ownership changed')
      current.coordinator = null
      save(directory, current, context)
    }, { waitMs: 5000, strictRelease: true })
  }
}
