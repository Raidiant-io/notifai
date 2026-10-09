#!/usr/bin/env node
// Same published bytes, owned hosted account, diagnostic evidence only.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { repositoryRoot } from './cross-platform.mjs'
import { preparePackedCli, requireOwnedHostedAccount } from './verify-packed-install.mjs'
import { nativeInstallationIdentity } from '../apps/cli/dist/native-installation-identity.js'

const BETA_VERSION = '12.0.0-beta.6'
const BETA_SOURCE = '37d101646cfa1285da93581357244f10d79ca297'
const BASELINE_TIMEOUT = 20_000
const outerStages = output => [...output.matchAll(/notifai-startup:(outer-entered|management-ready|shim-returned)/g)].map(match => match[1])
const help = output => /init/.test(output)
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')

// Kill only the child tree created by this probe, before terminating its root.
// Killing an outer shell alone can strand Node and its synchronous helper.
export function measure(file, args, { cwd, env, phase, timeoutMs }) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let stdout = '', stderr = '', timedOut = false, terminatedTree = null, settled = false, fallback
    const stageEvidence = []
    const finish = (status, signal, failedToStart = false) => {
      if (settled) return
      settled = true
      clearTimeout(deadline); clearTimeout(fallback)
      const record = { phase, timeoutMs, elapsedMs: Date.now() - started, status, signalled: Boolean(signal),
        timedOut, failedToStart, terminatedTree, matchesHelp: help(stdout), outerStages: stageEvidence }
      console.log(JSON.stringify({ event: 'measurement', ...record }))
      resolve(record)
    }
    const collect = (kind, text) => {
      // Buffer only enough for help and fixed stage markers; never report text.
      if (kind === 'stdout') stdout = (stdout + text).slice(0, 1024 * 1024)
      else {
        stderr = (stderr + text).slice(0, 1024 * 1024)
        for (const stage of outerStages(stderr)) if (!stageEvidence.some(item => item.stage === stage)) {
          stageEvidence.push({ stage, atMs: Date.now(), elapsedMs: Date.now() - started })
        }
      }
    }
    child.stdout.setEncoding('utf8').on('data', text => collect('stdout', text))
    child.stderr.setEncoding('utf8').on('data', text => collect('stderr', text))
    const deadline = setTimeout(() => {
      timedOut = true
      if (child.pid && process.platform === 'win32') {
        try {
          execFileSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
          terminatedTree = true
        } catch { terminatedTree = false }
      }
      child.kill('SIGKILL')
      fallback = setTimeout(() => finish(null, 'SIGKILL'), 2_000)
    }, timeoutMs)
    child.once('error', () => finish(null, null, true))
    child.once('close', (status, signal) => finish(status, signal))
  })
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { 'cli-tarball': { type: 'string' },
    'expected-sha': { type: 'string', default: BETA_SOURCE }, 'report-path': { type: 'string' },
    'owned-hosted-account': { type: 'boolean' }, 'longer-timeout-ms': { type: 'string', default: '90000' } } })
  assert.equal(process.platform, 'win32', 'Diagnostic requires native Windows')
  assert.equal(process.arch, 'arm64', 'Diagnostic requires native Windows ARM64')
  assert.ok(values['owned-hosted-account'], 'Explicit --owned-hosted-account is required')
  requireOwnedHostedAccount()
  assert.equal(values['expected-sha'], BETA_SOURCE, 'Probe is bound to the immutable beta source')
  assert.equal(JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/cli/package.json'), 'utf8')).version,
    BETA_VERSION, 'Probe must consume the unchanged beta package')
  assert.ok(values['report-path'], 'Supply --report-path outside the checkout')
  const reportPath = path.resolve(values['report-path'])
  const tracePath = reportPath + '.trace.jsonl'
  assert.ok(!existsSync(reportPath) && !existsSync(tracePath), 'Diagnostic evidence must be new')
  const longerTimeout = Number(values['longer-timeout-ms'])
  assert.ok(Number.isInteger(longerTimeout) && longerTimeout > BASELINE_TIMEOUT && longerTimeout <= 180_000,
    'Longer diagnostic deadline must be between 20001 and 180000ms')
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-startup-diagnostic-'))
  const report = { diagnosticOnly: true, releaseAcceptance: false, version: BETA_VERSION, sourceRevision: BETA_SOURCE,
    measurements: [], trace: [], completed: false }
  writeFileSync(tracePath, '', { flag: 'wx', mode: 0o600 })
  try {
    const tarball = values['cli-tarball'] ? path.resolve(values['cli-tarball']) : path.join(scratch, 'registry.tgz')
    if (!values['cli-tarball']) {
      execFileSync(process.execPath, ['scripts/verify-published.mjs', '@raidiant/notifai', '--expected-sha', BETA_SOURCE,
        '--artifact-output', tarball], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
    }
    // A supplied tarball is the exact registry artifact retained by
    // verify-published.mjs in the workflow; preparePackedCli authenticates it.
    report.tarballSha256 = digest(tarball)
    const prepared = await preparePackedCli(scratch, { cliTarball: tarball, sourceRevision: BETA_SOURCE, ownedHostedAccount: true })
    const bin = path.join(prepared.installedCli, 'bin/notifai.mjs')
    const shimDir = path.join(prepared.installDir, 'node_modules/.bin')
    const psShim = path.join(shimDir, 'notifai.ps1')
    const cmdShim = path.join(shimDir, 'notifai.cmd')
    const env = { ...process.env, ...prepared.env }
    const { version, sourceRevision, sourceDirty, target } = prepared.nativeReceipt.build
    report.nativeBuild = { version, sourceRevision, sourceDirty, target }
    const nativeIdentity = nativeInstallationIdentity(prepared.home, true)
    const adapterManifest = JSON.parse(readFileSync(path.join(prepared.installedCli, 'npm-adapter-files.json'), 'utf8'))
    const unchanged = new Map([psShim, cmdShim, path.join(shimDir, 'notifai'), prepared.nativeCommand, nativeIdentity.runtime,
      ...adapterManifest.files.map(item => path.join(prepared.installedCli, item.path)),
      ...['npm-adapter-files.json', 'inventory.json'].map(name => path.join(prepared.installedCli, name))]
      .map(file => [file, digest(file)]))
    const cmdRunner = path.join(prepared.installDir, 'notifai-cmd-smoke.cmd')
    writeFileSync(cmdRunner, '@call "%NOTIFAI_CMD_SHIM%" --help\r\n', 'ascii')
    const shellEnv = { ...env, NOTIFAI_CMD_SHIM: cmdShim, NOTIFAI_POWERSHELL_SHIM: psShim,
      NOTIFAI_BASH_SHIM: path.join(shimDir, 'notifai') }
    const common = { cwd: prepared.installDir, timeoutMs: BASELINE_TIMEOUT }
    const psArgs = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
    const preload = fileURLToPath(new URL('./diagnose-windows-npm-startup-preload.cjs', import.meta.url)).replaceAll('\\', '/')
    const tracedEnv = phase => ({ ...shellEnv, NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --require="${preload}"`.trim(),
      NOTIFAI_STARTUP_TRACE_FILE: tracePath, NOTIFAI_STARTUP_TRACE_PHASE: phase })
    const run = async (file, args, phase, environment, timeoutMs = BASELINE_TIMEOUT) => {
      const result = await measure(file, args, { ...common, env: environment, phase, timeoutMs })
      report.measurements.push(result)
      if (result.timedOut && result.terminatedTree !== true) {
        report.processTreeCleanupUnproven = true
        throw new Error('Owned process-tree cleanup was not proven')
      }
      return result
    }
    // First sequence uses the original environment, command lines and bounds.
    for (const [file, args, phase] of [
      [process.execPath, [bin, '--help'], 'baseline-direct-node'],
      ['cmd.exe', ['/d', '/v:off', '/c', path.basename(cmdRunner)], 'baseline-cmd-shim'],
      ['powershell.exe', psArgs('& $env:NOTIFAI_POWERSHELL_SHIM --help'), 'baseline-powershell-shim'],
    ]) {
      const result = await run(file, args, phase, phase === 'baseline-direct-node' ? env : shellEnv)
      if (result.status !== 0 || !result.matchesHelp) break
    }
    // Subsequent runs are warm diagnostic repeats with an additive preload;
    // module paths/autoload policy remain inherited from the failed job.
    await run(process.execPath, [bin, '--help'], 'trace-direct-node', tracedEnv('trace-direct-node'))
    await run('cmd.exe', ['/d', '/v:off', '/c', path.basename(cmdRunner)], 'trace-cmd-shim', tracedEnv('trace-cmd-shim'))
    const tracedScript = "[Console]::Error.WriteLine('notifai-startup:outer-entered'); & $env:NOTIFAI_POWERSHELL_SHIM --help; [Console]::Error.WriteLine('notifai-startup:shim-returned'); exit $LASTEXITCODE"
    const traced = await run('powershell.exe', psArgs(tracedScript), 'trace-powershell-shim', tracedEnv('trace-powershell-shim'))
    if (traced.timedOut) await run('powershell.exe', psArgs(tracedScript), 'extended-powershell-diagnostic',
      tracedEnv('extended-powershell-diagnostic'), longerTimeout)
    const traceRecords = readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    if ((traced.timedOut || traced.status !== 0) && !traceRecords.some(record =>
      record.phase === 'trace-powershell-shim' && record.event === 'node-entry')) {
      // Controlled comparison only after the unchanged baseline: load the
      // inbox module used by npm's untouched Split-Path/Test-Path shim.
      const controlledScript = "[Console]::Error.WriteLine('notifai-startup:outer-entered'); $PSModuleAutoLoadingPreference='None'; Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1')); [Console]::Error.WriteLine('notifai-startup:management-ready'); & $env:NOTIFAI_POWERSHELL_SHIM --help; [Console]::Error.WriteLine('notifai-startup:shim-returned'); exit $LASTEXITCODE"
      await run('powershell.exe', psArgs(controlledScript), 'controlled-management-diagnostic', tracedEnv('controlled-management-diagnostic'))
    }
    report.payloadsUnchanged = [...unchanged].every(([file, sha]) => digest(file) === sha)
    assert.ok(report.payloadsUnchanged, 'Diagnostic changed an installed payload')
    report.completed = true
  } finally {
    for (const line of readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean)) {
      try { report.trace.push(JSON.parse(line)) } catch { report.traceIncomplete = true }
    }
    report.scratchRetained = report.processTreeCleanupUnproven === true
    const groups = new Map()
    for (const event of report.trace.filter(item => item.event === 'exec-start' || item.event === 'exec-end')) {
      const key = `${event.phase}:${event.category}`
      if (!groups.has(key)) groups.set(key, { phase: event.phase, category: event.category, started: 0, finished: 0, elapsedMs: 0 })
      const group = groups.get(key)
      if (event.event === 'exec-start') group.started++
      else { group.finished++; group.elapsedMs += event.elapsedMs }
    }
    report.helperSummary = [...groups.values()].map(group => ({ ...group, unfinished: group.started - group.finished }))
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ event: 'diagnostic-report', diagnosticOnly: true, releaseAcceptance: false,
      completed: report.completed, measurements: report.measurements.length, traceEvents: report.trace.length }))
    if (!report.processTreeCleanupUnproven) rmSync(scratch, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main() } catch { console.error('Windows npm startup diagnostic failed; inspect the structured report if created.'); process.exitCode = 1 }
}
