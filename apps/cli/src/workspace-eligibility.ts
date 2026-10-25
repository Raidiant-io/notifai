import path from 'node:path'
import type { CommandDeps } from './commands-core.js'
import { resolveActiveHarness } from './commands-harness-context.js'
import { codexGlobalDir } from './install-hooks.js'
import { canonicalPath } from './local-path.js'

/** Workspace eligibility is separate from User-owned Project Enablement. */
export function workspaceExclusion(cwd: string, env: NodeJS.ProcessEnv): {
  code: string
  message: string
} | null {
  const directory = canonicalPath(cwd)
  const home = codexGlobalDir(env)
  for (const name of ['memories', 'memories_v2']) {
    const relative = path.relative(canonicalPath(path.join(home, name)), directory)
    if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
      return {
        code: 'codex_memory_workspace',
        message: "This is Codex's internal memory folder; Notifai doesn't send from here.",
      }
    }
  }
  return null
}

/** Refuse before configuration, registration or submission, including Projectless sends. */
export function rejectExcludedWorkspace(deps: CommandDeps, json = false): boolean {
  const exclusion = workspaceExclusion(deps.cwd, deps.env)
  if (exclusion === null) return false
  const { active, contested } = resolveActiveHarness(deps.env, deps.cwd, (deps.now ?? Date.now)())
  // Other harnesses keep their existing behavior. With ambiguous ownership,
  // leave the existing command's ambiguity handling in charge as well.
  if (contested.length > 1 || (active !== null && active.harness !== 'codex')) return false
  if (json) deps.io.out(JSON.stringify({ ok: false, ...exclusion }))
  else deps.io.err(`${exclusion.code}: ${exclusion.message}`)
  return true
}
