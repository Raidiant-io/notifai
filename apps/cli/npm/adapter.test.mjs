import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { pack } from 'tar-stream'
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js'
import { Distribution, releaseSigningMessage } from '../dist/release-distribution.js'
import { acquireNative } from './bootstrap.mjs'
import { runNpmAdapter } from './adapter.mjs'
import { assertAcquisitionReady, executeNative, ownedPosixCommand } from './platform.mjs'
import { npmAdapterPosixAccess } from '../dist/npm-adapter-verification.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t, { target = 'bun-linux-x64', extra = false, beta = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-acquisition-')), temporary = path.join(root, 'temporary')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const version = beta ? '12.0.0-beta.1' : '12.0.0', extension = target.includes('windows') ? '.exe' : ''
  const files = { [`notifai${extension}`]: 'launcher', [`notifai-runtime${extension}`]: 'runtime', 'NOTICE.txt': 'notice', ...(extra ? { unexpected: 'not admitted' } : {}) }
  let archive
  if (extension) {
    const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
    for (const [name, contents] of Object.entries(files)) await zip.add(name, new Uint8ArrayReader(Buffer.from(contents)))
    archive = Buffer.from(await zip.close())
  } else {
    const writer = pack(), chunks = [], reading = (async () => { for await (const chunk of writer) chunks.push(chunk) })()
    for (const [name, contents] of Object.entries(files)) await new Promise((resolve, reject) => writer.entry({ name, size: contents.length, type: 'file' }, contents, error => error ? reject(error) : resolve()))
    writer.finalize(); await reading; archive = gzipSync(Buffer.concat(chunks))
  }
  const artifact = { target, filename: `notifai-${version}-${target.slice(4)}.${extension ? 'zip' : 'tar.gz'}`, bytes: archive.length, sha256: hash(archive),
    launcher_sha256: hash('launcher'), runtime_sha256: hash('runtime'), materials: [{ path: 'NOTICE.txt', bytes: 6, sha256: hash('notice') }] }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from(JSON.stringify({ schema: 1, version, source_revision: 'a'.repeat(40), store_schema: 1, launcher_schema: 1, artifacts: [artifact] }))
  const signedInventory = JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'), signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') })
  const release = { directory: root, executable: path.join(root, 'bin/notifai.mjs'), signedInventory,
    manifest: { native: { version, source_revision: 'a'.repeat(40) } } }
  const calls = [], executions = [], out = [], err = []
  let installed = false, tampered = false
  const distribution = new Distribution({ fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() }, async url => {
    calls.push(String(url)); return new Response(tampered ? Buffer.from('tampered') : archive)
  })
  const platform = { existingCommand: () => installed ? '/owned/notifai' : null, target: () => target,
    temporaryDirectory: () => { mkdirSync(temporary, { mode: 0o700 }); return temporary },
    checkPublisher: directory => assert.equal(readFileSync(path.join(directory, `notifai${extension}`), 'utf8'), 'launcher'),
    execute: (file, args) => { executions.push({ file, args }); return 7 },
    capture: (file, args) => { executions.push({ file, args }); installed = true; return { status: 0, stdout: JSON.stringify({ ok: true, runtime_installed: true }) } },
  }
  return { root, temporary, release, distribution, platform, calls, executions, out: value => out.push(value), err: value => err.push(value),
    output: out, errors: err, verify: () => release, locator: { version, source_revision: 'a'.repeat(40) }, tamper: () => { tampered = true } }
}

