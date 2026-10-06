#!/usr/bin/env node
// Only the standalone CLI binaries are signed here. No Companion App target.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { repositoryRoot } from './cross-platform.mjs'

const { values } = parseArgs({ options: { directory: { type: 'string' }, 'expected-sha': { type: 'string' } } })
assert.ok(process.platform === 'darwin' && values.directory && /^[a-f0-9]{40}$/.test(values['expected-sha'] ?? ''), 'Exact native macOS candidate is required')
const directory = path.resolve(values.directory)
const build = JSON.parse(readFileSync(path.join(directory, 'notifai-runtime.build.json'), 'utf8'))
const policy = JSON.parse(readFileSync(path.join(repositoryRoot, 'distribution/release-materials.json'), 'utf8'))
assert.ok(policy.status === 'approved' && /^[A-Z0-9]{10}$/.test(policy.macos_team_id ?? ''), 'Reviewed Developer ID publisher is missing')
assert.ok(build.target === `bun-darwin-${process.arch}` && build.sourceRevision === values['expected-sha'] && build.sourceDirty === false, 'Native signing source identity differs')
const required = ['NOTIFAI_MACOS_CERTIFICATE_BASE64', 'NOTIFAI_MACOS_CERTIFICATE_PASSWORD', 'NOTIFAI_MACOS_SIGNING_IDENTITY',
  'NOTIFAI_NOTARY_KEY_BASE64', 'NOTIFAI_NOTARY_KEY_ID', 'NOTIFAI_NOTARY_ISSUER']
