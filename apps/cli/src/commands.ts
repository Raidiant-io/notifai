import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  CAPABILITIES_V1,
  PLATFORMS,
  SHIPPED_CLI_CAPABILITIES,
  QUESTION_TEXT_MAX_LENGTH,
  REPLY_MAX_QUESTIONS,
  REPLY_MAX_WINDOW_SECONDS,
  validateDraft,
  type EvidenceSnapshot,
  type AccountAccessResponse,
  type ListRepliesResponse,
  type NotificationDraftT,
  type Platform,
  type QuestionT,
  type RecoveryAction,
  type ReplyView,
  type RoutableDevice,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { sha256Hex } from '@raidiant/notifai-protocol/node'
import {
  ApiCallError,
  NetworkError,
  createClient,
  isRetryableReplyPollError,
  type ApiClient,
  type ClientOptions,
} from './client.js'
import {
  BOOLEAN_CONFIG_KEYS,
  CONFIG_KEYS,
  NUMERIC_CONFIG_KEYS,
  configBounds,
  configDefaultValue,
  findProjectConfigPath,
  personalProjectConfigPath,
  globalConfigPath,
  loadConfig,
  sessionConfigPath,
  stateDir,
  type CliConfig,
  type ConfigKey,
  type FlagOverrides,
  type LogLevel,
} from './config.js'
import { acceptedValues, configInfo } from './config-schema.js'
import { packageVersion, skillsSource } from './release.js'
import { atomicWriteFileSync } from './atomic-file.js'
import { withTargetFileLock } from './file-lock.js'
import {
  renderConfigExplain,
  renderConfigList,
  renderConfigPlain,
} from './ui/config-view.js'
import type { CredentialStore, MachineCredential } from './credentials.js'
import {
  firstBlocker,
  type Readiness,
  type ReadinessRefresh,
  type ReadinessState,
  type StateStatus,
} from './readiness.js'
import type { Tone } from './ui/theme.js'
import {
  waiterCeilingSeconds,
  clearAcknowledgementObligation,
  handleSessionEnd,
  handleStop,
  handleUserPromptSubmit,
  parseHookInput,
  pruneAbandonedSessions,
  readLiveProjectSessionPointers,
  readMatchingProjectSessionPointer,
  readProjectSession,
  readProjectSessionPointer,
  readSessionState,
  registerQuestion,
  type EscalationDeliveryRoute,
  type HookContext,
  type HookHarness,
  MIN_REPLY_WINDOW_SECONDS,
} from './hooks.js'
import {
  LOG_EVENTS,
  activeLogPath,
  archiveLogPaths,
  logConfigResolved,
  logSettingsFrom,
  logsDiskUsage,
  nullLogger,
  readLogRecords,
  renderRecord,
  type LogQuery,
  type Logger,
  RECORD_LEVELS,
} from './logging.js'
import {
  BLOCKING_STOP_TIMEOUT_SECONDS,
  stopHandlerIsDetached,
  CLAUDE_ASYNC_STOP_TIMEOUT_SECONDS,
  HARNESSES,
  applyPlan,
  buildCursorHookConfig,
  buildHookConfig,
  codexLayerDir,
  codexLayerPaths,
  codexCoexistenceNotes,
  codexHomeNote,
  codexRepresentationProblems,
  codexTrustProblems,
  codexProjectRoot,
  detectHarness,
  detectedHarnesses,
  findInstallations,
  handlerEvent,
  hookDefinitionFiles,
  inspectCodexLayer,
  loadCursorSettings,
  loadSettings,
  mergeCursorHooks,
  mergeHooks,
  removeCursorHooks,
  removeHooks,
  settingsFile,
  withCodexLayerTransaction,
  type Harness,
  type Installation,
} from './install-hooks.js'
import { HARNESS_CAPABILITIES, HARNESS_LABELS } from './harnesses.js'
import {
  claudeWakeRoute,
  inspectClaudeInbox,
  systemClaudeWakeAdapters,
  type ClaudeWakeAdapters,
} from './claude-wake.js'
import {
  codexWakeRoute,
  inspectCodexResume,
  type CodexWakeAdapters,
} from './codex-wake.js'
import {
  inspectHookAdapter,
  installHookAdapter,
  isNpxAdapterTarget,
  type HookAdapterTarget,
} from './hook-adapter.js'
import {
  isOurOpencodePlugin,
  opencodePluginSource,
} from './opencode-plugin.js'
import {
  CHOICE_USAGE,
  buildDraft,
  formatReceipt,
  parseChoices,
  receiptExitCode,
  slugify,
  validateMediaInputs,
  type DraftInvocation,
  type SendFlags,
} from './send.js'
import {
  buildSourceContext,
  inferInvocationContext,
  projectSlugFrom as inferredProjectSlugFrom,
} from './invocation-context.js'
import type { NativeSkill, NativeSkills, SkillScope } from './native-skills.js'
import { openUrl } from './platform.js'

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
  /** Test seam and production adapter for the external native skills installer. */
  nativeSkills?: NativeSkills
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

function loadLoggedConfig(
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

function makeClient(
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

function resolvedBaseUrl(config: CliConfig, credential: MachineCredential | null): string {
  return config.base_url.source === 'default' && credential ? credential.baseUrl : config.base_url.value
}

function authedClient(deps: CommandDeps, config: CliConfig): { client: ApiClient; baseUrl: string } | null {
  const credential = deps.store.load()
  if (!credential) {
    // The commonest reason a command does nothing, and one that leaves no other
    // trace: it returns before any request is made, so without this the log
    // shows an exit code and no cause.
    log(deps).error('cli.error', { kind: 'auth', message: 'not signed in', store: deps.store.describe() })
    deps.io.err('Not signed in. Run `notifai login` first.')
    return null
  }
  const baseUrl = resolvedBaseUrl(config, credential)
  return {
    client: makeClient(deps, baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`),
    baseUrl,
  }
}

const UPDATE_CLI_COMMAND = 'npm install -g @raidiant/notifai'

function localRecovery(action: RecoveryAction | null): string | null {
  switch (action) {
    case 'update_cli':
      return `next: ${UPDATE_CLI_COMMAND}`
    case 'update_companion':
      return 'next: Update Notifai on the named device.'
    case 'wait_for_service':
      return 'next: The service is being updated; try again later.'
    default:
      return null
  }
}

function reportError(
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
    const recovery = localRecovery(err.recoveryAction)
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

// ---------------------------------------------------------------------------
// login / logout / auth status
// ---------------------------------------------------------------------------

export async function loginCommand(
  deps: CommandDeps,
  flags: { name?: string; baseUrl?: string; open?: boolean },
): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, flags: { base_url: flags.baseUrl } as FlagOverrides })
  const baseUrl = config.base_url.value
  const machineName = flags.name ?? os.hostname()
  const secret = randomBytes(32).toString('base64url')
  const pollVerifier = randomBytes(24).toString('base64url')
  const client = makeClient(deps, baseUrl, null)

  let begin
  try {
    begin = await client.beginPairing({
      machine_name: machineName,
      credential_hash: sha256Hex(secret),
      poll_verifier_hash: sha256Hex(pollVerifier),
    })
  } catch (err) {
    return reportError(deps, err)
  }

  const interactive = deps.io.interactive === true
  if (interactive) {
    await deps.io.intro?.('Notifai sign in')
    await deps.io.note?.(`Code: ${begin.code}\n${begin.approve_url}`, 'Approve this machine')
  } else {
    deps.io.out(`Pairing code: ${begin.code}`)
    deps.io.out(`Approve this machine at: ${begin.approve_url}`)
    deps.io.out('Waiting for approval…')
  }
  if (flags.open !== false) deps.io.openUrl(begin.approve_url)

  const expiresAt = new Date(begin.expires_at).getTime()
  const intervalMs = Math.max(begin.poll_interval_seconds, 1) * 1000
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const approvalWaitMessage = (): string => {
    const remainingSec = Math.max(0, Math.ceil((expiresAt - now()) / 1000))
    const minutes = Math.floor(remainingSec / 60)
    const seconds = remainingSec % 60
    const remaining =
      minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`
    return `Waiting for approval… code ${begin.code} · ${remaining} left`
  }
  const spinner = interactive ? await deps.io.spinner?.(approvalWaitMessage()) : null
  while (now() < expiresAt) {
    await sleep(intervalMs)
    let poll
    try {
      poll = await client.pollPairing(begin.pairing_id, pollVerifier)
    } catch (err) {
      if (err instanceof NetworkError) {
        spinner?.message(`Connection lost — retrying… code ${begin.code}`)
        continue
      }
      spinner?.error('Pairing failed')
      return reportError(deps, err)
    }
    if (poll.status === 'approved' && poll.machine_id) {
      deps.store.save({ machineId: poll.machine_id, secret, baseUrl, machineName })
      if (interactive) {
        spinner?.stop(`Machine "${machineName}" approved`)
        await deps.io.outro?.(`Credential stored in ${deps.store.describe()}`)
      } else {
        deps.io.out(`Machine "${machineName}" approved. Credential stored in ${deps.store.describe()}.`)
      }
      return EXIT.ok
    }
    if (poll.status === 'denied') {
      spinner?.error('Pairing denied')
      deps.io.err('Pairing was denied from the dashboard.')
      return EXIT.auth
    }
    if (poll.status === 'no_active_plan') {
      const next =
        poll.next_action ??
        `Open ${baseUrl.replace(/\/$/, '')}/support to request Alpha access, then retry.`
      spinner?.error('Account has no Alpha access')
      deps.io.err('This account has no active plan or temporary Alpha access.')
      deps.io.err(`next: ${next}`)
      deps.io.err('After access is granted, run `notifai login` again.')
      return EXIT.auth
    }
    if (poll.status === 'expired') break
    spinner?.message(approvalWaitMessage())
  }
  spinner?.error('Pairing expired')
  deps.io.err('Pairing expired before it was approved. Run `notifai login` again.')
  return EXIT.auth
}

export function logoutCommand(deps: CommandDeps): number {
  deps.store.clear()
  deps.io.out('Machine credential removed. Revoke it in the dashboard too if the machine is untrusted.')
  return EXIT.ok
}

export function authStatusCommand(deps: CommandDeps, flags: { json?: boolean }): number {
  const credential = deps.store.load()
  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        credential
          ? {
              signed_in: true,
              machine_id: credential.machineId,
              machine_name: credential.machineName,
              base_url: credential.baseUrl,
              store: deps.store.describe(),
            }
          : { signed_in: false },
        null,
        2,
      ),
    )
    return credential ? EXIT.ok : EXIT.auth
  }
  if (!credential) {
    deps.io.err('Not signed in. Run `notifai login`.')
    return EXIT.auth
  }
  deps.io.out(`Signed in as machine "${credential.machineName}" (${credential.machineId})`)
  deps.io.out(`Server: ${credential.baseUrl}`)
  deps.io.out(`Credential store: ${deps.store.describe()}`)
  return EXIT.ok
}

/** Show the server's account access decision without attempting a product mutation. */
export async function accessStatusCommand(
  deps: CommandDeps,
  flags: { json?: boolean },
): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const access: AccountAccessResponse = await authed.client.accessStatus()
    if (flags.json) {
      deps.io.out(JSON.stringify(access, null, 2))
      return access.status === 'active' ? EXIT.ok : EXIT.failed
    }
    if (access.status === 'no_active_plan') {
      const supportUrl = `${authed.baseUrl.replace(/\/$/, '')}/support`
      deps.io.out('No active plan or temporary Alpha access for this account.')
      deps.io.out(`next: Open ${supportUrl} to request Alpha access, then retry.`)
      return EXIT.failed
    }
    const expiry = access.expires_at ? ` until ${access.expires_at}` : ''
    deps.io.out(`Access active (${access.reason})${expiry}`)
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

// ---------------------------------------------------------------------------
// devices / capabilities
// ---------------------------------------------------------------------------

