import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'
import type { Distribution, ReleaseInventory } from './release-distribution.js'
import { NPM_ADAPTER_BIN, NPM_ADAPTER_INVENTORY, NPM_ADAPTER_MANIFEST,
  NPM_ADAPTER_MAX_METADATA, parseNpmAdapterManifest, type NpmAdapterManifest } from './npm-adapter-contract.js'

export interface VerifiedNpmAdapter {
  directory: string
  executable: string
  manifest: NpmAdapterManifest
  inventory: ReleaseInventory
  signedInventory: string
}
export interface NpmAdapterAccessPath { file: string; directory: boolean }
export type NpmAdapterAccessCheck = (paths: readonly NpmAdapterAccessPath[]) => void
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Windows callers must supply the existing OS ACL adapter. A POSIX UID or
 * package.json marker is never treated as Windows ownership evidence. */
export function npmAdapterPosixAccess(paths: readonly NpmAdapterAccessPath[]): void {
  if (process.platform === 'win32' || !process.getuid) throw new Error('Npm adapter ownership needs an OS access check')
  for (const { file } of paths) {
    const stat = lstatSync(file)
    if (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) throw new Error('Npm adapter path is not owned by this User')
  }
}

/** Verify release authority and every published payload byte. No PATH entry is
 * executed and no environment hint or package marker expands release trust. */
export function verifyNpmAdapterArtifact(directory: string, distribution: Pick<Distribution, 'verifyInventory'>,
  checkAccess: NpmAdapterAccessCheck = npmAdapterPosixAccess): VerifiedNpmAdapter {
  directory = path.resolve(directory)
  const paths: NpmAdapterAccessPath[] = []
  const files = new Map<string, Stats>()
  function inspect(file: string, isDirectory: boolean) {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Npm adapter contains a linked or non-regular path')
    }
    paths.push({ file, directory: isDirectory })
    return stat
  }
  inspect(directory, true)
  function collect(relative = '') {
    for (const name of readdirSync(path.join(directory, relative))) {
      if (paths.length > 256) throw new Error('Npm adapter contains too many paths')
      const local = relative ? `${relative}/${name}` : name, file = path.join(directory, local)
      const stat = lstatSync(file), isDirectory = stat.isDirectory()
      inspect(file, isDirectory)
      files.set(local, stat)
      if (isDirectory) collect(local)
    }
  }
  collect()
  // One bounded OS proof, including metadata and every payload, before any
  // bytes establish authority. Nothing is cached across verification calls.
  checkAccess(paths)
  function metadata(name: string): string {
    const file = path.join(directory, name), stat = files.get(name)
    if (!stat?.isFile()) throw new Error('Npm adapter metadata is missing or non-regular')
    if (stat.size > NPM_ADAPTER_MAX_METADATA) throw new Error('Npm adapter metadata exceeds its size limit')
    return readFileSync(file, 'utf8')
  }
  const manifestBytes = metadata(NPM_ADAPTER_MANIFEST)
  const signedInventory = metadata(NPM_ADAPTER_INVENTORY)
  const inventory = distribution.verifyInventory(signedInventory)
  const manifest = parseNpmAdapterManifest(manifestBytes)
  if (inventory.version !== manifest.native.version || inventory.source_revision !== manifest.native.source_revision ||
      !inventory.artifacts.every(artifact => artifact.materials.some(material => material.path === NPM_ADAPTER_MANIFEST &&
        material.bytes === Buffer.byteLength(manifestBytes) && material.sha256 === hash(manifestBytes)))) {
    throw new Error('Npm adapter manifest is not authenticated by its native release')
  }
  const expected = new Map(manifest.files.map(file => [file.path, file]))
  for (const [local, stat] of files) {
    const file = path.join(directory, local)
    if (stat.isDirectory()) {
      if (![...expected.keys()].some(item => item.startsWith(`${local}/`))) throw new Error('Unexpected npm adapter directory')
    } else {
      if ([NPM_ADAPTER_MANIFEST, NPM_ADAPTER_INVENTORY].includes(local)) continue
      const wanted = expected.get(local)
      if (!wanted || stat.size !== wanted.bytes || hash(readFileSync(file)) !== wanted.sha256) {
        throw new Error('Npm adapter payload integrity mismatch')
      }
      expected.delete(local)
    }
  }
  if (expected.size) throw new Error('Npm adapter payload is incomplete')
  const executable = path.join(directory, NPM_ADAPTER_BIN)
  const pkg = JSON.parse(metadata('package.json')) as { name?: unknown; version?: unknown; bin?: { notifai?: unknown }; scripts?: unknown; dependencies?: unknown }
  if (pkg.name !== manifest.package || pkg.version !== manifest.adapter_version || pkg.bin?.notifai !== NPM_ADAPTER_BIN ||
      pkg.scripts !== undefined || pkg.dependencies !== undefined) throw new Error('Invalid published npm adapter package contract')
  return { directory, executable, manifest, inventory, signedInventory }
}
