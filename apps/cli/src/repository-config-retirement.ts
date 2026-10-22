/**
 * Notifai no longer reads `.notifai/config.toml` or `.notifai/guidance/` from a
 * repository. A skill or script written before that still passes `--project`,
 * and a repository may still hold those files, so both are answered instead of
 * silently ignored.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { globalConfigDir, personalProjectIdentity, projectLocation } from './config.js'

export const PROJECT_LAYER_REMOVED =
  'Repository-committed guidance and config were removed; use `--local` for this project.'

export const REPOSITORY_CONFIG_NOTICE = [
  'notifai: this repository has .notifai/ settings, which Notifai no longer reads.',
  'To keep a setting for this project, run `notifai config set <key> <value> --local` ' +
    '(guidance: `notifai guidance set <topic> --local`).',
]

function holdsRepositoryConfig(dir: string): boolean {
  const base = path.join(dir, '.notifai')
  try {
    if (lstatSync(path.join(base, 'config.toml')).isFile()) return true
  } catch {
    // No shared config file here.
  }
  try {
    return readdirSync(path.join(base, 'guidance'), { withFileTypes: true }).some(entry => entry.isFile())
  } catch {
    return false
  }
}

/** From the folder up to its checkout root, where the old lookup searched. */
function repositoryHoldsConfig(cwd: string, root: string): boolean {
  let dir: string
  try { dir = realpathSync(cwd) } catch { dir = path.resolve(cwd) }
  for (;;) {
    if (holdsRepositoryConfig(dir)) return true
    const relative = path.relative(root, dir)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false
    dir = path.dirname(dir)
  }
}

/**
 * The notice the first time a command runs in a repository holding those
 * files, recorded so that repository (all of its worktrees) never sees it
 * again. A notice that cannot be recorded is not shown, so it cannot repeat.
 */
export function takeRepositoryConfigNotice(cwd: string, env: NodeJS.ProcessEnv): readonly string[] | null {
  const location = projectLocation(cwd, env)
  if (location === null || !location.checkout || !repositoryHoldsConfig(cwd, location.root)) return null
  const marker = path.join(globalConfigDir(env), 'repository-config-notices', `${personalProjectIdentity(cwd, env)}.json`)
  if (existsSync(marker)) return null
  try {
    atomicWriteFileSync(marker, `${JSON.stringify({ version: 1, shown_at: new Date().toISOString() })}\n`, {
      requireCurrentUserOwner: true,
    })
  } catch {
    return null
  }
  return REPOSITORY_CONFIG_NOTICE
}
