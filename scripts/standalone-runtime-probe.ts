// Test-only executable. Uses the application's real storage/process adapters.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { withFileLock } from '../apps/cli/src/file-lock.js'
import { atomicWriteFileSync } from '../apps/cli/src/atomic-file.js'
import { currentProcessIdentity, processIdentityLiveness } from '../apps/cli/src/process-identity.js'
import { WindowsDpapiStore } from '../apps/cli/src/credentials.js'
import { Installation } from '../apps/cli/src/installation.js'
import { Distribution } from '../apps/cli/src/release-distribution.js'
import { sameLocalPath } from '../apps/cli/src/local-path.js'
import { createSkillManifest, shippedSkillBundle, verifySkillBundle } from '../apps/cli/src/skill-integrity.js'

const [mode, root, ...args] = process.argv.slice(2)
assert.ok(root)
if (mode === 'lock') {
  const file = path.join(root, 'shared.json')
  for (let i = 0; i < 50; i++) withFileLock(`${file}.lock`, () => {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(state.future_field, 'preserve-me')
    atomicWriteFileSync(file, JSON.stringify({ ...state, count: state.count + 1 }))
  }, { waitMs: 15_000 })
} else if (mode === 'identity') {
  const identity = currentProcessIdentity()
  assert.ok(identity)
  assert.equal(processIdentityLiveness(identity), 'alive')
  assert.equal(processIdentityLiveness({ ...identity, start: 'a-different-process' }), 'gone')
} else if (mode === 'distribution') {
  const fixture = JSON.parse(readFileSync(path.join(root, 'signed-fixture.json'), 'utf8'))
  const distribution = new Distribution({ fixture: fixture.publicKey })
  const inventory = distribution.verifyInventory(fixture.inventory)
  assert.equal(inventory.version, '12.0.0')
  distribution.verifyArtifact(inventory.artifacts[0]!, Buffer.from('archive-fixture'))
} else if (mode === 'archive') {
  const { extractReleaseArchive } = await import('../apps/cli/src/release-archive.js')
  const fixture = JSON.parse(readFileSync(path.join(root, 'archive-fixture.json'), 'utf8'))
  const directory = await extractReleaseArchive({ distribution: new Distribution({ fixture: fixture.publicKey }),
    signedInventory: fixture.inventory, target: fixture.target, bytes: readFileSync(path.join(root, 'archive-fixture.bin')),
    parent: path.join(root, 'extracted') })
  assert.equal(readFileSync(path.join(directory, 'licenses', 'NOTICE.txt'), 'utf8'), 'Fixture notice')
} else if (mode === 'owner-launch') {
  const { currentRuntimeBuild, launchSelf } = await import('../apps/cli/src/launch-self.js')
  const { retainSessionRuntime } = await import('../apps/cli/src/runtime-build-retention.js')
  const { writeSessionState, readSessionState } = await import('../apps/cli/src/hook-session-state.js')
  const session = 'native-owner-fixture', reference = currentRuntimeBuild()
  assert.ok(reference)
  writeSessionState(session, process.env, { harness: 'claude-code' })
  const child = launchSelf(['owner-heartbeat', root], { cwd: root, env: process.env,
    retain: value => retainSessionRuntime(session, process.env, value) })
  assert.deepEqual(readSessionState(session, process.env).runtime_builds, [reference])
  process.stdout.write(JSON.stringify({ ...child, reference }))
} else if (mode === 'installation') {
  const fixture = JSON.parse(readFileSync(path.join(root, 'installation-fixture.json'), 'utf8'))
  const extension = process.platform === 'win32' ? '.exe' : ''
  const options = { root: path.join(root, '.notifai'), target: fixture.target,
    distribution: new Distribution({ fixture: fixture.publicKey }),
    probe(directory: string) {
      const result = spawnSync(path.join(directory, `notifai${extension}`), ['identity', root], { encoding: 'utf8', timeout: 20_000 })
      assert.equal(result.status, 0, result.stderr)
    } }
  const installation = new Installation(options)
  const first = installation.stage({ directory: fixture.directories[0], signedInventory: fixture.inventories[0] })
  const second = installation.stage({ directory: fixture.directories[1], signedInventory: fixture.inventories[1] })
  const operation = args[0]
  if (operation === 'first') {
    assert.equal(installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' }).active.active, first)
  } else if (operation === 'update') {
    const result = installation.activate({ build: second, expectedGeneration: 1, source: 'manual', channel: 'stable' })
    assert.equal(result.active.active, second)
    assert.equal(result.launcher_update_pending, process.platform === 'win32')
  } else if (operation === 'repair') {
    const before = installation.inspect().active
    assert.equal(installation.repairLauncher(2).launcher_update_pending, false)
    assert.deepEqual(installation.inspect().active, before)
    assert.equal(installation.rollback(2).active.active, first)
    const interrupted = new Installation({ ...options, observe(phase) { if (phase === 'metadata') throw new Error('interrupted') } })
    assert.throws(() => interrupted.activate({ build: second, expectedGeneration: 3, source: 'manual', channel: 'stable' }), /interrupted/)
    assert.equal(installation.recover().active?.active, second)
    assert.equal(installation.inspect().pending, false)
  } else throw new Error('Unknown installation operation')
} else if (mode === 'skills') {
  const { SkillInstallation } = await import('../apps/cli/src/skill-installation.js')
  const bundled = shippedSkillBundle()
  assert.ok(bundled.ok)
  const installer = new SkillInstallation({ cwd: root, env: process.env })
  const oldSource = path.join(root, 'previous-skill'), oldSkill = path.join(oldSource, 'notifai')
  mkdirSync(oldSkill, { recursive: true })
  writeFileSync(path.join(oldSkill, 'SKILL.md'), 'Previous verified fixture guidance\n')
  writeFileSync(path.join(oldSource, 'manifest.json'), JSON.stringify(createSkillManifest(oldSkill, '1.0.0')))
  const previous = verifySkillBundle(oldSource, '1.0.0')
  assert.ok(previous.ok)
  assert.ok(installer.reconcile({ scope: 'project', agents: ['claude-code'], bundle: previous.bundle }).ok)
  const interrupted = new SkillInstallation({ cwd: root, env: process.env, observe(phase) {
    if (phase === 'old-retained') throw new Error('simulated interruption')
  } })
  assert.equal(interrupted.reconcile({ scope: 'project', bundle: bundled.bundle }).ok, false)
  assert.equal(installer.inspect('project').pending, true)
  const installed = installer.reconcile({ scope: 'project', bundle: bundled.bundle })
  assert.ok(installed.ok, JSON.stringify(installed.conflicts))
  assert.equal(installed.placements.length, 1)
  const skill = installed.placements[0]!.path
  assert.equal(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), readFileSync(path.join(bundled.bundle.skillRoot, 'SKILL.md'), 'utf8'))
  writeFileSync(path.join(skill, 'user-note.md'), 'preserve my content')
  assert.equal(installer.remove('project').ok, false)
  assert.equal(readFileSync(path.join(skill, 'user-note.md'), 'utf8'), 'preserve my content')
} else if (mode === 'credentials') {
  assert.equal(process.platform, 'win32')
  const store = new WindowsDpapiStore({ ...process.env, LOCALAPPDATA: root })
  const sample = { machineId: 'mach_fixture', secret: 'fixture-only-no-account',
    baseUrl: 'https://example.test', machineName: 'fixture' }
  store.save(sample)
  assert.deepEqual(store.load(), sample)
  for (const file of readdirSync(path.join(root, 'notifai'))) {
    assert.ok(!readFileSync(path.join(root, 'notifai', file), 'utf8').includes(sample.secret))
  }
  store.clear()
  assert.equal(store.load(), null)
} else if (mode === 'io') {
  process.stdout.write(JSON.stringify({ args, input: readFileSync(0, 'utf8') }))
  process.stderr.write('probe-stderr')
  process.exitCode = 23
} else if (mode === 'location') {
  if (args[0]) assert.ok(sameLocalPath(process.execPath, args[0]), 'short and long executable paths name the same installation')
  process.stdout.write(process.execPath)
} else if (mode === 'detach') {
  assert.equal(process.platform, 'win32')
  const child = spawnSync(path.join(path.dirname(process.execPath), 'notifai.exe'),
    ['--internal-detach', 'heartbeat', root], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  assert.equal(child.status, 0, child.stderr)
  process.stdout.write(child.stdout)
} else if (mode === 'tree') {
  const child = spawn(process.execPath, ['heartbeat', root], { stdio: 'ignore' })
  child.on('error', (error) => { throw error })
  writeFileSync(path.join(root, 'processes.json'), JSON.stringify({ parent: process.pid, child: child.pid }))
  setInterval(() => {}, 100)
} else if (mode === 'heartbeat' || mode === 'owner-heartbeat') {
  if (mode === 'owner-heartbeat') {
    const { currentRuntimeBuild } = await import('../apps/cli/src/launch-self.js')
    const { readSessionState } = await import('../apps/cli/src/hook-session-state.js')
    const reference = currentRuntimeBuild()
    assert.ok(reference)
    assert.ok(readSessionState('native-owner-fixture', process.env).runtime_builds?.some(item =>
      item.installation_id === reference.installation_id && item.build === reference.build), 'build reference must exist before the child starts')
  }
  writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ pid: process.pid, executable: process.execPath }))
  setInterval(() => writeFileSync(path.join(root, 'heartbeat'), String(Date.now())), 50)
} else throw new Error(`Unknown probe mode: ${mode}`)
