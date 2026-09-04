import {
  hermesClassicCliLocalInstance,
  type HermesClassicCliLocalInstance,
  type SourceContextHarness,
} from './harnesses.js'

/**
 * Exact evidence that this shell command is running inside one supported
 * harness. Configuration-directory variables are deliberately absent: they
 * describe where a tool stores files, not which tool owns the current shell.
 * OpenCode's generated plugin supplies the Notifai-owned marker because its
 * plugin API exposes Agent Session identity but the ordinary environment does not.
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
  if (env['NOTIFAI_ACTIVE_HARNESS'] === 'opencode') {
    const sessionId = env['NOTIFAI_ACTIVE_SESSION_ID']
    const sessionLabel = env['NOTIFAI_ACTIVE_SESSION_LABEL']
    const sessionLabelPending = env['NOTIFAI_ACTIVE_SESSION_LABEL_PENDING'] === '1'
    candidates.push({
      harness: 'opencode',
      label: 'OpenCode',
      ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
      ...(sessionLabel === undefined || sessionLabel === '' ? {} : { sessionLabel }),
      ...(sessionLabelPending ? { sessionLabelPending: true } : {}),
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
  const candidates = harnessEnvCandidates(env)
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
export function claudeSessionPid(env: NodeJS.ProcessEnv): number {
  const declared = Number(env['CLAUDE_PID'])
  return Number.isInteger(declared) && declared > 0 ? declared : process.ppid
}