export async function devicesCommand(deps: CommandDeps, flags: { json?: boolean }): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const result = await authed.client.listDevices()
    if (flags.json) {
      deps.io.out(JSON.stringify(result, null, 2))
      return EXIT.ok
    }
    if (result.devices.length === 0) {
      const supportUrl = supportPageUrl(authed.baseUrl)
      let email: string | null = null
      try {
        email = (await authed.client.accessStatus()).email
      } catch {
        // Best-effort: the empty-state copy still points at /support without it.
      }
      deps.io.out(
        `No devices yet. Install Notifai from ${supportUrl}, ${sameAccountSignInLine(email)}, and allow notifications.`,
      )
      return EXIT.ok
    }
    for (const d of result.devices) {
      deps.io.out(
        `${d.device_id}  ${d.display_name}  ${d.platform}  ${d.status_message ?? 'Working'}`,
      )
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

/**
 * Devices as data, for surfaces that render them themselves.
 *
 * `devicesCommand` prints and returns an exit code, which is the right shape
 * for a command and the wrong one for a menu that wants to show names beside
 * checkboxes. Silent on every failure by design: the interactive app already
 * shows the credential and connectivity state on its status card, so a second
 * error line here would be reporting the same fault twice.
 */
export async function deviceInventory(deps: CommandDeps): Promise<RoutableDevice[] | null> {
  if (!deps.store.load()) return null
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return null
  try {
    return (await authed.client.listDevices()).devices
  } catch {
    return null
  }
}

/** Whether a device is in a state where a notification would actually arrive. */
export function canDeviceReceive(device: RoutableDevice): boolean {
  return deviceCanReceive(device)
}

export async function capabilitiesCommand(
  deps: CommandDeps,
  flags: { json?: boolean; platform?: Platform },
): Promise<number> {
  // Locally, and with the same message `send` gives. Spending a round trip to
  // have the server answer "Request validation failed" told the caller neither
  // which flag was wrong nor what it accepts.
  if (flags.platform !== undefined && !(PLATFORMS as readonly string[]).includes(flags.platform)) {
    deps.io.err(`Unknown platform "${flags.platform}" — use ${PLATFORMS.join(' or ')}.`)
    return EXIT.usage
  }
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const credential = deps.store.load()
  const baseUrl = resolvedBaseUrl(config, credential)
  const client = makeClient(deps, baseUrl, null)
  try {
    const doc = await client.capabilities(flags.platform ?? 'ios')
    if (flags.json) {
      deps.io.out(JSON.stringify(doc, null, 2))
      return EXIT.ok
    }
    deps.io.out(`${doc.platform} capability contract v${doc.schema_version} (payload limit ${doc.payload_limit_bytes} bytes)`)
    for (const field of doc.fields) {
      deps.io.out(`  ${field.path}: ${field.status}${field.reason ? ` — ${field.reason}` : ''}`)
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

// ---------------------------------------------------------------------------
// send / status
// ---------------------------------------------------------------------------

function resolveDraftInvocation(
  deps: CommandDeps,
  flags: Pick<SendFlags, 'sessionId' | 'sessionLabel'>,
  active: ActiveHarnessSession | null,
): { ok: true; invocation: DraftInvocation } | { ok: false; error: string } {
  const inferred = inferInvocationContext(deps.cwd)
  const source = buildSourceContext({
    env: deps.env,
    invocation: inferred,
    ...(flags.sessionId !== undefined ? { sessionId: flags.sessionId } : {}),
    ...(flags.sessionLabel !== undefined ? { sessionLabel: flags.sessionLabel } : {}),
    ...(active === null
      ? {}
      : {
          activeHarness: {
            harness: active.harness,
            ...(active.sessionId === undefined ? {} : { sessionId: active.sessionId }),
          },
        }),
  })
  if (!source.ok) return source
  return {
    ok: true,
    invocation: {
      inferredProject: inferred.project,
      ...(source.source === undefined ? {} : { source: source.source }),
    },
  }
}

export async function sendCommand(
  deps: CommandDeps,
  flags: SendFlags & {
    json?: boolean
    wait?: number
    noWait?: boolean
    replyTimeout?: number
    noBlock?: boolean
    idempotencyKey?: string
    baseUrl?: string
  },
): Promise<number> {
  const hasReplyChoice = Array.isArray(flags.replyChoice)
    ? flags.replyChoice.length > 0
    : flags.replyChoice !== undefined
  if (flags.reply && flags.kind !== undefined && flags.kind !== 'question') {
    deps.io.err(`--kind ${flags.kind} cannot be combined with --reply; a reply request is a question.`)
    return EXIT.usage
  }
  // Kind now decides the sound a notification arrives with, so it is asked for
  // at the boundary rather than defaulted silently: an unlabelled send would
  // reach the user as ordinary news whatever actually happened.
  if (!flags.reply && flags.kind === undefined) {
    deps.io.err(
      '--kind is required: say what this notification is. ' +
        'update (news) · done (finished) · failed (terminal failure) · blocked (cannot proceed). ' +
        '--reply makes it a question without --kind.',
    )
    return EXIT.usage
  }
  if (!flags.reply && flags.kind === 'question') {
    deps.io.err('--kind question requires --reply so the question can be answered.')
    return EXIT.usage
  }
  if (
    !flags.reply &&
    (flags.replyTimeout !== undefined || flags.replyWindow !== undefined || flags.noBlock || hasReplyChoice)
  ) {
    deps.io.err('Use --reply with --reply-timeout, --reply-window, --reply-choice, or --no-block.')
    return EXIT.usage
  }
  const replyTimeout = flags.replyTimeout ?? 900
  if (flags.reply && !isNonNegativeInteger(replyTimeout)) {
    deps.io.err('--reply-timeout must be a non-negative integer number of seconds.')
    return EXIT.usage
  }
  // Asking while declaring that nothing will wait for the answer. The reply is
  // captured server-side and then unreachable: only a blocking send waits for
  // it, and the hook path drains questions registered by `ask`, never a send's
  // request id. So the user gets a real button, taps it, and nothing happens —
  // worse than a banner that never asked, because it spends their attention
  // and their trust in the channel.
  //
  // Both spellings of "do not wait" are rejected, because the defect is the
  // zero wait and not the flag that produced it.
  if (flags.reply && (flags.noBlock || replyTimeout === 0)) {
    deps.io.err(
      'A question needs someone to hear the answer, so --reply cannot be combined ' +
        'with --no-block or --reply-timeout 0.\n' +
        'To ask and end the turn, use `notifai ask` — the turn-end hook returns the answer.\n' +
        'To announce finished work, drop --reply and its choices.',
    )
    return EXIT.usage
  }
  if (
    flags.reply &&
    flags.replyWindow !== undefined &&
    (!Number.isInteger(flags.replyWindow) ||
      flags.replyWindow < MIN_REPLY_WINDOW_SECONDS ||
      flags.replyWindow > REPLY_MAX_WINDOW_SECONDS)
  ) {
    deps.io.err(
      `--reply-window must be an integer from ${MIN_REPLY_WINDOW_SECONDS} to ${REPLY_MAX_WINDOW_SECONDS} seconds.`,
    )
    return EXIT.usage
  }
  const mediaInputError = validateMediaInputs(flags.image, flags.imageAlt)
  if (mediaInputError !== null) {
    deps.io.err(mediaInputError)
    return EXIT.usage
  }
  const config = loadLoggedConfig(deps, {
    cwd: deps.cwd,
    env: deps.env,
    flags: { base_url: flags.baseUrl, wait_seconds: flags.wait } as FlagOverrides,
  })
  const source = resolveDraftInvocation(
    deps,
    flags,
    activeHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)()),
  )
  if (!source.ok) {
    deps.io.err(source.error)
    return EXIT.usage
  }
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  const mediaIds: string[] = []
  for (const image of flags.image ?? []) {
    if (image.startsWith('med_')) {
      mediaIds.push(image)
      continue
    }
    const uploaded = await uploadImage(deps, authed.client, image)
    if (!uploaded.ok) {
      if (uploaded.error !== null) deps.io.err(uploaded.error)
      return uploaded.exit
    }
    mediaIds.push(uploaded.mediaId)
  }
  flags = { ...flags, image: mediaIds }
  const build = buildDraft(config, flags, source.invocation)
  if (!build.ok) {
    deps.io.err(build.error)
    return EXIT.usage
  }
  const capabilities = CAPABILITIES_V1.describe(build.platform)
  if (!capabilities) {
    deps.io.err(`No capability contract is available for ${build.platform}.`)
    return EXIT.usage
  }
  const validation = validateDraft(build.draft, capabilities)
  if (!validation.ok) {
    for (const issue of validation.errors) deps.io.err(`${issue.path}: ${issue.message}`)
    return EXIT.usage
  }
  emitSendWarnings(deps, flags, config)
  if (
    !flags.reply &&
    (flags.title.trim().endsWith('?') || flags.body.trim().endsWith('?'))
  ) {
    deps.io.err(
      'Heads up: this notification ends with a question but has no reply action. Add --reply (and optionally --reply-choice) so it can be answered from the notification.',
    )
  }
  const waitSeconds = flags.noWait ? 0 : config.wait_seconds.value
  const idempotencyKey = flags.idempotencyKey ?? `cli-${randomBytes(12).toString('base64url')}`
  let receipt: SubmissionReceipt
  try {
    receipt = await authed.client.submit(
      { idempotency_key: idempotencyKey, draft: build.draft },
      waitSeconds,
    )
  } catch (err) {
    return reportError(deps, err)
  }
  const receiptExit = receiptExitCode(receipt)
  // The single most useful line in the log: it ties the local invocation to
  // the server-side request id, which is what every later question about this
  // notification ("did it arrive?", "which device?") is asked in terms of.
  log(deps).info('send.submitted', {
    request_id: receipt.request_id,
    kind: flags.reply ? 'question' : (flags.kind ?? 'update'),
    title: flags.title,
    overall: receipt.overall,
    replayed: receipt.replayed,
    agent_acknowledgement_required: receipt.agent_acknowledgement_required,
    deliveries: receipt.deliveries.length,
    wait_seconds: waitSeconds,
    exit: receiptExit,
  })
  log(deps).info('send.outcome', {
    request_id: receipt.request_id,
    overall: receipt.overall,
    // Per device, because "it said accepted but nothing arrived" is answered
    // by which device reached which state and why the provider said so.
    devices: receipt.deliveries.map((delivery) => ({
      device: delivery.device_name,
      state: delivery.state,
      attempts: delivery.attempts,
      provider_status: delivery.provider_status,
      provider_reason: delivery.provider_reason,
    })),
    ...(receipt.warnings.length > 0 ? { warnings: receipt.warnings } : {}),
  })
  if (!flags.json) {
    const quietOrdinarySuccess =
      !flags.reply &&
      receipt.overall === 'provider_accepted_all' &&
      receipt.warnings.length === 0
    if (!quietOrdinarySuccess) deps.io.out(formatReceipt(receipt))
  } else if (flags.reply) deps.io.out(JSON.stringify({ type: 'receipt', receipt }))

  // A zero wait can no longer reach here: --reply guarantees a positive one.
  if (!flags.reply || receiptExit !== EXIT.ok) {
    if (flags.json) {
      deps.io.out(
        flags.reply
          ? JSON.stringify({
              type: 'reply_result',
              request_id: receipt.request_id,
              replies: [],
              agent_acknowledgement_required: receipt.agent_acknowledgement_required,
              agent_acknowledgement_text_required: receipt.agent_acknowledgement_text_required,
              agent_acknowledgement: null,
              acknowledgement_command: null,
              degraded: false,
            })
          : JSON.stringify(receipt, null, 2),
      )
    }
    return receiptExit
  }

  try {
    const result = await waitForReply(authed.client, receipt.request_id, {
      timeoutSeconds: replyTimeout,
      afterSeq: 0,
      now: deps.now,
      sleep: deps.sleep,
    })
    recordReplies(deps, receipt.request_id, result.response.replies)
    if (flags.json) {
      deps.io.out(
        JSON.stringify(replyResultJson(result.response, result.degraded)),
      )
    } else if (result.response.replies.length > 0) {
      printReplies(deps, result.response.replies)
      printAcknowledgementStatus(deps, result.response)
    } else {
      printNoReply(deps, receipt.request_id, result.response.reply_expires_at)
      printAcknowledgementStatus(deps, result.response)
    }
    if (result.degraded) {
      log(deps).error('cli.error', {
        kind: 'network',
        operation: 'reply_wait',
        request_id: receipt.request_id,
        degraded: true,
        message: 'the reply wait ended while the server was unreachable or faulting',
      })
      deps.io.err(degradedWaitWarning(receipt.request_id))
      return EXIT.network
    }
    if (result.timedOut) {
      deps.io.err(
        `No reply yet. Retrieve it with \`notifai replies ${receipt.request_id}\` or retire the question with ` +
          `\`notifai close ${receipt.request_id}\`. ` +
          `This is a reply-wait timeout, not a Delivery or Companion Receipt failure — check with \`notifai status ${receipt.request_id}\`.`,
      )
    }
    return result.timedOut ? EXIT.noReply : EXIT.ok
  } catch (err) {
    // Receipt already printed; a wait fault must not read as "send failed".
    // Permanent poll errors (auth, closed window, not found) still surface, but
    // always name the durable request and point at recovery.
    if (err instanceof ApiCallError || err instanceof NetworkError) {
      log(deps).error('cli.error', {
        kind: err instanceof ApiCallError ? 'api' : 'network',
        operation: 'reply_wait',
        request_id: receipt.request_id,
        ...(err instanceof ApiCallError ? { status: err.status, code: err.code } : {}),
        message: err.message,
      })
      deps.io.err(
        `notifai: reply wait failed for ${receipt.request_id} (${err instanceof ApiCallError ? err.code : 'network'}: ${err.message}). ` +
          `Delivery and Companion Receipt are independent — check with \`notifai status ${receipt.request_id}\` and retry with \`notifai replies ${receipt.request_id}\`.`,
      )
      if (err instanceof ApiCallError) {
        if (err.code === 'auth_required' || err.code === 'machine_revoked') return EXIT.auth
        return err.status >= 500 || err.status === 429 || err.status === 408
          ? EXIT.network
          : EXIT.failed
      }
      return EXIT.network
    }
    return reportError(deps, err)
  }
}

function emitSendWarnings(
  deps: CommandDeps,
  flags: SendFlags,
  config: ReturnType<typeof loadConfig>,
): void {
  if (flags.title.length > 40) {
    deps.io.err(
      `Heads up: this title is ${flags.title.length} characters; notification titles work best around 40 characters or fewer.`,
    )
  }
  if (/^(?:update|done|question|failed|blocked)\s*(?:[·:—-]|$)/i.test(flags.title.trim())) {
    deps.io.err(
      'Heads up: keep the title to the specific substance. Put notification type in --kind; project identity is inferred separately.',
    )
  }
  if (
    flags.collapseKey === undefined &&
    config.collapse_key.value !== null &&
    config.collapse_key.source.startsWith('global:')
  ) {
    deps.io.err(
      'Heads up: collapse_key comes from machine-global config, so unrelated notifications may replace each other. Prefer a project or command-specific --collapse-key.',
    )
  }
  if (flags.ttl !== undefined && flags.ttl > 259_200) {
    deps.io.err(
      'Heads up: this explicit --ttl is longer than 72 hours; stale notifications may arrive after they are useful.',
    )
  }
}

export async function repliesCommand(
  deps: CommandDeps,
  requestedId: string | undefined,
  flags: { wait?: number; after?: number; json?: boolean; pending?: boolean },
): Promise<number> {
  const waitSeconds = flags.wait ?? 0
  const afterSeq = flags.after ?? 0
  if (!isNonNegativeInteger(waitSeconds)) {
    deps.io.err('--wait must be a non-negative integer number of seconds.')
    return EXIT.usage
  }
  if (!isNonNegativeInteger(afterSeq)) {
    deps.io.err('--after must be a non-negative integer sequence number.')
    return EXIT.usage
  }

  if (flags.pending === true && requestedId !== undefined) {
    deps.io.err('Pass a request id or --pending, not both.')
    return EXIT.usage
  }
  let requestIds = requestedId === undefined ? [] : [requestedId]
  if (flags.pending === true) {
    const sessionId = readProjectSession(deps.cwd, deps.env, (deps.now ?? Date.now)())
    if (sessionId === null) {
      deps.io.err('No active session pointer is available in this directory.')
      return EXIT.noReply
    }
    // Every delivered question in the session's queue, in registration order —
    // an agent may have several outstanding at once.
    const state = readSessionState(sessionId, deps.env)
    requestIds = (Array.isArray(state.pending) ? state.pending : [])
      .map((entry) => entry.request_id)
      .filter((id): id is string => id !== undefined)
    if (requestIds.length === 0) {
      // `--json` is a promise about stdout, and an empty result is still a
      // result: a caller that asked for machine-readable output must not have
      // to parse an English sentence to learn there was nothing pending.
      if (flags.json === true) {
        deps.io.out(JSON.stringify({ session_id: sessionId, pending: [], replies: [] }, null, 2))
      } else {
        deps.io.err(`Session ${sessionId} has no pushed question pending.`)
      }
      return EXIT.noReply
    }
  }
  if (requestIds.length === 0) {
    deps.io.err('Pass a request id or --pending.')
    return EXIT.usage
  }

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    let anyReplies = false
    const degradedRequestIds: string[] = []
    let allTimedOut = true
    const jsonBodies: object[] = []
    for (const requestId of requestIds) {
      try {
        const result = await waitForReply(authed.client, requestId, {
          timeoutSeconds: waitSeconds,
          afterSeq,
          now: deps.now,
          sleep: deps.sleep,
        })
        recordReplies(deps, requestId, result.response.replies)
        if (flags.json) {
          jsonBodies.push(replyResultJson(result.response, result.degraded))
        } else if (result.response.replies.length > 0) {
          if (flags.pending === true) deps.io.out(`pending request ${requestId}`)
          printReplies(deps, result.response.replies)
          printAcknowledgementStatus(deps, result.response)
        } else {
          printNoReply(deps, requestId, result.response.reply_expires_at)
          printAcknowledgementStatus(deps, result.response)
        }
        anyReplies ||= result.response.replies.length > 0
        if (result.degraded) degradedRequestIds.push(requestId)
        allTimedOut &&= result.timedOut
      } catch (err) {
        recordDegradedReplyWaits(deps, degradedRequestIds)
        return reportError(deps, err, { operation: 'reply_wait', request_id: requestId })
      }
    }
    if (flags.json) {
      // One request keeps the response shape agents already parse; several
      // (only possible via --pending) arrive as an array in queue order.
      deps.io.out(JSON.stringify(jsonBodies.length === 1 ? jsonBodies[0] : jsonBodies, null, 2))
    }
    if (degradedRequestIds.length > 0) {
      recordDegradedReplyWaits(deps, degradedRequestIds)
      // Name a request whose polls actually degraded, not merely the first item
      // in a multi-request queue that may have completed cleanly.
      deps.io.err(degradedWaitWarning(degradedRequestIds[0]!))
      return EXIT.network
    }
    if (anyReplies) return EXIT.ok
    return allTimedOut ? EXIT.noReply : EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

interface ReplyWaitOptions {
  timeoutSeconds: number
  afterSeq: number
  now?: (() => number) | undefined
  sleep?: ((milliseconds: number) => Promise<void>) | undefined
}

interface ReplyWaitResult {
  response: ListRepliesResponse
  timedOut: boolean
  /**
   * The wait ended while polls were failing, so silence is unproven: the user
   * may well have answered and we could not see it.
   */
  degraded: boolean
}

/** Loop over server-capped long polls until a reply arrives or the caller's deadline passes. */
export async function waitForReply(
  client: ApiClient,
  requestId: string,
  options: ReplyWaitOptions,
): Promise<ReplyWaitResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + options.timeoutSeconds * 1000
  let lastResponse: ListRepliesResponse | null = null
  let lastTransientError: Error | null = null
  let consecutiveTransientErrors = 0
  let firstPoll = true

  while (firstPoll || now() < deadline) {
    firstPoll = false
    const remainingMs = Math.max(0, deadline - now())
    const waitSeconds = Math.min(25, Math.floor(remainingMs / 1000))
    try {
      const response = await client.replies(requestId, {
        waitSeconds,
        afterSeq: options.afterSeq,
      })
      lastResponse = response
      lastTransientError = null
      consecutiveTransientErrors = 0
      if (response.replies.length > 0) return { response, timedOut: false, degraded: false }

      const pauseMs = Math.min(250, Math.max(0, deadline - now()))
      if (pauseMs > 0) await sleep(pauseMs)
    } catch (err) {
      if (!isRetryableReplyPollError(err)) throw err
      lastTransientError = err instanceof Error ? err : new Error(String(err))
      consecutiveTransientErrors += 1
      const remainingAfterError = Math.max(0, deadline - now())
      if (remainingAfterError === 0) break
      const backoffMs = Math.min(
        250 * 2 ** (consecutiveTransientErrors - 1),
        2_000,
        remainingAfterError,
      )
      await sleep(backoffMs)
    }
  }

  // Never saw a successful poll: surface the fault so callers get EXIT.network
  // rather than a fake empty silence. The durable request is still on the
  // server; the typed recovery is `notifai replies <id>`.
  if (!lastResponse && lastTransientError) throw lastTransientError
  return {
    response:
      lastResponse ??
      ({
        request_id: requestId,
        reply_expires_at: null,
        agent_acknowledgement_required: false,
        agent_acknowledgement_text_required: false,
        agent_acknowledgement: null,
        replies: [],
      } satisfies ListRepliesResponse),
    timedOut: true,
    // A poll succeeded at some point, so we do not throw — but the last thing
    // we know is that we could not reach the server. Reporting that as a plain
    // "no reply" would let an agent treat an unseen refusal as consent.
    degraded: lastTransientError !== null,
  }
}

function recordDegradedReplyWaits(deps: CommandDeps, requestIds: readonly string[]): void {
  if (requestIds.length === 0) return
  log(deps).error('cli.error', {
    kind: 'network',
    operation: 'reply_wait',
    request_ids: requestIds,
    degraded: true,
    message: 'the reply wait ended while the server was unreachable or faulting',
  })
}

/**
 * Shared by every surface that waits: "the user did not answer" and "I could
 * not find out" must not look the same, because agents branch on the exit code
 * and one of those two branches is safe to proceed from.
 *
 * Delivery / Companion Receipt / OS presentation are separate facts — a wait
 * fault is not evidence that the push failed.
 */
function degradedWaitWarning(requestId: string): string {
  return (
    `notifai: the wait for ${requestId} ended while the server was unreachable or faulting, ` +
    `so this is "could not find out", not "no answer" — the request is still durable and the ` +
    `reply may already be waiting (Provider Acceptance and Companion Receipt are independent). ` +
    `Retry with \`notifai replies ${requestId}\`.`
  )
}
function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

function acknowledgeInvocation(requestId: string, textRequired: boolean): string {
  return textRequired
    ? `notifai acknowledge ${requestId} --text <text>`
    : `notifai acknowledge ${requestId}`
}

function acknowledgementCommand(
  requestId: string,
  required: boolean,
  textRequired: boolean,
  acknowledgement: ListRepliesResponse['agent_acknowledgement'],
  hasReply = true,
): string | null {
  return required && acknowledgement === null && hasReply
    ? acknowledgeInvocation(requestId, textRequired)
    : null
}

function replyResultJson(response: ListRepliesResponse, degraded: boolean): object {
  return {
    type: 'reply_result',
    request_id: response.request_id,
    reply_expires_at: response.reply_expires_at,
    replies: response.replies,
    agent_acknowledgement_required: response.agent_acknowledgement_required,
    agent_acknowledgement: response.agent_acknowledgement,
    agent_acknowledgement_text_required: response.agent_acknowledgement_text_required,
    acknowledgement_command: acknowledgementCommand(
      response.request_id,
      response.agent_acknowledgement_required,
      response.agent_acknowledgement_text_required,
      response.agent_acknowledgement,
      response.replies.length > 0,
    ),
    degraded,
  }
}

function printAcknowledgementStatus(deps: CommandDeps, response: ListRepliesResponse): void {
  if (!response.agent_acknowledgement_required) {
    deps.io.out('Agent Acknowledgement: not required for this request.')
    return
  }
  const textRequired = response.agent_acknowledgement_text_required
  if (response.agent_acknowledgement !== null) {
    const recorded = `Agent Acknowledgement: recorded at ${response.agent_acknowledgement.created_at}`
    deps.io.out(
      response.agent_acknowledgement.text.length > 0
        ? `${recorded}: ${response.agent_acknowledgement.text}`
        : `${recorded}.`,
    )
    return
  }
  if (response.replies.length > 0) {
    deps.io.out('Agent Acknowledgement required.')
    deps.io.out(
      textRequired
        ? `next: Run \`${acknowledgeInvocation(response.request_id, true)}\` with concrete text saying what you will do because of the reply.`
        : `next: Run \`${acknowledgeInvocation(response.request_id, false)}\` so the user sees you read the reply; this account turned acknowledgement text off.`,
    )
    return
  }
  deps.io.out('Agent Acknowledgement: required after a user reply; no reply is recorded yet.')
}

function recordReplies(deps: CommandDeps, requestId: string, replies: readonly ReplyView[]): void {
  const logger = log(deps)
  for (const reply of replies) {
    logger.info('reply.received', {
      request_id: requestId,
      sequence: reply.seq,
      device: reply.device_name,
      text: reply.text,
      answers: reply.answers,
      source: reply.source,
    })
  }
}

function printReplies(deps: CommandDeps, replies: ReplyView[]): void {
  for (const reply of replies) deps.io.out(`reply from ${reply.device_name}: ${reply.text}`)
  const contradiction = contradictingAnswer(replies)
  if (contradiction !== null) deps.io.err(contradiction)
}

/**
 * The correction note for a wait that saw more than one answer.
 *
 * A later reply that conflicts with an earlier one is a correction, so the
 * latest answer is the one that counts. The server retires the question on
 * the other devices the moment one answers, which makes this rare; it is
 * still reachable, because a device can answer between the first reply
 * landing and its retirement arriving.
 *
 * Ordered by seq, so `replies.at(-1)` is the answer to act on.
 */
export function contradictingAnswer(replies: ReplyView[]): string | null {
  const winner = replies.at(-1)
  if (winner === undefined || replies.length < 2) return null
  const key = (reply: ReplyView) =>
    reply.answers.length > 0 ? JSON.stringify(reply.answers) : reply.text
  const corrected = replies.slice(0, -1).filter((reply) => key(reply) !== key(winner))
  if (corrected.length === 0) return null
  const names = [...new Set(corrected.map((reply) => reply.device_name))].join(', ')
  return (
    `note: "${winner.text}" from ${winner.device_name} is the answer that counts — a later ` +
    `answer corrects an earlier one. Earlier differing answers from ${names} were superseded.`
  )
}

function printNoReply(deps: CommandDeps, requestId: string, expiresAt?: string | null): void {
  // A harness hook may have retired this question, in which case promising an
  // open window would send the caller back to wait for an answer the server
  // will now refuse.
  const closed = expiresAt != null && Date.parse(expiresAt) <= Date.now()
  deps.io.out(
    closed
      ? `no reply for request ${requestId}; the reply window has closed`
      : `no reply yet for request ${requestId}; the reply window remains open`,
  )
}

export async function statusCommand(
  deps: CommandDeps,
  requestId: string,
  flags: { json?: boolean },
): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const snapshot = await authed.client.evidence(requestId)
    if (flags.json) {
      deps.io.out(JSON.stringify(snapshot, null, 2))
      return EXIT.ok
    }
    deps.io.out(`request ${snapshot.request_id} (${snapshot.event ?? 'no event'}) — ${snapshot.overall}`)
    let anyReplyReceived = false
    for (const d of snapshot.deliveries) {
      deps.io.out(`  ${d.device_name}:`)
      deps.io.out(`    Delivery: ${d.state} after ${d.attempts} attempt(s)`)
      deps.io.out(
        `    Provider Acceptance: ${d.state === 'provider_accepted' ? 'accepted' : 'not recorded'}`,
      )
      if (d.companion_receipt.state === 'observed') {
        const latency = d.companion_receipt.latency_ms
        deps.io.out(
          `    Companion Receipt (the app's delivery confirmation): observed at ${d.companion_receipt.observed_at}` +
            (latency === null ? '' : ` (${formatElapsed(latency)} after Provider Acceptance)`),
        )
      } else {
        deps.io.out(
          "    Companion Receipt (the app's delivery confirmation): unknown — not observed; this is not a failure or proof of non-receipt",
        )
      }
      // Notifai never learns whether the OS painted a banner; saying so stops
      // a reply-wait fault from being misread as "the phone never showed it".
      deps.io.out(
        '    OS presentation: not observed by Notifai — Provider Acceptance and Companion Receipt do not prove a banner was shown',
      )
      const replyEvent = d.events.find((e) => e.stage === 'reply_received')
      if (replyEvent) {
        anyReplyReceived = true
        deps.io.out(`    Reply received: yes (first at ${replyEvent.occurred_at})`)
      } else {
        deps.io.out('    Reply received: not yet recorded on this delivery')
      }
      for (const e of d.events) {
        deps.io.out(`      ${e.occurred_at}  ${e.stage}${e.reason ? ` (${e.reason})` : ''}`)
      }
    }
    deps.io.out(
      anyReplyReceived
        ? `  Reply wait: answers are on the server — collect with \`notifai replies ${snapshot.request_id}\` (a local wait fault does not erase them)`
        : `  Reply wait: no answer stored yet — a blocking wait failure is independent of Delivery above; retry with \`notifai replies ${snapshot.request_id}\``,
    )
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
}

const MEDIA_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif'> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
}

type UploadResult =
  | { ok: true; mediaId: string }
  /** `error: null` means `reportError` already said it; do not print it twice. */
  | { ok: false; error: string | null; exit: number }

