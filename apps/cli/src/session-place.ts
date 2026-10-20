/**
 * Where a Claude Code conversation runs: its place, from the environment
 * Claude Code gives its hooks (and so the session child it starts).
 *
 * The place decides two things. Only the Claude desktop app pauses or evicts
 * a conversation it still lists, so only there can an end be the app's own
 * stop rather than the User's close. And a held answer or note is delivered
 * only to an interactive place: a scripted run (`claude -p`, an Agent SDK
 * script) that resumes the same conversation receives nothing and never
 * becomes the place the conversation is in.
 */

export type ClaudePlace =
  | 'terminal'
  | 'claude-desktop'
  | 'claude-ide'
  | 'claude-background'
  | 'orca-chat'
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
}

export function claudePlaceOf(signals: ClaudePlaceSignals): ClaudePlace {
  const entrypoint = signals.entrypoint
  if (entrypoint === undefined || entrypoint === null || entrypoint === '') return 'unreported'
  if (entrypoint === 'claude-desktop' || entrypoint === 'claude-desktop-3p') return 'claude-desktop'
  if (entrypoint === 'claude-vscode') return 'claude-ide'
  if (entrypoint === 'cli') return signals.sessionKind === 'bg' ? 'claude-background' : 'terminal'
  if (entrypoint.startsWith('sdk-')) return signals.orcaStructured === true ? 'orca-chat' : 'headless'
  return 'unknown'
}

/** Whether a held answer or note may be handed to a conversation in this place. */
export function placeReceives(place: ClaudePlace): boolean {
  return place !== 'headless' && place !== 'unknown'
}

/** The place signals in a hook's (or session child's) environment. */
export function claudePlaceSignals(env: NodeJS.ProcessEnv): ClaudePlaceSignals {
  return {
    entrypoint: env['CLAUDE_CODE_ENTRYPOINT'],
    sessionKind: env['CLAUDE_CODE_SESSION_KIND'] ?? null,
    orcaStructured: env['ORCA_STRUCTURED_SESSION'] === '1',
  }
}
