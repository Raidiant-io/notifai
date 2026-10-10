import { createHash } from 'node:crypto'
import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import type { InstallationAccess } from './installation-access.js'
import type { NpmAdapterAccessCheck, VerifiedNpmAdapter } from './npm-adapter-verification.js'
import { NPM_ADAPTER_INVENTORY, NPM_ADAPTER_MANIFEST } from './npm-adapter-contract.js'
import { LEGACY_NPM_RELEASES } from './legacy-npm-releases.js'
import { npmShim } from './npm-adapter-route.js'
import { canonicalPath } from './local-path.js'

interface PackageFile { path: string; bytes: number; sha256: string; identity: string; mode: number }
interface PackageDirectory { path: string; identity: string }
export interface LegacyNpmPackage {
  prefix: string
  prefix_identity: string
  directory: string
  version: string
  directories: PackageDirectory[]
  files: PackageFile[]
  shims: PackageFile[]
  /** These are preserved, not claimed to match a registry release. */
  dependency_files: number
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const identity = (file: string) => {
  const stat = lstatSync(file, { bigint: true })
  if (stat.ino <= 0n) throw new Error('Legacy npm physical identity is unavailable')
  return `${stat.dev}:${stat.ino}`
}
const safeName = (name: string) => name.length > 0 && name.length <= 240 &&
  !/[\\/:\0\r\n]/.test(name) && name !== '.' && name !== '..' && !/[. ]$/.test(name) &&
  !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)

/** Inspect one supplied Windows global layout without executing its contents.
 * This proves only package bytes, local ownership and exact command wrappers.
 * It does not establish the application's view, reader absence or permission
 * to replace custom dependency bytes. Callers must establish those separately. */
export function inspectLegacyNpmPackage(prefix: string, checkAccess: NpmAdapterAccessCheck): LegacyNpmPackage {
  if (!path.isAbsolute(prefix)) throw new Error('An absolute npm prefix is required')
  prefix = realpathSync(prefix)
  const directory = path.join(prefix, 'node_modules', '@raidiant', 'notifai')
  const directories: PackageDirectory[] = [], files: PackageFile[] = []
  let total = 0
  function inspect(file: string, isDirectory: boolean) {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Legacy npm contains a linked or non-regular path')
    }
    return stat
  }
  const accessPaths = [prefix, path.join(prefix, 'node_modules'), path.join(prefix, 'node_modules', '@raidiant')]
    .map(file => { inspect(file, true); return { file, directory: true } })
  function walk(relative: string) {
    if (directories.length + files.length >= 8192 || relative.split('/').length > 32) throw new Error('Legacy npm tree exceeds its bounds')
    const current = path.join(directory, relative)
    inspect(current, true)
    directories.push({ path: relative, identity: identity(current) })
    accessPaths.push({ file: current, directory: true })
    const names = readdirSync(current).sort(), normalized = new Set<string>()
    for (const name of names) {
      if (!safeName(name) || normalized.has(name.toLowerCase())) throw new Error('Ambiguous legacy npm path')
      normalized.add(name.toLowerCase())
      const local = relative ? `${relative}/${name}` : name, file = path.join(directory, local), stat = lstatSync(file)
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(local)
      else {
        inspect(file, false)
        if (files.length + directories.length >= 8192 || stat.size > 32 * 1024 * 1024 ||
            (total += stat.size) > 128 * 1024 * 1024) throw new Error('Legacy npm tree exceeds its bounds')
        accessPaths.push({ file, directory: false })
        files.push({ path: local, bytes: stat.size, sha256: '', identity: identity(file), mode: stat.mode & 0o777 })
      }
    }
  }
  walk('')
  // Reuse the OS access policy in bounded batches. No ACL is changed on
  // package-manager files, and POSIX UID bits never stand in for Windows ACLs.
  for (let i = 0; i < accessPaths.length; i += 256) checkAccess(accessPaths.slice(i, i + 256))
  for (const file of files) {
    const source = path.join(directory, file.path), bytes = readFileSync(source)
    if (bytes.length !== file.bytes || identity(source) !== file.identity) throw new Error('Legacy npm changed during inspection')
    file.sha256 = hash(bytes)
  }
  const manifest = files.find(file => file.path === 'package.json')
  if (!manifest || manifest.bytes > 256 * 1024) throw new Error('Legacy npm manifest is unavailable')
  const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown; bin?: { notifai?: unknown } }
  const release = typeof pkg.version === 'string' ? LEGACY_NPM_RELEASES[pkg.version] : undefined
  const published = files.filter(file => !file.path.startsWith('node_modules/'))
    .map(file => [file.path, file.bytes, file.sha256] as const).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  if (pkg.name !== '@raidiant/notifai' || pkg.bin?.notifai !== 'dist/main.js' || !release ||
      published.length !== release.files || hash(JSON.stringify(published)) !== release.sha256 ||
      directories.some(item => item.path && item.path !== 'node_modules' && !item.path.startsWith('node_modules/') &&
        !published.some(file => file[0].startsWith(`${item.path}/`)))) throw new Error('Legacy npm does not match an unchanged supported release')
  const shims = ['notifai', 'notifai.cmd', 'notifai.ps1'].map(name => {
    const file = path.join(prefix, name), stat = inspect(file, false)
    if (stat.size > 16 * 1024) throw new Error('Legacy npm shim exceeds its bounds')
    checkAccess([{ file, directory: false }])
    const bytes = readFileSync(file)
    if (bytes.toString('utf8').replaceAll('\r\n', '\n') !== npmShim('node_modules/@raidiant/notifai/dist/main.js', path.extname(name))) {
      throw new Error('Legacy npm command was modified or is not a supported npm shim')
    }
    return { path: name, bytes: bytes.length, sha256: hash(bytes), identity: identity(file), mode: stat.mode & 0o777 }
  })
  return { prefix, prefix_identity: identity(prefix), directory, version: pkg.version as string, directories, files, shims,
    dependency_files: files.length - published.length }
}

