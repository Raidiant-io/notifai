/**
 * Codex's own answer to "which hooks are installed, and which are trusted":
 * the app-server's `hooks/list`. It reports every hook Codex would load for a
 * directory, document and plugin hooks alike, with Codex's current hash and
 * trust status. Notifai's reading of `config.toml` (`codexTrustFindings`)
 * mirrors a persisted format that is not a public contract, so it is only the
 * fallback for when no `codex` can be asked.
 *
 * It describes the configuration on disk, never what a running thread loaded:
 * `session-handlers.ts` answers that from the session's SessionStart record.
 * Asking costs one short-lived app-server: explicit commands (doctor,
 * `update --resume`) and the hub's bounded check of affected homes ask;
 * hooks never do.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { codexStdioRequest } from './codex-native-control.js'
import {
  codexTrustFindings,
  type CodexTrustFinding,
  type Installation,
} from './install-hooks.js'

/** The fields of Codex's `HookMetadata` (app-server protocol v2) Notifai reads. */
export interface CodexHookMetadata {
  key: string
  eventName: string
  command?: string | null
  matcher?: string | null
  sourcePath: string
  pluginId?: string | null
  enabled: boolean
  isManaged?: boolean
  currentHash: string
  trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified' | string
}

/** Null when Codex could not be asked; the caller then reads `config.toml`. */
export type ListCodexHooks = (env: NodeJS.ProcessEnv, cwd: string) => Promise<CodexHookMetadata[] | null>

export const listCodexHooks: ListCodexHooks = async (env, cwd) =>
  parseHooksList(await codexStdioRequest(env, cwd, 'hooks/list', { cwds: [cwd] }))

function parseHooksList(result: unknown): CodexHookMetadata[] | null {
  const data = (result as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  const hooks = data.flatMap((entry) => Array.isArray((entry as { hooks?: unknown })?.hooks) ? (entry as { hooks: unknown[] }).hooks : [])
  const valid = hooks.filter((hook): hook is CodexHookMetadata => {
    const h = hook as Partial<CodexHookMetadata> | null
    return h !== null && typeof h === 'object' && typeof h.key === 'string' && typeof h.sourcePath === 'string' &&
      typeof h.currentHash === 'string' && typeof h.trustStatus === 'string' && typeof h.enabled === 'boolean'
  })
  return valid.length === hooks.length ? valid : null
}

function canonical(file: string): string {
  try {
    return path.join(realpathSync(path.dirname(file)), path.basename(file))
  } catch {
    return file
  }
}

/** Notifai's plugin, should it ever ship as one: `notifai` from any marketplace. */
function isNotifaiPlugin(pluginId: string | null | undefined): boolean {
  return typeof pluginId === 'string' && pluginId.split('@')[0]?.trim().toLowerCase() === 'notifai'
}

const camel = (event: string) => event.charAt(0).toLowerCase() + event.slice(1)

/**
 * Trust findings for Notifai's handlers, from Codex's own `hooks/list` when
 * it answered, else from `config.toml`. Each document handler is matched by
 * source file, event and position, the way Codex keys it; a Notifai plugin's
 * hooks count by their own rows, so a plugin whose bundle changed since the
 * User approved it shows as changed.
 */
export function codexTrustFindingsFrom(
  installations: Installation[],
  env: NodeJS.ProcessEnv,
  listed: CodexHookMetadata[] | null,
): CodexTrustFinding[] {
  if (listed === null) return codexTrustFindings(installations, env)
  const findings: CodexTrustFinding[] = []
  for (const installation of installations.filter((entry) => entry.harness === 'codex')) {
    const source = canonical(installation.file)
    for (const handler of installation.handlers) {
      const suffix = `:${handler.event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}:${handler.groupIndex}:${handler.handlerIndex}`
      const row = listed.find((hook) => !hook.pluginId && canonical(hook.sourcePath) === source &&
        hook.key.endsWith(suffix) && hook.eventName === camel(handler.event))
      // Not listed (an event this Codex does not know): the persisted reading decides.
      if (row === undefined) { findings.push(...codexTrustFindings([{ ...installation, handlers: [handler] }], env)); continue }
      const state = trustState(row)
      if (state !== null) findings.push({ file: installation.file, event: handler.event, state })
    }
  }
  for (const row of listed.filter((hook) => isNotifaiPlugin(hook.pluginId))) {
    const state = trustState(row)
    if (state !== null) findings.push({ file: row.sourcePath, event: row.eventName.charAt(0).toUpperCase() + row.eventName.slice(1), state })
  }
  return findings
}

/** Codex's verdict stands: its hash, not Notifai's mirror of it, decides. */
function trustState(row: CodexHookMetadata): CodexTrustFinding['state'] | null {
  if (!row.enabled) return 'disabled'
  if (row.trustStatus === 'managed' || row.isManaged === true || row.trustStatus === 'trusted') return null
  return row.trustStatus === 'modified' ? 'changed' : 'new'
}

/**
 * One `hooks/list` per Codex home the given installations live in, then a
 * synchronous lookup for callers that decide under a lock. Never throws.
 */
export async function codexTrustReader(
  scopes: ReadonlyArray<{ env: NodeJS.ProcessEnv; installations: Installation[] }>,
  cwd: string,
  list: ListCodexHooks = listCodexHooks,
): Promise<(installations: Installation[], env: NodeJS.ProcessEnv) => CodexTrustFinding[]> {
  const answers = new Map<string, CodexHookMetadata[] | null>()
  for (const scope of scopes) {
    if (!scope.installations.some((installation) => installation.harness === 'codex')) continue
    const home = scope.env['CODEX_HOME'] ?? ''
    if (answers.has(home)) continue
    try { answers.set(home, await list(scope.env, cwd)) } catch { answers.set(home, null) }
  }
  return (installations, env) => codexTrustFindingsFrom(installations, env, answers.get(env['CODEX_HOME'] ?? '') ?? null)
}
