import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packageStandalone } from './package-standalone.mjs'
import { Distribution, releaseSigningMessage } from '../apps/cli/dist/release-distribution.js'
import { extractReleaseArchive } from '../apps/cli/dist/release-archive.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(t, target) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-packaging-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'input'), materials = path.join(root, 'materials'), output = path.join(root, 'output')
  mkdirSync(directory); mkdirSync(materials)
  writeFileSync(path.join(materials, 'NOTICE.txt'), 'Fixture distribution material')
  const build = { version: '1.2.3', sourceRevision: 'a'.repeat(40), sourceDirty: false, sourceDigest: 'b'.repeat(64), target, runtime: 'bun-1.4.2' }
  const extension = target.includes('windows') ? '.exe' : ''
  writeFileSync(path.join(directory, `notifai${extension}`), 'fixture launcher')
  writeFileSync(path.join(directory, `notifai-runtime${extension}`), 'fixture runtime')
  writeFileSync(path.join(directory, `notifai-runtime${extension}.build.json`), JSON.stringify(build))
  writeFileSync(path.join(directory, 'check.json'), JSON.stringify({ ok: true, build,
    checks: ['isolated-no-runtime-path', 'embedded-skill-integrity', 'process-identity', 'cwd-config', 'BUN_OPTIONS', 'BUN_BE_BUN'],
    runtime_sha256: hash('fixture runtime'), launcher_sha256: hash('fixture launcher') }))
  return { root, directory, materials, output, extension }
}

for (const target of ['bun-linux-x64', 'bun-windows-arm64']) test(`packages checked bytes readable by the real ${target} distribution reader`, async t => {
  const f = fixture(t, target)
  const result = await packageStandalone(f)
  const again = await packageStandalone({ ...f, output: path.join(f.root, 'again') })
  assert.deepEqual(result, again, 'Identical inputs should produce identical archive identity')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from(JSON.stringify({ schema: 1, version: '1.2.3', source_revision: 'a'.repeat(40),
    store_schema: 1, launcher_schema: 1, artifacts: [result.artifact] }))
  const signedInventory = JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
    signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') })
  const distribution = new Distribution({ fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
  const extracted = await extractReleaseArchive({ distribution, signedInventory, target,
    bytes: readFileSync(path.join(f.output, result.artifact.filename)), parent: path.join(f.root, 'extract') })
  assert.equal(readFileSync(path.join(extracted, `notifai-runtime${f.extension}`), 'utf8'), 'fixture runtime')
  assert.equal(readFileSync(path.join(extracted, 'NOTICE.txt'), 'utf8'), 'Fixture distribution material')
  await assert.rejects(packageStandalone(f), /EEXIST/)
})

test('rejects changed executables, dirty source, and material collisions before writing an archive', async t => {
  const f = fixture(t, 'bun-linux-x64')
  writeFileSync(path.join(f.directory, 'notifai-runtime'), 'changed after checks')
  await assert.rejects(packageStandalone(f), /Runtime changed/)
  writeFileSync(path.join(f.directory, 'notifai-runtime'), 'fixture runtime')
  writeFileSync(path.join(f.materials, 'notifai'), 'collision')
  await assert.rejects(packageStandalone(f), /reserved path/)
  rmSync(path.join(f.materials, 'notifai'))
  const file = path.join(f.directory, 'check.json'), check = JSON.parse(readFileSync(file))
  check.build.sourceDirty = true
  writeFileSync(file, JSON.stringify(check))
  await assert.rejects(packageStandalone(f))
})
