/** Canonical lifecycle event vocabulary shared by installation and execution. */
import { type HookInstallableHarness } from './harnesses.js'

/**
 * One harness-neutral table for the lifecycle events this CLI build serves.
 *
 * Builders, generated-plugin discovery lists, ownership regexes, and
 * `HOOK_EVENTS` all derive from this. Per-harness *shape* (async Stop,
 * Cursor `loop_limit`, OpenCode native joint names) stays at the adapter;
 * this table owns names, budgets, and which harnesses receive each event.
 *
 * Timeouts are seconds. Document Stop is not taken from `timeoutSeconds`:
 * Question Routing hosts use the full-window budget, and the Cursor `stop`
 * handler uses the non-routing blocking budget.
 */
export const HOOK_EVENT_TABLE = [
  {
    // Codex async question cards: registration before the card is displayed.
    notifai: 'pre-tool-use',
    document: 'PreToolUse',
    cursor: null,
    openclaw: false,
    opencodeDiscovery: false,
    timeoutSeconds: 10,
  },
  {
    notifai: 'post-compact',
    document: 'PostCompact',
    cursor: null,
    openclaw: false,
    opencodeDiscovery: false,
    timeoutSeconds: 5,
  },
  {
    notifai: 'post-tool-use',
    document: 'PostToolUse',
    cursor: null,
    openclaw: false,
    opencodeDiscovery: false,
    timeoutSeconds: 10,
  },
  {
    // Claude Code only, matched to its question picker; see `installsClaudePickerHooks`.
    notifai: 'permission-request',
    document: 'PermissionRequest',
    cursor: null,
    openclaw: false,
    opencodeDiscovery: false,
    timeoutSeconds: 0,
  },
  {
    notifai: 'session-start',
    document: 'SessionStart',
    cursor: 'sessionStart',
    openclaw: true,
    opencodeDiscovery: false,
    timeoutSeconds: 5,
  },
  {
    notifai: 'subagent-start',
    document: 'SubagentStart',
    cursor: null,
    openclaw: true,
    opencodeDiscovery: false,
    timeoutSeconds: 5,
  },
  {
    notifai: 'user-prompt-submit',
    document: 'UserPromptSubmit',
    cursor: 'beforeSubmitPrompt',
    openclaw: true,
    opencodeDiscovery: true,
    timeoutSeconds: 15,
  },
  {
    notifai: 'stop',
    document: 'Stop',
    cursor: 'stop',
    openclaw: true,
    opencodeDiscovery: true,
    timeoutSeconds: 5,
    cursorLoopLimit: 3,
  },
  {
    notifai: 'session-end',
    document: 'SessionEnd',
    cursor: 'sessionEnd',
    openclaw: true,
    opencodeDiscovery: true,
    timeoutSeconds: 3,
  },
  {
    // The Session Attendant. It is not one document event: it is installed
    // as a second, asynchronous handler on each of ATTEND_DOCUMENT_EVENTS.
    notifai: 'attend',
    document: null,
    cursor: null,
    openclaw: false,
    opencodeDiscovery: false,
    timeoutSeconds: 0,
  },
] as const

export type HookEvent = (typeof HOOK_EVENT_TABLE)[number]['notifai']

export const HOOK_EVENTS: readonly HookEvent[] = HOOK_EVENT_TABLE.map((row) => row.notifai)

/** Native Grok gates reuse the same session-scoped handlers. */
export const GROK_DOCUMENT_ALIASES = { SubagentStop: 'Stop', PostToolUseFailure: 'PostToolUse' } as const

/** Alternation of Notifai hook-event tokens for command ownership regexes. */
export const HOOK_EVENT_PATTERN = HOOK_EVENTS.join('|')

export const HOOK_EVENT_COMMAND_RE = new RegExp(` hook (${HOOK_EVENT_PATTERN})\\b`)

/**
 * OpenCode has no settings document, so discovery reconstructs the joints
 * the generated module reports as handlers. Session start/subagent start
 * arrive through `experimental.chat.system.transform` rather than this list.
 */
export const OPENCODE_EVENTS = HOOK_EVENT_TABLE.filter(
  (row): row is (typeof HOOK_EVENT_TABLE)[number] & { document: string } =>
    row.opencodeDiscovery && row.document !== null,
).map((row) => [row.document, row.notifai] as const)

export const OPENCLAW_EVENTS = HOOK_EVENT_TABLE.filter(
  (row): row is (typeof HOOK_EVENT_TABLE)[number] & { document: string } =>
    row.openclaw && row.document !== null,
).map((row) => [row.document, row.notifai] as const)

/**
 * Where the Session Attendant handler is installed: SessionStart starts it,
 * and UserPromptSubmit and Stop re-arm a session whose attendant died.
 */
export const ATTEND_DOCUMENT_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const

/**
 * The attend handler's events for one harness. Codex also needs Interrupt: an
 * interrupted Codex turn fires Interrupt instead of Stop, and the attendant
 * reads a Codex thread's activity from its own turn boundaries.
 */
export function attendDocumentEvents(harness: HookInstallableHarness | undefined): readonly string[] {
  return harness === 'codex' ? [...ATTEND_DOCUMENT_EVENTS, 'Interrupt'] : ATTEND_DOCUMENT_EVENTS
}

/**
 * Whether this build installs the Session Attendant for a harness, and with
 * it Codex's card handlers: Claude Code everywhere it publishes a session
 * descriptor and inbox, and Codex everywhere. On Windows a Codex hook's parent
 * is the PowerShell its command starts; the Codex process above it is proven
 * from the process table (`windowsCodexHookSource`).
 */
export function installsSessionAttendant(harness: HookInstallableHarness | undefined): boolean {
  return harness === 'claude-code' || harness === 'codex'
}

/** The one tool both Claude Code picker handlers are matched to. */
export const CLAUDE_PICKER_MATCHER = 'AskUserQuestion'

/**
 * Whether this build installs the two handlers that link a registered
 * question to Claude Code's question picker: `PermissionRequest`, which runs
 * while the picker is on screen, and `PostToolUse`, which runs once it has an
 * answer. Every platform: on Windows the picker's process is the one Claude
 * Code names for itself (`claudeHookSourcePid`), as for the attendant.
 */
export function installsClaudePickerHooks(harness: HookInstallableHarness | undefined): boolean {
  return harness === 'claude-code'
}

/** Lifecycle handlers one installed harness must carry in this CLI build. */
export function requiredHookEvents(harness: HookInstallableHarness): readonly HookEvent[] {
  if (harness === 'opencode' || harness === 'openclaw' || harness === 'hermes') return []
  return HOOK_EVENT_TABLE.filter((row) =>
    row.notifai === 'pre-tool-use'
      ? harness === 'codex' && installsSessionAttendant(harness)
      : row.notifai === 'post-compact'
      ? harness === 'grok'
      : row.notifai === 'subagent-start' && harness === 'grok'
      ? false
      : row.notifai === 'post-tool-use'
      ? harness === 'grok' || (harness === 'codex' && installsSessionAttendant(harness)) || installsClaudePickerHooks(harness)
      : row.notifai === 'permission-request'
      ? installsClaudePickerHooks(harness)
      : row.notifai === 'attend'
      ? installsSessionAttendant(harness)
      : harness === 'cursor'
        ? row.cursor !== null
        : row.document !== null,
  ).map((row) => row.notifai)
}
