import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import cmdShim from 'cmd-shim'
import { Distribution, releaseSigningMessage } from '../dist/release-distribution.js'
import { verifyNpmAdapterArtifact, npmAdapterPosixAccess } from '../dist/npm-adapter-verification.js'
import { adapterRoutesOnPath, environmentForVerifiedAdapter, inspectNpmAdapterRoute } from '../dist/npm-adapter-route.js'
import { generateAdapterManifest, bindAdapterInventory, hash } from '../../../scripts/npm-adapter-artifact.mjs'
import { prepareNativeLaunch } from './adapter.mjs'

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

test('linked or oversized package trees fail before starting an OS access batch', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  let calls = 0
  const checkAccess = () => { calls++ }
  const linked = path.join(f.proof.directory, 'linked')
  symlinkSync(f.root, linked)
  assert.throws(() => verifyNpmAdapterArtifact(f.proof.directory, f.distribution, checkAccess), /linked or non-regular/)
  rmSync(linked)
  for (let index = 0; index < 257; index++) writeFileSync(path.join(f.proof.directory, `unexpected-${index}`), '')
  assert.throws(() => verifyNpmAdapterArtifact(f.proof.directory, f.distribution, checkAccess), /too many paths/)
  assert.equal(calls, 0)
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
test('verified global POSIX adapters expose the exact prefix and retain the entire global bin', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, 'global'), env = { PATH: `${f.bin}:/unknown` }
  const routes = adapterRoutesOnPath(f.proof, env)
  assert.equal(routes[0].global_prefix, f.prefix)
  assert.equal(environmentForVerifiedAdapter(f.proof, env), env)
  const command = path.join(f.bin, 'notifai'); rmSync(command); symlinkSync('/bin/sh', command)
  assert.equal(inspectNpmAdapterRoute(command, f.proof), null)
})
test('Windows wrapper admission matches real npm templates and rejects appended or alternate executable code', async t => {
  const f = await fixture(t, 'npx', 'win32'), env = { Path: `${f.bin};C:\\unrelated;;C:\\unknown` }
  for (const name of ['notifai', 'notifai.cmd', 'notifai.ps1']) {
    assert.equal(inspectNpmAdapterRoute(path.join(f.bin, name), f.proof, f.options)?.kind, 'npx', name)
  }
  assert.equal(environmentForVerifiedAdapter(f.proof, env, f.options).Path, 'C:\\unrelated;;C:\\unknown')
  const command = path.join(f.bin, 'notifai.ps1'); writeFileSync(command, readFileSync(command, 'utf8') + 'Write-Host altered\n')
  assert.equal(inspectNpmAdapterRoute(command, f.proof, f.options), null)
  assert.equal(environmentForVerifiedAdapter(f.proof, env, f.options), env)
  const global = await fixture(t, 'global', 'win32')
  assert.equal(inspectNpmAdapterRoute(path.join(global.bin, 'notifai.cmd'), global.proof, global.options)?.global_prefix, global.prefix)
  assert.equal(environmentForVerifiedAdapter(global.proof, { Path: global.bin }, global.options).Path, global.bin)
})

test('old global native routes get exact-prefix repair while admitted and NPX routes retain native ownership', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, 'global'), original = { PATH: `${f.bin}:/unknown`, NOTIFAI_NPM_ADAPTER_ARTIFACT: '/forged/artifact' }
  let capability = false, probes = 0
  const platform = { capture: (_file, args) => { probes++; assert.deepEqual(args, ['self-check', '--json']);
    return { status: 0, stdout: JSON.stringify({ ok: true, ...(capability ? { capabilities: { npm_adapter_routes: 1 } } : {}) }) } } }
  const legacy = await prepareNativeLaunch(f.proof, { env: original, platform, existing: '/owned/native with spaces' })
  assert.equal(legacy.problem.code, 'native_adapter_routes_unsupported')
  assert.equal(legacy.problem.adapter_prefix, f.prefix)
  assert.deepEqual(legacy.problem.steps[0].args, ['uninstall', '--global', '--prefix', f.prefix, '@raidiant/notifai'])
  assert.deepEqual(legacy.problem.steps[1], { executable: '/owned/native with spaces', args: ['update'] })
  assert.equal(legacy.env.PATH, original.PATH)
  assert.equal(legacy.env.NOTIFAI_NPM_ADAPTER_ARTIFACT, f.proof.executable)
  assert.equal(original.NOTIFAI_NPM_ADAPTER_ARTIFACT, '/forged/artifact')
  capability = true
  assert.equal((await prepareNativeLaunch(f.proof, { env: original, platform, existing: '/owned/native with spaces' })).problem, null)
  const npx = await fixture(t)
  const admitted = await prepareNativeLaunch(npx.proof, { env: { PATH: `${npx.bin}:/unknown` }, platform, existing: '/owned/native' })
  assert.equal(admitted.env.PATH, '/unknown')
  assert.equal(admitted.problem, null); assert.equal(probes, 2)
})
