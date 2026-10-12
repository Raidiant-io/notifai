import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { acquireNative } from './bootstrap.mjs'
import { adapterRoutesOnPath, environmentForVerifiedAdapter } from '../dist/npm-adapter-route.js'

export const ADAPTER_HELP = 'Usage: notifai <command>\n\nRun notifai init to install the native runtime and approve this computer.\nUse notifai install for explicit installation, notifai update for runtime updates, and notifai doctor for diagnosis.\nNode.js is required only for this npm launcher. Removing it through npm leaves the native runtime installed.'

export async function prepareNativeLaunch(proof, { env, platform, existing = null }) {
  const options = { platform: platform.platform ?? process.platform, checkAccess: platform.checkAccess }
  // This ephemeral locator is diagnostic input only. Native code revalidates it
  // and consumes it before launching residents; no NPX path is persisted.
  const childEnv = { ...environmentForVerifiedAdapter(proof, env, options), NOTIFAI_NPM_ADAPTER_ARTIFACT: proof.executable }
  const globals = adapterRoutesOnPath(proof, childEnv, options).filter(route => route.kind === 'global')
  if (existing && globals.length) {
    const probe = await platform.capture(existing, ['self-check', '--json'])
    let report
    try { report = JSON.parse(probe.stdout) } catch { /* Missing capability is unsupported. */ }
    if (probe.status !== 0 || report?.ok !== true || report.capabilities?.npm_adapter_routes !== 1) {
      const prefix = globals[0].global_prefix
      const steps = [
        { executable: 'npm', args: ['uninstall', '--global', '--prefix', prefix, '@raidiant/notifai'] },
        { executable: existing, args: ['update'] },
        { executable: 'npm', args: ['install', '--global', '--prefix', prefix, `@raidiant/notifai@${proof.manifest.adapter_version}`] },
      ]
      const quote = text => options.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`
      const commands = steps.map(step => `${options.platform === 'win32' && step.executable !== 'npm' ? '& ' : ''}${quote(step.executable)} ${step.args.map(quote).join(' ')}`)
      return { env: childEnv, problem: { ok: false, code: 'native_adapter_routes_unsupported', native_command: existing,
        adapter_prefix: prefix, adapter_version: proof.manifest.adapter_version, steps,
        message: `This native runtime cannot use the verified global npm launcher yet. Remove only this adapter, update the native runtime by its absolute command, then reinstall the adapter:\n${commands.join('\n')}` } }
    }
  }
  return { env: childEnv, problem: null }
}

function installOptions(args, locator) {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' }, version: { type: 'string' },
    channel: { type: 'string' }, 'no-init': { type: 'boolean' }, 'no-path': { type: 'boolean' },
    'migrate-npm': { type: 'boolean' }, shell: { type: 'string' } } })
  const channel = locator.version.split('+')[0].includes('-') ? 'beta' : 'stable'
  assert.ok(!values.version || values.version === locator.version, `This npm adapter acquires ${locator.version}; use native update for another runtime version`)
  assert.ok(!values.channel || values.channel === channel, `This npm adapter acquires the ${channel} release; use native update to change channel`)
  const forwarded = []
  for (const key of ['json', 'no-init', 'no-path', 'migrate-npm']) if (values[key]) forwarded.push(`--${key}`)
  if (values.shell !== undefined) forwarded.push('--shell', values.shell)
  return forwarded
}

/** Existing installations are always launched before any acquisition decision. */
export async function runNpmAdapter(args, { locator, platform, distribution, verify, env = process.env, out = console.log, err = console.error }) {
  const existing = platform.existingCommand()
  const command = args[0], json = args.includes('--json')
  if (existing !== null) {
    const proof = verify()
    const prepared = await prepareNativeLaunch(proof, { env, platform,
      existing: args.length === 0 || args.includes('--help') || args.includes('-h') || ['--version', '-V', 'self-check'].includes(command) ? null : existing })
    if (prepared.problem) {
      if (json) out(JSON.stringify(prepared.problem))
      else err(prepared.problem.message)
      return 2
    }
    platform.setEnvironment?.(prepared.env)
    return platform.execute(existing, args.length ? args : ['--help'])
  }
  if (!command || args.includes('--help') || args.includes('-h')) { out(ADAPTER_HELP); return 0 }
  if (command === 'uninstall') {
    const report = { ok: true, code: 'native_not_installed', runtime_installed: false,
      message: 'No native Notifai runtime is installed. Remove this npm launcher with the package manager that installed it; npm removal affects only the launcher.' }
    if (json) out(JSON.stringify(report))
    else out(report.message)
    return 0
  }
  const needed = { ok: false, code: 'setup_needed', adapter_version: locator.version,
    runtime_installed: false, next_action: 'notifai init',
    message: 'The native Notifai runtime is not installed. Run notifai init. npm removes this launcher only.' }
  if (!['init', 'install'].includes(command)) {
    if (json) out(JSON.stringify(needed))
    else err(needed.message + (command === '--version' || command === '-V' ? ` Npm launcher version: ${locator.version}.` : ''))
    return 2
  }
  const forwarded = command === 'install' ? installOptions(args.slice(1), locator) : []
  const release = verify()
  assert.equal(release.manifest.native.version, locator.version, 'Adapter code/native version mismatch')
  assert.equal(release.manifest.native.source_revision, locator.source_revision, 'Adapter code/native source mismatch')
  const prepared = await prepareNativeLaunch(release, { env, platform })
  platform.setEnvironment?.(prepared.env)
  const result = await acquireNative(release, { platform, distribution, capture: command === 'init', installArgs: forwarded })
  if (command === 'install') return result
  if (result.status !== 0 || result.report.runtime_installed !== true) {
    if (json) out(JSON.stringify(result.report))
    else err(result.report.message ?? 'Native installation needs attention before setup can continue.')
    return result.status || 2
  }
  const stable = platform.existingCommand()
  assert.ok(stable, 'Native installation did not produce its fixed owned command')
  return platform.execute(stable, args)
}
