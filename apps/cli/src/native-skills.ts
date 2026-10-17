import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { accountHome, configHome } from './platform.js'
import { integrationPublication, type IntegrationPublication } from './native-installation.js'
import { SOURCE_CONTEXT_HARNESSES, type SourceContextHarness } from './harnesses.js'
import { canonicalPath, sameLocalPath } from './local-path.js'
import { openclawConfigPath, openclawStateDir, parseOpenclawConfig } from './openclaw-plugin.js'
import { packageVersion } from './release.js'
import { createSkillManifest, shippedSkillBundle, verifySkillBundle, type SkillInspectionBudget, type VerifiedSkillBundle } from './skill-integrity.js'

/**
 * Notifai guidance on disk.
 *
 * Every `notifai` skill directory in a harness's skill location is Notifai's.
 * Nothing records who placed it: the location says whose it is, and the bytes
 * say whether it is current. Refresh rewrites any copy that is not this CLI's
 * bundled skill, wherever it came from. Customisation belongs in Guidance
 * Topics, which no refresh touches.
 *
 * Reads follow links, so a harness whose skill directory is a link to another
 * harness's is one copy, not two. Writes land on the resolved directory. A
 * project-scope destination must resolve inside the project, so a checkout
 * cannot steer a write elsewhere on the machine.
 */

/** Where guidance is placed: this checkout, or every project on the machine. */
export type SkillScope = 'project' | 'global'

/** One directory some harnesses load the skill from. */
export interface SkillCopy {
  scope: SkillScope
  /** The directory a harness loads, as that harness names it. */
  path: string
  /** Every harness that loads this directory. */
  harnesses: SourceContextHarness[]
  condition: 'current' | 'stale' | 'unreadable'
  problem?: string
}

export interface SkillInventory {
  copies: SkillCopy[]
  /** The bundled skill's digest, or null when this CLI cannot verify its own bundle. */
  expectedDigest: string | null
  /** Inspection could not finish; the copies listed are incomplete. */
  error?: string
}

export interface SkillsOperationFailure {
  code: number
  error: string
}

export type SkillsOperationResult = number | SkillsOperationFailure

export interface SkillRefreshResult {
  ok: boolean
  /** Directories rewritten with the bundled skill. */
  changed: string[]
  error?: string
}

export interface NativeSkills {
  /** Synchronous local discovery: every copy any harness loads, and whether it is current. */
  inspect(cwd: string, env: NodeJS.ProcessEnv, budget?: SkillInspectionBudget): SkillInventory
  /** Place the bundled skill for these harnesses in one scope, replacing their copies in the other. */
  place(options: { scope: SkillScope; harnesses: readonly SourceContextHarness[]; cwd: string; env: NodeJS.ProcessEnv;
    publishIntegration?: IntegrationPublication }): Promise<SkillsOperationResult>
  /** Rewrite every copy that is not the bundled skill. */
  refresh(options: { cwd: string; env: NodeJS.ProcessEnv; publishIntegration?: IntegrationPublication }): Promise<SkillRefreshResult>
  /** Remove every copy in the given scopes. */
  remove(options: { scopes: readonly SkillScope[]; cwd: string; env: NodeJS.ProcessEnv }): Promise<SkillsOperationResult>
}

/** The directory a harness loads Notifai guidance from, or null where it has none. */
export function skillDestination(scope: SkillScope, harness: SourceContextHarness, cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (scope === 'project') {
    if (harness === 'openclaw' && !isOpenclawWorkspace(cwd, env)) return null
    const relative = { codex: '.agents/skills', cursor: '.agents/skills', opencode: '.agents/skills',
      'claude-code': '.claude/skills', hermes: '.hermes/skills', grok: '.grok/skills', openclaw: 'skills' }[harness]
    return path.join(cwd, relative, 'notifai')
  }
  const home = accountHome(env)
  const configured = (key: string, fallback: string): string | null => {
    const value = env[key]?.trim()
    if (!value) return path.join(home, fallback)
    return path.isAbsolute(value) ? value : null
  }
  const root = {
    codex: () => path.join(home, '.agents'),
    cursor: () => path.join(home, '.cursor'),
    opencode: () => path.join(configHome(env), 'opencode'),
    'claude-code': () => configured('CLAUDE_CONFIG_DIR', '.claude'),
    hermes: () => configured('HERMES_HOME', '.hermes'),
    grok: () => configured('GROK_HOME', '.grok'),
    openclaw: () => {
      const state = openclawStateDir(env)
      return path.isAbsolute(state) ? state : null
    },
  }[harness]()
  return root === null ? null : path.join(root, 'skills', 'notifai')
}

