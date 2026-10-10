import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import { captureRemovalPlan, executableMember, removalPlan, removePlannedFiles, verifyRemovalPlan, type RemovalPlan } from './installation-removal.js'
import { inspectNativeFileUse, type NativeFileUse } from './native-file-use.js'
import { canonicalPath, sameLocalPath } from './local-path.js'
import { windowsUninstallCommand } from './windows-uninstall.js'
import { atomicWriteFileSync } from './atomic-file.js'
import { installationAccess, type InstallationAccess } from './installation-access.js'
import { withFileLock } from './file-lock.js'
import type { Distribution, ReleaseArtifact, ReleaseChannel, ReleaseInventory, ReleaseTarget, ChannelRecord, ResolvedRelease } from './release-distribution.js'
import { compareReleasePrecedence, isPrerelease } from './version.js'
import { ShellPathInstallation } from './installation-path.js'
import { WindowsPathInstallation, nativeUserPathRegistry } from './installation-windows-path.js'
import { RuntimeRetention, type RuntimeOwnerInspection } from './runtime-retention.js'
import { currentProcessIdentity, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { canShareLocalState, ContinuityPending, installedRuntime, LOCAL_CONTINUITY } from './local-continuity.js'
import { LEGACY_BOOTSTRAP_INVENTORIES } from './legacy-native-bootstrap.js'

export type InstallSource = 'shell' | 'powershell' | 'npm' | 'manual'
export interface ActiveGeneration { schema: 1; active: string; previous: string | null; generation: number }
interface InstallRecord {
  schema: 1
  id: string
  owner: 'notifai'
  source: InstallSource
  target?: ReleaseTarget
  runtime?: { target: ReleaseTarget; contract: typeof LOCAL_CONTINUITY }
  channel: ReleaseChannel
  previousChannel: ReleaseChannel | null
  launcherBuild: string
  launcherUpdatePending: boolean
}
interface Transaction { schema: 1; kind: 'activation' | 'launcher' | 'channel'; from: ActiveGeneration | null; to: ActiveGeneration; previous: InstallRecord | null; next: InstallRecord }
interface UninstallTransaction { schema: 1; installation_id: string; generation: number; token: string; owner: ProcessIdentity; phase: 'preparing' | 'removing'; plan?: RemovalPlan; cleanup_build?: string }
type UninstallPreparation = { status: 'waiting_for_questions' | 'uncertain'; reason?: string } |
  { status: 'preparing' | 'removing'; token: string; owners: RuntimeOwnerInspection }
interface VerifiedVersion { directory: string; inventory: ReleaseInventory; artifact: ReleaseArtifact }
export interface InstallationStatus { active: ActiveGeneration | null; pending: boolean; uninstall_pending: boolean; bootstrap_pending?: true; source: InstallSource | null; channel: ReleaseChannel | null; launcher_update_pending: boolean }
export interface ActivationResult { changed: boolean; active: ActiveGeneration; launcher_update_pending: boolean }
type Phase = 'prepared' | 'launcher' | 'metadata' | 'activated' | 'uninstall-planned' | 'uninstall-file-removed' | 'bootstrap-closed' | 'bootstrap-fenced'
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const buildId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function present(file: string): boolean {
  try { lstatSync(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function owned(file: string, directory: boolean): void {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error(`Unowned installation path: ${file}`)
}
export function activeRecord(value: unknown): ActiveGeneration {
  const item = value as Partial<ActiveGeneration> | null
  if (!item || item.schema !== 1 || !buildId(item.active) || !(item.previous === null || buildId(item.previous)) ||
      !Number.isSafeInteger(item.generation) || item.generation! < 1) throw new Error('Invalid active generation')
  return { schema: 1, active: item.active, previous: item.previous, generation: item.generation! }
}
export function activeBytes(value: ActiveGeneration): string {
  // This canonical grammar is shared with the deliberately small C launcher.
  return `${JSON.stringify({ schema: 1, active: value.active, previous: value.previous, generation: value.generation })}\n`
}
function sameGeneration(left: ActiveGeneration | null, right: ActiveGeneration | null): boolean {
  return left === null || right === null ? left === right : activeBytes(left) === activeBytes(right)
}

/** Local installation authority. Distribution and archive parsing delegate to
 * their own modules. No activation removes a version, changes account data, or rewires a
 * harness. Old resident owners can keep their immutable executable. */
export class Installation {
  private readonly access: InstallationAccess
  private readonly root: string
  private readonly extension: string
  private readonly probe: (directory: string, inventory: ReleaseInventory) => void
  constructor(private readonly options: { root: string; target: ReleaseTarget; distribution: Distribution;
    access?: InstallationAccess; probe?: (directory: string, inventory: ReleaseInventory) => void; observe?: (phase: Phase) => void;
    bootIdentity?: () => string | null; fileUse?: (launcher: string, files: readonly string[]) => NativeFileUse;
    sessionsDirectory?: string; externalWriters?: () => string | null; legacyBootstrapInventories?: readonly string[] }) {
    if (!path.isAbsolute(options.root)) throw new Error('Installation root must be absolute')
    this.access = options.access ?? installationAccess()
    this.root = path.resolve(options.root)
    this.extension = options.target.startsWith('bun-windows-') ? '.exe' : ''
    this.probe = options.probe ?? ((directory, inventory) => {
      const launcher = path.join(directory, `notifai${this.extension}`)
      const output = execFileSync(launcher, ['self-check', '--json'], { encoding: 'utf8', timeout: 20_000,
        windowsHide: true, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      const result = JSON.parse(output) as { ok?: boolean; capabilities?: { local_continuity?: string }; build?: { version?: string; sourceRevision?: string; sourceDirty?: boolean; target?: string } }
      if (result.ok !== true || result.build?.version !== inventory.version || result.build.sourceRevision !== inventory.source_revision ||
          result.build.sourceDirty !== false || result.build.target !== options.target) throw new Error('Candidate self-check did not establish the signed build identity')
      if (inventory.schema === 2 && result.capabilities?.local_continuity !== inventory.local_continuity?.contract) {
        throw new Error('Candidate does not implement its signed local continuity contract')
      }
    })
  }

  private owned(file: string, directory: boolean): void {
    owned(file, directory)
    this.access.check(file, directory)
  }
  private write(file: string, contents: string | Uint8Array, executable = false): void {
    this.access.directory(path.dirname(file))
    atomicWriteFileSync(file, contents, { mode: executable ? 0o700 : 0o600, preserveMode: false,
      requireCurrentUserOwner: true, prepareTemporary: temporary => this.access.beforePublish(temporary) })
  }
  private file(name: string): string { return path.join(this.root, name) }
  private checkRoot(): void { if (present(this.root)) this.owned(this.root, true) }
  private prepareRoot(): void { this.checkRoot(); this.access.directory(this.root) }
  private readJson(name: string): unknown | null {
    const file = this.file(name)
    // Reading a record requires a trusted root; its absence does not. A folder
    // an older CLI left behind is protected only after candidate authentication.
    if (!present(file)) return null
    this.checkRoot()
    this.owned(file, false)
    if (lstatSync(file).size > 256 * 1024) throw new Error('Installation record exceeds its size limit')
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  private save(name: string, value: unknown): void {
    this.write(this.file(name), `${JSON.stringify(value)}\n`)
  }
  private mutate<T>(action: () => T, resumeBootstrap = false): T {
    return withFileLock(this.file('installation.lock'), () => {
      if (present(this.file('uninstall.json')) && !(resumeBootstrap && this.bootstrapTarget() !== null)) {
        throw new Error(this.bootstrapTarget() !== null
          ? 'Recover the exact pending native bootstrap before changing this installation'
          : 'Finish or explicitly cancel the pending uninstall before changing this installation')
      }
      return action()
    }, { waitMs: 5_000, strictRelease: true })
  }

  /** The existing transaction owns recovery. This small presence marker uses
   * the filename shipped native launchers already honor; its distinct schema
   * makes their uninstall parser refuse it. It is never an uninstall plan. */
  private bootstrapTarget(): string | null {
    const record = this.readJson('uninstall.json') as Record<string, unknown> | null
    if (record?.['schema'] !== 2 || record['operation'] !== 'continuity-bootstrap') return null
    const transaction = this.transaction(this.readJson('transaction.json'))
    if (!buildId(record['build']) || record['build'] !== transaction.to.active ||
        record['installation_id'] !== transaction.next.id || transaction.previous === null || transaction.previous.runtime !== undefined ||
        transaction.next.runtime === undefined || transaction.kind !== 'activation') throw new Error('Invalid native bootstrap recovery')
    return record['build']
  }
  private legacyRejectionProven(version: VerifiedVersion): boolean {
    return version.inventory.schema === 1 && (this.options.legacyBootstrapInventories ?? LEGACY_BOOTSTRAP_INVENTORIES)
      .includes(hash(readFileSync(path.join(version.directory, 'inventory.json'))))
  }
  /** One short first-upgrade boundary, under installation.lock. Existing
   * questions/owners defer it without waiting or stopping anything. Moving the
   * target into runtime rejects old ordinary commands, retained entrypoints and core
   * updater writes; harmless authenticated cache/staging/PATH work can finish.
   * The historical binaries are retained unchanged. */
  private bootstrapLegacy(transaction: Transaction, installed: InstallRecord): void {
    const build = transaction.to.active
    const pending = (reason: string): never => { throw new ContinuityPending(build, reason) }
    try {
      const external = this.options.externalWriters?.()
      if (external) pending(external)
      const retention = new RuntimeRetention(this.root, installed.id, this.access, this.options.bootIdentity)
      const owners = () => retention.inspectOwners(this.options.sessionsDirectory ?? this.file('sessions'))
      const quiet = (): void => {
        const observed = owners()
        if (observed.status !== 'clear' || observed.unattributedPending ||
            observed.sessions.some(session => session.pending || session.references.some(ref => ref.installation_id !== installed.id)) ||
            observed.residents.some(resident => processIdentityLiveness(resident.identity) !== 'gone') ||
            observed.hosts.some(host => processIdentityLiveness(host) !== 'gone')) {
          pending('The first native upgrade needs its existing questions and runtime owners to finish; their work is preserved.')
        }
      }
      quiet()
      const oldFiles: string[] = []
      const versions = this.file('versions')
      this.owned(versions, true)
      for (const existing of readdirSync(versions)) {
        if (/^\.staged-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(existing)) continue
        if (!buildId(existing)) pending('An unrecognized runtime directory needs inspection.')
        const version = this.verifyVersion(existing)
        if (version.inventory.schema !== 1) continue
        if (!this.legacyRejectionProven(version)) pending('This historical runtime has no proven writer rejection boundary.')
        oldFiles.push(path.join(version.directory, `notifai-runtime${this.extension}`))
      }
      if (!oldFiles.length) pending('No authenticated historical native runtime establishes this bootstrap boundary.')
      if (present(this.file('uninstall.json')) && this.bootstrapTarget() !== build) throw new Error('Existing uninstall must be recovered separately')
      this.save('uninstall.json', { schema: 2, operation: 'continuity-bootstrap', installation_id: installed.id, build })
      this.options.observe?.('bootstrap-closed')
      const launcher = path.join(this.versionDirectory(build), `notifai${this.extension}`)
      // Unlike uninstall, never exempt an old invoking payload/Windows parent.
      const use = this.options.fileUse ? this.options.fileUse(launcher, oldFiles)
        : inspectNativeFileUse(launcher, oldFiles, { excludeForeground: false })
      if (use.status !== 'clear') pending('An old native process is live or could not be inspected; retry the staged candidate after it finishes.')
      quiet()
      const identity = { ...installed }
      delete identity.target
      this.save('install.json', { ...identity, runtime: { target: this.options.target, contract: LOCAL_CONTINUITY } })
      this.options.observe?.('bootstrap-fenced')
    } finally {
      // Before the permanent fence, a busy/uncertain result immediately restores
      // the working installation. After it, only exact transaction recovery may
      // reopen admission; restoring the legacy target could revive an obsolete updater.
      if (this.readInstall()?.runtime === undefined && this.bootstrapTarget() === build) rmSync(this.file('uninstall.json'), { force: true })
    }
  }
  /** Publish a prepared owned-file change only while the assessed runtime is
   * still authoritative. Callers do no network/host/process waits here. */
  publishIntegration<T>(expectedGeneration: number, action: () => T,
    identity?: { installation_id: string; build: string }): T {
    return this.mutate(() => {
      const active = this.readActive()
      if (active?.generation !== expectedGeneration || present(this.file('transaction.json')) ||
          identity && (this.readInstall()?.id !== identity.installation_id || active.active !== identity.build)) {
        throw new Error('Update superseded; inspect the active installation before repairing integrations')
      }
      const result = action()
      if (result instanceof Promise) throw new Error('Integration publication must be synchronous')
      return result
    })
  }

  /** Called under installation.lock before preparing or recovering activation.
   * Unknown lifetime evidence overestimates writers; it never grants clearance. */
  private assertContinuity(build: string, installed: InstallRecord | null): void {
    const candidate = this.verifyVersion(build)
    if (candidate.inventory.schema !== 2) throw new ContinuityPending(build,
      'This release cannot enforce local continuity; it may be retained but cannot become active.')
    const external = this.options.externalWriters?.()
    if (external) throw new ContinuityPending(build, external)
    // First native installation also shares the existing state directory with
    // legacy owners. An absent install record does not establish quiescence.
    const installationId = installed?.id ?? '00000000-0000-0000-0000-000000000000'
    const retention = new RuntimeRetention(this.root, installationId, this.access, this.options.bootIdentity)
    const owners = retention.inspectOwners(this.options.sessionsDirectory ?? this.file('sessions'))
    if (owners.status === 'uncertain') throw new ContinuityPending(build, owners.reason ?? 'Runtime ownership is uncertain.')
    if (owners.unattributedPending || owners.sessions.some(owner => owner.pending && owner.references.length === 0 ||
        owner.references.some(reference => reference.installation_id !== installationId)) ||
        owners.hosts.some(host => processIdentityLiveness(host) !== 'gone')) {
      throw new ContinuityPending(build, 'An existing writer has no verified native generation.')
    }
    const builds = new Set(owners.sessions.flatMap(owner => owner.builds))
    const liveBuilds = new Set<string>()
    for (const resident of owners.residents) {
      if (processIdentityLiveness(resident.identity) === 'gone') continue
      if (resident.runtime?.installation_id !== installationId) throw new ContinuityPending(build,
        'An existing resident has no verified native generation.')
      builds.add(resident.runtime.build)
      liveBuilds.add(resident.runtime.build)
    }
    const active = this.readActive()
    if (active) builds.add(active.active)
    const versions = this.file('versions')
    this.owned(versions, true)
    for (const existing of readdirSync(versions)) {
      // Download/extraction scratch is never a managed command destination.
      if (/^\.staged-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(existing)) continue
      if (!buildId(existing)) throw new ContinuityPending(build, 'An unrecognized runtime directory needs inspection.')
      if (!this.neverAdmitted(existing) && retention.reason(existing) !== null) builds.add(existing)
    }
    for (const existing of builds) {
      if (existing === build) continue
      let previous: VerifiedVersion
      try { previous = this.verifyVersion(existing) } catch { throw new ContinuityPending(build, 'A retained runtime cannot be authenticated.') }
      // A completed bootstrap permanently withdrew legacy native command admission.
      // Preserve old references and files, without treating them as resumable
      // writers. An actually observed old resident still blocks on uncertainty.
      if (installed?.runtime !== undefined && !liveBuilds.has(existing) && this.legacyRejectionProven(previous)) continue
      if (!canShareLocalState(candidate.inventory, previous.inventory)) throw new ContinuityPending(build,
        `Existing runtime ${previous.inventory.version} has an unknown or different local continuity contract.`)
    }
  }
  private uninstallRecord(): UninstallTransaction | null {
    const value = this.readJson('uninstall.json') as Partial<UninstallTransaction> | null
    if (value === null) return null
    if (value.schema !== 1 || typeof value.installation_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.installation_id) ||
        typeof value.token !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.token) ||
        !value.owner || !Number.isSafeInteger(value.owner.pid) || value.owner.pid <= 0 || typeof value.owner.start !== 'string' || !value.owner.start ||
        !Number.isSafeInteger(value.generation) || value.generation! < 1 ||
        !['preparing', 'removing'].includes(value.phase ?? '')) throw new Error('Uninstall journal needs repair')
    if (value.plan !== undefined) {
      if (value.phase !== 'removing') throw new Error('Invalid removal phase')
      removalPlan(value.plan)
      if (value.cleanup_build !== undefined && (!buildId(value.cleanup_build) || !value.plan.files.some(item => item.name === `versions/${value.cleanup_build}/notifai-runtime.exe`))) throw new Error('Invalid cleanup build')
    }
    return value as UninstallTransaction
  }
  /** No wiring or runtime edits. The journal closes C and JS launch admission,
   * while the caller verifies withdrawal and process absence. Questions keep
   * their existing owners; uncertainty leaves the working installation intact. */
  beginUninstall(expectedGeneration: number, currentSessions: string): UninstallPreparation {
    if (!this.uninstallRecord()?.plan) this.activeRelease(expectedGeneration)
    return withFileLock(this.file('installation.lock'), () => {
      const active = this.readActive(), installed = this.readInstall(), journal = this.uninstallRecord()
      if (present(this.file('transaction.json'))) throw new Error('Installation changed or uninstall needs recovery')
      if (journal?.plan) {
        if ((installed && installed.id !== journal.installation_id) || (active && active.generation !== journal.generation) ||
            (expectedGeneration !== 0 && expectedGeneration !== journal.generation)) throw new Error('Installation changed during removal')
        verifyRemovalPlan(this.root, journal.plan, (file, directory) => this.owned(file, directory))
      } else if (!active || !installed || active.generation !== expectedGeneration ||
          (journal && (journal.installation_id !== installed.id || journal.generation !== active.generation))) {
        throw new Error('Installation changed or uninstall needs recovery')
      }
      const installationId = installed?.id ?? journal!.installation_id
      const generation = active?.generation ?? journal!.generation
      const owner = currentProcessIdentity()
      if (owner === null) throw new Error('Cannot establish uninstall process identity')
      const resuming = journal && journal.owner.pid === owner.pid && journal.owner.start === owner.start
      if (journal && !resuming && processIdentityLiveness(journal.owner) !== 'gone') {
        throw new Error('Another uninstall may still be running; retain this installation')
      }
      const owners = new RuntimeRetention(this.root, installationId, this.access, this.options.bootIdentity).inspectOwners(currentSessions)
      if (owners.status !== 'clear') {
        // A preparing journal has never removed wiring. Reopen admission so
        // work that appeared during preflight can complete through its owners.
        if (journal?.phase === 'preparing') rmSync(this.file('uninstall.json'))
        return { status: owners.status, ...(owners.reason ? { reason: owners.reason } : {}) }
      }
      const token = resuming ? journal!.token : randomUUID()
      if (!resuming) this.save('uninstall.json', { ...journal, schema: 1, installation_id: installationId, generation, token, owner, phase: journal?.phase ?? 'preparing' })
      return { status: journal?.phase ?? 'preparing', token, owners }
    }, { waitMs: 5_000, strictRelease: true })
  }
  cancelUninstall(token: string): void {
    this.checkRoot()
    withFileLock(this.file('installation.lock'), () => {
      const journal = this.uninstallRecord(), installed = this.readInstall(), active = this.readActive()
      const owner = currentProcessIdentity()
      if (!journal || journal.token !== token || journal.phase !== 'preparing' || journal.installation_id !== installed?.id ||
          journal.generation !== active?.generation || journal.owner.pid !== owner?.pid || journal.owner.start !== owner?.start) {
        throw new Error('Uninstall changed; inspect before recovery')
      }
      rmSync(this.file('uninstall.json'))
    }, { waitMs: 5_000, strictRelease: true })
  }
  /** The last gate before owned wiring edits. The durable phase transition
   * prevents cancellation from reopening admission after a partial removal. */
  enterUninstallRemoval(token: string, currentSessions: string): { status: 'removing' | 'waiting_for_questions' | 'residents_running' | 'uncertain' } {
    try {
      return withFileLock(this.file('installation.lock'), () => {
        const journal = this.uninstallRecord(), installed = this.readInstall(), active = this.readActive()
        const owner = currentProcessIdentity()
        if (!journal || journal.token !== token || !['preparing', 'removing'].includes(journal.phase) || journal.installation_id !== installed?.id ||
            journal.generation !== active?.generation || journal.owner.pid !== owner?.pid || journal.owner.start !== owner?.start ||
            present(this.file('transaction.json'))) return { status: 'uncertain' }
        const retention = new RuntimeRetention(this.root, installed.id, this.access, this.options.bootIdentity)
        const owners = retention.inspectOwners(currentSessions)
        if (owners.status !== 'clear') return { status: owners.status }
        for (const identity of [...owners.hosts, ...owners.residents.map(item => item.identity)]) {
          const liveness = processIdentityLiveness(identity)
          if (liveness !== 'gone') return { status: liveness === 'alive' ? 'residents_running' : 'uncertain' }
        }
        this.checkStable(installed)
        this.owned(this.file('versions'), true)
        const files = [this.file(path.join('bin', `notifai${this.extension}`))]
        for (const build of readdirSync(this.file('versions'))) {
          // Unfinished staging or unfamiliar entries need explicit recovery.
          const version = this.verifyVersion(build)
          files.push(path.join(version.directory, `notifai${this.extension}`), path.join(version.directory, `notifai-runtime${this.extension}`))
        }
        const version = this.verifyVersion(active.active)
        const observed = (this.options.fileUse ?? inspectNativeFileUse)(path.join(version.directory, `notifai${this.extension}`), files)
        if (observed.status !== 'clear') return { status: observed.status === 'in_use' ? 'residents_running' : 'uncertain' }
        // Close the scan window for state written by an owner exiting while the
        // native observer ran. Admission is still closed throughout both reads.
        const after = retention.inspectOwners(currentSessions)
        if (after.status !== 'clear') return { status: after.status }
        for (const identity of [...after.hosts, ...after.residents.map(item => item.identity)]) {
          const liveness = processIdentityLiveness(identity)
          if (liveness !== 'gone') return { status: liveness === 'alive' ? 'residents_running' : 'uncertain' }
        }
        this.save('uninstall.json', { ...journal, phase: 'removing' })
        return { status: 'removing' }
      }, { waitMs: 5_000, strictRelease: true })
    } catch { return { status: 'uncertain' } }
  }
  releaseUninstallReferences(token: string, currentSessions: string): { status: 'released' | 'waiting_for_questions' | 'residents_running' | 'uncertain' } {
    try {
      if (this.uninstallRecord()?.phase !== 'removing') return { status: 'uncertain' }
      const admitted = this.enterUninstallRemoval(token, currentSessions)
      if (admitted.status !== 'removing') return { status: admitted.status }
      return withFileLock(this.file('installation.lock'), () => {
        const journal = this.uninstallRecord(), installed = this.readInstall(), active = this.readActive(), owner = currentProcessIdentity()
        if (!journal || journal.phase !== 'removing' || journal.token !== token || journal.installation_id !== installed?.id ||
            journal.generation !== active?.generation || journal.owner.pid !== owner?.pid || journal.owner.start !== owner?.start) return { status: 'uncertain' }
        const retention = new RuntimeRetention(this.root, installed.id, this.access, this.options.bootIdentity)
        const owners = retention.inspectOwners(currentSessions)
        if (owners.status !== 'clear') return { status: owners.status }
        retention.releaseReferences(owners)
        return { status: 'released' }
      }, { waitMs: 5_000, strictRelease: true })
    } catch { return { status: 'uncertain' } }
  }
  private uninstallFiles(installed: InstallRecord): string[] {
    const names = ['install.json', 'active.json', `bin/notifai${this.extension}`]
    for (const build of readdirSync(this.file('versions'))) {
      const version = this.verifyVersion(build)
      const members = [`notifai${this.extension}`, `notifai-runtime${this.extension}`, 'inventory.json', ...version.artifact.materials.map(item => item.path)]
      const files = new Set(members), directories = new Set<string>([''])
      for (const file of members) for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent)
      const visit = (relative: string): void => {
        const directory = path.join(version.directory, relative)
        this.owned(directory, true)
        for (const name of readdirSync(directory)) {
          const member = relative ? `${relative}/${name}` : name
          if (directories.has(member)) visit(member)
          else if (!files.has(member)) throw new Error('Unrecognized file in immutable generation; preserve it before uninstall')
        }
      }
      visit('')
      names.push(...members.map(member => `versions/${build}/${member}`))
    }
    // These records own only installation metadata. Host journals and session
    // files referenced by them remain User state outside this removal plan.
    for (const directory of ['runtime-retention', 'openclaw-hosts']) {
      if (!present(this.file(directory))) continue
      const visit = (relative: string): void => {
        this.owned(this.file(relative), true)
        for (const name of readdirSync(this.file(relative))) {
          const member = `${relative}/${name}`, file = this.file(member)
          if (lstatSync(file).isDirectory()) visit(member)
          else {
            const value = this.readJson(member) as { schema?: unknown; installation_id?: unknown } | null
            if (value?.schema !== 1 || value.installation_id !== installed.id) throw new Error('Unverified installation retention record')
            names.push(member)
          }
        }
      }
      visit(directory)
    }
    if (present(this.file('staged-runtimes'))) {
      this.owned(this.file('staged-runtimes'), true)
      for (const name of readdirSync(this.file('staged-runtimes'))) {
        if (!/^[a-f0-9]{64}\.json$/.test(name) || !this.neverAdmitted(name.slice(0, -5))) throw new Error('Unverified staged runtime record')
        names.push(`staged-runtimes/${name}`)
      }
    }
    for (const channel of ['stable', 'beta'] as const) if (this.channelRecord(channel)) names.push(`channels/${channel}.json`)
    for (const name of ['shell-path.json', 'windows-path.json']) if (present(this.file(name))) names.push(name)
    return names
  }
  uninstallState(): { installationId: string; generation: number; phase: 'preparing' | 'removing'; planned: boolean } | null {
    const journal = this.uninstallRecord()
    return journal ? { installationId: journal.installation_id, generation: journal.generation, phase: journal.phase, planned: journal.plan !== undefined } : null
  }
  private cleanupFiles(journal: UninstallTransaction): { launcher: string; runtime: string; launcherHash: string; runtimeHash: string; directory: string } {
    if (!journal.plan || !journal.cleanup_build) throw new Error('No verified Windows cleanup plan')
    const directory = this.file(`uninstall-tools/${journal.installation_id}`)
    const member = (name: string): string => {
      const item = journal.plan!.files.find(item => item.name === `versions/${journal.cleanup_build}/${name}`)
      if (!item) throw new Error('Cleanup executable is not in the removal plan')
      return item.sha256
    }
    return { directory, launcher: path.join(directory, 'notifai.exe'), runtime: path.join(directory, 'notifai-runtime.exe'),
      launcherHash: member('notifai.exe'), runtimeHash: member('notifai-runtime.exe') }
  }
  private verifyCleanupCopy(journal: UninstallTransaction): ReturnType<Installation['cleanupFiles']> {
    const copy = this.cleanupFiles(journal)
    this.owned(this.file('uninstall-tools'), true)
    this.owned(copy.directory, true)
    for (const [file, expected] of [[copy.launcher, copy.launcherHash], [copy.runtime, copy.runtimeHash]]) {
      this.owned(file!, false)
      if (hash(readFileSync(file!)) !== expected) throw new Error('Windows cleanup copy changed')
    }
    return copy
  }
  /** Only the copied, verified payload may finish after Windows releases the
   * originals. A command-line flag alone cannot authorize deleting them. */
  finishUninstall(installationId: string, currentSessions: string): ReturnType<Installation['completeUninstall']> {
    const journal = this.uninstallRecord()
    if (!this.options.target.startsWith('bun-windows-') || !journal || journal.installation_id !== installationId) throw new Error('No matching Windows uninstall')
    const copy = this.verifyCleanupCopy(journal)
    if (!sameLocalPath(canonicalPath(process.execPath), canonicalPath(copy.runtime), process.platform)) throw new Error('Run the verified temporary uninstall command after the original command exits')
    const begun = this.beginUninstall(journal.generation, currentSessions)
    if (begun.status !== 'removing') return { status: begun.status === 'preparing' ? 'uncertain' : begun.status }
    return this.completeUninstall(begun.token, currentSessions, () => { throw new Error('Uninstall wiring was not completed') })
  }
  private prepareWindowsCleanup(journal: UninstallTransaction): string {
    if (!journal.cleanup_build) {
      const active = this.readActive()
      if (!active) throw new Error('Active cleanup build is unavailable')
      journal.cleanup_build = active.active
      this.save('uninstall.json', journal)
    }
    const copy = this.cleanupFiles(journal)
    this.access.directory(copy.directory)
    for (const [file, expected] of [[copy.launcher, copy.launcherHash], [copy.runtime, copy.runtimeHash]]) {
      if (!present(file!)) {
        const original = this.file(`versions/${journal.cleanup_build}/${path.basename(file!)}`)
        this.owned(original, false)
        const bytes = readFileSync(original)
        if (hash(bytes) !== expected) throw new Error('Cleanup source changed')
        this.write(file!, bytes, true)
      }
    }
    this.verifyCleanupCopy(journal)
    const receipt = JSON.stringify({ schema: 1, root: this.root, id: journal.installation_id,
      launcherHash: copy.launcherHash, runtimeHash: copy.runtimeHash, files: journal.plan!.files.map(item => item.name) }) + '\n'
    const receiptFile = path.join(copy.directory, 'cleanup.json')
    if (present(receiptFile)) {
      this.owned(receiptFile, false)
      if (readFileSync(receiptFile, 'utf8') !== receipt) throw new Error('Cleanup receipt changed')
    } else this.write(receiptFile, receipt)
    const lock = path.join(copy.directory, 'cleanup.lock')
    if (!present(lock)) this.write(lock, '')
    return windowsUninstallCommand(this.root, journal.installation_id, hash(receipt))
  }
  /** Wiring removal is supplied by the command's existing ownership-aware
   * harness/skill integration. Runtime deletion owns only a persisted finite
   * plan; credentials, configuration and Agent Session history stay intact. */
  completeUninstall(token: string, currentSessions: string, removeWiring: () => { ok: boolean; conflicts: string[] }):
    { status: 'removed' | 'incomplete' | 'waiting_for_questions' | 'residents_running' | 'uncertain'; retained?: string[]; conflicts?: string[]; recovery_command?: string } {
    try {
      if (!this.uninstallRecord()?.plan) {
        const admitted = this.enterUninstallRemoval(token, currentSessions)
        if (admitted.status !== 'removing') return { status: admitted.status }
        const wiring = removeWiring()
        if (!wiring.ok) return { status: 'incomplete', conflicts: wiring.conflicts }
        const released = this.releaseUninstallReferences(token, currentSessions)
        if (released.status !== 'released') return { status: released.status }
      }
      return withFileLock(this.file('installation.lock'), () => {
        const journal = this.uninstallRecord(), owner = currentProcessIdentity()
        if (!journal || journal.phase !== 'removing' || journal.token !== token ||
            journal.owner.pid !== owner?.pid || journal.owner.start !== owner?.start) return { status: 'uncertain' }
        if (!journal.plan) {
          const installed = this.readInstall(), active = this.readActive()
          if (!installed || !active || installed.id !== journal.installation_id || active.generation !== journal.generation) return { status: 'uncertain' }
          const launcher = this.activeRelease().launcher
          const pathSetup = this.options.target.startsWith('bun-windows-')
            ? new WindowsPathInstallation({ bin: this.file('bin'), registry: nativeUserPathRegistry(launcher),
              read: () => this.readJson('windows-path.json'), save: receipt => this.save('windows-path.json', receipt) })
            : new ShellPathInstallation({ home: path.dirname(this.root), bin: this.file('bin'), shell: '',
              read: () => this.readJson('shell-path.json'), save: receipt => this.save('shell-path.json', receipt) })
          const pathRemoved = pathSetup.remove()
          if (!pathRemoved.ok) return { status: 'incomplete', conflicts: pathRemoved.conflicts }
          journal.plan = captureRemovalPlan(this.root, this.uninstallFiles(installed), (file, directory) => this.owned(file, directory))
          this.save('uninstall.json', journal)
          this.options.observe?.('uninstall-planned')
        }
        const plan = journal.plan
        verifyRemovalPlan(this.root, plan, (file, directory) => this.owned(file, directory))
        const executables = plan.files.filter(item => executableMember(item.name) && present(this.file(item.name))).map(item => this.file(item.name))
        const externalCopy = this.options.target.startsWith('bun-windows-') && journal.cleanup_build &&
          sameLocalPath(canonicalPath(process.execPath), canonicalPath(this.cleanupFiles(journal).runtime), process.platform)
          ? this.verifyCleanupCopy(journal) : null
        const launcher = externalCopy?.launcher ?? executables.find(file => path.basename(file) === `notifai${this.extension}`)
        if (executables.length) {
          if (!launcher) return { status: 'incomplete', retained: executables }
          const observed = (this.options.fileUse ?? inspectNativeFileUse)(launcher, executables)
          if (observed.status !== 'clear') return { status: observed.status === 'in_use' ? 'residents_running' : 'uncertain' }
        }
        // Windows cannot unlink this command's executing images. A separately
        // invoked cleanup command must apply the same finite plan after exit.
        if (this.options.target.startsWith('bun-windows-') && !externalCopy) return { status: 'incomplete', recovery_command: this.prepareWindowsCleanup(journal), retained: plan.files.filter(item => present(this.file(item.name))).map(item => this.file(item.name)) }
        removePlannedFiles(this.root, plan, (file, directory) => this.owned(file, directory), () => this.options.observe?.('uninstall-file-removed'))
        rmSync(this.file('uninstall.json'))
        return { status: 'removed' }
      }, { waitMs: 5_000, strictRelease: true })
    } catch (error) { return { status: 'incomplete', conflicts: [error instanceof Error ? error.message : 'Uninstall needs recovery'] } }
  }
  private readActive(): ActiveGeneration | null {
    const value = this.readJson('active.json')
    if (value === null) return null
    const active = activeRecord(value)
    if (readFileSync(this.file('active.json'), 'utf8') !== activeBytes(active)) throw new Error('Active generation is not in launcher format')
    return active
  }
  private installRecord(value: unknown): InstallRecord {
    const item = value as Partial<InstallRecord> | null
    if (!item || item.schema !== 1 || item.owner !== 'notifai' || installedRuntime(item)?.target !== this.options.target ||
        typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id) ||
        !['shell', 'powershell', 'npm', 'manual'].includes(item.source ?? '') ||
        !['stable', 'beta'].includes(item.channel ?? '') || !buildId(item.launcherBuild) ||
        !(item.previousChannel === null || item.previousChannel === 'stable' || item.previousChannel === 'beta') ||
        typeof item.launcherUpdatePending !== 'boolean') throw new Error('Invalid installation ownership record')
    return item as InstallRecord
  }
  private readInstall(): InstallRecord | null {
    const value = this.readJson('install.json')
    return value === null ? null : this.installRecord(value)
  }
  inspect(): InstallationStatus {
    const installation = this.readInstall(), active = this.readActive()
    const bootstrap = this.bootstrapTarget() !== null
    return { active, pending: present(this.file('transaction.json')), uninstall_pending: present(this.file('uninstall.json')) && !bootstrap,
      ...(bootstrap ? { bootstrap_pending: true as const } : {}), source: installation?.source ?? null, channel: installation?.channel ?? null, launcher_update_pending: installation?.launcherUpdatePending ?? false }
  }
  /** Authenticated active identity for explicit lifecycle commands. Ordinary
   * hooks use the lightweight launcher checks and do not hash the payload. */
  activeRelease(expectedGeneration?: number): { version: string; launcher: string; build: string; generation: number } {
    const active = this.readActive(), installation = this.readInstall()
    if (!active || !installation) throw new Error('No managed installation is active')
    if (present(this.file('transaction.json'))) throw new Error('Recover the pending installation transaction first')
    if (expectedGeneration !== undefined && active.generation !== expectedGeneration) throw new Error('Installation changed; inspect before continuing')
    this.checkStable(installation)
    const candidate = this.verifyVersion(active.active)
    return { version: candidate.inventory.version, launcher: path.join(candidate.directory, `notifai${this.extension}`),
      build: active.active, generation: active.generation }
  }
  private channelRecord(channel: ReleaseChannel): { signed: string; record: ChannelRecord } | null {
    this.checkRoot()
    const directory = this.file('channels')
    if (!present(directory)) return null
    this.owned(directory, true)
    const file = path.join(directory, `${channel}.json`)
    if (!present(file)) return null
    this.owned(file, false)
    if (lstatSync(file).size > 256 * 1024) throw new Error('Cached channel exceeds its size limit')
    const signed = readFileSync(file, 'utf8')
    return { signed, record: this.options.distribution.verifyChannel(signed, channel) }
  }
  private assertNotWithdrawn(version: string): void {
    for (const channel of ['stable', 'beta'] as const) {
      if (this.channelRecord(channel)?.record.withdrawn_versions.includes(version)) throw new Error('This release has been withdrawn; use a verified replacement')
    }
  }
  /** Persist a verified discovery sequence before fetching its inventory. A
   * failed download cannot make a later lower sequence acceptable again. */
  async resolveRelease(channel: ReleaseChannel, version?: string, options: { readOnly?: boolean } = {}): Promise<ResolvedRelease> {
    if (!['stable', 'beta'].includes(channel)) throw new Error('Unknown release channel')
    const cached = this.channelRecord(channel)
    return this.options.distribution.resolveRelease({ channel, target: this.options.target,
      ...(version === undefined ? {} : { version }),
      ...(cached ? { seen: { sequence: cached.record.sequence, digest: hash(cached.signed) } } : {}),
      acceptChannel: signed => {
        if (options.readOnly) {
          const latest = this.channelRecord(channel)
          this.options.distribution.verifyChannel(signed, channel, latest ? { sequence: latest.record.sequence, digest: hash(latest.signed) } : undefined)
          return
        }
        this.prepareRoot()
        this.mutate(() => {
          const latest = this.channelRecord(channel)
          this.options.distribution.verifyChannel(signed, channel, latest ? { sequence: latest.record.sequence, digest: hash(latest.signed) } : undefined)
          this.access.directory(this.file('channels'))
          this.write(this.file(`channels/${channel}.json`), signed)
        })
      },
    })
  }
  /** Complete authenticated download-to-activation operation. Reuses an
   * already verified immutable build; never downloads on an ordinary hook. */
  async installRelease(input: { channel: ReleaseChannel; source: InstallSource; expectedGeneration: number;
    version?: string; allowStableDowngrade?: boolean }): Promise<ActivationResult & { version: string }> {
    if (this.uninstallRecord()) throw new Error('Recover the pending uninstall before installing')
    const before = this.inspect()
    if (before.pending) throw new Error('Recover the pending installation transaction first')
    if ((before.active?.generation ?? 0) !== input.expectedGeneration) throw new Error('Installation changed; inspect before retrying')
    const release = await this.resolveRelease(input.channel, input.version)
    const build = this.identity(release.inventory, release.artifact)
    if (!present(this.versionDirectory(build))) {
      const bytes = await this.options.distribution.downloadArtifact(release)
      const downloads = this.file('downloads')
      if (present(downloads)) this.owned(downloads, true)
      this.access.directory(downloads)
      const temporary = path.join(downloads, randomUUID())
      this.access.directory(temporary)
      try {
        const { extractReleaseArchive } = await import('./release-archive.js')
        const directory = await extractReleaseArchive({ distribution: this.options.distribution,
          signedInventory: release.signedInventory, target: this.options.target, bytes, parent: temporary })
        if (this.stage({ directory, signedInventory: release.signedInventory }) !== build) throw new Error('Staged release identity changed')
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    const result = this.activate({ ...input, build })
    return { ...result, version: release.inventory.version }
  }
  /** First-install boundary for an authenticated portable candidate. Rerunning
   * any bootstrap reuses a healthy installation; runtime changes belong to the
   * explicit update command. Existing directory migration is bounded to root/bin. */
  installCandidate(input: { directory: string; signedInventory: string; source: InstallSource;
    channel?: ReleaseChannel; version?: string; upgrade?: boolean }): ActivationResult & { version: string; reused: boolean } {
    if (present(this.file('uninstall.json')) && this.bootstrapTarget() === null) throw new Error('Finish or explicitly cancel the pending uninstall before installing')
    if (!['shell', 'powershell', 'npm', 'manual'].includes(input.source) ||
        (input.channel !== undefined && !['stable', 'beta'].includes(input.channel))) throw new Error('Unknown installation source or channel')
    if (input.upgrade && (!input.version || !input.channel)) throw new Error('--upgrade requires an exact --version and --channel')
    const verified = this.verifyFiles(input.directory, input.signedInventory)
    if (input.version !== undefined && input.version !== verified.inventory.version) throw new Error('Candidate does not match the requested exact version')
    this.probe(input.directory, verified.inventory)
    // No ownership or permission change occurs before authenticating candidate
    // bytes. The OS adapter must preserve all existing child descriptors.
    for (const directory of [this.root, this.file('bin')]) {
      if (present(directory)) {
        owned(directory, true)
        this.access.protectExistingDirectory(directory)
        this.owned(directory, true)
      }
    }
    const before = this.inspect()
    if (before.pending) {
      const transaction = this.transaction(this.readJson('transaction.json'))
      const staged = this.verifyVersion(transaction.to.active)
      if ((transaction.previous !== null && !input.upgrade) ||
          this.identity(verified.inventory, verified.artifact) !== transaction.to.active ||
          input.signedInventory !== readFileSync(path.join(staged.directory, 'inventory.json'), 'utf8') ||
          (input.channel !== undefined && input.channel !== transaction.next.channel)) {
        throw new Error('Resume the exact staged candidate or explicitly abandon the pending installation transaction')
      }
      const after = this.recover()
      return { changed: true, active: after.active!, version: staged.inventory.version, reused: false,
        launcher_update_pending: after.launcher_update_pending }
    }
    if (before.active) {
      const active = this.activeRelease(before.active.generation)
      if (input.upgrade) {
        const build = this.stage(input)
        return { ...this.activate({ build, source: before.source!, channel: input.channel!,
          expectedGeneration: before.active.generation }), version: verified.inventory.version, reused: false }
      }
      if ((input.version !== undefined && active.version !== input.version) ||
          (input.channel !== undefined && before.channel !== input.channel)) {
        throw new Error('An installation already exists; use notifai update to change its version or channel')
      }
      return { changed: false, active: before.active, version: active.version, reused: true,
        launcher_update_pending: before.launcher_update_pending }
    }
    const channel = input.channel ?? 'stable'
    if (channel === 'stable' && isPrerelease(verified.inventory.version)) throw new Error('Prerelease installation requires explicit beta channel')
    const build = this.stage(input)
    return { ...this.activate({ build, source: input.source, channel, expectedGeneration: 0 }), version: verified.inventory.version, reused: false }
  }
  /** Exact recoverable target; no new channel discovery and no runtime change. */
  pendingRelease(): { launcher: string; version: string; channel: ReleaseChannel } | null {
    const record = this.readJson('transaction.json')
    if (!record) return null
    const transaction = this.transaction(record), staged = this.verifyVersion(transaction.to.active)
    return { launcher: path.join(staged.directory, `notifai${this.extension}`), version: staged.inventory.version,
      channel: transaction.next.channel }
  }
  /** Explicit User PATH setup/removal. No hook or ordinary command edits
   * shell startup files or registry PATH; User-edited ownership is preserved. */
  shellPath(operation: 'configure' | 'remove', shell: string, env: NodeJS.ProcessEnv = {}) {
    const active = this.activeRelease()
    return this.mutate(() => {
      if (this.options.target.startsWith('bun-windows-')) {
        const pathSetup = new WindowsPathInstallation({ bin: this.file('bin'), registry: nativeUserPathRegistry(active.launcher),
          read: () => this.readJson('windows-path.json'), save: receipt => this.save('windows-path.json', receipt) })
        return operation === 'configure' ? pathSetup.configure() : pathSetup.remove()
      }
      const pathSetup = new ShellPathInstallation({ home: path.dirname(this.root), bin: this.file('bin'), shell, env,
        read: () => this.readJson('shell-path.json'), save: receipt => this.save('shell-path.json', receipt) })
      return operation === 'configure' ? pathSetup.configure() : pathSetup.remove()
    })
  }
  private versionDirectory(build: string): string {
    if (!buildId(build)) throw new Error('Invalid immutable build identifier')
    return this.file(path.join('versions', build))
  }
  private identity(inventory: ReleaseInventory, artifact: ReleaseArtifact): string {
    return hash(`${inventory.version}\0${artifact.target}\0${artifact.sha256}`)
  }
  private verifyFiles(directory: string, signedInventory: string, managed = false): Omit<VerifiedVersion, 'directory'> {
    const check = (file: string, isDirectory: boolean) => managed ? this.owned(file, isDirectory) : owned(file, isDirectory)
    check(directory, true)
    const inventory = this.options.distribution.verifyInventory(signedInventory)
    if (inventory.store_schema !== inventory.schema || inventory.launcher_schema !== 1) throw new Error('This installer cannot establish store and launcher compatibility for the candidate')
    const artifact = inventory.artifacts.find(item => item.target === this.options.target)
    if (!artifact) throw new Error('Candidate does not contain this installation target')
    for (const [name, expected] of [[`notifai-runtime${this.extension}`, artifact.runtime_sha256], [`notifai${this.extension}`, artifact.launcher_sha256]]) {
      const file = path.join(directory, name!)
      check(file, false)
      if (lstatSync(file).size > 512 * 1024 * 1024 || hash(readFileSync(file)) !== expected) throw new Error(`Candidate integrity mismatch: ${name}`)
    }
    for (const material of artifact.materials) {
      const file = path.join(directory, material.path)
      // Check each parent; an intermediate symlink is also outside the archive.
      let parent = path.dirname(file)
      while (parent !== directory) { check(parent, true); parent = path.dirname(parent) }
      check(file, false)
      if (lstatSync(file).size !== material.bytes || hash(readFileSync(file)) !== material.sha256) throw new Error(`Candidate material integrity mismatch: ${material.path}`)
    }
    return { inventory, artifact }
  }
  private verifyVersion(build: string): VerifiedVersion {
    this.checkRoot()
    this.owned(this.file('versions'), true)
    const directory = this.versionDirectory(build)
    this.owned(directory, true)
    const file = path.join(directory, 'inventory.json')
    this.owned(file, false)
    if (lstatSync(file).size > 256 * 1024) throw new Error('Version inventory is too large')
    const verified = this.verifyFiles(directory, readFileSync(file, 'utf8'), true)
    if (this.identity(verified.inventory, verified.artifact) !== build) throw new Error('Version directory identity mismatch')
    return { directory, ...verified }
  }

  /** Admit extracted executable bytes only after their signed hashes agree.
   * Archive authenticity and additional distribution materials are checked by
   * the distribution reader before it calls this local transaction boundary. */
  stage(input: { directory: string; signedInventory: string }): string {
    const verified = this.verifyFiles(input.directory, input.signedInventory)
    this.probe(input.directory, verified.inventory)
    const build = this.identity(verified.inventory, verified.artifact)
    this.prepareRoot()
    if (present(this.file('versions'))) this.owned(this.file('versions'), true)
    this.access.directory(this.file('versions'))
    const destination = this.versionDirectory(build)
    if (present(destination)) {
      this.mutate(() => { this.verifyVersion(build); this.keepStaged(build) })
      return build
    }
    const staged = this.file(path.join('versions', `.staged-${randomUUID()}`))
    this.access.directory(staged)
    try {
      for (const name of [`notifai-runtime${this.extension}`, `notifai${this.extension}`, ...verified.artifact.materials.map(item => item.path)]) {
        this.write(path.join(staged, name), readFileSync(path.join(input.directory, name)), [`notifai${this.extension}`, `notifai-runtime${this.extension}`].includes(name))
      }
      this.write(path.join(staged, 'inventory.json'), input.signedInventory)
      this.verifyFiles(staged, input.signedInventory, true)
      this.mutate(() => {
        if (present(destination)) this.verifyVersion(build)
        else {
          // Publish positive never-admitted evidence before making this build
          // addressable. Missing evidence is always conservative, including
          // historical builds and an interrupted activation.
          if (verified.inventory.schema === 2) {
            this.access.directory(this.file('staged-runtimes'))
            this.save(`staged-runtimes/${build}.json`, { schema: 1, build, inventory_sha256: hash(input.signedInventory) })
          }
          renameSync(staged, destination)
        }
        this.keepStaged(build)
      })
      return build
    } finally { if (present(staged)) rmSync(staged, { recursive: true }) }
  }
  private neverAdmitted(build: string): boolean {
    const record = this.readJson(`staged-runtimes/${build}.json`) as { schema?: unknown; build?: unknown; inventory_sha256?: unknown } | null
    if (record === null) return false
    const version = this.verifyVersion(build)
    // Historical installers do not consume this receipt on activation.
    if (version.inventory.schema !== 2) return false
    if (record.schema !== 1 || record.build !== build || record.inventory_sha256 !== hash(readFileSync(path.join(version.directory, 'inventory.json')))) {
      throw new Error('Unverified staged runtime evidence')
    }
    return true
  }
  private keepStaged(build: string): void {
    const installed = this.readInstall()
    if (installed) new RuntimeRetention(this.root, installed.id, this.access, this.options.bootIdentity).activate(null, build)
  }

  private checkStable(record: InstallRecord | null, alternative?: InstallRecord): void {
    const bin = this.file('bin'), file = path.join(bin, `notifai${this.extension}`)
    if (present(bin)) this.owned(bin, true)
    if (!present(file)) {
      if (record) throw new Error('Owned stable command is missing; repair the installation')
      return
    }
    this.owned(file, false)
    const actual = hash(readFileSync(file))
    const records = [record, alternative].filter((entry): entry is InstallRecord => entry !== null && entry !== undefined)
    if (!records.some(entry => this.verifyVersion(entry.launcherBuild).artifact.launcher_sha256 === actual)) {
      throw new Error('Unowned stable command; preserve it and resolve the command collision')
    }
  }
  private transaction(value: unknown): Transaction {
    const item = value as Partial<Transaction> | null
    if (!item || item.schema !== 1 || !['activation', 'launcher', 'channel'].includes(item.kind ?? '')) throw new Error('Invalid installation transaction')
    const from = item.from === null ? null : activeRecord(item.from), to = activeRecord(item.to)
    const previous = item.previous === null ? null : this.installRecord(item.previous), next = this.installRecord(item.next)
    const validGeneration = item.kind === 'launcher' ? from !== null && sameGeneration(from, to) :
      item.kind === 'channel' ? from !== null && to.active === from.active && to.previous === from.previous && to.generation === from.generation + 1 :
      to.generation === (from?.generation ?? 0) + 1 && to.previous === (from?.active ?? null)
    if (!validGeneration || (from === null) !== (previous === null) ||
        (previous && previous.id !== next.id)) throw new Error('Installation transaction identity mismatch')
    return { schema: 1, kind: item.kind!, from, to, previous, next }
  }
  private finish(transaction: Transaction): void {
    const current = this.readActive()
    if (!sameGeneration(current, transaction.from) && !sameGeneration(current, transaction.to)) throw new Error('Installation changed during transaction recovery')
    const installed = this.readInstall()
    if (installed && installed.id !== transaction.next.id) throw new Error('Installation owner changed during recovery')
    const next = this.verifyVersion(transaction.to.active)
    // Discovery can advance while an interrupted transaction is waiting. An
    // already committed generation stays usable; recovery never silently rolls
    // it back. A not-yet-committed withdrawn candidate cannot become active.
    if (!sameGeneration(current, transaction.to)) {
      this.assertNotWithdrawn(next.inventory.version)
      if (installed && installed.runtime === undefined && transaction.next.runtime !== undefined) this.bootstrapLegacy(transaction, installed)
      this.assertContinuity(transaction.to.active, this.readInstall())
    }
    this.checkStable(transaction.previous, transaction.next)
    this.access.directory(this.file('bin'))
    const stable = this.file(path.join('bin', `notifai${this.extension}`))
    try {
      if (!present(stable) || hash(readFileSync(stable)) !== next.artifact.launcher_sha256) {
        this.write(stable, readFileSync(path.join(next.directory, `notifai${this.extension}`)), true)
      }
      transaction.next.launcherBuild = transaction.to.active
      transaction.next.launcherUpdatePending = false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || !transaction.previous || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error
      this.checkStable(transaction.previous)
      transaction.next.launcherBuild = transaction.previous.launcherBuild
      transaction.next.launcherUpdatePending = true
    }
    this.save('transaction.json', transaction)
    this.options.observe?.('launcher')
    this.save('install.json', transaction.next)
    this.options.observe?.('metadata')
    new RuntimeRetention(this.root, transaction.next.id, this.access, this.options.bootIdentity)
      .activate(transaction.from?.active ?? null, transaction.to.active)
    // Remove the exemption before launch admission can see this generation.
    // A crash here overestimates writers; it cannot admit an untracked writer.
    rmSync(this.file(`staged-runtimes/${transaction.to.active}.json`), { force: true })
    this.write(this.file('active.json'), activeBytes(transaction.to))
    this.options.observe?.('activated')
    if (!sameGeneration(this.readActive(), transaction.to)) throw new Error('Active generation read-back failed')
    if (this.bootstrapTarget() === transaction.to.active) rmSync(this.file('uninstall.json'))
    rmSync(this.file('transaction.json'))
  }
  /** Explicit housekeeping. No live-generation deletion and no age heuristic.
   * Partial Windows deletion stays visible and is safely retryable: inventory
   * is removed last, and each remaining file must still match that signature. */
  cleanup(expectedGeneration: number): { removed: string[]; retained: Array<{ build: string; reason: string; bytes: number }> } {
    this.prepareRoot()
    return this.mutate(() => {
      const active = this.readActive(), installed = this.readInstall()
      if (!active || !installed || active.generation !== expectedGeneration || present(this.file('transaction.json'))) {
        throw new Error('Installation changed or needs recovery before cleanup')
      }
      const retention = new RuntimeRetention(this.root, installed.id, this.access, this.options.bootIdentity)
      const removed: string[] = [], retained: Array<{ build: string; reason: string; bytes: number }> = []
      this.owned(this.file('versions'), true)
      for (const build of readdirSync(this.file('versions'))) {
        if (!buildId(build)) continue // Staging and unrelated entries are never cleanup authority.
        let bytes = 0
        const protectedBuild = [active.active, active.previous, installed.launcherBuild].includes(build)
        let reason = protectedBuild ? 'active_previous_or_launcher' : retention.reason(build)
        try {
          const directory = this.versionDirectory(build)
          this.owned(directory, true)
          const inventoryFile = path.join(directory, 'inventory.json')
          if (!present(inventoryFile) && readdirSync(directory).length === 0 && reason === null) {
            rmdirSync(directory); removed.push(build); continue
          }
          this.owned(inventoryFile, false)
          if (lstatSync(inventoryFile).size > 256 * 1024) throw new Error('Invalid cleanup inventory')
          const inventoryBytes = readFileSync(inventoryFile)
          const inventory = this.options.distribution.verifyInventory(inventoryBytes.toString('utf8'))
          const artifact = inventory.artifacts.find(item => item.target === this.options.target)
          if (!artifact || this.identity(inventory, artifact) !== build) throw new Error('Cleanup inventory identity mismatch')
          const files = new Map<string, { sha256: string; bytes?: number }>([
            [`notifai${this.extension}`, { sha256: artifact.launcher_sha256 }],
            [`notifai-runtime${this.extension}`, { sha256: artifact.runtime_sha256 }],
            ['inventory.json', { sha256: hash(inventoryBytes) }],
            ...artifact.materials.map(item => [item.path, item] as const),
          ])
          const directories = new Set<string>([''])
          for (const name of files.keys()) {
            for (let parent = path.dirname(path.normalize(name)); parent !== '.'; parent = path.dirname(parent)) directories.add(parent)
          }
          const existingFiles: string[] = [], existingDirectories: string[] = []
          const visit = (relative: string): void => {
            const here = path.join(directory, relative)
            this.owned(here, true)
            existingDirectories.push(here)
            for (const name of readdirSync(here)) {
              const member = path.join(relative, name), file = path.join(directory, member)
              if (directories.has(member)) visit(member)
              else {
                const expected = files.get(member.split(path.sep).join('/'))
                if (!expected) throw new Error('Unowned file in retired generation')
                this.owned(file, false)
                const size = lstatSync(file).size
                if (size > 512 * 1024 * 1024 || (expected.bytes !== undefined && size !== expected.bytes) || hash(readFileSync(file)) !== expected.sha256) {
                  throw new Error('Modified file in retired generation')
                }
                bytes += size; existingFiles.push(file)
              }
            }
          }
          visit('')
          if (reason === null) {
            for (const file of existingFiles.filter(file => file !== inventoryFile)) rmSync(file)
            for (const directory of existingDirectories.slice(1).reverse()) rmdirSync(directory)
            rmSync(inventoryFile)
            rmdirSync(directory)
            removed.push(build)
          }
        } catch { reason ??= 'cleanup_incomplete_or_unverified' }
        if (reason !== null) retained.push({ build, reason, bytes })
      }
      return { removed, retained }
    })
  }
  recover(): InstallationStatus {
    if (!present(this.file('transaction.json'))) return this.inspect()
    this.prepareRoot()
    this.mutate(() => {
      const value = this.readJson('transaction.json')
      if (value !== null) this.finish(this.transaction(value))
    }, true)
    return this.inspect()
  }
  /** Explicitly abandon only a transaction that has not committed its active
   * pointer. Keep all immutable payloads and user data; no implicit downgrade.
   * A locked Windows launcher leaves the journal available for a quiet retry. */
  abandonPending(expectedGeneration: number): InstallationStatus {
    this.prepareRoot()
    this.mutate(() => {
      const current = this.readActive()
      if ((current?.generation ?? 0) !== expectedGeneration) throw new Error('Installation changed; inspect before abandoning recovery')
      const value = this.readJson('transaction.json')
      if (value === null) return
      const transaction = this.transaction(value)
      if (!sameGeneration(current, transaction.from) || sameGeneration(current, transaction.to)) {
        throw new Error('This activation is committed; recover it before an explicit rollback')
      }
      const installed = this.readInstall()
      if ((installed && installed.id !== transaction.next.id) || (!installed && transaction.previous)) {
        throw new Error('Installation owner changed during recovery')
      }
      if (installed?.runtime && transaction.previous !== null && transaction.previous.runtime === undefined) throw new Error('Recover the exact pending native bootstrap; its admission fence cannot be abandoned')
      this.checkStable(transaction.previous, transaction.next)
      const stable = this.file(path.join('bin', `notifai${this.extension}`))
      if (transaction.previous) {
        const prior = this.verifyVersion(transaction.previous.launcherBuild)
        if (!present(stable) || hash(readFileSync(stable)) !== prior.artifact.launcher_sha256) {
          this.write(stable, readFileSync(path.join(prior.directory, `notifai${this.extension}`)), true)
        }
        this.save('install.json', transaction.previous)
      } else {
        if (present(stable)) rmSync(stable)
        if (installed) rmSync(this.file('install.json'))
      }
      rmSync(this.file('transaction.json'))
    })
    return this.inspect()
  }
  activate(input: { build: string; expectedGeneration: number; source: InstallSource; channel: ReleaseChannel; allowStableDowngrade?: boolean }): ActivationResult {
    if (!['stable', 'beta'].includes(input.channel) || !['shell', 'powershell', 'npm', 'manual'].includes(input.source)) {
      throw new Error('Unknown installation source or channel')
    }
    const candidate = this.verifyVersion(input.build)
    this.probe(candidate.directory, candidate.inventory)
    if (input.channel === 'stable' && isPrerelease(candidate.inventory.version)) throw new Error('Prerelease cannot activate on stable')
    this.prepareRoot()
    return this.mutate(() => {
      if (present(this.file('transaction.json'))) throw new Error('Recover the pending installation transaction first')
      const from = this.readActive(), previous = this.readInstall()
      if ((from?.generation ?? 0) !== input.expectedGeneration) throw new Error('Installation changed; inspect before retrying')
      if ((from === null) !== (previous === null)) throw new Error('Installation metadata is incomplete; repair it first')
      this.checkStable(previous)
      this.assertNotWithdrawn(candidate.inventory.version)
      if (from?.active === input.build) {
        if (previous!.channel === input.channel) return { changed: false, active: from, launcher_update_pending: previous!.launcherUpdatePending }
        const to = { ...from, generation: from.generation + 1 }
        const transaction: Transaction = { schema: 1, kind: 'channel', from, to, previous,
          next: { ...previous!, channel: input.channel } }
        this.save('transaction.json', transaction)
        this.options.observe?.('prepared')
        this.finish(transaction)
        return { changed: true, active: to, launcher_update_pending: transaction.next.launcherUpdatePending }
      }
      const order = from ? compareReleasePrecedence(candidate.inventory.version, this.verifyVersion(from.active).inventory.version) : 'after'
      if (order !== 'after') {
        const stable = this.channelRecord('stable')?.record
        if (!(order === 'before' && input.allowStableDowngrade === true && input.channel === 'stable' && previous?.channel === 'beta' &&
              stable?.version === candidate.inventory.version && stable.inventory_sha256 === hash(readFileSync(path.join(candidate.directory, 'inventory.json'))))) {
          throw new Error('Use explicit rollback or an authorized return to the signed stable target; release identities cannot be replaced')
        }
      }
      return this.commit(from, previous, input.build, input.source, input.channel)
    })
  }
  private commit(from: ActiveGeneration | null, previous: InstallRecord | null, build: string, source: InstallSource, channel: ReleaseChannel): ActivationResult {
    // Historical readers remain authenticated, but can never become an active
    // updater again. Leave no recoverable downgrade transaction for them.
    if (this.verifyVersion(build).inventory.schema !== 2) throw new ContinuityPending(build,
      'This release cannot enforce local continuity; it may be retained but cannot become active.')
    const to: ActiveGeneration = { schema: 1, active: build, previous: from?.active ?? null, generation: (from?.generation ?? 0) + 1 }
    const next: InstallRecord = { schema: 1, id: previous?.id ?? randomUUID(), owner: 'notifai', source: previous?.source ?? source,
      runtime: { target: this.options.target, contract: LOCAL_CONTINUITY }, channel, previousChannel: previous?.channel ?? null, launcherBuild: build, launcherUpdatePending: false }
    const transaction: Transaction = { schema: 1, kind: 'activation', from, to, previous, next }
    this.save('transaction.json', transaction)
    this.options.observe?.('prepared')
    this.finish(transaction)
    return { changed: true, active: to, launcher_update_pending: transaction.next.launcherUpdatePending }
  }
  /** Explicit quiet-point retry. The active generation and rollback slot stay put. */
  repairLauncher(expectedGeneration: number): ActivationResult {
    this.prepareRoot()
    return this.mutate(() => {
      if (present(this.file('transaction.json'))) throw new Error('Recover the pending installation transaction first')
      const from = this.readActive(), previous = this.readInstall()
      if (!from || !previous || from.generation !== expectedGeneration) throw new Error('Installation changed; inspect before repair')
      this.checkStable(previous)
      if (!previous.launcherUpdatePending) return { changed: false, active: from, launcher_update_pending: false }
      const transaction: Transaction = { schema: 1, kind: 'launcher', from, to: from, previous,
        next: { ...previous, launcherBuild: from.active, launcherUpdatePending: false } }
      this.save('transaction.json', transaction)
      this.options.observe?.('prepared')
      this.finish(transaction)
      return { changed: !transaction.next.launcherUpdatePending, active: from, launcher_update_pending: transaction.next.launcherUpdatePending }
    })
  }
  rollback(expectedGeneration: number): ActivationResult {
    const snapshot = this.readActive()
    if (!snapshot?.previous) throw new Error('No previous verified generation is available')
    const candidate = this.verifyVersion(snapshot.previous)
    this.probe(candidate.directory, candidate.inventory)
    return this.mutate(() => {
      if (present(this.file('transaction.json'))) throw new Error('Recover the pending installation transaction first')
      const from = this.readActive(), previous = this.readInstall()
      if (!sameGeneration(from, snapshot) || from?.generation !== expectedGeneration || !previous) throw new Error('Installation changed; inspect before rollback')
      this.checkStable(previous)
      this.assertNotWithdrawn(candidate.inventory.version)
      if (!previous.previousChannel) throw new Error('Previous release channel is unavailable')
      return this.commit(from, previous, snapshot.previous!, previous.source, previous.previousChannel)
    })
  }
}
