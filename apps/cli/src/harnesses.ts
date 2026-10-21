/** Every harness Notifai can name in Source Context when authoritatively known. */
export const SOURCE_CONTEXT_HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'openclaw',
  'hermes',
  'grok',
] as const

export type SourceContextHarness = (typeof SOURCE_CONTEXT_HARNESSES)[number]

/**
 * Harnesses whose lifecycle Notifai can install and manage.
 *
 * Source Context is the broader vocabulary. Managed hook installation is a
 * narrower, independently proven cell. Hermes owns a native prompt plugin; its
 * Question Routing is proven only for the attended local classic CLI
 * (`HERMES_CLASSIC_CLI_LOCAL_CAPABILITY`).
 */
export const HOOK_INSTALLABLE_HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'openclaw',
  'hermes',
  'grok',
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
  grok: 'Grok',
}

export type DeliveryRoute =
  | 'hook-continuation'
  | 'inbox-socket'
  | 'session-queue'
  | 'owned-control-plane'
  | 'hold-for-next-turn'
  | 'unsupported'

export type StopContinuation = 'decision-block' | 'gateway-service' | 'plugin-attendant' | 'unsupported'

export interface HarnessCapability {
  /** How an answer is admitted to another turn in the already-open session. */
  stopContinuation: StopContinuation
  /** Available answer-delivery routes, best current route first. */
  deliveryRoutes: readonly DeliveryRoute[]
  /** Concise, honest readiness text for doctor and installation guidance. */
  deliveryContract: string
  /** Whether this integration can queue Session Notes and post-consumption Answer Edits. */
  sessionMessages?: 'gateway-service' | 'unsupported'
}

const CLAUDE_CODE_CAPABILITY: HarnessCapability = {
  stopContinuation: 'decision-block',
  deliveryRoutes: ['hook-continuation', 'inbox-socket', 'hold-for-next-turn'],
  deliveryContract:
    "the Stop hook returns at once and waits out of band through the complete answer window, then posts the answer into this same open session over its own inbox socket, whether it is idle or busy; open in several places, the most recently opened receives; closing the session ends its questions, while the desktop app pausing it, an Orca chat idling it out, Orca losing its pane's terminal or the machine shutting down keeps them and the answer arrives when it comes back",
}

const CODEX_CAPABILITY: HarnessCapability = {
  stopContinuation: 'decision-block',
  deliveryRoutes: ['session-queue', 'hold-for-next-turn'],
  deliveryContract:
    "the Stop hook returns at once and waits out of band through the complete answer window, then queues the answer into this same thread's durable inbox; an idle session consumes it within seconds and a busy one at its next turn boundary; closing the session ends its questions, while its app unloading or idling it out, Orca losing its pane's terminal or the machine shutting down keeps them and the answer waits in the thread until it comes back",
}

/**
 * Cursor activation ceilings (see `cursor-activation-rule.ts`): SessionStart
 * context reaches the editor, the Agents Window and `cursor-agent`; the
 * always-applied rule reaches the editor, the Agents Window and Cursor SDK
 * hosts that load the `user` setting source. An SDK host without that source,
 * an ACP host (no lifecycle hooks) and a cloud agent (no machine
 * configuration) receive neither.
 */
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
    "OpenCode's own question form reaches the User's devices while its turn waits and settles from either side; there is no proven answer continuation after session.idle, so use the question form or a blocking reply command; closing the session ends its questions",
}

const OPENCLAW_CAPABILITY: HarnessCapability = {
  stopContinuation: 'gateway-service',
  deliveryRoutes: ['session-queue'],
  deliveryContract:
    'the Gateway service owns the complete answer window and queues a pointer-only follow-up into the exact current session after claiming the answer; the agent fetches the reply and acknowledges it in that session',
  sessionMessages: 'gateway-service',
}

const OPENCLAW_UNPROVEN_PLATFORM_CAPABILITY: HarnessCapability = {
  stopContinuation: 'unsupported',
  deliveryRoutes: ['unsupported'],
  deliveryContract:
    'OpenClaw asynchronous answer continuation is verified on macOS only; use a blocking reply command on this host',
  sessionMessages: 'unsupported',
}

const GROK_CAPABILITY: HarnessCapability = {
  stopContinuation: 'decision-block',
  deliveryRoutes: ['session-queue', 'hook-continuation', 'hold-for-next-turn'],
  deliveryContract:
    'the Stop hook waits for the answer; an exact shared-leader session receives a claimed interjection, otherwise a native decision block continues the same session within Grok\'s per-turn continuation limit; closing the session ends its questions',
}

export const HERMES_CLASSIC_CLI_QUESTION_CAPABILITY: HarnessCapability = {
  stopContinuation: 'plugin-attendant',
  deliveryRoutes: ['session-queue'],
  deliveryContract:
    'the live classic CLI plugin owns the complete answer window and admits the claimed answer as the next input of that exact session through Hermes\'s public plugin API; closing the session ends its questions',
}

export const HERMES_QUESTION_ROUTING_UNAVAILABLE: HarnessCapability = {
  stopContinuation: 'unsupported',
  deliveryRoutes: ['unsupported'],
  deliveryContract: 'Hermes Question Routing is available only in an attended local classic CLI session; use a blocking `notifai send --reply` question on other Hermes surfaces',
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
  setup: 'hermes-plugin',
  activation: 'project-enabled-system-prompt-section',
  sourceContext: 'hermes-session-id-and-invocation-cwd',
  continuation: 'plugin-attendant-exact-session-injection',
  sessionPresence: 'plugin-owned-attendant',
  sessionMessages: 'in-process-exact-session-injection',
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
 * Hermes Question Routing is scoped to its proved local classic CLI instance.
 */
export const HARNESS_CAPABILITIES: Record<HookInstallableHarness, HarnessCapability> = {
  'claude-code': CLAUDE_CODE_CAPABILITY,
  codex: CODEX_CAPABILITY,
  cursor: CURSOR_CAPABILITY,
  opencode: OPENCODE_CAPABILITY,
  openclaw: OPENCLAW_CAPABILITY,
  hermes: HERMES_CLASSIC_CLI_QUESTION_CAPABILITY,
  grok: GROK_CAPABILITY,
}

/** Question-routing capability for the active harness integration on this host. */
export function questionRoutingCapability(
  harness: HookInstallableHarness,
  platform: NodeJS.Platform = process.platform,
): HarnessCapability {
  if (harness === 'hermes' && platform !== 'darwin' && platform !== 'linux') {
    return HERMES_QUESTION_ROUTING_UNAVAILABLE
  }
  if (harness === 'openclaw' && platform !== 'darwin') {
    return OPENCLAW_UNPROVEN_PLATFORM_CAPABILITY
  }
  return HARNESS_CAPABILITIES[harness]
}
