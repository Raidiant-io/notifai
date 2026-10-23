import {
  hermesClassicCliLocalInstance,
  type HermesClassicCliLocalInstance,
  type SourceContextHarness,
} from './harnesses.js'
import { codexSubagentRoot } from './codex-subagent.js'
import { readSessionIncarnation } from './hook-session-state.js'
import { OPENCODE_2_SHELL_MARKER, trustedOpencodeShellSession } from './opencode-shell-session.js'
import { processAncestry, type AncestorProcess } from './process-ancestry.js'

/**
 * Exact evidence that this shell command is running inside one supported
 * harness. Configuration-directory variables are deliberately absent: they
 * describe where a tool stores files, not which tool owns the current shell.
 * OpenCode's generated plugin supplies the Notifai-owned marker because its
 * plugin API exposes Agent Session identity but the ordinary environment does
 * not. OpenCode 2's plugin cannot name the session in a shell, so there the
 * marker says to read OpenCode's own `OPENCODE_SESSION_ID`, believed only for
 * a session the plugin recorded (`opencode-shell-session.ts`).
 *
 * Hermes contributes `HERMES_SESSION_ID` only — the durable Agent Session id
 * bridged into tool subprocesses. `HERMES_SESSION_KEY` is a gateway routing
 * key and must never be treated as Agent Session identity.
 */
export interface ActiveHarnessSession {
  harness: SourceContextHarness
  label: string
  sessionId?: string
  /** Exact surface/backend cell proven for this marker envelope. */
  integrationInstance?: HermesClassicCliLocalInstance
  /** Trusted human title published by this harness's managed adapter. */
  sessionLabel?: string
  /** The harness has only a temporary placeholder title so far. */
  sessionLabelPending?: boolean
  /**
   * Whether a delegated worker is asking. OpenCode: its plugin reported the
   * session as one; absent from a plugin too old to say, which hands back no
   * form. Codex: set only by `resolveAskingHarness`, for a subagent asking on
   * its root's behalf.
   */
  worker?: boolean
  /**
   * Codex subagent asking on its root's behalf: the root's start when this
   * shell was resolved. Registration rechecks it under the root's lock.
   */
  rootKey?: string
}

/**
 * Every harness marker present in this environment, in declared order.
 *
 * Order is only for diagnostic display. A harness exports its markers
 * into every process it starts, so a nested harness inherits its parent's
 * markers alongside its own and the environment alone cannot say which of them
 * owns this shell; `resolveActiveHarness` preserves that ambiguity.
 */
function harnessEnvCandidates(env: NodeJS.ProcessEnv): ActiveHarnessSession[] {
  const candidates: ActiveHarnessSession[] = []
  if (env['NOTIFAI_ACTIVE_HARNESS'] === 'opencode' && env['NOTIFAI_OPENCODE_PLUGIN'] === OPENCODE_2_SHELL_MARKER) {
    // OpenCode 2 names the session only in its own variable; see opencode-shell-session.ts.
    const trusted = trustedOpencodeShellSession(env, env['OPENCODE_SESSION_ID'], () => (callerChain ??= processAncestry()))
    candidates.push({ harness: 'opencode', label: 'OpenCode', ...(trusted === null ? {} : {
      sessionId: trusted.sessionId,
      worker: trusted.worker,
      ...(trusted.sessionLabel === undefined ? {} : { sessionLabel: trusted.sessionLabel }),
      ...(trusted.sessionLabelPending === true ? { sessionLabelPending: true } : {}),
    }) })
  } else if (env['NOTIFAI_ACTIVE_HARNESS'] === 'opencode') {
    const sessionId = env['NOTIFAI_ACTIVE_SESSION_ID']
    const sessionLabel = env['NOTIFAI_ACTIVE_SESSION_LABEL']
    const sessionLabelPending = env['NOTIFAI_ACTIVE_SESSION_LABEL_PENDING'] === '1'
    const worker = env['NOTIFAI_ACTIVE_SESSION_WORKER']
    candidates.push({
      harness: 'opencode',
      label: 'OpenCode',
      ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
      ...(sessionLabel === undefined || sessionLabel === '' ? {} : { sessionLabel }),
      ...(sessionLabelPending ? { sessionLabelPending: true } : {}),
      ...(worker === '0' ? { worker: false } : worker === '1' ? { worker: true } : {}),
    })
  }
  if (env['NOTIFAI_ACTIVE_HARNESS'] === 'openclaw') {
    const sessionId = env['NOTIFAI_ACTIVE_SESSION_ID']
    candidates.push({
      harness: 'openclaw',
      label: 'OpenClaw',
      ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    })
  }
  if (env['CLAUDECODE'] === '1') {
    const sessionId = env['CLAUDE_CODE_SESSION_ID']
    candidates.push({
      harness: 'claude-code',
      label: 'Claude Code',
      ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    })
  }
  const codexSession = env['CODEX_THREAD_ID']
  if (codexSession !== undefined && codexSession !== '') {
    candidates.push({ harness: 'codex', label: 'Codex', sessionId: codexSession })
  }
  if ((env['CURSOR_AGENT'] ?? '') !== '') candidates.push({ harness: 'cursor', label: 'Cursor' })
  const grokSession = env['GROK_SESSION_ID']?.trim()
  if (grokSession) candidates.push({ harness: 'grok', label: 'Grok', sessionId: grokSession })
  const hermesSession = env['HERMES_SESSION_ID']
  if (hermesSession !== undefined && hermesSession !== '') {
    const integrationInstance = hermesClassicCliLocalInstance(env)
    candidates.push({
      harness: 'hermes',
      label: 'Hermes',
      sessionId: hermesSession,
      ...(integrationInstance === null ? {} : { integrationInstance }),
    })
  }
  return candidates
}

