// Diagnostic-only Node preload. Never prints arguments, paths, environment,
// subprocess output, or credentials; forwards every call unchanged.
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require needs a synchronous CommonJS preload before ESM evaluation. */
const childProcess = require('node:child_process')
const { appendFileSync } = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const { performance } = require('node:perf_hooks')
const traceFile = process.env.NOTIFAI_STARTUP_TRACE_FILE
const phase = process.env.NOTIFAI_STARTUP_TRACE_PHASE
if (!traceFile || !/^[a-z0-9-]{1,80}$/.test(phase || '')) throw new Error('Startup trace requires a diagnostic owner')
let sequence = 0
const mark = record => appendFileSync(traceFile, JSON.stringify({ atMs: Date.now(), pid: process.pid,
  parentPid: process.ppid, phase, ...record }) + '\n')
const stages = output => [...String(output || '').matchAll(/notifai-bootstrap:([a-z-]+)/g)]
  .map(match => match[1]).filter(stage => ['started', 'modules-ready', 'encoding-ready', 'helper-ready',
    'operation-started', 'home-ready', 'command-ready', 'complete'].includes(stage))
function category(file, args = []) {
  if (/(?:^|[\\/])powershell\.exe$/i.test(String(file))) {
    const index = args.indexOf('-EncodedCommand')
    const code = index < 0 ? '' : Buffer.from(String(args[index + 1] || ''), 'base64').toString('utf16le')
    if (code.includes('Get-NotifaiInstalledCommand')) return 'installed-command'
    if (code.includes('Assert-NotifaiPathAccess')) return 'path-acl'
    if (code.includes('Get-NotifaiWindowsTarget')) return 'native-target'
    if (code.includes('New-NotifaiPrivateDirectory')) return 'private-directory'
    return 'powershell-other'
  }
  if (args.some(arg => String(arg).startsWith('--internal-check-package-'))) return 'native-package-acl'
  if (/(?:^|[\\/])notifai(?:-runtime)?\.exe$/i.test(String(file))) return 'native-launch'
  return 'other'
}
mark({ event: 'node-entry' })
const originalExec = childProcess.execFileSync
childProcess.execFileSync = function (file, args, options) {
  const id = ++sequence, kind = category(file, Array.isArray(args) ? args : [])
  const started = performance.now()
  mark({ event: 'exec-start', id, category: kind, timeoutMs: options?.timeout || null })
  try {
    const result = Reflect.apply(originalExec, this, arguments)
    mark({ event: 'exec-end', id, category: kind, elapsedMs: Math.round(performance.now() - started), status: 0 })
    return result
  } catch (error) {
    mark({ event: 'exec-end', id, category: kind, elapsedMs: Math.round(performance.now() - started),
      status: typeof error.status === 'number' ? error.status : null,
      timedOut: error.code === 'ETIMEDOUT', stages: stages(error.stderr) })
    throw error
  }
}
const originalSpawn = childProcess.spawn
childProcess.spawn = function (file, args) {
  const id = ++sequence, kind = category(file, Array.isArray(args) ? args : [])
  const started = performance.now()
  const child = Reflect.apply(originalSpawn, this, arguments)
  mark({ event: 'spawn-start', id, category: kind, childPid: child.pid || null })
  child.once('close', (status, signal) => mark({ event: 'spawn-end', id, category: kind,
    elapsedMs: Math.round(performance.now() - started), status, signalled: signal !== null }))
  return child
}
syncBuiltinESMExports()