/** `--image` accepts a media id, a local file path, or an http(s) URL. */
async function uploadImage(deps: CommandDeps, client: ApiClient, source: string): Promise<UploadResult> {
  let bytes: Uint8Array
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | undefined
  if (/^https?:\/\//.test(source)) {
    try {
      const response = await fetch(source)
      if (!response.ok) return { ok: false, error: `Could not fetch ${source} (${response.status}).`, exit: EXIT.usage }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
      mediaType = (['image/jpeg', 'image/png', 'image/gif'] as const).find((t) => t === contentType)
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch (err) {
      return { ok: false, error: `Could not fetch ${source}: ${String(err)}`, exit: EXIT.network }
    }
  } else {
    if (!existsSync(source)) {
      return { ok: false, error: `--image: "${source}" is not a media id, file, or URL.`, exit: EXIT.usage }
    }
    bytes = new Uint8Array(readFileSync(source))
    mediaType = MEDIA_TYPES[path.extname(source).toLowerCase()]
  }
  if (!mediaType) {
    return { ok: false, error: 'Images must be JPEG, PNG, or GIF.', exit: EXIT.usage }
  }
  try {
    const grant = await client.createMediaUpload({
      media_type: mediaType,
      size_bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    })
    await client.uploadMedia(grant, bytes)
    return { ok: true, mediaId: grant.media_id }
  } catch (err) {
    // Every other API failure in this file goes through `reportError`, which
    // maps a revoked credential to the auth code, a server fault to the network
    // one and everything else to plain failure, and records it in the local
    // log with whatever next step the server named. This used to answer
    // `network` to all of them, so an image too large for the account exited
    // the same way an unreachable server did, and nothing about it was logged.
    return { ok: false, error: null, exit: reportError(deps, err) }
  }
}

// ---------------------------------------------------------------------------
// hook / ask / close — harness integration
// ---------------------------------------------------------------------------

export const HOOK_EVENTS = ['user-prompt-submit', 'stop', 'session-end'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** SessionEnd cleanup must precede every diagnostic that can wait on a file lock. */
export function hookDefersDiagnosticsUntilAfterCleanup(
  event: unknown,
): event is 'session-end' {
  return event === 'session-end'
}

/**
 * Runs one harness hook. Contract with every harness: hook JSON arrives on
 * stdin, the decision (if any) goes to stdout, diagnostics go to stderr, and
 * exit 0 with no stdout means "no decision — carry on as normal".
 *
 * Every failure path in here must reach that no-decision state. A hook that
 * throws, or that blocks past the harness's timeout, degrades the agent for a
 * feature the user only asked to make it more convenient.
 */
export async function hookRunCommand(
  deps: CommandDeps,
  event: string,
  readStdin: () => Promise<string>,
  harness?: HookHarness,
): Promise<number> {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    deps.io.err(`Unknown hook event "${event}". Valid: ${HOOK_EVENTS.join(', ')}`)
    return EXIT.usage
  }

  // One clock owns the complete Stop invocation, including stdin, config,
  // credentials, and client construction. Starting this inside `handleStop`
  // would grant slow setup a second budget and let the harness kill us before
  // an accepted answer is journaled or written to stdout.
  const now = deps.now ?? Date.now
  // The waiter may spend a long wall clock exactly when no turn is held open
  // for it, which is the same condition the installer used to declare
  // `async: true`. One predicate decides it for both.
  const detachedWaiter = stopHandlerIsDetached(harness, deps.hookPlatform ?? process.platform)
  const processDeadlineAt = now() + waiterCeilingSeconds(detachedWaiter) * 1000

  const logger = log(deps)
  logger.bind({ cmd: `hook ${event}` })
  let started = false
  const start = (data: Record<string, unknown> = {}): void => {
    if (started) return
    started = true
    logger.info('hook.start', { hook: event, harness: harness ?? 'unknown', ...data })
  }
  const failureData = (err: unknown): Record<string, unknown> =>
    err instanceof ApiCallError
      ? { status: err.status, code: err.code, message: err.message, details: err.details }
      : { message: err instanceof Error ? err.message : String(err) }

  let raw: string
  try {
    raw = await readStdin()
  } catch (err) {
    start({ input: 'unavailable' })
    logger.error('hook.end', {
      hook: event,
      outcome: 'ignored',
      reason: 'input-read-failed',
      ...failureData(err),
    })
    return EXIT.ok
  }

  if (raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    } catch {
      start({ input: 'malformed' })
      logger.error('hook.end', { hook: event, outcome: 'ignored', reason: 'malformed-input' })
      deps.io.err('notifai: ignored malformed or truncated hook input; no routing action was taken')
      return EXIT.ok
    }
  }

  let envelope = parseHookInput(raw)
  if (harness === 'cursor') {
    const sessionId = envelope.session_id ?? envelope.conversation_id
    const cwd = envelope.cwd ?? envelope.workspace_roots?.[0]
    envelope = {
      ...envelope,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(cwd === undefined ? {} : { cwd }),
      stop_hook_active:
        envelope.stop_hook_active ??
        (typeof envelope.loop_count === 'number' && envelope.loop_count > 0),
    }
  }

  const cwd = envelope.cwd ?? deps.cwd
  const sessionEnd = hookDefersDiagnosticsUntilAfterCleanup(event)
  logger.bind({ session: envelope.session_id ?? null })
  let config: CliConfig | null = null
  let configFailure: unknown
  try {
    config = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
    // The hook's project is the session's, not this process's, and the log
    // settings that apply are that project's too. Keeping a mutable bootstrap
    // logger lets this more-specific layer turn logging back on.
    logger.adopt(logSettingsFrom(config))
    logger.bind({ project: config.project.value })
    if (!sessionEnd) {
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      logConfigResolved(logger, config)
    }
  } catch (err) {
    configFailure = err
    if (!sessionEnd) {
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      logger.error('hook.end', {
        hook: event,
        outcome: 'failed',
        reason: 'config-failed',
        ...failureData(err),
      })
      for (const line of describeHookFailure(err)) deps.io.err(`notifai: ${line}`)
      return EXIT.ok
    }
  }

  // Everything below is inside one fail-open boundary. Credential loading,
  // client construction and hook handling can all throw, and a hook that exits
  // non-zero makes the harness report a failure — strictly worse than skipping.
  try {
    if (sessionEnd) {
      // Codex gives SessionEnd one second total. Do every durable cleanup write
      // before lifecycle diagnostics: the log lock is deliberately allowed to
      // wait that long, and a busy log must never preserve ended-session state
      // or its inherited configuration. The resolved config above is retained
      // in memory so logging still uses the ending session's settings afterwards.
      const outcome = handleSessionEnd(deps.env, envelope, (deps.now ?? Date.now)())
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      if (config !== null) logConfigResolved(logger, config)
      const data = { hook: event, decided: false, ...outcome.log }
      if (configFailure === undefined) logger.info('hook.end', data)
      else {
        logger.error('hook.end', {
          ...data,
          reason: 'config-failed',
          config_error: failureData(configFailure),
        })
      }
      for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
      return EXIT.ok
    }

    // Non-SessionEnd hooks cannot reach here without resolved configuration.
    const resolved = config!
    const credential = deps.store.load()
    if (!credential) {
      logger.error('hook.end', { hook: event, outcome: 'not-paired' })
      deps.io.err('notifai: hook skipped: this machine is not paired; run `notifai login`')
      return EXIT.ok
    }
    // Pin authenticated traffic to the origin the credential was issued for. A
    // repository can commit `.notifai/config.toml`, and honouring a base_url
    // from it would hand this machine's bearer token to whatever host it names.
    const baseUrl = credential.baseUrl
    if (resolved.base_url.source !== 'default' && resolved.base_url.value !== baseUrl) {
      deps.io.err(
        `notifai: ignoring base_url from ${resolved.base_url.source}; hooks only talk to ${baseUrl}`,
      )
    }
    // UserPromptSubmit runs in front of the user's own prompt under a 15s
    // harness ceiling and can make two calls, so each gets a small slice of it;
    // Stop is allowed to block and keeps the ordinary budget.
    const client = makeClient(
      deps,
      baseUrl,
      `Bearer nfm_${credential.machineId}.${credential.secret}`,
      {
        timeoutMs: event === 'user-prompt-submit' ? 4_000 : 20_000,
        ...(event === 'stop' ? { deadlineAt: processDeadlineAt, now } : {}),
      },
    )
    const ctx: HookContext = {
      client,
      config: resolved,
      env: deps.env,
      now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      waitForFirstReply: async (requestId, timeoutSeconds) => {
        const result = await waitForReply(client, requestId, {
          timeoutSeconds,
          afterSeq: 0,
          now: deps.now,
          sleep: deps.sleep,
        })
        return {
          replies: result.response.replies,
          timedOut: result.timedOut,
          degraded: result.degraded,
        }
      },
      log: logger,
      ...(harness === undefined ? {} : { harness }),
    }

    // Real clock, deliberately, not `deps.now`. This compares against file
    // mtimes, which are wall-clock facts — handing it a virtual or skewed clock
    // would have it delete live session state as "abandoned".
    // Daily state pruning is housekeeping, not part of the Stop delivery
    // contract. Its directory scan has no useful bound, so keep it on the
    // short prompt path and never spend the answer owner's finite budget on it.
    if (event !== 'stop') pruneAbandonedSessions(deps.env)

    const outcome =
      event === 'user-prompt-submit'
        ? await handleUserPromptSubmit(ctx, envelope)
        : await handleStop(
            ctx,
            envelope,
            processDeadlineAt,
            stopWakeRoute(deps, harness, envelope.session_id, cwd),
          )
    // Answer diagnostics are already persisted once as hook.answer. Keep every
    // other note in the lifecycle record without duplicating the user's text.
    const notes = outcome.notes.filter((note) => !/^(?:late )?answer from /.test(note))
    logger.info('hook.end', {
      hook: event,
      // A hook that returns stdout has taken over the turn; one that does not
      // has handed the terminal back. That distinction is the whole contract.
      decided: outcome.stdout !== undefined,
      ...(notes.length === 0 ? {} : { notes }),
      ...outcome.log,
    })
    for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
    if (outcome.stdout !== undefined) deps.io.out(outcome.stdout)
    return EXIT.ok
  } catch (err) {
    // SessionEnd defers its start record until after cleanup; if cleanup itself
    // fails, begin the after-the-fact lifecycle here before recording why.
    if (sessionEnd) start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
    // The hook still exits 0 — handing the terminal back is always right. What
    // this adds is that the reason survives, including the server's own words.
    logger.error('hook.end', {
      hook: event,
      outcome: 'failed',
      reason: 'execution-failed',
      ...failureData(err),
    })
    for (const line of describeHookFailure(err)) deps.io.err(`notifai: ${line}`)
    return EXIT.ok
  }
}

/**
 * The last meter for an answer this Stop hook accepted, chosen by harness.
 *
 * Both wake adapters need the harness process that invoked this hook: Claude's
 * to prove exact own-child session ownership before it posts to the inbox
 * socket, Codex's to know whether its own stdout is still a live continuation
 * channel. Without an exact session id neither can prove anything, so the
 * waiter falls back to the plain blocking Stop continuation.
 */
function stopWakeRoute(
  deps: CommandDeps,
  harness: Harness | undefined,
  sessionId: string | undefined,
  cwd: string,
): EscalationDeliveryRoute | undefined {
  if (sessionId === undefined) return undefined
  if (harness === 'claude-code') {
    if ((deps.hookPlatform ?? process.platform) === 'win32') return undefined
    return claudeWakeRoute({
      sessionId,
      cwd,
      sourcePid: deps.claudeSourcePid ?? claudeSessionPid(deps.env),
      ...(deps.claudeWake === undefined ? {} : { adapters: deps.claudeWake }),
    })
  }
  if (harness === 'codex') {
    return codexWakeRoute({
      threadId: sessionId,
      cwd,
      sourcePid: deps.codexSourcePid ?? process.ppid,
      env: deps.env,
      ...(deps.codexWake === undefined ? {} : { adapters: deps.codexWake }),
    })
  }
  return undefined
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
function claudeSessionPid(env: NodeJS.ProcessEnv): number {
  const declared = Number(env['CLAUDE_PID'])
  return Number.isInteger(declared) && declared > 0 ? declared : process.ppid
}

/**
 * What went wrong, in terms of what to do about it.
 *
 * On 2026-08-03 a contract change shipped without the server deploy that goes
 * with it. The CLI stamped `lifecycle` on every question draft, the deployed
 * server rejected the unknown field, and escalation stopped working entirely —
 * announced as "hook failed, deferring to the terminal", which reads like a
 * flaky network. The information needed to diagnose it in one second was
 * already in hand: a 422 whose details name the offending path. It was being
 * thrown away by `String(err)`.
 *
 * A hook still exits 0 whatever this says. Handing the terminal back is always
 * right; the only question is whether the user is told anything they can use.
 */
export function describeHookFailure(err: unknown): string[] {
  if (!(err instanceof ApiCallError)) {
    return [`hook failed, deferring to the terminal (${String(err)})`]
  }
  const lines = [`hook failed, deferring to the terminal (${err.code}: ${err.message})`]
  const paths = rejectedPaths(err.details)
  if (paths.length > 0) lines.push(`the server rejected: ${paths.join(', ')}`)
  // A 422 on a draft this CLI built is not a user error — this CLI's own
  // contract produced it. Either the server is behind, or the two disagree.
  if (err.status === 422) {
    lines.push(
      'this build sent a field the server did not accept, which usually means the server ' +
        'is older than this CLI — check with `notifai doctor`',
    )
  }
  return lines
}

function rejectedPaths(details: unknown): string[] {
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

export interface AskFlags {
  /** Emit the registration and its turn obligation as one JSON object. */
  json?: boolean
  choice?: string[]
  /** The single question is multi-select: several answers may be chosen. */
  multi?: boolean
  /** Optional Markdown context appended after the question block. */
  body?: string
  /** Raw JSON for a multi-question form; replaces the positional question. */
  form?: string
  image?: string[]
  imageAlt?: string[]
  project?: string
  sessionId?: string
  sessionLabel?: string
}

/** The `--form` document: what an agent writes to ask several things at once. */
interface AskFormQuestion {
  text: string
  choices?: string[]
  multi?: boolean
}

export interface BuiltQuestions {
  questions: QuestionT[]
  /** Canonical Markdown body: question block first, optional context second. */
  body: string
}

/**
 * Turn ask input into questions plus their canonical body. Everything is
 * validated at registration because a later hook failure is easy to miss.
 */
export function buildQuestions(
  flags: AskFlags,
  question: string | undefined,
): { ok: true; questions: QuestionT[]; body: string } | { ok: false; error: string } {
  if (flags.form !== undefined) {
    if (question !== undefined || flags.choice?.length || flags.multi) {
      return { ok: false, error: '--form replaces the positional question, --choice, and --multi.' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(flags.form)
    } catch {
      return {
        ok: false,
        error: '--form must be JSON: {"questions": [{"text", "choices"?, "multi"?}], "body"?}.',
      }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `--form needs a "questions" array (1-${REPLY_MAX_QUESTIONS} entries).` }
    }
    const record = parsed as Record<string, unknown>
    const unknownKeys = Object.keys(record).filter((key) => key !== 'questions' && key !== 'body')
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        error: `Unknown --form ${unknownKeys.length === 1 ? 'key' : 'keys'}: ${unknownKeys.join(', ')}. Use "body" for Markdown context.`,
      }
    }
    if (!Array.isArray(record['questions'])) {
      return { ok: false, error: `--form needs a "questions" array (1-${REPLY_MAX_QUESTIONS} entries).` }
    }
    const formQuestions = record['questions']
    if (formQuestions.length < 1 || formQuestions.length > REPLY_MAX_QUESTIONS) {
      return {
        ok: false,
        error: `A form asks 1-${REPLY_MAX_QUESTIONS} questions; this one has ${formQuestions.length}.`,
      }
    }
    if (record['body'] !== undefined && typeof record['body'] !== 'string') {
      return { ok: false, error: '"body" must be a Markdown string.' }
    }
    if (flags.body !== undefined && record['body'] !== undefined) {
      return { ok: false, error: 'Pass form context in either --body or the form "body" key, not both.' }
    }
    const questions: QuestionT[] = []
    const usedIds = new Set<string>()
    for (const [index, entry] of formQuestions.entries()) {
      if (typeof entry !== 'object' || entry === null || typeof (entry as AskFormQuestion).text !== 'string') {
        return { ok: false, error: `Question ${index + 1} needs a "text" string.` }
      }
      const spec = entry as AskFormQuestion
      const built = buildOneQuestion(spec.text, spec.choices, spec.multi === true, index, usedIds)
      if ('error' in built) return { ok: false, error: `Question ${index + 1}: ${built.error}` }
      questions.push(built.question)
    }
    const context = flags.body ?? (record['body'] as string | undefined)
    const questionBlock = questions.map((entry, index) => `${index + 1}. ${entry.text}`).join('\n')
    return {
      ok: true,
      questions,
      body:
        context !== undefined && context.trim() !== ''
          ? `${questionBlock}\n\n${context}`
          : questionBlock,
    }
  }

  if (question === undefined || question.trim() === '') {
    return { ok: false, error: 'The question cannot be empty.' }
  }
  const built = buildOneQuestion(question, flags.choice, flags.multi === true, 0, new Set())
  if ('error' in built) return { ok: false, error: built.error }
  const context = flags.body
  return {
    ok: true,
    questions: [built.question],
    body:
      context !== undefined && context.trim() !== ''
        ? `${built.question.text}\n\n${context}`
        : built.question.text,
  }
}

function buildOneQuestion(
  text: string,
  choiceLabels: string[] | undefined,
  multi: boolean,
  index: number,
  usedIds: Set<string>,
): { question: QuestionT } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { error: 'the question text cannot be empty.' }
  if (trimmed.length > QUESTION_TEXT_MAX_LENGTH) {
    return {
      error:
        `a question must be readable where it is answered: keep it within ` +
        `${QUESTION_TEXT_MAX_LENGTH} characters and put the longer context in --body.`,
    }
  }
  const choices = parseChoices(choiceLabels)
  if (choices === 'invalid') return { error: CHOICE_USAGE }
  if (multi && choices === null) {
    return { error: '--multi needs answers to select between; add --choice.' }
  }
  let id = slugify(trimmed)
  if (id === '' || usedIds.has(id)) id = `q${index + 1}`
  usedIds.add(id)
  return {
    question: {
      id,
      text: trimmed,
      ...(choices !== null ? { choices } : {}),
      ...(multi ? { multi: true } : {}),
    },
  }
}

function buildAskDraft(
  config: CliConfig,
  built: BuiltQuestions,
  flags: AskFlags,
  invocation: DraftInvocation,
  mediaIds: string[],
): { ok: true; draft: NotificationDraftT } | { ok: false; error: string } {
  const result = buildDraft(
    config,
    {
      title: built.questions[0]!.text,
      body: built.body,
      ...(flags.project !== undefined ? { project: flags.project } : {}),
      ...(mediaIds.length > 0 ? { image: mediaIds } : {}),
      ...(flags.imageAlt !== undefined ? { imageAlt: flags.imageAlt } : {}),
      reply: true,
      questions: built.questions,
    },
    invocation,
  )
  if (!result.ok) return result
  const capabilities = CAPABILITIES_V1.describe(result.platform)
  if (capabilities === null) return { ok: false, error: 'No iOS capability contract is available.' }
  const validation = validateDraft(result.draft, capabilities)
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('\n'),
    }
  }
  return { ok: true, draft: result.draft }
}

function recordRegisteredQuestion(
  deps: CommandDeps,
  sessionId: string,
  built: BuiltQuestions,
  draft: NotificationDraftT,
  json = false,
): number {
  try {
    registerQuestion(
      sessionId,
      deps.env,
      {
        question: built.questions[0]!.text,
        questions: built.questions,
        body: draft.presentation.body,
        ...(draft.project !== undefined ? { project: draft.project } : {}),
        ...(draft.source !== undefined ? { source: draft.source } : {}),
        ...(draft.presentation.media !== undefined ? { media: draft.presentation.media } : {}),
      },
      (deps.now ?? Date.now)(),
    )
  } catch (err) {
    log(deps).error('ask.registered', { ok: false, session: sessionId, message: String(err) })
    deps.io.err(`Could not register the question: ${err instanceof Error ? err.message : String(err)}`)
    return EXIT.failed
  }
  log(deps).info('ask.registered', {
    ok: true,
    session: sessionId,
    questions: built.questions.length,
    text: built.questions[0]!.text,
    choices: built.questions[0]!.choices?.length ?? 0,
    media: draft.presentation.media?.length ?? 0,
  })
  // The block below is the densest guidance this CLI prints, and until now it
  // was prose only: an agent could not read back the choice ids it must branch
  // on without asking the server for them. The JSON form carries the same
  // obligation as data.
  if (json) {
    deps.io.out(
      JSON.stringify(
        {
          registered: true,
          questions: built.questions.map((entry) => ({
            id: entry.id,
            text: entry.text,
            ...(entry.choices === undefined ? {} : { choices: entry.choices }),
            ...(entry.multi === true ? { multi: true } : {}),
          })),
          next: {
            end_turn: true,
            in_this_turn:
              'Ask the question in the conversation and say what concrete work each possible answer will make you resume, then end the turn.',
            route_neutral:
              'Never say where the answer must arrive; it returns by whatever route the harness supports.',
            on_answer:
              'Acknowledge it, then resume the committed work without asking the user to confirm again.',
          },
        },
        null,
        2,
      ),
    )
    return EXIT.ok
  }
  for (const [index, entry] of built.questions.entries()) {
    const prefix = built.questions.length > 1 ? `${index + 1}. ` : ''
    if (entry.choices !== undefined) {
      const kind = entry.multi === true ? 'answers offered (several may be chosen)' : 'answers offered'
      deps.io.out(`${prefix}${entry.text} — ${kind}: ${entry.choices.map((choice) => choice.label).join(' / ')}`)
    } else if (built.questions.length > 1) {
      deps.io.out(`${prefix}${entry.text} — free text`)
    }
  }
  deps.io.out(
    built.questions.length > 1
      ? `${built.questions.length} questions registered as one form. Ask them in the conversation, state the concrete work you will resume for their answers, then end your turn.`
      : 'Question registered. Ask it in the conversation, state the concrete work you will resume when the answer arrives, then end your turn.',
  )
  deps.io.out('Before ending this turn, pre-commit in your own words to the work you will resume:')
  for (const [index, entry] of built.questions.entries()) {
    const questionPrefix = built.questions.length > 1 ? `Question ${index + 1}, ` : ''
    if (entry.choices !== undefined) {
      for (const choice of entry.choices) {
        deps.io.out(
          `- ${questionPrefix}If the answer is ${JSON.stringify(choice.label)}: state the concrete work you will resume.`,
        )
      }
      deps.io.out(
        `- ${questionPrefix}For an unexpected typed answer: state how it will determine the concrete work you resume.`,
      )
    } else {
      deps.io.out(
        `- ${questionPrefix}For the free-text answer: state how its content will determine the concrete work you resume.`,
      )
    }
  }
  deps.io.out(
    'When the answer arrives, resume the matching work without asking the user to confirm again. Frame this as work you will resume, not as approval you receive.',
  )
  deps.io.out(
    'A Notifai answer cannot answer a harness permission prompt or interactive picker; leave those to the harness and user.',
  )
  return EXIT.ok
}

async function uploadAskMedia(
  deps: CommandDeps,
  config: CliConfig,
  sessionId: string,
  built: BuiltQuestions,
  flags: AskFlags,
  invocation: DraftInvocation,
): Promise<number> {
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  const mediaIds: string[] = []
  for (const image of flags.image ?? []) {
    if (image.startsWith('med_')) {
      mediaIds.push(image)
      continue
    }
    const uploaded = await uploadImage(deps, authed.client, image)
    if (!uploaded.ok) {
      if (uploaded.error !== null) deps.io.err(uploaded.error)
      return uploaded.exit
    }
    mediaIds.push(uploaded.mediaId)
  }
  const ready = buildAskDraft(config, built, flags, invocation, mediaIds)
  if (!ready.ok) {
    deps.io.err(ready.error)
    return EXIT.usage
  }
  return recordRegisteredQuestion(deps, sessionId, built, ready.draft, flags.json === true)
}

/**
 * Registers a question for turn-end routing. Returns immediately so the agent
 * can ask in prose and end its turn; the terminal keeps the question to itself
 * for `ask_grace_seconds` before it reaches any device.
 */
