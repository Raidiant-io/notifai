/** Canonical lifecycle event vocabulary shared by installation and execution. */
import { type HookInstallableHarness } from './harnesses.js'
import { hookHostPlatform, type HookHostPlatform } from './hook-adapter.js'

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
    notifai: 'activation-stop',
    document: null,
    cursor: 'stop',
    openclaw: false,
    opencodeDiscovery: false,
    timeoutSeconds: 5,
    cursorLoopLimit: 1,
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
 * Whether this build installs the Session Attendant for a harness. Claude Code
 * only, and not on Windows, where it has no session descriptor or inbox
 * socket. Codex waits for its own proof of a resident managed hook.
 */
export function installsSessionAttendant(
  harness: HookInstallableHarness | undefined,
  platform?: NodeJS.Platform | HookHostPlatform,
): boolean {
  return harness === 'claude-code' && hookHostPlatform(platform) === 'posix'
}

/** Lifecycle handlers one installed harness must carry in this CLI build. */
export function requiredHookEvents(
  harness: HookInstallableHarness,
  platform?: NodeJS.Platform | HookHostPlatform,
): readonly HookEvent[] {
  if (harness === 'opencode' || harness === 'openclaw') return []
  return HOOK_EVENT_TABLE.filter((row) =>
    row.notifai === 'attend'
      ? installsSessionAttendant(harness, platform)
      : harness === 'cursor'
        ? row.cursor !== null
        : row.document !== null,
  ).map((row) => row.notifai)
}
