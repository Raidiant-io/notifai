#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { repositoryRoot } from './cross-platform.mjs'

const { values } = parseArgs({ options: { launcher: { type: 'string' }, bun: { type: 'string', default: 'bun' } } })
assert.ok(values.launcher, '--launcher is required')
assert.equal(execFileSync(values.bun, ['--version'], { encoding: 'utf8' }).trim(), '1.4.2')
const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-runtime-'))
const windows = process.platform === 'win32'
const extension = windows ? '.exe' : ''
const launcher = path.join(root, `notifai${extension}`)
const runtime = path.join(root, `notifai-runtime${extension}`)
const fixture = path.join(repositoryRoot, 'scripts/standalone-runtime-probe.ts')
const sourceBundle = path.join(root, 'probe.mjs')
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const env = { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root,
  PATH: windows ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin',
  ...(windows ? { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: root, APPDATA: root } : {}),
}
function run(args, overrides = {}) {
  const result = spawnSync(launcher, args, { cwd: root, env, encoding: 'utf8', timeout: 90_000, ...overrides })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
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
    '--define', 'NOTIFAI_COMPILED_BUILD={"runtime":"bun-1.4.2-test-only"}',
    fixture, '--outfile', runtime], { cwd: repositoryRoot, stdio: 'inherit' })
  execFileSync(values.bun, ['build', '--target=node', fixture, '--outfile', sourceBundle],
    { cwd: repositoryRoot, stdio: 'inherit' })
  run(['identity', root])
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from(JSON.stringify({ schema: 1, version: '12.0.0', source_revision: 'a'.repeat(40),
    store_schema: 1, launcher_schema: 1, artifacts: [{ target: 'bun-windows-x64',
      filename: 'notifai-12.0.0-windows-x64.zip', bytes: 15,
      sha256: createHash('sha256').update('archive-fixture').digest('hex'),
      runtime_sha256: 'c'.repeat(64), launcher_sha256: 'd'.repeat(64) }] }))
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
  mkdirSync(path.join(managed, 'bin'), { recursive: true })
  const stable = path.join(managed, 'bin', `notifai${extension}`)
  copyFileSync(launcher, stable)
  const builds = ['a'.repeat(64), 'b'.repeat(64)]
  const payloads = builds.map(build => {
    const directory = path.join(managed, 'versions', build)
    mkdirSync(directory, { recursive: true })
    copyFileSync(launcher, path.join(directory, `notifai${extension}`))
    const payload = path.join(directory, `notifai-runtime${extension}`)
    copyFileSync(runtime, payload)
    return payload
  })
  for (let i = 0; i < builds.length; i++) {
    const state = JSON.stringify({ schema: 1, active: builds[i], previous: builds[i - 1] ?? null, generation: i + 1 })
    writeFileSync(path.join(managed, 'active.tmp'), `${state}\n`)
    renameSync(path.join(managed, 'active.tmp'), path.join(managed, 'active.json'))
    assert.equal(realpathSync(execFileSync(stable, ['location', root], { cwd: root, env, encoding: 'utf8' })), realpathSync(payloads[i]))
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
    const credentialRoot = path.join(root, 'credentials')
    mkdirSync(credentialRoot)
    run(['credentials', credentialRoot])
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
    checks: ['kernel-process-identity', 'signed-inventory-integrity', 'argv-stdin-stderr-exit', 'atomic-active-generation', 'mixed-node-bun-lock-and-atomic-write',
      ...(windows ? ['dpapi-roundtrip-and-clear', 'foreground-tree-termination'] : [])] })}\n`)
} finally { rmSync(root, { recursive: true, force: true }) }
