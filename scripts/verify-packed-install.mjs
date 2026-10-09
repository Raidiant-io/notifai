#!/usr/bin/env node
// Verify the generated npm route and the exact native product it authenticates.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { commandInvocation, repositoryRoot } from './cross-platform.mjs'
import { requireStatus, runExternal } from './run-external.mjs'
import { PACKED_SKILL_SMOKE_TIMEOUTS } from './packed-skill-smoke.mjs'
import { verifyPackedAdapter, releaseAdapterAccess } from './verify-packed-npm-adapter.mjs'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
const TIMEOUTS = PACKED_SKILL_SMOKE_TIMEOUTS
const runPhase = (file, args, options) => requireStatus(runExternal(file, args, options))
function fail(message) { throw new Error(message) }
function argvValue(flag) { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1] }
function verifyVersionOutput(label, expected, run) {
  const output = run().trim()
  if (expected instanceof RegExp) assert.match(output, expected, label)
  else assert.equal(output, expected, label)
}
/** Exercise the three npm shims Windows users actually launch. */
export function verifyWindowsShims(installDir, expectedVersion, env) {
  const timings = []
  const measuredOutput = (file, args, options) => {
    const result = runPhase(file, args, options)
    timings.push({ phase: result.phase, elapsed_ms: result.elapsedMs })
    return result.stdout
  }
  const binDir = path.join(installDir, 'node_modules', '.bin')
  const cmdShim = path.join(binDir, 'notifai.cmd')
  const powershellShim = path.join(binDir, 'notifai.ps1')
  const bashShim = path.join(binDir, 'notifai')
  for (const shim of [cmdShim, powershellShim, bashShim]) {
    if (!existsSync(shim)) fail(`npm did not create the Windows shim ${shim}`)
  }

  const shellEnv = {
    ...env,
    NOTIFAI_CMD_SHIM: cmdShim,
    NOTIFAI_POWERSHELL_SHIM: powershellShim,
    NOTIFAI_BASH_SHIM: bashShim,
  }
  // Put the command line in a batch file so Node does not have to serialize
  // nested quotes through cmd.exe's /c parser. The runner itself is invoked by
  // a relative name; the spaced, Unicode install path is still parsed by cmd when the
  // environment variable expands inside the batch file.
  const cmdRunner = path.join(installDir, 'notifai-cmd-smoke.cmd')
  writeFileSync(cmdRunner, '@call "%NOTIFAI_CMD_SHIM%" --help\r\n', 'ascii')
  try {
    verifyVersionOutput('notifai.cmd through cmd.exe', expectedVersion, () =>
      measuredOutput('cmd.exe', ['/d', '/v:off', '/c', path.basename(cmdRunner)], {
        cwd: installDir,
        env: shellEnv,
        timeoutMs: TIMEOUTS.cliCommand,
        phase: 'windows-cmd-shim',
      }),
    )
  } finally {
    rmSync(cmdRunner, { force: true })
  }

  const powershellArgs = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    // Exercise the unmodified npm shim using the host's own OS module. On
    // hosted Windows ARM, inherited third-party module discovery alone took
    // 26 seconds before Node started. This setup belongs to the test host;
    // it changes neither the npm wrapper nor the adapter's access checks.
    "$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; " +
      "Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1')); " +
      '& $env:NOTIFAI_POWERSHELL_SHIM --help',
  ]
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    verifyVersionOutput(`notifai.ps1 through ${executable}`, expectedVersion, () =>
      measuredOutput(executable, powershellArgs, {
        cwd: installDir,
        env: shellEnv,
        timeoutMs: TIMEOUTS.cliCommand,
        phase: `windows-ps-shim-${executable}`,
      }),
    )
  }

  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const gitBash = path.join(programFiles, 'Git', 'bin', 'bash.exe')
  if (!existsSync(gitBash)) fail(`Git Bash is missing at ${gitBash}`)
  verifyVersionOutput('notifai POSIX shim through Git Bash', expectedVersion, () =>
    measuredOutput(
      gitBash,
      ['-lc', 'shim_path=$(cygpath -u "$NOTIFAI_BASH_SHIM"); "$shim_path" --help'],
      { cwd: installDir, env: shellEnv, timeoutMs: TIMEOUTS.cliCommand, phase: 'windows-bash-shim' },
    ),
  )
  return timings
}


