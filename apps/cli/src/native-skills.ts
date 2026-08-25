import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { accountHome, npxLaunch } from './platform.js'

/**
 * Exact reviewed version of the external `skills` installer.
 *
 * The GitHub skill source stays the immutable CLI version tag. The installer
 * program that fetches it must not float on `latest`.
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

export interface SkillsRemoveOptions {
  skill: string
  scope: SkillScope
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface NativeSkills {
  /** Launch the native interactive `npx skills add` flow. */
  add(options: SkillsAddOptions): Promise<number>
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
  skillPath?: unknown
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
        path:
          typeof entry.skillPath === 'string' && entry.skillPath !== ''
            ? entry.skillPath
            : conventionalSkillPath(scope, name, cwd, env),
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
    const launch = npxLaunch(args, options)
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
  // remaining installer prompts non-interactive after the scope is chosen.
  if (options.scope !== undefined) args.push('--yes')
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
    return run(skillsAddArgv(options), { cwd: options.cwd, env: options.env })
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
