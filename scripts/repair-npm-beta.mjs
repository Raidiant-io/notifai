#!/usr/bin/env node
// Recovery changes discovery only. Registry bytes are acquired and authenticated,
// never rebuilt, repacked or republished.
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execCommand, repositoryRoot } from './cross-platform.mjs'
import { checkPublicProviderPosture, resolveTagCommit } from './check-public-provider-posture.mjs'
import { publicationLane, npmPromotion } from './publication-lane.mjs'
import { registryDistTags, promoteDistribution, waitForDistribution } from './verify-npm-distribution.mjs'

const repository = 'https://github.com/Raidiant-io/notifai'
const packages = new Map([['@raidiant/notifai', 'apps/cli/package.json'], ['@raidiant/notifai-protocol', 'packages/protocol/package.json']])
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const tagFor = (name, version) => `${name === '@raidiant/notifai' ? 'v' : 'protocol-v'}${version}`

export function planBetaRepair({ name, version, before }) {
  assert.ok(packages.has(name), 'Repair supports only the CLI and protocol packages')
  assert.equal(publicationLane(version), 'latest', 'Repair requires an already-published stable version')
  assert.equal(before.latest, version, 'Repair version must already be published under npm latest')
  const writes = npmPromotion({ name, version, before })
  assert.ok(writes.every(write => write.tag === 'beta'), 'Repair must never change npm latest')
  return writes
}

/** npm owns Sigstore/registry verification. This policy consumes only its
 * verified bundles, then binds the exact bytes and first-party build identity. */