/** OpenClaw loads project skills from its configured workspace, which need not be this directory. */
function isOpenclawWorkspace(cwd: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const config = openclawConfigPath(env)
    let workspace = env['OPENCLAW_WORKSPACE_DIR']?.trim() || path.join(openclawStateDir(env), 'workspace')
    if (path.isAbsolute(config) && existsSync(config)) {
      if (lstatSync(config).size > 256 * 1024) return false
      const parsed = parseOpenclawConfig(readFileSync(config, 'utf8'), config)
      const object = (value: unknown): Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      const agents = object(parsed['agents']), defaults = object(agents['defaults'])
      const entries = Object.values(object(agents['entries']))
      // Several agent workspaces, or one built from includes, name no single project.
      if ('$include' in parsed || '$include' in agents || '$include' in defaults || agents['list'] !== undefined ||
          entries.length > 1) return false
      const selected = object(entries[0])['workspace'] ?? defaults['workspace']
      if (selected !== undefined) {
        if (typeof selected !== 'string') return false
        workspace = selected
      }
    }
    if (workspace.startsWith('~/')) workspace = path.join(accountHome(env), workspace.slice(2))
    return path.isAbsolute(workspace) && !workspace.includes('${') && sameLocalPath(workspace, cwd)
  } catch {
    return false
  }
}

function bundledSkill(): { ok: true; bundle: VerifiedSkillBundle } | { ok: false; error: string } {
  const version = packageVersion()
  if (version === null) return { ok: false, error: 'This CLI cannot establish which bundled skill belongs to it' }
  const shipped = shippedSkillBundle(version)
  if (!shipped.ok) return { ok: false, error: shipped.error }
  const verified = verifySkillBundle(shipped.bundle.sourceRoot, shipped.bundle.manifest.package_version)
  return verified.ok ? { ok: true, bundle: verified.bundle } : { ok: false, error: verified.error }
}

function expectedSkillDigest(): string | null {
  const version = packageVersion()
  if (version === null) return null
  const shipped = shippedSkillBundle(version)
  return shipped.ok ? shipped.bundle.manifest.digest : null
}

function inspectionLimit(error: unknown): boolean {
  return /inspection (budget exhausted|size exceeded)/.test(String(error))
}

export function inspectSkillCopies(cwd: string, env: NodeJS.ProcessEnv, budget?: SkillInspectionBudget): SkillInventory {
  const expectedDigest = expectedSkillDigest()
  const byDirectory = new Map<string, SkillCopy>()
  try {
    // Global first: run from the home directory, both scopes name one directory, and it is the machine's.
    for (const scope of ['global', 'project'] as const) {
      for (const harness of SOURCE_CONTEXT_HARNESSES) {
        const destination = skillDestination(scope, harness, cwd, env)
        if (destination === null || !existsSync(destination)) continue
        const directory = canonicalPath(destination)
        const known = byDirectory.get(directory)
        if (known !== undefined) {
          if (!known.harnesses.includes(harness)) known.harnesses.push(harness)
          continue
        }
        let condition: SkillCopy['condition']
        let problem: string | undefined
        try {
          condition = createSkillManifest(directory, '', budget).digest === expectedDigest ? 'current' : 'stale'
        } catch (error) {
          if (inspectionLimit(error)) throw error
          condition = 'unreadable'
          problem = String(error)
        }
        byDirectory.set(directory, { scope, path: destination, harnesses: [harness], condition,
          ...(problem === undefined ? {} : { problem }) })
      }
    }
  } catch (error) {
    return { copies: [...byDirectory.values()], expectedDigest, error: `Inspection incomplete: ${String(error)}` }
  }
  return { copies: [...byDirectory.values()], expectedDigest }
}

/** The directory a write lands on. Project scope must stay inside the project. */
function writableDirectory(scope: SkillScope, destination: string, cwd: string): string {
  const directory = canonicalPath(destination)
  if (scope === 'project') {
    const fold = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file
    if (!fold(directory).startsWith(`${fold(canonicalPath(cwd))}${path.sep}`)) {
      throw new Error(`Refusing a project skill destination that resolves outside the project: ${destination}`)
    }
  }
  return directory
}

const LEFTOVER = /^\.notifai-[a-f0-9]{24}\.(new|old)$/

