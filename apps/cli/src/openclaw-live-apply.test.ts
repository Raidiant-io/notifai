import { expect, it } from 'vitest'
import { applyOpenclawPluginLive, openclawLiveApplyText, type OpenclawRunner } from './openclaw-live-apply.js'

const runner = (status: number | null, stdout: string, stderr = '', error?: NodeJS.ErrnoException): OpenclawRunner =>
  () => ({ status, stdout, stderr, ...(error === undefined ? {} : { error }) })

// Shapes recorded from OpenClaw 2026.10.5 `openclaw plugins reload <id> --json`.
const APPLIED = `{
  "ok": true,
  "restartRequired": false,
  "runtime": { "operationId": "op", "generation": 3, "pluginIds": ["notifai"] },
  "pluginIds": ["notifai"]
}
`
const NOT_RUNNING = `{
  "ok": false,
  "error": { "type": "cli_error", "message": "The Gateway is not running. Start it before reloading a plugin." }
}
`

it('reports the generation the running Gateway applied', () => {
  let call: { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined
  const env = { OPENCLAW_STATE_DIR: '/state' }
  const outcome = applyOpenclawPluginLive(env, (command, args, options) => {
    call = { command, args, env: options.env }
    return { status: 0, stdout: APPLIED, stderr: '' }
  })
  expect(outcome).toEqual({ status: 'applied', generation: 3, restartRequired: false })
  expect(call).toEqual({ command: 'openclaw', args: ['plugins', 'reload', 'notifai', '--json'], env })
  expect(openclawLiveApplyText(outcome)).toContain('generation 3')
})

it('says the plugin is saved for the next start when no Gateway runs or OpenClaw is absent', () => {
  const stopped = applyOpenclawPluginLive({}, runner(1, NOT_RUNNING, '[openclaw] The CLI command failed.\n'))
  expect(stopped).toEqual({ status: 'saved', reason: 'no-running-gateway' })
  expect(openclawLiveApplyText(stopped)).toContain('loads when the Gateway next starts')
  const missing = Object.assign(new Error('spawn openclaw ENOENT'), { code: 'ENOENT' })
  const absent = applyOpenclawPluginLive({}, runner(null, '', '', missing))
  expect(absent).toEqual({ status: 'saved', reason: 'openclaw-cli-unavailable' })
  expect(openclawLiveApplyText(absent)).toContain('openclaw plugins reload notifai')
})

it('keeps a refused replacement visible: the previous generation still serves', () => {
  const refused = applyOpenclawPluginLive({}, runner(1, JSON.stringify({ ok: false,
    error: { message: 'Plugin reload timed out waiting for in-flight work' } })))
  expect(refused).toEqual({ status: 'failed', reason: 'Plugin reload timed out waiting for in-flight work' })
  expect(openclawLiveApplyText(refused)).toContain('kept its previous Notifai plugin generation')
  const late = Object.assign(new Error('spawnSync openclaw ETIMEDOUT'), { code: 'ETIMEDOUT' })
  expect(applyOpenclawPluginLive({}, runner(null, '', '', late)).status).toBe('failed')
  expect(applyOpenclawPluginLive({}, runner(0, '{"ok":true}')).status).toBe('failed')
})

it('names a required restart when the Gateway applied metadata over loaded code', () => {
  const outcome = applyOpenclawPluginLive({}, runner(0, APPLIED.replace('"restartRequired": false', '"restartRequired": true')))
  expect(outcome).toEqual({ status: 'applied', generation: 3, restartRequired: true })
  expect(openclawLiveApplyText(outcome)).toContain('restart the Gateway')
})
