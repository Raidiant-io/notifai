import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hookAdapterPath } from './hook-adapter.js'
import { accountHome } from './platform.js'

export const HERMES_PLUGIN_ID = 'notifai'
export const HERMES_PLUGIN_MARKER = '# notifai managed hermes plugin v1'

export function hermesPluginDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HERMES_HOME']?.trim() || path.join(accountHome(env, process.platform), '.hermes')
  return path.join(home, 'plugins', HERMES_PLUGIN_ID)
}

export function hermesPluginSource(adapterPath: string, nodePath?: string): string {
  const command = nodePath === undefined ? [adapterPath] : [nodePath, adapterPath]
  return `${HERMES_PLUGIN_MARKER}
"""Notifai activation for a proven local Hermes CLI Agent Session."""
import json
import os
import subprocess

COMMAND = ${JSON.stringify(command)}

def _activation(info):
    platform = str(info.get("platform") or "")
    if platform not in ("cli", "subagent"):
        return ""
    if os.environ.get("HERMES_SESSION_SOURCE", "").lower() not in ("", "cli"):
        return ""
    if os.environ.get("_HERMES_GATEWAY") == "1" or os.environ.get("HERMES_TUI_ACTIVE_SESSION_FILE"):
        return ""
    if os.environ.get("TERMINAL_ENV", "").lower() not in ("", "local"):
        return ""
    if os.environ.get("HERMES_SESSION_KEY") or os.environ.get("HERMES_SESSION_PLATFORM"):
        return ""
    session_id = str(info.get("session_id") or "").strip()
    if not session_id:
        return ""
    cwd = str(info.get("cwd") or "").strip()
    if not cwd:
        # A set but invalid TERMINAL_CWD cannot fall back to the launch dir.
        if os.environ.get("TERMINAL_CWD", "").strip():
            return ""
        try:
            cwd = os.getcwd()
        except OSError:
            return ""
    if not os.path.isdir(cwd):
        return ""
    worker = platform == "subagent"
    event = "subagent-start" if worker else "session-start"
    envelope = {"session_id": session_id, "cwd": cwd,
                "hook_event_name": "SubagentStart" if worker else "SessionStart"}
    try:
        result = subprocess.run(COMMAND + ["hook", event, "--owner", "notifai", "--harness", "hermes"],
                                input=json.dumps(envelope), text=True, capture_output=True,
                                timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""

def register(ctx):
    ctx.register_system_prompt_section("notifai.activation", _activation,
                                       position="after_memory", max_chars=4000)
`
}

export function isOurHermesPlugin(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory() ||
      !lstatSync(path.join(dir, '__init__.py')).isFile() ||
      !lstatSync(path.join(dir, 'plugin.yaml')).isFile()) return false
    return readFileSync(path.join(dir, '__init__.py'), 'utf8').startsWith(HERMES_PLUGIN_MARKER) &&
      /^name: notifai$/m.test(readFileSync(path.join(dir, 'plugin.yaml'), 'utf8'))
  } catch {
    return false
  }
}

function hermesCommand(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('hermes', ['plugins', ...args], {
    env, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Hermes plugin command failed: ${result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? 'unknown error'}`)
  }
  return result.stdout
}

export function hermesVersionSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  const result = spawnSync('hermes', ['--version'], {
    env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  })
  return result.status === 0 && /^Hermes Agent v0\.21\.5\b/m.test(result.stdout)
}

export function hermesPluginListed(env: NodeJS.ProcessEnv = process.env): boolean {
  return hermesCommand(['list', '--plain', '--no-bundled'], env)
    .split(/\r?\n/)
    .some(line => /^enabled\s+\S+\s+\S+\s+notifai\s*$/.test(line))
}

export function preflightHermesPlugin(env: NodeJS.ProcessEnv = process.env): void {
  const installed = hermesPluginDir(env)
  if (existsSync(installed) && !isOurHermesPlugin(installed)) {
    throw new Error('Hermes already has a foreign plugin named notifai; leave it unchanged')
  }
  if (!hermesVersionSupported(env)) {
    throw new Error('Hermes v0.21.5 is required for the proven Notifai plugin integration')
  }
  if (!existsSync(installed) && hermesCommand(['list', '--plain'], env)
    .split(/\r?\n/)
    .some(line => /^(?:enabled|disabled|not enabled)\s+\S+\s+\S+\s+notifai\s*$/.test(line))) {
    throw new Error('Hermes already discovers a foreign plugin named notifai; leave it unchanged')
  }
}

export function installHermesPlugin(adapterPath: string, env: NodeJS.ProcessEnv = process.env, nodePath?: string): string {
  const installed = hermesPluginDir(env)
  preflightHermesPlugin(env)
  const source = hermesPluginSource(adapterPath, nodePath)
  if (existsSync(installed) && readFileSync(path.join(installed, '__init__.py'), 'utf8') === source) {
    hermesCommand(['enable', HERMES_PLUGIN_ID], env)
  } else {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-plugin-'))
    try {
      writeFileSync(path.join(temp, 'plugin.yaml'), 'name: notifai\nversion: "1.0.0"\ndescription: "Notifai Project Enablement and agent guidance"\n')
      writeFileSync(path.join(temp, '__init__.py'), source)
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: temp, env, encoding: 'utf8', timeout: 10_000 })
        if (result.error || result.status !== 0) throw new Error(`Could not prepare Hermes plugin: ${result.error?.message ?? result.stderr?.trim() ?? 'git failed'}`)
      }
      git(['init', '-q'])
      git(['add', 'plugin.yaml', '__init__.py'])
      git(['-c', 'user.name=Notifai', '-c', 'user.email=notifai@example.invalid', 'commit', '-qm', 'plugin'])
      hermesCommand(['install', pathToFileURL(temp).href, '--enable', '--no-deps', ...(existsSync(installed) ? ['--force'] : [])], env)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
  if (!isOurHermesPlugin(installed) || !hermesPluginListed(env)) {
    throw new Error('Hermes did not report an enabled Notifai plugin after installation')
  }
  return installed
}

export function uninstallHermesPlugin(env: NodeJS.ProcessEnv = process.env): boolean {
  const installed = hermesPluginDir(env)
  if (!existsSync(installed)) return false
  if (!isOurHermesPlugin(installed)) throw new Error('Hermes plugin named notifai is foreign; leave it unchanged')
  hermesCommand(['remove', HERMES_PLUGIN_ID], env)
  if (existsSync(installed)) throw new Error('Hermes still has the Notifai plugin after removal')
  return true
}

export function hermesPluginCurrent(adapterHome: string | undefined, env: NodeJS.ProcessEnv): boolean {
  const dir = hermesPluginDir(env)
  return isOurHermesPlugin(dir) && readFileSync(path.join(dir, '__init__.py'), 'utf8') ===
    hermesPluginSource(hookAdapterPath(adapterHome), process.platform === 'win32' ? process.execPath : undefined)
}
