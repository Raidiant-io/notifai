import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Distribution, releaseSigningMessage } from '../apps/cli/dist/release-distribution.js'
import { adapterPackageManifest, bindAdapterInventory, generateAdapterManifest, hash } from './npm-adapter-artifact.mjs'

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-adapter-artifact-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(path.join(directory, 'bin'))
  const source = JSON.parse(readFileSync(new URL('../apps/cli/package.json', import.meta.url), 'utf8'))
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(adapterPackageManifest(source)))
  writeFileSync(path.join(directory, 'bin/notifai.mjs'), '#!/usr/bin/env node\n')
  return { directory, source }
}
test('payload bytes deterministically bind the existing identity without workspace runtime dependencies or hooks', t => {
  const { directory, source } = fixture(t)
  const bytes = generateAdapterManifest(directory, source.version, 'a'.repeat(40))
  assert.equal(generateAdapterManifest(directory, source.version, 'a'.repeat(40)), bytes)
  const manifest = JSON.parse(bytes), pkg = JSON.parse(readFileSync(path.join(directory, 'package.json')))
  assert.equal(pkg.name, '@raidiant/notifai'); assert.equal(pkg.version, source.version)
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.scripts, undefined)
  for (const file of manifest.files) assert.equal(file.sha256, hash(readFileSync(path.join(directory, file.path))))
  symlinkSync(path.join(directory, 'package.json'), path.join(directory, 'linked.json'))
  assert.throws(() => generateAdapterManifest(directory, source.version, 'a'.repeat(40)), /symlink/)
})
test('finalization admits only signed identical manifest materials and unchanged payload', t => {
  const { directory, source } = fixture(t)
  const bytes = generateAdapterManifest(directory, source.version, 'a'.repeat(40))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const distribution = new Distribution({ fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() })
  const inventory = { schema: 1, version: source.version, source_revision: 'a'.repeat(40), store_schema: 1, launcher_schema: 1,
    artifacts: [{ target: 'bun-linux-x64', filename: `notifai-${source.version}-linux-x64.tar.gz`, bytes: 1, sha256: 'b'.repeat(64),
      launcher_sha256: 'b'.repeat(64), runtime_sha256: 'b'.repeat(64),
      materials: [{ path: 'npm-adapter-files.json', bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }] }] }
  const signed = value => { const payload = Buffer.from(JSON.stringify(value)); return JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
    signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') }) }
  bindAdapterInventory(directory, signed(inventory), distribution)
  assert.throws(() => bindAdapterInventory(directory, signed({ ...inventory, source_revision: 'c'.repeat(40) }), distribution), /sources/)
  assert.throws(() => bindAdapterInventory(directory, signed({ ...inventory, artifacts: [{ ...inventory.artifacts[0], materials: [] }] }), distribution), /identical/)
  writeFileSync(path.join(directory, 'bin/notifai.mjs'), 'changed')
  assert.throws(() => bindAdapterInventory(directory, signed(inventory), distribution), /changed/)
})