/** Replace one directory with the bundled skill: stage beside it, swap, discard the old tree. */
function writeSkill(directory: string, bundle: VerifiedSkillBundle): void {
  const parent = path.dirname(directory)
  mkdirSync(parent, { recursive: true })
  // An interrupted earlier write leaves its staging directories here.
  for (const name of readdirSync(parent)) {
    if (LEFTOVER.test(name)) rmSync(path.join(parent, name), { recursive: true, force: true })
  }
  const token = randomBytes(12).toString('hex')
  const staged = path.join(parent, `.notifai-${token}.new`)
  const old = path.join(parent, `.notifai-${token}.old`)
  mkdirSync(staged, { mode: 0o700 })
  // Read embedded files through the runtime: native copyfile cannot address
  // Bun's executable filesystem. The verified manifest bounds what is copied.
  for (const entry of bundle.manifest.files) {
    if (entry.path.split('/').some(part => !part || part === '.' || part === '..') ||
      entry.path.includes('\\') || path.isAbsolute(entry.path)) throw new Error('Invalid bundled skill path')
    const target = path.join(staged, entry.path)
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, readFileSync(path.join(bundle.skillRoot, entry.path)), { flag: 'wx', mode: 0o600 })
  }
  if (createSkillManifest(staged, '').digest !== bundle.manifest.digest) {
    rmSync(staged, { recursive: true, force: true })
    throw new Error('Staged skill failed integrity verification')
  }
  const replacing = existsSync(directory)
  if (replacing) renameSync(directory, old)
  renameSync(staged, directory)
  // The new copy is in place; an old tree that resists deletion is cleared by the next write here.
  if (replacing) try { rmSync(old, { recursive: true, force: true }) } catch { /* best effort */ }
}

/** Remove every copy in these scopes; null on success, otherwise what stopped it. */
export function removeSkillCopies(scopes: readonly SkillScope[], cwd: string, env: NodeJS.ProcessEnv): string | null {
  try {
    for (const copy of inspectSkillCopies(cwd, env).copies) {
      if (scopes.includes(copy.scope)) rmSync(writableDirectory(copy.scope, copy.path, cwd), { recursive: true, force: true })
    }
    return null
  } catch (error) {
    return failure(error).error
  }
}

function failure(error: unknown): SkillsOperationFailure {
  return { code: 1, error: error instanceof Error ? error.message : String(error) }
}

export const nativeSkills: NativeSkills = {
  inspect: inspectSkillCopies,

  async place(options) {
    if (options.harnesses.length === 0 || options.harnesses.some(harness => !SOURCE_CONTEXT_HARNESSES.includes(harness))) {
      return { code: 1, error: 'Choose the supported harnesses that should load this skill' }
    }
    const bundle = bundledSkill()
    if (!bundle.ok) return { code: 1, error: bundle.error }
    const other: SkillScope = options.scope === 'project' ? 'global' : 'project'
    try {
      return (options.publishIntegration ?? integrationPublication(options))(() => {
        const placed = new Set<string>()
        for (const harness of options.harnesses) {
          const destination = skillDestination(options.scope, harness, options.cwd, options.env)
          if (destination === null) {
            throw new Error(harness === 'openclaw'
              ? 'Run project skill setup from the configured OpenClaw workspace, or choose global skill scope'
              : `${harness} has no ${options.scope} skill location`)
          }
          const directory = writableDirectory(options.scope, destination, options.cwd)
          if (!placed.has(directory)) writeSkill(directory, bundle.bundle)
          placed.add(directory)
        }
        // A harness lists every copy it can see; one scope per harness keeps it to one.
        for (const harness of options.harnesses) {
          const destination = skillDestination(other, harness, options.cwd, options.env)
          if (destination === null || !existsSync(destination)) continue
          const directory = writableDirectory(other, destination, options.cwd)
          if (!placed.has(directory)) rmSync(directory, { recursive: true, force: true })
        }
        return 0
      })
    } catch (error) {
      return failure(error)
    }
  },

  async refresh(options) {
    const inventory = inspectSkillCopies(options.cwd, options.env)
    if (inventory.error !== undefined) return { ok: false, changed: [], error: inventory.error }
    const outdated = inventory.copies.filter(copy => copy.condition !== 'current')
    if (outdated.length === 0) return { ok: true, changed: [] }
    const bundle = bundledSkill()
    if (!bundle.ok) return { ok: false, changed: [], error: bundle.error }
    const changed: string[] = []
    try {
      (options.publishIntegration ?? integrationPublication(options))(() => {
        for (const copy of outdated) {
          writeSkill(writableDirectory(copy.scope, copy.path, options.cwd), bundle.bundle)
          changed.push(copy.path)
        }
      })
      return { ok: true, changed }
    } catch (error) {
      return { ok: false, changed, error: failure(error).error }
    }
  },

  async remove(options) {
    const error = removeSkillCopies(options.scopes, options.cwd, options.env)
    return error === null ? 0 : { code: 1, error }
  },
}
