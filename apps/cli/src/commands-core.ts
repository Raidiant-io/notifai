import { SHIPPED_CLI_CAPABILITIES, type RecoveryAction } from '@raidiant/notifai-protocol'
import { type ClaudeWakeAdapters } from './claude-wake.js'
import {
  ApiCallError,
  NetworkError,
  createClient,
  type ApiClient,
  type ClientOptions,
} from './client.js'
import { type CodexWakeAdapters } from './codex-wake.js'
import { loadConfig, type CliConfig } from './config.js'
import type { CredentialStore, MachineCredential } from './credentials.js'
import { type HookAdapterTarget } from './hook-adapter.js'
import { logConfigResolved, logSettingsFrom, nullLogger, type Logger } from './logging.js'
import type { NativeSkills } from './native-skills.js'
import type { CodexSessionTitleLookup } from './harness-session-title.js'
import type { OrcaSessionTitleLookup } from './orca-session-title.js'
import type { QuestionSettlementLaunch } from './question-settlement-process.js'
import { packageVersion } from './release.js'
import type { Tone } from './ui/theme.js'
import { cliUpdateRecoveryCommand } from './cli-update-contract.js'

export interface CommandIo {
  out(line: string): void
  err(line: string): void
  /** Interactive confirmation; resolves `fallback` (default false) when not interactive. */
  confirm(question: string, fallback?: boolean): Promise<boolean>
  openUrl(url: string): void
  /**
   * True only when a human is demonstrably driving a terminal. Everything below
   * is optional sugar that MUST only be called behind this flag: an agent that
   * reaches an interactive prompt does not error, it hangs — the prompt
   * libraries wait on stdin for ever — so the gate is bypass, not handling.
   * Test fakes leave all of this undefined and exercise the plain paths.
   */
  interactive?: boolean
  select?(message: string, options: { value: string; label: string; hint?: string }[]): Promise<string | null>
  /** Interactive multi-select. `initial` are pre-selected values. */
  multiselect?(
    message: string,
    options: { value: string; label: string; hint?: string }[],
    initial?: string[],
  ): Promise<string[] | null>
  intro?(title: string): Promise<void>
  outro?(message: string): Promise<void>
  note?(message: string, title?: string): Promise<void>
  spinner?(message: string): Promise<CommandSpinner | null>
  /**
   * A report line. `tone` distinguishes the two states that are neither pass
   * nor fail — something optional the user declined, and something that was
   * never evaluated — which a boolean has to round to one or the other.
   * Optional so existing implementations keep type-checking.
   */
  check?(ok: boolean, message: string, tone?: Tone): Promise<void>
}

export interface CommandSpinner {
  message(message: string): void
  stop(message: string): void
  error(message: string): void
}

export interface CommandDeps {
  io: CommandIo
  store: CredentialStore
  env: NodeJS.ProcessEnv
  cwd: string
  /** Test seam; production fixes the hook adapter under os.homedir(). */
  hookAdapterHome?: string
  /** Test seam; production uses this process's Node and CLI paths. */
  hookInstallTarget?: HookAdapterTarget
  /** Test seam; production uses process.platform for adapter format and quoting. */
  hookPlatform?: NodeJS.Platform
  /** Test seam; production uses fetch against base_url. */
  clientFactory?: (baseUrl: string, bearer: string | null, options?: ClientOptions) => ApiClient
  /** Test seam for bounded polling without wall-clock sleeps. */
  now?: () => number
  /** Test seam for retry/backoff timing. */
  sleep?: (milliseconds: number) => Promise<void>
  /** Test seams for Claude liveness, socket delivery, and cold resume. */
  claudeWake?: ClaudeWakeAdapters
  claudeSourcePid?: number
  /** Test seams for the Codex thread-writer probe and cold resume. */
  codexWake?: CodexWakeAdapters
  codexSourcePid?: number
  /** Test seam for the detached owner recovered from a pre-Stop User prompt. */
  spawnQuestionSettlement?: (launch: QuestionSettlementLaunch) => void
  /** Test seam and production adapter for the external native skills installer. */
  nativeSkills?: NativeSkills
  /** Test seam for Orca's exact-pane Agent Session title lookup. */
  orcaSessionTitle?: OrcaSessionTitleLookup
  /** Test seam for Codex Desktop/CLI's native Agent Session title index. */
  codexSessionTitle?: CodexSessionTitleLookup
  /** Test seam for registry reads; production uses fetch. */
  fetchImpl?: typeof fetch
  /**
   * The local record of what this invocation did. Optional so a test fake need
   * not carry one; `log(deps)` supplies a logger that records nothing.
   */
  logger?: Logger
}

