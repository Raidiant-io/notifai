#!/usr/bin/env node
/**
 * Install the packed CLI the way the registry would, and prove it starts.
 *
 * Every other pre-publish gate runs inside this workspace, where the CLI
 * always resolves the protocol package that is sitting next to it. That link
 * hides exactly one class of defect: the packed CLI's `package.json` naming a
 * protocol version other than the one packed beside it. A release once
 * shipped that way — the CLI imported exports its declared protocol
 * dependency did not have, every workspace gate passed, and a clean
 * `npm install -g` crashed at startup.
 *
 * So this gate packs both packages, then leaves the workspace entirely:
 *
 *   1. The packed CLI manifest must pin the protocol dependency to exactly
 *      the protocol version packed here. Any other specifier is a hard
 *      failure, because a registry install would resolve that specifier —
 *      not this tree — and ship whatever the registry has under it.
 *   2. In an isolated temp directory outside the workspace, the two tarballs
 *      are installed with npm using their packed dependency metadata. Every
 *      other dependency resolves from the registry exactly as it would for a
 *      user; the local protocol tarball satisfies the pin only because step 1
 *      proved the pin names it.
 *   3. The installed protocol must be byte-for-byte the packed one — if the
 *      installer quietly fetched a published version of the same number
 *      instead, this run would be vouching for the wrong bytes.
 *   4. The installed CLI must still carry the reviewed skill bundle, and it
 *      must be able to stage that bundle as a portable local source. This is
 *      the deterministic proof that the tarball contains and installs the
 *      intended skill. It does not spawn the third-party `skills` installer;
 *      that integration smoke is `scripts/verify-packed-skill-install.mjs`.
 *   5. The installed bin must run: `notifai --version` has to report the
 *      packed version, and `notifai config show` has to exit 0. Startup
 *      resolves the CLI's static protocol imports, so a protocol missing an
 *      export the CLI names fails both commands at module link time.
 *
 * Needs registry access for the CLI's public dependencies; needs no
 * credentials and never publishes anything. Every external process has a
 * short explicit timeout so a stalled npm cannot consume a runner budget.
 *
 * Usage:
 *   node scripts/verify-packed-install.mjs
 *   node scripts/verify-packed-install.mjs --cli-tarball a.tgz --protocol-tarball b.tgz
 *   node scripts/verify-packed-install.mjs ... --gitleaks
 *
 * The tarball flags skip the packing step and verify the given artifacts —
 * that is how the test fixture proves a stale pin fails.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { assertPackedTarballs } from './check-packed-boundary.mjs'
import { commandInvocation, repositoryRoot } from './cross-platform.mjs'
import { PACKED_SKILL_SMOKE_TIMEOUTS } from './packed-skill-smoke.mjs'
import { CLI_PACKAGE, PROTOCOL_PACKAGE } from './package-contract.mjs'
import { requireStatus, runExternal } from './run-external.mjs'

const CLI_NAME = CLI_PACKAGE.name
const PROTOCOL_NAME = PROTOCOL_PACKAGE.name
const TIMEOUTS = PACKED_SKILL_SMOKE_TIMEOUTS

/**
 * Why the packed CLI cannot ship with the protocol pin it carries, or null
 * when the pin is exactly the protocol version packed beside it.
 *
 * Equality is deliberately literal: a range that merely *covers* the local
 * version still hands the resolution to the registry, which may satisfy it
 * with older bytes than the ones this tree was tested against.
 */
export function protocolPinFailure(packedCliManifest, packedProtocolVersion) {
  const pin = packedCliManifest.dependencies?.[PROTOCOL_NAME]
  if (pin === undefined) {
    return `packed ${CLI_NAME} declares no ${PROTOCOL_NAME} dependency`
  }
  if (pin !== packedProtocolVersion) {
    return (
      `packed ${CLI_NAME}@${packedCliManifest.version} depends on ${PROTOCOL_NAME}@${pin}, ` +
      `but the protocol packed beside it is ${packedProtocolVersion} — a registry install would ` +
      `resolve ${pin} from npm and ship a CLI importing exports that version may not have ` +
      `(the startup-crash class); the pin must be exactly ${packedProtocolVersion}`
    )
  }
  return null
}

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex')

