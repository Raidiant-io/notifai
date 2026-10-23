import {
chmodSync,
mkdirSync,
mkdtempSync,
readFileSync,
rmSync,
symlinkSync,
writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import type { CommandDeps,CommandIo } from './commands-core.js'
import { cliUpdateCommand } from './commands-update.js'
import { inspectHookAdapter,installHookAdapter } from './hook-adapter.js'

class CapturedIo implements CommandIo {
  interactive = false
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

/**
 * Recovery is proved from a stable and a beta running build. A beta build's
 * repair advice names the beta channel, and a plain update from it refuses to
 * downgrade to an older stable `latest`, so each build recovers on its own
 * channel from a registry that publishes it there.
 */
const RUNNING_BUILDS = [
  {
    channel: 'stable',
    distTag: 'latest',
    version: '10.1.0',
    tags: { latest: '10.1.0' },
    installSpec: '@raidiant/notifai@latest',
  },
  {
    channel: 'beta',
    distTag: 'beta',
    version: '10.2.0-beta.1',
    tags: { latest: '3.0.1', beta: '10.2.0-beta.1' },
    installSpec: '@raidiant/notifai@10.2.0-beta.1',
  },
] as const
type RunningBuild = (typeof RUNNING_BUILDS)[number]
const STABLE_BUILD = RUNNING_BUILDS[0]

describe('CLI update recovery', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function recoveryFixture(installedAt = '3.0.1', build: RunningBuild = STABLE_BUILD) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-update-retry-'))
    roots.push(root)
    const { version } = build
    const installed = npmInstall(root, 'installed', installedAt)
    const running = npmInstall(root, 'running', version)
    const home = path.join(root, 'home')
    installHookAdapter({ execPath: process.execPath, scriptPath: running.artifact }, home)
    const adapterBefore = readFileSync(inspectHookAdapter(home).path, 'utf8')
    const managerBin = path.join(root, 'manager', 'bin')
    mkdirSync(managerBin, { recursive: true })
    const manager = path.join(managerBin, 'npm')
    const plan = path.join(root, 'install-plan.json')
    const calls = path.join(root, 'npm-calls.jsonl')
    writeFileSync(manager, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'prefix') { process.stdout.write(${JSON.stringify(path.join(root, 'other-prefix'))}); process.exit(0); }
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, 'utf8'));
if (args[0] === 'view') {
  if (plan.tags === undefined) process.exit(1);
  process.stdout.write(JSON.stringify(plan.tags));
  process.exit(0);
}
if (plan.exit) process.exit(plan.exit);
const prefix = args[args.indexOf('--prefix') + 1];
const pkg = path.join(prefix, 'lib', 'node_modules', '@raidiant', 'notifai');
fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: plan.version }));
fs.writeFileSync(path.join(pkg, 'dist', 'main.js'), plan.script, { mode: 0o755 });
`)
    chmodSync(manager, 0o755)
    const io = new CapturedIo()
    const deps: CommandDeps = {
      io,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test' },
      env: { PATH: [managerBin, path.dirname(installed.command)].join(':'), HOME: home },
      cwd: root,
      hookAdapterHome: home,
      hookInstallTarget: { execPath: process.execPath, scriptPath: running.artifact },
      hookPlatform: 'darwin',
      runningVersion: version,
    }
    const setPlan = (overrides: Record<string, unknown> = {}) => writeFileSync(plan, JSON.stringify({
      version,
      tags: build.tags,
      script: `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${version}\n`)})\n`,
      ...overrides,
    }))
    setPlan()
    const npmCalls = (): string[][] =>
      readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
    const installedVersion = (): string =>
      JSON.parse(readFileSync(path.join(installed.packageRoot, 'package.json'), 'utf8')).version
    return { root, version, installed, running, home, adapterBefore, io, deps, setPlan, calls, npmCalls, installedVersion }
  }

  /** A published release the fake npm installs; it reports its own version. */
  function release(version: string) {
    return { version, script: `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${version}\n`)})\n` }
  }

  // Newer than every running build, so the updater's own version never blocks the install.
  const next = 11

  it('installs the newer of npm beta and latest as one exact release on the beta channel', () => {
    const f = recoveryFixture()
    const beta = `${next}.0.0-beta.2`
    f.setPlan({ ...release(beta), tags: { latest: '3.0.1', beta } })
    expect(cliUpdateCommand(f.deps, { channel: 'beta', json: true })).toBe(0)
    expect(JSON.parse(f.io.outLines.at(-1)!)).toMatchObject({ ok: true, target: { version: beta, dist_tag: 'beta' } })
    expect(f.npmCalls().at(-1)).toContain(`@raidiant/notifai@${beta}`)
    expect(f.installedVersion()).toBe(beta)

    // Once the stable release ships, the beta channel installs it instead of the
    // older same-core beta.
    const stable = `${next}.0.0`
    f.setPlan({ ...release(stable), tags: { latest: stable, beta } })
    expect(cliUpdateCommand(f.deps, { channel: 'beta', json: true })).toBe(0)
    expect(JSON.parse(f.io.outLines.at(-1)!)).toMatchObject({ ok: true, target: { version: stable, dist_tag: 'latest' } })
    expect(f.npmCalls().at(-1)).toContain(`@raidiant/notifai@${stable}`)
    expect(f.installedVersion()).toBe(stable)
  })

  it('refuses a beta-channel result other than the resolved release', () => {
    const f = recoveryFixture()
    f.setPlan({ ...release(`${next}.0.1`), tags: { latest: '3.0.1', beta: `${next}.0.0-beta.2` } })
    expect(cliUpdateCommand(f.deps, { channel: 'beta', json: true })).toBe(1)
    expect(JSON.parse(f.io.outLines.at(-1)!)).toMatchObject({
      code: 'effective_command_not_target',
      recovery_command: 'npx --yes @raidiant/notifai@latest update --channel beta',
    })
  })

  it.each(RUNNING_BUILDS.flatMap((build) => [
    { name: 'missing runtime dependency', plan: { script: "throw new Error('missing dependency')\n" } },
    { name: 'wrong executable version', plan: { script: "process.stdout.write('3.0.1\\n')\n" } },
    { name: 'invalid package version', plan: { version: 'broken' } },
  ].map((broken) => ({ ...broken, channel: build.channel, build }))))('refuses $name from a $channel build without retargeting hooks, then recovers on retry', ({ plan, build }) => {
    const f = recoveryFixture('3.0.1', build)
    f.setPlan(plan)
    expect(cliUpdateCommand(f.deps, { json: true, channel: build.channel })).toBe(1)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({ ok: false })
    expect(readFileSync(inspectHookAdapter(f.home).path, 'utf8')).toBe(f.adapterBefore)
    f.setPlan()
    expect(cliUpdateCommand(f.deps, { json: true, channel: build.channel })).toBe(0)
  })
})
