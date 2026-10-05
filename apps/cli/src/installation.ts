import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync, ensurePrivateDirectory } from './atomic-file.js'
import { withFileLock } from './file-lock.js'
import type { Distribution, ReleaseArtifact, ReleaseChannel, ReleaseInventory, ReleaseTarget } from './release-distribution.js'
import { compareReleasePrecedence, isPrerelease } from './version.js'

type InstallSource = 'shell' | 'powershell' | 'npm' | 'manual'
export interface ActiveGeneration { schema: 1; active: string; previous: string | null; generation: number }
interface InstallRecord {
  schema: 1
  id: string
  owner: 'notifai'
  source: InstallSource
  target: ReleaseTarget
  channel: ReleaseChannel
  previousChannel: ReleaseChannel | null
  launcherBuild: string
  launcherUpdatePending: boolean
}
interface Transaction { schema: 1; kind: 'activation' | 'launcher'; from: ActiveGeneration | null; to: ActiveGeneration; previous: InstallRecord | null; next: InstallRecord }
interface VerifiedVersion { directory: string; inventory: ReleaseInventory; artifact: ReleaseArtifact }
export interface InstallationStatus { active: ActiveGeneration | null; pending: boolean; source: InstallSource | null; channel: ReleaseChannel | null }
export interface ActivationResult { changed: boolean; active: ActiveGeneration; launcher_update_pending: boolean }
type Phase = 'prepared' | 'launcher' | 'metadata' | 'activated'
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
function activeRecord(value: unknown): ActiveGeneration {
  const item = value as Partial<ActiveGeneration> | null
  if (!item || item.schema !== 1 || !buildId(item.active) || !(item.previous === null || buildId(item.previous)) ||
      !Number.isSafeInteger(item.generation) || item.generation! < 1) throw new Error('Invalid active generation')
  return { schema: 1, active: item.active, previous: item.previous, generation: item.generation! }
}
function activeBytes(value: ActiveGeneration): string {
  // This canonical grammar is shared with the deliberately small C launcher.
  return `${JSON.stringify({ schema: 1, active: value.active, previous: value.previous, generation: value.generation })}\n`
}
function sameGeneration(left: ActiveGeneration | null, right: ActiveGeneration | null): boolean {
  return left === null || right === null ? left === right : activeBytes(left) === activeBytes(right)
}

/** Local installation authority. Network and archive extraction are outside this
 * module. No activation removes a version, changes account data, or rewires a
 * harness. Old resident owners can keep their immutable executable. */
