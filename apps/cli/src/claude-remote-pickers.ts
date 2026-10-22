/**
 * Claude Code Remote Control and question pickers.
 *
 * Remote Control forwards a picker to the User's remote client and, after its
 * dialog expiry (`dialogExpiry`, 5 minutes unless set; overridden by
 * `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS`), cancels it to its "safe no-action
 * default". Read from Claude Code 2.1.308's source, that is the same
 * cancellation as Esc, which signals the waiting `PermissionRequest` handler
 * with no `PostToolUse` after it, so the device question is withdrawn though
 * the User may simply be away. Reproducing it needs a signed-in remote client,
 * so nothing has shown a difference to tell the two apart by. Notifai never
 * changes Claude Code's settings, so `doctor` says what happens and which
 * setting keeps such a question open. Local pickers are unaffected.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { harnessAccountHome, loadSettings, settingsFile } from './install-hooks.js'

/** Claude Code's default remote dialog expiry. */
export const CLAUDE_DEFAULT_DIALOG_EXPIRY_MS = 300_000

const DIALOG_EXPIRY_MS: Readonly<Record<string, number | null>> = { '60s': 60_000, '5m': 300_000, '10m': 600_000, never: null }

/** How long a forwarded picker waits before Claude Code cancels it; `ms` null means never. */
export interface ClaudeDialogExpiry {
  ms: number | null
  source: 'env' | 'settings' | 'default'
}

function readSetting(file: string, key: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return loadSettings(file)[key]
  } catch {
    // Unreadable here: it says nothing either way.
    return undefined
  }
}

/**
 * The dialog expiry Claude Code applies, read as it reads it: the environment
 * variable, then the trusted settings (each folder's local settings, then the
 * User's own). Claude Code never takes this from a checked-in project file.
 */
export function claudeDialogExpiry(env: NodeJS.ProcessEnv, folders: readonly string[]): ClaudeDialogExpiry {
  const override = env['CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS']
  if (override !== undefined && override.trim() !== '' && Number.isFinite(Number(override))) {
    const ms = Number(override)
    return { ms: ms <= 0 ? null : ms, source: 'env' }
  }
  const files = [
    ...[...new Set(folders)].map((folder) => path.join(folder, '.claude', 'settings.local.json')),
    settingsFile('claude-code', env),
  ]
  for (const file of files) {
    const value = readSetting(file, 'dialogExpiry')
    if (typeof value === 'string' && value in DIALOG_EXPIRY_MS) return { ms: DIALOG_EXPIRY_MS[value]!, source: 'settings' }
  }
  return { ms: CLAUDE_DEFAULT_DIALOG_EXPIRY_MS, source: 'default' }
}

/**
 * Whether the User set Remote Control to start in every session: their own
 * settings, else the older copy in Claude Code's global config. A session
 * started with `/remote-control` is not visible here.
 */
export function claudeRemoteControlAtStartup(env: NodeJS.ProcessEnv): boolean {
  const fromSettings = readSetting(settingsFile('claude-code', env), 'remoteControlAtStartup')
  if (typeof fromSettings === 'boolean') return fromSettings
  const configDir = env['CLAUDE_CONFIG_DIR']
  const globalConfig = configDir !== undefined && configDir !== ''
    ? path.join(configDir, '.claude.json')
    : path.join(harnessAccountHome(env), '.claude.json')
  return readSetting(globalConfig, 'remoteControlAtStartup') === true
}

function duration(ms: number): string {
  if (ms % 60_000 === 0) return ms === 60_000 ? '1 minute' : `${ms / 60_000} minutes`
  const seconds = Math.round(ms / 1000)
  return seconds === 1 ? '1 second' : `${seconds} seconds`
}

/**
 * What `doctor` reports. Not a fault: it is only worth the User's attention
 * when Remote Control starts in every session and its pickers can expire.
 */
export function claudeRemotePickerCheck(input: { expiry: ClaudeDialogExpiry; remoteControlAtStartup: boolean }): {
  ok: boolean
  detail: string
  technical: { dialog_expiry_ms: number | null; dialog_expiry_source: ClaudeDialogExpiry['source']; remote_control_at_startup: boolean }
} {
  const technical = {
    dialog_expiry_ms: input.expiry.ms,
    dialog_expiry_source: input.expiry.source,
    remote_control_at_startup: input.remoteControlAtStartup,
  }
  if (input.expiry.ms === null) {
    return { ok: true, technical, detail: 'a picker Claude Code forwards to Remote Control never expires, so its question stays open on your devices' }
  }
  const after = duration(input.expiry.ms)
  const effect = `a picker Claude Code forwards to Remote Control closes after ${after} unanswered, the same way as Esc, ` +
    'so Notifai withdraws its question from your devices'
  const keep = 'set Dialog expiry to never in Claude Code\'s /config to keep that question open'
  return input.remoteControlAtStartup
    ? { ok: false, technical, detail: `Remote Control starts in every session: ${effect}; ${keep}` }
    : { ok: true, technical, detail: `only in a session shared with Remote Control: ${effect}; ${keep}` }
}
