import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandDeps, CommandIo } from './commands-core.js'
import { cliUpdateCommand } from './commands-update.js'
import { installHookAdapter, inspectHookAdapter } from './hook-adapter.js'
import { packageVersion } from './release.js'

class CapturedIo implements CommandIo {
  outLines: string[] = []
  errLines: string[] = []
  out(line: string) { this.outLines.push(line) }
  err(line: string) { this.errLines.push(line) }
  async confirm() { return false }
  openUrl() {}
}

function npmInstall(root: string, name: string, version: string) {
  const prefix = path.join(root, name)
  const packageRoot = path.join(prefix, 'lib', 'node_modules', '@raidiant', 'notifai')
  const artifact = path.join(packageRoot, 'dist', 'main.js')
  const command = path.join(prefix, 'bin', 'notifai')
  mkdirSync(path.dirname(artifact), { recursive: true })
  mkdirSync(path.dirname(command), { recursive: true })
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version }))
  writeFileSync(artifact, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(version)} + "\\n")\n`)
  chmodSync(artifact, 0o755)
  symlinkSync(path.relative(path.dirname(command), artifact), command)
  return { prefix, packageRoot, artifact, command }
}

describe('CLI update recovery', () => {
  it('updates the PATH winner prefix and retargets the shared hook adapter in one action', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-update-loop-'))
    const currentVersion = packageVersion()
    if (currentVersion === null) throw new Error('test build has no package version')
    const stale = npmInstall(root, 'stale-prefix', '3.0.1')
    const current = npmInstall(root, 'current-prefix', currentVersion)
    const managerPrefix = path.join(root, 'manager-prefix')
    const managerBin = path.join(managerPrefix, 'bin')
    const npm = path.join(managerBin, 'npm')
    const calls = path.join(root, 'npm-calls.jsonl')
    mkdirSync(managerBin, { recursive: true })
    writeFileSync(
      npm,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'prefix') {
  process.stdout.write(${JSON.stringify(managerPrefix)} + '\\n');
  process.exit(0);
}
const prefix = args[args.indexOf('--prefix') + 1];
const packageRoot = path.join(prefix, 'lib', 'node_modules', '@raidiant', 'notifai');
const artifact = path.join(packageRoot, 'dist', 'main.js');
fs.mkdirSync(path.dirname(artifact), { recursive: true });
fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version: ${JSON.stringify(currentVersion)} }));
fs.writeFileSync(artifact, '#!${process.execPath}\\nprocess.stdout.write(${JSON.stringify(`${currentVersion}\\n`)})\\n', { mode: 0o755 });
`,
    )
    chmodSync(npm, 0o755)

    const home = path.join(root, 'home')
    installHookAdapter({ execPath: process.execPath, scriptPath: stale.artifact }, home)
    const io = new CapturedIo()
    const deps: CommandDeps = {
      io,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test' },
      env: {
        PATH: [managerBin, path.dirname(stale.command), path.dirname(current.command)].join(':'),
      },
      cwd: root,
      hookAdapterHome: home,
      hookInstallTarget: { execPath: process.execPath, scriptPath: current.artifact },
      hookPlatform: 'darwin',
    }

    expect(cliUpdateCommand(deps, {})).toBe(0)
    expect(JSON.parse(readFileSync(path.join(stale.packageRoot, 'package.json'), 'utf8'))).toMatchObject({
      version: currentVersion,
    })
    expect(
      readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    ).toEqual([
      ['prefix', '--global'],
      ['install', '--global', '--prefix', realpathSync(stale.prefix), '@raidiant/notifai'],
    ])
    expect(spawnSync(stale.command, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(currentVersion)
    expect(inspectHookAdapter(home).target).toMatchObject({ scriptPath: realpathSync(stale.artifact) })
    expect(io.outLines).toEqual(['Notifai is updated. Re-run `notifai init` to continue setup.'])
    expect(io.outLines.join('\n')).not.toContain(root)
    expect(io.errLines).toEqual([])

    io.outLines = []
    expect(cliUpdateCommand(deps, { json: true })).toBe(0)
    const result = JSON.parse(io.outLines[0] ?? '{}') as Record<string, unknown>
    expect(result).toMatchObject({
      ok: true,
      package_manager_prefix: managerPrefix,
      update_prefix: realpathSync(stale.prefix),
      after: {
        effective: {
          command_path: stale.command,
          artifact_path: realpathSync(stale.artifact),
          version: currentVersion,
        },
      },
      hook_adapter: {
        target: { scriptPath: realpathSync(stale.artifact) },
      },
    })
  })
})
