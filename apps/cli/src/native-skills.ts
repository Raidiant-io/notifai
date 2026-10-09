import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { accountHome, configHome } from './platform.js'
import { SkillInstallation, type SkillPlacement } from './skill-installation.js'
import { SOURCE_CONTEXT_HARNESSES, type SourceContextHarness } from './harnesses.js'
import { sameLocalPath } from './local-path.js'
import { openclawStateDir } from './openclaw-plugin.js'
import { packageVersion } from './release.js'
import { createSkillManifest, shippedSkillBundle, skillTreeDigest, type SkillInspectionBudget } from './skill-integrity.js'

/** Explicit placement scope for bundled Notifai guidance. */
export type SkillScope = 'project' | 'global'

export type SkillCondition = 'managed-current' | 'managed-stale' | 'managed-pending' | 'managed-missing' | 'managed-modified' | 'bundle-unavailable' | 'inspection-incomplete' | 'unmanaged' | 'incomplete' | 'unreadable'

/** A receipt-backed scope or an existing unowned guidance tree. */
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
  condition?: SkillCondition
  problem?: string
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
  /** Synchronous local discovery for lifecycle diagnostics; adapters must share list's inventory. */
  inspect?(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv, budget?: SkillInspectionBudget): SkillsListResult
  /** Read ownership-aware local inventory without executing a program.
   * Ownership must be explicit; omitted owned is treated as unmanaged. */
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
    if (statSync(file).size > 64 * 1024) return {}
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
 * Project Codex, Cursor and OpenCode share the conventional path. These harnesses have
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
  const openclawHome = openclawStateDir(env)
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

