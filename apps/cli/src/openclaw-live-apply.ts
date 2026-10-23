/**
 * Apply a changed Notifai plugin to a running OpenClaw Gateway.
 *
 * A running Gateway keeps the plugin generation it loaded. Editing the plugin
 * files alone does not replace it; OpenClaw applies source edits only through
 * `openclaw plugins reload <id>` (or its next start). The reload drains the old
 * generation, awaits its service stop, then registers the new one and returns
 * the applied generation. It is idempotent, so a lost or interrupted reload is
 * safe to repeat; until it applies, the readiness fence keeps answers off the
 * older generation (`openclaw-gateway-readiness.ts`).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { OPENCLAW_PLUGIN_ID } from './openclaw-plugin.js'

/** OpenClaw drains in-flight plugin work for up to 60 s before it replaces. */
export const OPENCLAW_RELOAD_TIMEOUT_MS = 90_000

export type OpenclawLiveApply =
  | { status: 'applied'; generation: number; restartRequired: boolean }
  | { status: 'saved'; reason: 'no-running-gateway' | 'openclaw-cli-unavailable' }
  | { status: 'failed'; reason: string }

export type OpenclawRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>

const defaultRunner: OpenclawRunner = (command, args, options) => spawnSync(command, args, {
  env: options.env, timeout: options.timeout, encoding: 'utf8', maxBuffer: 1024 * 1024,
  shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})

/** OpenClaw prints one JSON document first; trailing lines are human notes. */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0, inString = false, escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) {
      try {
        const value: unknown = JSON.parse(text.slice(start, index + 1))
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
      } catch { return null }
    }
  }
  return null
}

const NO_GATEWAY = /gateway (?:is )?not (?:running|reachable)|no (?:running|local) gateway|ECONNREFUSED|requires a running gateway|could not connect/i

export function applyOpenclawPluginLive(env: NodeJS.ProcessEnv, run: OpenclawRunner = defaultRunner): OpenclawLiveApply {
  const result = run('openclaw', ['plugins', 'reload', OPENCLAW_PLUGIN_ID, '--json'],
    { env, timeout: OPENCLAW_RELOAD_TIMEOUT_MS })
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return { status: 'saved', reason: 'openclaw-cli-unavailable' }
  if (code === 'ETIMEDOUT') return { status: 'failed', reason: 'the Gateway did not apply the reload in time' }
  const output = `${result.stdout ?? ''}`
  const json = firstJsonObject(output)
  const runtime = json?.['runtime']
  const generation = runtime !== null && typeof runtime === 'object' ? (runtime as Record<string, unknown>)['generation'] : undefined
  if (result.status === 0 && json?.['ok'] === true && typeof generation === 'number' && Number.isInteger(generation)) {
    return { status: 'applied', generation, restartRequired: json['restartRequired'] === true }
  }
  const error = json?.['error']
  const message = error !== null && typeof error === 'object' && typeof (error as Record<string, unknown>)['message'] === 'string'
    ? (error as Record<string, unknown>)['message'] as string
    : `${result.stderr ?? ''}`.trim().split(/\r?\n/)[0] ?? ''
  if (NO_GATEWAY.test(`${message}\n${result.stderr ?? ''}`)) return { status: 'saved', reason: 'no-running-gateway' }
  return { status: 'failed', reason: message.slice(0, 400) || `openclaw exited with ${String(result.status)}` }
}

/** One sentence for the install close: what the Gateway is running now. */
export function openclawLiveApplyText(outcome: OpenclawLiveApply): string {
  switch (outcome.status) {
    case 'applied':
      return outcome.restartRequired
        ? `The running OpenClaw Gateway applied Notifai plugin generation ${outcome.generation} but reports that a restart is required to load it. A restart expires waiting Notifai questions: restart the Gateway once none waits.`
        : `The running OpenClaw Gateway applied the Notifai plugin as generation ${outcome.generation}.`
    case 'saved':
      return outcome.reason === 'no-running-gateway'
        ? 'No running OpenClaw Gateway answered; the plugin is saved and loads when the Gateway next starts.'
        : 'The `openclaw` command is not on PATH, so a running Gateway keeps its previous Notifai plugin until `openclaw plugins reload notifai` runs; a reload keeps waiting questions, while a restart expires them.'
    case 'failed':
      return `The running OpenClaw Gateway kept its previous Notifai plugin generation (${outcome.reason}). Answers wait for the installed generation; run \`openclaw plugins reload notifai --wait\` once its current work finishes.`
  }
}
