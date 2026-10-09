import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cliBinReadiness, consumeNpmAdapterLocator, inspectCliInstallations } from './cli-bin.js'
import { legacyNpmMigration } from './legacy-npm-migration.js'
import { Distribution, releaseSigningMessage } from './release-distribution.js'
import { npmAdapterInventoryUrl } from './npm-adapter-contract.js'
import { canonicalPath } from './local-path.js'
import { nativeUninstallCommand } from './commands-native-uninstall.js'
import type { CommandDeps } from './commands-core.js'
import type { Installation } from './installation.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-routes-')); roots.push(home)
  const root = path.join(home, '.notifai'), build = 'b'.repeat(64)
  const command = path.join(root, 'bin', 'notifai'), runtime = path.join(root, 'versions', build, 'notifai-runtime')
  mkdirSync(path.dirname(command), { recursive: true }); mkdirSync(path.dirname(runtime), { recursive: true })
  writeFileSync(command, 'native launcher', { mode: 0o700 }); writeFileSync(runtime, 'native runtime', { mode: 0o700 })
  writeFileSync(path.join(root, 'install.json'), JSON.stringify({ schema: 1, owner: 'notifai',
    id: '12345678-1234-1234-1234-123456789012', channel: 'stable', source: 'shell' }), { mode: 0o600 })
  writeFileSync(path.join(root, 'active.json'), JSON.stringify({ schema: 1, active: build, previous: null, generation: 1 }) + '\n', { mode: 0o600 })
  writeFileSync(path.join(path.dirname(runtime), 'inventory.json'), JSON.stringify({ payload:
    Buffer.from(JSON.stringify({ version: '11.8.0', source_revision: 'c'.repeat(40) })).toString('base64') }), { mode: 0o600 })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const distribution = new Distribution({ fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() })
  function adapter(prefix: string, version: string, npx = false) {
    const modules = npx ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules')
    const directory = path.join(modules, '@raidiant', 'notifai'), executable = path.join(directory, 'bin', 'notifai.mjs')
    const bin = npx ? path.join(modules, '.bin') : path.join(prefix, 'bin'), shim = path.join(bin, 'notifai')
    mkdirSync(path.dirname(executable), { recursive: true }); mkdirSync(bin, { recursive: true })
    const files = { 'bin/notifai.mjs': '#!/usr/bin/env node\nthrow new Error("inspection must never execute me")\n',
      'package.json': JSON.stringify({ name: '@raidiant/notifai', version, bin: { notifai: 'bin/notifai.mjs' } }) }
    for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(directory, name), bytes, { mode: 0o700 })
    const manifest = JSON.stringify({ schema: 1, package: '@raidiant/notifai', adapter_version: version,
      native: { version, source_revision: 'a'.repeat(40), inventory_url: npmAdapterInventoryUrl(version) },
      files: Object.entries(files).map(([name, bytes]) => ({ path: name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })) })
    writeFileSync(path.join(directory, 'npm-adapter-files.json'), manifest, { mode: 0o600 })
    const payload = Buffer.from(JSON.stringify({ schema: 1, version, source_revision: 'a'.repeat(40), store_schema: 1, launcher_schema: 1,
      artifacts: [{ target: 'bun-linux-x64', filename: `notifai-${version}-linux-x64.tar.gz`, bytes: 1, sha256: 'd'.repeat(64),
        runtime_sha256: 'e'.repeat(64), launcher_sha256: 'f'.repeat(64), materials: [{ path: 'npm-adapter-files.json', bytes: Buffer.byteLength(manifest), sha256: hash(manifest) }] }] }))
    writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') }), { mode: 0o600 })
    symlinkSync(executable, shim)
    return { bin, shim, executable, directory, prefix }
  }
  const options = { nativeHome: home, distribution, runningArtifactPath: runtime, currentVersion: '11.8.0' }
  return { home, root, command, runtime, adapter, options }
}

