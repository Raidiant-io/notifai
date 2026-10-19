import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { planBetaRepair, repairNpmBeta, verifyRepairProvenance } from './repair-npm-beta.mjs'

const sourceRevision = 'a'.repeat(40), repository = 'https://github.com/Raidiant-io/notifai'
function fixture(t, name = '@raidiant/notifai-protocol') {
  const version = name.endsWith('protocol') ? '8.4.0' : '13.0.0'
  const tag = `${name.endsWith('protocol') ? 'protocol-v' : 'v'}${version}`, ref = `refs/tags/${tag}`
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-beta-repair-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const certificate = path.join(root, 'certificate'), key = path.join(root, 'key')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-nodes', '-subj', '/CN=synthetic-provenance',
    '-addext', `subjectAltName=URI:${repository}/.github/workflows/publish.yml@${ref}`, '-outform', 'DER', '-out', certificate, '-keyout', key], { stdio: 'pipe' })
  const tarball = Buffer.from('synthetic registry tarball')
  const statement = { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: `pkg:npm/${name.replace('@', '%40')}@${version}`, digest: { sha512: createHash('sha512').update(tarball).digest('hex') } }],
    predicate: { buildDefinition: { buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: { workflow: { repository, path: '.github/workflows/publish.yml', ref } },
      resolvedDependencies: [{ uri: `git+${repository}@${ref}`, digest: { gitCommit: sourceRevision } }] } } }
  const audit = { invalid: [], missing: [], verified: [{ name, version, registry: 'https://registry.npmjs.org/', attestationBundles: [
    { predicateType: statement.predicateType, bundle: {
      dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
      verificationMaterial: { certificate: { rawBytes: readFileSync(certificate).toString('base64') } },
    } },
  ] }] }
  const state = { tags: { latest: version, beta: `${version}-beta.1` }, verified: false, mutations: [], commands: [] }
  const run = (program, args, options = {}) => {
    state.commands.push({ program, args })
    if (program === 'git') return JSON.stringify({ name, version })
    if (program === process.execPath) { assert.ok(args.includes('scripts/require-ci-evidence.mjs')); return '' }
    assert.equal(program, 'npm')
    if (args[0] === 'install') {
      assert.ok(args.includes('--ignore-scripts'))
      const installed = path.join(options.cwd, 'node_modules', ...name.split('/'))
      mkdirSync(installed, { recursive: true }); writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name, version }))
      return ''
    }
    assert.deepEqual(args.slice(0, 4), ['audit', 'signatures', '--json', '--include-attestations'])
    state.verified = true
    return JSON.stringify(audit)
  }
  const fetchImpl = async address => {
    const url = String(address)
    if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: sourceRevision } })
    if (url.endsWith('/private-vulnerability-reporting')) return Response.json({ enabled: true })
    if (url.includes('/releases/tags/')) return Response.json({ tag_name: tag, immutable: true, prerelease: false })
    if (url.endsWith('/fixture.tgz')) return new Response(tarball)
    return Response.json({ name, version, dist: { tarball: 'https://registry.npmjs.org/fixture.tgz' } })
  }
  const options = { fetchImpl, run, lookup: async () => ({ ...state.tags }),
    admitMutation: () => { assert.equal(state.verified, true) },
    writeTag: async (pkg, write) => {
      assert.equal(state.verified, true); assert.equal(pkg, name); state.mutations.push(write)
      if (write.version === null) delete state.tags[write.tag]
      else state.tags[write.tag] = write.version
    } }
  return { root, name, version, tarball, audit, statement, state, options,
    provenance: { name, version, sourceRevision, tarball, audit } }
}