/** The invocation's logger, or one that discards everything. */
export function log(deps: CommandDeps): Logger {
  return deps.logger ?? nullLogger()
}

export function loadLoggedConfig(
  deps: CommandDeps,
  options: Parameters<typeof loadConfig>[0],
): CliConfig {
  const config = loadConfig(options)
  const logger = log(deps)
  logger.adopt(logSettingsFrom(config))
  logger.bind({ project: config.project.value })
  logConfigResolved(logger, config)
  return config
}

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  noReply: 3,
  auth: 4,
  network: 5,
} as const

export function makeClient(
  deps: CommandDeps,
  baseUrl: string,
  bearer: string | null,
  options?: ClientOptions,
): ApiClient {
  return (deps.clientFactory ?? createClient)(baseUrl, bearer, {
    ...options,
    logger: log(deps),
    cliVersion: packageVersion(),
    capabilities: SHIPPED_CLI_CAPABILITIES,
  })
}

export function resolvedBaseUrl(config: CliConfig, credential: MachineCredential | null): string {
  return credential ? credential.baseUrl : config.base_url.value
}

/**
 * Whether a flag or env origin would send signed-in traffic somewhere other
 * than the origin stored with this machine's credential.
 *
 * Login still honours those overrides: pairing has no credential to pin to.
 * Returning the source (not the override URL, and never the bearer) is what
 * lets callers diagnose the ignore without leaking either.
 */
export function ignoredOriginOverride(
  config: CliConfig,
  credential: MachineCredential,
): CliConfig['base_url']['source'] | null {
  if (config.base_url.source === 'default') return null
  if (config.base_url.value === credential.baseUrl) return null
  return config.base_url.source
}

export function diagnoseIgnoredOriginOverride(
  io: Pick<CommandIo, 'err'>,
  config: CliConfig,
  credential: MachineCredential,
): void {
  const source = ignoredOriginOverride(config, credential)
  if (source === null) return
  io.err(
    `Ignoring base_url from ${source}; authenticated traffic uses the origin stored with this machine's credential. Run \`notifai login\` to pair with a different origin.`,
  )
}