it('admits distinct signed global adapters as routes to one native runtime without legacy migration or version changes', () => {
  const f = fixture(), old = f.adapter(path.join(f.home, 'old prefix'), '12.0.0'), beta = f.adapter(path.join(f.home, 'β prefix'), '12.1.0-beta.1')
  const env = { HOME: f.home, PATH: `${old.bin}:${beta.bin}:${path.dirname(f.command)}` }
  const before = readFileSync(path.join(f.root, 'active.json'), 'utf8')
  const inspection = inspectCliInstallations(env, 'linux', f.options)
  expect(inspection.entries.map(entry => entry.kind)).toEqual(['npm-adapter', 'npm-adapter', 'native'])
  expect(inspection.effective).toMatchObject({ artifact_path: f.runtime, adapter: { version: '12.0.0' } })
  expect(inspection.native).toMatchObject({ version: '11.8.0', channel: 'stable' })
  expect(inspection.invoking_adapter).toBeNull()
  expect(cliBinReadiness(env, 'linux', f.options).status).toBe('ready')
  expect(legacyNpmMigration(env, 'linux', f.command, f.options)).toEqual({ collisions: [], migration: null })
  expect(readFileSync(path.join(f.root, 'active.json'), 'utf8')).toBe(before)
})

it('keeps modified and missing-proof npm commands visible as unknown collisions without executing them', () => {
  const f = fixture(), route = f.adapter(path.join(f.home, 'prefix'), '12.0.0')
  const env = { HOME: f.home, PATH: `${route.bin}:${path.dirname(f.command)}` }
  writeFileSync(route.executable, 'modified bytes', { mode: 0o700 })
  expect(cliBinReadiness(env, 'linux', f.options).status).toBe('gap')
  expect(legacyNpmMigration(env, 'linux', f.command, f.options)).toMatchObject({ collisions: [{ kind: 'unknown' }], migration: null })
  rmSync(path.join(route.directory, 'inventory.json'))
  expect(inspectCliInstallations(env, 'linux', f.options).effective?.kind).toBe('unknown')
})

it('revalidates the transient invocation locator separately from PATH and removes only verified NPX insertion', () => {
  const f = fixture(), route = f.adapter(path.join(f.home, '_npx', 'cache'), '12.0.0-beta.1', true)
  const env = { HOME: f.home, PATH: `${route.bin}:${path.dirname(f.command)}`, NOTIFAI_NPM_ADAPTER_ARTIFACT: route.executable }
  const locator = consumeNpmAdapterLocator(env)
  expect(env).not.toHaveProperty('NOTIFAI_NPM_ADAPTER_ARTIFACT')
  const inspection = inspectCliInstallations(env, 'linux', { ...f.options, invokingNpmAdapterArtifact: locator })
  expect(inspection.invoking_adapter).toMatchObject({ version: '12.0.0-beta.1', artifact_path: route.executable })
  expect(inspection.effective?.command_path).toBe(f.command)
  expect(env.PATH).toContain(route.bin)
  expect(inspectCliInstallations(env, 'linux', { ...f.options, invokingNpmAdapterArtifact: path.join(f.home, 'forged', 'notifai.mjs') }).invoking_adapter).toBeNull()
  expect(inspectCliInstallations(env, 'linux', f.options).entries[0]?.kind).toBe('npm-adapter')
})

it('fails adapter ownership closed when an OS access check rejects the route', () => {
  const f = fixture(), route = f.adapter(path.join(f.home, 'prefix'), '12.0.0')
  const env = { HOME: f.home, PATH: route.bin }
  expect(inspectCliInstallations(env, 'linux', { ...f.options, checkAccess() { throw new Error('ACL unavailable') } }).effective?.kind).toBe('unknown')
  chmodSync(route.directory, 0o777)
  expect(inspectCliInstallations(env, 'linux', f.options).effective?.kind).toBe('unknown')
})