/** Copy the entire assessed package, including every dependency and shim, into
 * a new private directory. A snapshot preserves bytes; it does not keep cached
 * readers alive at their former paths or authorize overwriting customizations. */
export function snapshotLegacyNpmPackage(proof: LegacyNpmPackage, destination: string, access: InstallationAccess): string {
  if (!path.isAbsolute(destination)) throw new Error('Snapshot path must be absolute')
  destination = canonicalPath(destination)
  const relative = path.relative(proof.prefix, destination)
  if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error('Snapshot must be outside the npm prefix')
  }
  try { lstatSync(destination); throw new Error('Snapshot destination already exists') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  access.directory(destination)
  try {
    if (identity(proof.prefix) !== proof.prefix_identity) throw new Error('Legacy npm prefix changed before preservation')
    for (const entry of proof.directories) {
      if (identity(path.join(proof.directory, entry.path)) !== entry.identity) throw new Error('Legacy npm directory changed before preservation')
      access.directory(path.join(destination, 'package', entry.path))
    }
    access.directory(path.join(destination, 'shims'))
    for (const [root, folder, files] of [[proof.directory, 'package', proof.files], [proof.prefix, 'shims', proof.shims]] as const) {
      for (const item of files) {
        const source = path.join(root, item.path), target = path.join(destination, folder, item.path)
        if (identity(source) !== item.identity || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error('Legacy npm file changed before preservation')
        copyFileSync(source, target, constants.COPYFILE_EXCL)
        access.beforePublish(target)
        const descriptor = openSync(target, 'r+')
        try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
        const bytes = readFileSync(target)
        if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error('Legacy npm snapshot does not match the assessed bytes')
      }
    }
    const contents = `${JSON.stringify({ schema: 1, ...proof })}\n`
    atomicWriteFileSync(path.join(destination, 'snapshot.json'), contents, { requireCurrentUserOwner: true,
      prepareTemporary: access.beforePublish })
    return hash(contents)
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error }
}

/** Recheck the exact publication scope immediately before npm. During forward
 * recovery, missing files and authenticated replacement bytes are expected;
 * an unrecognized file or later edit is never permission to overwrite it.
 * This does not establish process quiescence or manager trust. */
export function assertNpmReplacementState(original: LegacyNpmPackage, replacement: VerifiedNpmAdapter,
  recovering: boolean, checkAccess: NpmAdapterAccessCheck): void {
  if (identity(original.prefix) !== original.prefix_identity) throw new Error('Npm prefix identity changed')
  const old = new Map(original.files.map(file => [file.path, file]))
  const target = new Map(replacement.manifest.files.map(file => [file.path, file.sha256]))
  for (const name of [NPM_ADAPTER_MANIFEST, NPM_ADAPTER_INVENTORY]) {
    target.set(name, hash(readFileSync(path.join(replacement.directory, name))))
  }
  const seen = new Set<string>(), directories = new Set<string>(), accessPaths: Parameters<NpmAdapterAccessCheck>[0][number][] = []
  let total = 0
  function inspect(file: string, directory: boolean) {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Npm replacement scope contains a linked or non-regular path')
    accessPaths.push({ file, directory })
    return stat
  }
  for (const relative of ['', 'node_modules', 'node_modules/@raidiant']) inspect(path.join(original.prefix, relative), true)
  function walk(relative: string) {
    if (seen.size + directories.size >= 8192 || relative.split('/').length > 32) throw new Error('Npm replacement scope exceeds its bounds')
    const directory = path.join(original.directory, relative)
    inspect(directory, true)
    directories.add(relative)
    const previous = original.directories.find(item => item.path === relative)
    if (!recovering && (!previous || identity(directory) !== previous.identity)) throw new Error('Legacy npm directory changed')
    if (recovering && relative && !previous && ![...target.keys()].some(file => file.startsWith(`${relative}/`))) throw new Error('Npm replacement contains a new directory')
    const names = new Set<string>()
    for (const name of readdirSync(directory)) {
      if (!safeName(name) || names.has(name.toLowerCase())) throw new Error('Ambiguous npm replacement path')
      names.add(name.toLowerCase())
      const local = relative ? `${relative}/${name}` : name, file = path.join(original.directory, local), stat = lstatSync(file)
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(local)
      else {
        inspect(file, false)
        if (seen.size + directories.size >= 8192 || stat.size > 32 * 1024 * 1024 ||
            (total += stat.size) > 128 * 1024 * 1024) throw new Error('Npm replacement scope exceeds its bounds')
        const digest = hash(readFileSync(file)), previous = old.get(local)
        const unchanged = previous?.sha256 === digest && previous.identity === identity(file)
        if (!unchanged && !(recovering && target.get(local) === digest)) throw new Error('Npm replacement would overwrite a new or modified file')
        seen.add(local)
      }
    }
  }
  try { walk('') } catch (error) {
    // Only the package root may be absent after a started manager. A missing
    // descendant during traversal is a concurrent change, not a safe gap.
    if (!recovering || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    let absent = false
    try { lstatSync(original.directory) } catch (missing) { absent = (missing as NodeJS.ErrnoException).code === 'ENOENT' }
    if (!absent || seen.size || directories.size) throw error
  }
  if (!recovering && (seen.size !== original.files.length || directories.size !== original.directories.length)) throw new Error('Legacy npm files changed')
  for (const shim of original.shims) {
    const file = path.join(original.prefix, shim.path)
    let stat
    try { stat = inspect(file, false) } catch (error) {
      if (recovering && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (stat.size > 16 * 1024) throw new Error('Npm shim exceeds its bounds')
    const bytes = readFileSync(file)
    if (hash(bytes) === shim.sha256 && identity(file) === shim.identity) continue
    const expected = npmShim('node_modules/@raidiant/notifai/bin/notifai.mjs', path.extname(shim.path))
    if (!recovering || bytes.toString('utf8').replaceAll('\r\n', '\n') !== expected) throw new Error('Npm replacement would overwrite a modified command')
  }
  for (let i = 0; i < accessPaths.length; i += 256) checkAccess(accessPaths.slice(i, i + 256))
}
