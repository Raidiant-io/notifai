// Test-only executable. Uses the application's real storage/process adapters.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { withFileLock } from '../apps/cli/src/file-lock.js'
import { atomicWriteFileSync } from '../apps/cli/src/atomic-file.js'
import { currentProcessIdentity, processIdentityLiveness, processExecutableName, processStartTime } from '../apps/cli/src/process-identity.js'
import { inspectNativeFileUse, type NativeFileUse } from '../apps/cli/src/native-file-use.js'
import { WindowsDpapiStore } from '../apps/cli/src/credentials.js'
import { Installation } from '../apps/cli/src/installation.js'
import { Distribution } from '../apps/cli/src/release-distribution.js'
import { sameLocalPath } from '../apps/cli/src/local-path.js'
import { systemMonotonicNs } from '../apps/cli/src/monotonic-clock.js'
import { createSkillManifest, shippedSkillBundle, verifySkillBundle } from '../apps/cli/src/skill-integrity.js'

const [mode, rawRoot, ...args] = process.argv.slice(2)
const finishing = mode === 'uninstall' && rawRoot === '--finish'
const root = finishing ? path.dirname(args[args.indexOf('--installation-root') + 1]!) : rawRoot
assert.ok(root)
if (mode === 'hook') {
  assert.equal(root, 'stop')
  assert.deepEqual(args, ['--owner', 'notifai', '--harness', 'codex'])
  assert.ok(Number(process.env.NOTIFAI_HOOK_SOURCE_PID) > 0, 'native hooks must identify their harness parent')
  if (process.env.NOTIFAI_PROBE_PARENT_PID !== undefined) {
    assert.equal(process.env.NOTIFAI_HOOK_SOURCE_PID, process.env.NOTIFAI_PROBE_PARENT_PID,
      'native hook entry must capture its immediate caller, replacing inherited hook ancestry')
  }
  if (process.env.NOTIFAI_PROBE_HOOK_OUTPUT !== undefined) {
    writeFileSync(process.env.NOTIFAI_PROBE_HOOK_OUTPUT, process.env.NOTIFAI_HOOK_SOURCE_PID!)
  }
  process.stdout.write('native hook command executed')
} else if (mode === 'native-hooks') {
  const { inspectHookAdapter, installHookAdapter, hookAdapterTargetsArtifact } = await import('../apps/cli/src/hook-adapter.js')
  const { hookCommand } = await import('../apps/cli/src/install-hooks.js')
  const { inspectCliInstallations } = await import('../apps/cli/src/cli-bin.js')
  const adapter = inspectHookAdapter(root)
  assert.deepEqual(adapter.problems, [])
  assert.equal(adapter.target?.kind, 'native')
  assert.equal(installHookAdapter(adapter.target!, root).changed, false)
  assert.ok(hookAdapterTargetsArtifact(adapter.target, process.execPath))
  const installed = inspectCliInstallations({ ...process.env, PATH: path.dirname(adapter.path) }, process.platform)
  assert.ok(sameLocalPath(installed.effective!.artifact_path!, process.execPath))
  const command = hookCommand(adapter.path, 'stop', 'codex')
  const result = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 20_000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'native hook command executed')
  for (const inherited of [undefined, '2147483647']) {
    const env: NodeJS.ProcessEnv = { ...process.env, NOTIFAI_PROBE_PARENT_PID: String(process.pid) }
    if (inherited === undefined) delete env.NOTIFAI_HOOK_SOURCE_PID
    else env.NOTIFAI_HOOK_SOURCE_PID = inherited
    const direct = spawnSync(adapter.path, ['hook', 'stop', '--owner', 'notifai', '--harness', 'codex'],
      { env, encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert.equal(direct.status, 0, direct.stderr)
    assert.equal(direct.stdout, 'native hook command executed')
  }
  // Resident self-launches retain the original harness identity. Exercise the
  // real launchSelf path, including the Windows native detach boundary.
  const { launchSelf } = await import('../apps/cli/src/launch-self.js')
  const output = path.join(root, 'detached-hook-source')
  launchSelf(['hook', 'stop', '--owner', 'notifai', '--harness', 'codex'], {
    cwd: root, retain: () => {}, env: { ...process.env, NOTIFAI_HOOK_SOURCE_PID: String(process.pid),
      NOTIFAI_PROBE_PARENT_PID: String(process.pid), NOTIFAI_PROBE_HOOK_OUTPUT: output },
  })
  for (let i = 0; i < 100 && !existsSync(output); i++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(readFileSync(output, 'utf8'), String(process.pid))
  const { openclawPluginSource } = await import('../apps/cli/src/openclaw-plugin.js')
  const module = path.join(root, 'openclaw-readiness.mjs')
  writeFileSync(module, openclawPluginSource({ adapterPath: adapter.path, timeoutSeconds: 5 }) + `
import assert from 'node:assert/strict'
JOURNAL_DIR = path.join(${JSON.stringify(root)}, 'openclaw', 'notifai', 'continuation-journal')
assert.equal(writeReadiness({ script: ADAPTER }), true)
const receipt = JSON.parse(readFileSync(readinessPath(), 'utf8'))
assert.equal(receipt.pid, process.pid)
assert.ok(receipt.start)
if (process.platform === 'win32') assert.match(receipt.start, /^windows-filetime:[0-9]+$/)
clearReadiness()
assert.equal(existsSync(readinessPath()), false)
MESSAGE_JOURNAL_DIR = path.join(path.dirname(JOURNAL_DIR), 'message-journal')
const generation = '11111111-1111-4111-8111-111111111111', messageId = 'sm_host_fixture'
const deliveryId = createHash('sha256').update(generation + String.fromCharCode(0) + messageId).digest('hex').slice(0, 32)
saveMessageJournal({ delivery_id: deliveryId, message_id: messageId, generation,
  session_key: 'agent:main:main', cwd: process.cwd(), openclaw_session_id: 'host-fixture',
  native_revision: 'fixture', boot_id: GATEWAY_BOOT_ID, deadline_ns: '1234', attempt: 1,
  phase: 'transcript', ...(process.argv[2] === 'settle' ? {} : { text: 'pending fixture context' }) })
`)
} else if (mode === 'file-use') {
  const { inspectNativeFileUse } = await import('../apps/cli/src/native-file-use.js')
  const installed = path.join(root, '.notifai'), extension = process.platform === 'win32' ? '.exe' : ''
  const files = [path.join(installed, 'bin', `notifai${extension}`)]
  for (const build of readdirSync(path.join(installed, 'versions'))) {
    files.push(path.join(installed, 'versions', build, `notifai${extension}`), path.join(installed, 'versions', build, `notifai-runtime${extension}`))
  }
  let result = inspectNativeFileUse(path.join(path.dirname(process.execPath), `notifai${extension}`), files)
  const deadline = Date.now() + 15_000
  while (args[0] === 'clear' && result.status === 'in_use' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250))
    result = inspectNativeFileUse(path.join(path.dirname(process.execPath), `notifai${extension}`), files)
  }
  if (result.status === 'uncertain' || (args[0] === 'clear' && result.status !== 'clear')) {
    const raw = spawnSync(path.join(path.dirname(process.execPath), `notifai${extension}`), ['--internal-file-users', ...files],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    process.stderr.write(JSON.stringify({ observation: result, running: { pid: process.pid, parent: process.ppid }, names: result.processes.map(item => ({ ...item, name: processExecutableName(item.pid) })), native: { pid: raw.pid, status: raw.status, stdout: raw.stdout, stderr: raw.stderr, error: raw.error?.message } }) + '\n')
  }
  if (args[0] === 'clear') assert.deepEqual(result, { status: 'clear', processes: [] })
  else {
    assert.equal(result.status, 'in_use', JSON.stringify(result))
    assert.ok(result.processes.some(item => item.pid === Number(args[0])))
    assert.ok(result.processes.every(item => item.pid !== process.pid && item.pid !== process.ppid))
  }
  assert.equal(inspectNativeFileUse(path.join(path.dirname(process.execPath), `notifai${extension}`), [path.join(installed, 'absent')]).status, 'uncertain')
} else if (mode === 'host-state') {
  const { RuntimeRetention } = await import('../apps/cli/src/runtime-retention.js')
  const managed = path.join(root, '.notifai')
  const id = JSON.parse(readFileSync(path.join(managed, 'install.json'), 'utf8')).id
  const retention = new RuntimeRetention(managed, id)
  const inspected = retention.inspectOwners(path.join(root, 'no-sessions'))
  assert.ok(inspected.hosts.length > 0)
  assert.equal(inspected.hosts.length, readdirSync(path.join(managed, 'openclaw-hosts')).length)
  for (const host of inspected.hosts) assert.equal(processIdentityLiveness(host), 'gone')
  assert.equal(inspected.status, args[0])
} else if (mode === 'lock') {
  const file = path.join(root, 'shared.json')
  for (let i = 0; i < 50; i++) withFileLock(`${file}.lock`, () => {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(state.future_field, 'preserve-me')
    atomicWriteFileSync(file, JSON.stringify({ ...state, count: state.count + 1 }))
  }, { waitMs: 15_000 })
} else if (mode === 'account-home') {
  const { resolveHookAdapterHome } = await import('../apps/cli/src/hook-adapter.js')
  // The parent deliberately supplies a different HOME/USERPROFILE. OS identity
  // must not come from Bun's environment-derived os.userInfo().homedir.
  assert.throws(() => resolveHookAdapterHome(), /does not match this account's OS home/)
  assert.equal(resolveHookAdapterHome(root), root)
  assert.ok(sameLocalPath(resolveHookAdapterHome(undefined, {}), args[0]!))
} else if (mode === 'identity') {
  const identity = currentProcessIdentity()
  assert.ok(identity)
  assert.equal(processIdentityLiveness(identity), 'alive')
  assert.equal(processIdentityLiveness({ ...identity, start: 'a-different-process' }), 'gone')
} else if (mode === 'clock') {
  process.stdout.write(systemMonotonicNs().toString())
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
  const { assertNativeLaunchAllowed } = await import('../apps/cli/src/native-uninstall-barrier.js')
  assertNativeLaunchAllowed(process.env)
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
} else if (mode === 'installation' || mode === 'uninstall') {
  const fixture = JSON.parse(readFileSync(path.join(root, 'installation-fixture.json'), 'utf8'))
  const extension = process.platform === 'win32' ? '.exe' : ''
  const installationRoot = path.join(root, '.notifai')
  const fileUseObservations: Array<{ sequence: number; launcher: string; files: string[];
    own: ReturnType<typeof currentProcessIdentity>; parent_pid: number; observation: NativeFileUse }> = []
  let fileUseCalls = 0
  const options = { root: installationRoot, target: fixture.target,
    distribution: new Distribution({ fixture: fixture.publicKey }),
    ...(mode === 'uninstall' ? { fileUse(launcher: string, files: readonly string[]) {
      const sequence = ++fileUseCalls
      const observation = inspectNativeFileUse(launcher, files)
      // Keep the original filtered result; no extra process reads or logging
      // occur between successful scans. Raw probe/parent-start data is not exposed.
      if (fileUseObservations.length < 8) fileUseObservations.push({ sequence,
        launcher: path.relative(installationRoot, launcher), files: files.map(file => path.relative(installationRoot, file)),
        own: currentProcessIdentity(), parent_pid: process.ppid, observation })
      return observation
    } } : {}),
    probe(directory: string) {
      const result = spawnSync(path.join(directory, `notifai${extension}`), ['identity', root], { encoding: 'utf8', timeout: 20_000 })
      assert.equal(result.status, 0, result.stderr)
    } }
  const installation = new Installation(options)
  const operation = mode === 'uninstall' ? 'uninstall' : args[0]
  const first = operation === 'uninstall' ? '' : installation.stage({ directory: fixture.directories[0], signedInventory: fixture.inventories[0] })
  const second = operation === 'uninstall' ? '' : installation.stage({ directory: fixture.directories[1], signedInventory: fixture.inventories[1] })
  if (operation === 'first') {
    assert.equal(installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' }).active.active, first)
  } else if (operation === 'update') {
    const prepared = new Installation({ ...options, observe(phase) { if (phase === 'prepared') throw new Error('interrupted') } })
    assert.throws(() => prepared.activate({ build: second, expectedGeneration: 1, source: 'manual', channel: 'stable' }), /interrupted/)
    assert.equal(installation.abandonPending(1).active?.active, first)
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
    assert.equal(installation.abandonPending(3).active?.active, first)
    assert.equal(installation.inspect().pending, false)
    assert.throws(() => interrupted.activate({ build: second, expectedGeneration: 3, source: 'manual', channel: 'stable' }), /interrupted/)
    assert.equal(installation.recover().active?.active, second)
    assert.equal(installation.inspect().pending, false)
  } else if (operation === 'uninstall') {
    const sessions = path.join(root, 'no-sessions')
    const reportFailure = (stage: string, result: { status: string }, expected: string): void => {
      if (result.status === expected) return
      try {
        const identities = fileUseObservations.flatMap(item => item.observation.processes)
          .filter((item, index, all) => all.findIndex(other => other.pid === item.pid && other.start === item.start) === index)
        process.stderr.write(JSON.stringify({ diagnostic: 'uninstall-file-use', stage, result,
          uninstall_state: installation.uninstallState(), file_use_calls: fileUseCalls,
          observations_truncated: fileUseCalls > fileUseObservations.length, observations: fileUseObservations,
          original_parent_start: 'unavailable', original_probe_identity: 'unavailable',
          // These reads happen after failure, never substitute for the scan.
          after_failure: { own: currentProcessIdentity(), parent: { pid: process.ppid, start: processStartTime(process.ppid) },
            identities_truncated: identities.length > 8,
            identities: identities.slice(0, 8).map(item => ({ ...item,
              liveness: item.start ? processIdentityLiveness({ pid: item.pid, start: item.start }) : 'unknown',
              name: processExecutableName(item.pid) })) } }) + '\n')
      } catch (error) {
        process.stderr.write(JSON.stringify({ diagnostic: 'uninstall-file-use', stage, result,
          file_use_calls: fileUseCalls, observations_truncated: fileUseCalls > fileUseObservations.length,
          observations: fileUseObservations,
          diagnostic_error: error instanceof Error ? error.message : 'Diagnostic unavailable' }) + '\n')
      }
    }
    if (finishing) {
      const result = installation.finishUninstall(args[args.indexOf('--installation-id') + 1]!, sessions)
      reportFailure('finishUninstall', result, 'removed')
      assert.equal(result.status, 'removed', JSON.stringify(result))
      process.stdout.write(JSON.stringify(result))
      process.exit(0)
    }
    const begun = installation.beginUninstall(installation.inspect().active!.generation, sessions)
    reportFailure('beginUninstall', begun, 'preparing')
    assert.equal(begun.status, 'preparing', JSON.stringify(begun))
    if (begun.status !== 'preparing') throw new Error('Native uninstall did not prepare')
    const entered = installation.enterUninstallRemoval(begun.token, sessions)
    reportFailure('enterUninstallRemoval', entered, 'removing')
    assert.equal(entered.status, 'removing')
    const { readSessionState, sessionStatePath, sessionHasEnded } = await import('../apps/cli/src/hook-session-state.js')
    assert.ok(readSessionState('native-owner-fixture', process.env).runtime_builds?.length)
    const released = installation.releaseUninstallReferences(begun.token, sessions)
    reportFailure('releaseUninstallReferences', released, 'released')
    assert.equal(released.status, 'released')
    assert.deepEqual(JSON.parse(readFileSync(sessionStatePath('native-owner-fixture', process.env), 'utf8')).runtime_builds, [])
    assert.equal(sessionHasEnded('native-owner-fixture', process.env), false)
    assert.throws(() => installation.cancelUninstall(begun.token), /changed/)
    const result = installation.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] }))
    reportFailure('completeUninstall', result, process.platform === 'win32' ? 'incomplete' : 'removed')
    assert.equal(result.status, process.platform === 'win32' ? 'incomplete' : 'removed', JSON.stringify(result))
    if (process.platform !== 'win32') assert.equal(installation.inspect().active, null)
    else { assert.ok(result.recovery_command); process.stdout.write(JSON.stringify(result)) }
  } else if (operation === 'cleanup') {
    // Inject only boot identities. File publication, ownership checks, signed
    // inventory verification and deletion use the real native OS adapters.
    let boot = '11111111-1111-4111-8111-111111111111'
    const cleanup = new Installation({ ...options, root: path.join(root, 'cleanup-managed'), bootIdentity: () => boot })
    const builds: string[] = []
    for (let i = 0; i < 3; i++) {
      const build = cleanup.stage({ directory: fixture.directories[i], signedInventory: fixture.inventories[i] })
      builds.push(build)
      cleanup.activate({ build, expectedGeneration: i, source: 'manual', channel: 'stable' })
    }
    assert.deepEqual(cleanup.cleanup(3).removed, [])
    boot = '22222222-2222-4222-8222-222222222222'
    assert.deepEqual(cleanup.cleanup(3).removed, [builds[0]])
    assert.equal(cleanup.activeRelease().build, builds[2])
    assert.equal(cleanup.rollback(3).active.active, builds[1])
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
