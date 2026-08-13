import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

export interface NativeSkills {
  /** Launch the native interactive `npx skills add` flow. */
  add(options: SkillsAddOptions): Promise<number>
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
  const home = env['HOME'] ?? env['USERPROFILE'] ?? os.homedir()
  return stateHome !== undefined && stateHome !== ''
    ? path.join(stateHome, 'skills', '.skill-lock.json')
    : path.join(home, '.agents', '.skill-lock.json')
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
  const home = env['HOME'] ?? env['USERPROFILE'] ?? os.homedir()
  return path.join(home, '.agents', 'skills', name)
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
    const child = spawn('npx', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    })
    child.on('error', () => resolve(1))
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/** The only process/filesystem adapter Notifai needs for the external installer. */
export const nativeSkills: NativeSkills = {
  async add(options) {
    const args = ['-y', 'skills', 'add', options.source, '--skill', options.skill]
    if (options.scope === 'global') args.push('--global')
    // An explicit scope is the unattended contract. Native `--yes` keeps all
    // remaining installer prompts non-interactive after the scope is chosen.
    if (options.scope !== undefined) args.push('--yes')
    return run(args, { cwd: options.cwd, env: options.env })
  },

  async list(scope, cwd, env) {
    // Presence is already on disk. `npx skills list` takes seconds and cannot
    // change whether the notifai skill is installed — the lock file is what
    // the installer itself consults.
    return { skills: skillsFromLock(scope, cwd, env) }
  },
}