export function askCommand(
  deps: CommandDeps,
  question: string | undefined,
  flags: AskFlags,
): number | Promise<number> {
  // Validate before route discovery. A malformed question belongs to the
  // caller and should not be hidden behind whichever harness setup issue
  // happens to exist on this machine.
  const built = buildQuestions(flags, question)
  if (!built.ok) {
    deps.io.err(built.error)
    return EXIT.usage
  }
  const mediaInputError = validateMediaInputs(flags.image, flags.imageAlt)
  if (mediaInputError !== null) {
    deps.io.err(mediaInputError)
    return EXIT.usage
  }
  const routingConfig = loadConfig({ cwd: deps.cwd, env: deps.env })
  if (!routingConfig.ask_notifications.value) {
    deps.io.err(
      'Question routing is disabled by ask_notifications=false; enable it or use a blocking `notifai send --reply` question.',
    )
    return EXIT.usage
  }
  if (deps.store.load() === null) {
    deps.io.err(
      'Question routing is not paired on this machine; run `notifai login` before registering an asynchronous question.',
    )
    return EXIT.usage
  }
  // An agent calling this gets no hook payload. Harness-native environment
  // markers identify the active owner, while UserPromptSubmit adds the hook's
  // canonical id to the directory's concurrent-session index.
  const now = (deps.now ?? Date.now)()
  const { active, contested } = resolveActiveHarness(deps.env, deps.cwd, now)
  let sessionId: string | undefined
  if (active !== null) {
    const installations = findInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform)
    const activeInstalled = installations.some(
      (installation) => installation.harness === active.harness,
    )
    if (!activeInstalled) {
      for (const line of diagnoseActiveHarnessSession(
        active,
        'not-installed',
        installations,
        contested,
      )) {
        deps.io.err(line)
      }
      return EXIT.usage
    }
    if (active.sessionId === undefined) {
      for (const problem of activeQuestionRouteProblems(deps, active, installations)) {
        deps.io.err(`Question routing is not ready: ${problem}`)
      }
      return EXIT.usage
    }
    const projectPointer = readMatchingProjectSessionPointer(
      deps.cwd,
      deps.env,
      now,
      active.sessionId,
      active.harness,
    )
    if (projectPointer === null) {
      for (const line of diagnoseActiveHarnessSession(
        active,
        'not-fired',
        installations,
        contested,
      )) {
        deps.io.err(line)
      }
      return EXIT.usage
    }
    const routeProblems = activeQuestionRouteProblems(deps, active, installations)
    if (routeProblems.length > 0) {
      for (const problem of routeProblems) deps.io.err(`Question routing is not ready: ${problem}`)
      return EXIT.usage
    }
    if (readSessionState(projectPointer.sessionId, deps.env).last_stop_at === undefined) {
      deps.io.err(
        `Question routing is not ready: this ${active.label} session has fired UserPromptSubmit, but its Stop hook has not been observed. End one harmless turn, send a new prompt, then run \`notifai doctor\`.`,
      )
      return EXIT.usage
    }
    sessionId = projectPointer.sessionId
  } else {
    for (const line of diagnoseMissingSession(deps)) deps.io.err(line)
    deps.io.err(
      'Could not prove which live harness session owns this command, so Notifai will not register a question that could be delivered to the wrong or already-ended agent. Run it from a supported harness with exact session identity, or use a blocking `notifai send --reply` question.',
    )
    return EXIT.usage
  }
  if (!sessionId) {
    for (const line of diagnoseMissingSession(deps)) deps.io.err(line)
    return EXIT.usage
  }
  const source = resolveDraftInvocation(deps, flags, active)
  if (!source.ok) {
    deps.io.err(source.error)
    return EXIT.usage
  }
  if (source.invocation.source?.session_id !== sessionId) {
    deps.io.err(
      `Question routing is not ready: --session-id or NOTIFAI_SESSION_ID does not match the exact active ${active.label} session; refusing cross-session routing.`,
    )
    return EXIT.usage
  }

  // Placeholders let every body, source, project, media, and payload limit fail
  // before an upload starts. The real ids replace them only after this passes.
  const placeholders = (flags.image ?? []).map((_, index) => `med_pending_${index + 1}`)
  const preflight = buildAskDraft(routingConfig, built, flags, source.invocation, placeholders)
  if (!preflight.ok) {
    deps.io.err(preflight.error)
    return EXIT.usage
  }
  if ((flags.image?.length ?? 0) > 0) {
    return uploadAskMedia(
      deps,
      routingConfig,
      sessionId,
      built,
      flags,
      source.invocation,
    )
  }
  return recordRegisteredQuestion(deps, sessionId, built, preflight.draft, flags.json === true)
}

/**
 * Exact evidence that this shell command is running inside one supported
 * harness. Configuration-directory variables are deliberately absent: they
 * describe where a tool stores files, not which tool owns the current shell.
 * OpenCode's generated plugin supplies the Notifai-owned marker because its
 * plugin API exposes session identity but the ordinary environment does not.
 */
interface ActiveHarnessSession {
  harness: Harness
  label: string
  sessionId?: string
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
    candidates.push({
      harness: 'opencode',
      label: 'OpenCode',
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
function resolveActiveHarness(
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

function activeHarnessSession(
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: number,
): ActiveHarnessSession | null {
  return resolveActiveHarness(env, cwd, now).active
}

/**
 * One fail-closed admission gate shared by every active harness route.
 * Finding a file is not readiness: the exact session, one current definition,
 * the stable adapter, a long enough Stop owner, and (for Codex) trust must all
 * be true before `ask` is allowed to create an answerable notification.
 */
function activeQuestionRouteProblems(
  deps: CommandDeps,
  active: ActiveHarnessSession,
  installations: Installation[],
): string[] {
  const problems: string[] = []
  if (active.sessionId === undefined) {
    problems.push(
      `the active ${active.label} shell does not expose an exact session id; a project-level last-writer pointer can cross-wire two sessions. Use a blocking \`notifai send --reply\` question`,
    )
  }
  const capability = HARNESS_CAPABILITIES[active.harness]
  if (capability.stopContinuation === 'unsupported') {
    problems.push(`${active.label}: ${capability.deliveryContract}`)
  }
  const matching = installations.filter(
    (installation) => installation.harness === active.harness,
  )
  if (matching.length > 1) {
    problems.push(
      `${matching.length} ${active.label} definitions are active (${matching.map((entry) => entry.file).join(', ')}); keep either project or global routing`,
    )
  }
  for (const installation of matching) {
    for (const problem of installation.problems ?? []) {
      problems.push(`${installation.file}: ${problem}`)
    }
    for (const handler of installation.handlers) {
      const event = handlerEvent(handler.command)
      if (event !== null && !(HOOK_EVENTS as readonly string[]).includes(event)) {
        problems.push(
          `${handler.event} in ${installation.file} names the unsupported event ${event}; reinstall the ${active.label} hooks`,
        )
      }
    }
  }
  for (const problem of inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform).problems) {
    problems.push(problem)
  }
  for (const installation of matching) problems.push(...stopShapeProblems(installation, deps.hookPlatform))
  problems.push(...codexTrustProblems(matching, deps.env))
  return [...new Set(problems)]
}

type ActiveHarnessProblem = 'not-installed' | 'not-fired' | 'different-session'

function diagnoseActiveHarnessSession(
  active: ActiveHarnessSession,
  problem: ActiveHarnessProblem,
  installations: Installation[],
  contested: ActiveHarnessSession[] = [],
): string[] {
  // Naming one harness confidently is wrong when the environment carries the
  // markers of several and none of them has fired here: whichever one the
  // agent is told to prompt may not be the one it is running in.
  const ambiguity =
    contested.length > 1
      ? [
          `Several harness markers are present here (${contested.map((candidate) => candidate.label).join(', ')}) and none names a session that has fired in this directory, so ${active.label} is a guess from the environment. Send the prompt in the harness you are actually running.`,
        ]
      : []
  if (problem === 'not-installed') {
    const others = installations.map((installation) => installation.harness)
    return [
      `Could not register the question for the active ${active.label} session: Notifai ${active.label} hooks are not installed for this project.`,
      ...ambiguity,
      ...(others.length === 0
        ? []
        : [
            `Hooks installed for ${[...new Set(others)].join(', ')} do not route an active ${active.label} session.`,
          ]),
      `Run \`notifai hooks install --harness ${active.harness}\`, then send one ${active.label} prompt and run \`notifai doctor\`.`,
      `Retry \`notifai ask\` only after doctor reports that the ${active.label} hooks fired.`,
    ]
  }
  if (problem === 'different-session') {
    return [
      `Could not register the question for the active ${active.label} session: the project pointer belongs to another ${active.label} session or harness.`,
      ...ambiguity,
      `Refusing to guess or cross-wire the question. Send one prompt in this ${active.label} session, then run \`notifai doctor\`.`,
      `Retry \`notifai ask\` only after doctor reports that this active ${active.label} session fired the hooks.`,
    ]
  }
  return [
    `Could not register the question for the active ${active.label} session: Notifai hooks are installed, but this session has not published its pointer.`,
    ...ambiguity,
    `Send one ${active.label} prompt, then run \`notifai doctor\`.`,
    `Retry \`notifai ask\` only after doctor reports that the active ${active.label} session fired the hooks.`,
  ]
}

/**
 * Why `ask` cannot see a session, in terms of what to do about it.
 *
 * Only a UserPromptSubmit hook firing produces the pointer this reads, and the
 * old message answered every cause with "run `notifai hooks install` and send
 * one prompt". The useful next action depends on the harness: some reload
 * project hook files, OpenCode loads its plugin at startup, and Codex should be
 * checked after a prompt before assuming that a new session is required.
 */
function diagnoseMissingSession(deps: CommandDeps): string[] {
  const installations = findInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform)
  if (installations.length === 0) {
    return [
      'Could not tell which harness session this is: no Notifai hooks are installed for this project.',
      'Run `notifai hooks install`, then follow the activation instruction it prints.',
    ]
  }
  const where = installations.map((i) => `${i.harness} in ${i.file}`).join(', ')
  return [
    `Could not tell which harness session this is. Notifai hooks are installed (${where}),`,
    'but no usable session pointer from the last 24 hours exists here.',
    hookActivationAdvice(installations),
    'Do not bypass this with a guessed session id; run from the exact active harness session or use a blocking `notifai send --reply` question.',
  ]
}

/** The least disruptive verified way to make each installed adapter run once. */
function hookActivationAdvice(installations: Installation[]): string {
  const harnesses = new Set(installations.map((installation) => installation.harness))
  const advice: string[] = []
  if (
    installations.some(
      (installation) => installation.harness === 'claude-code' && !installation.global,
    )
  ) {
    advice.push('Claude Code: send one new prompt; project hook files reload without a restart')
  }
  if (
    installations.some(
      (installation) => installation.harness === 'claude-code' && installation.global,
    )
  ) {
    advice.push('Claude Code global hooks: send one prompt; start a new session only if it does not fire')
  }
  if (
    installations.some(
      (installation) => installation.harness === 'cursor' && !installation.global,
    )
  ) {
    advice.push(
      'Cursor: send one prompt, then run `notifai doctor`; start a new session only if it still has not fired',
    )
  }
  if (
    installations.some(
      (installation) => installation.harness === 'cursor' && installation.global,
    )
  ) {
    advice.push('Cursor global hooks: send one prompt; start a new session only if it does not fire')
  }
  if (harnesses.has('codex')) {
    advice.push(
      'Codex: send one prompt, then run `notifai doctor`; start a new session only if it still has not fired',
    )
  }
  if (harnesses.has('opencode')) {
    advice.push(
      'OpenCode: restart it, then send one prompt; plugins load at startup, but non-blocking question continuation is intentionally unsupported',
    )
  }
  return `${advice.join('. ')}.`
}

/**
 * Record the one Agent Acknowledgement associated with a replied-to request.
 *
 * `--text` is optional here because the acknowledgement is not: an account may
 * turn the agent's written reply off, and the receipt must still be recorded so
 * the user sees that an agent read the answer. The service holds the account's
 * snapshot, so it — not this process — decides whether text was owed.
 */
export async function acknowledgeCommand(
  deps: CommandDeps,
  requestId: string,
  flags: { text?: string; json?: boolean },
): Promise<number> {
  const text = flags.text?.trim() ?? ''
  if (flags.text !== undefined && text.length === 0) {
    deps.io.err('--text must contain non-whitespace text. Drop it to acknowledge without text.')
    return EXIT.usage
  }
  if (text.length > AGENT_ACKNOWLEDGEMENT_MAX_LENGTH) {
    deps.io.err(
      `--text must be at most ${AGENT_ACKNOWLEDGEMENT_MAX_LENGTH} characters after trimming. Shorten it: an acknowledgement is a receipt, not a report.`,
    )
    return EXIT.usage
  }

  const logger = log(deps)
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  logger.info('acknowledgement.attempted', {
    request_id: requestId,
    text,
    characters: text.length,
  })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const result = await authed.client.putAgentAcknowledgement(
      requestId,
      text.length > 0 ? { text } : {},
    )
    const output = {
      request_id: requestId,
      outcome: result.status,
      acknowledgement: result.agent_acknowledgement,
      agent_acknowledgement_required: true,
    }
    logger.info('acknowledgement.outcome', {
      request_id: requestId,
      outcome: result.status,
      text: result.agent_acknowledgement.text,
      created_at: result.agent_acknowledgement.created_at,
      agent_acknowledgement_required: true,
    })
    const sessionId = readProjectSession(deps.cwd, deps.env, (deps.now ?? Date.now)())
    if (sessionId !== null) {
      clearAcknowledgementObligation(sessionId, deps.env, requestId)
    }
    if (flags.json) deps.io.out(JSON.stringify(output, null, 2))
    else {
      deps.io.out(
        `Agent Acknowledgement ${result.status} for ${requestId} at ${result.agent_acknowledgement.created_at}.`,
      )
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err, { operation: 'agent_acknowledgement', request_id: requestId })
  }
}

/** Retire a question so a late answer is rejected rather than silently lost. */
export async function closeCommand(
  deps: CommandDeps,
  requestId: string,
  flags: { json?: boolean } = {},
): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const response = await authed.client.closeReplies(requestId)
    if (flags.json) {
      deps.io.out(
        JSON.stringify(
          {
            ...response,
            acknowledgement_command: acknowledgementCommand(
              response.request_id,
              response.agent_acknowledgement_required,
              response.agent_acknowledgement_text_required,
              response.agent_acknowledgement,
              response.replies.length > 0,
            ),
          },
          null,
          2,
        ),
      )
    } else {
      deps.io.out(`Closed the reply window for ${requestId}.`)
      if (response.replies.length > 0) printAcknowledgementStatus(deps, response)
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

export interface HooksInstallFlags {
  harness?: string
  global?: boolean
  /** Test seam; production resolves the running CLI. */
  execPath?: string
  scriptPath?: string
}

/** True when this process is `npx` / `npm exec`, not a global or linked install. */
export function runningViaNpx(env: NodeJS.ProcessEnv, scriptPath: string): boolean {
  if (env['npm_command'] === 'exec') return true
  return scriptPath.includes(`${path.sep}_npx${path.sep}`)
}

function fileHookInstallTarget(
  target: HookAdapterTarget | undefined,
): { execPath: string; scriptPath: string } | undefined {
  if (target === undefined || isNpxAdapterTarget(target)) return undefined
  return target
}

function resolveHookAdapterTarget(deps: CommandDeps, flags: HooksInstallFlags): HookAdapterTarget {
  if (deps.hookInstallTarget !== undefined && isNpxAdapterTarget(deps.hookInstallTarget)) {
    return deps.hookInstallTarget
  }
  const fileTarget = fileHookInstallTarget(deps.hookInstallTarget)
  const execPath = flags.execPath ?? fileTarget?.execPath ?? process.execPath
  const scriptPath = flags.scriptPath ?? fileTarget?.scriptPath ?? process.argv[1] ?? 'notifai'
  if (runningViaNpx(deps.env, scriptPath)) {
    const version = packageVersion()
    const npmCli = deps.env['npm_execpath']
    if (version === null) {
      throw new Error(
        'Could not read this CLI version, so an npx hook target cannot be pinned. Install `@raidiant/notifai` globally and rerun `notifai hooks install`.',
      )
    }
    if (typeof npmCli !== 'string' || npmCli === '') {
      throw new Error(
        'This process looks like npx but npm_execpath is missing. Install `@raidiant/notifai` globally and rerun `notifai hooks install`.',
      )
    }
    return { kind: 'npx', execPath, npmCli, spec: `@raidiant/notifai@${version}` }
  }
  return { execPath, scriptPath }
}

function printHooksInstallClose(deps: CommandDeps, harness: Harness, file: string): void {
  const label = HARNESS_LABELS[harness]
  if (deps.io.interactive === true && deps.io.note) {
    void deps.io.note(`${file}\nSend one ${label} prompt, then run \`notifai doctor\`.`, `${label} hooks installed`)
    return
  }
  deps.io.out(`Installed ${harness} hooks in ${file}`)
  deps.io.out(`Send one ${label} prompt, then check \`notifai doctor\`.`)
}

export function hooksInstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  if (flags.harness === undefined) {
    const detected = detectedHarnesses(deps.cwd, deps.env)
    if (detected.length === 0) {
      deps.io.err(`Could not tell which harness you mean — pass --harness <${HARNESSES.join('|')}>.`)
      return EXIT.usage
    }
    let ok = true
    for (const harness of detected) {
      if (hooksInstallCommand(deps, { ...flags, harness }) !== EXIT.ok) ok = false
    }
    return ok ? EXIT.ok : EXIT.failed
  }
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  const adapterTarget = resolveHookAdapterTarget(deps, flags)
  const scriptPath =
    flags.scriptPath ?? fileHookInstallTarget(adapterTarget)?.scriptPath ?? process.argv[1] ?? 'notifai'
  const hookPlatform = deps.hookPlatform ?? process.platform
  const nodePath = adapterTarget.execPath
  let adapterPath: string
  try {
    adapterPath = installHookAdapter(adapterTarget, deps.hookAdapterHome, hookPlatform).path
  } catch (err) {
    deps.io.err(`Could not prepare the stable hook adapter: ${String(err)}`)
    return EXIT.failed
  }
  const wantGlobal = flags.global === true
  const existing = findInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform).filter(
    (installation) => installation.harness === harness,
  )
  const otherScope = existing.filter((installation) => installation.global !== wantGlobal)
  if (!wantGlobal && otherScope.some((installation) => installation.global)) {
    const globalFile = otherScope.find((installation) => installation.global)?.file
    deps.io.out(
      `${HARNESS_LABELS[harness]} hooks already cover this machine (${globalFile}). This project does not need its own copy. To wire only this project: notifai hooks uninstall --harness ${harness} --global && notifai hooks install --harness ${harness}`,
    )
    return EXIT.ok
  }
  if (wantGlobal && otherScope.some((installation) => !installation.global)) {
    if (hooksUninstallCommand(deps, { ...flags, global: false, harness }) !== EXIT.ok) {
      return EXIT.failed
    }
  }
  const codexPaths =
    harness === 'codex'
      ? codexLayerPaths(wantGlobal, deps.cwd, deps.env, hookPlatform)
      : null
  const settingsTarget =
    codexPaths?.configToml ?? settingsFile(harness, wantGlobal, deps.cwd, deps.env, hookPlatform)

  // OpenCode's adapter is a generated plugin module rather than a handler
  // merged into a settings document, so it owns the whole file.
  if (harness === 'opencode') {
    return installOpencodePlugin(deps, settingsTarget, {
      adapterPath,
      timeoutSeconds: BLOCKING_STOP_TIMEOUT_SECONDS,
      platform: hookPlatform,
      nodePath,
    })
  }

