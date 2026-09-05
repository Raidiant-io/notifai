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
import { packageVersion } from './release.js'
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

describe('CLI update recovery', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function recoveryFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-update-retry-'))
    roots.push(root)
    const version = packageVersion()!
    const installed = npmInstall(root, 'installed', '3.0.1')
    const running = npmInstall(root, 'running', version)
    const home = path.join(root, 'home')
    installHookAdapter({ execPath: process.execPath, scriptPath: running.artifact }, home)
    const adapterBefore = readFileSync(inspectHookAdapter(home).path, 'utf8')
    const managerBin = path.join(root, 'manager', 'bin')
    mkdirSync(managerBin, { recursive: true })
    const manager = path.join(managerBin, 'npm')
    const plan = path.join(root, 'install-plan.json')
    writeFileSync(manager, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'prefix') { process.stdout.write(${JSON.stringify(path.join(root, 'other-prefix'))}); process.exit(0); }
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, 'utf8'));
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
    }
    const setPlan = (overrides: Record<string, unknown> = {}) => writeFileSync(plan, JSON.stringify({
      version,
      script: `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${version}\n`)})\n`,
      ...overrides,
    }))
    setPlan()
    return { root, installed, running, home, adapterBefore, io, deps, setPlan }
  }

  it('repairs an interrupted install whose only npm command is a dangling symlink', () => {
    const f = recoveryFixture()
    rmSync(f.installed.packageRoot, { recursive: true })
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({ ok: true, update_prefix: realpathSync(f.installed.prefix) })
    expect(spawnSync(f.installed.command, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(packageVersion())
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
      expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({ ok: false, code: 'update_destination_unknown' })
      const inferredPrefix = path.dirname(path.join(f.root, layout))
      expect(existsSync(path.join(inferredPrefix, 'lib', 'node_modules'))).toBe(false)
      expect(readFileSync(artifact, 'utf8')).toContain('3.0.1')
    },
  )

  it.each([
    { name: 'missing runtime dependency', script: "throw new Error('missing dependency')\n" },
    { name: 'wrong executable version', script: "process.stdout.write('3.0.1\\n')\n" },
    { name: 'invalid package version', version: 'broken' },
  ])('refuses $name without retargeting hooks, then recovers on retry', (broken) => {
    const f = recoveryFixture()
    f.setPlan(broken)
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(1)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({ ok: false })
    expect(readFileSync(inspectHookAdapter(f.home).path, 'utf8')).toBe(f.adapterBefore)
    f.setPlan()
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
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

  it('reports a partial upgrade when hook replacement fails and repairs it on retry', () => {
    const f = recoveryFixture()
    const adapter = inspectHookAdapter(f.home).path
    rmSync(adapter)
    symlinkSync(f.running.artifact, adapter)
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(1)
    expect(JSON.parse(f.io.outLines[0]!)).toMatchObject({
      ok: false,
      code: 'hook_adapter_retarget_failed',
      recovery_command: expect.stringContaining(' update'),
      after: { effective: { version: packageVersion() } },
    })
    expect(readFileSync(f.running.artifact, 'utf8')).toContain(packageVersion())
    rmSync(adapter)
    installHookAdapter({ execPath: process.execPath, scriptPath: f.running.artifact }, f.home)
    expect(cliUpdateCommand(f.deps, { json: true })).toBe(0)
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
    expect(spawnSync(inspectHookAdapter(f.home).path, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(packageVersion())
  })

  it('updates the PATH winner prefix and retargets the shared hook adapter in one action', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-update-loop-'))
    roots.push(root)
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
