import { execFileSync } from 'node:child_process'
import path from 'node:path'

export type OrcaSessionTitleLookup = (env: NodeJS.ProcessEnv) => string | undefined
export type OrcaCommand = (executable: string, args: readonly string[]) => string | null

const runOrcaCommand: OrcaCommand = (executable, args) => {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    }).trim()
  } catch {
    return null
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
}

function worktreePathFromId(value: string): string | null {
  if (value.length === 0 || value.length > 4_096 || containsControlCharacter(value)) return null
  const separator = value.indexOf('::')
  if (separator <= 0) return null
  const repoId = value.slice(0, separator)
  const worktreePath = value.slice(separator + 2)
  if (!/^[A-Za-z0-9._-]+$/u.test(repoId) || worktreePath.length === 0) return null
  return path.posix.isAbsolute(worktreePath) || path.win32.isAbsolute(worktreePath)
    ? worktreePath
    : null
}

function opaqueSelector(value: string | undefined): string | null {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 1_024 ||
    containsControlCharacter(value)
  ) {
    return null
  }
  return value
}

function orcaExecutable(env: NodeJS.ProcessEnv): string | null {
  const configured = env['ORCA_CLI_COMMAND']?.trim()
  if (configured !== undefined && configured.length > 0) {
    return containsControlCharacter(configured) ? null : configured
  }
  return env['ORCA_DEV_REPO_ROOT'] === undefined ? 'orca' : 'orca-dev'
}

/**
 * Read the User-facing task name assigned to this exact Orca Agent Session.
 *
 * The environment contributes only opaque selectors. Orca must return the
 * exact worktree id and path plus the exact pane before its task title becomes
 * trusted; Project, branch, path, worktree, and pane strings are never
 * promoted into an Agent Session label.
 */
export function readOrcaSessionTitle(
  env: NodeJS.ProcessEnv,
  command: OrcaCommand = runOrcaCommand,
): string | undefined {
  if (env['TERM_PROGRAM'] !== 'Orca') return undefined
  const worktreeId = env['ORCA_WORKTREE_ID']
  if (worktreeId === undefined) return undefined
  const expectedPath = worktreePathFromId(worktreeId)
  if (expectedPath === null) return undefined
  const paneKey = opaqueSelector(env['ORCA_PANE_KEY'])
  if (paneKey === null) return undefined
  const executable = orcaExecutable(env)
  if (executable === null) return undefined

  let output: string | null
  try {
    output = command(executable, ['worktree', 'ps', '--json'])
  } catch {
    return undefined
  }
  if (output === null || output === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const response = parsed as {
    ok?: unknown
    result?: {
      worktrees?: unknown
    }
  }
  if (response.ok !== true || !Array.isArray(response.result?.worktrees)) return undefined

  const worktrees = response.result.worktrees.filter(
    (candidate): candidate is { worktreeId: string; path: string; agents?: unknown } =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { worktreeId?: unknown }).worktreeId === worktreeId &&
      (candidate as { path?: unknown }).path === expectedPath,
  )
  if (worktrees.length !== 1 || !Array.isArray(worktrees[0]!.agents)) return undefined

  const agents = worktrees[0]!.agents.filter(
    (candidate): candidate is { paneKey: string; taskTitle?: unknown } =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { paneKey?: unknown }).paneKey === paneKey,
  )
  if (agents.length !== 1) return undefined
  const taskTitle = agents[0]!.taskTitle
  return typeof taskTitle === 'string' && taskTitle.trim().length > 0 ? taskTitle : undefined
}
