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
 * The offer is made only at a terminal outside Claude Code or inside a Claude
 * Code session in its default permission mode, as the session's own hooks
 * last reported it. In any other mode (auto, acceptEdits, plan,
 * bypassPermissions), or before a mode is known, the state reads as not
 * applicable and carries no remedy, so nothing is offered or written: bypass
 * does not need the rules, and Claude Code does not say how its auto mode
 * judges a command that grants itself permission rules.
 */
import { existsSync } from 'node:fs'
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

export const CLAUDE_COMMANDS_STATE_ID = 'claude-commands'

/**
 * Where this invocation runs: `null` outside Claude Code (a person at a
 * terminal, or another harness), otherwise the Claude Code session's last
 * reported permission mode, itself `null` when none is known yet.
 */
export type ClaudeCommandContext = null | { permissionMode: string | null }

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
  if (context !== null && mode !== CLAUDE_DEFAULT_PERMISSION_MODE) {
    return {
      ...base,
      status: 'ready',
      detail: mode === null
        ? 'not applicable until this session reports its permission mode; it is offered only in Claude Code\'s default mode'
        : `not applicable in this session's \`${mode}\` permission mode; it is offered only in Claude Code's default mode`,
      technical: { permission_mode: mode, applicable: false },
    }
  }
  return {
    ...base,
    status: 'optional-gap',
    detail: 'not granted, so in its default mode Claude Code asks at the terminal before each Notifai command and a question cannot leave while you are away',
    ...(context === null ? {} : { technical: { permission_mode: mode, applicable: true } }),
    remedy: {
      by: 'cli',
      summary: 'on the User\'s yes, let Claude Code run the Notifai commands an away User depends on without asking first',
      command: 'notifai init --claude-commands',
    },
  }
}
