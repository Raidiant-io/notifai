import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { NPM_ADAPTER_BIN, NPM_ADAPTER_INVENTORY, NPM_ADAPTER_MANIFEST,
  NPM_ADAPTER_PACKAGE, npmAdapterInventoryUrl, parseNpmAdapterManifest } from '../apps/cli/dist/npm-adapter-contract.js'

export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
/** Generated package metadata is deliberately separate from the source workspace. */
export function adapterPackageManifest(source) {
  return { name: NPM_ADAPTER_PACKAGE, version: source.version, type: 'module',
    description: 'Launch the independently managed native Notifai CLI',
    bin: { notifai: NPM_ADAPTER_BIN }, files: ['bin', 'data', 'package.json', NPM_ADAPTER_MANIFEST,
      NPM_ADAPTER_INVENTORY, 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES', 'CHANGELOG.md'],
    engines: source.engines, license: source.license, author: source.author,
    homepage: source.homepage, bugs: source.bugs, repository: source.repository,
    publishConfig: source.publishConfig }
}

export function generateAdapterManifest(directory, version, sourceRevision) {
  const files = []
  function visit(relative = '') {
    const parent = path.join(directory, relative)
    const stat = lstatSync(parent)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Adapter payload directory must be regular')
    for (const name of readdirSync(parent).sort()) {
      const file = relative ? `${relative}/${name}` : name
      if ([NPM_ADAPTER_MANIFEST, NPM_ADAPTER_INVENTORY].includes(file)) continue
      const stat = lstatSync(path.join(directory, file))
      assert.ok(!stat.isSymbolicLink(), 'Adapter payload cannot contain symlinks')
      if (stat.isDirectory()) visit(file)
      else {
        assert.ok(stat.isFile(), 'Adapter payload must contain regular files')
        files.push({ path: file, bytes: stat.size, sha256: hash(readFileSync(path.join(directory, file))) })
      }
    }
  }
  visit()
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const bytes = JSON.stringify({ schema: 1, package: NPM_ADAPTER_PACKAGE, adapter_version: version,
    native: { version, source_revision: sourceRevision, inventory_url: npmAdapterInventoryUrl(version) }, files }, null, 2) + '\n'
  parseNpmAdapterManifest(bytes)
  writeFileSync(path.join(directory, NPM_ADAPTER_MANIFEST), bytes)
  return bytes
}

/** Second packaging phase: W3 supplies the final signed inventory after all
 * native targets embed the identical first-phase manifest as release material. */
export function bindAdapterInventory(directory, signedInventory, distribution) {
  const bytes = readFileSync(path.join(directory, NPM_ADAPTER_MANIFEST), 'utf8')
  const manifest = parseNpmAdapterManifest(bytes)
  const inventory = distribution.verifyInventory(signedInventory)
  assert.equal(inventory.version, manifest.native.version, 'Adapter/native versions differ')
  assert.equal(inventory.source_revision, manifest.native.source_revision, 'Adapter/native sources differ')
  for (const artifact of inventory.artifacts) {
    const material = artifact.materials.find(item => item.path === NPM_ADAPTER_MANIFEST)
    assert.ok(material && material.bytes === Buffer.byteLength(bytes) && material.sha256 === hash(bytes),
      'Every native target must authenticate the identical adapter manifest')
  }
  for (const file of manifest.files) {
    const stat = lstatSync(path.join(directory, file.path))
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === file.bytes &&
      hash(readFileSync(path.join(directory, file.path))) === file.sha256, 'Adapter bytes changed after native signing')
  }
  writeFileSync(path.join(directory, NPM_ADAPTER_INVENTORY), signedInventory, { mode: 0o644 })
}
