/**
 * Which OpenCode is installed, and which of Notifai's two OpenCode plugins it
 * loads.
 *
 * OpenCode 2 replaced OpenCode 1's plugin API. Its loader accepts only a
 * default export with an `id` and a `setup` (or `effect`) function, and logs
 * any other module as "failed to load plugin" without running it
 * (anomalyco/opencode v2.1.3, `packages/core/src/plugin/module.ts`). OpenCode 1
 * runs the exported functions of the module instead. Both lines use the
 * `opencode` command and the same plugin directory, so Notifai writes the one
 * plugin the installed major loads: `opencode-plugin.ts` for OpenCode 1 and
 * `opencode2-plugin.ts` for OpenCode 2. A plugin left over from the other
 * major is an installation fault that reinstalling repairs.
 *
 * The OpenCode 2 plugin is proven against 2.1. Version 2.1 changed the plugin
 * API's session fields (upstream PR #57260), so 2.0.x is unsupported.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { opencodePluginSource, type OpencodePluginLine, type OpencodePluginOptions } from './opencode-plugin.js'
import { opencode2PluginSource } from './opencode2-plugin.js'

/** The oldest OpenCode 2 release the OpenCode 2 plugin is proven against. */
export const OPENCODE_2_FLOOR = '2.1'

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
  const key = JSON.stringify([env['PATH'], env['Path'], env['PATHEXT'], env['ComSpec']])
  if (run === runOpencodeVersion && probed.has(key)) return probed.get(key)!
  const output = run(env)
  const version = output?.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1] ?? null
  if (run === runOpencodeVersion) probed.set(key, version)
  return version
}

function runOpencodeVersion(env: NodeJS.ProcessEnv): string | null {
  try {
    let command = 'opencode'
    let args = ['--version']
    if (process.platform === 'win32') {
      const value = (key: string) => env[key] ?? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1]
      const extensions = (value('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      const candidates = (value('PATH') ?? '').split(';').filter(Boolean).flatMap(directory =>
        extensions.map(extension => path.win32.resolve(directory.replace(/^"|"$/g, ''), `opencode${extension}`)))
      const executable = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile())
      if (executable === undefined) return null
      command = executable
      if (/\.(cmd|bat)$/i.test(command)) {
        // npm's native Windows shim needs cmd.exe. The only argument is
        // fixed; quote the resolved path and refuse expansion characters.
        if (/["%\r\n]/.test(command)) return null
        args = ['/d', '/s', '/c', `""${command}" --version"`]
        command = value('COMSPEC') ?? 'cmd.exe'
      }
    }
    const result = spawnSync(command, args, {
      env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      ...(process.platform === 'win32' && args[0] === '/d' ? { windowsVerbatimArguments: true } : {}),
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

function parsed(version: string): { major: number; minor: number } | null {
  const [major, minor] = version.split('.').map(Number)
  return Number.isInteger(major) && Number.isInteger(minor) ? { major: major!, minor: minor! } : null
}

/**
 * The plugin this OpenCode loads. An unread version is no evidence of
 * OpenCode 2: it keeps the plugin already installed, else OpenCode 1's.
 */
export function opencodePluginLine(version: string | null, installed?: OpencodePluginLine): OpencodePluginLine {
  const known = version === null ? null : parsed(version)
  if (known === null) return installed ?? 1
  return known.major >= 2 ? 2 : 1
}

/** Whether Notifai supports this OpenCode, and if not, the problem and what the User can do. */
export function opencodeSupport(version: string | null):
  { supported: true; problem: null; remedy: null } | { supported: false; problem: string; remedy: string } {
  const known = version === null ? null : parsed(version)
  if (known === null) {
    return {
      supported: false,
      problem: 'The OpenCode version could not be read; Notifai cannot verify that OpenCode loads the installed plugin.',
      remedy: 'make the intended opencode executable available on PATH, then run notifai doctor again',
    }
  }
  if (known.major <= 1 || (known.major === 2 && known.minor >= 1)) {
    return { supported: true, problem: null, remedy: null }
  }
  if (known.major === 2) {
    return {
      supported: false,
      problem: `OpenCode ${version} predates the OpenCode 2 plugin API Notifai supports, which starts at OpenCode ${OPENCODE_2_FLOOR}: ` +
        'its sessions may get no Notifai guidance, turn-end notification or question-form link.',
      remedy: `upgrade OpenCode to ${OPENCODE_2_FLOOR} or later, then restart it`,
    }
  }
  return {
    supported: false,
    problem: `OpenCode ${version} is newer than the OpenCode 2 plugin API Notifai supports: ` +
      'its sessions may get no Notifai guidance, turn-end notification or question-form link.',
    remedy: `use OpenCode 2 (${OPENCODE_2_FLOOR} or later) or OpenCode 1 for sessions that should reach your devices`,
  }
}

/** The installed plugin against the installed OpenCode, in plain words; null when they match or the version is unread. */
export function opencodePluginLineFault(version: string | null, installed: OpencodePluginLine): string | null {
  if (version === null || parsed(version) === null) return null
  const expected = opencodePluginLine(version)
  if (expected === installed) return null
  return `OpenCode ${version} loads only OpenCode ${expected} plugins, but the installed Notifai plugin is for OpenCode ${installed}; ` +
    'rerun `notifai hooks install --harness opencode`'
}

/** The generated plugin for one OpenCode major. */
export function opencodePluginSourceFor(line: OpencodePluginLine, options: OpencodePluginOptions): string {
  return line === 2 ? opencode2PluginSource(options) : opencodePluginSource(options)
}