  if (harness === 'cursor') {
    try {
      withTargetFileLock(settingsTarget, () => {
        const document = loadCursorSettings(settingsTarget)
        const result = mergeCursorHooks(
          document,
          buildCursorHookConfig({
            adapterPath,
            harness: 'cursor',
            platform: hookPlatform,
            nodePath,
          }),
          scriptPath,
        )
        applyPlan(settingsTarget, result.document)
        return result
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    printHooksInstallClose(deps, harness, settingsTarget)
    return EXIT.ok
  }

  const installInto = (file: string): { file: string; foreignStopCount: number } => {
    const document = loadSettings(file)
    const foreignStopCount = foreignStopHandlers(document).length
    const result = mergeHooks(
      document,
      buildHookConfig({
        adapterPath,
        harness,
        platform: hookPlatform,
        nodePath,
      }),
      scriptPath,
    )
    applyPlan(file, result.document)
    return { file, foreignStopCount }
  }

  let installed: { file: string; foreignStopCount: number }
  try {
    installed =
      codexPaths === null
        ? withTargetFileLock(settingsTarget, () => installInto(settingsTarget))
        : withCodexLayerTransaction(codexPaths, (inspection) => installInto(inspection.writeTarget))
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }

  if (harness === 'codex') {
    const layer = flags.global ? null : codexLayerDir(deps.cwd)
    if (layer !== null) mkdirSync(layer, { recursive: true })
  }
  printHooksInstallClose(deps, harness, installed.file)
  if (installed.foreignStopCount > 0) {
    deps.io.out(
      "This layer already has a Stop handler. Codex runs every matching handler, so Notifai's Stop and the existing one will both fire.",
    )
  }
  if (harness === 'codex') {
    for (const problem of codexRepresentationProblems(deps.cwd, deps.env, hookPlatform)) {
      deps.io.out(problem)
    }
    for (const note of codexCoexistenceNotes(deps.cwd, deps.env, hookPlatform)) {
      deps.io.out(note)
    }
    if (flags.global) {
      const home = codexHomeNote(deps.env, hookPlatform)
      if (home !== null) deps.io.out(home)
    }
  }
  return EXIT.ok
}

function foreignStopHandlers(document: { hooks?: Record<string, { hooks?: { command: string }[] }[]> }): { command: string }[] {
  const groups = document.hooks?.['Stop']
  if (!Array.isArray(groups)) return []
  return groups
    .flatMap((group) => group.hooks ?? [])
    .filter((handler) => !/ hook (user-prompt-submit|stop|session-end)\b/.test(handler.command))
}

/**
 * Writes the OpenCode plugin, replacing any Notifai plugin already there —
 * including one a different checkout wrote, matched on the managed marker for
 * the same reason command hooks are.
 */
function installOpencodePlugin(
  deps: CommandDeps,
  file: string,
  options: {
    adapterPath: string
    timeoutSeconds: number
    platform?: NodeJS.Platform
    nodePath?: string
  },
): number {
  try {
    withTargetFileLock(file, () => {
      if (existsSync(file)) {
        assertOwnedRegularFile(file)
        const existing = readFileSync(file, 'utf8')
        if (!isOurOpencodePlugin(existing)) {
          throw new Error(`${file} exists and was not written by Notifai; move it aside first.`)
        }
      }
      atomicWriteFileSync(file, opencodePluginSource(options), {
        mode: 0o600,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
    })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  printHooksInstallClose(deps, 'opencode', file)
  return EXIT.ok
}

export function hooksUninstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  const scriptPath = flags.scriptPath ?? process.argv[1] ?? 'notifai'
  const global = flags.global ?? false
  const codexPaths =
    harness === 'codex'
      ? codexLayerPaths(global, deps.cwd, deps.env, deps.hookPlatform)
      : null
  const file =
    codexPaths?.configToml ?? settingsFile(harness, global, deps.cwd, deps.env, deps.hookPlatform)
  if (harness === 'opencode') {
    try {
      return withTargetFileLock(file, () => {
        if (!existsSync(file)) {
          deps.io.out(`Nothing to remove: ${file} does not exist.`)
          return EXIT.ok
        }
        assertOwnedRegularFile(file)
        // We own the whole file, but only if we wrote it.
        if (!isOurOpencodePlugin(readFileSync(file, 'utf8'))) {
          deps.io.out(`Left ${file} alone: Notifai did not write it.`)
          return EXIT.ok
        }
        rmSync(file, { force: true })
        deps.io.out(`Removed the Notifai OpenCode plugin at ${file}`)
        return EXIT.ok
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
  }
  if (harness === 'cursor') {
    let stripped: ReturnType<typeof removeCursorHooks> | null
    try {
      stripped = withTargetFileLock(file, () => {
        if (!existsSync(file)) return null
        const document = loadCursorSettings(file)
        const result = removeCursorHooks(document, scriptPath)
        applyPlan(file, result.document)
        return result
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    if (stripped === null) {
      deps.io.out(`Nothing to remove: ${file} does not exist.`)
      return EXIT.ok
    }
    deps.io.out(
      stripped.replaced.length > 0
        ? `Removed Notifai hooks (${stripped.replaced.join(', ')}) from ${file}`
        : `No Notifai hooks found in ${file}`,
    )
    return EXIT.ok
  }
  const removeInstalledHooks = (): { existing: string[]; removedAny: boolean } => {
    const files =
      codexPaths === null
        ? hookDefinitionFiles(harness, global, deps.cwd, deps.env, deps.hookPlatform)
        : [codexPaths.hooksJson, codexPaths.configToml]
    const existing = files.filter((candidate) => existsSync(candidate))
    let removedAny = false
    for (const candidate of existing) {
      const removeFromCandidate = () => {
        const document = loadSettings(candidate)
        const result = removeHooks(document, scriptPath)
        if (result.replaced.length > 0) applyPlan(candidate, result.document)
        return result
      }
      const stripped =
        codexPaths === null
          ? withTargetFileLock(candidate, removeFromCandidate)
          : removeFromCandidate()
      if (stripped.replaced.length > 0) {
        removedAny = true
        deps.io.out(`Removed Notifai hooks (${stripped.replaced.join(', ')}) from ${candidate}`)
      }
    }
    return { existing, removedAny }
  }

  let result: { existing: string[]; removedAny: boolean }
  try {
    result =
      codexPaths === null
        ? removeInstalledHooks()
        : withCodexLayerTransaction(codexPaths, removeInstalledHooks)
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  if (result.existing.length === 0) {
    deps.io.out(`Nothing to remove: ${file} does not exist.`)
    return EXIT.ok
  }
  if (!result.removedAny) {
    deps.io.out(`No Notifai hooks found in ${result.existing.join(', ')}`)
  }
  return EXIT.ok
}

function assertOwnedRegularFile(file: string): void {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${file} is not a regular file; refusing to read or replace it.`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${file} is owned by uid ${stat.uid}, not the current user.`)
  }
}

function resolveHarness(deps: CommandDeps, requested: string | undefined): Harness | null {
  if (requested !== undefined) {
    if ((HARNESSES as readonly string[]).includes(requested)) return requested as Harness
    deps.io.err(
      `Unknown harness "${requested}". Supported: ${HARNESSES.join(', ')}.`,
    )
    return null
  }
  const detected = detectHarness(deps.cwd, deps.env)
  if (!detected) {
    deps.io.err(`Could not tell which harness to install for — pass --harness <${HARNESSES.join('|')}>.`)
    return null
  }
  return detected
}

/**
 * Which harnesses to wire. An explicit `--harness` still wins as a singleton.
 * Otherwise: every detected harness, or a human picker when detection is empty
 * or names more than one.
 */
async function pickHarnessesToInstall(
  deps: CommandDeps,
  requested?: string,
): Promise<Harness[] | null> {
  if (requested !== undefined) {
    const harness = resolveHarness(deps, requested)
    return harness === null ? null : [harness]
  }
  const detected = detectedHarnesses(deps.cwd, deps.env)
  if (detected.length === 1) return detected
  if (deps.io.interactive === true && deps.io.multiselect) {
    const picked = await deps.io.multiselect(
      'Which agent harnesses should Notifai wire here?',
      HARNESSES.map((name) => ({
        value: name,
        label: HARNESS_LABELS[name],
        ...(detected.includes(name) ? { hint: 'detected on this machine' } : {}),
      })),
      detected,
    )
    if (picked === null) return null
    const unknown = picked.filter((name) => !(HARNESSES as readonly string[]).includes(name))
    if (unknown.length > 0) {
      deps.io.err(`Unknown harness "${unknown[0]}". Supported: ${HARNESSES.join(', ')}.`)
      return null
    }
    return picked as Harness[]
  }
  if (detected.length === 0) {
    deps.io.err(
      `Could not tell which harness to wire. Run: notifai hooks install --harness <${HARNESSES.join('|')}>`,
    )
    return null
  }
  return detected
}

// ---------------------------------------------------------------------------
// config show / set / unset
// ---------------------------------------------------------------------------

export function configShowCommand(
  deps: CommandDeps,
  flags: { json?: boolean; explain?: boolean; plain?: boolean },
): number {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  if (flags.json) {
    const output = Object.fromEntries(
      CONFIG_KEYS.map((key) => [
        key,
        {
          value: config[key].value,
          source: config[key].source,
          summary: configInfo(key).summary,
        },
      ]),
    )
    deps.io.out(JSON.stringify(output, null, 2))
    return EXIT.ok
  }
  // Anything that is not a person at a terminal keeps the flat `key = value`
  // form it has always had. Scripts parse this, and a prettier layout for an
  // audience that cannot see it would only be a breaking change.
  if (deps.io.interactive !== true || flags.plain === true) {
    for (const line of renderConfigPlain(config, flags.explain === true)) deps.io.out(line)
    return EXIT.ok
  }
  for (const line of renderConfigList(config, { showAdvanced: flags.explain === true })) {
    deps.io.out(line)
  }
  return EXIT.ok
}

/**
 * One setting, explained in full.
 *
 * The gap this closes: `config show` prints a value and provenance but that is
 * not enough to explain the setting's consequences. Every key already had a
 * careful explanation — in a TypeScript comment, read by everyone except the
 * person who needed it.
 */
export function configExplainCommand(
  deps: CommandDeps,
  key: string,
  flags: { json?: boolean } = {},
): number {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    deps.io.err(`Unknown setting "${key}".`)
    deps.io.err(`Valid settings: ${CONFIG_KEYS.join(', ')}`)
    return EXIT.usage
  }
  const configKey = key as ConfigKey
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const info = configInfo(configKey)
  const entry = config[configKey]

  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        {
          key: configKey,
          label: info.label,
          group: info.group,
          kind: info.kind,
          summary: info.summary,
          detail: info.detail,
          accepts: acceptedValues(configKey),
          ...(info.choices !== undefined ? { choices: info.choices } : {}),
          value: entry.value,
          source: entry.source,
        },
        null,
        2,
      ),
    )
    return EXIT.ok
  }

  if (deps.io.interactive !== true) {
    deps.io.out(`${configKey} = ${JSON.stringify(entry.value)}  [${entry.source}]`)
    deps.io.out(info.detail.replace(/\n\n/g, '\n'))
    deps.io.out(`accepts: ${acceptedValues(configKey)}`)
    return EXIT.ok
  }
  for (const line of renderConfigExplain(configKey, config)) deps.io.out(line)
  return EXIT.ok
}

/**
 * Closest config key by edit distance, or null when nothing is close.
 *
 * The threshold matters more than the algorithm: suggesting a key that shares
 * three letters with the typo sends the reader to the wrong setting with
 * confidence, which is worse than listing all fourteen and letting them look.
 */
function nearestKey(input: string): string | null {
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of CONFIG_KEYS) {
    const distance = editDistance(input.toLowerCase(), candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(best.length / 3)) ? best : null
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return previous[b.length]!
}

export async function configSetCommand(
  deps: CommandDeps,
  key: string,
  rawValue: string,
  flags: { project?: boolean; local?: boolean; session?: string; yes?: boolean },
): Promise<number> {
  const configKey = configMutationKey(deps, key)
  if (configKey === null) return EXIT.usage
  const info = configInfo(configKey)
  let value: unknown = rawValue
  if (NUMERIC_CONFIG_KEYS.includes(configKey)) {
    const numeric = Number(rawValue)
    if (!Number.isInteger(numeric)) {
      deps.io.err(`${key} takes ${acceptedValues(configKey)}, not "${rawValue}".`)
      return EXIT.usage
    }
    const bounds = configBounds(configKey)
    if (bounds !== undefined && (numeric < bounds.min || numeric > bounds.max)) {
      deps.io.err(`${key} must be between ${bounds.min} and ${bounds.max}.`)
      return EXIT.usage
    }
    value = numeric
  }
  if (BOOLEAN_CONFIG_KEYS.includes(configKey)) {
    if (rawValue !== 'true' && rawValue !== 'false') {
      deps.io.err(`${key} is a toggle — pass "true" or "false", not "${rawValue}".`)
      return EXIT.usage
    }
    value = rawValue === 'true'
  }
  // Enum keys were accepted unchecked, so `config set sound whatever` wrote a
  // value the sender would later reject — a typo that only surfaces at the
  // moment a notification fails to carry the sound you asked for.
  if (info.kind === 'enum' && info.choices !== undefined && !info.choices.includes(rawValue)) {
    deps.io.err(`${key} takes one of: ${info.choices.join(', ')} — not "${rawValue}".`)
    return EXIT.usage
  }
  if (key === 'devices') value = rawValue.split(',').map((s) => s.trim()).filter(Boolean)

  const target = await configMutationTarget(deps, flags)
  if (target === null) return EXIT.usage
  if (target.layer === 'global' && Object.is(value, configDefaultValue(configKey))) {
    deps.io.err(`${key} is already the shipped default (${JSON.stringify(value)}).`)
    deps.io.err(
      `Run \`notifai config unset ${key} --yes\` to remove a redundant override instead of creating one.`,
    )
    return EXIT.usage
  }

  if (!flags.yes) {
    const confirmed = await deps.io.confirm(`Set ${key} = ${JSON.stringify(value)} in ${target.path}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }

  const existing = existsSync(target.path)
    ? (parseToml(readFileSync(target.path, 'utf8')) as Record<string, unknown>)
    : {}
  existing[key] = value
  mkdirSync(path.dirname(target.path), { recursive: true })
  writeFileSync(target.path, `${stringifyToml(existing)}\n`)
  deps.io.out(`Wrote ${key} to ${target.path}`)
  return EXIT.ok
}

function configMutationKey(deps: CommandDeps, key: string): ConfigKey | null {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    deps.io.err(`Unknown setting "${key}".`)
    const near = nearestKey(key)
    if (near !== null) deps.io.err(`Did you mean "${near}"?`)
    deps.io.err(`Valid settings: ${CONFIG_KEYS.join(', ')}`)
    deps.io.err('Run `notifai config explain <key>` to see what one of them does.')
    return null
  }
  return key as ConfigKey
}

type ConfigMutationFlags = { project?: boolean; local?: boolean; session?: string; yes?: boolean }
type ConfigMutationLayer = 'global' | 'project' | 'local' | 'session'

async function configMutationTarget(
  deps: CommandDeps,
  flags: ConfigMutationFlags,
): Promise<{ path: string; layer: ConfigMutationLayer } | null> {
  let layer = flags.local ? 'local' : flags.project ? 'project' : 'global'
  if (
    flags.session === undefined &&
    flags.local !== true &&
    flags.project !== true &&
    flags.yes !== true &&
    deps.io.interactive === true &&
    deps.io.select
  ) {
    const selected = await deps.io.select('Where should this setting live?', [
      { value: 'global', label: 'This machine', hint: 'applies across projects' },
      { value: 'project', label: 'This project (shared)', hint: '.notifai/config.toml' },
      { value: 'local', label: 'This project (personal)', hint: 'stored on this machine, not in the repo' },
    ])
    if (selected === null) {
      deps.io.err('No configuration layer selected.')
      return null
    }
    layer = selected
  }

  const targetPath = flags.session
    ? sessionConfigPath(flags.session, deps.env)
    : layer === 'local'
      ? personalProjectConfigPath(deps.cwd, deps.env)
      : layer === 'project'
        ? (findProjectConfigPath(deps.cwd) ?? path.join(deps.cwd, '.notifai', 'config.toml'))
        : globalConfigPath(deps.env)
  return {
    path: targetPath,
    layer: flags.session ? 'session' : (layer as Exclude<ConfigMutationLayer, 'session'>),
  }
}

export async function configUnsetCommand(
  deps: CommandDeps,
  key: string,
  flags: ConfigMutationFlags,
): Promise<number> {
  const configKey = configMutationKey(deps, key)
  if (configKey === null) return EXIT.usage
  const target = await configMutationTarget(deps, flags)
  if (target === null) return EXIT.usage
  const existing = existsSync(target.path)
    ? (parseToml(readFileSync(target.path, 'utf8')) as Record<string, unknown>)
    : {}
  if (!Object.prototype.hasOwnProperty.call(existing, configKey)) {
    deps.io.out(`${configKey} is not set in ${target.path}`)
    return EXIT.ok
  }
  if (!flags.yes) {
    const confirmed = await deps.io.confirm(`Remove ${configKey} from ${target.path}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }

  delete existing[configKey]
  if (Object.keys(existing).length === 0) {
    rmSync(target.path, { force: true })
  } else {
    writeFileSync(target.path, `${stringifyToml(existing)}\n`)
  }
  deps.io.out(`Removed ${configKey} from ${target.path}; the inherited value now applies.`)
  return EXIT.ok
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

export interface LogsFlags {
  json?: boolean
  limit?: number
  all?: boolean
  since?: string
  level?: string
  event?: string[]
  run?: string
  request?: string
  session?: string
  project?: string
  allProjects?: boolean
  grep?: string
  path?: boolean
  clear?: boolean
}

const LOG_RECORD_OPTIONS: readonly (readonly [keyof LogsFlags, string])[] = [
  ['limit', '--limit'],
  ['all', '--all'],
  ['since', '--since'],
  ['level', '--level'],
  ['event', '--event'],
  ['run', '--run'],
  ['request', '--request'],
  ['session', '--session'],
  ['project', '--project'],
  ['allProjects', '--all-projects'],
  ['grep', '--grep'],
]

/**
 * Deliberately small. The reader is usually a model with a finite context, and
 * a log command whose default answer is ten thousand lines gets used once.
 * Everything beyond this is reachable by asking for it.
 */
const DEFAULT_LOG_LIMIT = 30
/** Even `--all` stops somewhere; an unbounded dump is never the useful answer. */
const MAX_LOG_LIMIT = 2_000

/** `10m`, `2h`, `1d`, or an ISO 8601 instant. */
export function parseSince(raw: string, now: number): number | null {
  const relative = /^(\d+)([smhd])$/.exec(raw.trim())
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = relative[2] as 's' | 'm' | 'h' | 'd'
    const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[unit]
    return now - amount * seconds * 1000
  }
  const absolute = Date.parse(raw)
  return Number.isNaN(absolute) ? null : absolute
}

/**
 * What this machine recorded about itself.
 *
 * The retrieval half of the local log, and the half that decides whether the
 * log is worth having. Three things make it usable by an agent rather than
 * merely available to one: the default is bounded and scoped to this project,
 * the filters match the questions actually asked ("that run", "that
 * notification", "just the failures"), and `--json` gives the machine the
 * records untouched on stdout while every word of explanation goes to stderr.
 */
export function logsCommand(deps: CommandDeps, flags: LogsFlags): number {
  const selectedRetrievalOptions = LOG_RECORD_OPTIONS
    .filter(([key]) => {
      const value = flags[key]
      return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false
    })
    .map(([, name]) => name)

  if (flags.path === true && flags.clear === true) {
    deps.io.err('Pass --path or --clear, not both.')
    return EXIT.usage
  }
  if (flags.path === true && selectedRetrievalOptions.length > 0) {
    deps.io.err(`--path cannot be combined with record options: ${selectedRetrievalOptions.join(', ')}.`)
    return EXIT.usage
  }
  if (flags.clear === true && selectedRetrievalOptions.length > 0) {
    deps.io.err(`--clear cannot be combined with record options: ${selectedRetrievalOptions.join(', ')}.`)
    return EXIT.usage
  }
  if (flags.project !== undefined && flags.allProjects === true) {
    deps.io.err('Pass --project or --all-projects, not both.')
    return EXIT.usage
  }
  if (flags.limit !== undefined && flags.all === true) {
    deps.io.err('Pass --limit or --all, not both.')
    return EXIT.usage
  }
  if (flags.limit !== undefined && (!Number.isInteger(flags.limit) || flags.limit <= 0)) {
    deps.io.err('--limit must be a positive integer.')
    return EXIT.usage
  }
  if (flags.limit !== undefined && flags.limit > MAX_LOG_LIMIT) {
    deps.io.err(`--limit cannot exceed ${MAX_LOG_LIMIT}; narrow the result with --since or filters.`)
    return EXIT.usage
  }

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const now = (deps.now ?? Date.now)()

  if (flags.path === true) {
    const usage = logsDiskUsage(deps.env)
    const archives = archiveLogPaths(deps.env)
    if (flags.json === true) {
      deps.io.out(
        JSON.stringify(
          {
            active: activeLogPath(deps.env),
            archives,
            files: usage.files,
            bytes: usage.bytes,
            level: config.log_level.value,
            max_bytes: config.log_max_bytes.value,
            max_files: config.log_max_files.value,
            local_only: true,
          },
          null,
          2,
        ),
      )
      return EXIT.ok
    }
    deps.io.out(activeLogPath(deps.env))
    for (const archive of archives) deps.io.out(archive)
    deps.io.err(
      `${usage.files} file(s), ${Math.round(usage.bytes / 1024)} KB, level ${config.log_level.value}. These stay on this machine.`,
    )
    return EXIT.ok
  }

  if (flags.clear === true) {
    let removed = 0
    for (const file of [activeLogPath(deps.env), ...archiveLogPaths(deps.env)]) {
      try {
        unlinkSync(file)
        removed += 1
      } catch {
        // Absent, or not ours to remove; either way there is nothing to report.
      }
    }
    deps.io.out(
      flags.json === true
        ? JSON.stringify({ cleared_files: removed })
        : `Cleared ${removed} log file${removed === 1 ? '' : 's'}.`,
    )
    return EXIT.ok
  }

  const query: LogQuery = {
    limit: flags.limit ?? (flags.all === true ? MAX_LOG_LIMIT : DEFAULT_LOG_LIMIT),
  }

  if (flags.since !== undefined) {
    const since = parseSince(flags.since, now)
    if (since === null) {
      deps.io.err(`Could not read "${flags.since}" as a time. Use 10m, 2h, 1d, or an ISO 8601 instant.`)
      return EXIT.usage
    }
    query.since = since
  }
  if (flags.level !== undefined) {
    if (!(RECORD_LEVELS as readonly string[]).includes(flags.level)) {
      deps.io.err(`--level takes one of: ${RECORD_LEVELS.join(', ')} — not "${flags.level}".`)
      return EXIT.usage
    }
    query.level = flags.level as LogLevel
  }
  if (flags.event !== undefined && flags.event.length > 0) {
    const unknown = flags.event.filter((name) => !(LOG_EVENTS as readonly string[]).includes(name))
    if (unknown.length > 0) {
      deps.io.err(`Unknown event ${unknown.join(', ')}. Valid: ${LOG_EVENTS.join(', ')}`)
      return EXIT.usage
    }
    query.event = flags.event
  }
  if (flags.run !== undefined) query.run = flags.run
  if (flags.session !== undefined) query.session = flags.session
  if (flags.request !== undefined) query.request = flags.request
  if (flags.grep !== undefined) query.contains = flags.grep

  // Scoped to this project by default. A machine commonly runs several agents
  // in several worktrees at once, and the answer to "what just happened" is
  // useless if three other projects are interleaved through it.
  const scope =
    flags.project ?? (flags.allProjects === true ? undefined : (config.project.value ?? undefined))
  if (scope !== undefined) query.project = scope

  const result = readLogRecords(deps.env, query)

  if (flags.json === true) {
    for (const record of result.records) deps.io.out(JSON.stringify(record))
  } else {
    for (const record of result.records) deps.io.out(renderRecord(record))
  }

  if (result.records.length === 0) {
    if (config.log_level.value === 'off') {
      deps.io.err('Nothing is being recorded: log_level is off.')
      deps.io.err('Turn it on with `notifai config set log_level info --yes`.')
    } else if (logsDiskUsage(deps.env).files === 0) {
      deps.io.err('No log yet. It is written the next time a notifai command or harness hook runs.')
    } else {
      deps.io.err('No records matched. Widen it with --all-projects, --since 1d, or --all.')
    }
    return EXIT.ok
  }

  // Everything explanatory goes to stderr so `--json` leaves stdout as clean
  // JSONL for whatever is parsing it.
  const notes: string[] = []
  if (scope !== undefined) notes.push(`project ${scope} (--all-projects for every project)`)
  if (result.more) {
    notes.push(
      query.limit! < MAX_LOG_LIMIT
        ? `more history behind this (-n ${Math.min(query.limit! * 4, MAX_LOG_LIMIT)} or --all)`
        : `more history exists beyond the ${MAX_LOG_LIMIT}-record safety cap; narrow with --since or filters`,
    )
  }
  if (config.log_level.value !== 'debug') notes.push('`log_level = debug` records request detail')
  if (notes.length > 0) deps.io.err(`— ${result.records.length} records; ${notes.join('; ')}`)
  return EXIT.ok
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * Where `npx skills add` fetches the optional agent skill from, derived from
 * this build's own version so the pin cannot drift from the release it names.
 * Null when the build cannot establish its version; see `./release.js`.
 */
export const SKILLS_SOURCE: string | null = skillsSource()

/**
 * How to refer to the pin in user-facing text.
 *
 * Only reached in a corrupted install, where naming the tag is impossible but
 * saying nothing would be worse — the sentence still has to read as English.
 */
const SKILLS_SOURCE_LABEL = SKILLS_SOURCE ?? 'the public release tag matching this CLI'

function skillSourceParts(): { source: string; ref: string } | null {
  if (SKILLS_SOURCE === null) return null
  const match = /^([^#]+)#(.+)$/.exec(SKILLS_SOURCE)
  return match === null ? null : { source: match[1]!, ref: match[2]! }
}

function expectedSkill(skill: NativeSkill): boolean {
  const expected = skillSourceParts()
  return (
    expected !== null &&
    skill.name === 'notifai' &&
    skill.source === expected.source &&
    skill.sourceType === 'github' &&
    skill.ref === expected.ref
  )
}

async function skillReadiness(
  deps: CommandDeps,
  selectedScope?: SkillScope,
): Promise<ReadinessState> {
  const scopes: SkillScope[] = selectedScope === undefined ? ['project', 'global'] : [selectedScope]
  const results = await Promise.all(
    scopes.map(async (scope) => {
      if (deps.nativeSkills === undefined) return { scope, skills: [] as NativeSkill[] }
      try {
        return { scope, ...(await deps.nativeSkills.list(scope, deps.cwd, deps.env)) }
      } catch (err) {
        return { scope, skills: [] as NativeSkill[], error: String(err) }
      }
    }),
  )
  const installed = results.flatMap(({ skills }) => skills).find(expectedSkill)
  if (installed !== undefined) {
    return {
      id: 'skill',
      title: 'Agent guidance skill',
      status: 'ready',
      detail: `installed from ${SKILLS_SOURCE_LABEL} in the ${installed.scope} scope`,
    }
  }

  const errors = results
    .filter((result) => result.error !== undefined)
    .map((result) => `${result.scope}: ${result.error}`)
  const scopeText = selectedScope === undefined ? 'project or machine-global scope' : `${selectedScope} scope`
  return {
    id: 'skill',
    title: 'Agent guidance skill',
    status: 'optional-gap',
    detail:
      errors.length > 0
        ? `could not verify installer-managed state in ${scopeText} (${errors.join('; ')})`
        : `not installed from ${SKILLS_SOURCE_LABEL} in ${scopeText}`,
    remedy: {
      by: 'cli',
      summary: 'install the skill agents follow when deciding to notify',
      command:
        selectedScope === undefined
          ? 'notifai init --skills'
          : `notifai init --skills --skills-scope ${selectedScope}`,
    },
  }
}

/** Derive a contract-valid project slug; init alone needs a non-empty fallback. */
export function projectSlugFrom(name: string): string {
  return inferredProjectSlugFrom(name) ?? 'project'
}

export interface InitFlags {
  projectId?: string
  /**
   * Install the agent guidance skill. Tri-state on purpose:
   * true installs, false skips silently, and undefined means "offer it when a
   * human is present, do nothing when one is not" — an unattended run must
   * never spawn npx against the network by default.
   */
  skills?: boolean
  /** Scope selected by an unattended caller; humans choose inside npx skills. */
  skillsScope?: SkillScope
  /** Same tri-state, for the harness hooks. */
  hooks?: boolean
}

interface SetupProofRecord {
  request_id: string
  device_id: string
  project: string | null
  started_at: string
}

/** Long enough for a first TestFlight install; keep-waiting extends another budget. */
const DEVICE_BRIDGE_TIMEOUT_MS = 10 * 60 * 1000
const DEVICE_BRIDGE_POLL_MS = 2_000
const PROOF_TIMEOUT_MS = 30_000
const PROOF_POLL_MS = 1_000

function supportPageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/support`
}

function formatWaitBudget(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/** Same-account line for the device hop; prefers the real email when known. */
function sameAccountSignInLine(email: string | null | undefined): string {
  return email
    ? `sign in with the same email as this account (${email})`
    : 'sign in with the same email as this account'
}

function deviceInstallRemedy(options: {
  baseUrl: string
  email: string | null
  devices: readonly RoutableDevice[]
}): string {
  const support = supportPageUrl(options.baseUrl)
  const sameEmail = sameAccountSignInLine(options.email)
  if (options.devices.length === 0) {
    return (
      `open the install steps at ${support} on your iPhone, ` +
      `install Notifai, ${sameEmail}, and allow notifications`
    )
  }
  if (options.devices.some((d) => d.permission_status === 'denied')) {
    return 'allow notifications for Notifai in iPhone Settings'
  }
  return 'open Notifai on your iPhone and allow its notification prompt'
}

function setupProofPath(deps: CommandDeps): string {
  let projectDir = path.resolve(deps.cwd)
  try {
    projectDir = realpathSync(projectDir)
  } catch {
    // A deleted or not-yet-created cwd cannot collide with a real directory:
    // the resolved absolute path is still a stable local identity for it.
  }
  const digest = createHash('sha256').update(projectDir).digest('hex').slice(0, 32)
  return path.join(stateDir(deps.env), 'setup-proofs', `${digest}.json`)
}

function readSetupProof(deps: CommandDeps): SetupProofRecord | null {
  const file = setupProofPath(deps)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SetupProofRecord>
    return typeof parsed.request_id === 'string' &&
      typeof parsed.device_id === 'string' &&
      (typeof parsed.project === 'string' || parsed.project === null) &&
      typeof parsed.started_at === 'string'
      ? (parsed as SetupProofRecord)
      : null
  } catch {
    // Corrupt local evidence is not readiness. A fresh proof replaces it.
    return null
  }
}

function writeSetupProof(deps: CommandDeps, proof: SetupProofRecord): boolean {
  const file = setupProofPath(deps)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch (err) {
    deps.io.err(
      `Could not save setup proof ${proof.request_id} at ${file}: ${String(err)}`,
    )
    return false
  }
}

function observedCompanionReceipt(
  snapshot: EvidenceSnapshot,
  deviceId: string,
): { delivery: EvidenceSnapshot['deliveries'][number]; observedAt: string } | null {
  const delivery = snapshot.deliveries.find((candidate) => candidate.device_id === deviceId)
  const receipt = delivery?.events.find((event) => event.stage === 'companion_received')
  return delivery && receipt ? { delivery, observedAt: receipt.occurred_at } : null
}

/**
 * The setup coordinator that observes each prerequisite and advances the ones
 * this build can perform.
 *
 * Idempotent by construction: every step first observes, then acts only on the
 * gap, so re-running is how you check the setup as much as how you create it.
 * With a human at a terminal it walks them through the missing pieces; run by
 * an agent it never prompts — each optional step is answered by a flag, and
 * whatever only the user can do (signing in, pairing a companion device) is
 * printed as the next human action. An agent runs every CLI command itself.
 */
/**
 * Close a gap the CLI is allowed to close on its own, without asking.
 *
 * Only reached for `by: 'cli'` remedies, which by definition need no human, so
 * this stays silent about what it did — the re-assessment that follows reports
 * the new state, and narrating both is how a setup log becomes unreadable.
 *
 * `pending` means the action is real but its evidence has not arrived yet;
 * `failed` means the action itself could not be performed.
 */
type GapCloseResult = 'closed' | 'pending' | 'failed'

async function closeGap(
  deps: CommandDeps,
  state: ReadinessState,
  flags: InitFlags,
): Promise<GapCloseResult> {
  if (state.id === 'project') {
    const configPath = path.join(deps.cwd, '.notifai', 'config.toml')
    const existing = existsSync(configPath)
      ? (parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
      : {}
    existing['project'] = projectSlugFrom(flags.projectId ?? path.basename(deps.cwd))
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${stringifyToml(existing)}\n`)
    return 'closed'
  }

  if (state.id === 'hooks') {
    const harnesses = await pickHarnessesToInstall(deps)
    if (harnesses === null || harnesses.length === 0) return 'failed'
    let ok = true
    for (const harness of harnesses) {
      if (hooksInstallCommand(deps, { harness }) !== EXIT.ok) ok = false
    }
    return ok ? 'closed' : 'failed'
  }

  if (state.id === 'skill') {
    if (deps.nativeSkills === undefined) {
      deps.io.err('Skill installation failed — the native `npx skills` flow is unavailable.')
      return 'failed'
    }
    // Refuse rather than reach for a mutable ref: installing the skill from a
    // moving branch is the one outcome the pin exists to prevent.
    if (SKILLS_SOURCE === null) {
      deps.io.err(
        'Skill installation failed — this build cannot determine its own version, so there is no release tag to install from.',
      )
      return 'failed'
    }
    const scopeText = flags.skillsScope === undefined ? 'the scope you choose' : `${flags.skillsScope} scope`
    deps.io.out(`Starting the native npx skills setup for the notifai agent skill (${scopeText})...`)
    const addOptions = {
      source: SKILLS_SOURCE,
      skill: 'notifai',
      cwd: deps.cwd,
      env: deps.env,
      ...(flags.skillsScope === undefined ? {} : { scope: flags.skillsScope }),
    }
    const code = await deps.nativeSkills.add(addOptions)
    if (code !== 0) {
      deps.io.err('Skill installation failed — run it manually with:')
      deps.io.err(
        `  npx skills add ${SKILLS_SOURCE} --skill notifai${
          flags.skillsScope === 'global' ? ' --global' : ''
        }${flags.skillsScope === undefined ? '' : ' --yes'}`,
      )
    }
    return code === 0 ? 'closed' : 'failed'
  }

  if (state.id === 'proof') return await runSetupProof(deps)

  return 'failed'
}

function deviceCanReceive(device: RoutableDevice): boolean {
  const receiveIsFloored =
    device.support?.state === 'must_update' &&
    device.support.affected_operation === 'receive_notifications'
  return (
    !receiveIsFloored &&
    device.registration_healthy &&
    (device.permission_status === 'authorized' || device.permission_status === 'provisional')
  )
}

function readyIosDevices(devices: readonly RoutableDevice[]): RoutableDevice[] {
  return devices.filter((device) => device.platform === 'ios' && deviceCanReceive(device))
}

function deviceBridgeMessage(devices: readonly RoutableDevice[]): string {
  if (devices.length === 0) {
    return 'Waiting for the iPhone app to sign in and register…'
  }
  const denied = devices.find((device) => device.permission_status === 'denied')
  if (denied) return `Waiting for notifications to be allowed on ${denied.display_name}…`
  const undecided = devices.find((device) => device.permission_status === 'not_determined')
  if (undecided) return `Waiting for ${undecided.display_name} to allow the notification prompt…`
  return 'Waiting for an iPhone to become ready…'
}

/**
 * Observe the supported Device Installation path while the user finishes the
 * app-side work. The live bridge is the dashboard `/support` page (TestFlight
 * steps). Interactive runs offer to open it so the user never types the URL;
 * non-interactive/agent paths only print plain text and never wait on a prompt.
 *
 * The wait budget is stated up front. On expiry we say the *timer* expired —
 * not the setup — and offer another budget when a human is present. Agents
 * never hang: this whole path is gated on `io.interactive`, and keep-waiting
 * uses `confirm` which resolves the safe default when not interactive.
 */
async function waitForReadyDevice(deps: CommandDeps, state: ReadinessState): Promise<GapCloseResult> {
  const remedy = state.remedy
  if (deps.io.interactive !== true || remedy?.by !== 'user-elsewhere') return 'pending'

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) {
    deps.io.err('Could not start the companion-device wait: this machine is not signed in.')
    return 'failed'
  }

  const budgetLabel = formatWaitBudget(DEVICE_BRIDGE_TIMEOUT_MS)
  const supportUrl = supportPageUrl(authed.baseUrl)
  await deps.io.note?.(
    [
      state.detail,
      remedy.summary,
      `Install steps (no typing): ${supportUrl}`,
      `I will wait up to ${budgetLabel} for your iPhone to become ready.`,
    ].join('\n'),
    'Finish setup on your iPhone',
  )

  // Open the real support page so the user never has to type the URL. Decline
  // is fine — the URL remains in the note and in the Next: line if they leave.
  if (await deps.io.confirm('Open install instructions in your browser?', true)) {
    deps.io.openUrl(supportUrl)
  }

  if (!(await deps.io.confirm('Wait here while you finish that on your device?', true))) {
    deps.io.out(
      `OK — finish device setup when you can (install steps: ${supportUrl}), then re-run \`notifai init\`.`,
    )
    return 'pending'
  }

  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const spinner = await deps.io.spinner?.(`Waiting up to ${budgetLabel} for your iPhone…`)
  let lastDevices: RoutableDevice[] = []
  let deadline = now() + DEVICE_BRIDGE_TIMEOUT_MS

  for (;;) {
    while (now() < deadline) {
      try {
        const response = await authed.client.listDevices()
        const iphoneDevices = response.devices.filter((device) => device.platform === 'ios')
        lastDevices = iphoneDevices
        const ready = readyIosDevices(iphoneDevices)[0]
        if (ready) {
          spinner?.stop(`${ready.display_name} is ready to receive`)
          return 'closed'
        }
        spinner?.message(deviceBridgeMessage(iphoneDevices))
      } catch (err) {
        if (!(err instanceof NetworkError)) {
          spinner?.error('Could not check companion readiness')
          reportError(deps, err)
          return 'failed'
        }
        spinner?.message('Connection lost — still watching…')
      }
      await sleep(Math.min(DEVICE_BRIDGE_POLL_MS, Math.max(0, deadline - now())))
    }

    // Timer expired — setup did not. Offer another budget only when a human
    // can answer; confirm() already returns the fallback for agents, so this
    // never hangs unattended even if interactive were mis-set.
    spinner?.error(`The ${budgetLabel} wait timer expired`)
    deps.io.err(
      `The ${budgetLabel} wait timer expired — setup is not finished, only this wait.`,
    )
    deps.io.err(deviceBridgeMessage(lastDevices).replace(/…$/, '.'))
    deps.io.err(
      `Re-run \`notifai init\` later and it will pick up from here (install steps: ${supportUrl}).`,
    )

    const keepWaiting = await deps.io.confirm(
      `Keep waiting for another ${budgetLabel}?`,
      false,
    )
    if (!keepWaiting) {
      deps.io.out('Stopping the wait. iPhone setup can continue; re-run `notifai init` when ready.')
      return 'pending'
    }
    spinner?.message(`Waiting another ${budgetLabel} for your iPhone…`)
    deadline = now() + DEVICE_BRIDGE_TIMEOUT_MS
  }
}

function setupProofDraft(
  config: CliConfig,
  device: RoutableDevice,
): ReturnType<typeof buildDraft> {
  const project = config.project.value
  return buildDraft(config, {
    title: 'Notifai is ready',
    body:
      project === null
        ? 'This real notification completed setup verification.'
        : `This real notification completed setup verification for ${project}.`,
    event: 'setup_verified',
    kind: 'update',
    platform: 'ios',
    device: [device.device_id],
    sound: 'none',
    level: 'passive',
    collapseKey: 'notifai-setup-verification',
  })
}

async function submitSetupProof(
  deps: CommandDeps,
  client: ApiClient,
  config: CliConfig,
  device: RoutableDevice,
): Promise<SubmissionReceipt | null> {
  const build = setupProofDraft(config, device)
  if (!build.ok) {
    deps.io.err(`Could not build the setup verification notification: ${build.error}`)
    return null
  }
  const capabilities = CAPABILITIES_V1.describe(build.platform)
  if (!capabilities) {
    deps.io.err(`No capability contract is available for ${build.platform}.`)
    return null
  }
  const validation = validateDraft(build.draft, capabilities)
  if (!validation.ok) {
    for (const issue of validation.errors) {
      deps.io.err(`Setup verification ${issue.path}: ${issue.message}`)
    }
    return null
  }
  try {
    return await client.submit(
      {
        idempotency_key: `init-${randomBytes(12).toString('base64url')}`,
        draft: build.draft,
      },
      config.wait_seconds.value,
    )
  } catch (err) {
    reportError(deps, err)
    return null
  }
}

/**
 * Send or resume one real setup probe, then wait for a Companion Receipt.
 * Provider Acceptance is intentionally insufficient: it proves APNs accepted
 * the push, not that a companion process received it.
 */
async function runSetupProof(deps: CommandDeps): Promise<GapCloseResult> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return 'failed'

  let devices: RoutableDevice[]
  try {
    devices = (await authed.client.listDevices()).devices
  } catch (err) {
    reportError(deps, err)
    return 'failed'
  }
  const candidates = readyIosDevices(devices)
  const existing = readSetupProof(deps)
  const target =
    candidates.find(
      (device) =>
        device.device_id === existing?.device_id && existing.project === config.project.value,
    ) ?? candidates[0]
  if (!target) {
    deps.io.err('Setup proof needs a receipt-capable iPhone.')
    return 'pending'
  }

  let proof =
    existing?.device_id === target.device_id && existing.project === config.project.value
      ? existing
      : null
  if (proof === null) {
    const receipt = await submitSetupProof(deps, authed.client, config, target)
    if (receipt === null) return 'failed'
    if (receipt.overall === 'provider_rejected_all') {
      deps.io.err(formatReceipt(receipt))
      return 'failed'
    }
    proof = {
      request_id: receipt.request_id,
      device_id: target.device_id,
      project: config.project.value,
      started_at: new Date((deps.now ?? Date.now)()).toISOString(),
    }
    if (!writeSetupProof(deps, proof)) return 'failed'
    deps.io.out(`Verification notification sent to ${target.display_name} (${proof.request_id}).`)
  } else {
    deps.io.out(`Checking verification notification ${proof.request_id} again.`)
  }

  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + PROOF_TIMEOUT_MS
  const spinner = deps.io.interactive === true
    ? await deps.io.spinner?.(
        "Waiting for a Companion Receipt (the app's delivery confirmation)…",
      )
    : null
  let lastError: unknown = null
  let replacedMissingProof = false

  for (;;) {
    try {
      const snapshot = await authed.client.evidence(proof.request_id)
      const observed = observedCompanionReceipt(snapshot, proof.device_id)
      if (observed) {
        spinner?.stop(`Receipt observed from ${observed.delivery.device_name}`)
        deps.io.out(
          `Companion Receipt (the app's delivery confirmation) observed from ${observed.delivery.device_name}.`,
        )
        return 'closed'
      }
      lastError = null
    } catch (err) {
      lastError = err
      if (
        err instanceof ApiCallError &&
        err.code === 'not_found' &&
        !replacedMissingProof
      ) {
        const receipt = await submitSetupProof(deps, authed.client, config, target)
        if (receipt === null) return 'failed'
        if (receipt.overall === 'provider_rejected_all') {
          deps.io.err(formatReceipt(receipt))
          return 'failed'
        }
        proof = {
          request_id: receipt.request_id,
          device_id: target.device_id,
          project: config.project.value,
          started_at: new Date(now()).toISOString(),
        }
        if (!writeSetupProof(deps, proof)) return 'failed'
        replacedMissingProof = true
        lastError = null
        deps.io.out(`The saved proof had expired; sent replacement ${proof.request_id}.`)
        continue
      }
      if (!(err instanceof NetworkError)) {
        spinner?.error('Could not read Companion Receipt evidence')
        reportError(deps, err)
        return 'failed'
      }
      spinner?.message('Connection lost — still checking the same request…')
    }

    if (now() >= deadline) break
    await sleep(Math.min(PROOF_POLL_MS, Math.max(0, deadline - now())))
  }

  spinner?.stop('Delivery confirmation not observed yet')
  if (lastError instanceof NetworkError) deps.io.err(lastError.message)
  deps.io.out(
    `Provider accepted the notification; Companion Receipt (the app's delivery confirmation) for ${proof.request_id} was not observed within ${PROOF_TIMEOUT_MS / 1000}s. ` +
      'Proof may still arrive — re-run `notifai init` and it will re-check this same notification.',
  )
  return 'pending'
}

/** Closing a local gap cannot have changed the service, the keychain, or devices. */
function refreshAfterClose(id: string): readonly ReadinessRefresh[] | undefined {
  return id === 'project' || id === 'hooks' || id === 'skill' || id === 'question-routing-settings'
    ? ['local']
    : undefined
}

/** Whether an optional gap should be closed, given flags and who is watching. */
function wantsOptional(deps: CommandDeps, state: ReadinessState, flags: InitFlags): Promise<boolean> {
  // Optional CLI updates are surfaced by doctor or when a missing feature is
  // relevant. Init does not turn them into setup work.
  if (state.id === 'contract') return Promise.resolve(false)
  // Naming the project is init's whole reason to touch the filesystem, costs
  // nothing, and is undone by editing one line — so it is done rather than
  // asked about, for a human and an agent alike.
  if (state.id === 'project') return Promise.resolve(true)
  const explicit = state.id === 'hooks' ? flags.hooks : state.id === 'skill' ? flags.skills : undefined
  if (explicit !== undefined) return Promise.resolve(explicit)
  // An agent is never asked, and never assumed into a change it did not
  // request: silence means no, and the summary says what was skipped.
  if (deps.io.interactive !== true) return Promise.resolve(false)
  const question =
    state.id === 'hooks'
      ? 'Install harness hooks, so questions reach your devices when you are away?'
      : 'Install/update the agent guidance skill through the native npx skills flow?'
  return deps.io.confirm(question, true)
}

/**
 * Setup as one step at a time.
 *
 * The old version ran five steps in a fixed order and ended with a list of
 * everything still outstanding. That is a report, and a report is the wrong
 * output here: someone handed five things to do does none of them, and the
 * order was the script's rather than the dependency graph's — it offered to
 * install hooks after a sign-in that had just failed.
 *
 * So this closes what it can, then surfaces exactly one thing, the first that
 * stands in the way. Re-running advances by one. Idempotence stops being a
 * property to preserve and becomes the mechanism: every decision is derived
 * from observed state, so a partial run, a second project, a fresh worktree
 * and a revoked credential are the same code path arriving at different
 * states rather than four branches to enumerate.
 */
export async function initCommand(deps: CommandDeps, flags: InitFlags): Promise<number> {
  if (
    flags.skillsScope !== undefined &&
    flags.skillsScope !== 'project' &&
    flags.skillsScope !== 'global'
  ) {
    deps.io.err('Invalid skill scope. Choose `project` or `global`.')
    return EXIT.usage
  }
  if (flags.skillsScope !== undefined && flags.skills !== true) {
    deps.io.err('`--skills-scope` requires `--skills`. Choose project or global in the native installer.')
    return EXIT.usage
  }
  if (
    flags.skills === true &&
    deps.io.interactive !== true &&
    flags.skillsScope === undefined
  ) {
    deps.io.err(
      'Unattended skill setup requires an explicit scope: `notifai init --skills --skills-scope project` or `... global`.',
    )
    return EXIT.usage
  }
  await deps.io.intro?.('Notifai setup')

  const skillOpts = flags.skillsScope === undefined ? {} : { skillScope: flags.skillsScope }
  let readiness = await assessReadiness(deps, skillOpts)
  const reassess = (refresh?: readonly ReadinessRefresh[]) =>
    assessReadiness(deps, {
      ...skillOpts,
      ...(refresh === undefined ? {} : { previous: readiness, refresh }),
    })
  let failed = false
  const attempted = new Set<string>()

  // Re-assess after every successful action. This is how a browser approval or
  // companion registration can unlock the next state while the user is still
  // here, without copying the dependency graph into a second setup script.
  for (;;) {
    let advanced = false
    let stop = false

    for (const state of readiness.states) {
      if (state.status === 'ready') continue
      if (state.status === 'unknown') {
        stop = true
        break
      }

      const remedy = state.remedy
      if (remedy === undefined || attempted.has(state.id)) {
        if (state.status === 'gap') stop = true
        if (stop) break
        continue
      }

      if (state.status === 'optional-gap') {
        if (remedy.by !== 'cli' || !(await wantsOptional(deps, state, flags))) continue
        attempted.add(state.id)
        const result = await closeGap(deps, state, flags)
        if (result === 'failed') failed = true
        if (result === 'failed' && state.status === 'optional-gap') {
          readiness = await reassess(refreshAfterClose(state.id))
          advanced = true
          break
        }
        if (result !== 'closed') {
          stop = true
          break
        }
        readiness = await reassess(refreshAfterClose(state.id))
        advanced = true
        break
      }

      if (remedy.by === 'cli') {
        attempted.add(state.id)
        const result = await closeGap(deps, state, flags)
        if (result === 'failed') failed = true
        if (result !== 'closed') {
          stop = true
          break
        }
        readiness = await reassess(refreshAfterClose(state.id))
        advanced = true
        break
      }

      // Its to launch, theirs to complete. Running `init` is the consent; announce
      // and open rather than re-asking. An agent never reaches this path.
      if (
        remedy.by === 'user-here' &&
        remedy.interactive === true &&
        deps.io.interactive === true
      ) {
        attempted.add(state.id)
        deps.io.out('Opening your browser to approve this machine — Ctrl-C to stop.')
        if ((await loginCommand(deps, {})) !== EXIT.ok) {
          failed = true
          stop = true
          break
        }
        readiness = await reassess()
        advanced = true
        break
      }

      if (
        state.id === 'devices' &&
        remedy.by === 'user-elsewhere' &&
        deps.io.interactive === true
      ) {
        attempted.add(state.id)
        const result = await waitForReadyDevice(deps, state)
        if (result === 'failed') failed = true
        if (result !== 'closed') {
          stop = true
          break
        }
        readiness = await reassess()
        advanced = true
        break
      }

      // A human-only remedy is the first blocker for an unattended agent.
      stop = true
      break
    }

    if (stop || !advanced) break
  }

  await printInitClose(deps, readiness, flags)
  const blocker = firstBlocker(readiness)
  if (blocker === null) return failed ? EXIT.failed : EXIT.ok
  return failed || deps.io.interactive !== true ? EXIT.failed : EXIT.ok
}

function isHookSubstate(id: string): boolean {
  return id === 'hooks' || id.startsWith('hooks-') || id === 'question-routing-settings'
}

function leftoverOptionals(readiness: Readiness, flags: InitFlags): ReadinessState[] {
  return readiness.states.filter((state) => {
    if (state.status !== 'optional-gap') return false
    if (isHookSubstate(state.id)) return false
    if (state.id === 'skill' && flags.skills === false) return false
    return true
  })
}

function printOptionalLeftovers(deps: CommandDeps, leftovers: readonly ReadinessState[]): void {
  for (const state of leftovers) {
    deps.io.out(`Optional, not set up — ${remedyLine(state)}`)
  }
}

function questionsWillRoute(readiness: Readiness): boolean {
  const hooks = readiness.states.find((state) => state.id === 'hooks')
  const settings = readiness.states.find((state) => state.id === 'question-routing-settings')
  return hooks?.status === 'ready' && settings?.status !== 'gap'
}

async function printInitClose(
  deps: CommandDeps,
  readiness: Readiness,
  flags: InitFlags,
): Promise<void> {
  const blocker = firstBlocker(readiness)
  const canSend = readiness.states.find((state) => state.id === 'devices')?.status === 'ready'
  const questions = questionsWillRoute(readiness)
  const leftovers = leftoverOptionals(readiness, flags).filter(
    (state) => state.id !== 'contract',
  )

  if (blocker?.id === 'contract') {
    deps.io.out(blocker.detail)
    deps.io.out(UPDATE_CLI_COMMAND)
    await deps.io.outro?.('Update Notifai, then run init again')
    return
  }

  if (deps.io.interactive === true) {
    if (blocker === null) {
      const lines = [
        canSend ? 'You can send notifications.' : 'You are signed in.',
        questions
          ? 'Questions will reach your devices.'
          : 'Questions stay in the terminal until hooks are installed.',
      ]
      await deps.io.note?.(lines.join('\n'), 'Ready')
      printOptionalLeftovers(deps, leftovers)
      deps.io.out(
      questions
        ? 'All set. Agents in this project can notify you and ask you questions.'
        : 'All set. Agents in this project can notify you. Questions stay in the terminal until hooks are installed.',
    )
      await deps.io.outro?.('All set ✨')
      return
    }
    await deps.io.note?.(`${blocker.title} — ${blocker.detail}\n${remedyLine(blocker)}`, 'Next')
    deps.io.out(`Next: ${blocker.title} — ${blocker.detail}`)
    deps.io.out(`  ${remedyLine(blocker)}`)
    if (blocker.remedy?.by === 'user-elsewhere' || blocker.remedy?.by === 'user-here') {
      deps.io.out('  Then re-run `notifai init` and it will pick up from here.')
    }
    await deps.io.outro?.('One step remains (above)')
    return
  }

  if (blocker === null) {
    printOptionalLeftovers(deps, leftovers)
    deps.io.out(
      questions
        ? 'All set. Agents in this project can notify you and ask you questions.'
        : 'All set. Agents in this project can notify you. Questions stay in the terminal until hooks are installed.',
    )
    return
  }
  deps.io.out(`Next: ${blocker.title} — ${blocker.detail}`)
  deps.io.out(`  ${remedyLine(blocker)}`)
  if (blocker.remedy?.by === 'user-elsewhere' || blocker.remedy?.by === 'user-here') {
    deps.io.out('  Then re-run `notifai init` and it will pick up from here.')
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/**
 * Server-owned support policy plus every shipped platform document. Artifact
 * versions and document integers are structured inventory, never routing or a
 * definition of "up to date".
 */
async function compatibilityCheck(client: ApiClient): Promise<ReadinessState> {
  try {
    const [compatibility, documents] = await Promise.all([
      client.compatibility(),
      Promise.all(PLATFORMS.map((platform) => client.capabilities(platform))),
    ])
    const technical = {
      local: {
        cli_version: packageVersion(),
        capabilities: [...SHIPPED_CLI_CAPABILITIES],
      },
      server: compatibility,
      capability_documents: documents.map((document) => ({
        platform: document.platform,
        schema_version: document.schema_version,
      })),
    }
    if (compatibility.cli.state === 'must_update') {
      return {
        id: 'contract',
        title: 'Notifai update',
        status: 'gap',
        detail: "Notifai can't send notifications until you update.",
        technical,
        remedy: {
          by: 'user-here',
          summary: 'update Notifai',
          command: UPDATE_CLI_COMMAND,
        },
      }
    }
    if (compatibility.cli.state === 'update_available') {
      const scheduled = compatibility.cli.reason === 'sunset_scheduled'
      return {
        id: 'contract',
        title: 'Notifai update',
        status: 'optional-gap',
        detail: scheduled
          ? 'Update Notifai soon to keep sending notifications.'
          : 'A newer Notifai is available.',
        technical,
        remedy: {
          by: 'user-here',
          summary: 'update Notifai',
          command: UPDATE_CLI_COMMAND,
        },
      }
    }
    return {
      id: 'contract',
      title: 'Notifai update',
      status: 'ready',
      detail: 'Notifai can send notifications.',
      technical,
    }
  } catch (err) {
    return {
      id: 'contract',
      title: 'Notifai update',
      status: 'optional-gap',
      detail: 'The service is being updated; try again later.',
      technical: {
        error: err instanceof ApiCallError
          ? { code: err.code, status: err.status }
          : String(err),
      },
      remedy: {
        by: 'user-here',
        summary: 'try again after the service update',
        command: 'notifai doctor',
      },
    }
  }
}

function projectReadiness(deps: CommandDeps, config: CliConfig): ReadinessState {
  const configured = config.project.value
  if (configured !== null) {
    return {
      id: 'project',
      title: 'Project identity',
      status: 'ready',
      detail: `"${configured}" (${config.project.source})`,
    }
  }
  const inferred = inferInvocationContext(deps.cwd).project
  if (inferred !== null) {
    return {
      id: 'project',
      title: 'Project identity',
      status: 'optional-gap',
      detail: `"${inferred}" is inferred for each send; init can stamp it into shared config`,
      remedy: {
        by: 'cli',
        summary: 'make the inferred Project identity explicit for every checkout',
        command: 'notifai init',
      },
    }
  }
  return {
    id: 'project',
    title: 'Project identity',
    status: 'optional-gap',
    detail: 'the directory name has no characters a Project identifier can use',
    remedy: {
      by: 'cli',
      summary: 'choose an explicit Project identifier',
      command: 'notifai init --project-id my-project',
    },
  }
}

function remoteStatesFrom(previous: Readiness): {
  credential: ReadinessState
  server: ReadinessState
  contract: ReadinessState
  auth: ReadinessState
  devices: ReadinessState
  proof: ReadinessState
} | null {
  const pick = (id: string): ReadinessState | undefined => previous.states.find((state) => state.id === id)
  const credential = pick('credential')
  const server = pick('server')
  const contract = pick('contract')
  const auth = pick('auth')
  const devices = pick('devices')
  const proof = pick('proof')
  if (
    credential === undefined ||
    server === undefined ||
    contract === undefined ||
    auth === undefined ||
    devices === undefined ||
    proof === undefined
  ) {
    return null
  }
  return { credential, server, contract, auth, devices, proof }
}

function remoteInvalidatedByConfig(previous: Readiness, config: CliConfig): boolean {
  if (config.base_url.source === 'default') return false
  const server = previous.states.find((state) => state.id === 'server')
  return server === undefined || !server.detail.includes(config.base_url.value)
}

/**
 * Read the whole setup once, in dependency order.
 *
 * Descent stops where a prerequisite is missing: without a credential there is
 * nothing to ask the server with, and without a reachable server a contract
 * mismatch is unknowable rather than absent. Those downstream states report
 * `unknown`, which is the honest answer and keeps a network outage from
 * looking like a broken install.
 */
export async function assessReadiness(
  deps: CommandDeps,
  options: {
    skillScope?: SkillScope
    previous?: Readiness
    refresh?: readonly ReadinessRefresh[]
  } = {},
): Promise<Readiness> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const previous = options.previous
  const refresh = options.refresh
  if (previous !== undefined && refresh !== undefined && refresh.length === 0) return previous

  const reuseRemote =
    previous !== undefined &&
    refresh !== undefined &&
    !refresh.includes('remote') &&
    !remoteInvalidatedByConfig(previous, config)
  if (reuseRemote) {
    const reused = remoteStatesFrom(previous)
    if (reused !== null) {
      return {
        states: [
          projectReadiness(deps, config),
          reused.credential,
          reused.server,
          reused.contract,
          reused.auth,
          ...hookStates(deps),
          await skillReadiness(deps, options.skillScope),
          reused.devices,
          reused.proof,
        ],
      }
    }
  }

  const states: ReadinessState[] = []
  let accountClient: ApiClient | null = null
  let accountDevices: RoutableDevice[] | null = null

  states.push(projectReadiness(deps, config))

  const credential = deps.store.load()
  states.push(
    credential
      ? {
          id: 'credential',
          title: 'This machine',
          status: 'ready',
          detail: `paired as "${credential.machineName}" (${deps.store.describe()})`,
        }
      : {
          id: 'credential',
          title: 'This machine',
          status: 'gap',
          detail: 'not paired with your account',
          remedy: {
            by: 'user-here',
            summary: 'sign in — this opens your browser to approve the machine',
            command: 'notifai login',
            interactive: true,
          },
        },
  )

  const baseUrl = resolvedBaseUrl(config, credential)
  const anon = makeClient(deps, baseUrl, null)
  // A probe that throws is unreachable, not a crash: this runs against a
  // half-configured machine by definition, which is where a client that
  // cannot even be constructed properly shows up.
  let reachable = false
  try {
    reachable = await anon.health()
  } catch {
    reachable = false
  }
  states.push(
    reachable
      ? { id: 'server', title: 'Service', status: 'ready', detail: `${baseUrl} reachable` }
      : {
          id: 'server',
          title: 'Service',
          status: 'gap',
          detail: `cannot reach ${baseUrl}`,
          remedy: {
            by: 'user-here',
            summary: 'check your network',
            command: 'notifai doctor',
          },
        },
  )

  if (!reachable || !credential) {
    states.push({
      id: 'contract',
      title: 'Notifai update',
      status: 'unknown',
      detail: !reachable
        ? 'Not checked because the service is unreachable.'
        : 'Not checked because this machine is not paired.',
    })
  } else {
    const compatibilityClient = makeClient(
      deps,
      baseUrl,
      `Bearer nfm_${credential.machineId}.${credential.secret}`,
    )
    states.push(await compatibilityCheck(compatibilityClient))
  }

  let accountEmail: string | null = null
  let accountLookupFailed = false
  if (!credential || !reachable) {
    const why = !credential ? 'this machine is not paired' : 'the server is unreachable'
    states.push({ id: 'auth', title: 'Account', status: 'unknown', detail: `not checked — ${why}` })
  } else {
    const client = makeClient(deps, baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
    accountClient = client
    try {
      const [{ devices }, email] = await Promise.all([
        client.listDevices(),
        Promise.resolve()
          .then(async () => (await client.accessStatus()).email)
          .catch(() => null as string | null),
      ])
      accountDevices = devices
      accountEmail = email
      states.push({
        id: 'auth',
        title: 'Account',
        status: 'ready',
        detail: accountEmail
          ? `machine ${credential.machineId} accepted (${accountEmail})`
          : `machine ${credential.machineId} accepted`,
      })
    } catch (err) {
      // A credential the server rejects is revocation, not absence, and the
      // remedy is the same sign-in either way.
      accountLookupFailed = true
      states.push({
        id: 'auth',
        title: 'Account',
        status: 'gap',
        detail: err instanceof ApiCallError ? `${err.code}: ${err.message}` : String(err),
        remedy: {
          by: 'user-here',
          summary: 'this machine is no longer recognised; pair it again',
          command: 'notifai login',
        },
      })
    }
  }

  // Optional setup that works without a companion device must appear before the
  // device gap: init stops at the first user-elsewhere blocker, and hooks/skill
  // are reachable without a phone.
  states.push(...hookStates(deps))
  states.push(await skillReadiness(deps, options.skillScope))

  if (!credential || !reachable) {
    const why = !credential ? 'this machine is not paired' : 'the server is unreachable'
    states.push({ id: 'devices', title: 'Your devices', status: 'unknown', detail: `not checked — ${why}` })
  } else if (accountLookupFailed || accountDevices === null) {
    states.push({ id: 'devices', title: 'Your devices', status: 'unknown', detail: 'not checked — sign-in failed' })
  } else {
    const devices = accountDevices
    const iphoneDevices = devices.filter((device) => device.platform === 'ios')
    const ready = readyIosDevices(iphoneDevices)
    states.push(
      ready.length > 0
        ? {
            id: 'devices',
            title: 'Your devices',
            status: 'ready',
            detail: `${ready.map((d) => d.display_name).join(', ')} ready to receive`,
          }
        : {
            id: 'devices',
            title: 'Your devices',
            status: 'gap',
            // The one gap that cannot be closed from this terminal, and the
            // likeliest place a first setup is abandoned. Naming which of
            // the three sub-states it is matters: "install the app" is
            // useless advice to someone who installed it and denied the
            // permission prompt. The live bridge is /support on the
            // dashboard origin — not a placeholder, and not typed by hand.
            detail:
              iphoneDevices.length === 0
                ? `no iPhone registered yet; install Notifai on iPhone via ${supportPageUrl(baseUrl)}`
                : `${iphoneDevices.map((d) => `${d.display_name} (${d.permission_status})`).join(', ')} — registered but not able to receive`,
            remedy: {
              by: 'user-elsewhere',
              summary: deviceInstallRemedy({
                baseUrl,
                email: accountEmail,
                devices: iphoneDevices,
              }),
            },
          },
    )
  }

  states.push(await setupProofState(deps, config, accountClient, accountDevices))

  return { states }
}

async function setupProofState(
  deps: CommandDeps,
  config: CliConfig,
  client: ApiClient | null,
  devices: RoutableDevice[] | null,
): Promise<ReadinessState> {
  if (client === null || devices === null) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'unknown',
      detail: 'not checked — account and device readiness must be established first',
    }
  }

  const ios = readyIosDevices(devices)
  if (ios.length === 0) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'unknown',
      detail: 'not checked — no iPhone is ready',
    }
  }

  const proof = readSetupProof(deps)
  const target = proof === null ? null : ios.find((device) => device.device_id === proof.device_id)
  if (proof === null || proof.project !== config.project.value || target === undefined) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'gap',
      detail:
        "no Companion Receipt (the app's delivery confirmation) has proven this project on this machine yet",
      remedy: {
        by: 'cli',
        summary:
          "send one real verification notification and wait for its Companion Receipt (the app's delivery confirmation)",
        command: 'notifai init',
      },
    }
  }

  try {
    const snapshot = await client.evidence(proof.request_id)
    const observed = observedCompanionReceipt(snapshot, proof.device_id)
    if (observed) {
      return {
        id: 'proof',
        title: 'Delivery proof',
        status: 'ready',
        detail: `Companion Receipt (the app's delivery confirmation) observed from ${observed.delivery.device_name} at ${observed.observedAt} (${proof.request_id})`,
      }
    }
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'gap',
      detail: `${proof.request_id} was sent, but its Companion Receipt (the app's delivery confirmation) is still unknown`,
      remedy: {
        by: 'cli',
        summary: 'check the same verification notification again',
        command: 'notifai init',
      },
    }
  } catch (err) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'gap',
      detail: `could not read ${proof.request_id} evidence (${err instanceof ApiCallError ? err.code : String(err)})`,
      remedy: {
        by: 'cli',
        summary: 'retry the existing verification evidence check',
        command: 'notifai init',
      },
    }
  }
}

