import { execFileSync } from 'node:child_process'
import { processStartTime, type ProcessIdentity } from './process-identity.js'

/**
 * Where a conversation runs: its place. For Claude Code, from the environment
 * Claude Code gives its hooks (and so the session child it starts); for
 * Codex, from the process that hosts the thread and the environment its app
 * gives it.
 *
 * The place decides two things. Only an app stops a conversation it still
 * lists (the Claude desktop app pausing it, the Codex app unloading it, an
 * Orca chat or T3 Code idling it out), so only there can an end be the app's
 * own stop rather than the User's close. And a held answer or note is
 * delivered only to an interactive place: a scripted run (`claude -p`, an
 * Agent SDK script, `codex exec`) that resumes the same conversation receives
 * nothing and never becomes the place the conversation is in.
 */

export type ClaudePlace =
  | 'terminal'
  | 'claude-desktop'
  | 'claude-ide'
  | 'claude-background'
  | 'orca-chat'
  | 't3'
  | 'headless'
  /** An entrypoint this build does not know. */
  | 'unknown'
  /** No entrypoint reported (a session child from an earlier build, or none set): treated as interactive, as before. */
  | 'unreported'

export interface ClaudePlaceSignals {
  /** `CLAUDE_CODE_ENTRYPOINT`; absent or empty when not reported. */
  entrypoint?: string | null | undefined
  /** `CLAUDE_CODE_SESSION_KIND` (`bg` for a background session). */
  sessionKind?: string | null | undefined
  /** `ORCA_STRUCTURED_SESSION=1`: an Orca chat tab drives this SDK session. */
  orcaStructured?: boolean | undefined
  /** Direct host process, never a shell ancestor. */
  hostName?: string | null | undefined
}

export function claudePlaceOf(signals: ClaudePlaceSignals): ClaudePlace {
  const entrypoint = signals.entrypoint
  if (entrypoint === undefined || entrypoint === null || entrypoint === '') return 'unreported'
  if (entrypoint === 'claude-desktop' || entrypoint === 'claude-desktop-3p') return 'claude-desktop'
  if (entrypoint === 'claude-vscode') return 'claude-ide'
  if (entrypoint === 'cli') return signals.sessionKind === 'bg' ? 'claude-background' : 'terminal'
  if (entrypoint.startsWith('sdk-') && /^T3 Code(?: \(Nightly\))?(?:\.exe)?$/.test(signals.hostName ?? '')) return 't3'
  if (entrypoint.startsWith('sdk-')) return signals.orcaStructured === true ? 'orca-chat' : 'headless'
  return 'unknown'
}

/** Where a Codex thread runs. A terminal includes the shared background server plain `codex` terminals join. */
export type CodexPlace = 'terminal' | 'codex-app' | 'codex-ide' | 't3' | 'orca-chat' | 'headless' | 'unknown'

export type SessionPlace = ClaudePlace | CodexPlace

/**
 * What kind of process hosts a Codex thread (see `codexHostKind`):
 * - `app-server`: a server a client started for itself (the Codex app's, an
 *   IDE extension's, T3 Code's, an Orca chat's);
 * - `shared-server`: Codex's shared background server, which plain `codex`
 *   terminals join and which keeps a closed terminal's thread loaded;
 * - `exec`: a scripted `codex exec` run;
 * - `other`: anything else, such as a terminal hosting its own thread
 *   (`codex --no-daemon`).
 */
export type CodexHostKind = 'app-server' | 'shared-server' | 'exec' | 'other' | 'unknown'

export interface CodexPlaceSignals {
  hostKind: CodexHostKind
  /** `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`: T3 Code sets `T3 Code` on the app-server it starts. */
  originatorOverride?: string | null | undefined
  /** `ORCA_STRUCTURED_SESSION=1`: an Orca chat tab drives this app-server. */
  orcaStructured?: boolean | undefined
  /**
   * The thread's recorded originator. It names the surface the thread was
   * born in, so it only tells the Codex app's own server from an editor's;
   * the host decides the place.
   */
  originator?: string | null | undefined
}

export function codexPlaceOf(signals: CodexPlaceSignals): CodexPlace {
  if (signals.originatorOverride === 'T3 Code') return 't3'
  if (signals.orcaStructured === true) return 'orca-chat'
  switch (signals.hostKind) {
    case 'exec': return 'headless'
    case 'app-server': return signals.originator === 'codex_vscode' ? 'codex-ide' : 'codex-app'
    case 'other': case 'shared-server': return 'terminal'
    default: return 'unknown'
  }
}

/** Whether a held answer or note may be handed to a conversation in this place. */
export function placeReceives(place: SessionPlace): boolean {
  return place !== 'headless' && place !== 'unknown'
}

/** The place signals in a hook's (or session child's) environment. */
export function claudePlaceSignals(env: NodeJS.ProcessEnv, harnessPid?: number): ClaudePlaceSignals {
  return {
    entrypoint: env['CLAUDE_CODE_ENTRYPOINT'],
    hostName: harnessPid === undefined ? null : claudeHostName(harnessPid),
    sessionKind: env['CLAUDE_CODE_SESSION_KIND'] ?? null,
    orcaStructured: env['ORCA_STRUCTURED_SESSION'] === '1',
  }
}

/** How many processes up from the harness Orca's terminal host can be (pane → login → shell → harness). */
const ORCA_HOST_DEPTH = 6

function parentAndName(pid: number): { ppid: number; name: string } | null {
  try {
    const output = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000,
    }).trim()
    const matched = /^(\d+)\s+(.+)$/.exec(output)
    if (matched === null) return null
    const name = matched[2]!.trim()
    return { ppid: Number(matched[1]), name: name.slice(name.lastIndexOf('/') + 1) }
  } catch {
    return null
  }
}

/** Only the direct parent distinguishes an SDK UI from a script launched through its shell tool. */
export function claudeHostName(harnessPid: number): string | null {
  const own = parentAndName(harnessPid)
  return own === null ? null : parentAndName(own.ppid)?.name ?? null
}

/** The process that started this one, by pid and start time; null when it cannot be read. */
export function parentProcessOf(pid: number): ProcessIdentity | null {
  if (process.platform === 'win32') return null
  const own = parentAndName(pid)
  if (own === null || own.ppid <= 1) return null
  const start = processStartTime(own.ppid)
  return start === null ? null : { pid: own.ppid, start }
}

/**
 * The Orca terminal host above a harness in an Orca pane (`orca-terminal-host`
 * → `login` → shell → harness), by pid and start time; null when there is
 * none within a few processes up, or it cannot be read. Linux shortens the
 * process name to 15 characters.
 */
export function orcaTerminalHostOf(harnessPid: number): ProcessIdentity | null {
  if (process.platform === 'win32') return null
  let pid = harnessPid
  for (let depth = 0; depth < ORCA_HOST_DEPTH; depth += 1) {
    const current = parentAndName(pid)
    if (current === null || current.ppid <= 1) return null
    const parent = parentAndName(current.ppid)
    if (parent === null) return null
    if (parent.name.startsWith('orca-terminal-h')) {
      const start = processStartTime(current.ppid)
      return start === null ? null : { pid: current.ppid, start }
    }
    pid = current.ppid
  }
  return null
}
