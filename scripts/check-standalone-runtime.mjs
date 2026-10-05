#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { repositoryRoot } from './cross-platform.mjs'

const { values } = parseArgs({ options: { launcher: { type: 'string' }, bun: { type: 'string', default: 'bun' } } })
assert.ok(values.launcher, '--launcher is required')
assert.equal(execFileSync(values.bun, ['--version'], { encoding: 'utf8' }).trim(), '1.4.2')
const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-runtime-'))
const windows = process.platform === 'win32'
if (windows) execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts/check-windows-user-path.mjs')], { stdio: 'inherit', timeout: 120_000 })
const extension = windows ? '.exe' : ''
const launcher = path.join(root, `notifai${extension}`)
const runtime = path.join(root, `notifai-runtime${extension}`)
const fixture = path.join(repositoryRoot, 'scripts/standalone-runtime-probe.ts')
const sourceBundle = path.join(root, 'probe.mjs')
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const env = { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root,
  PATH: windows ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin',
  // PowerShell needs PATHEXT to invoke .exe as a native command and wait for
  // its exit; omitting it can send even an absolute .exe through file association.
  ...(windows ? { SystemRoot: process.env.SystemRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD', LOCALAPPDATA: root, APPDATA: root } : {}),
}
function run(args, overrides = {}) {
  const result = spawnSync(launcher, args, { cwd: root, env, encoding: 'utf8', timeout: 90_000, ...overrides })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
}
function privateDirectory(directory) {
  if (windows) execFileSync(launcher, ['--internal-private-directory', directory], { cwd: root, env })
  else mkdirSync(directory, { recursive: true })
}
function privateFile(file) {
  if (windows) execFileSync(launcher, ['--internal-own-created-file', file], { cwd: root, env })
}
function worker(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('native storage worker timed out')) }, 60_000)
    child.stderr.on('data', data => { error += data })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(error))
    })
  })
}
try {
  copyFileSync(path.resolve(values.launcher), launcher)
  execFileSync(values.bun, ['build', '--compile', '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig', '--no-compile-autoload-package-json', '--no-compile-autoload-tsconfig',
    '--asset=apps/cli/dist/skill-source',
    '--define', `NOTIFAI_COMPILED_BUILD=${JSON.stringify({ runtime: 'bun-1.4.2-test-only', sourceDirty: false, target: `bun-${windows ? 'windows' : process.platform}-${process.arch}` })}`,
    fixture, '--outfile', runtime], { cwd: repositoryRoot, stdio: 'inherit' })
  execFileSync(values.bun, ['build', '--target=node', fixture, '--outfile', sourceBundle],
    { cwd: repositoryRoot, stdio: 'inherit' })
  run(['identity', root])
  run(['skills', root])
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const target = `bun-${windows ? 'windows' : process.platform}-${process.arch}`
  const dependency = createRequire(path.join(repositoryRoot, 'apps/cli/package.json'))
  const fixtureFiles = [[`notifai${extension}`, 'launcher'], [`notifai-runtime${extension}`, 'runtime'], ['licenses/NOTICE.txt', 'Fixture notice']]
  let archive
  if (windows) {
    const { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } = dependency('@zip.js/zip.js')
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true })
    for (const [name, value] of fixtureFiles) await writer.add(name, new Uint8ArrayReader(Buffer.from(value)))
    archive = await writer.close()
  } else {
    const writer = dependency('tar-stream').pack(), chunks = []
    const finished = (async () => { for await (const chunk of writer) chunks.push(chunk) })()
    for (const [name, value] of fixtureFiles) writer.entry({ name }, value)
    writer.finalize(); await finished
    archive = gzipSync(Buffer.concat(chunks))
  }
  const digest = value => createHash('sha256').update(value).digest('hex')
  const archivePayload = Buffer.from(JSON.stringify({ schema: 1, version: '1.0.0', source_revision: 'a'.repeat(40),
    store_schema: 1, launcher_schema: 1, artifacts: [{ target, filename: `notifai-1.0.0-${target.slice(4)}.${windows ? 'zip' : 'tar.gz'}`,
      bytes: archive.length, sha256: digest(archive), runtime_sha256: digest('runtime'), launcher_sha256: digest('launcher'),
      materials: [{ path: 'licenses/NOTICE.txt', bytes: 14, sha256: digest('Fixture notice') }] }] }))
  writeFileSync(path.join(root, 'archive-fixture.bin'), archive)
  writeFileSync(path.join(root, 'archive-fixture.json'), JSON.stringify({ target,
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    inventory: JSON.stringify({ key_id: 'fixture', payload: archivePayload.toString('base64'),
      signature: sign(null, Buffer.concat([Buffer.from('notifai-release-v1\ninventory\n'), archivePayload]), privateKey).toString('base64') }) }))
  run(['archive', root])
  const directories = [], inventories = []
  for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
    const directory = path.join(root, `candidate-${version}`)
    mkdirSync(directory)
    directories.push(directory)
    copyFileSync(runtime, path.join(directory, `notifai-runtime${extension}`))
    // A PE overlay changes the signed fixture hash while retaining executable behavior.
    const launcherBytes = windows ? Buffer.concat([readFileSync(launcher), Buffer.from(`fixture ${version}`)]) : readFileSync(launcher)
    writeFileSync(path.join(directory, `notifai${extension}`), launcherBytes, { mode: 0o700 })
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    const payload = Buffer.from(JSON.stringify({ schema: 1, version, source_revision: 'a'.repeat(40),
      store_schema: 1, launcher_schema: 1, artifacts: [{ target,
        filename: `notifai-${version}-${windows ? 'windows' : process.platform}-${process.arch}.${windows ? 'zip' : 'tar.gz'}`,
        bytes: 100, sha256: digest(version), runtime_sha256: digest(readFileSync(runtime)), materials: [], launcher_sha256: digest(launcherBytes) }] }))
    inventories.push(JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, Buffer.concat([Buffer.from('notifai-release-v1\ninventory\n'), payload]), privateKey).toString('base64') }))
  }
  writeFileSync(path.join(root, 'installation-fixture.json'), JSON.stringify({ target, directories, inventories,
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString() }))
  run(['installation', root, 'first'])
  const ownerRoot = path.join(root, 'retained-owner')
  mkdirSync(ownerRoot)
  execFileSync(path.join(root, '.notifai', 'bin', `notifai${extension}`), ['native-hooks', root], { cwd: root, env, stdio: 'inherit' })
  const owner = JSON.parse(execFileSync(path.join(root, '.notifai', 'bin', `notifai${extension}`), ['owner-launch', ownerRoot],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 }))
  const busyRoot = path.join(root, 'busy-launcher')
  mkdirSync(busyRoot)
  const busy = windows ? spawn(path.join(root, '.notifai', 'bin', 'notifai.exe'), ['heartbeat', busyRoot],
    { cwd: root, env, stdio: 'ignore' }) : null
  const ownerRuntime = path.join(root, '.notifai', 'versions', owner.reference.build, `notifai-runtime${extension}`)
  const fileUsers = () => JSON.parse(execFileSync(launcher, ['--internal-file-users', realpathSync.native(ownerRuntime)],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 }))
  try {
    if (busy) {
      for (let i = 0; i < 100 && !existsSync(path.join(busyRoot, 'heartbeat')); i++) await sleep(50)
      assert.ok(existsSync(path.join(busyRoot, 'heartbeat')), 'managed launcher must be running during replacement')
    }
    run(['installation', root, 'update'])
    for (let i = 0; i < 100 && !existsSync(path.join(ownerRoot, 'heartbeat')); i++) await sleep(50)
    assert.ok(existsSync(path.join(ownerRoot, 'heartbeat')), 'the detached owner must outlive the launching command')
    const ownerState = JSON.parse(readFileSync(path.join(ownerRoot, 'owner.json'), 'utf8'))
    assert.equal(realpathSync.native(ownerState.executable), realpathSync.native(path.join(root, '.notifai', 'versions', owner.reference.build, `notifai-runtime${extension}`)))
    assert.notEqual(JSON.parse(readFileSync(path.join(root, '.notifai', 'active.json'), 'utf8')).active, owner.reference.build)
    const before = readFileSync(path.join(ownerRoot, 'heartbeat'), 'utf8')
    await sleep(250)
    assert.notEqual(readFileSync(path.join(ownerRoot, 'heartbeat'), 'utf8'), before, 'old owner keeps running after activation')
    if (windows) {
      const start = execFileSync(launcher, ['--internal-process-info', String(owner.pid)],
        { cwd: root, env, encoding: 'utf8', timeout: 10_000 }).split(/\r?\n/)[0]
      const users = fileUsers()
      assert.ok(users.processes.some(item => item.pid === owner.pid && item.start === start),
        'Restart Manager must find the exact native owner of the registered executable')
    }
  } finally {
    try { process.kill(owner.pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
    if (busy) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('owned busy launcher did not exit')), 10_000)
        busy.once('exit', () => { clearTimeout(timer); resolve() })
        busy.kill()
      })
      await sleep(250)
    }
  }
  if (windows) {
    let users = fileUsers()
    for (let i = 0; i < 10 && users.processes.length > 0; i++) { await sleep(50); users = fileUsers() }
    assert.equal(users.reboot_reasons, 0, 'Released fixture resources must not require a reboot')
    assert.deepEqual(users.processes, [], 'Restart Manager must observe release after native owner exit')
  }
  run(['installation', root, 'repair'])
  run(['installation', root, 'cleanup'])
  const managedRoot = path.join(root, '.notifai')
  const activeBuild = JSON.parse(readFileSync(path.join(managedRoot, 'active.json'), 'utf8')).active
  const barrier = path.join(managedRoot, 'uninstall.json')
  writeFileSync(barrier, '{}', { mode: 0o600 })
  privateFile(barrier)
  try {
    for (const entry of [path.join(managedRoot, 'bin', `notifai${extension}`),
      path.join(managedRoot, 'versions', activeBuild, `notifai${extension}`),
      path.join(managedRoot, 'versions', owner.reference.build, `notifai${extension}`)]) {
      const blocked = spawnSync(entry, ['identity', root], { cwd: root, env, encoding: 'utf8', timeout: 20_000 })
      assert.equal(blocked.error, undefined)
      assert.equal(blocked.status, 1)
      assert.match(blocked.stderr, /uninstall is in progress/)
    }
    // Direct payload invocation still cannot use the JS detached-owner path.
    const blockedRoot = path.join(root, 'blocked-owner')
    mkdirSync(blockedRoot)
    const blocked = spawnSync(path.join(managedRoot, 'versions', activeBuild, `notifai-runtime${extension}`),
      ['owner-launch', blockedRoot], { cwd: root, env, encoding: 'utf8', timeout: 20_000 })
    assert.equal(blocked.error, undefined)
    assert.notEqual(blocked.status, 0)
    assert.match(blocked.stderr, /uninstall is in progress/)
    assert.equal(existsSync(path.join(blockedRoot, 'owner.json')), false)
  } finally { rmSync(barrier) }
  const payload = Buffer.from(JSON.stringify({ schema: 1, version: '12.0.0', source_revision: 'a'.repeat(40),
    store_schema: 1, launcher_schema: 1, artifacts: [{ target: 'bun-windows-x64',
      filename: 'notifai-12.0.0-windows-x64.zip', bytes: 15,
      sha256: createHash('sha256').update('archive-fixture').digest('hex'),
      runtime_sha256: 'c'.repeat(64), materials: [], launcher_sha256: 'd'.repeat(64) }] }))
  const signed = { key_id: 'fixture', payload: payload.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from('notifai-release-v1\ninventory\n'), payload]), privateKey).toString('base64') }
  const fixtureData = { publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(), inventory: JSON.stringify(signed) }
  writeFileSync(path.join(root, 'signed-fixture.json'), JSON.stringify(fixtureData))
  run(['distribution', root])
  signed.payload = Buffer.from(payload.toString().replace('12.0.0', '99.0.0')).toString('base64')
  writeFileSync(path.join(root, 'signed-fixture.json'), JSON.stringify({ ...fixtureData, inventory: JSON.stringify(signed) }))
  assert.notEqual(spawnSync(launcher, ['distribution', root], { cwd: root, env }).status, 0,
    'tampered signed metadata must fail under the native runtime')
  const args = ['', 'two words', 'quote"inside', 'trailing\\', '日本語 café', '--flag=value']
  const io = spawnSync(launcher, ['io', root, ...args], { cwd: root, env,
    input: 'stdin with Unicode: λ\n', encoding: 'utf8', timeout: 20_000 })
  assert.equal(io.error, undefined)
  assert.equal(io.status, 23)
  assert.equal(io.stderr, 'probe-stderr')
  assert.deepEqual(JSON.parse(io.stdout), { args, input: 'stdin with Unicode: λ\n' })
  const managed = path.join(root, 'managed')
  privateDirectory(managed)
  privateDirectory(path.join(managed, 'bin'))
  privateDirectory(path.join(managed, 'versions'))
  const stable = path.join(managed, 'bin', `notifai${extension}`)
  copyFileSync(launcher, stable)
  privateFile(stable)
  const builds = ['a'.repeat(64), 'b'.repeat(64)]
  const payloads = builds.map(build => {
    const directory = path.join(managed, 'versions', build)
    privateDirectory(directory)
    copyFileSync(launcher, path.join(directory, `notifai${extension}`))
    const payload = path.join(directory, `notifai-runtime${extension}`)
    copyFileSync(runtime, payload)
    privateFile(payload)
    privateFile(path.join(directory, `notifai${extension}`))
    return payload
  })
  // A stray sibling must never override the managed active pointer.
  writeFileSync(path.join(managed, 'bin', `notifai-runtime${extension}`), 'not an executable')
  for (let i = 0; i < builds.length; i++) {
    const state = JSON.stringify({ schema: 1, active: builds[i], previous: builds[i - 1] ?? null, generation: i + 1 })
    writeFileSync(path.join(managed, 'active.tmp'), `${state}\n`)
    privateFile(path.join(managed, 'active.tmp'))
    renameSync(path.join(managed, 'active.tmp'), path.join(managed, 'active.json'))
    assert.equal(realpathSync.native(execFileSync(stable, ['location', root, payloads[i]], { cwd: root, env, encoding: 'utf8' })), realpathSync.native(payloads[i]))
  }
  writeFileSync(path.join(managed, 'active.json'), '{"schema":1,"active":"../escape"}\n')
  assert.equal(spawnSync(stable, ['location', root], { cwd: root, env }).status, 1, 'invalid active path must fail closed')
  writeFileSync(path.join(root, 'shared.json'), JSON.stringify({ count: 0, future_field: 'preserve-me' }))
  // Both runtimes contend for the SAME lock and unknown-field-bearing document.
  const results = await Promise.allSettled([worker(launcher, ['lock', root]), worker(process.execPath, [sourceBundle, 'lock', root]),
    worker(launcher, ['lock', root]), worker(process.execPath, [sourceBundle, 'lock', root])])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'shared.json'), 'utf8')),
    { count: 200, future_field: 'preserve-me' })
  if (windows) {
    execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(repositoryRoot, 'scripts/check-windows-installation-access.ps1'),
        '-Launcher', launcher], { cwd: root, env, stdio: 'inherit', timeout: 60_000 })
    const permissions = path.join(root, 'permissions')
    privateDirectory(permissions)
    const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe')
    execFileSync(icacls, [permissions, '/grant', '*S-1-1-0:(OI)(CI)F'], { cwd: root, env, stdio: 'pipe' })
    assert.notEqual(spawnSync(launcher, ['--internal-check-private-directory', permissions], { cwd: root, env }).status, 0,
      'an additional writable principal must be refused')
    execFileSync(icacls, [permissions, '/remove:g', '*S-1-1-0'], { cwd: root, env, stdio: 'pipe' })
    execFileSync(launcher, ['--internal-check-private-directory', permissions], { cwd: root, env })
    const junction = path.join(permissions, 'junction')
    symlinkSync(root, junction, 'junction')
    assert.notEqual(spawnSync(launcher, ['--internal-check-private-directory', junction], { cwd: root, env }).status, 0,
      'a reparse point must be refused')
    rmSync(junction)
    const credentialRoot = path.join(root, 'credentials')
    mkdirSync(credentialRoot)
    run(['credentials', credentialRoot])
    const detachedRoot = path.join(root, 'detached')
    mkdirSync(detachedRoot)
    // The intermediate runtime exits, closing its foreground launcher job.
    // Its deliberate owner must remain independently alive until we stop it.
    const detachedPid = Number(execFileSync(launcher, ['detach', detachedRoot],
      { cwd: root, env, encoding: 'utf8', timeout: 20_000 }).trim())
    assert.ok(Number.isSafeInteger(detachedPid) && detachedPid > 0)
    try {
      for (let i = 0; i < 100 && !existsSync(path.join(detachedRoot, 'heartbeat')); i++) await sleep(50)
      assert.ok(existsSync(path.join(detachedRoot, 'heartbeat')), 'deliberately detached owner must survive foreground exit')
      const before = readFileSync(path.join(detachedRoot, 'heartbeat'), 'utf8')
      await sleep(250)
      assert.notEqual(readFileSync(path.join(detachedRoot, 'heartbeat'), 'utf8'), before)
    } finally { process.kill(detachedPid) }
    // Killing only the stable entry must terminate its entire foreground tree.
    const parent = spawn(launcher, ['tree', root], { cwd: root, env, stdio: 'ignore' })
    try {
      for (let i = 0; i < 100 && !existsSync(path.join(root, 'heartbeat')); i++) await sleep(50)
      assert.ok(existsSync(path.join(root, 'heartbeat')), 'foreground descendant must start')
      const processes = JSON.parse(readFileSync(path.join(root, 'processes.json'), 'utf8'))
      parent.kill()
      await sleep(500)
      for (const pid of [processes.parent, processes.child]) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `orphaned process ${pid}`)
      }
    } finally { parent.kill() }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, platform: process.platform, arch: process.arch,
    checks: ['native-harness-command-without-node', 'immutable-detached-owner-across-update', 'uninstall-launch-barrier', 'bounded-signed-archive-extraction', 'installation-activation-recovery-rollback', 'retired-generation-cleanup-injected-boots', 'kernel-process-identity', 'bundled-skill-ownership', 'signed-inventory-integrity', 'argv-stdin-stderr-exit', 'atomic-active-generation', 'mixed-node-bun-lock-and-atomic-write',
      ...(windows ? ['restart-manager-runtime-owners', 'existing-directory-acl-migration-without-child-changes', 'installation-owner-and-acl', 'dpapi-roundtrip-and-clear', 'detached-owner-survival', 'foreground-tree-termination'] : [])] })}\n`)
} finally { rmSync(root, { recursive: true, force: true }) }
