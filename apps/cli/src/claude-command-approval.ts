/**
 * Claude Code permission rules for the Notifai commands an away User depends on.
 *
 * Outside a mode that skips permission prompts, Claude Code asks before each
 * Bash command it has no rule for. A question, its wake, and its
 * acknowledgement are all Bash commands, so without these rules the first one
 * waits at a terminal nobody is watching and nothing reaches a device.
 *
 * The rules are the User's to grant: setup offers them and writes them only on
 * a yes. They cover sending, asking, reading and acknowledging. Setup,
 * configuration, guidance edits, logs and sign-out keep their prompt.
 *
 * The offer is made at a terminal outside Claude Code, and inside a Claude
 * Code session unless the session is known to run in another permission mode
 * (auto, acceptEdits, plan, bypassPermissions): bypass does not need the
 * rules, and Claude Code does not say how its auto mode judges a command that
 * grants itself permission rules. The mode is known from, in order, what the
 * session's own hooks last reported, the mode the session was started with,
 * and `permissions.defaultMode` in the Claude Code settings. First-time setup
 * runs before any hook has reported, so a mode none of these names is
 * Claude Code's default and the offer stands: an explicit yes is never
 * dropped for want of a report.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { withTargetFileLock } from './file-lock.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import { applyPlan, loadSettings, settingsFile, type SettingsDocument } from './install-hooks.js'
import type { ReadinessState } from './readiness.js'

export const CLAUDE_COMMAND_RULES: readonly string[] = [
  'Bash(notifai send *)',
  'Bash(notifai ask *)',
  'Bash(notifai receive)',
  'Bash(notifai receive *)',
  'Bash(notifai acknowledge *)',
  'Bash(notifai status *)',
  'Bash(notifai replies *)',
  'Bash(notifai close *)',
  'Bash(notifai guidance)',
  'Bash(notifai session rename *)',
]

function allowList(document: SettingsDocument): unknown[] | null {
  const permissions = document['permissions']
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) return null
  const allow = (permissions as Record<string, unknown>)['allow']
  return Array.isArray(allow) ? allow : null
}

/** The rules a settings document still lacks. */
export function missingClaudeCommandRules(document: SettingsDocument): string[] {
  const allow = allowList(document) ?? []
  return CLAUDE_COMMAND_RULES.filter((rule) => !allow.includes(rule))
}

/** Add the missing rules, keeping every existing rule and key as it was. */
export function addClaudeCommandRules(document: SettingsDocument): { document: SettingsDocument; changed: boolean } {
  const missing = missingClaudeCommandRules(document)
  if (missing.length === 0) return { document, changed: false }
  const permissions = document['permissions']
  if (permissions !== undefined && (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions))) {
    throw new Error('`permissions` in the Claude Code settings is not an object; fix it before adding rules.')
  }
  const existing = (permissions ?? {}) as Record<string, unknown>
  if (existing['allow'] !== undefined && !Array.isArray(existing['allow'])) {
    throw new Error('`permissions.allow` in the Claude Code settings is not a list; fix it before adding rules.')
  }
  return {
    document: { ...document, permissions: { ...existing, allow: [...((existing['allow'] as unknown[] | undefined) ?? []), ...missing] } },
    changed: true,
  }
}

/** Remove exactly these rules; an allow list or permissions object this empties goes with them. */
export function removeClaudeCommandRules(document: SettingsDocument): { document: SettingsDocument; changed: boolean } {
  const allow = allowList(document)
  if (allow === null || !allow.some((rule) => typeof rule === 'string' && CLAUDE_COMMAND_RULES.includes(rule))) {
    return { document, changed: false }
  }
  const kept = allow.filter((rule) => !(typeof rule === 'string' && CLAUDE_COMMAND_RULES.includes(rule)))
  const permissions = { ...(document['permissions'] as Record<string, unknown>) }
  if (kept.length > 0) permissions['allow'] = kept
  else delete permissions['allow']
  const next: SettingsDocument = { ...document }
  if (Object.keys(permissions).length > 0) next['permissions'] = permissions
  else delete next['permissions']
  return { document: next, changed: true }
}

/** The Claude Code settings file these rules live in: the User's machine-level one. */
export function claudeCommandRulesFile(env: NodeJS.ProcessEnv): string {
  return settingsFile('claude-code', env)
}

export function claudeCommandRulesInstalled(env: NodeJS.ProcessEnv): boolean {
  const file = claudeCommandRulesFile(env)
  if (!existsSync(file)) return false
  try {
    return missingClaudeCommandRules(loadSettings(file)).length === 0
  } catch {
    return false
  }
}

/** Write the rules into the User's Claude Code settings. Returns whether the file changed. */
export function installClaudeCommandRules(env: NodeJS.ProcessEnv): boolean {
  const file = claudeCommandRulesFile(env)
  return withTargetFileLock(file, () => {
    const result = addClaudeCommandRules(loadSettings(file))
    if (result.changed) applyPlan(file, result.document)
    return result.changed
  })
}

/** Claude Code's ordinary mode, where it asks before each command it has no rule for. */
export const CLAUDE_DEFAULT_PERMISSION_MODE = 'default'

function usableMode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z]{1,32}$/.test(value) ? value : undefined
}

/** Keep the permission mode a Claude Code hook reported for its own session. */
export function recordClaudePermissionMode(sessionId: string, env: NodeJS.ProcessEnv, reported: unknown): void {
  const mode = usableMode(reported)
  if (mode === undefined || readSessionState(sessionId, env).claude_permission_mode === mode) return
  updateSessionState(sessionId, env, (state) => ({ ...state, claude_permission_mode: mode }))
}