export async function doctorCommand(
  deps: CommandDeps,
  flags: { json?: boolean },
  options: { readiness?: Readiness } = {},
): Promise<number> {
  const readiness = options.readiness ?? (await assessReadiness(deps))
  const blocker = firstBlocker(readiness)
  const ok = blocker === null

  // A human fallback exists only at a real terminal. Pipes, harnesses and
  // non-TTY callers get the structured agent variant even without --json.
  if (flags.json || deps.io.interactive !== true) {
    deps.io.out(
      JSON.stringify(
        { ok, exit_code: ok ? EXIT.ok : EXIT.failed, states: readiness.states },
        null,
        2,
      ),
    )
    return ok ? EXIT.ok : EXIT.failed
  }

  const line = (s: ReadinessState) => `${s.title}: ${s.detail}`
  await deps.io.intro?.('Notifai doctor')
  for (const s of readiness.states) {
    // Working software says nothing about versions. Soft/hard update states use
    // only the closed sentence and the exact command, never schema/capability
    // vocabulary or a server-provided action.
    if (s.id === 'contract') {
      if (s.status === 'ready' || s.status === 'unknown') continue
      deps.io.out(s.detail)
      if (s.remedy?.by !== 'user-elsewhere' && s.remedy?.command === UPDATE_CLI_COMMAND) {
        deps.io.out(UPDATE_CLI_COMMAND)
      }
      continue
    }
    if (deps.io.check) {
      await deps.io.check(s.status !== 'gap', line(s), doctorTone(s.status))
    } else {
      const mark =
        s.status === 'gap'
          ? 'FAIL'
          : s.status === 'unknown'
            ? '  ? '
            : s.status === 'optional-gap'
              ? '  --'
              : 'ok  '
      deps.io.out(`${mark}  ${line(s)}`)
    }
  }
  await deps.io.outro?.(
    ok
      ? 'Everything looks good'
      : blocker?.id === 'contract'
        ? 'Update Notifai, then run doctor again'
        : `Start with: ${remedyLine(blocker)}`,
  )
  return ok ? EXIT.ok : EXIT.failed
}