export function authedClient(deps: CommandDeps, config: CliConfig): { client: ApiClient; baseUrl: string } | null {
  const credential = deps.store.load()
  if (!credential) {
    // The commonest reason a command does nothing, and one that leaves no other
    // trace: it returns before any request is made, so without this the log
    // shows an exit code and no cause.
    log(deps).error('cli.error', { kind: 'auth', message: 'not signed in', store: deps.store.describe() })
    deps.io.err('Not signed in. Run `notifai init`; it will coordinate machine login and device setup.')
    return null
  }
  diagnoseIgnoredOriginOverride(deps.io, config, credential)
  const baseUrl = resolvedBaseUrl(config, credential)
  return {
    client: makeClient(deps, baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`),
    baseUrl,
  }
}

/**
 * Resolve a current CLI independently of PATH. A bare `notifai update` would
 * be captured by the stale winner this action is meant to repair.
 */
export function updateCliCommand(_deps: Pick<CommandDeps, 'hookInstallTarget' | 'hookPlatform'>): string {
  return cliUpdateRecoveryCommand()
}

/** The one first-run command an unsigned machine is told to run. */
export const SETUP_COMMAND = 'notifai init'

function affectedDeviceNames(details: unknown): string[] {
  if (typeof details !== 'object' || details === null || !('device_names' in details)) return []
  const names = (details as { device_names?: unknown }).device_names
  if (!Array.isArray(names)) return []
  return [...new Set(names.filter((name): name is string => typeof name === 'string' && name.trim() !== ''))]
}

function naturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

function localRecovery(
  deps: Pick<CommandDeps, 'hookInstallTarget' | 'hookPlatform'>,
  action: RecoveryAction | null,
  details: unknown,
): string | null {
  switch (action) {
    case 'update_cli':
      return `next: ${updateCliCommand(deps)}`
    case 'update_companion': {
      const names = affectedDeviceNames(details)
      return names.length > 0
        ? `next: Update Notifai on ${naturalList(names)}.`
        : 'next: Update Notifai on the affected devices.'
    }
    case 'wait_for_service':
      return 'next: The service is being updated; try again later.'
    default:
      return null
  }
}

export function reportError(
  deps: CommandDeps,
  err: unknown,
  context: Record<string, unknown> = {},
): number {
  // Recorded before it is printed: stderr from an agent's shell call is often
  // the one thing that does not survive into the next turn, and this is exactly
  // the line someone comes back looking for.
  log(deps).error('cli.error', {
    ...context,
    ...(err instanceof ApiCallError
      ? {
          kind: 'api',
          status: err.status,
          code: err.code,
          message: err.message,
          next_action: err.nextAction,
          recovery_action: err.recoveryAction,
          details: err.details,
        }
      : err instanceof NetworkError
        ? { kind: 'network', message: err.message }
        : { kind: 'unknown', message: String(err) }),
  })
  if (err instanceof ApiCallError) {
    deps.io.err(
      deps.io.interactive === true && err.recoveryAction !== null
        ? err.message
        : `${err.code}: ${err.message}`,
    )
    // The server's field-level details were already being logged above, but
    // stderr is the one surface an agent's next turn actually reads — so the
    // diagnosis has to be on it, the same way the hook path prints it.
    const paths = rejectedPaths(err.details)
    if (paths.length > 0) deps.io.err(`the server rejected: ${paths.join(', ')}`)
    // A 422 on a request this CLI built is not a user error: the two sides
    // disagree about the contract, in whichever direction. `doctor` says which.
    // Codes that name a policy the account chose are the exception — the
    // contract held, the body simply did not satisfy that account.
    if (
      err.status === 422 &&
      err.code !== 'acknowledgement_text_required' &&
      err.code !== 'feature_unavailable'
    ) {
      deps.io.err(
        'this build sent a field the server did not accept — the CLI and server ' +
          'disagree about the contract; check with `notifai doctor`',
      )
    }
    const recovery =
      err.code === 'no_active_devices'
        ? 'next: Run `notifai init` to connect an active Companion App; it will complete machine setup and identify any human-only device step.'
        : localRecovery(deps, err.recoveryAction, err.details)
    if (recovery !== null) deps.io.err(recovery)
    else if (err.recoveryAction === null && err.nextAction) deps.io.err(`next: ${err.nextAction}`)
    if (err.code === 'auth_required' || err.code === 'machine_revoked') return EXIT.auth
    return err.status >= 500 ? EXIT.network : EXIT.failed
  }
  if (err instanceof NetworkError) {
    deps.io.err(err.message)
    return EXIT.network
  }
  deps.io.err(String(err))
  return EXIT.failed
}

export function rejectedPaths(details: unknown): string[] {
  if (!Array.isArray(details)) return []
  return details
    .map((issue) =>
      typeof issue === 'object' && issue !== null && typeof (issue as { path?: unknown }).path === 'string'
        ? (issue as { path: string }).path
        : null,
    )
    .filter((path): path is string => path !== null && path !== '')
    .slice(0, 5)
}
