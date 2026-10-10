import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'
import { pack, type Headers } from 'tar-stream'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_NPM_RELEASES } from './legacy-npm-releases.js'
import { npmShim } from './npm-adapter-route.js'
import { npmAdapterInventoryUrl } from './npm-adapter-contract.js'
import { runNpmManager, type NpmManagerResult } from './npm-conversion-process.js'
import { prepareNpmReplacement, replaceNpmPackage, type NpmReplacementContext } from './npm-replacement.js'
import { Distribution, RELEASE_TARGETS, releaseSigningMessage } from './release-distribution.js'
import { processIdentityLiveness } from './process-identity.js'

vi.mock('./legacy-npm-releases.js', () => ({ LEGACY_NPM_RELEASES: {} }))
vi.mock('./npm-conversion-process.js', () => ({ runNpmManager: vi.fn() }))
vi.mock('./process-identity.js', () => ({ currentProcessIdentity: () => ({ pid: 101, start: 'windows-filetime:123' }), processIdentityLiveness: vi.fn(), normalizeProcessStart: (value: string) => value.replace('windows-filetime:', '') }))
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
async function archive(files: Map<string, string>, extra: [Headers, string][] = []): Promise<Buffer> {
  const writer = pack(), chunks: Buffer[] = []
  const collecting = (async () => { for await (const chunk of writer) chunks.push(Buffer.from(chunk as Uint8Array)) })()
  for (const [header, contents] of extra) writer.entry(header, contents)
  for (const [name, contents] of files) writer.entry({ name: `package/${name}` }, contents)
  writer.finalize(); await collecting
  return gzipSync(Buffer.concat(chunks))
}