const credentials = Object.fromEntries(required.map(name => { assert.ok(process.env[name], 'Protected macOS signing readiness is incomplete'); return [name, process.env[name]] }))
for (const name of required) delete process.env[name]
const run = (command, args, timeout = 60_000) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env: process.env })
  // Never surface argv or a native failure object: password/key arguments may be present.
  // codesign receives no secret argument, so its own diagnosis is safe to show.
  if (command === '/usr/bin/codesign' && (result.error || result.status !== 0)) console.error(String(result.stderr ?? '').slice(-2000))
  assert.ok(!result.error && result.status === 0, `${path.basename(command)} failed during protected macOS finalization`)
  return { stdout: result.stdout, stderr: result.stderr }
}
// Apple accepts a submission before its ticket is visible to this machine's
// online lookup, and a lookup made too early keeps failing for minutes.
const TICKET_FIRST_CHECK_MS = 60_000, TICKET_RETRY_MS = 30_000, TICKET_WINDOW_MS = 12 * 60_000
const pause = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const notarizationTicket = file => {
  const deadline = Date.now() + TICKET_WINDOW_MS
  for (let attempts = 1; ; attempts += 1) {
    const result = spawnSync('/usr/bin/codesign', ['-vvvv', '-R=notarized', '--check-notarization', file],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: process.env })
    if (!result.error && result.status === 0) return { stdout: result.stdout, stderr: result.stderr, attempts }
    if (Date.now() >= deadline) console.error(String(result.stderr ?? '').slice(-2000))
    assert.ok(Date.now() < deadline, 'Apple notarization ticket did not become verifiable on this machine')
    pause(TICKET_RETRY_MS)
  }
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-sign-'))
const keychain = path.join(scratch, 'signing.keychain-db'), password = randomBytes(32).toString('hex')
const evidence = path.join(directory, 'platform-evidence')
mkdirSync(evidence) // Retry by reusing final artifacts, never silently re-signing them.
let keychainCreated = false, searchList = null
try {
  const certificate = path.join(scratch, 'certificate.p12'), key = path.join(scratch, 'notary.p8')
  writeFileSync(certificate, Buffer.from(credentials.NOTIFAI_MACOS_CERTIFICATE_BASE64, 'base64'), { mode: 0o600, flag: 'wx' })
  writeFileSync(key, Buffer.from(credentials.NOTIFAI_NOTARY_KEY_BASE64, 'base64'), { mode: 0o600, flag: 'wx' })
  run('/usr/bin/security', ['create-keychain', '-p', password, keychain]); keychainCreated = true
  run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain])
  run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain])
  // codesign's --keychain only narrows a search of the user's keychain list:
  // an identity in a keychain outside that list is reported as not found.
  const listed = run('/usr/bin/security', ['list-keychains', '-d', 'user']).stdout.split('\n')
    .map(line => line.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain, ...listed]); searchList = listed
  run('/usr/bin/security', ['import', certificate, '-k', keychain, '-P', credentials.NOTIFAI_MACOS_CERTIFICATE_PASSWORD, '-T', '/usr/bin/codesign'])
  run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain])
  const entitlementFile = path.join(repositoryRoot, 'distribution/macos-runtime.entitlements.plist')
  const members = {}
  for (const name of ['notifai', 'notifai-runtime']) {
    const file = path.join(directory, name)
    run('/usr/bin/codesign', ['--force', '--sign', credentials.NOTIFAI_MACOS_SIGNING_IDENTITY, '--keychain', keychain,
      '--options', 'runtime', '--timestamp', '--identifier', name === 'notifai' ? 'sh.notifai.cli' : 'sh.notifai.runtime',
      ...(name === 'notifai-runtime' ? ['--entitlements', entitlementFile] : []), file])
    const verification = run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', file])
    const identity = run('/usr/bin/codesign', ['--display', '--verbose=4', file])
    assert.ok(identity.stderr.includes(`TeamIdentifier=${policy.macos_team_id}\n`) &&
      identity.stderr.includes('Authority=Developer ID Application:') && /flags=.*\(runtime\)/.test(identity.stderr) &&
      /^Timestamp=/m.test(identity.stderr), 'Final macOS signing identity differs')
    const entitlements = run('/usr/bin/codesign', ['--display', '--entitlements', ':-', file])
    members[name] = hash(file)
    writeFileSync(path.join(evidence, `${name}-codesign.json`), JSON.stringify({ verification, identity, entitlements }) + '\n', { flag: 'wx' })
  }
  const uploadRoot = path.join(scratch, 'upload'); mkdirSync(uploadRoot)
  for (const name of Object.keys(members)) writeFileSync(path.join(uploadRoot, name), readFileSync(path.join(directory, name)), { mode: 0o755, flag: 'wx' })
  const upload = path.join(evidence, 'notarization.zip')
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', uploadRoot, upload])
  const auth = ['--issuer', credentials.NOTIFAI_NOTARY_ISSUER, '--key-id', credentials.NOTIFAI_NOTARY_KEY_ID, '--key', key]
  const submission = run('/usr/bin/xcrun', ['notarytool', 'submit', upload, ...auth, '--wait', '--timeout', '15m', '--output-format', 'json'], 16 * 60_000)
  writeFileSync(path.join(evidence, 'submission.json'), submission.stdout, { flag: 'wx' })
  const result = JSON.parse(submission.stdout)
  assert.ok(typeof result.id === 'string' && /^[a-f0-9-]{36}$/i.test(result.id), 'Notary submission identity is missing')
  run('/usr/bin/xcrun', ['notarytool', 'log', result.id, ...auth, path.join(evidence, 'notary-log.json')])
  assert.equal(result.status, 'Accepted', 'Apple has not accepted this candidate')
  const log = JSON.parse(readFileSync(path.join(evidence, 'notary-log.json'), 'utf8'))
  assert.equal(log.status, 'Accepted', 'Notary log does not confirm acceptance')
  pause(TICKET_FIRST_CHECK_MS)
  for (const name of Object.keys(members)) {
    assert.equal(hash(path.join(directory, name)), members[name], 'Signed executable changed during notarization')
    // spctl execute assessment is for app bundles, not raw CLI Mach-O code.
    const assessment = notarizationTicket(path.join(directory, name))
    writeFileSync(path.join(evidence, `${name}-notarization-ticket.json`), JSON.stringify(assessment) + '\n', { flag: 'wx' })
  }
  const receipt = { schema: 1, target: build.target, team_id: policy.macos_team_id,
    runtime_sha256: members['notifai-runtime'], launcher_sha256: members.notifai,
    notarization: { id: result.id, status: result.status, archive_sha256: hash(upload), members, issues: log.issues ?? [] },
    macos: run('/usr/bin/sw_vers', []).stdout,
    checks: ['codesign-strict', 'notarization-accepted', 'raw-code-notarization'] }
  writeFileSync(path.join(directory, 'platform-check.json'), JSON.stringify(receipt) + '\n', { flag: 'wx' })
} finally {
  if (searchList !== null) spawnSync('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...searchList], { stdio: 'ignore', timeout: 30_000 })
  if (keychainCreated) spawnSync('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'ignore', timeout: 30_000 })
  rmSync(scratch, { recursive: true, force: true })
}