/** Readiness status as a report tone. */
function doctorTone(status: StateStatus): Tone {
  switch (status) {
    case 'ready':
      return 'ok'
    case 'gap':
      return 'bad'
    case 'optional-gap':
      return 'warn'
    case 'unknown':
      return 'pending'
  }
}

/** One line telling the reader what to actually do about a state. */
function remedyLine(state: ReadinessState): string {
  const remedy = state.remedy
  if (!remedy) return state.detail
  if (remedy.by === 'user-elsewhere') return remedy.summary
  return remedy.command === undefined
    ? remedy.summary
    : `${remedy.summary} — run \`${remedy.command}\``
}

/**
 * Whether the hook installation is internally ready, plus evidence that a
 * project session has fired it before. This cannot prove future execution or
 * end-to-end notification delivery without a live harness and device test.
 *
 * Every failure mode here was found the expensive way, by spawning a session
 * and watching nothing happen: hooks not installed, installed but never fired,
 * or left behind by an older build that named events this one does not serve.
 */
/**
 * Hook diagnostics as readiness states.
 *
 * A thin adapter over `hookChecks`, whose every branch was found the expensive
 * way and is not worth re-deriving. The judgment added here is which failures
 * actually stand in the way.
 *
 * Not everything failed is in the way. A pointer that has never been
 * published is the normal condition of an install thirty seconds old — the
 * next prompt fixes it and no command can. Treating that as blocking would
 * mean `init` could only finish after a session had already run — so it
 * reports as something worth knowing rather than something to
 * fix, and `init` walks on to the states it can actually close, delivery
 * proof included. Which failures are informational, and what the true remedy
 * is, is each check's own call (`HookCheck`).
 */
function hookStates(deps: CommandDeps): ReadinessState[] {
  const installations = findInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform)
  const active = activeHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)())
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const settings: ReadinessState = {
    id: 'question-routing-settings',
    title: 'Question routing settings',
    status: config.ask_notifications.value ? 'ready' : 'gap',
    detail: [
      `ask_notifications=${config.ask_notifications.value} (${config.ask_notifications.source})`,
      `ask_grace_seconds=${config.ask_grace_seconds.value} (${config.ask_grace_seconds.source})`,
    ].join(', '),
    ...(config.ask_notifications.value
      ? {}
      : {
          remedy: {
            by: 'cli' as const,
            summary: 'enable asynchronous question routing',
            command: 'notifai config set ask_notifications true',
          },
        }),
  }
  if (installations.length === 0) {
    return [
      {
        id: 'hooks',
        title: 'Question routing',
        status: active === null ? 'optional-gap' : 'gap',
        detail:
          active === null
            ? 'hooks not installed, so questions stay in the terminal'
            : `active ${active.label} session detected, but ${active.label} hooks are not installed; \`notifai ask\` cannot route this session`,
        remedy: {
          by: 'cli',
          summary: 'install harness hooks so questions reach your devices when you are away',
          command:
            active === null
              ? 'notifai hooks install'
              : `notifai hooks install --harness ${active.harness}`,
        },
      },
      settings,
    ]
  }

/**
 * A human title per check.
 *
 * Three checks used to collapse onto "Question routing", so a reader could not
 * tell which of them had failed, and the rest fell through to their internal
 * name — `hooks (stale)` beside `Delivery proof`. The `id` stays the stable
 * thing to branch on; this is only what a person reads.
 */
const CHECK_TITLES: Readonly<Record<string, string>> = {
  hooks: 'Question routing',
  'hooks (detected)': 'Harnesses detected',
  'hooks (active harness)': 'Routing for this harness',
  'hooks (active session)': 'Routing for this session',
  'hooks (stale)': 'Hook definitions current',
  'hooks (adapter)': 'Hook adapter',
  'hooks (trust)': 'Codex hook trust',
  'hooks (stop shape)': 'Turn-end hook shape',
  'hooks (duplicates)': 'Duplicate hook installs',
  'hooks (codex representation)': 'Codex hook representation',
  'hooks (question admission)': 'Question admission',
  'hooks (fired)': 'Hooks have run here',
  'hooks (answer continuation)': 'How an answer returns',
  'hooks (wake route)': 'Direct wake route',
}

