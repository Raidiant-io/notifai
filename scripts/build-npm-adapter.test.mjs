import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { createRequire } from 'node:module'
import { buildNpmAdapter } from './build-npm-adapter.mjs'
import { bindAdapterInventory, hash } from './npm-adapter-artifact.mjs'
import { execCommand } from './cross-platform.mjs'
import { Distribution, releaseSigningMessage } from '../apps/cli/dist/release-distribution.js'

const { extract } = createRequire(new URL('../apps/cli/package.json', import.meta.url))('tar-stream')

test('the staged adapter is deterministic, dependency-free and packs exactly its authenticated payload', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-generated-npm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = await buildNpmAdapter({ sourceRevision: 'a'.repeat(40), output: path.join(root, 'first') })
  const second = await buildNpmAdapter({ sourceRevision: 'a'.repeat(40), output: path.join(root, 'second') })
  assert.equal(first.manifest, second.manifest, 'The same source inputs must yield the same signed material')
  const manifest = JSON.parse(first.manifest), pkg = JSON.parse(readFileSync(path.join(first.directory, 'package.json')))
  assert.equal(pkg.scripts, undefined); assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.bin.notifai, 'bin/notifai.mjs')
  assert.ok(!manifest.files.some(file => file.path.startsWith('dist/') || file.path.startsWith('node_modules/')))
  assert.match(readFileSync(path.join(first.directory, 'THIRD_PARTY_NOTICES'), 'utf8'), /@zip.js\/zip.js@2.23.0/)
  execFileSync(process.execPath, ['--check', path.join(first.directory, pkg.bin.notifai)], { timeout: 10_000 })
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from(JSON.stringify({ schema: 1, version: pkg.version, source_revision: 'a'.repeat(40), store_schema: 1, launcher_schema: 1,
    artifacts: [{ target: 'bun-linux-x64', filename: `notifai-${pkg.version}-linux-x64.tar.gz`, bytes: 1,
      sha256: 'b'.repeat(64), runtime_sha256: 'b'.repeat(64), launcher_sha256: 'b'.repeat(64),
      materials: [{ path: 'npm-adapter-files.json', bytes: Buffer.byteLength(first.manifest), sha256: hash(first.manifest) }] }] }))
  bindAdapterInventory(first.directory, JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
    signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') }),
  new Distribution({ fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() }))
  const packed = path.join(root, 'packed'); mkdirSync(packed)
  const result = JSON.parse(execCommand('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packed], {
    cwd: first.directory, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }))
  const reader = extract(), names = [], bytes = new Map()
  const reading = (async () => { for await (const entry of reader) {
    assert.equal(entry.header.type, 'file')
    const relative = entry.header.name.replace(/^package\//, ''), chunks = []
    names.push(relative)
    for await (const chunk of entry) chunks.push(chunk)
    bytes.set(relative, Buffer.concat(chunks))
  } })()
  Readable.from(readFileSync(path.join(packed, result[0].filename))).pipe(createGunzip()).pipe(reader)
  await reading
  assert.deepEqual(names.sort(), [...manifest.files.map(file => file.path), 'inventory.json', 'npm-adapter-files.json'].sort())
  for (const file of manifest.files) assert.equal(hash(bytes.get(file.path)), file.sha256, `Packed payload changed: ${file.path}`)
})
