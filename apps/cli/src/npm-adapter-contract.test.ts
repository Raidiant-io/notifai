import { describe, expect, it } from 'vitest'
import { npmAdapterInventoryUrl, parseNpmAdapterManifest } from './npm-adapter-contract.js'

function manifest() {
  return { schema: 1, package: '@raidiant/notifai', adapter_version: '12.0.0-beta.1',
    native: { version: '12.0.0-beta.1', source_revision: 'a'.repeat(40), inventory_url: npmAdapterInventoryUrl('12.0.0-beta.1') },
    files: [{ path: 'bin/notifai.mjs', bytes: 1, sha256: 'b'.repeat(64) }, { path: 'package.json', bytes: 1, sha256: 'c'.repeat(64) }] }
}
describe('npm adapter release contract', () => {
  it('admits an exact beta release locator and required payload', () => {
    expect(parseNpmAdapterManifest(JSON.stringify(manifest())).native.version).toBe('12.0.0-beta.1')
  })
  it('rejects different native identity, untrusted origins and unbounded metadata', () => {
    for (const change of [{ version: '12.0.0' }, { source_revision: '../source' }, { inventory_url: 'https://example.com/inventory.json' }]) {
      const value = manifest(); Object.assign(value.native, change)
      expect(() => parseNpmAdapterManifest(JSON.stringify(value))).toThrow()
    }
    expect(() => parseNpmAdapterManifest(' '.repeat(256 * 1024 + 1))).toThrow(/large/)
  })
  it('rejects unsafe, conflicting, self-referential, missing and excessive payloads', () => {
    for (const name of ['../outside', 'C:/outside', 'bin\\outside', 'bin/NUL', 'inventory.json', 'npm-adapter-files.json']) {
      const value = manifest(); value.files[0]!.path = name
      expect(() => parseNpmAdapterManifest(JSON.stringify(value))).toThrow()
    }
    for (const files of [manifest().files.slice(1), [...manifest().files].reverse(),
      [...manifest().files, { path: 'PACKAGE.json', bytes: 1, sha256: 'b'.repeat(64) }].sort((a, b) => a.path < b.path ? -1 : 1)]) {
      expect(() => parseNpmAdapterManifest(JSON.stringify({ ...manifest(), files }))).toThrow()
    }
    const value = manifest(); value.files[0]!.bytes = 16 * 1024 * 1024
    expect(() => parseNpmAdapterManifest(JSON.stringify(value))).toThrow(/oversized/)
  })
})