export class Installation {
  private readonly root: string
  private readonly extension: string
  private readonly probe: (directory: string, inventory: ReleaseInventory) => void
  constructor(private readonly options: { root: string; target: ReleaseTarget; distribution: Distribution;
    probe?: (directory: string, inventory: ReleaseInventory) => void; observe?: (phase: Phase) => void }) {
    if (!path.isAbsolute(options.root)) throw new Error('Installation root must be absolute')
    this.root = path.resolve(options.root)
    this.extension = options.target.startsWith('bun-windows-') ? '.exe' : ''
    this.probe = options.probe ?? ((directory, inventory) => {
      const launcher = path.join(directory, `notifai${this.extension}`)
      const output = execFileSync(launcher, ['self-check', '--json'], { encoding: 'utf8', timeout: 20_000,
        windowsHide: true, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      const result = JSON.parse(output) as { ok?: boolean; build?: { version?: string; sourceRevision?: string; sourceDirty?: boolean; target?: string } }
      if (result.ok !== true || result.build?.version !== inventory.version || result.build.sourceRevision !== inventory.source_revision ||
          result.build.sourceDirty !== false || result.build.target !== options.target) throw new Error('Candidate self-check did not establish the signed build identity')
    })
  }

  private file(name: string): string { return path.join(this.root, name) }
  private checkRoot(): void { if (present(this.root)) owned(this.root, true) }
  private prepareRoot(): void { this.checkRoot(); ensurePrivateDirectory(this.root) }
  private readJson(name: string): unknown | null {
    this.checkRoot()
    const file = this.file(name)
    if (!present(file)) return null
    owned(file, false)
    if (lstatSync(file).size > 256 * 1024) throw new Error('Installation record exceeds its size limit')
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  private save(name: string, value: unknown): void {
    atomicWriteFileSync(this.file(name), `${JSON.stringify(value)}\n`, { requireCurrentUserOwner: true })
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
    if (!item || item.schema !== 1 || item.owner !== 'notifai' || item.target !== this.options.target ||
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
    return { active, pending: present(this.file('transaction.json')), source: installation?.source ?? null, channel: installation?.channel ?? null }
  }
  private versionDirectory(build: string): string {
    if (!buildId(build)) throw new Error('Invalid immutable build identifier')
    return this.file(path.join('versions', build))
  }
  private identity(inventory: ReleaseInventory, artifact: ReleaseArtifact): string {
    return hash(`${inventory.version}\0${artifact.target}\0${artifact.sha256}`)
  }
  private verifyFiles(directory: string, signedInventory: string): Omit<VerifiedVersion, 'directory'> {
    owned(directory, true)
    const inventory = this.options.distribution.verifyInventory(signedInventory)
    if (inventory.store_schema !== 1 || inventory.launcher_schema !== 1) throw new Error('This installer cannot establish store and launcher compatibility for the candidate')
    const artifact = inventory.artifacts.find(item => item.target === this.options.target)
    if (!artifact) throw new Error('Candidate does not contain this installation target')
    for (const [name, expected] of [[`notifai-runtime${this.extension}`, artifact.runtime_sha256], [`notifai${this.extension}`, artifact.launcher_sha256]]) {
      const file = path.join(directory, name!)
      owned(file, false)
      if (lstatSync(file).size > 512 * 1024 * 1024 || hash(readFileSync(file)) !== expected) throw new Error(`Candidate integrity mismatch: ${name}`)
    }
    for (const material of artifact.materials) {
      const file = path.join(directory, material.path)
      // Check each parent; an intermediate symlink is also outside the archive.
      let parent = path.dirname(file)
      while (parent !== directory) { owned(parent, true); parent = path.dirname(parent) }
      owned(file, false)
      if (lstatSync(file).size !== material.bytes || hash(readFileSync(file)) !== material.sha256) throw new Error(`Candidate material integrity mismatch: ${material.path}`)
    }
    return { inventory, artifact }
  }
  private verifyVersion(build: string): VerifiedVersion {
    this.checkRoot()
    owned(this.file('versions'), true)
    const directory = this.versionDirectory(build)
    owned(directory, true)
    const file = path.join(directory, 'inventory.json')
    owned(file, false)
    if (lstatSync(file).size > 256 * 1024) throw new Error('Version inventory is too large')
    const verified = this.verifyFiles(directory, readFileSync(file, 'utf8'))
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
    if (present(this.file('versions'))) owned(this.file('versions'), true)
    ensurePrivateDirectory(this.file('versions'))
    const destination = this.versionDirectory(build)
    if (present(destination)) { this.verifyVersion(build); return build }
    const staged = this.file(path.join('versions', `.staged-${randomUUID()}`))
    mkdirSync(staged, { mode: 0o700 })
    try {
      for (const name of [`notifai-runtime${this.extension}`, `notifai${this.extension}`, ...verified.artifact.materials.map(item => item.path)]) {
        atomicWriteFileSync(path.join(staged, name), readFileSync(path.join(input.directory, name)), { mode: [`notifai${this.extension}`, `notifai-runtime${this.extension}`].includes(name) ? 0o700 : 0o600, requireCurrentUserOwner: true })
      }
      atomicWriteFileSync(path.join(staged, 'inventory.json'), input.signedInventory, { requireCurrentUserOwner: true })
      this.verifyFiles(staged, input.signedInventory)
      withFileLock(this.file('installation.lock'), () => {
        if (present(destination)) this.verifyVersion(build)
        else renameSync(staged, destination)
      }, { waitMs: 5_000, strictRelease: true })
      return build
    } finally { if (present(staged)) rmSync(staged, { recursive: true }) }
  }

  private checkStable(record: InstallRecord | null, alternative?: InstallRecord): void {
    const bin = this.file('bin'), file = path.join(bin, `notifai${this.extension}`)
    if (present(bin)) owned(bin, true)
    if (!present(file)) {
      if (record) throw new Error('Owned stable command is missing; repair the installation')
      return
    }
    owned(file, false)
    const actual = hash(readFileSync(file))
    const records = [record, alternative].filter((entry): entry is InstallRecord => entry !== null && entry !== undefined)
    if (!records.some(entry => this.verifyVersion(entry.launcherBuild).artifact.launcher_sha256 === actual)) {
      throw new Error('Unowned stable command; preserve it and resolve the command collision')
    }
  }
  private transaction(value: unknown): Transaction {
    const item = value as Partial<Transaction> | null
    if (!item || item.schema !== 1 || !['activation', 'launcher'].includes(item.kind ?? '')) throw new Error('Invalid installation transaction')
    const from = item.from === null ? null : activeRecord(item.from), to = activeRecord(item.to)
    const previous = item.previous === null ? null : this.installRecord(item.previous), next = this.installRecord(item.next)
    const validGeneration = item.kind === 'launcher' ? from !== null && sameGeneration(from, to) :
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
    this.checkStable(transaction.previous, transaction.next)
    ensurePrivateDirectory(this.file('bin'))
    const stable = this.file(path.join('bin', `notifai${this.extension}`))
    try {
      if (!present(stable) || hash(readFileSync(stable)) !== next.artifact.launcher_sha256) {
        atomicWriteFileSync(stable, readFileSync(path.join(next.directory, `notifai${this.extension}`)), { mode: 0o700, preserveMode: false, requireCurrentUserOwner: true })
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
    atomicWriteFileSync(this.file('active.json'), activeBytes(transaction.to), { requireCurrentUserOwner: true })
    this.options.observe?.('activated')
    if (!sameGeneration(this.readActive(), transaction.to)) throw new Error('Active generation read-back failed')
    rmSync(this.file('transaction.json'))
  }
  recover(): InstallationStatus {
    if (!present(this.file('transaction.json'))) return this.inspect()
    this.prepareRoot()
    withFileLock(this.file('installation.lock'), () => {
      const value = this.readJson('transaction.json')
      if (value !== null) this.finish(this.transaction(value))
    }, { waitMs: 5_000, strictRelease: true })
    return this.inspect()
  }
  activate(input: { build: string; expectedGeneration: number; source: InstallSource; channel: ReleaseChannel }): ActivationResult {
    if (!['stable', 'beta'].includes(input.channel) || !['shell', 'powershell', 'npm', 'manual'].includes(input.source)) {
      throw new Error('Unknown installation source or channel')
    }
    const candidate = this.verifyVersion(input.build)
    this.probe(candidate.directory, candidate.inventory)
    if (input.channel === 'stable' && isPrerelease(candidate.inventory.version)) throw new Error('Prerelease cannot activate on stable')
    this.prepareRoot()
    return withFileLock(this.file('installation.lock'), () => {
      if (present(this.file('transaction.json'))) throw new Error('Recover the pending installation transaction first')
      const from = this.readActive(), previous = this.readInstall()
      if ((from?.generation ?? 0) !== input.expectedGeneration) throw new Error('Installation changed; inspect before retrying')
      if ((from === null) !== (previous === null)) throw new Error('Installation metadata is incomplete; repair it first')
      this.checkStable(previous)
      if (from?.active === input.build) return { changed: false, active: from, launcher_update_pending: previous!.launcherUpdatePending }
      if (from && compareReleasePrecedence(candidate.inventory.version, this.verifyVersion(from.active).inventory.version) !== 'after') {
        throw new Error('Use explicit rollback for a previous release; release identities cannot be replaced')
      }
      return this.commit(from, previous, input.build, input.source, input.channel)
    }, { waitMs: 5_000, strictRelease: true })
  }
  private commit(from: ActiveGeneration | null, previous: InstallRecord | null, build: string, source: InstallSource, channel: ReleaseChannel): ActivationResult {
    const to: ActiveGeneration = { schema: 1, active: build, previous: from?.active ?? null, generation: (from?.generation ?? 0) + 1 }
    const next: InstallRecord = { schema: 1, id: previous?.id ?? randomUUID(), owner: 'notifai', source: previous?.source ?? source,
      target: this.options.target, channel, previousChannel: previous?.channel ?? null, launcherBuild: build, launcherUpdatePending: false }
    const transaction: Transaction = { schema: 1, kind: 'activation', from, to, previous, next }
    this.save('transaction.json', transaction)
    this.options.observe?.('prepared')
    this.finish(transaction)
    return { changed: true, active: to, launcher_update_pending: transaction.next.launcherUpdatePending }
  }
  /** Explicit quiet-point retry. The active generation and rollback slot stay put. */
  repairLauncher(expectedGeneration: number): ActivationResult {
    this.prepareRoot()
    return withFileLock(this.file('installation.lock'), () => {
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
    }, { waitMs: 5_000, strictRelease: true })
  }
  rollback(expectedGeneration: number): ActivationResult {
    const snapshot = this.readActive()
    if (!snapshot?.previous) throw new Error('No previous verified generation is available')
    const candidate = this.verifyVersion(snapshot.previous)
    this.probe(candidate.directory, candidate.inventory)
    return withFileLock(this.file('installation.lock'), () => {
      if (present(this.file('transaction.json'))) throw new Error('Recover the pending installation transaction first')
      const from = this.readActive(), previous = this.readInstall()
      if (!sameGeneration(from, snapshot) || from?.generation !== expectedGeneration || !previous) throw new Error('Installation changed; inspect before rollback')
      this.checkStable(previous)
      if (!previous.previousChannel) throw new Error('Previous release channel is unavailable')
      return this.commit(from, previous, snapshot.previous!, previous.source, previous.previousChannel)
    }, { waitMs: 5_000, strictRelease: true })
  }
}