describe('finite npm replacement receipt and forward recovery', () => {
  let root: string, prefix: string, pkg: string, context: NpmReplacementContext
  let input: Parameters<typeof prepareNpmReplacement>[0]
  let targetFiles: Map<string, string>, beforeAdmission: (() => void) | undefined
  let interrupted: boolean
  let signingKey: KeyObject
  async function signTargetPackage(pkg: Record<string, unknown>): Promise<void> {
    targetFiles.set('package.json', JSON.stringify(pkg))
    const manifest = JSON.parse(targetFiles.get('npm-adapter-files.json')!)
    const entry = manifest.files.find((item: { path: string }) => item.path === 'package.json')
    entry.bytes = Buffer.byteLength(targetFiles.get('package.json')!)
    entry.sha256 = hash(targetFiles.get('package.json')!)
    const bytes = JSON.stringify(manifest)
    targetFiles.set('npm-adapter-files.json', bytes)
    const envelope = JSON.parse(input.signedInventory)
    const inventory = JSON.parse(Buffer.from(envelope.payload, 'base64').toString())
    for (const artifact of inventory.artifacts) artifact.materials[0] = { path: 'npm-adapter-files.json', bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }
    const payload = Buffer.from(JSON.stringify(inventory))
    input.signedInventory = JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage('inventory', payload), signingKey).toString('base64') })
    targetFiles.set('inventory.json', input.signedInventory)
    writeFileSync(input.artifact, await archive(targetFiles))
  }
  function installTarget(at: string) {
    const directory = path.join(at, 'node_modules/@raidiant/notifai')
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(path.join(directory, 'bin'), { recursive: true })
    for (const [name, bytes] of targetFiles) writeFileSync(path.join(directory, name), bytes)
    for (const extension of ['', '.cmd', '.ps1']) writeFileSync(path.join(at, `notifai${extension}`), npmShim('node_modules/@raidiant/notifai/bin/notifai.mjs', extension))
  }
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-replacement-')))
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    prefix = path.join(root, 'prefix'); pkg = path.join(prefix, 'node_modules/@raidiant/notifai')
    mkdirSync(path.join(pkg, 'dist'), { recursive: true })
    const legacy = new Map([
      ['dist/main.js', 'import("./main-run.js")\n'], ['dist/main-run.js', 'old runtime\n'],
      ['package.json', JSON.stringify({ name: '@raidiant/notifai', version: '11.7.1', bin: { notifai: 'dist/main.js' } })],
    ])
    for (const [name, bytes] of legacy) writeFileSync(path.join(pkg, name), bytes)
    const inventory = [...legacy].sort(([a], [b]) => a < b ? -1 : 1).map(([name, bytes]) => [name, Buffer.byteLength(bytes), hash(bytes)])
    ;(LEGACY_NPM_RELEASES as Record<string, { files: number; sha256: string }>)['11.7.1'] = { files: legacy.size, sha256: hash(JSON.stringify(inventory)) }
    mkdirSync(path.join(pkg, 'node_modules/custom'), { recursive: true })
    writeFileSync(path.join(pkg, 'node_modules/custom/changed.js'), 'custom dependency\n')
    for (const extension of ['', '.cmd', '.ps1']) writeFileSync(path.join(prefix, `notifai${extension}`), npmShim('node_modules/@raidiant/notifai/dist/main.js', extension))
    const version = '12.0.0-beta.16', revision = 'a'.repeat(40)
    targetFiles = new Map([
      ['bin/notifai.mjs', 'verified adapter\n'],
      ['package.json', JSON.stringify({ name: '@raidiant/notifai', version, bin: { notifai: 'bin/notifai.mjs' } })],
    ])
    const manifest = JSON.stringify({ schema: 1, package: '@raidiant/notifai', adapter_version: version,
      native: { version, source_revision: revision, inventory_url: npmAdapterInventoryUrl(version) },
      files: [...targetFiles].map(([file, bytes]) => ({ path: file, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })) })
    targetFiles.set('npm-adapter-files.json', manifest)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    signingKey = privateKey
    const payload = Buffer.from(JSON.stringify({ schema: 1, version, source_revision: revision, store_schema: 1, launcher_schema: 1,
      artifacts: RELEASE_TARGETS.map(target => ({ target, filename: `notifai-${version}-${target.slice(4)}.${target.includes('windows') ? 'zip' : 'tar.gz'}`,
        bytes: 1, sha256: 'b'.repeat(64), runtime_sha256: 'c'.repeat(64), launcher_sha256: 'd'.repeat(64),
        materials: [{ path: 'npm-adapter-files.json', bytes: Buffer.byteLength(manifest), sha256: hash(manifest) }] })) }))
    targetFiles.set('inventory.json', JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') }))
    input = { prefix, node: path.join(root, 'node.exe'), npm: path.join(root, 'npm-cli.js'), artifact: path.join(root, 'artifact.tgz'),
      scope: 'Owned test prefix; closed reader population; no native lifecycle competitors', signedInventory: targetFiles.get('inventory.json')! }
    writeFileSync(input.node, 'trusted node fixture'); writeFileSync(input.npm, 'trusted npm fixture')
    writeFileSync(input.artifact, await archive(targetFiles))
    context = { installationRoot: path.join(root, 'native'), launcher: path.join(root, 'launcher.exe'), env: process.env,
      distribution: new Distribution({ fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() }),
      // Native ACL semantics and actual npm are exercised by Windows tests.
      access: { check() {}, directory(file) { mkdirSync(file, { recursive: true, mode: 0o700 }) }, beforePublish() {}, protectExistingDirectory() {} },
      packageAccess() {}, verifyEnvironment: vi.fn(() => undefined) }
    mkdirSync(context.installationRoot)
    interrupted = false; beforeAdmission = undefined
    vi.mocked(processIdentityLiveness).mockImplementation(identity => identity.pid === 101 ? 'alive' : 'gone')
    vi.mocked(runNpmManager).mockReset().mockImplementation(async operation => {
      const at = operation.args[operation.args.indexOf('--prefix') + 1]!
      const result: NpmManagerResult = { manager: { pid: 202, start: 'windows-filetime:456' }, started: false, exit_code: 1, stdout: '', stderr: '' }
      beforeAdmission?.()
      try { operation.admit(result.manager!) } catch (error) { return { ...result, failure: (error as Error).message } }
      result.started = true
      if (interrupted) { rmSync(path.join(pkg, 'dist/main.js')); return { ...result, failure: 'interrupted' } }
      installTarget(at)
      return { ...result, exit_code: 0 }
    })
  })
  afterEach(() => { Object.defineProperty(process, 'platform', platform); rmSync(root, { recursive: true, force: true }) })
  const receipt = (directory: string) => JSON.parse(readFileSync(path.join(directory, 'operation.json'), 'utf8'))

  it('prepares off-prefix, authenticates bytes and preserves all files before replacing through npm', async () => {
    const prepared = await prepareNpmReplacement(input, context)
    expect(prepared.dependency_files).toBe(1)
    expect(readFileSync(path.join(pkg, 'dist/main.js'), 'utf8')).toBe('import("./main-run.js")\n')
    expect(readFileSync(path.join(prepared.directory, 'original/package/node_modules/custom/changed.js'), 'utf8')).toBe('custom dependency\n')
    const observe = vi.fn(() => undefined)
    const result = await replaceNpmPackage(prepared.directory, context, observe)
    expect(result.exit_code).toBe(0)
    expect(observe).toHaveBeenCalledTimes(2)
    expect(observe).toHaveBeenCalledWith(input.scope, 1)
    expect(receipt(prepared.directory)).toMatchObject({ phase: 'package_verified', coordinator: null, may_have_run: true, manager: result.manager })
    const options = vi.mocked(runNpmManager).mock.calls[1]![0]
    expect(options.args).toContain('--offline')
    expect(options.args[options.args.indexOf('--userconfig') + 1]).not.toBe(options.args[options.args.indexOf('--globalconfig') + 1])
  })
  it('refuses unauthenticated archive input before allowing npm to parse it', async () => {
    writeFileSync(input.artifact, 'not the pinned artifact')
    await expect(prepareNpmReplacement(input, context)).rejects.toThrow()
    expect(runNpmManager).not.toHaveBeenCalled()
    expect(existsSync(path.join(pkg, 'dist/main.js'))).toBe(true)
  })
  it.each(['extra', 'missing', 'changed', 'duplicate', 'traversal', 'link', 'other-inventory'] as const)(
    'rejects an archive with %s content before npm runs', async fault => {
      const files = new Map(targetFiles), extra: [Headers, string][] = []
      if (fault === 'extra') files.set('extra.js', 'unreleased')
      if (fault === 'missing') files.delete('bin/notifai.mjs')
      if (fault === 'changed') files.set('bin/notifai.mjs', 'modified')
      if (fault === 'duplicate') extra.push([{ name: 'package/BIN/NOTIFAI.MJS' }, 'duplicate'])
      if (fault === 'traversal') extra.push([{ name: 'package/../outside' }, 'escape'])
      if (fault === 'link') extra.push([{ name: 'package/link', type: 'symlink', linkname: '../outside' }, ''])
      if (fault === 'other-inventory') input.signedInventory += '\n'
      writeFileSync(input.artifact, await archive(files, extra))
      await expect(prepareNpmReplacement(input, context)).rejects.toThrow()
      expect(runNpmManager).not.toHaveBeenCalled()
      expect(existsSync(path.join(pkg, 'dist/main.js'))).toBe(true)
    })
  it('discards global PAX metadata instead of forwarding another parser an ambiguous archive', async () => {
    // tar-stream does not apply global PAX without a following local PAX record.
    // npm uses another reader: forwarding these source headers would be unsafe.
    const value = 'path=../../outside.js\n'
    let record = `0 ${value}`
    while (!record.startsWith(`${Buffer.byteLength(record)} `)) record = `${Buffer.byteLength(record)} ${value}`
    // pack only emits bodies for files, so change this fixture's type byte to
    // global PAX and recompute the standard tar header checksum.
    const source = gunzipSync(await archive(targetFiles, [[{ name: 'GlobalHead' }, record]]))
    source[156] = 'g'.charCodeAt(0)
    source.fill(0x20, 148, 156)
    const checksum = source.subarray(0, 512).reduce((sum, value) => sum + value, 0)
    source.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    writeFileSync(input.artifact, gzipSync(source))
    const prepared = await prepareNpmReplacement(input, context)
    const normalized = readFileSync(path.join(prepared.directory, 'adapter.tgz'))
    expect(gunzipSync(normalized).includes(Buffer.from('../../outside.js'))).toBe(false)
    expect(receipt(prepared.directory).target.archive_sha256).toBe(hash(normalized))
    expect(normalized.equals(readFileSync(input.artifact))).toBe(false)
  })
  it.each(['bin', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'man'])(
    'refuses a signed package that expands npm installation scope through %s', async key => {
      const metadata = JSON.parse(targetFiles.get('package.json')!)
      metadata[key] = key === 'bin' ? { ...metadata.bin, unrelated: 'bin/notifai.mjs' }
        : key === 'man' ? ['manual.1'] : { unrelated: '1.0.0' }
      await signTargetPackage(metadata)
      await expect(prepareNpmReplacement(input, context)).rejects.toThrow(/package contract/)
      expect(runNpmManager).not.toHaveBeenCalled()
      expect(existsSync(path.join(pkg, 'dist/main.js'))).toBe(true)
    })
  it('retains its receipt and repairs forward after npm removed an old entry', async () => {
    const prepared = await prepareNpmReplacement(input, context)
    interrupted = true
    const first = await replaceNpmPackage(prepared.directory, context, () => undefined)
    expect(first.failure).toBe('interrupted')
    expect(receipt(prepared.directory)).toMatchObject({ phase: 'replacing', coordinator: null, manager: first.manager })
    expect(existsSync(path.join(pkg, 'dist/main.js'))).toBe(false)
    interrupted = false
    // Later target selection cannot retarget a prepared operation.
    input.signedInventory = 'new channel choice must not be consulted'
    writeFileSync(input.artifact, 'new channel archive must not be consulted')
    const second = await replaceNpmPackage(prepared.directory, context, () => undefined)
    expect(second.exit_code).toBe(0)
    expect(receipt(prepared.directory)).toMatchObject({ phase: 'package_verified', target: { version: '12.0.0-beta.16', inventory_sha256: hash(targetFiles.get('inventory.json')!) } })
  })
  it('refuses a reader that appears between preparation and suspended-manager admission', async () => {
    const prepared = await prepareNpmReplacement(input, context)
    let reads = 0
    const result = await replaceNpmPackage(prepared.directory, context, () => { if (++reads === 2) throw new Error('new reader') })
    expect(result).toMatchObject({ started: false, failure: 'new reader' })
    expect(existsSync(path.join(pkg, 'dist/main.js'))).toBe(true)
  })
  it('preserves a user edit arriving during supervisor startup', async () => {
    const prepared = await prepareNpmReplacement(input, context)
    beforeAdmission = () => writeFileSync(path.join(prefix, 'notifai.cmd'), 'new custom wrapper')
    const result = await replaceNpmPackage(prepared.directory, context, () => undefined)
    expect(result.started).toBe(false)
    expect(result.failure).toMatch(/modified/)
    expect(readFileSync(path.join(prefix, 'notifai.cmd'), 'utf8')).toBe('new custom wrapper')
  })
  for (const state of ['alive', 'unknown'] as const) it(`refuses recovery while the recorded manager is ${state}`, async () => {
    const prepared = await prepareNpmReplacement(input, context)
    interrupted = true
    await replaceNpmPackage(prepared.directory, context, () => undefined)
    vi.mocked(processIdentityLiveness).mockReturnValue(state)
    await expect(replaceNpmPackage(prepared.directory, context, () => undefined)).rejects.toThrow(/proved stopped/)
    expect(runNpmManager).toHaveBeenCalledTimes(2)
  })
  for (const file of ['original/package/node_modules/custom/changed.js', 'adapter.tgz', 'user.npmrc', 'global.npmrc']) it(`refuses changed prepared material: ${file}`, async () => {
    const prepared = await prepareNpmReplacement(input, context)
    writeFileSync(path.join(prepared.directory, file), 'later edit')
    await expect(replaceNpmPackage(prepared.directory, context, () => undefined)).rejects.toThrow(/changed|pinned/)
    expect(runNpmManager).toHaveBeenCalledTimes(1)
    expect(receipt(prepared.directory).coordinator).toBeNull()
  })
  it('has one canonical slot per prefix and refuses overlapping execution', async () => {
    const prepared = await prepareNpmReplacement(input, context)
    await expect(prepareNpmReplacement(input, context)).rejects.toThrow(/already exists/)
    const original = vi.mocked(runNpmManager).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(runNpmManager).mockImplementationOnce(async operation => { await gate; return original(operation) })
    const first = replaceNpmPackage(prepared.directory, context, () => undefined)
    await expect(replaceNpmPackage(prepared.directory, context, () => undefined)).rejects.toThrow(/proved stopped/)
    release()
    expect((await first).exit_code).toBe(0)
  })
  it('reserves preparation after rechecking a concurrently claimed prefix slot', async () => {
    let competitor: ReturnType<typeof prepareNpmReplacement> | undefined
    vi.mocked(context.verifyEnvironment).mockImplementationOnce(() => {
      // Both callers passed the early absence check. This caller claims the
      // directory and yields during archive verification before its rival.
      competitor = prepareNpmReplacement(input, context)
    })
    await expect(prepareNpmReplacement(input, context)).rejects.toThrow(/already exists/)
    const winner = await competitor!
    expect(receipt(winner.directory)).toMatchObject({ phase: 'prepared', target: { version: '12.0.0-beta.16' } })
    expect(runNpmManager).toHaveBeenCalledTimes(1)
    expect(readFileSync(path.join(winner.directory, 'original/package/dist/main.js'), 'utf8')).toBe('import("./main-run.js")\n')
  })
})