/**
 * Whether a marker's session plausibly owns this process: its harness host
 * must be this process or one of its ancestors.
 *
 * Markers are inherited by everything a harness starts, including long-lived
 * processes that outlive the command: a tmux server or an editor started from
 * an agent's shell gives every shell opened in it the agent's markers, and an
 * `ask` from there would register on that session and put the answer into its
 * conversation. So a marker is believed only where the tree agrees:
 *
 * - Claude Code names its own process in `CLAUDE_PID`; it must be an
 *   ancestor. A dead or unrelated pid is no evidence at all.
 * - Codex names no process, so the host its hooks recorded for the thread must
 *   be an ancestor, or failing that some Codex process must be.
 *
 * Where nothing names a host (a build that exports no pid, a thread no hook
 * has recorded) or the tree cannot be read (Windows), the marker stands as
 * before: there is no evidence against it.
 */
export function markerInsideItsHost(
  candidate: ActiveHarnessSession,
  env: NodeJS.ProcessEnv,
  chain: readonly AncestorProcess[] | null,
  recordedHost: (sessionId: string) => number | undefined,
): boolean {
  if (chain === null) return true
  if (candidate.harness === 'claude-code') {
    const declared = Number(env['CLAUDE_PID'])
    if (!Number.isInteger(declared) || declared <= 0) return true
    return chain.some((ancestor) => ancestor.pid === declared)
  }
  if (candidate.harness === 'codex' && candidate.sessionId !== undefined) {
    const host = recordedHost(candidate.sessionId)
    if (host === undefined) return true
    return chain.some((ancestor) => ancestor.pid === host || ancestor.name.toLowerCase().startsWith('codex'))
  }
  return true
}

let callerChain: AncestorProcess[] | null | undefined

function recordedHarnessHost(env: NodeJS.ProcessEnv): (sessionId: string) => number | undefined {
  return (sessionId) => {
    try {
      return readSessionIncarnation(sessionId, env)?.harness_process?.pid
    } catch {
      return undefined
    }
  }
}

/** The markers whose session this process really runs inside. */
function verifiedCandidates(env: NodeJS.ProcessEnv): ActiveHarnessSession[] {
  const candidates = harnessEnvCandidates(env)
  if (!candidates.some((candidate) => candidate.harness === 'claude-code' || candidate.harness === 'codex')) return candidates
  callerChain ??= processAncestry()
  const host = recordedHarnessHost(env)
  return candidates.filter((candidate) => markerInsideItsHost(candidate, env, callerChain ?? null, host))
}

