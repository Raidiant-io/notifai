import path from 'node:path'
import { type SourceContextT } from '@raidiant/notifai-protocol'
import type { SourceContextHarness } from './harnesses.js'
import { gitQuery } from './git-query.js'
import { resolveSessionLabel } from './session-labels.js'
import { projectSlugFrom } from './project-name.js'
export { projectSlugFrom } from './project-name.js'

export type GitCommand = (cwd: string, args: readonly string[]) => string | null

const runGit: GitCommand = (cwd, args) => gitQuery(cwd, args)

/** The useful, privacy-safe context inferred from one invocation directory. */
export interface InvocationContext {
  project: string | null
  branch?: string
  worktree?: string
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
 * Linked worktrees share the parent of Git's common directory. A non-Git
 * directory has no inferred Project. Only basenames and branch names are
 * returned; no absolute path can leave this function.
 */
export function inferInvocationContext(
  cwd: string,
  git: GitCommand = runGit,
  /** Project identity alone needs no branch, and asks Git one question fewer. */
  include: { branch: boolean } = { branch: true },
): InvocationContext {
  const commonRaw = git(cwd, ['rev-parse', '--git-common-dir'])
  if (commonRaw === null || commonRaw === '') {
    return { project: null }
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

  const branchRaw = include.branch ? git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) : null
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
  | {
      ok: true
      source?: SourceContextT
      generatedSessionLabel?: string
      unchangedSessionLabel?: string
      rejectedSessionLabel?: { reason: string; label: string }
      /** A label given where no harness identifies the Agent Session: nothing to name, so it is set aside. */
      droppedSessionLabel?: true
    }
  | { ok: false; error: string }

/** Resolve per-field Source Context precedence without fabricating Agent Session identity. */
export function buildSourceContext(input: SourceContextInput): SourceContextBuild {
  const sessionId =
    input.sessionId ?? input.env['NOTIFAI_SESSION_ID'] ?? input.activeHarness?.sessionId
  const givenLabel = input.sessionLabel ?? input.env['NOTIFAI_SESSION_LABEL']
  // Agents cannot see whether their harness identifies the session, so they
  // always pass a label; where none is identified, it has nothing to name.
  const droppedLabel = givenLabel !== undefined && sessionId === undefined
  const explicitLabel = droppedLabel ? undefined : givenLabel
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
    ...(label !== undefined
      ? { session_label_source: label.source === 'fallback' ? 'fallback' : 'semantic' }
      : {}),
    ...(label?.previousSource === 'fallback'
      ? { session_label_previous_source: 'fallback' as const }
      : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(input.invocation.branch !== undefined ? { branch: input.invocation.branch } : {}),
    ...(input.invocation.worktree !== undefined ? { worktree: input.invocation.worktree } : {}),
  }
  const dropped = droppedLabel ? { droppedSessionLabel: true as const } : {}
  return Object.keys(source).length === 0
    ? { ok: true, ...dropped }
    : {
        ok: true,
        ...dropped,
        source,
        ...(label?.ignoredExplicitLabel === true
          ? { unchangedSessionLabel: label.label }
          : {}),
        ...(label?.rejectedExplicitLabel === undefined
          ? {}
          : { rejectedSessionLabel: { reason: label.rejectedExplicitLabel, label: label.label } }),
        ...(label !== undefined && label.ok && label.source === 'fallback'
          ? { generatedSessionLabel: label.label }
          : {}),
      }
}
