/**
 * `git rev-parse` queries, as one hook asks them.
 *
 * Project identity comes from Git, and one hook asks Git the same few
 * questions several times (each configuration load infers the Project
 * again). In a runtime that is one short-lived process per hook, and each
 * question is a `git` process. When the hub runs a hook (see `hub-ingress.ts`)
 * it runs it inside a hook scope (`hook-scope.ts`), which gives these queries:
 * - the hook's own environment, as a runtime started for that hook would have;
 * - one answer per question for the whole hook, as if Git were asked once;
 * - the hub's earlier answer to a repository-identity question, but only
 *   while every `.git` entry Git's discovery would look at is unchanged.
 * Outside a hook scope nothing changes: the question goes to Git.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { hookScopeEnv, oncePerHook } from './hook-scope.js'

/** Questions whose answer depends only on where the repository is, never on what is checked out. */
const IDENTITY_QUESTIONS: ReadonlySet<string> = new Set(['--git-common-dir', '--git-dir', '--show-toplevel'])
/** A shared identity answer is asked again at least this often, whatever the checks say. */
const SHARED_IDENTITY_MS = 30_000
const SHARED_IDENTITY_LIMIT = 256

let sharedIdentity: Map<string, { answer: string | null; evidence: string; at: number }> | null = null

/** The hub keeps repository-identity answers across the hooks it runs. */
export function shareGitIdentityAnswers(): void {
  sharedIdentity ??= new Map()
}

/** `git -C <cwd> <args>`, trimmed; null when Git fails or is missing. */
export function gitQuery(cwd: string, args: readonly string[]): string | null {
  const env = hookScopeEnv()
  if (env === undefined) return runGit(cwd, args, undefined)
  const key = `${cwd}\0${args.join('\0')}`
  return oncePerHook(`git\0${key}`, () => sharedOrAsked(cwd, args, key, env))
}

function sharedOrAsked(cwd: string, args: readonly string[], key: string, env: NodeJS.ProcessEnv): string | null {
  const shareable = sharedIdentity !== null && args.length === 2 && args[0] === 'rev-parse' && IDENTITY_QUESTIONS.has(args[1]!)
  let answer: string | null
  if (shareable) {
    const sharedKey = `${key}\0${gitEnvironmentKey(env)}`
    const evidence = discoveryEvidence(cwd)
    const known = sharedIdentity!.get(sharedKey)
    if (known !== undefined && evidence !== null && known.evidence === evidence && Date.now() - known.at < SHARED_IDENTITY_MS) {
      answer = known.answer
    } else {
      answer = runGit(cwd, args, env)
      sharedIdentity!.delete(sharedKey)
      if (evidence !== null) {
        if (sharedIdentity!.size >= SHARED_IDENTITY_LIMIT) sharedIdentity!.clear()
        sharedIdentity!.set(sharedKey, { answer, evidence, at: Date.now() })
      }
    }
  } else {
    answer = runGit(cwd, args, env)
  }
  return answer
}

function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      windowsHide: true,
      ...(env === undefined ? {} : { env }),
    }).trim()
  } catch {
    return null
  }
}

/** Everything in the environment Git reads to find a repository or to trust it. */
function gitEnvironmentKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).filter((name) => name.startsWith('GIT_') || name === 'HOME' || name === 'XDG_CONFIG_HOME' || name === 'PATH')
    .sort().map((name) => `${name}=${env[name]}`).join('\0')
}

/**
 * What Git's repository discovery from `cwd` would look at: the directory
 * itself, and each `.git` entry from it upwards to the first that exists.
 * Null when that cannot be read (the answer is then never shared).
 */
function discoveryEvidence(cwd: string): string | null {
  try {
    const start = path.resolve(cwd)
    const self = lstatSync(start, { bigint: true })
    const parts = [`${self.dev}:${self.ino}`]
    for (let directory = start; ; directory = path.dirname(directory)) {
      let entry
      try { entry = lstatSync(path.join(directory, '.git'), { bigint: true }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') return null
        entry = null
      }
      if (entry !== null) {
        parts.push(`${directory}:${entry.dev}:${entry.ino}:${entry.mode}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`)
        break
      }
      parts.push(`${directory}:-`)
      if (path.dirname(directory) === directory) break
    }
    return parts.join('|')
  } catch {
    return null
  }
}
