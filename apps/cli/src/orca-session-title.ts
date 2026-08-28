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

function orcaExecutable(env: NodeJS.ProcessEnv): string | null {
  const configured = env['ORCA_CLI_COMMAND']?.trim()
  if (configured !== undefined && configured.length > 0) {
    return containsControlCharacter(configured) ? null : configured
  }
  return env['ORCA_DEV_REPO_ROOT'] === undefined ? 'orca' : 'orca-dev'
}

/**
 * Read the User-facing task name assigned to this exact Orca worktree.
 *
 * The environment contributes only an opaque selector. Orca must return that
 * exact id and its matching path before its display name becomes trusted; no
 * path component or identifier is ever promoted into an Agent Session label.
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
  const executable = orcaExecutable(env)
  if (executable === null) return undefined

  let output: string | null
  try {
    output = command(executable, [
      'worktree',
      'show',
      '--worktree',
      `id:${worktreeId}`,
      '--json',
    ])
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
    result?: { worktree?: { id?: unknown; path?: unknown; displayName?: unknown } }
  }
  const worktree = response.result?.worktree
  if (
    response.ok !== true ||
    worktree?.id !== worktreeId ||
    worktree.path !== expectedPath ||
    typeof worktree.displayName !== 'string' ||
    worktree.displayName.trim().length === 0
  ) {
    return undefined
  }
  return worktree.displayName
}
