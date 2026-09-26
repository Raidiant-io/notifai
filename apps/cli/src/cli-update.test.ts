import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandDeps, CommandIo } from './commands-core.js'
import { cliUpdateCommand } from './commands-update.js'
import { installHookAdapter, inspectHookAdapter } from './hook-adapter.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { codexHookIdentityHash, codexTrustKey, codexTrustProblems, findInstallations } from './install-hooks.js'
import { readSessionState, sessionStatePath, writeSessionState } from './hook-session-state.js'
import { enableProject, projectBinding, projectEnabled } from './project-enablement.js'

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
      recovery_command: 'npx --yes @raidiant/notifai@beta update --channel beta',
    })
  })

  it('refuses to move a beta installation back to an older stable release without an explicit channel', () => {
    const beta = `${next}.0.0-beta.2`
    const f = recoveryFixture(beta)
    f.setPlan({ ...release('3.0.1'), tags: { latest: '3.0.1', beta } })
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(1)
    expect(JSON.parse(f.io.outLines.at(-1)!)).toMatchObject({
      ok: false,
      code: 'update_would_downgrade',
      recovery_command: 'npx --yes @raidiant/notifai@beta update --channel beta',
      target: { version: '3.0.1', dist_tag: 'latest' },
    })
    expect(f.npmCalls().some((args) => args[0] === 'install')).toBe(false)
    expect(f.installedVersion()).toBe(beta)

    // The stable release that supersedes the beta is an ordinary update.
    const stable = `${next}.0.0`
    f.setPlan({ ...release(stable), tags: { latest: stable, beta } })
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
    expect(f.npmCalls().at(-1)).toContain(`@raidiant/notifai@${stable}`)
    expect(f.installedVersion()).toBe(stable)
  })

  it('switches a newer global beta to the selected public release only when stable is explicit', () => {
    const beta = RUNNING_BUILDS[1].version
    const stable = RUNNING_BUILDS[0].version
    const f = recoveryFixture(beta, RUNNING_BUILDS[1])
    f.setPlan({ tags: undefined })
    expect(cliUpdateCommand(f.deps, { channel: 'stable', json: true })).toBe(1)
    expect(JSON.parse(f.io.outLines.at(-1)!)).toMatchObject({
      code: 'release_versions_unavailable',
      recovery_command: 'npx --yes @raidiant/notifai@latest update --channel stable',
    })
    expect(f.npmCalls().some((args) => args[0] === 'install')).toBe(false)

    f.setPlan({
      version: stable,
      tags: { latest: stable, beta },
      script: `#!${process.execPath}\nif (process.argv[2] === '--version') process.stdout.write(${JSON.stringify(`${stable}\n`)}); else process.stdout.write(JSON.stringify({ ok: true, read_only: true, running_version: ${JSON.stringify(stable)} }));\n`,
    })

    expect(cliUpdateCommand(f.deps, { channel: 'stable', json: true })).toBe(0)
    const report = JSON.parse(f.io.outLines.at(-1)!)
    expect(report).toMatchObject({
      ok: true,
      update_prefix: realpathSync(f.installed.prefix),
      target: { version: stable, dist_tag: 'latest' },
      handoff: { ok: true, read_only: true, running_version: stable },
    })
    expect(f.npmCalls().at(-1)).toContain(`@raidiant/notifai@${stable}`)
    expect(f.installedVersion()).toBe(stable)
    expect(inspectHookAdapter(f.home).target).toMatchObject({ scriptPath: realpathSync(f.installed.artifact) })
  })

  it('refuses the beta channel when the installation is newer than every published release', () => {
    const f = recoveryFixture(`${next}.1.0`)
    f.setPlan({ ...release(`${next}.0.0`), tags: { latest: `${next}.0.0`, beta: `${next}.0.0-beta.2` } })
    expect(cliUpdateCommand(f.deps, { channel: 'beta', json: true })).toBe(1)
    const report = JSON.parse(f.io.outLines.at(-1)!)
    expect(report).toMatchObject({ ok: false, code: 'update_would_downgrade' })
    expect(report.recovery_command).not.toContain('update')
    expect(f.npmCalls().some((args) => args[0] === 'install')).toBe(false)
    expect(f.installedVersion()).toBe(`${next}.1.0`)
  })

  it('installs nothing on the beta channel when the published versions cannot be read', () => {
    const f = recoveryFixture()
    f.setPlan({ ...release(`${next}.0.0-beta.2`), tags: undefined })
    expect(cliUpdateCommand(f.deps, { channel: 'beta', json: true })).toBe(1)
    expect(JSON.parse(f.io.outLines.at(-1)!)).toMatchObject({
      ok: false,
      code: 'release_versions_unavailable',
      recovery_command: 'npx --yes @raidiant/notifai@beta update --channel beta',
    })
    expect(f.npmCalls().some((args) => args[0] === 'install')).toBe(false)
    expect(f.installedVersion()).toBe('3.0.1')
  })

  it('updates the real PATH winner when npx prepends its own temporary launcher', () => {
    const f = recoveryFixture()
    const modules = path.join(f.root, '_npx', 'cache-key', 'node_modules')
    const artifact = path.join(modules, '@raidiant', 'notifai', 'dist', 'main.js')
    const bin = path.join(modules, '.bin')
    mkdirSync(path.dirname(artifact), { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(path.dirname(artifact), '..', 'package.json'), JSON.stringify({ version: f.version }))
    writeFileSync(artifact, readFileSync(f.running.artifact), { mode: 0o755 })
    symlinkSync(artifact, path.join(bin, 'notifai'))
    f.deps.hookInstallTarget = { execPath: process.execPath, scriptPath: artifact }
    f.deps.env.PATH = `${bin}:${f.deps.env.PATH}`
    f.setPlan({ script: `#!${process.execPath}\nif(process.argv[2]==='--version')process.stdout.write(${JSON.stringify(f.version)});else process.stdout.write(JSON.stringify({ok:true,read_only:true,running_version:${JSON.stringify(f.version)},path:process.env.PATH}));` })
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
    const report = JSON.parse(f.io.outLines[0]!)
    expect(report.update_prefix).toBe(realpathSync(f.installed.prefix))
    expect(report.before.effective.command_path).toBe(f.installed.command)
    expect(report.after.effective.command_path).toBe(f.installed.command)
    expect(report.handoff.path.split(':')).not.toContain(bin)
    expect(f.deps.env.PATH).toContain(bin)
    expect(readFileSync(artifact, 'utf8')).toBe(readFileSync(f.running.artifact, 'utf8'))
  })

  it.each(RUNNING_BUILDS)('repairs an interrupted install whose only npm command is a dangling symlink from a $channel build', (build) => {
    const f = recoveryFixture('3.0.1', build)
    rmSync(f.installed.packageRoot, { recursive: true })
    expect(cliUpdateCommand(f.deps, { json: true, channel: build.channel })).toBe(0)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({ ok: true, update_prefix: realpathSync(f.installed.prefix) })
    expect(f.npmCalls().at(-1)?.at(-1)).toBe(build.installSpec)
    expect(spawnSync(f.installed.command, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(build.version)
    expect(inspectHookAdapter(f.home).target).toMatchObject({ scriptPath: realpathSync(f.installed.artifact) })
  })

  it.each(['project/node_modules', 'pnpm/.pnpm/notifai/node_modules'])(
    'refuses the unsupported %s installation before npm can write into it',
    (layout) => {
      const f = recoveryFixture()
      const artifact = path.join(f.root, layout, '@raidiant', 'notifai', 'dist', 'main.js')
      mkdirSync(path.dirname(artifact), { recursive: true })
      writeFileSync(path.join(path.dirname(artifact), '..', 'package.json'), JSON.stringify({ version: '3.0.1' }))
      writeFileSync(artifact, `#!${process.execPath}\nprocess.stdout.write('3.0.1\\n')\n`, { mode: 0o755 })
      rmSync(f.installed.command)
      symlinkSync(artifact, f.installed.command)
      expect(cliUpdateCommand(f.deps, { json: true })).toBe(1)
      expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({
        ok: false, code: 'update_destination_unknown',
        recovery_command: 'npx --yes @raidiant/notifai@latest doctor --json',
        message: expect.stringContaining('package manager that installed'),
      })
      expect(f.io.outLines.join('\n')).not.toContain('@raidiant/notifai@latest update')
      const inferredPrefix = path.dirname(path.join(f.root, layout))
      expect(existsSync(path.join(inferredPrefix, 'lib', 'node_modules'))).toBe(false)
      expect(readFileSync(artifact, 'utf8')).toContain('3.0.1')
    },
  )

  it.each(RUNNING_BUILDS)('explains an unreachable npm prefix without prescribing the same refused updater from a $channel build', (build) => {
    const f = recoveryFixture('3.0.1', build)
    rmSync(f.installed.command)
    expect(cliUpdateCommand(f.deps, { json: true, channel: build.channel })).toBe(1)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({
      ok: false, code: 'package_manager_prefix_not_on_path',
      recovery_command: `npx --yes @raidiant/notifai@${build.distTag} doctor --json`,
      message: expect.stringContaining('not on PATH'),
    })
    expect(f.io.outLines.join('\n')).not.toContain(`@raidiant/notifai@${build.distTag} update`)
    f.io.interactive = true
    expect(cliUpdateCommand(f.deps, { channel: build.channel })).toBe(1)
    expect(f.io.errLines.join('\n')).toContain('not on PATH')
    expect(f.io.errLines.join('\n')).not.toContain(`@raidiant/notifai@${build.distTag} update`)
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

  it('keeps the installation and adapter unchanged offline and resumes on retry', () => {
    const f = recoveryFixture()
    const before = readFileSync(f.installed.artifact, 'utf8')
    f.setPlan({ exit: 1 })
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(1)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({ ok: false, code: 'package_install_failed' })
    expect(readFileSync(f.installed.artifact, 'utf8')).toBe(before)
    expect(readFileSync(inspectHookAdapter(f.home).path, 'utf8')).toBe(f.adapterBefore)
    f.setPlan()
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
  })

  it('gets the handoff from the installed artifact using the previous PATH version', () => {
    const f = recoveryFixture()
    f.setPlan({ script: `#!${process.execPath}\nif(process.argv[2]==='--version')process.stdout.write(${JSON.stringify(f.version)});else process.stdout.write(JSON.stringify({ok:true,read_only:true,running_version:${JSON.stringify(f.version)},args:process.argv.slice(2),new_release_marker:'new artifact'}));` })
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
    const report = JSON.parse(f.io.outLines[0]!)
    expect(report.handoff).toMatchObject({ new_release_marker: 'new artifact', args: ['update', '--check', '--json', '--from', '3.0.1'] })
    expect(report.handoff_error).toBeNull()
    expect(report.follow_up_required).toBe(true)
  })

  it('reports incomplete follow-up when the new artifact rejects its handoff', () => {
    const f = recoveryFixture()
    f.setPlan({ script: `#!${process.execPath}\nif(process.argv[2]==='--version')process.stdout.write(${JSON.stringify(f.version)});else process.stdout.write(JSON.stringify({ok:false,read_only:true,running_version:${JSON.stringify(f.version)}}));` })
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
    const report = JSON.parse(f.io.outLines[0]!)
    expect(report.handoff).toBeNull()
    expect(report.handoff_error).toContain('update --check --json')
  })

  it('gives unattended failures structured retry evidence without requiring --json', () => {
    const f = recoveryFixture()
    f.setPlan({ exit: 1 })
    expect(cliUpdateCommand(f.deps, {})).toBe(1)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({
      ok: false,
      code: 'package_install_failed',
      recovery_command: 'npx --yes @raidiant/notifai@latest update',
    })
    expect(f.io.errLines).toEqual([])
    f.io.interactive = true
    expect(cliUpdateCommand(f.deps, {})).toBe(1)
    expect(f.io.errLines).toEqual([
      'Notifai could not finish updating. Retry with:',
      'npx --yes @raidiant/notifai@latest update',
    ])
  })

  it.each(RUNNING_BUILDS)('reports a partial upgrade from a $channel build when hook replacement fails and repairs it on retry', (build) => {
    const f = recoveryFixture('3.0.1', build)
    const adapter = inspectHookAdapter(f.home).path
    rmSync(adapter)
    symlinkSync(f.running.artifact, adapter)
    expect(cliUpdateCommand(f.deps, { json: true, channel: build.channel })).toBe(1)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({
      ok: false,
      code: 'hook_adapter_retarget_failed',
      recovery_command: expect.stringContaining(' update'),
      after: { effective: { version: build.version } },
    })
    expect(readFileSync(f.running.artifact, 'utf8')).toContain(build.version)
    rmSync(adapter)
    installHookAdapter({ execPath: process.execPath, scriptPath: f.running.artifact }, f.home)
    expect(cliUpdateCommand(f.deps, { json: true, channel: build.channel })).toBe(0)
  })

  it('keeps account-scoped hook trust and queued session work across an update', () => {
    const f = recoveryFixture()
    const codexHome = path.join(f.home, 'accounts', 'selected-codex')
    f.deps.env['CODEX_HOME'] = codexHome
    f.deps.env['XDG_STATE_HOME'] = path.join(f.home, 'state')
    f.deps.env['XDG_CONFIG_HOME'] = path.join(f.home, 'config')
    expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toBe(0)
    const installations = findInstallations(f.deps.env, f.home)
    const codex = installations.find((entry) => entry.harness === 'codex')!
    const trustFile = path.join(codexHome, 'config.toml')
    writeFileSync(trustFile, codex.handlers.map((handler) =>
      `[hooks.state.${JSON.stringify(codexTrustKey(codex, handler))}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`,
    ).join('\n'))
    expect(codexTrustProblems(installations, f.deps.env)).toEqual([])
    const enabled = projectBinding(f.root, f.deps.env, 'enabled-project')!
    const disabled = projectBinding(f.root, f.deps.env, 'disabled-project')!
    enableProject(enabled)
    writeSessionState('upgrade-session', f.deps.env, {
      pending: [{
        question_id: 'question-existing',
        request_id: 'request-pending',
        question: 'Continue the release?',
        summary: 'Continue the release?',
        asked_at: 1_800_000_000_000,
      }],
      acknowledgement_due: [{ request_id: 'request-existing', recorded_at: 1_800_000_000_000 }],
    })
    const protectedFiles = [codex.file, trustFile, enabled.markerPath, sessionStatePath('upgrade-session', f.deps.env)]
    const before = protectedFiles.map((file) => readFileSync(file, 'utf8'))
    f.setPlan({ exit: 1 })
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(1)
    expect(protectedFiles.map((file) => readFileSync(file, 'utf8'))).toEqual(before)
    f.setPlan()
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
    expect(protectedFiles.map((file) => readFileSync(file, 'utf8'))).toEqual(before)
    expect(codexTrustProblems(findInstallations(f.deps.env, f.home), f.deps.env)).toEqual([])
    expect(readSessionState('upgrade-session', f.deps.env).acknowledgement_due).toHaveLength(1)
    expect(readSessionState('upgrade-session', f.deps.env).pending?.[0]?.question_id).toBe('question-existing')
    expect(projectEnabled(enabled)).toBe(true)
    expect(projectEnabled(disabled)).toBe(false)
    expect(spawnSync(inspectHookAdapter(f.home).path, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(f.version)
  })

  it.each(RUNNING_BUILDS)('updates the PATH winner prefix and retargets the shared hook adapter in one action from a $channel build', (build) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-update-loop-'))
    roots.push(root)
    const currentVersion = build.version
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
if (args[0] === 'view') {
  process.stdout.write(${JSON.stringify(JSON.stringify(build.tags))});
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
    io.interactive = true
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
      runningVersion: currentVersion,
    }

    expect(cliUpdateCommand(deps, { channel: build.channel })).toBe(0)
    expect(JSON.parse(readFileSync(path.join(stale.packageRoot, 'package.json'), 'utf8'))).toMatchObject({
      version: currentVersion,
    })
    expect(
      readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    ).toEqual([
      ...(build.channel === 'beta' ? [['view', '@raidiant/notifai', 'dist-tags', '--json']] : []),
      ['prefix', '--global'],
      ['install', '--global', '--prefix', realpathSync(stale.prefix), build.installSpec],
    ])
    expect(spawnSync(stale.command, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(currentVersion)
    expect(inspectHookAdapter(home).target).toMatchObject({ scriptPath: realpathSync(stale.artifact) })
    expect(io.outLines.join('\n')).toContain('notifai update --check --json')
    expect(io.outLines.join('\n')).toContain('a restart is not automatic')
    expect(io.outLines.join('\n')).not.toContain(root)
    expect(io.errLines).toEqual([])

    io.outLines = []
    expect(cliUpdateCommand(deps, { json: true, channel: build.channel })).toBe(0)
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