it('keeps help, version and doctor read-only through the actual source entrypoint', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-entrypoint-diagnostics-')); roots.push(home)
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home,
    NOTIFAI_TEST_HOME: home, NOTIFAI_CREDENTIALS: 'file', NOTIFAI_BASE_URL: 'http://127.0.0.1:1', CI: '1' }
  delete env['NOTIFAI_NPM_ADAPTER_ARTIFACT']
  const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url))
  for (const args of [['--help'], ['send', '--help'], ['--version'], ['doctor', '--json']]) {
    const result = spawnSync(process.execPath, [entrypoint, ...args], { cwd: home, env, encoding: 'utf8', timeout: 15_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(args[0] === 'doctor' ? 1 : 0)
    if (args[0] === 'doctor') expect(JSON.parse(result.stdout)).toHaveProperty('states')
    expect(readdirSync(home)).toEqual([])
  }
})

it('identifies the complete cmd-shim-generated legacy Windows triplet at its exact npm prefix', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-windows-legacy-')); roots.push(home)
  const prefix = path.join(home, 'prefix with spaces'), pkg = path.join(prefix, 'node_modules', '@raidiant', 'notifai')
  const artifact = path.join(pkg, 'dist', 'main.js'), stable = path.join(home, '.notifai', 'bin', 'notifai.exe')
  mkdirSync(path.dirname(artifact), { recursive: true })
  writeFileSync(artifact, 'legacy runtime bytes', { mode: 0o700 })
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@raidiant/notifai', version: '11.8.0', bin: { notifai: 'dist/main.js' } }))
  for (const name of ['notifai', 'notifai.cmd', 'notifai.ps1']) {
    writeFileSync(path.join(prefix, name), readFileSync(new URL(`./fixtures/legacy-npm-windows/${name}`, import.meta.url)))
  }
  const env = { Path: prefix, HOME: home, USERPROFILE: home }, options = { nativeHome: home }
  const result = legacyNpmMigration(env, 'win32', stable, options)
  expect(result.collisions).toHaveLength(3)
  expect(result.migration).toMatchObject({ artifact: canonicalPath(artifact), prefix: canonicalPath(prefix), version: '11.8.0',
    cleanup: { args: ['uninstall', '--global', '--prefix', canonicalPath(prefix), '@raidiant/notifai'] } })
  expect(readFileSync(artifact, 'utf8')).toBe('legacy runtime bytes')
  writeFileSync(path.join(prefix, 'notifai.cmd'), ' '.repeat(16 * 1024 + 1))
  expect(legacyNpmMigration(env, 'win32', stable, options).migration).toBeNull()
  expect(readFileSync(artifact, 'utf8')).toBe('legacy runtime bytes')
})

it('reports exact-prefix npm cleanup after native removal without deleting the verified npm launcher', async () => {
  const f = fixture(), route = f.adapter(path.join(f.home, 'prefix with spaces'), '12.0.0'), out: string[] = []
  // Local authority's removal result is substituted; real signed artifact,
  // shim, prefix inspection and command reporting execute against the fixture.
  const installation = {
    uninstallState: () => null, inspect: () => ({ active: { generation: 1 } }),
    beginUninstall: () => ({ status: 'preparing', token: 'fixture', owners: { hosts: [], stateRoots: [] } }),
    enterUninstallRemoval: () => ({ status: 'removing' }), completeUninstall: () => ({ status: 'removed' }),
  } as unknown as Installation
  const deps: CommandDeps = { cwd: f.home, env: { HOME: f.home, PATH: route.bin }, hookAdapterHome: f.home, hookPlatform: 'linux',
    io: { out: line => out.push(line), err() {}, confirm: async () => false, openUrl() {} },
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' } }
  expect(await nativeUninstallCommand(deps, { json: true }, { installation, inspection: f.options, removeWiring: () => ({ ok: true, conflicts: [] }) })).toBe(0)
  expect(JSON.parse(out[0]!).adapter_cleanup).toMatchObject([{ args: ['uninstall', '--global', '--prefix', canonicalPath(route.prefix), '@raidiant/notifai'] }])
  expect(readFileSync(route.executable, 'utf8')).toContain('inspection must never execute me')
})
