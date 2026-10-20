/**
 * Which form Notifai's Claude Code hook definitions take on macOS and Linux.
 *
 * Exec form (`command` plus `args`) makes Claude Code spawn the handler with
 * no shell in between. A Claude Code that predates the `args` field ignores
 * it and runs the bare executable, so every Notifai hook would silently do
 * nothing. Exec form is therefore written only when the installed Claude
 * Code's version is known and supports it; otherwise shell form, which the
 * session child also accepts (it recognises Claude through a shell parent).
 */
import { spawnSync } from 'node:child_process'
import { compareVersions } from './version.js'
import { olderClaudeAttendantsAlive } from './claude-form-readers.js'

/**
 * The first Claude Code release with the hook `args` field. Source: Anthropic's
 * Claude Code changelog, section 2.1.139, "Added hook `args: string[]` field
 * (exec form) that spawns the command directly without a shell"
 * (https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md).
 */
export const CLAUDE_EXEC_FORM_MIN_VERSION = '2.1.139'

/** `claude --version` normally answers in about a tenth of a second. */
const PROBE_TIMEOUT_MS = 3_000

export type ClaudeHookFormName = 'exec' | 'shell'

export interface ClaudeHookForm {
  form: ClaudeHookFormName
  /** The installed Claude Code's version, or null when it could not be read. */
  version: string | null
  reason: 'version-supported' | 'version-below-floor' | 'version-unknown' | 'version-unknown-kept-exec' | 'older-attendants-running'
}

const probed = new Map<string, string | null>()

/**
 * The installed Claude Code's version, from a non-interactive
 * `claude --version` found on PATH the way the CLI runs `claude` elsewhere.
 * Read once per process and PATH. Null when it is missing, slow or unparseable.
 */
export function probeClaudeCodeVersion(
  env: NodeJS.ProcessEnv,
  run: (env: NodeJS.ProcessEnv) => string | null = runClaudeVersion,
): string | null {
  const key = env['PATH'] ?? ''
  if (run === runClaudeVersion && probed.has(key)) return probed.get(key)!
  const output = run(env)
  const version = output?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null
  if (run === runClaudeVersion) probed.set(key, version)
  return version
}

function runClaudeVersion(env: NodeJS.ProcessEnv): string | null {
  try {
    const result = spawnSync('claude', ['--version'], {
      env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    })
    return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : null
  } catch {
    return null
  }
}

/**
 * The form to write. A known version decides. An unknown version (no
 * `claude` on this PATH, a slow answer) writes shell form for a new
 * definition, but keeps an existing exec-form definition: it was written when
 * a supporting version was known, and an unreadable version is no evidence
 * of a downgrade, so an install from another environment never flips it back
 * and forth.
 */
export function claudeHookForm(version: string | null, currentlyExec = false, olderAttendants = 0): ClaudeHookForm {
  const decided = decideForm(version, currentlyExec)
  // Never move shell form to exec form under an attendant that reads only
  // shell form: it would withdraw from its session (see claude-form-readers).
  if (decided.form === 'exec' && !currentlyExec && olderAttendants > 0) return { form: 'shell', version, reason: 'older-attendants-running' }
  return decided
}

function decideForm(version: string | null, currentlyExec: boolean): ClaudeHookForm {
  if (version === null) {
    return currentlyExec
      ? { form: 'exec', version, reason: 'version-unknown-kept-exec' }
      : { form: 'shell', version, reason: 'version-unknown' }
  }
  const order = compareVersions(version, CLAUDE_EXEC_FORM_MIN_VERSION)
  if (order === 'before' || order === 'unparseable') return { form: 'shell', version, reason: 'version-below-floor' }
  return { form: 'exec', version, reason: 'version-supported' }
}

/** The decision for this machine: the probed version, or a test's. */
export function claudeHookFormFor(
  deps: { env: NodeJS.ProcessEnv; claudeCodeVersion?: () => string | null; hookPlatform?: NodeJS.Platform },
  currentlyExec = false,
): ClaudeHookForm {
  return claudeHookForm(deps.claudeCodeVersion !== undefined ? deps.claudeCodeVersion() : probeClaudeCodeVersion(deps.env), currentlyExec,
    currentlyExec ? 0 : olderClaudeAttendantsAlive(deps.env, deps.hookPlatform ?? process.platform))
}

/** Plain words for doctor. */
export function describeClaudeHookForm(decision: ClaudeHookForm): string {
  switch (decision.reason) {
    case 'version-supported':
      return `exec form: Claude Code ${decision.version} runs hooks without a shell (from ${CLAUDE_EXEC_FORM_MIN_VERSION})`
    case 'version-below-floor':
      return `shell form: Claude Code ${decision.version} is older than ${CLAUDE_EXEC_FORM_MIN_VERSION}, the first release with exec-form hooks`
    case 'version-unknown':
      return 'shell form: the Claude Code version could not be read (`claude --version` did not answer)'
    case 'version-unknown-kept-exec':
      return 'exec form, kept: the Claude Code version could not be read now, and exec form was written when a supporting version was known'
    case 'older-attendants-running':
      return `shell form, kept while an older Notifai still attends a Claude Code session; exec form follows once it hands that session over (Claude Code ${decision.version})`
  }
}