function checkTitle(name: string): string {
  return CHECK_TITLES[name] ?? name
}

  /** Real but not in the way; see the note above. */
  const informational = new Set<string>()
  return [
    ...hookChecks(deps).map((check) => ({
      id: check.name.replace(/[ ()]+/g, '-').replace(/-$/, ''),
      title: checkTitle(check.name),
      status: check.ok
        ? 'ready' as const
        : check.informational === true || informational.has(check.name)
          ? 'optional-gap' as const
          : 'gap' as const,
      detail: check.detail,
      ...(check.ok
        ? {}
        : {
            remedy: {
              by: 'user-here' as const,
              // The check's own remedy when it has one; the generic reinstall
              // line was wrong exactly where it mattered (an unfired pointer
              // needs a prompt, not `hooks install`).
              ...(check.remedy ?? {
                summary: 'the detail above names what to change',
                command: 'notifai hooks install',
              }),
            },
          }),
    })),
    settings,
  ]
}

/**
 * Whether an installed Stop handler declares the shape its harness needs.
 *
 * The three answers differ, and getting one wrong fails silently in a
 * different way each time:
 *
 *   - Claude Code's handler must be `async: true`, or the waiter holds the
 *     user's turn for its whole wait instead of returning at once. It must
 *     also declare a `timeout`, because the harness default is 600 s and the
 *     kill is silent — the backgrounded waiter vanishes and the answer the
 *     user already gave is never delivered.
 *   - Codex owns its Stop timeout. Declaring one changes the definition it
 *     hashes into `trusted_hash`, and an untrusted handler is simply not run.
 *   - Everything else blocks its turn and needs a ceiling above the wait.
 */
function stopShapeProblems(
  installation: Installation,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (installation.harness === 'codex') return []
  const problems: string[] = []
  for (const handler of installation.handlers.filter(
    (entry) => handlerEvent(entry.command) === 'stop',
  )) {
    if (stopHandlerIsDetached(installation.harness, platform)) {
      if (handler.async !== true) {
        problems.push(
          `${installation.file} declares a blocking Stop handler; the Claude Code wake route needs \`async: true\` so the turn ends while the waiter runs`,
        )
      }
      if (handler.timeout === undefined || handler.timeout < CLAUDE_ASYNC_STOP_TIMEOUT_SECONDS) {
        problems.push(
          `${installation.file} gives Stop ${handler.timeout ?? 'no'} declared seconds; Claude Code then kills the backgrounded waiter at its 600s default without reporting anything, so it needs an explicit ${CLAUDE_ASYNC_STOP_TIMEOUT_SECONDS}s`,
        )
      }
      continue
    }
    if (handler.timeout === undefined || handler.timeout < BLOCKING_STOP_TIMEOUT_SECONDS) {
      problems.push(
        `${installation.file} gives Stop ${handler.timeout ?? 'no'}s, but the blocking answer owner requires ${BLOCKING_STOP_TIMEOUT_SECONDS}s`,
      )
    }
  }
  return problems
}

interface HookCheck {
  name: string
  ok: boolean
  detail: string
  /** Real but not in the way: worth a line, never a blocker. */
  informational?: boolean
  /** A remedy truer than the generic `notifai hooks install`. */
  remedy?: { summary: string; command: string }
}

function hookChecks(deps: CommandDeps): HookCheck[] {
  const checks: HookCheck[] = []
  const installations = findInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform)

  // Not having hooks is a setup someone chose, not a fault: `send` works
  // without them. A setup that cannot work is what deserves to go red.
  if (installations.length === 0) {
    checks.push({
      name: 'hooks',
      ok: true,
      detail: 'not installed (optional) — `notifai hooks install` adds question routing',
    })
    return checks
  }
  checks.push({
    name: 'hooks',
    ok: true,
    detail: installations
      .map((i) => `${i.harness} ${i.global ? 'global' : 'project'} (${i.file})`)
      .join(', '),
  })

  const wired = new Set(installations.map((installation) => installation.harness))
  const unwired = detectedHarnesses(deps.cwd, deps.env).filter((harness) => !wired.has(harness))
  if (unwired.length > 0) {
    checks.push({
      name: 'hooks (detected)',
      ok: false,
      informational: true,
      detail: `${unwired.map((harness) => HARNESS_LABELS[harness]).join(', ')} detected on this machine but not wired`,
      remedy: {
        summary: 'install hooks for every detected harness',
        command: 'notifai hooks install',
      },
    })
  }

  const { active, contested } = resolveActiveHarness(
    deps.env,
    deps.cwd,
    (deps.now ?? Date.now)(),
  )
  const activeInstallations =
    active === null
      ? []
      : installations.filter((installation) => installation.harness === active.harness)
  if (active !== null) {
    checks.push({
      name: 'hooks (active harness)',
      ok: activeInstallations.length > 0,
      detail:
        activeInstallations.length > 0
          ? `active ${active.label} session has a matching hook installation`
          : `active ${active.label} session has no matching hook installation — run \`notifai hooks install --harness ${active.harness}\``,
      ...(activeInstallations.length > 0
        ? {}
        : {
            remedy: {
              summary: `install hooks for the active ${active.label} session`,
              command: `notifai hooks install --harness ${active.harness}`,
            },
          }),
    })
    if (activeInstallations.length > 0) {
      const pointer =
        active.sessionId === undefined
          ? null
          : readMatchingProjectSessionPointer(
              deps.cwd,
              deps.env,
              (deps.now ?? Date.now)(),
              active.sessionId,
              active.harness,
            )
      if (pointer === null) {
        // The normal condition of hooks installed moments ago: the pointer
        // appears when the harness next fires a hook, and no command can
        // force that. Informational, so `init` walks on to the states it can
        // actually prove instead of exiting over evidence only time produces.
        checks.push({
          name: 'hooks (active session)',
          ok: false,
          informational: true,
          detail: `active ${active.label} session has not published a live pointer — send one ${active.label} prompt, then check again`,
          remedy: {
            summary: `send one ${active.label} prompt — its hook publishes the routing pointer`,
            command: 'notifai doctor',
          },
        })
      } else {
        checks.push({
          name: 'hooks (active session)',
          ok: true,
          detail: `the concurrent project index contains the active ${active.label} session`,
        })
      }
    }
  }

  // A handler naming an event this build dropped exits 2 every time the harness
  // fires it, which the harness reports as a hook failure.
  const stale = installations.flatMap((i) =>
    i.handlers
      .filter((h) => {
        const event = handlerEvent(h.command)
        return event !== null && !(HOOK_EVENTS as readonly string[]).includes(event)
      })
      .map((h) => `${h.event} -> ${handlerEvent(h.command)} in ${i.file}`),
  )
  checks.push({
    name: 'hooks (stale)',
    ok: stale.length === 0,
    detail:
      stale.length === 0
        ? 'every installed handler names an event this build serves'
        : `${stale.join('; ')} — rerun \`notifai hooks install\` to drop ${stale.length === 1 ? 'it' : 'them'}`,
  })

  const adapterProblems = installations.flatMap((installation) =>
    (installation.problems ?? []).map((problem) => `${installation.file}: ${problem}`),
  )
  const sharedAdapter = inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform)
  adapterProblems.push(...sharedAdapter.problems)
  if (adapterProblems.length > 0) {
    checks.push({
      name: 'hooks (adapter)',
      ok: false,
      // A machine-global install for a harness that is not active in this
      // project is useful diagnosis, but it must not block unrelated init.
      informational: active === null && installations.every((installation) => installation.global),
      detail: adapterProblems.join('; '),
    })
  }

  const trustProblems = codexTrustProblems(installations, deps.env)
  checks.push({
    name: 'hooks (trust)',
    ok: trustProblems.length === 0,
    detail:
      trustProblems.length === 0
        ? 'best-effort check matches current persisted Codex approvals; Notifai never writes the trust store, and `/hooks` is authoritative'
        : `best-effort check only; Notifai never writes the trust store and \`/hooks\` is authoritative. ${trustProblems.join('; ')}`,
    ...(trustProblems.length === 0
      ? {}
      : {
          remedy: {
            summary: 'open `/hooks` in Codex and approve the changed Notifai handlers',
            command: '/hooks',
          },
        }),
  })

  const shapeProblems = installations.flatMap((installation) =>
    stopShapeProblems(installation, deps.hookPlatform).map(
      (problem) =>
        `${problem} — run \`notifai hooks install --harness ${installation.harness}${installation.global ? ' --global' : ''}\``,
    ),
  )
  checks.push({
    name: 'hooks (stop shape)',
    ok: shapeProblems.length === 0,
    detail:
      shapeProblems.length === 0
        ? `every installed Stop handler declares the shape its harness needs: Claude Code async with an explicit ${CLAUDE_ASYNC_STOP_TIMEOUT_SECONDS}s waiter budget, blocking hosts ${BLOCKING_STOP_TIMEOUT_SECONDS}s, Codex host-owned`
        : shapeProblems.join('; '),
  })

  // Project and global definitions for one harness both fire. Stable adapter
  // identity deliberately makes their command bytes equal, so comparing
  // command targets would now hide this duplicate rather than diagnose it.
  // Different harnesses remain independent: only the active one runs.
  const duplicated = [...new Set(installations.map((i) => i.harness))]
    .map((harness) => ({
      harness,
      installations: installations.filter((i) => i.harness === harness),
    }))
    .filter(
      (entry) =>
        entry.installations.some((installation) => installation.global) &&
        entry.installations.some((installation) => !installation.global),
    )
  if (duplicated.length > 0) {
    checks.push({
      name: 'hooks (duplicates)',
      ok: false,
      detail: duplicated
        .map(
          (entry) =>
            `${entry.harness}: ${entry.installations.length} hook definitions are active, so each event will fire all of them. Keep either project or global routing and uninstall the other: ${entry.installations.map((installation) => installation.file).join(', ')}`,
        )
        .join('; '),
    })
  }

  const representationProblems = codexRepresentationProblems(
    deps.cwd,
    deps.env,
    deps.hookPlatform,
  )
  if (representationProblems.length > 0) {
    checks.push({
      name: 'hooks (codex representation)',
      ok: false,
      detail: representationProblems.join('; '),
    })
  } else {
    const coexistence = codexCoexistenceNotes(deps.cwd, deps.env, deps.hookPlatform)
    if (coexistence.length > 0) {
      checks.push({
        name: 'hooks (codex representation)',
        ok: true,
        detail: coexistence.join('; '),
      })
    }
  }

  const codexHome = codexHomeNote(deps.env, deps.hookPlatform)
  if (codexHome !== null) {
    checks.push({ name: 'hooks (codex home)', ok: true, detail: codexHome })
  }

  if (active !== null && activeInstallations.length > 0) {
    const admissionProblems = activeQuestionRouteProblems(deps, active, installations)
    checks.push({
      name: 'hooks (question admission)',
      ok: admissionProblems.length === 0,
      detail:
        admissionProblems.length === 0
          ? `the active ${active.label} route is exact, current, singular, trusted where applicable, and bounded by a live owner`
          : admissionProblems.join('; '),
    })
  }

  // Which route this judges, and which remedy it prints, must both belong to
  // the harness that is actually running here. A machine-global installation
  // matches every directory, so picking whichever installation matched — or
  // whichever session last wrote a pointer — reports on a harness the agent
  // cannot influence: it is told to send a prompt in a harness that is not
  // running, follows the fail-closed rule, and can never clear the check.
  const firedPointer =
    active === null
      ? readProjectSessionPointer(deps.cwd, deps.env, (deps.now ?? Date.now)())
      : active.sessionId === undefined
        ? (readLiveProjectSessionPointers(deps.cwd, deps.env, (deps.now ?? Date.now)()).find(
            (pointer) => pointer.harness === active.harness,
          ) ?? null)
        : readMatchingProjectSessionPointer(
            deps.cwd,
            deps.env,
            (deps.now ?? Date.now)(),
            active.sessionId,
            active.harness,
          )
  const firedState = firedPointer === null ? null : readSessionState(firedPointer.sessionId, deps.env)
  const promptFired = firedState?.last_prompt_at !== undefined
  const stopFired = firedState?.last_stop_at !== undefined
  const fired = firedPointer !== null && promptFired && stopFired
  // Installations for other harnesses are irrelevant to the active one, and an
  // active harness with none of its own has nothing to activate: say that
  // instead of advising a prompt in some other harness. When the environment
  // is contested and nothing has fired, every candidate is still possible, so
  // the advice covers all of them rather than betting on one.
  const activationHarnesses = new Set(
    contested.length > 1
      ? contested.map((candidate) => candidate.harness)
      : active === null
        ? installations.map((installation) => installation.harness)
        : [active.harness],
  )
  const activationInstallations = installations.filter((installation) =>
    activationHarnesses.has(installation.harness),
  )
  const activationAdvice =
    activationInstallations.length > 0
      ? hookActivationAdvice(activationInstallations)
      : active === null
        ? hookActivationAdvice(installations)
        : `${active.label}: no ${active.label} hook installation matches this project — run \`notifai hooks install --harness ${active.harness}\`.`
  checks.push({
    name: 'hooks (fired)',
    ok: fired,
    // A wholly fresh install is informational. Once UserPromptSubmit has fired,
    // a missing Stop is a broken route, not missing historical evidence.
    informational: firedPointer === null,
    detail: fired
      ? active === null
        ? 'a session in this directory has run UserPromptSubmit and Stop'
        : `the active ${active.label} session has run UserPromptSubmit and Stop`
      : firedPointer === null
        ? `no ${
            contested.length > 1
              ? `session pointer for any harness whose markers are present here (${contested
                  .map((candidate) => candidate.label)
                  .join(', ')})`
              : active === null
                ? 'session pointer'
                : `${active.label} session pointer`
          } from the last 24 hours — ${activationAdvice}`
        : `the routed session has fired ${promptFired ? 'UserPromptSubmit' : 'neither required event'}, but Stop has not been observed — end one harmless turn, send a new prompt, then check again`,
    ...(fired
      ? {}
      : {
          remedy: {
            summary:
              firedPointer === null
                ? `send one ${active === null || contested.length > 1 ? '' : `${active.label} `}prompt in a session here, then re-check`
                : 'end one harmless turn, send a new prompt, then re-check',
            command: 'notifai doctor',
          },
        }),
  })

  const continuationInstallations =
    active !== null ? activeInstallations : installations
  const continuationHarnesses = [
    ...new Set(continuationInstallations.map((installation) => installation.harness)),
  ]
  checks.push({
    name: 'hooks (answer continuation)',
    ok:
      continuationHarnesses.length > 0 &&
      continuationHarnesses.every(
        (harness) => HARNESS_CAPABILITIES[harness].stopContinuation !== 'unsupported',
      ),
    informational: active === null,
    detail:
      continuationHarnesses.length === 0
        ? active === null
          ? 'no installed harness route to assess'
          : `the active ${active.label} session has no matching continuation adapter`
        : continuationHarnesses
            .map((harness) => `${harness}: ${HARNESS_CAPABILITIES[harness].deliveryContract}`)
            .join('; '),
  })

  const wakeRoute = wakeRouteCheck(deps, active, activeInstallations)
  if (wakeRoute !== null) checks.push(wakeRoute)

  const stray = codexStrayWorktreeCheck(deps)
  if (stray !== null) checks.push(stray)

  return checks
}

/**
 * Whether an answer arriving after this turn ends could actually reach this
 * exact session — the question `notifai ask` really turns on, and the one no
 * other check answers.
 *
 * Read-only, and deliberately so: nothing here connects to a socket, takes a
 * lock, or sends a message. A diagnostic that wakes the agent it is diagnosing
 * would be its own bug report.
 *
 * Everything it can report negatively is a degradation rather than a failure —
 * the accepted journal still replays the answer at the session's next turn —
 * so this is never a blocker. What it buys is that the reason has a name
 * before the user notices the silence.
 *
 * It never asks for `crossSessionInbound`. The poster is the session's own
 * hook child and takes the privileged own-child path, verified to be delivered
 * even against a `bypassPermissions` receiver while an unrelated process was
 * held. Widening a user's general inbound policy to suit Notifai would be a
 * real change to their machine's posture in exchange for nothing.
 */
function wakeRouteCheck(
  deps: CommandDeps,
  active: ActiveHarnessSession | null,
  activeInstallations: Installation[],
): HookCheck | null {
  if (active === null || activeInstallations.length === 0) return null
  if (active.harness === 'claude-code') {
    const readiness = inspectClaudeInbox({
      pid: deps.claudeSourcePid ?? claudeSessionPid(deps.env),
      platform: deps.hookPlatform ?? process.platform,
      readDescriptor:
        deps.claudeWake?.readDescriptor ?? systemClaudeWakeAdapters(deps.env).readDescriptor,
      socketExists: (socketPath) => existsSync(socketPath),
    })
    return {
      name: 'hooks (wake route)',
      ok: readiness.state === 'ready',
      informational: true,
      detail:
        readiness.state === 'ready'
          ? `this Claude Code ${readiness.version} session is listening on ${readiness.socketPath}, so an answer can start a turn here without you`
          : `${readiness.reason}. Answers are still delivered, at this session's next turn rather than on their own`,
    }
  }
  if (active.harness === 'codex') {
    const readiness = inspectCodexResume(deps.env, {
      platform: deps.hookPlatform ?? process.platform,
      directoryExists: (directory) => existsSync(directory),
    })
    return {
      name: 'hooks (wake route)',
      ok: readiness.state === 'ready',
      informational: true,
      detail:
        readiness.state === 'ready'
          ? `the held Codex turn continues from its own hook, and after it returns ${readiness.lockDirectory} can prove a stopped thread unowned before resuming it`
          : `the held Codex turn still continues from its own hook, but after it returns nothing can be resumed: ${readiness.reason}. Answers wait for the next turn`,
    }
  }
  return null
}

/**
 * A Codex hooks file sitting in a worktree, which Codex will never read.
 *
 * `settingsFile` now writes to the main repository, so this only fires for a
 * file an older build left behind — but that file is indistinguishable from a
 * working install if you go looking, and it is exactly what made this bug take
 * a day to find. Omitted entirely when there is nothing to say.
 */
function codexStrayWorktreeCheck(
  deps: CommandDeps,
): { name: string; ok: boolean; detail: string } | null {
  const layer = codexLayerDir(deps.cwd)
  if (layer === null) return null
  const root = codexProjectRoot(deps.cwd)
  const project = inspectCodexLayer(codexLayerPaths(false, deps.cwd, deps.env))
  if (project.jsonEvents.length === 0 && project.tomlEvents.length === 0) return null
  const strayJson = path.join(path.dirname(layer), '.codex', 'hooks.json')
  const strayToml = path.join(path.dirname(layer), '.codex', 'config.toml')
  const problems: string[] = []
  if (!existsSync(layer)) {
    problems.push(`${layer} is missing, so Codex never looks for project hooks here`)
  }
  if (existsSync(strayJson) && path.resolve(strayJson) !== path.resolve(project.paths.hooksJson)) {
    problems.push(`${strayJson} is never read — Codex reads ${project.writeTarget} instead`)
  }
  if (existsSync(strayToml) && path.resolve(strayToml) !== path.resolve(project.paths.configToml)) {
    problems.push(`${strayToml} is never read — Codex reads ${project.writeTarget} instead`)
  }
  return {
    name: 'hooks (codex worktree)',
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `worktree wired to the main repository at ${root}`
        : `${problems.join('; ')}. Re-run \`notifai hooks install\` to fix.`,
  }
}

// ---------------------------------------------------------------------------
// production IO
// ---------------------------------------------------------------------------

/**
 * Whether a human is driving this terminal.
 *
 * A TTY alone is NOT that evidence: agent harnesses frequently allocate a PTY
 * for the commands they run, and a prompt shown to an agent does not fail — it
 * hangs, because every prompt library waits on stdin rather than erroring. So
 * this also honours `CI` and an explicit `NOTIFAI_NO_INPUT=1` escape hatch,
 * and every interactive affordance stays strictly optional: anything `init`
 * can ask, a flag can answer.
 */
function isHumanTerminal(env: NodeJS.ProcessEnv): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    (env['CI'] ?? '') === '' &&
    (env['NOTIFAI_NO_INPUT'] ?? '') === ''
  )
}

/**
 * Lazy on purpose: the hook path runs in front of every prompt the user types,
 * and must not pay for a prompt library it will never show.
 */
async function clack() {
  return await import('@clack/prompts')
}

export function realIo(env: NodeJS.ProcessEnv = process.env): CommandIo {
  const interactive = () => isHumanTerminal(env)
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    get interactive() {
      return interactive()
    },
    confirm: async (question, fallback = false) => {
      if (!interactive()) return fallback
      const p = await clack()
      const answer = await p.confirm({ message: question, initialValue: fallback })
      // Ctrl-C mid-prompt arrives as a cancel symbol, not a SIGINT; treat it
      // as the safe answer rather than letting a Symbol escape into logic.
      return p.isCancel(answer) ? false : answer
    },
    select: async (message, options) => {
      if (!interactive()) return null
      const p = await clack()
      const answer = await p.select({ message, options })
      return p.isCancel(answer) ? null : (answer as string)
    },
    multiselect: async (message, options, initial) => {
      if (!interactive()) return null
      const p = await clack()
      const answer = await p.multiselect({
        message,
        options,
        required: true,
        ...(initial !== undefined && initial.length > 0 ? { initialValues: initial } : {}),
      })
      return p.isCancel(answer) ? null : (answer as string[])
    },
    intro: async (title) => {
      if (!interactive()) return
      ;(await clack()).intro(title)
    },
    outro: async (message) => {
      if (!interactive()) return
      ;(await clack()).outro(message)
    },
    note: async (message, title) => {
      if (!interactive()) return
      ;(await clack()).note(message, title)
    },
    spinner: async (message) => {
      if (!interactive()) return null
      const progress = (await clack()).spinner()
      progress.start(message)
      return {
        message: (next) => progress.message(next),
        stop: (next) => progress.stop(next),
        error: (next) => progress.error(next),
      }
    },
    check: async (ok, message, tone) => {
      if (!interactive()) return
      const { log } = await clack()
      switch (tone ?? (ok ? 'ok' : 'bad')) {
        case 'ok':
          return log.success(message)
        case 'warn':
          return log.warn(message)
        case 'pending':
          // Never checked. `log.info` reads as neutral, which is the honest
          // rendering for a state no evidence was gathered about.
          return log.info(message)
        case 'bad':
          return log.error(message)
      }
    },
    openUrl,
  }
}
