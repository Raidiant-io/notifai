/** Every harness Notifai can name in Source Context when authoritatively known. */
export const SOURCE_CONTEXT_HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'openclaw',
  'hermes',
] as const

export type SourceContextHarness = (typeof SOURCE_CONTEXT_HARNESSES)[number]

/**
 * Harnesses whose lifecycle Notifai can install and manage.
 *
 * Source Context is the broader vocabulary. Managed hook installation is a
 * narrower, independently proven cell: Hermes can appear in Source Context
 * without being hook-installable.
 */
export const HOOK_INSTALLABLE_HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'openclaw',
] as const

export type HookInstallableHarness = (typeof HOOK_INSTALLABLE_HARNESSES)[number]

export function isHookInstallableHarness(value: string): value is HookInstallableHarness {
  return (HOOK_INSTALLABLE_HARNESSES as readonly string[]).includes(value)
}

export const HARNESS_LABELS: Record<SourceContextHarness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
}

export type DeliveryRoute =
  | 'hook-continuation'
  | 'inbox-socket'
  | 'owned-control-plane'
  | 'cold-resume'
  | 'hold-for-next-turn'
  | 'unsupported'

export type StopContinuation = 'decision-block' | 'unsupported'

export interface HarnessCapability {
  /** How an answer is admitted to another turn in the already-open session. */
  stopContinuation: StopContinuation
  /** Available answer-delivery routes, best current route first. */
  deliveryRoutes: readonly DeliveryRoute[]
  /** Concise, honest readiness text for doctor and installation guidance. */
  deliveryContract: string
}

const CLAUDE_CODE_CAPABILITY: HarnessCapability = {
  stopContinuation: 'decision-block',
  deliveryRoutes: ['hook-continuation', 'inbox-socket', 'cold-resume', 'hold-for-next-turn'],
  deliveryContract:
    'the Stop hook returns at once and waits out of band through the complete answer window, then posts the answer into this same session over its own inbox socket; a session that has stopped is resumed only once a liveness probe proves it stopped',
}

const CODEX_CAPABILITY: HarnessCapability = {
  stopContinuation: 'decision-block',
  deliveryRoutes: ['hook-continuation', 'cold-resume', 'hold-for-next-turn'],
  deliveryContract:
    'live Stop continuation while the turn is held through the complete answer window; crash recovery may resume only a stopped thread behind its writer lock',
}

const CURSOR_CAPABILITY: HarnessCapability = {
  stopContinuation: 'unsupported',
  deliveryRoutes: ['unsupported'],
  deliveryContract:
    'the hook can return a live follow-up, but the invoking shell exposes no exact conversation id; asynchronous ask is unsupported',
}

const OPENCODE_CAPABILITY: HarnessCapability = {
  stopContinuation: 'unsupported',
  deliveryRoutes: ['unsupported'],
  deliveryContract:
    'no proven answer continuation after session.idle; use a blocking reply command',
}

const OPENCLAW_CAPABILITY: HarnessCapability = {
  stopContinuation: 'unsupported',
  deliveryRoutes: ['unsupported'],
  deliveryContract:
    'no proven answer continuation after agent_end; use a blocking reply command',
}

export const HERMES_QUESTION_ROUTING_UNAVAILABLE: HarnessCapability = {
  stopContinuation: 'unsupported',
  deliveryRoutes: ['unsupported'],
  deliveryContract:
    'Hermes asynchronous ask has no proven continuation owner on this integration surface. Use a blocking `notifai send --reply` question',
}

/**
 * The one Hermes integration instance proven by the pinned vertical probe.
 *
 * This is evidence-bearing capability data, not an adapter. Unsupported and
 * deferred surfaces intentionally have no empty implementation object here.
 */
export const HERMES_CLASSIC_CLI_LOCAL_CAPABILITY = {
  instance: {
    harness: 'hermes',
    surface: 'classic-cli',
    terminalBackend: 'local',
  },
  setup: 'unsupported',
  activation: 'unsupported',
  sourceContext: 'hermes-session-id-and-invocation-cwd',
  continuation: 'unsupported',
} as const

export type HermesClassicCliLocalInstance =
  (typeof HERMES_CLASSIC_CLI_LOCAL_CAPABILITY)['instance']

/**
 * Resolve only the Hermes instance whose complete marker envelope was proven.
 *
 * `HERMES_SESSION_ID` is also bridged by deferred gateway, TUI, API, ACP, and
 * remote-backend paths. Their first-party routing/source/backend markers keep
 * those cells distinct. Missing source/backend values are the pinned classic
 * CLI defaults; a gateway key is never part of that instance.
 */
export function hermesClassicCliLocalInstance(
  env: NodeJS.ProcessEnv,
): HermesClassicCliLocalInstance | null {
  const sessionId = (env['HERMES_SESSION_ID'] ?? '').trim()
  const sessionKey = (env['HERMES_SESSION_KEY'] ?? '').trim()
  const platform = (env['HERMES_SESSION_PLATFORM'] ?? '').trim().toLowerCase()
  const source = (env['HERMES_SESSION_SOURCE'] ?? '').trim().toLowerCase()
  const terminalBackend = (env['TERMINAL_ENV'] ?? '').trim().toLowerCase()
  if (sessionId === '' || sessionKey !== '' || platform !== '') return null
  if (source !== '' && source !== 'cli') return null
  if (terminalBackend !== '' && terminalBackend !== 'local') return null
  return HERMES_CLASSIC_CLI_LOCAL_CAPABILITY.instance
}

/**
 * Question-routing contract for hook-installable harnesses.
 *
 * Hermes is deliberately absent: a send-only surface must not occupy this
 * table with a fake managed-hook continuation route.
 */
export const HARNESS_CAPABILITIES: Record<HookInstallableHarness, HarnessCapability> = {
  'claude-code': CLAUDE_CODE_CAPABILITY,
  codex: CODEX_CAPABILITY,
  cursor: CURSOR_CAPABILITY,
  opencode: OPENCODE_CAPABILITY,
  openclaw: OPENCLAW_CAPABILITY,
}

/** Question-routing capability for the active harness integration. */
export function questionRoutingCapability(harness: HookInstallableHarness): HarnessCapability {
  return HARNESS_CAPABILITIES[harness]
}
