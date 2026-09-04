import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { protocolPinFailure } from './verify-packed-install.mjs'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-packed-install.mjs')

/** Build a registry-shaped tarball (`package/package.json`) from a manifest. */
function fixtureTarball(directory, filename, manifest) {
  const staging = path.join(directory, `${filename}-staging`, 'package')
  mkdirSync(staging, { recursive: true })
  writeFileSync(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2))
  const tarball = path.join(directory, filename)
  execFileSync('tar', ['czf', tarball, 'package'], { cwd: path.dirname(staging) })
  return tarball
}

test('the gate fails a packed CLI whose manifest pins a stale protocol version', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-fixture-'))
  try {
    const protocolTarball = fixtureTarball(fixture, 'protocol.tgz', {
      name: '@raidiant/notifai-protocol',
      version: '0.6.0',
    })
    const cliTarball = fixtureTarball(fixture, 'cli.tgz', {
      name: '@raidiant/notifai',
      version: '9.9.9',
      bin: { notifai: 'dist/main.js' },
      // The defect class this gate exists for: the CLI ships pinned to a
      // protocol version other than the one packed beside it.
      dependencies: { '@raidiant/notifai-protocol': '0.5.0' },
    })

    const run = spawnSync(
      process.execPath,
      [script, '--cli-tarball', cliTarball, '--protocol-tarball', protocolTarball],
      { encoding: 'utf8' },
    )

    assert.equal(run.status, 1, `expected the gate to fail, got status ${run.status}\n${run.stdout}${run.stderr}`)
    assert.match(run.stderr, /Packed install verification FAILED/)
    assert.match(run.stderr, /@raidiant\/notifai-protocol@0\.5\.0/)
    assert.match(run.stderr, /the protocol packed beside it is 0\.6\.0/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('a pin equal to the packed protocol version passes the pin check', () => {
  const failure = protocolPinFailure(
    { name: '@raidiant/notifai', version: '9.9.9', dependencies: { '@raidiant/notifai-protocol': '0.6.0' } },
    '0.6.0',
  )
  assert.equal(failure, null)
})

test('a covering range is still a failure — resolution must not go to the registry', () => {
  const failure = protocolPinFailure(
    { name: '@raidiant/notifai', version: '9.9.9', dependencies: { '@raidiant/notifai-protocol': '^0.6.0' } },
    '0.6.0',
  )
  assert.match(String(failure), /must be exactly 0\.6\.0/)
})

test('a missing protocol dependency is a failure', () => {
  const failure = protocolPinFailure({ name: '@raidiant/notifai', version: '9.9.9', dependencies: {} }, '0.6.0')
  assert.match(String(failure), /declares no @raidiant\/notifai-protocol dependency/)
})

test('the packed-install script never spawns the third-party skills installer', () => {
  const source = readFileSync(script, 'utf8')
  assert.doesNotMatch(source, /nativeSkills\.add/u)
  assert.doesNotMatch(source, /skillsAddArgv/u)
  assert.doesNotMatch(source, /npxLaunch/u)
  assert.match(source, /phase: 'packed-npm-install'/u)
  assert.match(source, /stageShippedSkillBundle/u)
})