export function requireOwnedHostedAccount(env = process.env, accountHome = os.userInfo().homedir) {
  assert.ok(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.GITHUB_REPOSITORY === 'Raidiant-io/notifai',
    'Real npm/native installation acceptance requires the disposable first-party hosted account')
  assert.ok(path.isAbsolute(accountHome) && path.resolve(env.HOME ?? accountHome) === path.resolve(accountHome),
    'Acceptance HOME must match the actual OS account')
  return accountHome
}
export async function preparePackedCli(scratch, options = {}) {
  assert.ok(options.cliTarball, 'Supply --cli-tarball from the single admitted npm pack operation')
  assert.ok(options.ownedHostedAccount ?? process.argv.includes('--owned-hosted-account'),
    'Explicit --owned-hosted-account is required; local artifact tests must remain read-only')
  const home = requireOwnedHostedAccount()
  const ownershipReceipt = path.join(process.env.RUNNER_TEMP ?? '', 'notifai-native-acceptance-owner.json')
  assert.ok(path.isAbsolute(ownershipReceipt), 'Hosted runner must provide an absolute owned temporary directory')
  const sourceRevision = options.sourceRevision ?? argvValue('--expected-sha')
  const source = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/cli/package.json'), 'utf8'))
  const cliTarball = path.resolve(options.cliTarball)
  const checkAccess = releaseAdapterAccess(scratch)
  const verified = verifyPackedAdapter({ tarball: cliTarball, sourceRevision, version: source.version, checkAccess })
  const installDir = path.join(scratch, 'outside checkout Ω', 'install')
  mkdirSync(installDir, { recursive: true })
  writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ private: true }))
  const install = commandInvocation('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', cliTarball])
  runPhase(install.file, install.args, { ...install.options, cwd: installDir, timeoutMs: TIMEOUTS.npmInstall, phase: 'packed-npm-install' })
  const inventoryHash = createHash('sha256').update(verified.signedInventory).digest('hex')
  const installedCli = path.join(installDir, 'node_modules/@raidiant/notifai')
  const distribution = new Distribution(RELEASE_PUBLIC_KEYS)
  const { verifyNpmAdapterArtifact } = await import('../apps/cli/dist/npm-adapter-verification.js')
  const installed = verifyNpmAdapterArtifact(installedCli, distribution, checkAccess)
  assert.deepEqual(installed.manifest, verified.manifest, 'npm changed the verified adapter files')
  // Invoke the real npm entrypoint using the actual disposable OS account.
  // No synthetic HOME or fixture key may stand in for this acceptance boundary.
  const bin = path.join(installedCli, 'bin/notifai.mjs')
  const env = { ...process.env, HOME: home, USERPROFILE: home, CI: 'true' }
  const nativeRoot = path.join(home, '.notifai')
  if (existsSync(nativeRoot)) {
    assert.ok(existsSync(ownershipReceipt), 'Hosted acceptance refuses an existing installation without this run ownership receipt')
    const prior = JSON.parse(readFileSync(ownershipReceipt, 'utf8'))
    assert.ok(prior.root === nativeRoot && prior.source_revision === sourceRevision && prior.version === source.version && prior.inventory_sha256 === inventoryHash,
      'Hosted acceptance refuses a foreign or different-source native installation')
  }
  runPhase(process.execPath, [bin, 'install', '--json', '--no-init', '--no-path'], { cwd: installDir, env,
    timeoutMs: 180_000, phase: 'packed-real-native-acquisition' })
  if (!existsSync(ownershipReceipt)) writeFileSync(ownershipReceipt, JSON.stringify({ root: nativeRoot,
    source_revision: sourceRevision, version: source.version, inventory_sha256: inventoryHash }), { flag: 'wx', mode: 0o600 })
  const extension = process.platform === 'win32' ? '.exe' : ''
  const nativeCommand = path.join(home, '.notifai/bin', `notifai${extension}`)
  const nativeEnv = { ...env, PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '' }
  const receipt = JSON.parse(runPhase(nativeCommand, ['self-check', '--json'], {
    cwd: installDir, env: nativeEnv, timeoutMs: TIMEOUTS.cliCommand, phase: 'packed-native-identity' }).stdout)
  assert.ok(receipt.ok && receipt.processVerified && receipt.skill.files > 0, 'Native process and bundled skill must verify')
  assert.equal(receipt.build.version, source.version)
  assert.equal(receipt.build.sourceRevision, sourceRevision)
  assert.equal(receipt.build.sourceDirty, false)
  assert.equal(receipt.build.target, `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`)
  return { installDir, installedCli, cliManifest: source, env, cliTarball, nativeCommand, nativeReceipt: receipt, home }
}
async function main() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-install-'))
  try {
    const prepared = await preparePackedCli(scratch, { cliTarball: argvValue('--cli-tarball'), sourceRevision: argvValue('--expected-sha') })
    const bin = path.join(prepared.installedCli, 'bin/notifai.mjs')
    const help = runPhase(process.execPath, [bin, '--help'], { cwd: prepared.installDir,
      env: { ...process.env, ...prepared.env }, timeoutMs: TIMEOUTS.cliCommand, phase: 'packed-adapter-help' })
    assert.match(help.stdout, /init/)
    const timings = [{ phase: help.phase, elapsed_ms: help.elapsedMs }]
    if (process.platform === 'win32') timings.push(...verifyWindowsShims(prepared.installDir, /init/, { ...process.env, ...prepared.env }))
    console.log(JSON.stringify({ ok: true, version: prepared.cliManifest.version,
      build: prepared.nativeReceipt.build, skill: prepared.nativeReceipt.skill,
      timings,
      checks: ['exact-npm-files', 'isolated-npm-install', 'signed-exact-native-acquisition', 'native-process-identity', 'embedded-skill-integrity'] }))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main() } catch (error) { console.error(`Packed install verification FAILED: ${error.message}`); process.exitCode = 1 }
}
