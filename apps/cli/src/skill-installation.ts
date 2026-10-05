import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync, ensurePrivateDirectory } from './atomic-file.js'
import { withFileLock } from './file-lock.js'
import { accountHome, configHome, stateHome } from './platform.js'
import { canonicalPath, sameLocalPath } from './local-path.js'
import { SOURCE_CONTEXT_HARNESSES, type SourceContextHarness } from './harnesses.js'
import { openclawConfigPath, openclawStateDir, parseOpenclawConfig } from './openclaw-plugin.js'
import { createSkillManifest, verifySkillBundle, type VerifiedSkillBundle } from './skill-integrity.js'

type Scope = 'project' | 'global'
export interface SkillPlacement { path: string; digest: string; version: string }
interface PendingPlacement {
  placement: SkillPlacement
  previous: SkillPlacement | null
  token: string
}
interface SkillState {
  schema: 1
  scope: Scope
  project: string | null
  agents: SourceContextHarness[]
  placements: SkillPlacement[]
  pending?: PendingPlacement
}
export interface SkillInspection {
  agents: SourceContextHarness[]
  placements: SkillPlacement[]
  pending: boolean
  conflicts: string[]
}
export interface SkillReconciliation extends SkillInspection { ok: boolean }

function present(file: string): boolean {
  try { lstatSync(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function owned(file: string): void {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`Unowned or linked skill path: ${file}`)
  }
}
function skillTreeDigest(file: string): string | null {
  try { return createSkillManifest(file, '', { maxFiles: 100, maxBytes: 2 * 1024 * 1024, deadlineAt: Date.now() + 1_000 }).digest }
  catch { return null }
}

/** One bundled skill, explicit placements, and a small recoverable replacement.
 * This module never installs another package, edits harness trust, or scans
 * other projects. Receipts prove content ownership, not arbitrary delete paths. */
export class SkillInstallation {
  private readonly cwd: string
  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  constructor(private readonly options: { cwd: string; env: NodeJS.ProcessEnv;
    observe?: (phase: 'prepared' | 'old-retained' | 'published') => void }) {
    this.cwd = canonicalPath(options.cwd)
    this.home = canonicalPath(accountHome(options.env))
    this.env = options.env
  }

  private directory(scope: Scope, agent: SourceContextHarness): { anchor: string; destination: string } {
    if (scope === 'project') {
      if (agent === 'openclaw') this.requireOpenClawWorkspace()
      const relative = { codex: '.agents/skills', cursor: '.agents/skills', opencode: '.agents/skills',
        'claude-code': '.claude/skills', hermes: '.hermes/skills', grok: '.grok/skills', openclaw: 'skills' }[agent]
      return { anchor: this.cwd, destination: path.join(this.cwd, relative, 'notifai') }
    }
    const configured = (key: string, fallback: string): string => {
      const value = this.env[key]?.trim()
      if (value && !path.isAbsolute(value)) throw new Error(`${key} must be an absolute harness home`)
      return canonicalPath(value || fallback)
    }
    const roots: Record<SourceContextHarness, () => string> = {
      codex: () => path.join(this.home, '.agents'),
      cursor: () => path.join(this.home, '.cursor'),
      opencode: () => path.join(configHome(this.env), 'opencode'),
      'claude-code': () => configured('CLAUDE_CONFIG_DIR', path.join(this.home, '.claude')),
      hermes: () => configured('HERMES_HOME', path.join(this.home, '.hermes')),
      grok: () => configured('GROK_HOME', path.join(this.home, '.grok')),
      openclaw: () => {
        const root = openclawStateDir(this.env)
        if (!path.isAbsolute(root)) throw new Error('OpenClaw state home must be absolute')
        return canonicalPath(root)
      },
    }
    const anchor = roots[agent]()
    return { anchor, destination: path.join(anchor, 'skills', 'notifai') }
  }

  /** OpenClaw's configured workspace is not necessarily the command's CWD. */
  private requireOpenClawWorkspace(): void {
    const config = openclawConfigPath(this.env)
    if (!path.isAbsolute(config)) throw new Error('OpenClaw configuration path must be absolute')
    let workspace = this.env['OPENCLAW_WORKSPACE_DIR']?.trim() || path.join(openclawStateDir(this.env), 'workspace')
    if (present(config)) {
      if (lstatSync(config).size > 256 * 1024) throw new Error('OpenClaw workspace configuration is too large to inspect')
      const parsed = parseOpenclawConfig(readFileSync(config, 'utf8'), config)
      const object = (value: unknown): Record<string, unknown> => {
        if (value === undefined) return {}
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
        throw new Error('OpenClaw agent workspace configuration must be an object')
      }
      const agents = object(parsed['agents']), defaults = object(agents['defaults'])
      const entries = Object.entries(object(agents['entries']))
      if ('$include' in parsed || '$include' in agents || '$include' in defaults || agents['list'] !== undefined ||
          (agents['entries'] !== undefined && entries.length !== 1)) {
        throw new Error('OpenClaw project placement needs one unambiguous configured agent workspace; use global skill scope or resolve the agent configuration first')
      }
      const entry = object(entries[0]?.[1])
      if ('$include' in entry) throw new Error('Resolve the OpenClaw agent workspace before project skill placement')
      const selected = entry['workspace'] ?? defaults['workspace']
      if (selected !== undefined) {
        if (typeof selected !== 'string') throw new Error('OpenClaw workspace must be a concrete directory')
        workspace = selected
      }
    }
    if (workspace.startsWith('~/')) workspace = path.join(this.home, workspace.slice(2))
    if (!path.isAbsolute(workspace) || workspace.includes('${') || !sameLocalPath(workspace, this.cwd)) {
      throw new Error('Run project skill setup from the configured OpenClaw workspace, or choose global skill scope')
    }
  }

  private destinations(scope: Scope, agents: readonly SourceContextHarness[]): string[] {
    return [...new Set(agents.map(agent => this.directory(scope, agent).destination))]
  }

  private guard(scope: Scope, agents: readonly SourceContextHarness[], destination: string): void {
    const selected = agents.map(agent => this.directory(scope, agent)).find(item => sameLocalPath(item.destination, destination))
    if (!selected) throw new Error(`Skill receipt names an unexpected destination: ${destination}`)
    let current = selected.anchor
    if (present(current)) owned(current)
    for (const component of path.relative(selected.anchor, destination).split(path.sep)) {
      current = path.join(current, component)
      if (present(current)) owned(current)
    }
  }

  private statePath(scope: Scope): string {
    const id = scope === 'global' ? 'global' : createHash('sha256').update(process.platform === 'win32' ? this.cwd.toLowerCase() : this.cwd).digest('hex')
    return path.join(stateHome(this.env), 'notifai', 'skill-installations', `${id}.json`)
  }

  private empty(scope: Scope): SkillState {
    return { schema: 1, scope, project: scope === 'project' ? this.cwd : null, agents: [], placements: [] }
  }

  private read(scope: Scope): SkillState {
    const file = this.statePath(scope)
    if (!present(file)) return this.empty(scope)
    owned(file)
    if (lstatSync(file).size > 64 * 1024) throw new Error('Skill ownership receipt is too large')
    const state = JSON.parse(readFileSync(file, 'utf8')) as SkillState
    if (state.schema !== 1 || state.scope !== scope ||
      (scope === 'project' ? typeof state.project !== 'string' || !sameLocalPath(state.project, this.cwd) : state.project !== null) ||
      !Array.isArray(state.agents) || state.agents.length > SOURCE_CONTEXT_HARNESSES.length ||
      !state.agents.every(agent => SOURCE_CONTEXT_HARNESSES.includes(agent)) || !Array.isArray(state.placements) ||
      state.placements.length > SOURCE_CONTEXT_HARNESSES.length) throw new Error('Invalid skill ownership receipt')
    const placements = [...state.placements, ...(state.pending ? [state.pending.placement, ...(state.pending.previous ? [state.pending.previous] : [])] : [])]
    for (const item of placements) {
      if (!item || typeof item.path !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.digest) || typeof item.version !== 'string') {
        throw new Error('Invalid owned skill placement')
      }
      this.guard(scope, state.agents, item.path)
    }
    if (state.pending && (!/^[a-f0-9]{24}$/.test(state.pending.token) ||
      (state.pending.previous && state.pending.previous.path !== state.pending.placement.path))) throw new Error('Invalid pending skill replacement')
    return state
  }

  private save(state: SkillState): void {
    atomicWriteFileSync(this.statePath(state.scope), `${JSON.stringify(state)}\n`, { requireCurrentUserOwner: true })
  }

  inspect(scope: Scope): SkillInspection {
    try {
      const state = this.read(scope)
      return { agents: [...state.agents], placements: [...state.placements], pending: state.pending !== undefined,
        conflicts: state.placements.filter(item => skillTreeDigest(item.path) !== item.digest).map(item => item.path) }
    } catch (error) { return { agents: [], placements: [], pending: false, conflicts: [String(error)] } }
  }

  private temporary(pending: PendingPlacement, suffix: 'new' | 'old'): string {
    return path.join(path.dirname(pending.placement.path), `.notifai-${pending.token}.${suffix}`)
  }

  /** Reconcile only a journal already admitted by this installation's receipt. */
  private recover(state: SkillState): void {
    const pending = state.pending
    if (!pending) return
    const destination = pending.placement.path
    const staged = this.temporary(pending, 'new'), backup = this.temporary(pending, 'old')
    this.guard(state.scope, state.agents, destination)
    for (const file of [staged, backup]) if (present(file)) owned(file)
    const current = skillTreeDigest(destination)
    if (current !== pending.placement.digest) {
      if (present(destination) && current !== pending.previous?.digest) throw new Error(`Preserved modified skill during recovery: ${destination}`)
      if (skillTreeDigest(staged) !== pending.placement.digest) {
        // A verified old tree remains available even if the staged copy was lost.
        if (!present(destination) && pending.previous && skillTreeDigest(backup) === pending.previous.digest) renameSync(backup, destination)
        if (!present(staged) && !present(backup) &&
            (pending.previous ? skillTreeDigest(destination) === pending.previous.digest : !present(destination))) {
          delete state.pending
          this.save(state)
          return
        }
        throw new Error(`Skill replacement needs its verified staged content: ${staged}`)
      }
      if (present(destination)) {
        if (present(backup)) throw new Error(`Skill recovery has two old trees: ${destination}`)
        renameSync(destination, backup)
      }
      this.options.observe?.('old-retained')
      renameSync(staged, destination)
      this.options.observe?.('published')
    }
    if (skillTreeDigest(destination) !== pending.placement.digest) throw new Error(`Skill changed during placement: ${destination}`)
    state.placements = [...state.placements.filter(item => item.path !== destination), pending.placement]
    // Keep the journal until owned backup cleanup has completed. A failure or a
    // user edit there is retained and can be diagnosed on the next explicit run.
    this.save(state)
    if (present(backup)) {
      if (!pending.previous || skillTreeDigest(backup) !== pending.previous.digest) throw new Error(`Preserved modified skill backup: ${backup}`)
      rmSync(backup, { recursive: true })
    }
    if (present(staged)) {
      if (skillTreeDigest(staged) !== pending.placement.digest) throw new Error(`Preserved modified staged skill: ${staged}`)
      rmSync(staged, { recursive: true })
    }
    delete state.pending
    this.save(state)
  }

  reconcile(input: { scope: Scope; agents?: readonly SourceContextHarness[]; bundle: VerifiedSkillBundle }): SkillReconciliation {
    try {
      const verified = verifySkillBundle(input.bundle.sourceRoot, input.bundle.manifest.package_version)
      if (!verified.ok) throw new Error(verified.error)
      const file = this.statePath(input.scope)
      ensurePrivateDirectory(path.dirname(file))
      withFileLock(path.join(path.dirname(file), 'placements.lock'), () => {
        const state = this.read(input.scope)
        this.recover(state)
        const agents = [...new Set(input.agents ?? state.agents)]
        if (agents.length === 0 || !agents.every(agent => SOURCE_CONTEXT_HARNESSES.includes(agent))) throw new Error('Choose the supported harnesses that should load this skill')
        const destinations = this.destinations(input.scope, agents)
        const other = this.read(input.scope === 'global' ? 'project' : 'global')
        if ([...other.placements, ...(other.pending ? [other.pending.placement] : [])].some(item => destinations.some(destination => sameLocalPath(item.path, destination)))) {
          throw new Error('Project and global skill destinations overlap; keep the existing scope or use a separate project directory')
        }
        // Changing the selected set must never silently delete a prior placement.
        if (state.placements.some(item => !destinations.includes(item.path))) throw new Error('Remove the existing owned skill scope before narrowing its harness selection')
        for (const destination of destinations) {
          this.guard(input.scope, agents, destination)
          const previous = state.placements.find(item => item.path === destination)
          if (present(destination) && (!previous || skillTreeDigest(destination) !== previous.digest)) {
            throw new Error(`Preserved unowned or modified skill: ${destination}`)
          }
        }
        state.agents = agents
        for (const destination of destinations) {
          const previous = state.placements.find(item => item.path === destination) ?? null
          if (previous?.digest === verified.bundle.manifest.digest && present(destination)) continue
          mkdirSync(path.dirname(destination), { recursive: true })
          this.guard(input.scope, agents, destination)
          const pending: PendingPlacement = { previous, token: randomBytes(12).toString('hex'), placement: {
            path: destination, digest: verified.bundle.manifest.digest, version: verified.bundle.manifest.package_version } }
          const staged = this.temporary(pending, 'new')
          // Read embedded files through the runtime: native copyfile cannot
          // address Bun's executable filesystem. The verified manifest bounds
          // the exact files copied into this newly created private directory.
          mkdirSync(staged, { mode: 0o700 })
          for (const entry of verified.bundle.manifest.files) {
            if (entry.path.split('/').some(part => !part || part === '.' || part === '..') ||
              entry.path.includes('\\') || path.isAbsolute(entry.path)) throw new Error('Invalid bundled skill path')
            const target = path.join(staged, entry.path)
            mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
            writeFileSync(target, readFileSync(path.join(verified.bundle.skillRoot, entry.path)), { flag: 'wx', mode: 0o600 })
          }
          if (skillTreeDigest(staged) !== pending.placement.digest) throw new Error('Staged skill failed integrity verification')
          state.pending = pending
          this.save(state)
          this.options.observe?.('prepared')
          this.recover(state)
        }
        this.save(state)
      }, { waitMs: 5_000, strictRelease: true })
      const result = this.inspect(input.scope)
      return { ...result, ok: !result.pending && result.conflicts.length === 0 }
    } catch (error) { return { ...this.inspect(input.scope), ok: false, conflicts: [String(error)] } }
  }

  remove(scope: Scope): SkillReconciliation {
    try {
      const file = this.statePath(scope)
      if (!existsSync(file)) return { ok: true, agents: [], placements: [], pending: false, conflicts: [] }
      withFileLock(path.join(path.dirname(file), 'placements.lock'), () => {
        const state = this.read(scope)
        this.recover(state)
        for (const item of state.placements) {
          this.guard(scope, state.agents, item.path)
          if (present(item.path) && skillTreeDigest(item.path) !== item.digest) throw new Error(`Preserved modified skill: ${item.path}`)
        }
        for (const item of [...state.placements]) {
          if (present(item.path)) rmSync(item.path, { recursive: true })
          state.placements = state.placements.filter(entry => entry.path !== item.path)
          this.save(state)
        }
        rmSync(file)
      }, { waitMs: 5_000, strictRelease: true })
      return { ok: true, agents: [], placements: [], pending: false, conflicts: [] }
    } catch (error) { return { ...this.inspect(scope), ok: false, conflicts: [String(error)] } }
  }
}