/** Receipt ownership and content currency are separate: matching bytes never adopt a tree. */
export function discoverNotifaiSkills(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv,
  budget: SkillInspectionBudget = { maxFiles: 100, maxBytes: 2 * 1024 * 1024, deadlineAt: Date.now() + 1_000 }): SkillsListResult {
  budget = { ...budget, maxFiles: Math.min(100, budget.maxFiles), maxBytes: Math.min(2 * 1024 * 1024, budget.maxBytes) }
  const state = new SkillInstallation({ cwd, env }).inspect(scope, budget)
  if (state.inspectionIncomplete) return { skills: [], error: `Inspection incomplete: ${state.conflicts.join('; ')}` }
  const skills: NativeSkill[] = []
  const inspectTree = (root: string): { condition: 'complete' | 'missing' | 'incomplete' | 'unreadable' | 'inspection-incomplete'; digest?: string; problem?: string } => {
    try {
      try { lstatSync(root) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { condition: 'missing', problem: String(error) }
        throw error
      }
      // Do not traverse links, including linked parent roots. Discovery is read-only.
      let current = path.resolve(root)
      const anchor = scope === 'project' ? path.resolve(cwd) : path.resolve(path.dirname(path.dirname(root)))
      while (true) {
        if (lstatSync(current).isSymbolicLink()) return { condition: 'unreadable', problem: `Linked skill path: ${current}` }
        if (current === anchor) break
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
      if (!lstatSync(root).isDirectory() || !lstatSync(path.join(root, 'SKILL.md')).isFile()) {
        return { condition: 'incomplete', problem: `Skill directory needs SKILL.md: ${root}` }
      }
      return { condition: 'complete', digest: createSkillManifest(root, '', budget).digest }
    } catch (error) {
      return { condition: /inspection (budget exhausted|size exceeded)/.test(String(error)) ? 'inspection-incomplete'
        : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'incomplete' : 'unreadable', problem: String(error) }
    }
  }
  const placements = [...state.placements, ...(state.pendingPlacement !== undefined &&
    !state.placements.some(item => item.path === state.pendingPlacement!.path) ? [state.pendingPlacement] : [])]
  if (placements.length > 0) {
    const version = packageVersion()
    const bundle = version === null ? null : shippedSkillBundle(version, budget)
    const expected = bundle?.ok ? bundle.bundle.manifest.digest : null
    const bundleProblem = bundle === null ? 'This CLI cannot establish its bundled skill identity' : bundle.ok ? undefined : bundle.error
    // inspect already compared each intact placement with its receipt digest.
    // Re-read only conflicts to distinguish unreadable, missing and modified trees.
    const trees: Array<{ item: SkillPlacement; tree: ReturnType<typeof inspectTree> }> = placements.map(item => ({ item, tree: state.conflicts.includes(item.path) || !state.placements.some(recorded => recorded.path === item.path)
      ? inspectTree(item.path) : { condition: 'complete' as const, digest: item.digest } }))
    const condition: SkillCondition = trees.some(({ tree }) => tree.condition === 'inspection-incomplete') ? 'inspection-incomplete'
      : trees.some(({ tree }) => tree.condition === 'unreadable') ? 'unreadable'
      : trees.some(({ tree }) => tree.condition === 'incomplete') ? 'incomplete'
      : trees.some(({ item, tree }) => tree.condition !== 'missing' && tree.digest !== item.digest &&
        !(state.pendingPlacement?.path === item.path && tree.digest === state.pendingPlacement.digest)) ? 'managed-modified'
      : bundleProblem !== undefined && /inspection (budget exhausted|size exceeded)/.test(bundleProblem) ? 'inspection-incomplete'
      : bundleProblem !== undefined ? 'bundle-unavailable'
      : state.pending ? 'managed-pending'
      : trees.some(({ tree }) => tree.condition === 'missing') ? 'managed-missing'
      : expected !== null && trees.every(({ tree }) => tree.digest === expected) ? 'managed-current' : 'managed-stale'
    const problem = trees.find(({ tree }) => tree.problem)?.tree.problem ?? bundleProblem
    skills.push({ name: 'notifai', scope, path: placements[0]!.path, source: 'bundled', sourceType: 'bundled',
      sourceUrl: null, ref: `v${placements[0]!.version}`, owned: true, pending: state.pending,
      agents: state.agents, placements, condition,
      ...(problem === undefined ? {} : { problem }) })
  }
  const candidates = [conventionalSkillPath(scope, 'notifai', cwd, env),
    ...harnessSkillCopies(scope, 'notifai', cwd, env).map(copy => copy.path),
    ...(scope === 'global' ? [path.join(accountHome(env), '.cursor', 'skills', 'notifai'),
      path.join(configHome(env), 'opencode', 'skills', 'notifai')] : [])]
  const legacy = skillsFromLock(scope, cwd, env).find(skill => skill.name === 'notifai')
  for (const root of new Set(candidates)) {
    let linked = false
    try { linked = lstatSync(root).isSymbolicLink() || lstatSync(path.dirname(root)).isSymbolicLink() } catch { /* presence/readability below */ }
    if (!linked && placements.some(item => sameLocalPath(item.path, root))) continue
    try { lstatSync(root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      skills.push({ name: 'notifai', scope, path: root, source: null, sourceType: null, sourceUrl: null,
        ref: null, owned: false, condition: 'unreadable', problem: String(error) })
      continue
    }
    const tree = inspectTree(root)
    skills.push({ name: 'notifai', scope, path: root, source: legacy?.source ?? null, sourceType: legacy?.sourceType ?? null,
      sourceUrl: legacy?.sourceUrl ?? null, ref: legacy?.ref ?? null, owned: false,
      condition: tree.condition === 'complete' ? 'unmanaged' : tree.condition === 'missing' ? 'incomplete' : tree.condition,
      ...(tree.problem === undefined ? {} : { problem: tree.problem }) })
  }
  // A legacy lock is evidence of an incomplete prior install, never an ownership receipt.
  if (skills.length === 0 && legacy !== undefined) skills.push({ ...legacy, owned: false, condition: 'incomplete' })
  // Modified owned content is represented above, rather than hidden behind a generic list error.
  const errors = placements.length === 0 ? state.conflicts : []
  return { skills, ...(errors.length === 0 ? {} : { error: errors.join('; ') }) }
}

export interface SkillInventory { installed: NativeSkill[]; errors: string[] }
export interface SkillInventoryIssue { code: string; resolution: string; detail: string; remedy: string }

/** Common decision for diagnostic commands; presentation belongs to each caller. */
export function skillInventoryIssue(inventory: SkillInventory): SkillInventoryIssue | null {
  const { installed, errors } = inventory
  const unsafe = installed.filter(skill => skill.owned !== true ||
    skill.condition === 'bundle-unavailable' || skill.condition === 'inspection-incomplete' || skill.condition === 'managed-modified' || skill.condition === 'incomplete' || skill.condition === 'unreadable')
  if (unsafe.length > 0 || errors.length > 0) {
    const unreadable = errors.length > 0 || unsafe.some(skill => skill.condition === 'unreadable')
    const incomplete = unsafe.some(skill => skill.condition === 'incomplete') || errors.some(error => error.includes('Incomplete skill installation'))
    const modified = unsafe.some(skill => skill.condition === 'managed-modified')
    const limited = unsafe.some(skill => skill.condition === 'inspection-incomplete') || errors.some(error => error.includes('Inspection incomplete'))
    if (limited) return { code: 'skill-inspection-incomplete', resolution: 'skill-inspection-incomplete',
      detail: 'The bounded local skill inspection could not finish; ownership and content currency remain unverified.',
      remedy: 'Preserve existing guidance. Run notifai doctor --json for a separate inspection before authorizing any skill changes; refresh has not been attempted.' }
    if (unsafe.some(skill => skill.condition === 'bundle-unavailable')) return {
      code: 'skill-bundle-unavailable', resolution: 'skill-bundle-unavailable',
      detail: 'This CLI cannot verify its shipped skill bundle. Existing guidance is preserved; content currency remains unverified.',
      remedy: 'Restore a CLI package with its matching verified bundled skill before attempting refresh. Run notifai doctor --json to inspect the local CLI installation; do not replace existing guidance with an unverifiable bundle.' }
    const resolution = incomplete ? 'skill-incomplete' : unreadable ? 'skill-unreadable' : modified ? 'skill-modified' : 'skill-unmanaged'
    return { code: resolution, resolution,
      detail: `${unsafe.map(skill => `${skill.scope}: ${skill.path} (${skill.condition ?? 'unmanaged'})`).join('; ')}${errors.length ? `; ${errors.join('; ')}` : ''}. Existing guidance is preserved; matching package bytes do not establish installer ownership.`,
      remedy: 'Preserve existing guidance and ask its owner whether to keep it unmanaged or explicitly resolve the conflicting placement; do not adopt, overwrite, move or delete it automatically. Resolve unreadable or incomplete state first. Only after that custody decision and conflict resolution, select a scope and supported harnesses for setup, for example: notifai init --skills --skills-scope project --skills-harness codex. Use the chosen scope and harnesses; refresh cannot manage unowned or modified content.' }
  }
  if (installed.length > 1) return { code: 'skill-scope-ambiguous', resolution: 'skill-duplicates',
    detail: 'Multiple receipt-backed skill scopes are installed.',
    remedy: 'Choose the scope to keep, then run notifai init --skills --skills-scope project or notifai init --skills --skills-scope global with that chosen scope.' }
  return null
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
  inspect: discoverNotifaiSkills,
  async list(scope, cwd, env) {
    return discoverNotifaiSkills(scope, cwd, env)
  },
}