for (const target of ['bun-linux-x64', 'bun-windows-arm64']) test(`explicit ${target} acquisition authenticates, delegates and cleans temporary bytes`, async t => {
  const f = await fixture(t, { target, beta: true })
  assert.equal(await runNpmAdapter(['install', '--json', '--no-init', '--no-path'], f), 7)
  assert.deepEqual(f.executions[0].args, ['install', '--source', 'npm', '--version', '12.0.0-beta.1', '--channel', 'beta', '--json', '--no-init', '--no-path'])
  assert.equal(f.calls.length, 1); assert.ok(!f.calls[0].includes('release-metadata'))
  assert.equal(existsSync(f.temporary), false)
})
test('fresh init runs native setup exactly once and emits no second JSON report', async t => {
  const f = await fixture(t)
  assert.equal(await runNpmAdapter(['init', '--json', '--scope', 'project'], f), 7)
  assert.equal(f.executions.length, 2)
  assert.ok(f.executions[0].args.includes('--no-init'))
  assert.deepEqual(f.executions[1], { file: '/owned/notifai', args: ['init', '--json', '--scope', 'project'] })
  assert.deepEqual(f.output, [])
})
test('all read-only or ordinary missing-runtime invocations avoid acquisition and writes', async () => {
  const fail = () => { throw new Error('Unexpected acquisition or execution') }, output = []
  const deps = { locator: { version: '12.0.0' }, platform: { existingCommand: () => null, execute: fail }, distribution: fail,
    verify: fail, out: value => output.push(value), err: () => {} }
  for (const args of [[], ['--help'], ['send', '--help']]) assert.equal(await runNpmAdapter(args, deps), 0)
  for (const args of [['--version'], ['doctor', '--json'], ['send', '--json'], ['update']]) assert.equal(await runNpmAdapter(args, deps), 2)
  assert.equal(await runNpmAdapter(['uninstall', '--json'], deps), 0)
  for (const document of output.filter(item => item.startsWith('{'))) assert.ok(['setup_needed', 'native_not_installed'].includes(JSON.parse(document).code))
})
test('existing runtime preserves arguments, channels and exit status without acquisition', async () => {
  const fail = () => { throw new Error('Existing runtime cannot acquire') }, calls = []
  const deps = { platform: { existingCommand: () => '/owned/notifai', execute: (file, args) => { calls.push({ file, args }); return 13 } }, distribution: fail,
    verify: () => ({ directory: '/owned/npm-package', executable: '/owned/npm-package/bin/notifai.mjs' }) }
  for (const args of [[], ['--version'], ['init', '--json'], ['install'], ['doctor', '--json'], ['update', '--channel', 'beta'], ['uninstall']]) {
    assert.equal(await runNpmAdapter(args, deps), 13)
    assert.deepEqual(calls.at(-1), { file: '/owned/notifai', args: args.length ? args : ['--help'] })
  }
})
test('wrong identities, signatures, archives and members cannot execute a candidate', async t => {
  for (const kind of ['version', 'source', 'signature', 'archive', 'member']) {
    const f = await fixture(t, { extra: kind === 'member' })
    if (kind === 'version') f.release.manifest.native.version = '11.0.0'
    if (kind === 'source') f.release.manifest.native.source_revision = 'b'.repeat(40)
    if (kind === 'signature') f.release.signedInventory = f.release.signedInventory.replace('fixture', 'unknown')
    if (kind === 'archive') f.tamper()
    await assert.rejects(acquireNative(f.release, f))
    assert.equal(f.executions.length, 0); assert.equal(existsSync(f.temporary), false)
  }
})
test('invalid explicit install selection fails before fetching', async t => {
  const f = await fixture(t)
  for (const args of [['install', '--version', '11.0.0'], ['install', '--channel', 'beta'], ['install', '--unknown']]) {
    await assert.rejects(runNpmAdapter(args, f))
  }
  assert.equal(f.calls.length, 0)
})

test('release extraction survives asynchronous native install and is cleaned only after success or failure', async t => {
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
  for (const fail of [false, true]) {
    const f = await fixture(t), started = deferred(), finished = deferred()
    f.platform.execute = file => { started.resolve(file); return finished.promise }
    const pending = acquireNative(f.release, f)
    const executable = await started.promise
    assert.equal(existsSync(executable), true)
    assert.equal(existsSync(f.temporary), true)
    if (fail) {
      finished.reject(new Error('Native installer failed'))
      await assert.rejects(pending, /Native installer failed/)
    } else {
      finished.resolve(0)
      assert.equal(await pending, 0)
    }
    assert.equal(existsSync(f.temporary), false)
  }
})
test('native subprocess boundary preserves Unicode arguments, captured output and exit category', async () => {
  const args = ['δ🚀 spaces', '$(literal)', 'quote\" and \'']
  const result = await executeNative(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exitCode=2', ...args], { capture: true })
  assert.equal(result.status, 2); assert.deepEqual(JSON.parse(result.stdout), args)
  const split = await executeNative(process.execPath, ['-e', "const value=Buffer.from('δ🚀');process.stdout.write(value.subarray(0,1));setTimeout(()=>process.stdout.write(value.subarray(1)),10)"], { capture: true })
  assert.equal(split.stdout, 'δ🚀')
})

test('cancellation reaches the native child and retains its exit result', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  const script = `import { executeNative } from ${JSON.stringify(new URL('./platform.mjs', import.meta.url).href)}; process.exitCode=await executeNative(process.execPath,['-e','process.on("SIGTERM",()=>process.exit(42));process.stdout.write("ready");setInterval(()=>{},1000)']);`
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (parent.exitCode === null) parent.kill('SIGTERM') })
  const closed = once(parent, 'close')
  assert.equal(String((await once(parent.stdout, 'data'))[0]), 'ready')
  parent.kill('SIGTERM')
  assert.equal((await closed)[0], 42)
})

test('missing-command acquisition refuses pending transactions, retained owners, linked or writable installation roots', { skip: process.platform === 'win32' }, t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-readiness-')), root = path.join(home, '.notifai')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  assertAcquisitionReady(home, npmAdapterPosixAccess)
  mkdirSync(root)
  for (const name of ['uninstall.json', 'transaction.json', 'install.json', 'active.json']) {
    writeFileSync(path.join(root, name), '{}')
    assert.throws(() => assertAcquisitionReady(home, npmAdapterPosixAccess), /recovery/)
    rmSync(path.join(root, name))
  }
  const retention = path.join(root, 'runtime-retention'); mkdirSync(retention); mkdirSync(path.join(retention, 'unknown-owner'))
  assert.throws(() => assertAcquisitionReady(home, npmAdapterPosixAccess), /owners/)
  rmSync(retention, { recursive: true })
  const bin = path.join(root, 'bin'), command = path.join(bin, 'notifai'); mkdirSync(bin); writeFileSync(command, 'fixture', { mode: 0o700 })
  assert.equal(ownedPosixCommand(home), command)
  chmodSync(bin, 0o777); assert.throws(() => ownedPosixCommand(home), /owned/)
  chmodSync(bin, 0o700); rmSync(command); symlinkSync('/bin/sh', command)
  assert.throws(() => ownedPosixCommand(home), /owned/)
})