interface ActiveHarnessResolution {
  active: ActiveHarnessSession | null
  /**
   * Markers of harnesses that could equally own this shell. Lifecycle activity
   * cannot establish which inherited marker owns the invoking process.
   */
  contested: ActiveHarnessSession[]
}

/**
 * Environment markers identify an uncontested Agent Session. With several
 * inherited markers, neither lifecycle timestamps nor a directory pointer
 * proves which process owns this shell: a parent may resume while its child
 * still works, and activity can come from another concurrent invocation.
 * Keep that concrete ambiguity visible instead of routing to the latest writer.
 */
export function resolveActiveHarness(
  env: NodeJS.ProcessEnv,
  _cwd: string,
  _now: number,
): ActiveHarnessResolution {
  return resolution(verifiedCandidates(env))
}

/**
 * The Agent Session a question from this shell belongs to. As
 * `resolveActiveHarness`, except that a Codex subagent running inside its
 * root's live Codex process asks on the root's behalf (`codex-subagent.ts`):
 * its question registers there and its answer wakes the root, as a Claude Code
 * subagent's does. Only questions take the root's identity; everything else a
 * subagent runs keeps its own thread.
 */
export function resolveAskingHarness(
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: number,
  platform: NodeJS.Platform = process.platform,
): ActiveHarnessResolution {
  const resolved = resolveActiveHarness(env, cwd, now)
  if (resolved.active?.harness !== 'codex' || resolved.contested.length > 0) return resolved
  const chain = platform === process.platform ? callerChain ?? null : processAncestry(process.pid, platform)
  const root = codexSubagentRoot(env, chain)
  return root === null
    ? resolved
    : { active: { ...resolved.active, sessionId: root.rootSessionId, worker: true, rootKey: root.rootKey }, contested: [] }
}

/**
 * Every marker in the environment, inherited or not. Only for guards that
 * must err towards caution, such as not replacing package files while any
 * session these markers name still owes an answer; never for attribution.
 */
export function inheritedHarnessMarkers(env: NodeJS.ProcessEnv): ActiveHarnessResolution {
  return resolution(harnessEnvCandidates(env))
}

function resolution(candidates: ActiveHarnessSession[]): ActiveHarnessResolution {
  const first = candidates[0]
  if (first === undefined) return { active: null, contested: [] }
  return { active: first, contested: candidates.length > 1 ? candidates : [] }
}

/** Source Context must not attribute a request to a guessed Agent Session. */
export function sourceContextHarnessSession(
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: number,
): ActiveHarnessSession | null {
  const { active, contested } = resolveActiveHarness(env, cwd, now)
  if (contested.length > 1) return null
  if (active?.harness === 'hermes' && active.integrationInstance === undefined) return null
  return active
}

/**
 * The pid of the Claude Code session this hook belongs to.
 *
 * Claude exports `CLAUDE_PID` to its hooks, and that is the authoritative
 * answer. `process.ppid` agrees with it today — the hook command runs through
 * a shell, but the shell `exec`s, so this process's parent *is* the session
 * (probed against a live 2.1.228 session) — and it remains the fallback for a
 * harness build that stops exporting the variable.
 *
 * Preferring the explicit value costs a line and removes a silent failure: if
 * this ever resolved to a shell instead, no session descriptor would match, the
 * route could not prove own-child ownership, and every answer would degrade to
 * hold-for-next-turn with nothing reported as wrong.
 */
/**
 * The Claude Code process that ran this hook.
 *
 * The managed adapter reports its own parent. On POSIX that is Claude Code. On
 * Windows Claude Code runs hooks through a shell, so the adapter's parent is
 * that shell, and only the pid Claude Code names for itself is the session's.
 */
export function claudeHookSourcePid(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  const named = Number(env['CLAUDE_PID'])
  if (platform === 'win32' && Number.isInteger(named) && named > 0) return named
  const declared = Number(env['NOTIFAI_HOOK_SOURCE_PID'])
  if (Number.isInteger(declared) && declared > 0) return declared
  return Number.isInteger(named) && named > 0 ? named : undefined
}

export function claudeSessionPid(env: NodeJS.ProcessEnv): number {
  const declared = Number(env['CLAUDE_PID'])
  return Number.isInteger(declared) && declared > 0 ? declared : process.ppid
}
