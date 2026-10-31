import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import { accountHome } from './platform.js'
import { HOOK_INSTALLABLE_HARNESSES, type HookInstallableHarness } from './harnesses.js'

const COMMANDS: Record<HookInstallableHarness, readonly string[]> = {
  'claude-code': ['claude'], codex: ['codex'], cursor: ['cursor', 'cursor-agent'],
  opencode: ['opencode'], openclaw: ['openclaw'], hermes: ['hermes'], grok: ['grok'],
}

/** Presence is a runnable file, never a configuration directory or session marker.
 * No harness is launched. See docs/AGENT-APPS.md for the bounded search contract. */
export function agentAppCandidates(harness: HookInstallableHarness, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix
  const home = accountHome(env, platform)
  const value = (key: string) => env[key]?.trim() || undefined
  const dirs = (value('PATH') ?? '').split(platform === 'win32' ? ';' : ':').filter(dir => p.isAbsolute(dir))
  dirs.push(...['.local/bin', '.bun/bin', '.npm-global/bin', '.local/share/pnpm', 'bin'].map(dir => p.join(home, dir)))
  for (const key of ['PNPM_HOME', 'VOLTA_HOME', 'BUN_INSTALL', 'NPM_CONFIG_PREFIX', 'npm_config_prefix']) {
    const root = value(key)
    if (root && p.isAbsolute(root)) dirs.push(key === 'PNPM_HOME' || (platform === 'win32' && key.toLowerCase() === 'npm_config_prefix') ? root : p.join(root, 'bin'))
  }
  if (platform === 'win32') {
    for (const key of ['APPDATA', 'LOCALAPPDATA']) {
      const root = value(key)
      if (root) dirs.push(p.join(root, key === 'APPDATA' ? 'npm' : 'pnpm'))
    }
  } else dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin')
  const names = COMMANDS[harness].flatMap(name => platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name])
  const candidates = dirs.flatMap(dir => names.map(name => p.join(dir, name)))
  const config = (key: string, fallback: string) => value(key) ?? p.join(home, fallback)
  if (harness === 'claude-code') candidates.push(p.join(config('CLAUDE_CONFIG_DIR', '.claude'), 'local', 'node_modules', '.bin', platform === 'win32' ? 'claude.cmd' : 'claude'))
  if (harness === 'opencode') candidates.push(p.join(home, '.opencode', 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode'))
  if (harness === 'hermes') candidates.push(p.join(config('HERMES_HOME', '.hermes'), 'hermes-agent', 'venv', platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'hermes.exe' : 'hermes'))
  if (platform === 'darwin') {
    const bundle = harness === 'claude-code' ? 'Claude.app/Contents/MacOS/Claude'
      : harness === 'cursor' ? 'Cursor.app/Contents/MacOS/Cursor'
      : harness === 'codex' ? 'Codex.app/Contents/Resources/codex' : null
    if (bundle) for (const root of ['/Applications', p.join(home, 'Applications')]) candidates.push(p.join(root, bundle))
    if (harness === 'codex') for (const root of ['/Applications', p.join(home, 'Applications')]) {
      candidates.push(p.join(root, 'ChatGPT.app/Contents/Resources/codex-cli/bin/codex'))
    }
  }
  if (platform === 'win32' && harness === 'codex' && value('LOCALAPPDATA')) {
    candidates.push(p.join(value('LOCALAPPDATA')!, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'))
  }
  if (platform === 'win32' && harness === 'cursor') {
    const local = value('LOCALAPPDATA')
    if (local) candidates.push(p.join(local, 'Programs', 'cursor', 'Cursor.exe'))
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
      const root = value(key)
      if (root) candidates.push(p.join(root, 'Cursor', 'Cursor.exe'))
    }
  }
  return [...new Set(candidates.filter(candidate => p.isAbsolute(candidate)))]
}

export function runnableAgentFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false // follows symlinks, rejects dangling links
    accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch { return false }
}

export function detectAgentApps(env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  runnable: (file: string) => boolean = file => runnableAgentFile(file, platform)): HookInstallableHarness[] {
  return HOOK_INSTALLABLE_HARNESSES.filter(harness => agentAppCandidates(harness, env, platform).some(runnable))
}
