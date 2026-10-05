// Test-only executable. Uses the application's real storage/process adapters.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { withFileLock } from '../apps/cli/src/file-lock.js'
import { atomicWriteFileSync } from '../apps/cli/src/atomic-file.js'
import { currentProcessIdentity, processIdentityLiveness } from '../apps/cli/src/process-identity.js'
import { WindowsDpapiStore } from '../apps/cli/src/credentials.js'
import { Distribution } from '../apps/cli/src/release-distribution.js'
import { sameLocalPath } from '../apps/cli/src/local-path.js'

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
} else if (mode === 'heartbeat') {
  setInterval(() => writeFileSync(path.join(root, 'heartbeat'), String(Date.now())), 50)
} else throw new Error(`Unknown probe mode: ${mode}`)
