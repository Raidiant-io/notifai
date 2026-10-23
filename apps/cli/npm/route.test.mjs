import cmdShim from 'cmd-shim'
import assert from 'node:assert/strict'
import { generateKeyPairSync,sign } from 'node:crypto'
import { chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { bindAdapterInventory,generateAdapterManifest,hash } from '../../../scripts/npm-adapter-artifact.mjs'
import { environmentForVerifiedAdapter,inspectNpmAdapterRoute } from '../dist/npm-adapter-route.js'
import { npmAdapterPosixAccess,verifyNpmAdapterArtifact } from '../dist/npm-adapter-verification.js'
import { Distribution,releaseSigningMessage } from '../dist/release-distribution.js'

async function fixture(t, kind = 'npx', platform = process.platform) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai npm δ spaces-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const prefix = kind === 'npx' ? path.join(root, '_npx/cache') : path.join(root, 'prefix')
  const modules = kind === 'npx' || platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib/node_modules')
  const directory = path.join(modules, '@raidiant/notifai'), executable = path.join(directory, 'bin/notifai.mjs')
  mkdirSync(path.dirname(executable), { recursive: true })
  writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o755 })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@raidiant/notifai', version: '12.0.0-beta.1', bin: { notifai: 'bin/notifai.mjs' } }))
  const manifest = generateAdapterManifest(directory, '12.0.0-beta.1', 'a'.repeat(40))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from(JSON.stringify({ schema: 1, version: '12.0.0-beta.1', source_revision: 'a'.repeat(40), store_schema: 1, launcher_schema: 1,
    artifacts: [{ target: 'bun-linux-x64', filename: 'notifai-12.0.0-beta.1-linux-x64.tar.gz', bytes: 1, sha256: 'b'.repeat(64),
      runtime_sha256: 'b'.repeat(64), launcher_sha256: 'b'.repeat(64), materials: [{ path: 'npm-adapter-files.json', bytes: Buffer.byteLength(manifest), sha256: hash(manifest) }] }] }))
  const distribution = new Distribution({ fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
  bindAdapterInventory(directory, JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'), signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') }), distribution)
  // On POSIX these simulated Windows cases exercise npm's actual templates and
  // file graph with POSIX ownership, not Windows ACL or host integration proof.
  const checkAccess = process.platform === 'win32' ? _paths => {} : npmAdapterPosixAccess
  const proof = verifyNpmAdapterArtifact(directory, distribution, checkAccess)
  const bin = kind === 'npx' ? path.join(modules, '.bin') : platform === 'win32' ? prefix : path.join(prefix, 'bin')
  mkdirSync(bin, { recursive: true })
  if (platform === 'win32') await cmdShim(executable, path.join(bin, 'notifai'))
  else symlinkSync(executable, path.join(bin, 'notifai'))
  return { root, prefix, bin, proof, distribution, options: { platform, checkAccess } }
}

test('package proof batches every path once and rechecks access and hashes on each invocation', async t => {
  const f = await fixture(t), batches = []
  const checkAccess = paths => { batches.push(paths); f.options.checkAccess(paths) }
  verifyNpmAdapterArtifact(f.proof.directory, f.distribution, checkAccess)
  assert.equal(batches.length, 1)
  const paths = batches[0]
  assert.equal(new Set(paths.map(entry => entry.file)).size, paths.length)
  for (const name of ['package.json', 'inventory.json', 'npm-adapter-files.json', 'bin/notifai.mjs']) {
    assert.equal(paths.some(entry => entry.file === path.join(f.proof.directory, name) && !entry.directory), true, name)
  }
  assert.equal(paths.some(entry => entry.file === path.join(f.proof.directory, 'bin') && entry.directory), true)
  assert.throws(() => verifyNpmAdapterArtifact(f.proof.directory, f.distribution, entries => {
    assert.equal(entries.some(entry => entry.file === f.proof.executable), true)
    throw new Error('Foreign payload writer')
  }), /Foreign payload writer/)
  const bytes = readFileSync(f.proof.executable, 'utf8')
  writeFileSync(f.proof.executable, bytes.replace('node', 'evil'))
  assert.throws(() => verifyNpmAdapterArtifact(f.proof.directory, f.distribution, checkAccess), /integrity/)
  assert.equal(batches.length, 2)
})

test('route proof batches distinct ancestors and the Windows shim and rejects failed access', async t => {
  const f = await fixture(t, 'global', 'win32'), command = path.join(f.bin, 'notifai.cmd'), batches = []
  const options = { ...f.options, checkAccess: paths => { batches.push(paths); f.options.checkAccess(paths) } }
  assert.equal(inspectNpmAdapterRoute(command, f.proof, options)?.kind, 'global')
  assert.equal(batches.length, 1)
  assert.equal(new Set(batches[0].map(entry => entry.file)).size, batches[0].length)
  assert.equal(batches[0].some(entry => entry.file === f.prefix && entry.directory), true)
  assert.equal(batches[0].some(entry => entry.file === command && !entry.directory), true)
  assert.equal(inspectNpmAdapterRoute(command, f.proof, { ...options, checkAccess: () => { throw new Error('Foreign ancestor writer') } }), null)
})

test('verified POSIX NPX strips only its proven temporary insertion and preserves unknown entries', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), env = { PATH: `${f.bin}:/unrelated::/unknown`, OTHER: 'unchanged' }
  assert.equal(inspectNpmAdapterRoute(path.join(f.bin, 'notifai'), f.proof)?.kind, 'npx')
  assert.deepEqual(environmentForVerifiedAdapter(f.proof, env), { PATH: '/unrelated::/unknown', OTHER: 'unchanged' })
  assert.equal(env.PATH.startsWith(f.bin), true)
  chmodSync(f.bin, 0o777)
  assert.equal(inspectNpmAdapterRoute(path.join(f.bin, 'notifai'), f.proof), null)
  assert.equal(environmentForVerifiedAdapter(f.proof, env), env)
})
