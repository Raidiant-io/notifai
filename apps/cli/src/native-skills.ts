import { spawn } from 'node:child_process'
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

function conventionalSkillPath(
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

function run(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve) => {
    let launch: ReturnType<typeof npxLaunch>
    try {
      launch = npxLaunch(args, options)
    } catch {
      resolve(1)
      return
    }
    const child = spawn(launch.file, launch.args, launch.options)
    child.on('error', () => resolve(1))
    child.on('exit', (code) => resolve(code ?? 1))
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
      return await run(skillsAddArgv({ ...options, source: staged.staged.source }), {
        cwd: options.cwd,
        env: options.env,
      })
    } finally {
      staged.staged.cleanup()
    }
  },

  async remove(options) {
    return run(skillsRemoveArgv(options), { cwd: options.cwd, env: options.env })
  },

  async list(scope, cwd, env) {
    // Presence is already on disk. `npx skills list` takes seconds and cannot
    // change whether the notifai skill is installed — the lock file is what
    // the installer itself consults.
    return { skills: skillsFromLock(scope, cwd, env) }
  },
}
