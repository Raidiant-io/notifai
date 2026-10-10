import { releaseMaterialPath } from './release-path.js'
import { isSemVer } from './version.js'

/** Shared by npm packaging and native route inspection. The signed native
 * inventory authenticates these bytes as an ordinary release material. */
export const NPM_ADAPTER_PACKAGE = '@raidiant/notifai'
export const NPM_ADAPTER_BIN = 'bin/notifai.mjs'
export const NPM_ADAPTER_MANIFEST = 'npm-adapter-files.json'
export const NPM_ADAPTER_INVENTORY = 'inventory.json'
export const NPM_ADAPTER_DIRECTORY = 'dist/npm/notifai'
export const NPM_ADAPTER_MAX_METADATA = 256 * 1024
export const NPM_ADAPTER_MAX_BYTES = 16 * 1024 * 1024
export interface NpmAdapterFile { path: string; bytes: number; sha256: string }
export interface NpmAdapterManifest {
  schema: 1
  package: typeof NPM_ADAPTER_PACKAGE
  adapter_version: string
  native: { version: string; source_revision: string; inventory_url: string }
  files: NpmAdapterFile[]
}

/** npm may install only this package and its three platform command shims. */
export function assertNpmAdapterPackage(value: unknown, manifest: NpmAdapterManifest): void {
  const pkg = value as Record<string, unknown> | null
  const bin = pkg?.['bin'] as Record<string, unknown> | null
  if (!pkg || pkg['name'] !== manifest.package || pkg['version'] !== manifest.adapter_version ||
      !bin || typeof bin !== 'object' || Array.isArray(bin) || Object.keys(bin).length !== 1 || bin['notifai'] !== NPM_ADAPTER_BIN ||
      ['scripts', 'dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies',
        'directories', 'man'].some(key => Object.hasOwn(pkg, key))) throw new Error('Invalid published npm adapter package contract')
}

export function npmAdapterInventoryUrl(version: string): string {
  if (version.length > 100 || !isSemVer(version)) throw new Error('Invalid npm adapter version')
  return `https://github.com/Raidiant-io/notifai/releases/download/v${version}/inventory.json`
}

export function parseNpmAdapterManifest(bytes: string): NpmAdapterManifest {
  if (Buffer.byteLength(bytes) > NPM_ADAPTER_MAX_METADATA) throw new Error('Npm adapter metadata is too large')
  const value = JSON.parse(bytes) as Partial<NpmAdapterManifest>
  if (!value || value.schema !== 1 || value.package !== NPM_ADAPTER_PACKAGE ||
      typeof value.adapter_version !== 'string' || !value.native ||
      value.native.version !== value.adapter_version ||
      typeof value.native.source_revision !== 'string' || !/^[a-f0-9]{40}$/.test(value.native.source_revision) ||
      value.native.inventory_url !== npmAdapterInventoryUrl(value.adapter_version) ||
      !Array.isArray(value.files) || value.files.length < 2 || value.files.length > 128) {
    throw new Error('Invalid npm adapter manifest')
  }
  const names = new Set<string>()
  let total = 0, previous = ''
  for (const item of value.files) {
    if (!item || !releaseMaterialPath(item.path) || item.path <= previous ||
        [NPM_ADAPTER_MANIFEST, NPM_ADAPTER_INVENTORY].includes(item.path.toLowerCase()) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > NPM_ADAPTER_MAX_BYTES ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error('Invalid npm adapter file')
    }
    const name = item.path.toLowerCase()
    if ([...names].some(other => other === name || other.startsWith(`${name}/`) || name.startsWith(`${other}/`))) {
      throw new Error('Conflicting npm adapter paths')
    }
    names.add(name); previous = item.path; total += item.bytes
  }
  if (total > NPM_ADAPTER_MAX_BYTES || !names.has('package.json') || !names.has(NPM_ADAPTER_BIN)) {
    throw new Error('Incomplete or oversized npm adapter payload')
  }
  return value as NpmAdapterManifest
}
