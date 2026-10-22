/**
 * Whether the installed OpenCode loads Notifai's OpenCode plugin.
 *
 * The generated plugin (`opencode-plugin.ts`) is an OpenCode 1 plugin: a
 * module whose exported function returns hooks by name. OpenCode 2 replaced
 * that plugin API. Its loader accepts only a default export with an `id` and
 * a `setup` (or `effect`) function, and logs any other module as
 * "failed to load plugin" without running it (anomalyco/opencode v2.1.3,
 * `packages/core/src/plugin/module.ts`; the upstream guide
 * `services/www/src/docs/content/build/plugins/migrate-v1.mdx` says "V1 plugin
 * implementations do not run in V2"). On OpenCode 2, then, none of Notifai's
 * OpenCode wiring runs: no guidance, no turn-end notification, no question
 * link. This reports that instead of letting it fail silently.
 */
import { spawnSync } from 'node:child_process'

/** The newest OpenCode major whose loader runs the generated plugin. */
export const OPENCODE_PLUGIN_LAST_MAJOR = 1

/** `opencode --version` answers in well under a second on both major lines. */
const PROBE_TIMEOUT_MS = 3_000

const probed = new Map<string, string | null>()

/**
 * The installed OpenCode's version, from a non-interactive `opencode --version`
 * found on PATH. OpenCode 1 prints the bare version (`1.19.4`); OpenCode 2
 * prints its CLI banner (`opencode v2.1.3`). Read once per process and PATH.
 * Null when it is missing, slow or unparseable.
 */
export function probeOpencodeVersion(
  env: NodeJS.ProcessEnv,
  run: (env: NodeJS.ProcessEnv) => string | null = runOpencodeVersion,
): string | null {
  const key = env['PATH'] ?? ''
  if (run === runOpencodeVersion && probed.has(key)) return probed.get(key)!
  const output = run(env)
  const version = output?.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1] ?? null
  if (run === runOpencodeVersion) probed.set(key, version)
  return version
}

function runOpencodeVersion(env: NodeJS.ProcessEnv): string | null {
  try {
    const result = spawnSync('opencode', ['--version'], {
      env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    })
    return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : null
  } catch {
    return null
  }
}

/** The version for this machine: a test's, or the probed one. */
export function opencodeVersionFor(deps: { env: NodeJS.ProcessEnv; opencodeVersion?: () => string | null }): string | null {
  return deps.opencodeVersion !== undefined ? deps.opencodeVersion() : probeOpencodeVersion(deps.env)
}

/** False only for a known OpenCode 2 or later; an unread version is no evidence of one. */
export function opencodeLoadsPlugin(version: string | null): boolean {
  const major = version === null ? null : Number(version.split('.')[0])
  return major === null || !Number.isInteger(major) || major <= OPENCODE_PLUGIN_LAST_MAJOR
}

/** What stops working, in plain words; null when the plugin loads. */
export function opencodePluginLoadWarning(version: string | null): string | null {
  if (opencodeLoadsPlugin(version)) return null
  return `OpenCode ${version} will not load Notifai's OpenCode plugin, which is written for OpenCode 1's plugin API: ` +
    'in its sessions Notifai adds no guidance, sends no turn-end notification and does not link question forms.'
}

/** The way back until Notifai has an OpenCode 2 plugin. */
export const OPENCODE_PLUGIN_LOAD_REMEDY =
  'use OpenCode 1 (the `opencode-ai` package) for sessions that should reach your devices; Notifai does not support OpenCode 2 yet'
