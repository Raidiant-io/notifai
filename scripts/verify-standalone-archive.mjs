#!/usr/bin/env node
// CI verification only: an ephemeral test key admits one candidate locally.
// No production trust root, release publication, or channel mutation occurs.
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Distribution, releaseSigningMessage } from '../apps/cli/dist/release-distribution.js'
import { extractReleaseArchive } from '../apps/cli/dist/release-archive.js'
import { Installation } from '../apps/cli/dist/installation.js'
import { installationAccess } from '../apps/cli/dist/installation-access.js'
import { repositoryRoot } from './cross-platform.mjs'

assert.ok(process.argv[2], 'Usage: verify-standalone-archive.mjs <archive-directory>')
const notarized = process.argv[3] === '--notarized'
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && notarized && process.platform === 'darwin'), 'Invalid archive verification mode')
const directory = path.resolve(process.argv[2]), metadata = JSON.parse(readFileSync(path.join(directory, 'artifact.json'), 'utf8'))
const nativeTarget = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
assert.equal(metadata.build.target, nativeTarget, 'Archive verification requires its native target')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const distribution = new Distribution({ 'ci-only': publicKey.export({ type: 'spki', format: 'pem' }).toString() })
const payload = Buffer.from(JSON.stringify({ schema: 1, version: metadata.build.version, source_revision: metadata.build.sourceRevision,
  store_schema: 1, launcher_schema: 1, artifacts: [metadata.artifact] }))
const signedInventory = JSON.stringify({ key_id: 'ci-only', payload: payload.toString('base64'),
  signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') })
distribution.verifyInventory(signedInventory) // Validate the filename/size before reading a path from metadata.
const archiveFile = path.join(directory, metadata.artifact.filename)
assert.equal(statSync(archiveFile).size, metadata.artifact.bytes)
const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-archive-install-')), home = path.join(root, 'home')
mkdirSync(home)
const windows = process.platform === 'win32', extension = windows ? '.exe' : ''
try {
  const extracted = await extractReleaseArchive({ distribution, signedInventory, target: nativeTarget,
    bytes: readFileSync(archiveFile), parent: path.join(root, 'extracted') })
  if (notarized) {
    const policy = JSON.parse(readFileSync(path.join(repositoryRoot, 'distribution/release-materials.json'), 'utf8'))
    assert.match(policy.macos_team_id ?? '', /^[A-Z0-9]{10}$/)
    for (const name of ['notifai', 'notifai-runtime']) {
      const executable = path.join(extracted, name)
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', `-R=anchor apple generic and certificate leaf[subject.OU] = "${policy.macos_team_id}"`, executable], { timeout: 30_000 })
      execFileSync('/usr/bin/codesign', ['-vvvv', '-R=notarized', '--check-notarization', executable], { timeout: 60_000 })
    }
  }
  // An earlier non-native CLI leaves ~/.notifai/bin with ordinary inherited
  // permissions. The real OS access policy must still admit the installation.
  mkdirSync(path.join(home, '.notifai', 'bin'), { recursive: true })
  writeFileSync(path.join(home, '.notifai', 'bin', 'hook-adapter'), 'older CLI file')
  const installation = new Installation({ root: path.join(home, '.notifai'), target: nativeTarget, distribution,
    access: installationAccess(path.join(extracted, `notifai${extension}`)) })
  const candidate = { directory: extracted, signedInventory, channel: metadata.build.version.includes('-') ? 'beta' : 'stable' }
  assert.deepEqual(installation.recoverUninstallForInstall(candidate, path.join(root, 'sessions')), { status: 'unchanged' })
  const installed = installation.installCandidate({ ...candidate, source: 'manual' }) // Real candidate self-check; no probe mock.
  assert.equal(installed.reused, false)
  assert.equal(installed.version, metadata.build.version)
  const repeated = installation.installCandidate({ ...candidate, source: 'npm' })
  assert.equal(repeated.reused, true)
  assert.equal(repeated.changed, false)
  assert.deepEqual(repeated.active, installed.active)
  assert.equal(installation.inspect().source, 'manual', 'Rerunning another bootstrap must preserve installation ownership')
  const env = { HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
    PATH: windows ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin',
    ...(windows ? { SystemRoot: process.env.SystemRoot, APPDATA: home, LOCALAPPDATA: home } : {}) }
  const checked = JSON.parse(execFileSync(path.join(home, '.notifai', 'bin', `notifai${extension}`), ['self-check', '--json'],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000, windowsHide: true }))
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.build, metadata.build, 'Installed executable differs from checked archive identity')
  const size = directory => readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total +
    (entry.isDirectory() ? size(path.join(directory, entry.name)) : statSync(path.join(directory, entry.name)).size), 0)
  process.stdout.write(`${JSON.stringify({ ok: true, target: nativeTarget, build: metadata.build, archive_sha256: metadata.artifact.sha256,
    archive_bytes: metadata.artifact.bytes, installed_bytes: size(path.join(home, '.notifai')),
    checks: ['signed-archive-extraction', 'real-candidate-admission', 'fresh-managed-activation', 'mixed-bootstrap-reuse', 'installed-identity-without-runtime-path',
      ...(notarized ? ['raw-code-notarization'] : [])] })}\n`)
} finally { rmSync(root, { recursive: true, force: true }) }
