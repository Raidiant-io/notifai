import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { accountHome } from './platform.js'
import { SkillInstallation, type SkillPlacement } from './skill-installation.js'
import { SOURCE_CONTEXT_HARNESSES, type SourceContextHarness } from './harnesses.js'
import { packageVersion } from './release.js'
import { shippedSkillBundle, skillTreeDigest } from './skill-integrity.js'

/** Explicit placement scope for bundled Notifai guidance. */
export type SkillScope = 'project' | 'global'

/** One scope and all of its owned guidance placements. */
export interface NativeSkill {
  name: string
  scope: SkillScope
  path: string
  source: string | null
  sourceType: string | null
  sourceUrl: string | null
  ref: string | null
  pending?: boolean
  owned?: boolean
  agents?: SourceContextHarness[]
  placements?: SkillPlacement[]
}

export interface SkillsListResult {
  skills: NativeSkill[]
  error?: string
}

export interface SkillsAddOptions {
  /** Supported harness names for a new placement; refresh retains receipts. */
  agents?: readonly string[]
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
  /** Place this build’s verified bundled skill in the selected scope. */
  add(options: SkillsAddOptions): Promise<SkillsOperationResult>
  /** Uninstall one installer-managed skill in one scope. */
  remove(options: SkillsRemoveOptions): Promise<number>
  /** Read local receipts and migration evidence without executing a program. */
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

/** One harness-specific place the pinned installer puts a skill. */
export interface HarnessSkillCopy {
  /** The pinned installer's name for this harness. */
  agent: string
  label: string
  path: string
  /** Whether the installer would count this harness as installed here. */
  detected: boolean
}

/**
 * The skill directories that harnesses read instead of the conventional
 * `.agents/skills` path, as the pinned installer places them.
 *
 * Codex, Cursor and OpenCode share the conventional path. These harnesses have
 * their own directory, and a copy there is the one they load. The installer
 * narrows an unattended install to the agent it runs inside, so a refresh
 * started from one harness leaves every other harness's copy as it was.
 */
export function harnessSkillCopies(
  scope: SkillScope,
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): HarnessSkillCopy[] {
  const home = accountHome(env)
  const configured = (key: string, fallback: string): string => {
    const value = env[key]?.trim()
    return value !== undefined && value !== '' ? value : path.join(home, fallback)
  }
  const openclawHome =
    ['.openclaw', '.clawdbot', '.moltbot'].map((entry) => path.join(home, entry)).find((entry) => existsSync(entry)) ??
    path.join(home, '.openclaw')
  const harnesses = [
    { agent: 'claude-code', label: 'Claude Code', home: configured('CLAUDE_CONFIG_DIR', '.claude'), project: path.join('.claude', 'skills') },
    { agent: 'hermes-agent', label: 'Hermes', home: configured('HERMES_HOME', '.hermes'), project: path.join('.hermes', 'skills') },
    { agent: 'grok', label: 'Grok', home: configured('GROK_HOME', '.grok'), project: path.join('.grok', 'skills') },
    { agent: 'openclaw', label: 'OpenClaw', home: openclawHome, project: 'skills' },
  ]
  return harnesses.map((harness) => ({
    agent: harness.agent,
    label: harness.label,
    path: scope === 'global' ? path.join(harness.home, 'skills', name) : path.join(cwd, harness.project, name),
    detected: existsSync(harness.home),
  }))
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/**
 * Harness-specific copies whose content is not the expected skill.
 *
 * An existing copy is always checked. With `includeMissing`, a detected
 * harness with no copy counts too: that is what an installer run outside any
 * agent would have created. A link to the conventional directory is that
 * directory, not a second copy.
 */
export function staleHarnessSkillCopies(
  skill: Pick<NativeSkill, 'name' | 'scope' | 'path'>,
  expectedDigest: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  includeMissing = false,
): HarnessSkillCopy[] {
  if ('placements' in skill && Array.isArray(skill.placements)) {
    return (skill.placements as SkillPlacement[]).filter(copy => skillTreeDigest(copy.path) !== expectedDigest)
      .map(copy => ({ agent: 'selected', label: 'selected harness', path: copy.path, detected: true }))
  }
  return harnessSkillCopies(skill.scope, skill.name, cwd, env).filter((copy) => {
    if (!existsSync(copy.path)) return includeMissing && copy.detected
    if (sameDirectory(copy.path, skill.path)) return false
    return skillTreeDigest(copy.path) !== expectedDigest
  })
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

/** The bundled installer never downloads or executes another installer. */
export const nativeSkills: NativeSkills = {
  async add(options) {
    if (options.skill !== 'notifai' || options.scope === undefined) return { code: 1, error: 'Choose project or global scope for the bundled Notifai skill' }
    if (options.agents?.some(agent => !(SOURCE_CONTEXT_HARNESSES as readonly string[]).includes(agent))) {
      return { code: 1, error: 'Choose supported Notifai harness names for the skill' }
    }
    const version = packageVersion()
    if (version === null) return { code: 1, error: 'This CLI cannot establish which bundled skill belongs to it' }
    const bundle = shippedSkillBundle(version)
    if (!bundle.ok) return { code: 1, error: bundle.error }
    const result = new SkillInstallation(options).reconcile({ scope: options.scope, bundle: bundle.bundle,
      ...(options.agents === undefined ? {} : { agents: options.agents as SourceContextHarness[] }) })
    return result.ok ? 0 : { code: 1, error: result.conflicts.join('; ') }
  },
  async remove(options) {
    if (options.skill !== 'notifai') return 1
    return new SkillInstallation(options).remove(options.scope).ok ? 0 : 1
  },
  async list(scope, cwd, env) {
    const state = new SkillInstallation({ cwd, env }).inspect(scope)
    const first = state.placements[0]
    if (first) return { skills: [{ name: 'notifai', scope, path: first.path, source: 'bundled', sourceType: 'bundled',
      sourceUrl: null, ref: `v${first.version}`, owned: true, pending: state.pending, agents: state.agents, placements: state.placements }] }
    if (state.conflicts.length > 0) return { skills: [], error: state.conflicts.join('; ') }
    // Legacy locks are read-only migration evidence. They do not confer
    // ownership over directories or authorize removal of another installer’s data.
    return { skills: skillsFromLock(scope, cwd, env).filter(skill => skill.name === 'notifai').map(skill => ({ ...skill, owned: false })) }
  },
}
