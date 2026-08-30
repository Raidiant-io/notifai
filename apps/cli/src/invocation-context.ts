import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { type SourceContextT } from '@raidiant/notifai-protocol'
import type { SourceContextHarness } from './harnesses.js'
import { resolveSessionLabel } from './session-labels.js'

export type GitCommand = (cwd: string, args: readonly string[]) => string | null

const runGit: GitCommand = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      windowsHide: true,
    }).trim()
  } catch {
    return null
  }
}

/** The useful, privacy-safe context inferred from one invocation directory. */
export interface InvocationContext {
  project: string | null
  branch?: string
  worktree?: string
}

/** Contract-valid Project slug, or null when the name has no safe characters. */
export function projectSlugFrom(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, '')
    .slice(0, 64)
  return slug.length > 0 && /^[a-z0-9]/.test(slug) ? slug : null
}

function usesWindowsPaths(...values: string[]): boolean {
  return values.some((value) => /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value))
}

function pathApi(...values: string[]): typeof path.posix | typeof path.win32 {
  return usesWindowsPaths(...values) ? path.win32 : path.posix
}

/** Basename that can be fixture-tested for POSIX, drive, and UNC paths on any OS. */
export function portableBasename(value: string): string {
  const api = pathApi(value)
  return api.basename(api.normalize(value))
}

function resolveGitPath(cwd: string, value: string): string {
  const api = pathApi(cwd, value)
  return api.isAbsolute(value) ? api.normalize(value) : api.resolve(cwd, value)
}

function samePath(left: string, right: string): boolean {
  const api = pathApi(left, right)
  const normalizedLeft = api.normalize(left)
  const normalizedRight = api.normalize(right)
  return api === path.win32
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

/** Truncate a display string by Unicode characters and keep the ellipsis inside the bound. */
export function truncateContext(value: string, maxLength: number): string {
  const characters = Array.from(value)
  if (characters.length <= maxLength) return value
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`
}

/**
 * Infer stable Project identity plus branch/worktree display context.
 *
 * Linked worktrees share the parent of Git's common directory, while a non-Git
 * directory falls back to its own basename. Only basenames and branch names are
 * returned; no absolute path can leave this function.
 */
export function inferInvocationContext(
  cwd: string,
  git: GitCommand = runGit,
): InvocationContext {
  const commonRaw = git(cwd, ['rev-parse', '--git-common-dir'])
  if (commonRaw === null || commonRaw === '') {
    return { project: projectSlugFrom(portableBasename(cwd)) }
  }

  const commonDir = resolveGitPath(cwd, commonRaw)
  const api = pathApi(cwd, commonDir)
  const gitDirRaw = git(cwd, ['rev-parse', '--git-dir'])
  const topLevelRaw = git(cwd, ['rev-parse', '--show-toplevel'])
  const linked =
    gitDirRaw !== null &&
    gitDirRaw !== '' &&
    !samePath(resolveGitPath(cwd, gitDirRaw), commonDir)

  // In an ordinary checkout the worktree root is the useful Project root. A
  // linked worktree needs its shared repository identity instead: standard Git
  // stores that in <main>/.git, while submodules and --separate-git-dir use a
  // named common directory whose basename is the only stable, path-free label.
  // Treating every common directory as `.git` would infer `modules` or `public`
  // for submodules — an implementation detail, not the repository's identity.
  const commonName = api.basename(commonDir)
  const projectName = linked
    ? commonName.toLowerCase() === '.git'
      ? api.basename(api.dirname(commonDir))
      : commonName
    : topLevelRaw !== null && topLevelRaw !== ''
      ? portableBasename(topLevelRaw)
      : commonName.toLowerCase() === '.git'
        ? api.basename(api.dirname(commonDir))
        : commonName
  const project = projectSlugFrom(projectName)

  const branchRaw = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch =
    branchRaw === null || branchRaw === '' || branchRaw === 'HEAD'
      ? undefined
      : truncateContext(branchRaw, 128)

  const worktree =
    linked && topLevelRaw !== null && topLevelRaw !== ''
      ? truncateContext(portableBasename(topLevelRaw), 64)
      : undefined

  return {
    project,
    ...(branch !== undefined ? { branch } : {}),
    ...(worktree !== undefined && worktree !== '' ? { worktree } : {}),
  }
}

export interface SourceContextInput {
  env: NodeJS.ProcessEnv
  invocation: InvocationContext
  sessionId?: string
  sessionLabel?: string
  activeHarness?: {
    harness: SourceContextHarness
    sessionId?: string
    sessionLabel?: string
    sessionLabelPending?: boolean
  }
  now?: number
}

export type SourceContextBuild =
  | { ok: true; source?: SourceContextT; generatedSessionLabel?: string }
  | { ok: false; error: string }

/** Resolve per-field Source Context precedence without fabricating Agent Session identity. */
export function buildSourceContext(input: SourceContextInput): SourceContextBuild {
  const sessionId =
    input.sessionId ?? input.env['NOTIFAI_SESSION_ID'] ?? input.activeHarness?.sessionId
  const explicitLabel = input.sessionLabel ?? input.env['NOTIFAI_SESSION_LABEL']
  if (explicitLabel !== undefined && (sessionId === undefined || sessionId === '')) {
    return {
      ok: false,
      error: '--session-label (or NOTIFAI_SESSION_LABEL) needs an exact Agent Session id.',
    }
  }
  if (sessionId === '') {
    return { ok: false, error: '--session-id must not be empty.' }
  }

  const activeOwnsSession =
    sessionId !== undefined && input.activeHarness?.sessionId === sessionId
  const harness = activeOwnsSession ? input.activeHarness?.harness : undefined
  const label =
    sessionId === undefined
      ? undefined
      : resolveSessionLabel({
          env: input.env,
          sessionId,
          ...(harness === undefined ? {} : { harness }),
          ...(explicitLabel === undefined ? {} : { explicitLabel }),
          ...(activeOwnsSession && input.activeHarness?.sessionLabel !== undefined
            ? { harnessLabel: input.activeHarness.sessionLabel }
            : {}),
          ...(activeOwnsSession && input.activeHarness?.sessionLabelPending === true
            ? { harnessLabelPending: true }
            : {}),
          ...(input.now === undefined ? {} : { now: input.now }),
        })
  if (label !== undefined && !label.ok) return label

  const source: SourceContextT = {
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(label !== undefined ? { session_label: label.label } : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(input.invocation.branch !== undefined ? { branch: input.invocation.branch } : {}),
    ...(input.invocation.worktree !== undefined ? { worktree: input.invocation.worktree } : {}),
  }
  return Object.keys(source).length === 0
    ? { ok: true }
    : {
        ok: true,
        source,
        ...(label !== undefined && label.ok && label.source === 'fallback'
          ? { generatedSessionLabel: label.label }
          : {}),
      }
}
