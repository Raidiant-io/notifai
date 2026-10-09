#!/usr/bin/env node
// Assemble exact final artifacts locally. No provider calls or release mutation.
import assert from 'node:assert/strict'
import { createHash, createPrivateKey } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Distribution, RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
import { extractReleaseArchive } from '../apps/cli/dist/release-archive.js'
import { signReleaseInventory } from './sign-release-records.mjs'
import { bootstrapInventoryText } from './generate-bootstrap-metadata.mjs'
import { repositoryRoot } from './cross-platform.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const regular = (file, limit = 256 * 1024) => {
  const stat = lstatSync(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Release input must be a bounded regular file')
  return readFileSync(file)
}
const json = file => JSON.parse(regular(file).toString('utf8'))
const directory = file => { const stat = lstatSync(file); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Release input directory cannot be linked') }
const archiveChecks = ['signed-archive-extraction', 'real-candidate-admission', 'fresh-managed-activation',
  'mixed-bootstrap-reuse', 'installed-identity-without-runtime-path']

export async function assembleNativeRelease({ input, output, version, sourceRevision, materialsPolicy, adapterManifest, adapterNotice, ...signing }) {
  directory(input)
  const roots = RELEASE_TARGETS.map(target => {
    const root = path.join(input, target)
    directory(root); directory(path.join(root, 'archive'))
    return root
  })
  const candidates = roots.map(root => json(path.join(root, 'archive', 'artifact.json')))
  const signedInventory = signReleaseInventory({ version, sourceRevision, materialsPolicy, adapterManifest, adapterNotice, candidates, ...signing })
  const distribution = new Distribution(signing.trustedKeys)
  const inventory = distribution.verifyInventory(signedInventory)
  // Verify receipts before creating any release output. Each is tied to the
  // final executable/archive bytes, not an earlier pre-signing build.
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i], candidate = candidates[i], artifact = inventory.artifacts[i]
    assert.equal(candidate.artifact.target, RELEASE_TARGETS[i], 'Target directory and candidate identity differ')
    const checkBytes = regular(path.join(root, 'check.json')), check = JSON.parse(checkBytes)
    assert.equal(hash(checkBytes), candidate.check_sha256, 'Executable receipt changed after packaging')
    assert.equal(check.ok, true, 'Native executable verification failed')
    assert.deepEqual(check.build, candidate.build, 'Native executable build differs')
    assert.equal(check.launcher_sha256, artifact.launcher_sha256)
    assert.equal(check.runtime_sha256, artifact.runtime_sha256)
    const installed = json(path.join(root, 'archive-check.json'))
    assert.ok(installed.ok === true && installed.target === artifact.target && installed.archive_sha256 === artifact.sha256 &&
      installed.archive_bytes === artifact.bytes && Number.isSafeInteger(installed.installed_bytes) && installed.installed_bytes > 0 &&
      archiveChecks.every(value => installed.checks?.includes(value)), 'Final native archive installation evidence is incomplete')
    assert.deepEqual(installed.build, candidate.build, 'Installed archive build differs')
    if (artifact.target.startsWith('bun-darwin-')) {
      assert.match(materialsPolicy.macos_team_id ?? '', /^[A-Z0-9]{10}$/, 'Reviewed macOS publisher is missing')
      const platform = json(path.join(root, 'platform-check.json'))
      assert.ok(platform.schema === 1 && platform.target === artifact.target && platform.team_id === materialsPolicy.macos_team_id &&
        platform.runtime_sha256 === artifact.runtime_sha256 && platform.launcher_sha256 === artifact.launcher_sha256 &&
        ['codesign-strict', 'notarization-accepted', 'raw-code-notarization'].every(value => platform.checks?.includes(value)) &&
        installed.checks.includes('raw-code-notarization'),
      'Final macOS publisher/notarization evidence is incomplete')
    }
  }
  mkdirSync(output, { mode: 0o700 }) // Exclusive: a retry never overwrites a prior bundle.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-release-admission-'))
  try {
    for (let i = 0; i < roots.length; i++) {
      const artifact = inventory.artifacts[i]
      const bytes = regular(path.join(roots[i], 'archive', artifact.filename), 256 * 1024 * 1024)
      // Re-parse exact final archives: receipt identity alone must not sign a
      // mismatched inner material/runtime inventory. No candidate is executed.
      const extracted = await extractReleaseArchive({ distribution, signedInventory, target: artifact.target, bytes, parent: scratch })
      rmSync(extracted, { recursive: true, force: true })
      writeFileSync(path.join(output, artifact.filename), bytes, { flag: 'wx', mode: 0o600 })
    }
    writeFileSync(path.join(output, 'inventory.json'), signedInventory, { flag: 'wx', mode: 0o600 })
    writeFileSync(path.join(output, 'bootstrap.tsv'), bootstrapInventoryText(distribution, signedInventory), { flag: 'wx', mode: 0o600 })
    const result = { schema: 1, version, source_revision: sourceRevision, inventory_sha256: hash(signedInventory),
      artifacts: inventory.artifacts.map(({ target, filename, bytes, sha256 }) => ({ target, filename, bytes, sha256 })) }
    writeFileSync(path.join(output, 'assembly.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 })
    return result
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error }
  finally { rmSync(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, version: { type: 'string' },
    'expected-sha': { type: 'string' }, 'key-id': { type: 'string' }, 'adapter-manifest': { type: 'string' } } })
  assert.ok(values.input && values.output && values.version && values['expected-sha'] && values['key-id'], 'Explicit input/output/version/source/key identity is required')
  assert.ok(Object.keys(RELEASE_PUBLIC_KEYS).length, 'Production release trust is not configured')
  assert.ok(process.env.NOTIFAI_RELEASE_SIGNING_KEY, 'Protected release signing key is unavailable')
  const privateKey = createPrivateKey(process.env.NOTIFAI_RELEASE_SIGNING_KEY)
  delete process.env.NOTIFAI_RELEASE_SIGNING_KEY
  assert.ok(values['adapter-manifest'], 'Release-bound npm manifest is required')
  const adapterManifest = readFileSync(values['adapter-manifest'], 'utf8')
  const adapterNotice = readFileSync(path.join(repositoryRoot, 'apps/cli/npm/SHIM-NOTICE'), 'utf8')
  const materialsPolicy = json(path.join(repositoryRoot, 'distribution', 'release-materials.json'))
  const result = await assembleNativeRelease({ input: path.resolve(values.input), output: path.resolve(values.output),
    version: values.version, sourceRevision: values['expected-sha'], keyId: values['key-id'], privateKey,
    trustedKeys: RELEASE_PUBLIC_KEYS, materialsPolicy, adapterManifest, adapterNotice })
  process.stdout.write(JSON.stringify(result) + '\n')
}
