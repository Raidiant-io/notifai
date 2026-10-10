import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packageStandalone } from './package-standalone.mjs'
import { nativeReleaseBundle } from './publish-native-assets.mjs'
import { assembleNativeRelease } from './assemble-native-release.mjs'
import { generateAdapterManifest } from './npm-adapter-artifact.mjs'
import { Distribution, RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (file, value) => writeFileSync(file, JSON.stringify(value))
async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-release-assembly-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input = path.join(root, 'input'), materials = path.join(root, 'materials')
  mkdirSync(input); mkdirSync(materials)
  writeFileSync(path.join(materials, 'NOTICE.txt'), 'Synthetic material for assembly tests only')
  const adapter = path.join(root, 'adapter')
  mkdirSync(path.join(adapter, 'bin'), { recursive: true })
  writeFileSync(path.join(adapter, 'package.json'), '{}')
  writeFileSync(path.join(adapter, 'bin/notifai.mjs'), 'fixture adapter')
  const adapterManifest = generateAdapterManifest(adapter, '1.0.0', 'a'.repeat(40))
  const adapterNotice = 'fixture npm redistribution notice'
  writeFileSync(path.join(materials, 'npm-adapter-files.json'), adapterManifest)
  mkdirSync(path.join(materials, 'licenses'))
  writeFileSync(path.join(materials, 'licenses/npm-cmd-shim.txt'), adapterNotice)
  const policy = { schema: 1, status: 'approved', runtime: 'bun-1.4.2', macos_team_id: 'FIXTURE123', targets: {} }
  for (const target of RELEASE_TARGETS) {
    const directory = path.join(input, target)
    mkdirSync(directory)
    const build = { version: '1.0.0', sourceRevision: 'a'.repeat(40), sourceDirty: false, sourceDigest: 'b'.repeat(64), target, runtime: 'bun-1.4.2' }
    const extension = target.includes('windows') ? '.exe' : ''
    const launcher = Buffer.from(`fixture launcher ${target}`), runtime = Buffer.from(`fixture runtime ${target}`)
    writeFileSync(path.join(directory, `notifai${extension}`), launcher)
    writeFileSync(path.join(directory, `notifai-runtime${extension}`), runtime)
    json(path.join(directory, `notifai-runtime${extension}.build.json`), build)
    json(path.join(directory, 'check.json'), { ok: true, build, capabilities: { local_continuity: 'notifai-session-state-v1' }, runtime_sha256: hash(runtime), launcher_sha256: hash(launcher),
      checks: ['isolated-no-runtime-path', 'embedded-skill-integrity', 'process-identity', 'cwd-config', 'BUN_OPTIONS', 'BUN_BE_BUN'] })
    const metadata = await packageStandalone({ directory, materials, output: path.join(directory, 'archive') })
    policy.targets[target] = metadata.artifact.materials.filter(m => !['npm-adapter-files.json', 'licenses/npm-cmd-shim.txt'].includes(m.path))
    json(path.join(directory, 'archive-check.json'), { ok: true, target, build, archive_sha256: metadata.artifact.sha256,
      archive_bytes: metadata.artifact.bytes, installed_bytes: 1024,
      checks: ['signed-archive-extraction', 'real-candidate-admission', 'fresh-managed-activation', 'mixed-bootstrap-reuse', 'installed-identity-without-runtime-path', 'raw-code-notarization'] })
    if (target.startsWith('bun-darwin-')) json(path.join(directory, 'platform-check.json'), {
      schema: 1, target, team_id: policy.macos_team_id, runtime_sha256: hash(runtime), launcher_sha256: hash(launcher),
      checks: ['codesign-strict', 'notarization-accepted', 'raw-code-notarization'],
    })
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { root, input, output: path.join(root, 'release'), version: '1.0.0', sourceRevision: 'a'.repeat(40), materialsPolicy: policy, adapterManifest, adapterNotice,
    keyId: 'fixture', privateKey, trustedKeys: { fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() } }
}
test('assembly binds final archives, materials and native receipts into one signed release without replacing output', async t => {
  const f = await fixture(t)
  const result = await assembleNativeRelease(f)
  const inventoryBytes = readFileSync(path.join(f.output, 'inventory.json'), 'utf8')
  const distribution = new Distribution(f.trustedKeys)
  const inventory = distribution.verifyInventory(inventoryBytes)
  const admitted = nativeReleaseBundle(f.output, distribution, f.sourceRevision)
  assert.equal(admitted.assets.size, 8)
  assert.throws(() => nativeReleaseBundle(f.output, distribution, 'f'.repeat(40)), /source differs/)
  assert.equal(result.inventory_sha256, hash(inventoryBytes))
  assert.equal(inventory.artifacts.length, 6)
  for (const artifact of inventory.artifacts) assert.equal(hash(readFileSync(path.join(f.output, artifact.filename))), artifact.sha256)
  assert.match(readFileSync(path.join(f.output, 'bootstrap.tsv'), 'utf8'), /^notifai-bootstrap-v1\t1\.0\.0\t/)
  await assert.rejects(assembleNativeRelease(f), /EEXIST/)
  assert.equal(readFileSync(path.join(f.output, 'inventory.json'), 'utf8'), inventoryBytes)
  const changed = inventory.artifacts[0].filename
  writeFileSync(path.join(f.output, changed), 'changed after admission')
  assert.throws(() => admitted.assets.get(changed).read(), /integrity mismatch/)
})
test('assembly refuses incomplete platform evidence and changed final bytes; failed staging leaves no publishable bundle', async t => {
  const f = await fixture(t)
  const receipt = path.join(f.input, 'bun-darwin-arm64', 'platform-check.json')
  const original = readFileSync(receipt)
  const changed = JSON.parse(original); changed.team_id = 'OTHER12345'; json(receipt, changed)
  await assert.rejects(assembleNativeRelease(f), /macOS publisher/)
  assert.equal(existsSync(f.output), false)
  writeFileSync(receipt, original)
  const metadata = JSON.parse(readFileSync(path.join(f.input, 'bun-windows-x64', 'archive', 'artifact.json')))
  const archive = path.join(f.input, 'bun-windows-x64', 'archive', metadata.artifact.filename)
  writeFileSync(archive, 'changed after native installation verification')
  await assert.rejects(assembleNativeRelease(f), /integrity mismatch/)
  assert.equal(existsSync(f.output), false)
})

test('assembly refuses adapter source skew and a target that omitted signed adapter bytes', async t => {
  const f = await fixture(t)
  await assert.rejects(assembleNativeRelease({ ...f, adapterManifest: f.adapterManifest.replace('a'.repeat(40), 'c'.repeat(40)) }), /source identity differs/)
  const metadataPath = path.join(f.input, 'bun-linux-x64/archive/artifact.json')
  const metadata = JSON.parse(readFileSync(metadataPath))
  metadata.artifact.materials = metadata.artifact.materials.filter(m => m.path !== 'npm-adapter-files.json')
  writeFileSync(metadataPath, JSON.stringify(metadata))
  await assert.rejects(assembleNativeRelease(f), /materials differ/)
  assert.equal(existsSync(f.output), false)
})
