#!/usr/bin/env node
/** Install one exact published CLI version and exercise its native Windows shims. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { commandInvocation } from './cross-platform.mjs'
import { verifyWindowsShims } from './verify-packed-install.mjs'
import { CLI_PACKAGE } from './package-contract.mjs'
import { isSemVer } from '../apps/cli/src/version.js'

const CLI_NAME = CLI_PACKAGE.name

export function publishedVersionArgument(argv) {
  const version = argv[2]
  if (typeof version !== 'string' || !isSemVer(version)) {
    throw new Error('usage: node scripts/verify-published-windows.mjs <exact-version>')
  }
  return version
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('published Windows verification must run on a native Windows runner')
  }
  const version = publishedVersionArgument(process.argv)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-published-windows-'))
  try {
    const installDir = path.join(scratch, 'outside checkout Ω', 'install')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(
      path.join(installDir, 'package.json'),
      `${JSON.stringify({ name: 'notifai-published-windows-smoke', private: true }, null, 2)}\n`,
    )

    const install = commandInvocation('npm', [
      'install',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `${CLI_NAME}@${version}`,
    ])
    execFileSync(install.file, install.args, {
      ...install.options,
      cwd: installDir,
      stdio: ['ignore', 'ignore', 'inherit'],
    })

    const installedCli = path.join(installDir, 'node_modules', CLI_NAME)
    const manifest = JSON.parse(readFileSync(path.join(installedCli, 'package.json'), 'utf8'))
    if (manifest.version !== version) {
      throw new Error(`npm installed ${CLI_NAME}@${manifest.version}, expected exact ${version}`)
    }

    const home = path.join(scratch, 'home')
    const localAppData = path.join(home, 'AppData', 'Local')
    const roamingAppData = path.join(home, 'AppData', 'Roaming')
    mkdirSync(localAppData, { recursive: true })
    mkdirSync(roamingAppData, { recursive: true })
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: localAppData,
      APPDATA: roamingAppData,
      XDG_CONFIG_HOME: undefined,
      XDG_STATE_HOME: undefined,
    }

    verifyWindowsShims(installDir, version, env)
    execFileSync(process.execPath, [path.join(installedCli, 'dist', 'main.js'), 'config', 'show'], {
      cwd: installDir,
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    console.log(`${CLI_NAME}@${version} verified from npm on native ${process.arch} Windows.`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