/** The permission mode this session's hooks last reported, or null when none has. */
export function readClaudePermissionMode(sessionId: string, env: NodeJS.ProcessEnv): string | null {
  try {
    return usableMode(readSessionState(sessionId, env).claude_permission_mode) ?? null
  } catch {
    return null
  }
}

/** The permission mode a Claude Code command line starts in, when it names one. */
export function claudeLaunchMode(argv: readonly string[] | null): string | null {
  if (argv === null) return null
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index]!
    if (word === '--dangerously-skip-permissions') return 'bypassPermissions'
    if (word === '--permission-mode') return usableMode(argv[index + 1]) ?? null
    if (word.startsWith('--permission-mode=')) return usableMode(word.slice('--permission-mode='.length)) ?? null
  }
  return null
}

/**
 * `permissions.defaultMode` from the Claude Code settings that apply in these
 * folders, most specific first: each folder's `.claude/settings.local.json`,
 * then its `.claude/settings.json`, then the User's own settings. An
 * unreadable file says nothing.
 */
export function claudeSettingsDefaultMode(env: NodeJS.ProcessEnv, folders: readonly string[]): string | null {
  const files = [
    ...[...new Set(folders)].flatMap((folder) => [
      path.join(folder, '.claude', 'settings.local.json'),
      path.join(folder, '.claude', 'settings.json'),
    ]),
    claudeCommandRulesFile(env),
  ]
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const permissions = loadSettings(file)['permissions']
      if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) continue
      const mode = usableMode((permissions as Record<string, unknown>)['defaultMode'])
      if (mode !== undefined) return mode
    } catch {
      // Not readable here: it neither grants nor withholds anything.
    }
  }
  return null
}

/** Where a session's permission mode was learned. */
export type ClaudePermissionModeSource = 'hook' | 'launch' | 'settings'

/** The best-evidenced permission mode of a Claude Code session, or null when nothing names one. */
export function claudeSessionPermissionMode(evidence: {
  reported: string | null
  launch: string | null
  settings: string | null
}): { mode: string; source: ClaudePermissionModeSource } | null {
  if (evidence.reported !== null) return { mode: evidence.reported, source: 'hook' }
  if (evidence.launch !== null) return { mode: evidence.launch, source: 'launch' }
  if (evidence.settings !== null) return { mode: evidence.settings, source: 'settings' }
  return null
}

export const CLAUDE_COMMANDS_STATE_ID = 'claude-commands'

/**
 * Where this invocation runs: `null` outside Claude Code (a person at a
 * terminal, or another harness), otherwise the Claude Code session's
 * permission mode as best known, itself `null` when nothing names one.
 */
export type ClaudeCommandContext = null | { permissionMode: string | null; source?: ClaudePermissionModeSource | null }

/**
 * Why an explicit yes to the rules wrote nothing, or null when they are in
 * place or the attempt to write them already reported its own failure.
 */
export function claudeCommandsNotWritten(state: ReadinessState | undefined, installed: boolean, attempted: boolean): string | null {
  if (installed || attempted) return null
  const technical = state?.technical as { permission_mode?: unknown; applicable?: unknown } | undefined
  if (state !== undefined && technical?.applicable === false && typeof technical.permission_mode === 'string') {
    return `Claude Code command approval was not added: this session runs in Claude Code's \`${technical.permission_mode}\` permission mode, and the approval is only for its default mode. To add it, run \`notifai init --claude-commands\` from a terminal or from a Claude Code session in its default mode.`
  }
  if (state === undefined) {
    return 'Claude Code command approval was not added: Notifai is not set up for Claude Code on this machine yet. Run `notifai init --hooks --claude-commands` to set up both.'
  }
  return 'Claude Code command approval was not added yet: setup stopped before it got there. Run `notifai init --claude-commands` again once the step above is done.'
}

/** What the rules mean for this invocation; pure so every branch is testable. */
export function claudeCommandReadiness(installed: boolean, context: ClaudeCommandContext): ReadinessState {
  const base = { id: CLAUDE_COMMANDS_STATE_ID, title: 'Claude Code command approval', harnesses: ['claude-code'] as const }
  const mode = context?.permissionMode ?? null
  if (installed) {
    return {
      ...base,
      status: 'ready',
      detail: 'Claude Code runs the Notifai send, ask, receive and acknowledge commands without asking first',
    }
  }
  const source = context?.source ?? null
  if (context !== null && mode !== null && mode !== CLAUDE_DEFAULT_PERMISSION_MODE) {
    return {
      ...base,
      status: 'ready',
      detail: `not applicable in this session's \`${mode}\` permission mode; it is offered only in Claude Code's default mode`,
      technical: { permission_mode: mode, permission_mode_source: source, applicable: false },
    }
  }
  return {
    ...base,
    status: 'optional-gap',
    detail: 'not granted, so in its default mode Claude Code asks at the terminal before each Notifai command and a question cannot leave while you are away',
    ...(context === null ? {} : { technical: { permission_mode: mode, permission_mode_source: source, applicable: true } }),
    remedy: {
      by: 'cli',
      summary: 'on the User\'s yes, let Claude Code run the Notifai commands an away User depends on without asking first',
      command: 'notifai init --claude-commands',
    },
  }
}
