import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_NPM_RELEASES, NPM_MIGRATION_ADAPTER } from './legacy-npm-releases.js'
import { npmShim } from './npm-adapter-route.js'
import { npmAdapterInventoryUrl } from './npm-adapter-contract.js'
import { runNpmManager, type NpmManagerResult } from './npm-conversion-process.js'
import { prepareNpmReplacement, replaceNpmPackage, type NpmReplacementContext } from './npm-replacement.js'
import { Distribution, RELEASE_TARGETS, releaseSigningMessage } from './release-distribution.js'
import { processIdentityLiveness } from './process-identity.js'

vi.mock('./legacy-npm-releases.js', () => ({ LEGACY_NPM_RELEASES: {}, NPM_MIGRATION_ADAPTER: { version: '12.0.0-beta.15', integrity: '' } }))
vi.mock('./npm-conversion-process.js', () => ({ runNpmManager: vi.fn() }))
vi.mock('./process-identity.js', () => ({ currentProcessIdentity: () => ({ pid: 101, start: 'windows-filetime:123' }), processIdentityLiveness: vi.fn(), normalizeProcessStart: (value: string) => value.replace('windows-filetime:', '') }))
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('finite npm replacement receipt and forward recovery', () => {
  let root: string, prefix: string, pkg: string, context: NpmReplacementContext
  let input: Parameters<typeof prepareNpmReplacement>[0]
  let targetFiles: Map<string, string>, beforeAdmission: (() => void) | undefined
  let interrupted: boolean
  function installTarget(at: string) {
    const directory = path.join(at, 'node_modules/@raidiant/notifai')
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(path.join(directory, 'bin'), { recursive: true })
    for (const [name, bytes] of targetFiles) writeFileSync(path.join(directory, name), bytes)
    for (const extension of ['', '.cmd', '.ps1']) writeFileSync(path.join(at, `notifai${extension}`), npmShim('node_modules/@raidiant/notifai/bin/notifai.mjs', extension))
  }
  beforeEach(() => {
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
    const version = NPM_MIGRATION_ADAPTER.version, revision = 'a'.repeat(40)
    targetFiles = new Map([
      ['bin/notifai.mjs', 'verified adapter\n'],
      ['package.json', JSON.stringify({ name: '@raidiant/notifai', version, bin: { notifai: 'bin/notifai.mjs' } })],
    ])
    const manifest = JSON.stringify({ schema: 1, package: '@raidiant/notifai', adapter_version: version,
      native: { version, source_revision: revision, inventory_url: npmAdapterInventoryUrl(version) },
      files: [...targetFiles].map(([file, bytes]) => ({ path: file, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })) })
    targetFiles.set('npm-adapter-files.json', manifest)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const payload = Buffer.from(JSON.stringify({ schema: 1, version, source_revision: revision, store_schema: 1, launcher_schema: 1,
      artifacts: RELEASE_TARGETS.map(target => ({ target, filename: `notifai-${version}-${target.slice(4)}.${target.includes('windows') ? 'zip' : 'tar.gz'}`,
        bytes: 1, sha256: 'b'.repeat(64), runtime_sha256: 'c'.repeat(64), launcher_sha256: 'd'.repeat(64),
        materials: [{ path: 'npm-adapter-files.json', bytes: Buffer.byteLength(manifest), sha256: hash(manifest) }] })) }))
    targetFiles.set('inventory.json', JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') }))
    input = { prefix, node: path.join(root, 'node.exe'), npm: path.join(root, 'npm-cli.js'), artifact: path.join(root, 'artifact.tgz'),
      scope: 'Owned test prefix; closed reader population; no native lifecycle competitors' }
    writeFileSync(input.node, 'trusted node fixture'); writeFileSync(input.npm, 'trusted npm fixture'); writeFileSync(input.artifact, 'authenticated compressed fixture')
    NPM_MIGRATION_ADAPTER.integrity = createHash('sha512').update(readFileSync(input.artifact)).digest('base64')
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
  it('refuses unpinned compressed bytes before allowing npm to parse them', async () => {
    writeFileSync(input.artifact, 'not the pinned artifact')
    await expect(prepareNpmReplacement(input, context)).rejects.toThrow(/pinned/)
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
    const second = await replaceNpmPackage(prepared.directory, context, () => undefined)
    expect(second.exit_code).toBe(0)
    expect(receipt(prepared.directory).phase).toBe('package_verified')
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
})
