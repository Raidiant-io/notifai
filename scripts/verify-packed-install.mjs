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
 *   4. The installed bin must run: `notifai --version` has to report the
 *      packed version, and `notifai config show` has to exit 0. Startup
 *      resolves the CLI's static protocol imports, so a protocol missing an
 *      export the CLI names fails both commands at module link time.
 *
 * Needs registry access for the CLI's public dependencies; needs no
 * credentials and never publishes anything.
 *
 * Usage:
 *   node scripts/verify-packed-install.mjs
 *   node scripts/verify-packed-install.mjs --cli-tarball a.tgz --protocol-tarball b.tgz
 *
 * The tarball flags skip the packing step and verify the given artifacts —
 * that is how the test fixture proves a stale pin fails.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { commandInvocation, execCommand, repositoryRoot } from './cross-platform.mjs'

const CLI_NAME = '@raidiant/notifai'
const PROTOCOL_NAME = '@raidiant/notifai-protocol'

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

/** Pack one workspace package and return the tarball path. */
function packPackage(name, destination) {
  mkdirSync(destination, { recursive: true })
  execCommand('pnpm', ['--filter', name, 'pack', '--pack-destination', destination], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const tarballs = readdirSync(destination).filter((entry) => entry.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one packed tarball for ${name}, found ${tarballs.length}`)
  }
  return path.join(destination, tarballs[0])
}

/** Extract a packed tarball and return its `package/` directory. */
function extractTarball(tarball, destination) {
  mkdirSync(destination, { recursive: true })
  execFileSync('tar', ['xzf', tarball], { cwd: destination })
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
  verifyVersionOutput('notifai.cmd through cmd.exe', expectedVersion, () =>
    execFileSync(
      'cmd.exe',
      ['/d', '/v:off', '/s', '/c', 'call "%NOTIFAI_CMD_SHIM%" --version'],
      { cwd: installDir, env: shellEnv, encoding: 'utf8' },
    ),
  )

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
      execFileSync(executable, powershellArgs, {
        cwd: installDir,
        env: shellEnv,
        encoding: 'utf8',
      }),
    )
  }

  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const gitBash = path.join(programFiles, 'Git', 'bin', 'bash.exe')
  if (!existsSync(gitBash)) fail(`Git Bash is missing at ${gitBash}`)
  verifyVersionOutput('notifai POSIX shim through Git Bash', expectedVersion, () =>
    execFileSync(
      gitBash,
      ['-lc', 'shim_path=$(cygpath -u "$NOTIFAI_BASH_SHIM"); "$shim_path" --version'],
      { cwd: installDir, env: shellEnv, encoding: 'utf8' },
    ),
  )
}

async function main() {
  // Deliberately include spaces, a command metacharacter, and Unicode: every
  // Windows shell must survive the same paths real Users commonly have.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai packed & Ω '))
  try {
    let cliTarball = argvValue('--cli-tarball')
    let protocolTarball = argvValue('--protocol-tarball')
    if ((cliTarball === undefined) !== (protocolTarball === undefined)) {
      fail('pass both --cli-tarball and --protocol-tarball, or neither')
    }
    if (cliTarball === undefined) {
      // Protocol first: its prepack build writes the dist/ the CLI compiles against.
      protocolTarball = packPackage(PROTOCOL_NAME, path.join(scratch, 'pack-protocol'))
      cliTarball = packPackage(CLI_NAME, path.join(scratch, 'pack-cli'))
    }
    cliTarball = path.resolve(cliTarball)
    protocolTarball = path.resolve(protocolTarball)

    const packedCli = extractTarball(cliTarball, path.join(scratch, 'packed-cli'))
    const packedProtocol = extractTarball(protocolTarball, path.join(scratch, 'packed-protocol'))
    const cliManifest = readManifest(packedCli)
    const protocolManifest = readManifest(packedProtocol)
    if (cliManifest.name !== CLI_NAME) fail(`CLI tarball manifest names ${cliManifest.name}, expected ${CLI_NAME}`)
    if (protocolManifest.name !== PROTOCOL_NAME) {
      fail(`protocol tarball manifest names ${protocolManifest.name}, expected ${PROTOCOL_NAME}`)
    }

    const pinFailure = protocolPinFailure(cliManifest, protocolManifest.version)
    if (pinFailure !== null) fail(pinFailure)
    if (process.platform !== 'win32') {
      const packedBin = path.join(packedCli, 'dist/main.js')
      const packedMode = statSync(packedBin).mode & 0o111
      if (packedMode === 0) {
        fail(`packed dist/main.js is not executable (mode ${(statSync(packedBin).mode & 0o777).toString(8)})`)
      }
    }
    console.log(
      `Pin verified: packed ${CLI_NAME}@${cliManifest.version} depends on ${PROTOCOL_NAME}@${protocolManifest.version}.`,
    )

    // The isolated install lives in the OS temp directory, outside any
    // workspace, so nothing can fall back to workspace resolution. A private
    // manifest keeps npm from treating the directory as publishable.
    const installDir = path.join(scratch, 'install')
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
    execFileSync(install.file, install.args, {
      ...install.options,
      cwd: installDir,
      stdio: ['ignore', 'ignore', 'inherit'],
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
        fail(`installed protocol is missing ${file} — the pin was not satisfied by the packed tarball`)
      }
      if (sha256(installedBytes) !== sha256(readFileSync(path.join(packedProtocol, file)))) {
        fail(`installed protocol ${file} differs from the packed tarball — the pin resolved to different bytes`)
      }
    }

    // Execute the installed bin in an environment whose home is the scratch
    // directory, so the smoke commands can never read or write this user's
    // real configuration, credentials, or logs.
    const home = path.join(scratch, 'home')
    mkdirSync(home, { recursive: true })
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: undefined, XDG_STATE_HOME: undefined }
    const installedCli = path.join(installDir, 'node_modules', CLI_NAME)
    const binRelative =
      typeof cliManifest.bin === 'string' ? cliManifest.bin : cliManifest.bin?.notifai
    if (typeof binRelative !== 'string') fail('packed CLI manifest declares no notifai bin')
    const bin = path.join(installedCli, binRelative)
    const runInstalled = (args) =>
      execFileSync(process.execPath, [bin, ...args], { cwd: installDir, env, encoding: 'utf8' })

    verifyVersionOutput('installed notifai --version', cliManifest.version, () =>
      runInstalled(['--version']),
    )

    if (process.platform === 'win32') {
      verifyWindowsShims(installDir, cliManifest.version, env)
    }

    // `config show` runs the full command path offline. Reaching it at all
    // requires startup to link every static protocol import the CLI names —
    // the exact step a stale protocol dependency breaks.
    try {
      runInstalled(['config', 'show'])
    } catch (error) {
      fail(`installed notifai config show failed (${String(error)})`)
    }

    console.log(
      `Packed install verified: ${CLI_NAME}@${cliManifest.version} installs in isolation with ` +
        `${PROTOCOL_NAME}@${protocolManifest.version} and the installed bin runs.`,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
