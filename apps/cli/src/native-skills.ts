import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { accountHome, npxLaunch } from './platform.js'
import { packageVersion } from './release.js'
import { stageShippedSkillBundle } from './skill-integrity.js'

/**
 * Exact reviewed version of the external `skills` installer.
 *
 * The installer program must not float on `latest`. Notifai gives this pinned
 * version a verified local copy from the installed npm package.
 */
export const SKILLS_INSTALLER_SPEC = 'skills@1.5.23'

/** The two scopes offered by the skills installer. */
export type SkillScope = 'project' | 'global'

/** The installer-managed evidence needed by Notifai readiness. */
export interface NativeSkill {
  name: string
  scope: SkillScope
  path: string
  source: string | null
  sourceType: string | null
  sourceUrl: string | null
  ref: string | null
}

export interface SkillsListResult {
  skills: NativeSkill[]
  error?: string
}

export interface SkillsAddOptions {
  diagnosticsToStderr?: boolean
  source: string
  skill: string
  scope?: SkillScope
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface SkillsOperationFailure {
  code: number
  error: string
}

export type SkillsOperationResult = number | SkillsOperationFailure

export interface SkillsRemoveOptions {
  skill: string
  scope: SkillScope
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface NativeSkills {
  /** Launch the native interactive `npx skills add` flow. */
  add(options: SkillsAddOptions): Promise<SkillsOperationResult>
  /** Uninstall one installer-managed skill in one scope. */
  remove(options: SkillsRemoveOptions): Promise<number>
  /** Read installer-managed inventory from lock files. Does not spawn npx. */
  list(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv): Promise<SkillsListResult>
}

interface LockEntry {
  source?: unknown
  sourceType?: unknown
  sourceUrl?: unknown
  ref?: unknown
}

interface LockFile {
  skills?: Record<string, LockEntry>
}

function skillLockPath(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv): string {
  if (scope === 'project') return path.join(cwd, 'skills-lock.json')
  const stateHome = env['XDG_STATE_HOME']
  return stateHome !== undefined && stateHome !== ''
    ? path.join(stateHome, 'skills', '.skill-lock.json')
    : path.join(accountHome(env), '.agents', '.skill-lock.json')
}

function readLock(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv): LockFile {
  const file = skillLockPath(scope, cwd, env)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LockFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function conventionalSkillPath(
  scope: SkillScope,
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  if (scope === 'project') return path.join(cwd, '.agents', 'skills', name)
  return path.join(accountHome(env), '.agents', 'skills', name)
}

function skillsFromLock(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv): NativeSkill[] {
  const lock = readLock(scope, cwd, env)
  return Object.entries(lock.skills ?? {}).flatMap(([name, entry]): NativeSkill[] => {
    if (entry === null || typeof entry !== 'object') return []
    return [
      {
        name,
        scope,
        // skills@1.5.23 records the source-relative SKILL.md as `skillPath`.
        // It is not the installed destination and is therefore not trusted for
        // readiness. The installer contract puts skills at this conventional
        // path for both scopes.
        path: conventionalSkillPath(scope, name, cwd, env),
        source: typeof entry.source === 'string' ? entry.source : null,
        sourceType: typeof entry.sourceType === 'string' ? entry.sourceType : null,
        sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : null,
        ref: typeof entry.ref === 'string' ? entry.ref : null,
      },
    ]
  })
}

export function runSkillsCommand(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; diagnosticsToStderr?: boolean; timeoutMs?: number },
  resolveLaunch: typeof npxLaunch = npxLaunch,
): Promise<SkillsOperationResult> {
  return new Promise((resolve) => {
    let launch: ReturnType<typeof npxLaunch>
    try {
      launch = resolveLaunch(args, { ...options,
        ...(options.diagnosticsToStderr ? { stdio: ['ignore', 2, 2] as const } : {}) })
    } catch (error) {
      resolve({
        code: 1,
        error: error instanceof Error ? error.message : 'the native skills installer could not start',
      })
      return
    }
    // Only unattended refresh/resume owns a bounded process tree. Preserve
    // the human installer's existing terminal and Ctrl-C behavior in setup.
    const bounded = options.diagnosticsToStderr === true || options.timeoutMs !== undefined
    const child = spawn(launch.file, launch.args, { ...launch.options, detached: bounded && process.platform !== 'win32' })
    let timedOut = false
    const timer = bounded ? setTimeout(() => {
      timedOut = true
      if (child.pid === undefined) return
      try {
        // Terminate only this owned installer tree, so a timed-out migration
        // cannot leave a descendant writing its skill after staging is removed.
        if (process.platform === 'win32') {
          const killed = spawnSync(
            path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5_000, windowsHide: true },
          )
          if (killed.status !== 0) child.kill('SIGKILL')
        }
        else process.kill(-child.pid, 'SIGKILL')
      } catch { child.kill('SIGKILL') }
    }, options.timeoutMs ?? 60_000) : undefined
    child.on('error', () => {
      clearTimeout(timer)
      resolve({
        code: 1,
        error:
          'the native skills installer could not start on this machine; repair the local Node.js and npm installation, then rerun setup',
      })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(timedOut ? { code: 1, error: 'The native skills installer timed out; integration remains incomplete. Resolve the installer failure, then resume the update.' } : code ?? 1)
    })
  })
}

/** argv for `npx`, including the pinned installer spec. */
export function skillsAddArgv(options: SkillsAddOptions): string[] {
  const args = ['-y', SKILLS_INSTALLER_SPEC, 'add', options.source, '--skill', options.skill]
  if (options.scope === 'global') args.push('--global')
  // An explicit scope is the unattended contract. Native `--yes` keeps all
  // remaining installer prompts non-interactive after the scope is chosen;
  // `--copy` keeps the installed directory independent of temporary staging.
  if (options.scope !== undefined) args.push('--copy', '--yes')
  return args
}

/** argv for uninstalling one skill in one installer scope. */
export function skillsRemoveArgv(options: SkillsRemoveOptions): string[] {
  const args = ['-y', SKILLS_INSTALLER_SPEC, 'remove', options.skill]
  if (options.scope === 'global') args.push('--global')
  args.push('--yes')
  return args
}

/** The only process/filesystem adapter Notifai needs for the external installer. */
export const nativeSkills: NativeSkills = {
  async add(options) {
    const version = packageVersion()
    if (version === null) {
      return { code: 1, error: 'this CLI cannot establish which packaged skill belongs to it' }
    }
    const staged = stageShippedSkillBundle(options.cwd, version)
    if (!staged.ok) return { code: 1, error: staged.error }
    try {
      return await runSkillsCommand(skillsAddArgv({ ...options, source: staged.staged.source }), {
        cwd: options.cwd,
        env: options.env,
        ...(options.diagnosticsToStderr === undefined ? {} : { diagnosticsToStderr: options.diagnosticsToStderr }),
      })
    } finally {
      staged.staged.cleanup()
    }
  },

  async remove(options) {
    const result = await runSkillsCommand(skillsRemoveArgv(options), {
      cwd: options.cwd,
      env: options.env,
    })
    return typeof result === 'number' ? result : result.code
  },

  async list(scope, cwd, env) {
    // Presence is already on disk. `npx skills list` takes seconds and cannot
    // change whether the notifai skill is installed — the lock file is what
    // the installer itself consults.
    return { skills: skillsFromLock(scope, cwd, env) }
  },
}