test('repair accepts only existing latest stable versions and changes beta alone', () => {
  assert.deepEqual(planBetaRepair({ name: '@raidiant/notifai-protocol', version: '8.4.0', before: { latest: '8.4.0', beta: '8.2.1-beta.2' } }), [{ tag: 'beta', version: '8.4.0' }])
  assert.deepEqual(planBetaRepair({ name: '@raidiant/notifai', version: '13.0.0', before: { latest: '13.0.0', beta: '13.0.0-beta.1' } }), [{ tag: 'beta', version: null }])
  assert.deepEqual(planBetaRepair({ name: '@raidiant/notifai', version: '13.0.0', before: { latest: '13.0.0', beta: '14.0.0-beta.1' } }), [])
  for (const candidate of [
    { name: '@raidiant/notifai', version: '13.0.1', before: { latest: '13.0.0' } },
    { name: '@raidiant/notifai', version: '13.0.1-beta.1', before: { latest: '13.0.1-beta.1' } },
    { name: 'other-package', version: '13.0.0', before: { latest: '13.0.0' } },
  ]) assert.throws(() => planBetaRepair(candidate))
})

test('verified provenance must bind the exact bytes, tag, source, package and workflow signer', t => {
  const f = fixture(t)
  verifyRepairProvenance(f.provenance)
  assert.throws(() => verifyRepairProvenance({ ...f.provenance, tarball: Buffer.from('substitution') }), /registry bytes/)
  assert.throws(() => verifyRepairProvenance({ ...f.provenance, sourceRevision: 'b'.repeat(40) }), /source differs/)
  assert.throws(() => verifyRepairProvenance({ ...f.provenance, version: '8.3.0' }), /exact requested/)
  const wrongWorkflow = structuredClone(f.audit)
  f.statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main'
  wrongWorkflow.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(f.statement)).toString('base64')
  assert.throws(() => verifyRepairProvenance({ ...f.provenance, audit: wrongWorkflow }), /workflow differs/)
  const otherSigner = fixture(t, '@raidiant/notifai'), wrongSigner = structuredClone(f.audit)
  wrongSigner.verified[0].attestationBundles[0].bundle.verificationMaterial = otherSigner.audit.verified[0].attestationBundles[0].bundle.verificationMaterial
  assert.throws(() => verifyRepairProvenance({ ...f.provenance, audit: wrongSigner }), /signer is not/)
  const unsigned = structuredClone(f.audit); unsigned.verified = []
  assert.throws(() => verifyRepairProvenance({ ...f.provenance, audit: unsigned }), /exact requested/)
})

test('a channel change during artifact verification aborts without overwriting it', async t => {
  const f = fixture(t), receiptPath = path.join(f.root, 'race.json')
  await assert.rejects(repairNpmBeta({ name: f.name, version: f.version, receiptPath }, {
    ...f.options, admitMutation: () => { f.state.tags.latest = '8.5.0' },
  }), /changed since/)
  assert.deepEqual(f.state.mutations, [])
  const receipt = JSON.parse(readFileSync(receiptPath))
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.before.latest, '8.4.0')
  assert.equal(receipt.after.latest, '8.5.0')
})

test('recovery acquires and authenticates without repacking, then repairs only beta and retains receipts', async t => {
  for (const name of ['@raidiant/notifai', '@raidiant/notifai-protocol']) {
    const f = fixture(t, name), receiptPath = path.join(f.root, 'receipt.json')
    const result = await repairNpmBeta({ name, version: f.version, receiptPath }, f.options)
    assert.equal(result.status, 'repaired')
    assert.equal(result.after.latest, f.version)
    assert.equal(result.after.beta, name.endsWith('protocol') ? f.version : undefined)
    assert.equal(f.state.mutations.length, 1)
    assert.deepEqual(JSON.parse(readFileSync(receiptPath)), result)
    assert.ok(f.state.commands.every(call => !call.args.some(arg => ['publish', 'pack', 'prepack', 'rebuild'].includes(arg))))
  }
})

test('read-only verification never mutates, and failed provenance blocks repair', async t => {
  const f = fixture(t)
  const result = await repairNpmBeta({ name: f.name, version: f.version, verifyOnly: true }, f.options)
  assert.equal(result.status, 'verified'); assert.deepEqual(f.state.mutations, [])
  f.audit.missing.push({ name: f.name })
  const receiptPath = path.join(f.root, 'failed.json')
  await assert.rejects(repairNpmBeta({ name: f.name, version: f.version, receiptPath }, f.options), /missing signatures/)
  assert.deepEqual(f.state.mutations, [])
  assert.equal(JSON.parse(readFileSync(receiptPath)).status, 'failed')
})
