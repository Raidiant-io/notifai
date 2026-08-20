import { readLiveProjectSessionPointers } from './hooks.js'
import { type Harness } from './install-hooks.js'

/**
 * Exact evidence that this shell command is running inside one supported
 * harness. Configuration-directory variables are deliberately absent: they
 * describe where a tool stores files, not which tool owns the current shell.
 * OpenCode's generated plugin supplies the Notifai-owned marker because its
 * plugin API exposes session identity but the ordinary environment does not.
 */
export interface ActiveHarnessSession {
  harness: Harness
  label: string
  sessionId?: string
  /** Trusted human title published by this harness's managed adapter. */
  sessionLabel?: string
  /** The harness has only a temporary placeholder title so far. */
  sessionLabelPending?: boolean
}

/**
 * Every harness marker present in this environment, in declared order.
 *
 * Order here is a last resort, not an answer. A harness exports its markers
 * into every process it starts, so a nested harness inherits its parent's
 * markers alongside its own and the environment alone cannot say which of them
 * owns this shell; `resolveActiveHarness` settles that with live evidence.
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
  return candidates
}

interface ActiveHarnessResolution {
  active: ActiveHarnessSession | null
  /**
   * Markers of harnesses that could equally own this shell, present only when
   * nothing here has fired yet and declared order had to pick. Whatever is
   * reported then has to hold for every one of them.
   */
  contested: ActiveHarnessSession[]
}

/**
 * Which harness session owns this shell, when several claim to.
 *
 * Nesting is ordinary: an orchestrator running inside Claude Code starts a
 * Codex session, and that Codex process inherits `CLAUDECODE` and
 * `CLAUDE_CODE_SESSION_ID` on top of its own `CODEX_THREAD_ID`. The mirror is
 * just as ordinary, so no fixed precedence between two markers can be right —
 * whichever one it favours is wrong in the opposite nesting, and the cost is
 * silent: `ask` looks up a session that is not this one, and every remedy the
 * agent is told to try addresses a harness that is not running here.
 *
 * The general rule is to prefer the most specific *live* signal over inherited
 * environment. An inherited marker is a claim about some ancestor process; a
 * session id that names an entry in this directory's live pointer index is
 * evidence that that exact session fired a hook here and its state still
 * exists. Live evidence therefore wins over declared order, and the most
 * recently active pointer wins between two live candidates: the harness whose
 * turn is running is the one that fired last, while its parent sits blocked on
 * the child it started. Declared order decides only when nothing here has
 * fired yet, and it says so — every route fails closed there anyway.
 */
export function resolveActiveHarness(
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: number,
): ActiveHarnessResolution {
  const candidates = harnessEnvCandidates(env)
  const first = candidates[0]
  if (first === undefined) return { active: null, contested: [] }
  if (candidates.length === 1) return { active: first, contested: [] }
  for (const pointer of readLiveProjectSessionPointers(cwd, env, now)) {
    const owner = candidates.find(
      (candidate) =>
        candidate.harness === pointer.harness && candidate.sessionId === pointer.sessionId,
    )
    if (owner !== undefined) return { active: owner, contested: [] }
  }
  return { active: first, contested: candidates }
}

export function activeHarnessSession(
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: number,
): ActiveHarnessSession | null {
  return resolveActiveHarness(env, cwd, now).active
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
