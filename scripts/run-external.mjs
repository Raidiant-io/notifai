/**
 * Run one external process with a required timeout and a named phase.
 *
 * Packed and release gates previously used unbounded `execFileSync` / `spawn`.
 * When `npm exec` stalled after the registry metadata endpoint was already
 * reachable, that hang consumed the whole hosted-runner timeout with no
 * indication of which step had stopped. Every external process in those gates
 * now fails its named phase instead.
 */
import { spawnSync } from 'node:child_process'

const OUTPUT_LIMIT = 2_000

function clip(text) {
  const value = String(text ?? '').trim()
  if (value.length <= OUTPUT_LIMIT) return value
  return `${value.slice(0, OUTPUT_LIMIT)}…`
}

export function timedOut(result, timeoutMs, elapsedMs) {
  return result.error?.code === 'ETIMEDOUT' || (result.signal != null && elapsedMs >= timeoutMs)
}

export function formatPhaseTimeout({ phase, timeoutMs, elapsedMs, result }) {
  const parts = [
    `phase ${phase} timed out after ${timeoutMs}ms (elapsed ${elapsedMs}ms)`,
    'the process did not exit',
  ]
  const stderr = clip(result.stderr)
  const stdout = clip(result.stdout)
  if (stderr) parts.push(`stderr: ${stderr}`)
  if (stdout) parts.push(`stdout: ${stdout}`)
  if (result.signal) parts.push(`signal: ${result.signal}`)
  return parts.join('; ')
}

/**
 * Spawn a process and fail closed when it exceeds `timeoutMs`.
 *
 * `phase` is required so a timeout names the stalled step. `timeoutMs` must be
 * a positive number; omitting it is the defect this helper exists to prevent.
 */
export function runExternal(file, args, options) {
  const phase = options?.phase
  const timeoutMs = options?.timeoutMs
  if (typeof phase !== 'string' || phase.trim() === '') {
    throw new Error('runExternal requires a non-empty phase name')
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`phase ${phase} requires a positive timeoutMs`)
  }

  const started = Date.now()
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: options.windowsHide ?? true,
    shell: false,
  })
  const elapsedMs = Date.now() - started

  if (timedOut(result, timeoutMs, elapsedMs)) {
    throw new Error(formatPhaseTimeout({ phase, timeoutMs, elapsedMs, result }))
  }
  if (result.error) {
    throw new Error(`phase ${phase} failed to start (${result.error.message})`)
  }

  return { ...result, elapsedMs, phase }
}

export function requireStatus(result, expected = 0) {
  if (result.status === expected) return result
  const stderr = clip(result.stderr)
  const stdout = clip(result.stdout)
  throw new Error(
    `phase ${result.phase} exited ${result.status}` +
      (stderr ? `; stderr: ${stderr}` : '') +
      (stdout ? `; stdout: ${stdout}` : ''),
  )
}
