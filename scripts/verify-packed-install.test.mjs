import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { releaseSigningMessage, RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
import { adapterPackageManifest, generateAdapterManifest, hash } from './npm-adapter-artifact.mjs'
import { requireOwnedHostedAccount } from './verify-packed-install.mjs'
import { verifyPackedAdapter } from './verify-packed-npm-adapter.mjs'
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-proof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'package'), sourceRevision = 'a'.repeat(40)
  mkdirSync(path.join(directory, 'bin'), { recursive: true })
  const source = JSON.parse(readFileSync(new URL('../apps/cli/package.json', import.meta.url), 'utf8'))
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(adapterPackageManifest(source)))
  writeFileSync(path.join(directory, 'bin/notifai.mjs'), '#!/usr/bin/env node\nconsole.log("fixture adapter");\n', { mode: 0o755 })
  const manifest = generateAdapterManifest(directory, source.version, sourceRevision)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keys = { fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  const inventory = { schema: 1, version: source.version, source_revision: sourceRevision, store_schema: 1, launcher_schema: 1,
    artifacts: RELEASE_TARGETS.map(target => ({ target, filename: `notifai-${source.version}-${target.slice(4)}.${target.includes('windows') ? 'zip' : 'tar.gz'}`,
      bytes: 1, sha256: 'b'.repeat(64), runtime_sha256: 'c'.repeat(64), launcher_sha256: 'd'.repeat(64),
      materials: [{ path: 'npm-adapter-files.json', bytes: Buffer.byteLength(manifest), sha256: hash(manifest) }] })) }
  const save = value => { const payload = Buffer.from(JSON.stringify(value)); writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
    signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') })) }
  const pack = () => { const tarball = path.join(root, 'adapter.tgz'); execFileSync('tar', ['czf', tarball, 'package'], { cwd: root }); return tarball }
  save(inventory)
  return { directory, sourceRevision, version: source.version, keys, inventory, save, pack }
}
test('exact packed artifact binds adapter bytes to every signed native target and exact source', t => {
  const f = fixture(t)
  const verify = () => verifyPackedAdapter({ ...f, tarball: f.pack() })
  assert.equal(verify().source_revision, f.sourceRevision)
  writeFileSync(path.join(f.directory, 'bin/notifai.mjs'), 'modified payload')
  assert.throws(verify, /integrity/)
})
test('same version cannot admit foreign native source or missing manifest material', t => {
  const f = fixture(t)
  f.save({ ...f.inventory, source_revision: 'f'.repeat(40) })
  assert.throws(() => verifyPackedAdapter({ ...f, tarball: f.pack() }), /identity|source|authenticated/)
  f.save({ ...f.inventory, artifacts: f.inventory.artifacts.map(a => ({ ...a, materials: [] })) })
  assert.throws(() => verifyPackedAdapter({ ...f, tarball: f.pack() }), /material|authenticate/)
})
test('missing envelope and unmeasured npm files fail before adapter execution', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.directory, 'foreign.js'), 'unmeasured code')
  assert.throws(() => verifyPackedAdapter({ ...f, tarball: f.pack() }), /integrity/)
  rmSync(path.join(f.directory, 'foreign.js'))
  rmSync(path.join(f.directory, 'inventory.json'))
  assert.throws(() => verifyPackedAdapter({ ...f, tarball: f.pack() }))
})

test('real installation acceptance refuses local execution and a synthetic account home', () => {
  const account = path.resolve(os.tmpdir(), 'owned-account')
  assert.throws(() => requireOwnedHostedAccount({}, account), /disposable first-party/)
  assert.throws(() => requireOwnedHostedAccount({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Raidiant-io/notifai', HOME: account + '-fixture' }, account), /actual OS account/)
  assert.equal(requireOwnedHostedAccount({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Raidiant-io/notifai', HOME: account }, account), account)
})
