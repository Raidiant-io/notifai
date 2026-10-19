/**
 * The time each nested step of a hook process may spend.
 *
 * A harness kills a hook at the timeout its definition declares. A step inside
 * that hook with a longer ceiling of its own (a credential helper, a service
 * request, a lock wait, a detached hand-off) cannot finish its work; it only
 * holds the User's prompt until the harness gives up. Every budget here is
 * derived from the declared timeout of the generated definition, so the two
 * cannot drift apart. `install-hooks.test.ts` checks every generated hook
 * against this table.
 */
import { DEFAULT_TIMEOUT_MS } from './client.js'
import { DPAPI_TIMEOUT_MS } from './credentials.js'
import { FILE_LOCK_WAIT_MS } from './file-lock.js'
import { isHookInstallableHarness, type HookInstallableHarness } from './harnesses.js'
import { HOOK_EVENT_TABLE } from './hook-events.js'
import { CODEX_ATTEND_TIMEOUT_SECONDS, CODEX_INTERRUPT_TIMEOUT_SECONDS, stopHandlerIsDetached } from './install-hooks.js'
import { WINDOWS_DETACH_TIMEOUT_MS } from './launch-self.js'
import { NON_ROUTING_STOP_TIMEOUT_SECONDS, QUESTION_STOP_TIMEOUT_SECONDS } from './question-timing.js'

export interface HookStepBudgets {
  /** One OS credential-store helper run: Keychain `security`, DPAPI PowerShell, `secret-tool`. */
  credentialHelperMs: number
  /** One authenticated service request. */
  serviceRequestMs: number
  /** Waiting for the shared log lock. A hook that cannot wait appends unlocked. */
  logLockWaitMs: number
  /** The Windows launcher's synchronous hand-off to a detached process. */
  detachedLaunchMs: number
}

export type HookStep = keyof HookStepBudgets

/**
 * The explicit CLI and processes the harness does not time out (detached
 * owners, Claude Code's async attendant) keep each step's own ceiling.
 */
export const OWNER_STEP_BUDGETS: Readonly<HookStepBudgets> = Object.freeze({
  credentialHelperMs: DPAPI_TIMEOUT_MS,
  serviceRequestMs: DEFAULT_TIMEOUT_MS,
  logLockWaitMs: FILE_LOCK_WAIT_MS,
  detachedLaunchMs: WINDOWS_DETACH_TIMEOUT_MS,
})

/**
 * UserPromptSubmit can make two service calls in front of the User's prompt;
 * each keeps the slice it has always had.
 */
const SHORT_HOOK_REQUEST_MS = 4_000

/**
 * Internal events that run as detached owners, never under a harness timeout:
 * started by `launchSelf`, or by the OpenClaw Gateway service without the
 * plugin's child-process ceiling.
 */
const DETACHED_EVENTS: ReadonlySet<string> = new Set([
  'question-submission', 'question-settlement', 'openclaw-settlement', 'maintenance', 'retirement',
])

/**
 * The timeout, in seconds, that the generated definition for this event
 * declares, or null when the harness does not time the process out (detached
 * owners, Claude Code's async attendant, internal processes).
 *
 * `document` distinguishes the one event whose timeout differs by the harness
 * event it is attached to: Codex's attendant on `Interrupt`.
 */
export function hookTimeoutSeconds(
  event: string,
  harness: HookInstallableHarness | undefined,
  document?: string,
): number | null {
  if (DETACHED_EVENTS.has(event)) return null
  // The Session Attendant: Codex times it out, Claude Code backgrounds it and
  // the OpenClaw Gateway service owns it without a child timeout.
  if (event === 'attend') {
    if (harness !== 'codex') return null
    return document === 'Interrupt' ? CODEX_INTERRUPT_TIMEOUT_SECONDS : CODEX_ATTEND_TIMEOUT_SECONDS
  }
  // One plugin child-process ceiling bounds every other event the plugin runs.
  if (harness === 'opencode' || harness === 'openclaw') return NON_ROUTING_STOP_TIMEOUT_SECONDS
  if (event === 'stop') {
    // A command without a harness stamp came from a definition this build did
    // not write; its declared timeout is unknown, so it keeps owner budgets.
    if (harness === undefined) return null
    return stopHandlerIsDetached(harness) || harness === 'grok'
      ? QUESTION_STOP_TIMEOUT_SECONDS
      : NON_ROUTING_STOP_TIMEOUT_SECONDS
  }
  if (event === 'permission-request') return QUESTION_STOP_TIMEOUT_SECONDS
  const row = HOOK_EVENT_TABLE.find((candidate) => candidate.notifai === event)
  return row === undefined || row.timeoutSeconds <= 0 ? null : row.timeoutSeconds
}

/**
 * The budgets a hook process uses for its nested steps.
 *
 * A short hook spends at most a third of its declared timeout on any one step,
 * leaving the rest for process start, its own work and its output; it never
 * waits for the log lock. Long-lived owners keep the ordinary ceilings.
 */
export function hookStepBudgets(
  event: string,
  harness: HookInstallableHarness | undefined,
): HookStepBudgets {
  const timeout = hookTimeoutSeconds(event, harness)
  if (timeout === null) return { ...OWNER_STEP_BUDGETS }
  const share = Math.floor((timeout * 1000) / 3)
  if (Object.values(OWNER_STEP_BUDGETS).every((budget) => budget <= share)) return { ...OWNER_STEP_BUDGETS }
  return {
    credentialHelperMs: Math.min(OWNER_STEP_BUDGETS.credentialHelperMs, share),
    serviceRequestMs: Math.min(SHORT_HOOK_REQUEST_MS, share),
    logLockWaitMs: 0,
    detachedLaunchMs: Math.min(OWNER_STEP_BUDGETS.detachedLaunchMs, share),
  }
}

/**
 * The wall-clock allowance for a short hook's own work, measured from the
 * start of the hook command: its declared timeout less a margin for output and
 * exit. Null for processes the harness does not time out.
 */
export function hookWorkAllowanceMs(event: string, harness: HookInstallableHarness | undefined): number | null {
  const timeout = hookTimeoutSeconds(event, harness)
  if (timeout === null) return null
  const ms = timeout * 1000
  const share = Math.floor(ms / 3)
  if (Object.values(OWNER_STEP_BUDGETS).every((budget) => budget <= share)) return null
  return ms - Math.min(1_000, share)
}

/**
 * The nested steps one hook invocation can reach. Codex's `Interrupt`
 * attendant copy only records the turn's end; every other event is treated as
 * able to reach every step.
 */
export function hookSteps(event: string, document?: string): readonly HookStep[] {
  if (event === 'attend' && document === 'Interrupt') return ['logLockWaitMs']
  return ['credentialHelperMs', 'serviceRequestMs', 'logLockWaitMs', 'detachedLaunchMs']
}

/** The hook event and harness named on a `notifai hook <event>` command line, if any. */
export function hookInvocation(
  args: readonly string[],
): { event: string; harness: HookInstallableHarness | undefined } | null {
  if (args[0] !== 'hook' || args[1] === undefined) return null
  let harness: HookInstallableHarness | undefined
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!
    const value = arg === '--harness' ? args[index + 1] : arg.startsWith('--harness=') ? arg.slice('--harness='.length) : undefined
    if (value !== undefined && isHookInstallableHarness(value)) harness = value
  }
  return { event: args[1], harness }
}
