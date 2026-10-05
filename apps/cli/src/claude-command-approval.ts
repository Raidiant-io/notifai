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
 */
import { existsSync } from 'node:fs'
import { withTargetFileLock } from './file-lock.js'
import { applyPlan, loadSettings, settingsFile, type SettingsDocument } from './install-hooks.js'

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
