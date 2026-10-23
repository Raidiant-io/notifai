import { Uint8ArrayReader,Uint8ArrayWriter,ZipWriter } from '@zip.js/zip.js'
import assert from 'node:assert/strict'
import { createHash,generateKeyPairSync,sign } from 'node:crypto'
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { Distribution,releaseSigningMessage } from '../dist/release-distribution.js'
import { runNpmAdapter } from './adapter.mjs'
import { acquireNative } from './bootstrap.mjs'
import { windowsPackageAccess } from './platform.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('Windows batch transport keeps hostile and long pathnames as bounded data in one invocation', t => {
  // The subprocess is substituted: this proves transport, not Windows ACLs.
  const original = process.env.SystemRoot
  process.env.SystemRoot = 'C:\\Windows'
  t.after(() => { if (original === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = original })
  const paths = [
    { file: path.resolve("δ🚀 quote' $(literal);\nline"), directory: false },
    { file: path.resolve('long-' + 'x'.repeat(16_000)), directory: true },
  ]
  const calls = []
  const execute = (...args) => { calls.push(args); return '' }
  windowsPackageAccess(paths, execute)
  assert.equal(calls.length, 1)
  const [executable, args, options] = calls[0]
  assert.equal(executable.endsWith('powershell.exe'), true)
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  assert.equal(args[4].length < 32_000, true)
  const code = Buffer.from(args[4], 'base64').toString('utf16le')
  for (const entry of paths) assert.equal(code.includes(entry.file), false)
  assert.deepEqual(JSON.parse(Buffer.from(options.input.trim(), 'base64').toString('utf8')), { paths })
  assert.equal(options.input.endsWith('\n'), true)
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'])
  for (const rejected of [[], Array(258).fill(paths[0]), [{ ...paths[0], file: 'relative' }],
    [{ ...paths[0], file: path.resolve('nul\0path') }], [{ ...paths[0], directory: 'true' }],
    [{ ...paths[0], file: path.resolve('x'.repeat(1024 * 1024)) }]]) {
    assert.throws(() => windowsPackageAccess(rejected, execute))
  }
  assert.equal(calls.length, 1)
  assert.throws(() => windowsPackageAccess(paths, () => { throw new Error('ACL rejection') }), /Windows installation helper failed/)
})
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