/** Every file under a directory, relative and sorted, so two trees compare. */
function treeFiles(directory) {
  const out = []
  const walk = (current) => {
    for (const child of readdirSync(current).sort()) {
      const full = path.join(current, child)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(path.relative(directory, full))
    }
  }
  walk(directory)
  return out.sort()
}

function runPhase(file, args, options) {
  return requireStatus(runExternal(file, args, options))
}

/** Pack one workspace package and return the tarball path. */
function packPackage(name, destination, phase) {
  mkdirSync(destination, { recursive: true })
  const invocation = commandInvocation('pnpm', ['--filter', name, 'pack', '--pack-destination', destination])
  runPhase(invocation.file, invocation.args, {
    ...invocation.options,
    cwd: repositoryRoot,
    timeoutMs: TIMEOUTS.pack,
    phase,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const tarballs = readdirSync(destination).filter((entry) => entry.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one packed tarball for ${name}, found ${tarballs.length}`)
  }
  return path.join(destination, tarballs[0])
}

/** Extract a packed tarball and return its `package/` directory. */
function extractTarball(tarball, destination, phase) {
  mkdirSync(destination, { recursive: true })
  runPhase('tar', ['xzf', tarball], {
    cwd: destination,
    timeoutMs: TIMEOUTS.extract,
    phase,
  })
  return path.join(destination, 'package')
}

function readManifest(packageDirectory) {
  return JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
}

function fail(message) {
  console.error('Packed install verification FAILED:')
  console.error(`  - ${message}`)
  process.exit(1)
}

function argvValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function verifyVersionOutput(label, expected, run) {
  let reported
  try {
    reported = run().trim()
  } catch (error) {
    fail(`${label} failed to execute (${String(error)})`)
  }
  if (reported !== expected) {
    fail(`${label} reports ${reported || '<empty>'}, packed manifest says ${expected}`)
  }
}

/** Exercise the three npm shims Windows users actually launch. */
export function verifyWindowsShims(installDir, expectedVersion, env) {
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
  writeFileSync(cmdRunner, '@call "%NOTIFAI_CMD_SHIM%" --version\r\n', 'ascii')
  try {
    verifyVersionOutput('notifai.cmd through cmd.exe', expectedVersion, () =>
      runPhase('cmd.exe', ['/d', '/v:off', '/c', path.basename(cmdRunner)], {
        cwd: installDir,
        env: shellEnv,
        timeoutMs: TIMEOUTS.cliCommand,
        phase: 'windows-cmd-shim',
      }).stdout,
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
    '& $env:NOTIFAI_POWERSHELL_SHIM --version',
  ]
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    verifyVersionOutput(`notifai.ps1 through ${executable}`, expectedVersion, () =>
      runPhase(executable, powershellArgs, {
        cwd: installDir,
        env: shellEnv,
        timeoutMs: TIMEOUTS.cliCommand,
        phase: `windows-ps-shim-${executable}`,
      }).stdout,
    )
  }

  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const gitBash = path.join(programFiles, 'Git', 'bin', 'bash.exe')
  if (!existsSync(gitBash)) fail(`Git Bash is missing at ${gitBash}`)
  verifyVersionOutput('notifai POSIX shim through Git Bash', expectedVersion, () =>
    runPhase(
      gitBash,
      ['-lc', 'shim_path=$(cygpath -u "$NOTIFAI_BASH_SHIM"); "$shim_path" --version'],
      { cwd: installDir, env: shellEnv, timeoutMs: TIMEOUTS.cliCommand, phase: 'windows-bash-shim' },
    ).stdout,
  )
}

/**
 * Pack (unless tarball paths are supplied), install both tarballs outside the
 * workspace, and prove the packed protocol bytes and skill bundle survived.
 */
export async function preparePackedCli(scratch, options = {}) {
  let cliTarball = options.cliTarball
  let protocolTarball = options.protocolTarball
  if ((cliTarball === undefined) !== (protocolTarball === undefined)) {
    throw new Error('pass both --cli-tarball and --protocol-tarball, or neither')
  }
  if (cliTarball === undefined) {
    // Protocol first: its prepack build writes the dist/ the CLI compiles against.
    protocolTarball = packPackage(PROTOCOL_NAME, path.join(scratch, 'pack-protocol'), 'pack-protocol')
    cliTarball = packPackage(CLI_NAME, path.join(scratch, 'pack-cli'), 'pack-cli')
  }
  cliTarball = path.resolve(cliTarball)
  protocolTarball = path.resolve(protocolTarball)

  const boundary = assertPackedTarballs({
    tarballs: [protocolTarball, cliTarball],
    scanSecrets: options.scanSecrets === true,
  })
  console.log(
    `Packed boundary verified: ${boundary.files} files and ${boundary.sourceMaps} source maps.`,
  )

  const packedCli = extractTarball(cliTarball, path.join(scratch, 'packed-cli'), 'extract-cli')
  const packedProtocol = extractTarball(
    protocolTarball,
    path.join(scratch, 'packed-protocol'),
    'extract-protocol',
  )
  const cliManifest = readManifest(packedCli)
  const protocolManifest = readManifest(packedProtocol)
  if (cliManifest.name !== CLI_NAME) {
    throw new Error(`CLI tarball manifest names ${cliManifest.name}, expected ${CLI_NAME}`)
  }
  if (protocolManifest.name !== PROTOCOL_NAME) {
    throw new Error(`protocol tarball manifest names ${protocolManifest.name}, expected ${PROTOCOL_NAME}`)
  }

  const pinFailure = protocolPinFailure(cliManifest, protocolManifest.version)
  if (pinFailure !== null) throw new Error(pinFailure)
  if (process.platform !== 'win32') {
    const packedBin = path.join(packedCli, 'dist/main.js')
    const packedMode = statSync(packedBin).mode & 0o111
    if (packedMode === 0) {
      throw new Error(`packed dist/main.js is not executable (mode ${(statSync(packedBin).mode & 0o777).toString(8)})`)
    }
  }
  console.log(
    `Pin verified: packed ${CLI_NAME}@${cliManifest.version} depends on ${PROTOCOL_NAME}@${protocolManifest.version}.`,
  )

  // The isolated install lives in the OS temp directory, outside any
  // workspace, so nothing can fall back to workspace resolution. A private
  // manifest keeps npm from treating the directory as publishable.
  // Keep tar extraction in the plain scratch root because Windows bsdtar
  // cannot open every Unicode archive path. The installed package and shims
  // still live under the hostile path whose quoting behavior is the claim.
  const installDir = path.join(scratch, 'outside checkout Ω', 'install')
  mkdirSync(installDir, { recursive: true })
  writeFileSync(
    path.join(installDir, 'package.json'),
    JSON.stringify({ name: 'notifai-packed-install-smoke', version: '0.0.0', private: true }, null, 2),
  )
  // Both tarballs install together: npm satisfies the CLI's protocol pin by
  // deduplicating onto the top-level protocol tarball (the pin equality
  // proved above makes that resolution valid), and resolves every other
  // dependency from the registry per the packed metadata.
  const install = commandInvocation('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    protocolTarball,
    cliTarball,
  ])
  console.log('phase packed-npm-install: installing packed tarballs outside the workspace')
  runPhase(install.file, install.args, {
    ...install.options,
    cwd: installDir,
    timeoutMs: TIMEOUTS.npmInstall,
    phase: 'packed-npm-install',
  })

  // Prove the pin was satisfied by the packed protocol, not a same-numbered
  // published one: the installed protocol must match the tarball byte for byte.
  const installedProtocol = path.join(installDir, 'node_modules', PROTOCOL_NAME)
  const packedProtocolFiles = treeFiles(packedProtocol)
  for (const file of packedProtocolFiles) {
    const installedFile = path.join(installedProtocol, file)
    let installedBytes
    try {
      installedBytes = readFileSync(installedFile)
    } catch {
      throw new Error(`installed protocol is missing ${file} — the pin was not satisfied by the packed tarball`)
    }
    if (sha256(installedBytes) !== sha256(readFileSync(path.join(packedProtocol, file)))) {
      throw new Error(`installed protocol ${file} differs from the packed tarball — the pin resolved to different bytes`)
    }
  }

  const home = path.join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: undefined, XDG_STATE_HOME: undefined }
  const installedCli = path.join(installDir, 'node_modules', CLI_NAME)
  const integrity = await import(pathToFileURL(path.join(installedCli, 'dist', 'skill-integrity.js')).href)
  const bundle = integrity.shippedSkillBundle(cliManifest.version)
  if (!bundle.ok) throw new Error(`installed CLI skill bundle is invalid (${bundle.error})`)

  const staged = integrity.stageShippedSkillBundle(installDir, cliManifest.version)
  if (!staged.ok) throw new Error(`installed CLI could not stage its packaged skill (${staged.error})`)
  try {
    if (path.isAbsolute(staged.staged.source) || staged.staged.source.includes(installDir)) {
      throw new Error('staged packaged skill source is not machine-neutral')
    }
    const stagedRoot = path.resolve(installDir, staged.staged.source)
    if (!lstatSync(path.join(stagedRoot, 'notifai')).isDirectory()) {
      throw new Error('staged packaged skill is missing the notifai tree')
    }
  } finally {
    staged.staged.cleanup()
  }
  if (existsSync(path.join(installDir, '.notifai')) &&
    readdirSync(path.join(installDir, '.notifai')).some((entry) => entry.startsWith('skill-source-'))) {
    throw new Error('packed CLI left its temporary skill source behind')
  }

  console.log(
    `Packed skill bundle verified: ${CLI_NAME}@${cliManifest.version} contains and stages the reviewed skill.`,
  )

  return { installDir, installedCli, cliManifest, protocolManifest, env, cliTarball, protocolTarball }
}

async function main() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-install-'))
  try {
    const prepared = await preparePackedCli(scratch, {
      cliTarball: argvValue('--cli-tarball'),
      protocolTarball: argvValue('--protocol-tarball'),
      scanSecrets: process.argv.includes('--gitleaks'),
    })
    const { installDir, installedCli, cliManifest, protocolManifest, env } = prepared
    const binRelative =
      typeof cliManifest.bin === 'string' ? cliManifest.bin : cliManifest.bin?.notifai
    if (typeof binRelative !== 'string') fail('packed CLI manifest declares no notifai bin')
    const bin = path.join(installedCli, binRelative)
    const runInstalled = (args, phase) =>
      runPhase(process.execPath, [bin, ...args], {
        cwd: installDir,
        env,
        timeoutMs: TIMEOUTS.cliCommand,
        phase,
      }).stdout

    verifyVersionOutput('installed notifai --version', cliManifest.version, () =>
      runInstalled(['--version'], 'packed-cli-version'),
    )

    if (process.platform === 'win32') {
      verifyWindowsShims(installDir, cliManifest.version, env)
    }

    // `config show` runs the full command path offline. Reaching it at all
    // requires startup to link every static protocol import the CLI names —
    // the exact step a stale protocol dependency breaks.
    try {
      runInstalled(['config', 'show'], 'packed-cli-config')
    } catch (error) {
      fail(`installed notifai config show failed (${String(error)})`)
    }

    console.log(
      `Packed install verified: ${CLI_NAME}@${cliManifest.version} installs in isolation with ` +
        `${PROTOCOL_NAME}@${protocolManifest.version}; its bin runs and its packaged skill is present.`,
    )
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