export function verifyRepairProvenance({ name, version, sourceRevision, tarball, audit }) {
  assert.ok(Array.isArray(audit.invalid) && audit.invalid.length === 0 && Array.isArray(audit.missing) && audit.missing.length === 0,
    'npm signature audit has invalid or missing signatures')
  const entries = audit.verified?.filter(entry => entry.name === name && entry.version === version && entry.registry === 'https://registry.npmjs.org/')
  assert.equal(entries?.length, 1, 'npm must verify the exact requested package provenance')
  const bundles = entries[0].attestationBundles?.filter(entry => entry.predicateType === 'https://slsa.dev/provenance/v1')
  assert.equal(bundles?.length, 1, 'Exactly one verified SLSA provenance bundle is required')
  const bundle = bundles[0].bundle, envelope = bundle.dsseEnvelope
  assert.equal(envelope.payloadType, 'application/vnd.in-toto+json', 'Unexpected provenance envelope')
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'))
  const tag = tagFor(name, version), ref = `refs/tags/${tag}`
  assert.equal(new X509Certificate(Buffer.from(bundle.verificationMaterial.certificate.rawBytes, 'base64')).subjectAltName,
    `URI:${repository}/.github/workflows/publish.yml@${ref}`, 'Provenance signer is not the exact first-party release workflow')
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1')
  assert.equal(statement.predicateType, 'https://slsa.dev/provenance/v1')
  assert.deepEqual(statement.subject, [{ name: `pkg:npm/${name.replace('@', '%40')}@${version}`, digest: { sha512: hash('sha512', tarball) } }],
    'Verified provenance does not bind the acquired registry bytes')
  const definition = statement.predicate.buildDefinition
  assert.equal(definition.buildType, 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1')
  assert.deepEqual(definition.externalParameters.workflow, { ref, repository, path: '.github/workflows/publish.yml' },
    'Provenance workflow differs from the exact release tag')
  assert.ok(definition.resolvedDependencies.some(dependency => dependency.uri === `git+${repository}@${ref}` && dependency.digest?.gitCommit === sourceRevision),
    'Provenance source differs from the immutable release tag')
  return { source_revision: sourceRevision, source_tag: tag, tarball_sha512: hash('sha512', tarball), tarball_bytes: tarball.length }
}

export async function repairNpmBeta({ name, version, verifyOnly = false, receiptPath }, {
  fetchImpl = fetch,
  lookup = registryDistTags,
  run = (program, args, options = {}) => execCommand(program, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options }),
  writeTag,
  admitMutation = () => {},
} = {}) {
  const before = await lookup(name)
  const writes = planBetaRepair({ name, version, before })
  const tag = tagFor(name, version), token = process.env.GH_TOKEN
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-beta-repair-'))
  const receipt = { operation: verifyOnly ? 'verify-beta-repair' : 'repair-beta', name, version, before, planned_writes: writes, status: 'verifying' }
  const save = () => { if (receiptPath) writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }) }
  save()
  try {
    const sourceRevision = await resolveTagCommit(fetchImpl, tag, token)
    await checkPublicProviderPosture({ token, releaseTag: tag, expectedSha: sourceRevision }, fetchImpl)
    const manifest = JSON.parse(run('git', ['-C', repositoryRoot, 'show', `${sourceRevision}:${packages.get(name)}`]))
    assert.ok(manifest.name === name && manifest.version === version, 'Exact release tag has another package identity')
    run(process.execPath, ['scripts/require-ci-evidence.mjs', '--expected-sha', sourceRevision], { cwd: repositoryRoot })
    const metadataResponse = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    assert.ok(metadataResponse.ok, 'Repair version is not published')
    const metadata = await metadataResponse.json()
    assert.ok(metadata.name === name && metadata.version === version, 'Registry returned another package')
    const tarballUrl = new URL(metadata.dist.tarball)
    assert.ok(tarballUrl.origin === 'https://registry.npmjs.org' && !tarballUrl.username && !tarballUrl.password, 'Non-canonical registry artifact')
    const response = await fetchImpl(tarballUrl.href, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
    assert.ok(response.ok && response.body, 'Registry artifact download failed')
    const chunks = [], reader = response.body.getReader()
    let length = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.length
        assert.ok(length <= 64 * 1024 * 1024, 'Registry artifact exceeds the repair limit')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    assert.ok(length > 0, 'Registry artifact is empty')
    const tarball = Buffer.concat(chunks, length)
    writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ private: true, name: 'notifai-beta-repair-verification' }))
    // Installation is isolated and never executes package code or lifecycle scripts.
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--update-notifier=false', '--save-exact', '--registry=https://registry.npmjs.org', '--cache', path.join(scratch, 'cache'), `${name}@${version}`], { cwd: scratch })
    const installed = JSON.parse(readFileSync(path.join(scratch, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    assert.ok(installed.name === name && installed.version === version, 'Acquired package identity differs')
    const audit = JSON.parse(run('npm', ['audit', 'signatures', '--json', '--include-attestations', '--update-notifier=false', '--registry=https://registry.npmjs.org', '--cache', path.join(scratch, 'cache')], { cwd: scratch }))
    Object.assign(receipt, verifyRepairProvenance({ name, version, sourceRevision, tarball, audit }), { status: 'verified' })
    save()
    if (!verifyOnly) {
      await admitMutation()
      await promoteDistribution({ name, version, before }, { lookup, writeTag: writeTag ?? (async (pkg, write) => {
        run('npm', write.version === null ? ['dist-tag', 'rm', pkg, write.tag] : ['dist-tag', 'add', `${pkg}@${write.version}`, write.tag])
      }) })
      receipt.after = await waitForDistribution({ name, version, before }, { lookup })
      receipt.status = 'repaired'
      save()
    }
    return receipt
  } catch (error) {
    receipt.status = 'failed'
    receipt.error = error.message
    try { receipt.after = await lookup(name) } catch { /* preserve the last readable before state */ }
    save()
    throw error
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, name, version, receiptPath] = process.argv.slice(2)
  assert.ok(['verify', 'repair'].includes(command) && receiptPath, 'usage: repair-npm-beta.mjs verify|repair <package> <stable-version> <receipt-file>')
  const admitMutation = () => {
    assert.equal(process.env.GITHUB_REPOSITORY, 'Raidiant-io/notifai', 'Repair runs only in the first-party workflow')
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Repair runs only on main')
    assert.match(process.env.EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/)
    assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_SHA, 'Repair dispatch source differs')
    assert.equal(execCommand('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), process.env.EXPECTED_SHA, 'Repair checkout differs')
    assert.equal(execCommand('gh', ['api', 'repos/Raidiant-io/notifai/git/ref/heads/main', '--jq', '.object.sha'], { encoding: 'utf8', timeout: 30_000 }).trim(), process.env.EXPECTED_SHA,
      'Main advanced before repair; redispatch the reviewed source')
  }
  if (command === 'repair') admitMutation()
  console.log(JSON.stringify(await repairNpmBeta({ name, version, receiptPath, verifyOnly: command === 'verify' }, { admitMutation })))
}
