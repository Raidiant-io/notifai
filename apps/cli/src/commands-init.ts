import {
  SETUP_NOTIFICATION_COLLAPSE_KEY,
  SETUP_NOTIFICATION_SUMMARY,
  setupNotificationTitle,
} from '@raidiant/notifai-protocol'
import { buildIdentity } from './distribution.js'
import {
  CAPABILITIES_V1,
  validateDraft,
  type RoutableDevice,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { NetworkError, type ApiClient } from './client.js'
import { ensurePrivateDirectory } from './atomic-file.js'
import { personalProjectConfigPath, projectLocation, type CliConfig } from './config.js'
import { projectSlugFrom as inferredProjectSlugFrom } from './invocation-context.js'
import { type SkillScope } from './native-skills.js'
import {
  firstRequiredBlocker,
  isOptionalAutomation,
  isOptionalSetup,
  projectDisabledHere,
  questionRoutingReady,
  readinessJson,
  type Readiness,
  type ReadinessRefresh,
  type ReadinessState,
} from './readiness.js'
import { buildDraft, formatReceipt } from './send.js'
import { loginCommand } from './commands-auth.js'
import {
  EXIT,
  SETUP_COMMAND,
  authedClient,
  loadLoggedConfig,
  reportError,
  resolvedBaseUrl,
  updateCliCommand,
  type CommandDeps,
} from './commands-core.js'
import { readyCompanionDevices } from './commands-devices.js'
import { terminalQr } from './pairing-qr.js'
import {
  COMPANION_INSTALL_URLS,
  deviceNoun,
  plansUrl,
  setupPhoneUrl,
  type CompanionPlatform,
} from './setup-destinations.js'
import { assessReadiness, remedyLine } from './commands-doctor.js'
import { hooksInstallCommand, pickHarnessesToInstall } from './commands-hook-install.js'
import { detectedHarnesses, findInstallations } from './install-hooks.js'
import {
  observedCompanionReceipt,
  observedSetupProof,
  readSetupProof,
  setupProofApplies,
  writeSetupProof,
  type SetupProofRecord,
} from './commands-setup-proof.js'
import { skillInventory } from './commands-skill.js'
import { enableProjectUnlessDisabled, projectBinding, projectEnablementState } from './project-enablement.js'
import { inspectCliInstallations } from './cli-bin.js'
import { hookAdapterTargetsArtifact, inspectHookAdapter, installHookAdapter } from './hook-adapter.js'
import {
  CLAUDE_COMMANDS_STATE_ID,
  claudeCommandRulesInstalled,
  claudeCommandsNotWritten,
  installClaudeCommandRules,
} from './claude-command-approval.js'
import { CODEX_COMMANDS_STATE_ID, installCodexCommandRules } from './codex-command-rules.js'
import { packageVersion } from './release.js'
import {
  HARNESS_LABELS,
  HOOK_INSTALLABLE_HARNESSES,
  SOURCE_CONTEXT_HARNESSES,
  type HookInstallableHarness,
  type SourceContextHarness,
} from './harnesses.js'
import { relayMessage } from './relay-message.js'
import {
  APPROVAL_STOP_MS,
  APPS_QUESTION,
  NO_PROGRESS_STOP_MS,
  NOTIFICATION_GRACE_MS,
  appsQuestionMessage,
  clearSetupRun,
  connectedMessage,
  doneMessage,
  doneTerminalLines,
  expiredStopMessage,
  CODEX_HOOKS_WARNING,
  PHONE_IN_BROWSER_MESSAGE,
  PHONE_IN_BROWSER_TERMINAL_LINE,
  freshSetupRun,
  isSshSession,
  loadAppsChoice,
  loadSetupRun,
  messageDigest,
  noPhoneMessage,
  parseApps,
  partialMessage,
  partialTerminalLines,
  phoneKind,
  phoneWebMessage,
  saveAppsChoice,
  saveSetupRun,
  type DoneFacts,
  type Leftover,
  type PhoneKind,
  type SetupRun,
} from './setup-journey.js'

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/** Derive a contract-valid project slug; init alone needs a non-empty fallback. */
export function projectSlugFrom(name: string): string {
  return inferredProjectSlugFrom(name) ?? 'project'
}

export interface InitFlags {
  /** Emit final readiness on stdout, progress on stderr, and never prompt. */
  json?: boolean
  approval?: string
  approvalEmail?: string
  projectId?: string
  /**
   * Install the agent guidance skill. Tri-state on purpose:
   * true installs, false skips silently, and undefined means "offer it when a
   * human is present, do nothing when one is not" — an unattended run must
   * never place guidance by default.
   */
  skills?: boolean
  /**
   * Where the agent guidance skill is installed. The User owns this
   * choice; lifecycle wiring has no scope of its own and never reads it.
   */
  skillsScope?: SkillScope
  /** Comma-separated explicit harnesses; an existing selection is retained. */
  skillsHarness?: string
  /** Same tri-state, for the harness hooks. */
  hooks?: boolean
  /** Same tri-state, for the Claude Code rules that let Notifai commands run unprompted. */
  claudeCommands?: boolean
  /** Same tri-state, for the Codex rule that lets Notifai commands run outside its sandbox unprompted. */
  codexCommands?: boolean
  /**
   * The agent apps to connect: comma-separated ids, or `detected`. Hooks, the
   * skill (machine-wide) and command approval go into these without asking.
   */
  apps?: string
  /**
   * With --json: keep waiting up to this many seconds while the next step is
   * the User's, somewhere else (approval, phone, notifications, plan).
   */
  wait?: number | string
  /** `--no-open`: never open a page in this computer's browser. */
  open?: boolean
  /** Resolved from `apps` by init itself; not a flag. */
  chosenApps?: readonly HookInstallableHarness[]
}

const DEVICE_BRIDGE_POLL_MS = 2_000
const PLAN_POLL_MS = 5_000
/** How often an unattended `--wait` looks again at a step the User finishes elsewhere. */
const WAIT_POLL_MS = 5_000
/** A short look for the setup notification's receipt; nothing waits on it. */
const PROOF_TIMEOUT_MS = 10_000
const PROOF_POLL_MS = 1_000


/**
 * The setup coordinator that observes each prerequisite and advances the ones
 * this build can perform.
 *
 * Idempotent by construction: every step first observes, then acts only on the
 * gap, so re-running is how you check the setup as much as how you create it.
 * With a human at a terminal it walks them through the missing pieces; run by
 * an agent it never prompts — each optional step is answered by a flag, and
 * whatever only the user can do (signing in, pairing a companion device) is
 * opened in the browser or printed as the next human action. An agent runs
 * every CLI command itself; machine approval uses the same bounded wait.
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
  if (state.id === 'project-enablement') {
    const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
    const binding = projectBinding(deps.cwd, deps.env, config.project.value)
    if (binding === null) return 'failed'
    return enableProjectUnlessDisabled(binding) === 'enabled' ? 'closed' : 'failed'
  }

  if (state.id === 'hooks') {
    const harnesses = flags.chosenApps !== undefined ? [...flags.chosenApps] : await pickHarnessesToInstall(deps)
    if (harnesses === null || harnesses.length === 0) return 'failed'
    let ok = true
    for (const harness of harnesses) {
      if (hooksInstallCommand(deps, { harness, narrate: false }) !== EXIT.ok) ok = false
    }
    return ok ? 'closed' : 'failed'
  }

  if (state.id === 'claude-commands') {
    try {
      installClaudeCommandRules(deps.env)
      return 'closed'
    } catch (err) {
      deps.io.err(`Could not update the Claude Code settings: ${err instanceof Error ? err.message : String(err)}`)
      return 'failed'
    }
  }

  if (state.id === 'codex-commands') {
    try {
      installCodexCommandRules(deps.env, deps.hookPlatform ?? process.platform)
      return 'closed'
    } catch (err) {
      deps.io.err(`Could not write the Codex rules file: ${err instanceof Error ? err.message : String(err)}`)
      return 'failed'
    }
  }

  if (state.id === 'hooks-adapter') {
    const effective = inspectCliInstallations(
      deps.env,
      deps.hookPlatform ?? process.platform,
    ).effective
    if (effective === null || effective.artifact_path === null) return 'failed'
    if (buildIdentity() !== null) {
      const adapter = inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform)
      return adapter.problems.length === 0 && hookAdapterTargetsArtifact(adapter.target, effective.artifact_path) ? 'closed' : 'failed'
    }
    try {
      installHookAdapter(
        { execPath: process.execPath, scriptPath: effective.artifact_path },
        deps.hookAdapterHome,
        deps.hookPlatform ?? process.platform,
      )
      return 'closed'
    } catch (err) {
      deps.io.err(`Could not retarget Question Routing: ${String(err)}`)
      return 'failed'
    }
  }

  if (state.id === 'skill') {
    if (deps.nativeSkills === undefined) {
      deps.io.err('Skill installation failed — the bundled skill installer is unavailable.')
      return 'failed'
    }
    // Refuse rather than guess a release identity. The production adapter uses
    // this only as a human label; it verifies the bundled skill before placement.
    if (packageVersion() === null) {
      deps.io.err(
        'Skill installation failed — this build cannot determine its own version, so there is no release tag to install from.',
      )
      return 'failed'
    }
    // Machine-wide unless the User chose this Project only.
    const installScope = flags.skillsScope ?? 'global'
    const retry = `notifai init --skills --skills-scope ${installScope}`
    const before = skillInventory(deps)
    if (before.error !== undefined) {
      deps.io.err(`Could not inspect installed guidance. Retry with \`${retry}\`.`)
      return 'failed'
    }
    // Without a choice, the harnesses that already load the skill keep it.
    let harnesses: readonly string[] = flags.skillsHarness?.split(',').map((value) => value.trim())
      ?? [...new Set(before.copies.flatMap((copy) => copy.harnesses))]
    // Nothing named and nothing placed yet: the agent apps setup connects, or
    // failing that the ones found on this machine. Never a question.
    if (harnesses.length === 0) harnesses = [...(flags.chosenApps ?? detectedHarnesses(deps.env, deps.hookPlatform ?? process.platform))]
    if (harnesses.length === 0 || harnesses.some((harness) => !(SOURCE_CONTEXT_HARNESSES as readonly string[]).includes(harness))) {
      deps.io.err(`Choose the harnesses for this skill with --skills-harness ${SOURCE_CONTEXT_HARNESSES.join(',')}.`)
      return 'failed'
    }
    deps.io.out(`Installing the bundled notifai agent skill (${installScope} scope)...`)
    const operation = await deps.nativeSkills.place({ scope: installScope, harnesses: harnesses as SourceContextHarness[],
      cwd: deps.cwd, env: deps.env }).catch((error: unknown) => ({ code: 1, error: String(error) }))
    if ((typeof operation === 'number' ? operation : operation.code) !== 0) {
      deps.io.err(typeof operation === 'number'
        ? `Skill installation failed. Retry with \`${retry}\`.`
        : `Skill installation refused — ${operation.error}. Retry with \`${retry}\`.`)
      return 'failed'
    }
    // Every other copy on the machine is Notifai's too; bring it current.
    const refreshed = await deps.nativeSkills.refresh({ cwd: deps.cwd, env: deps.env })
    const after = skillInventory(deps)
    const placed = harnesses.every((harness) => after.copies.some((copy) => copy.scopes.includes(installScope) &&
      copy.condition === 'current' && copy.harnesses.includes(harness as SourceContextHarness)))
    if (!refreshed.ok || !placed || after.copies.some((copy) => copy.condition !== 'current')) {
      deps.io.err(refreshed.error ?? `The installed guidance could not be verified. Retry with \`${retry}\`.`)
      return 'failed'
    }
    return 'closed'
  }

  return 'failed'
}

function deviceBridgeMessage(devices: readonly RoutableDevice[]): string {
  if (devices.length === 0) {
    return 'Waiting for the Notifai app to sign in…'
  }
  const denied = devices.find((device) => device.permission_status === 'denied')
  if (denied) return `Waiting for notifications to be allowed on ${denied.display_name}…`
  const undecided = devices.find((device) => device.permission_status === 'not_determined')
  if (undecided) return `Waiting for ${undecided.display_name} to allow notifications…`
  return `Waiting for ${devices[0]!.display_name} to finish connecting…`
}

/** How many Companion Apps this Account has registered, on any platform. */
async function registeredCompanions(client: ApiClient): Promise<number> {
  try {
    const response = await client.listDevices()
    return response.devices.length
  } catch {
    // Unreachable here means unreachable for the wait that follows; ask, so a
    // User with nothing installed still gets the platform-specific steps.
    return 0
  }
}

/**
 * Which phone the notifications should arrive on.
 *
 * Asked in the User's words, here, so the destination this terminal opens is
 * already about their phone rather than an index they have to choose from
 * again on the other screen. This selection is only offered at a human terminal.
 */
async function askCompanionPlatform(deps: CommandDeps): Promise<CompanionPlatform | null> {
  if (deps.io.interactive !== true || deps.io.select === undefined) return null
  const selected = await deps.io.select('Where do you want to receive notifications?', [
    { value: 'iphone', label: 'iPhone' },
    { value: 'android', label: 'Android' },
  ])
  return selected === 'iphone' || selected === 'android' ? selected : null
}

/** What a phone's notification permission means for setup right now. */
type PermissionVerdict =
  | { kind: 'other' }
  | { kind: 'wait' }
  | { kind: 'off'; phone: PhoneKind; name: string }

interface DeviceFacts {
  device_id?: string
  display_name: string
  platform: unknown
  permission_status: string
}

/**
 * Missing notification permission does not stop setup. A phone that signed
 * in moments ago and has not answered the prompt yet is given a short while;
 * after that, or once the User said no, setup finishes and its last message
 * says notifications are off. The service does not say when a phone
 * registered, so the first time this run saw it stands in.
 */
function permissionVerdict(devices: readonly DeviceFacts[], run: SetupRun, now: number): PermissionVerdict {
  const seen = (run.first_seen ??= {})
  for (const device of devices) {
    const key = device.device_id ?? device.display_name
    if (seen[key] === undefined) seen[key] = now
  }
  const off = devices.filter((device) => device.permission_status === 'denied' || device.permission_status === 'not_determined')
  if (off.length === 0) return { kind: 'other' }
  const deciding = off.some((device) => device.permission_status === 'not_determined' &&
    now - (seen[device.device_id ?? device.display_name] ?? now) < NOTIFICATION_GRACE_MS)
  if (deciding) return { kind: 'wait' }
  return { kind: 'off', phone: phoneKind(off[0]!.platform), name: off[0]!.display_name }
}

/** The devices gap, once permission is all that is missing and the grace is over, stops blocking. */
function applyNotificationGrace(readiness: Readiness, run: SetupRun, now: number): Readiness {
  return {
    ...readiness,
    states: readiness.states.map((state) => {
      if (state.id !== 'devices' || state.status !== 'gap' || state.remedy?.by !== 'user-elsewhere') return state
      const technical = (state.technical ?? {}) as { devices?: DeviceFacts[] }
      if (!Array.isArray(technical.devices) || technical.devices.length === 0) return state
      const verdict = permissionVerdict(technical.devices, run, now)
      if (verdict.kind !== 'off') return state
      const { message: _message, ...rest } = state
      void _message
      return {
        ...rest,
        status: 'optional-gap',
        detail: `${verdict.name} is signed in, but notifications are off`,
        technical: { ...technical, notifications_off: verdict.phone },
      }
    }),
  }
}

/**
 * Codex's own `/hooks` approval is the User's, in Codex, and setup never
 * waits for it: during setup it is a warning the done message carries, not a
 * gap. `doctor` still reports it as one.
 */
function codexTrustAsWarning(readiness: Readiness): Readiness {
  return {
    ...readiness,
    states: readiness.states.map((state) => state.id === 'hooks-trust' && state.status === 'gap'
      ? { ...state, status: 'optional-gap', message: CODEX_HOOKS_WARNING }
      : state),
  }
}

/** The pieces setup needs to send the User to the browser for their phone. */
interface PhonePage {
  url: string
  open: boolean
}

/**
 * Observe the supported Device Installation path while the user finishes the
 * app-side work. A computer that was already connected when setup started
 * sends the User to the browser's guided phone steps. Otherwise the bridge is
 * a QR the phone scans straight to the store for the platform they named.
 *
 * The wait ends after 30 minutes without anything changing; setup then says
 * what is left and stops. Only reached with a human at the terminal.
 */
async function waitForReadyDevice(
  deps: CommandDeps,
  state: ReadinessState,
  run: SetupRun,
  phonePage: PhonePage | null,
  planRequired: boolean,
): Promise<GapCloseResult | 'stopped'> {
  const remedy = state.remedy
  if (deps.io.interactive !== true || remedy?.by !== 'user-elsewhere') return 'pending'

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) {
    deps.io.err('Could not start the companion-device wait: this machine is not signed in.')
    return 'failed'
  }

  // A phone that is registered but silent needs its permission allowed, not
  // install steps — and asking which phone would be asking about one they are
  // already holding.
  const needsPhone = (await registeredCompanions(authed.client)) === 0
  if (needsPhone && phonePage !== null) {
    deps.io.out('This computer is already connected.')
    if (phonePage.open && !(run.opened ?? []).includes('phone')) {
      deps.io.openUrl(phonePage.url)
      run.opened = [...(run.opened ?? []), 'phone']
    }
    if ((run.opened ?? []).includes('phone')) {
      deps.io.out('Opened your browser to set up your phone.')
      deps.io.out(`  Didn't open? ${phonePage.url}`)
    } else {
      deps.io.out(`Open this on your computer to set up your phone: ${phonePage.url}`)
    }
  } else if (needsPhone && run.phone_in_browser === true) {
    // The approval page this setup opened walks the phone steps with its
    // own sign-in QR; a store QR here would be a second, competing one.
    deps.io.out(PHONE_IN_BROWSER_TERMINAL_LINE)
  } else {
    const platform = needsPhone ? await askCompanionPlatform(deps) : null
    if (needsPhone && platform === null) return 'pending'
    const installUrl = platform === null ? null : COMPANION_INSTALL_URLS[platform]
    const technical = state.technical as { account_email?: unknown } | null | undefined
    const email = typeof technical?.account_email === 'string' ? technical.account_email : null
    // One QR and one line in the User's words. The state's own detail and
    // summary are written for a report and would say the same step twice.
    if (platform === null || installUrl === null) {
      await deps.io.note?.(`${remedy.summary.charAt(0).toUpperCase()}${remedy.summary.slice(1)}.`, 'Finish on your phone')
    } else {
      await deps.io.note?.(
        `${(await terminalQr(installUrl)).trimEnd()}\n` +
          `Scan with your phone's camera to get Notifai, then sign in with ${email ?? 'the email you used for this computer'} and allow notifications.`,
        `Get Notifai on your ${deviceNoun(platform)}`,
      )
    }
  }

  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const spinner = await deps.io.spinner?.(needsPhone ? 'Waiting for your phone…' : deviceBridgeMessage([]))
  let progress = ''
  let since = now()

  for (;;) {
    try {
      const response = await authed.client.listDevices()
      const ready = readyCompanionDevices(response.devices)[0]
      if (ready) {
        spinner?.stop(`${ready.display_name} is ready to receive`)
        return 'closed'
      }
      // Without a plan a Companion App (the desktop app above all) cannot
      // finish connecting; allowed notifications are all this step can
      // prove, and the plan step that follows does the rest.
      const allowed = planRequired
        ? response.devices.find((device) => device.permission_status === 'authorized' || device.permission_status === 'provisional')
        : undefined
      if (allowed) {
        spinner?.stop(`${allowed.display_name} is set up; it receives once your plan is active`)
        return 'closed'
      }
      const verdict = permissionVerdict(response.devices, run, now())
      if (verdict.kind === 'off') {
        spinner?.stop(`${verdict.name} is signed in; notifications are off`)
        return 'closed'
      }
      const message = response.devices.length === 0 && needsPhone ? 'Waiting for your phone…' : deviceBridgeMessage(response.devices)
      if (message !== progress) {
        progress = message
        since = now()
      }
      spinner?.message(message)
    } catch (err) {
      if (!(err instanceof NetworkError)) {
        spinner?.error('Could not check companion readiness')
        reportError(deps, err)
        return 'failed'
      }
      spinner?.message('Connection lost — still watching…')
    }
    if (now() - since >= NO_PROGRESS_STOP_MS) {
      spinner?.error('Stopped waiting for your phone')
      return 'stopped'
    }
    await sleep(DEVICE_BRIDGE_POLL_MS)
  }
}

/**
 * The plan is the last step. A person at the terminal is waited for while
 * they choose it in the app or on the web, for 30 minutes at most.
 */
async function waitForPlan(deps: CommandDeps, state: ReadinessState): Promise<GapCloseResult | 'stopped'> {
  if (deps.io.interactive !== true) return 'pending'
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return 'failed'
  const technical = (state.technical ?? {}) as { access_url?: unknown }
  const url = typeof technical.access_url === 'string' ? technical.access_url : plansUrl(authed.baseUrl)
  deps.io.out('Last step: choose a plan in the Notifai app on your phone.')
  deps.io.out(`  Or on the web: ${url}`)
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const spinner = await deps.io.spinner?.('Waiting for your plan…')
  const since = now()
  for (;;) {
    try {
      if ((await authed.client.accessStatus()).status === 'active') {
        spinner?.stop('Your plan is active')
        return 'closed'
      }
    } catch (err) {
      if (!(err instanceof NetworkError)) {
        spinner?.error('Could not check your plan')
        reportError(deps, err)
        return 'failed'
      }
    }
    if (now() - since >= NO_PROGRESS_STOP_MS) {
      spinner?.error('Stopped waiting for your plan')
      return 'stopped'
    }
    await sleep(PLAN_POLL_MS)
  }
}

/**
 * The notification that says a machine is set up — sent once per Approved
 * Machine, never per Project, so it only ever arrives when setup actually
 * finished somewhere new.
 *
 * It names the machine because that is the news: the User may run agents on
 * several, and "your agents can reach you" from one they set up weeks ago
 * reads as a mystery rather than a milestone. It carries no Project, because
 * nothing about it is Project-specific. It arrives the way their
 * notifications will: `done` is the honest kind, and it lets the server pick
 * the sound through its own kind and Account layers instead of this command
 * stamping one.
 */
function setupProofDraft(
  config: CliConfig,
  machineName: string,
  device: RoutableDevice,
): ReturnType<typeof buildDraft> {
  return buildDraft(config, {
    projectless: true,
    title: setupNotificationTitle(machineName),
    summary: SETUP_NOTIFICATION_SUMMARY,
    kind: 'done',
    platform: device.platform,
    device: [device.device_id],
    // Noticeable, not intrusive: a normal banner and sound. Deliberately not
    // `time_sensitive` — the Setup notification has no business breaking a Focus.
    //
    // Android has no caller-selected interruption level. Explicit null keeps an
    // Apple preference in config from leaking into this Android-only proof.
    level: device.platform === 'ios' ? 'active' : null,
    collapseKey: SETUP_NOTIFICATION_COLLAPSE_KEY,
  })
}

async function submitSetupProof(
  deps: CommandDeps,
  client: ApiClient,
  config: CliConfig,
  device: RoutableDevice,
): Promise<SubmissionReceipt | null> {
  const machineName = deps.store.load()?.machineName ?? 'This computer'
  const build = setupProofDraft(config, machineName, device)
  if (!build.ok) {
    deps.io.err(`Could not build the Setup notification: ${build.error}`)
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
      deps.io.err(`Setup notification ${issue.path}: ${issue.message}`)
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
 * Send the setup notification once, then briefly watch for its Companion
 * Receipt. It confirms a setup that is already complete, so it goes to a
 * device at most once per machine: never re-sent by a rerun or while its
 * receipt is awaited, and not sent at all when the browser's setup page (or
 * an earlier run) already sent one. A send the push service refused is tried
 * once more, after the device is seen again; that is the last try. An
 * unconfirmed receipt is no failure. A send that fails or is refused is
 * reported through `onState` (it says something real about delivery), and so
 * is a notification sent elsewhere.
 */
async function runSetupProof(
  deps: CommandDeps,
  onState: (state: ReadinessState) => void,
): Promise<GapCloseResult> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  // Readiness already reports the proof as skipped here; this guard keeps the
  // promise even if a gap reaches this closer: nothing is sent from a Project
  // the User disabled, the setup notification included.
  const binding = projectBinding(deps.cwd, deps.env, config.project.value)
  if (binding !== null && projectEnablementState(binding) === 'disabled') {
    deps.io.out(`Skipping the test notification: Notifai is disabled for Project "${binding.project}", so nothing is sent from here.`)
    return 'pending'
  }
  const authed = authedClient(deps, config)
  if (!authed) return 'failed'

  let devices: RoutableDevice[]
  try {
    devices = (await authed.client.listDevices()).devices
  } catch (err) {
    reportError(deps, err)
    return 'pending'
  }
  const candidates = readyCompanionDevices(devices)
  const now = deps.now ?? Date.now
  // Sent once already, to a device still here: never again, except the one
  // retry of a refused send once that device has been seen since.
  const existing = readSetupProof(deps)
  let retry: SetupProofRecord | null = null
  if (setupProofApplies(existing, candidates.map((device) => device.device_id))) {
    if (existing.companion_receipt.state === 'observed') return 'closed'
    if (existing.rejected === undefined || existing.rejected.retried) return 'pending'
    const device = candidates.find((candidate) => candidate.device_id === existing.device_id)!
    const seen = device.last_seen_at === null ? Number.NaN : Date.parse(device.last_seen_at)
    if (!(seen > Date.parse(existing.rejected.at))) {
      onState(proofRejectedState(device))
      return 'pending'
    }
    retry = existing
  } else {
    // The browser's Done step (or a run whose record is gone) already sent it.
    const sentAt = await setupNotificationSentAt(authed.client)
    if (sentAt !== null) {
      onState({ id: 'proof', title: 'Test notification', status: 'ready', detail: `already sent at ${sentAt}` })
      return 'closed'
    }
  }
  const target = retry === null ? candidates[0] : candidates.find((candidate) => candidate.device_id === retry.device_id)
  if (!target) return 'pending'

  const interactive = deps.io.interactive === true
  const spinner = interactive
    ? await deps.io.spinner?.(`Sending a test notification to ${target.display_name}…`)
    : null
  const receipt = await submitSetupProof(deps, authed.client, config, target)
  if (receipt === null || receipt.overall === 'provider_rejected_all') {
    spinner?.error(`The test notification to ${target.display_name} did not go through`)
    if (receipt !== null) deps.io.err(formatReceipt(receipt))
    if (receipt !== null) {
      // Kept, so nothing sends it again until the device reconnects, and
      // then only once.
      writeSetupProof(deps, {
        request_id: receipt.request_id,
        device_id: target.device_id,
        started_at: new Date(now()).toISOString(),
        companion_receipt: { state: 'unknown', observed_at: null },
        rejected: { at: new Date(now()).toISOString(), retried: retry !== null },
      })
      // The retry was the last try: setup goes on without it.
      if (retry !== null) return 'pending'
    }
    onState(receipt === null
      ? {
          id: 'proof',
          title: 'Test notification',
          status: 'gap',
          detail: `the test notification to ${target.display_name} could not be sent`,
          remedy: { by: 'cli', summary: 'run setup again to retry it', command: 'notifai init' },
        }
      : proofRejectedState(target))
    return 'failed'
  }
  const proof: SetupProofRecord = {
    request_id: receipt.request_id,
    device_id: target.device_id,
    started_at: new Date(now()).toISOString(),
    companion_receipt: { state: 'unknown', observed_at: null },
  }
  // A record that cannot be saved would make the next run send again.
  if (!writeSetupProof(deps, proof)) {
    spinner?.stop(`Test notification sent to ${target.display_name}`)
    return 'pending'
  }
  if (!interactive) deps.io.out(`Test notification sent to ${target.display_name} (${proof.request_id}).`)

  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + PROOF_TIMEOUT_MS
  for (;;) {
    try {
      const observed = observedCompanionReceipt(await authed.client.evidence(proof.request_id), proof.device_id)
      if (observed) {
        writeSetupProof(deps, observedSetupProof(proof, observed.observedAt))
        if (spinner) spinner.stop(`${observed.delivery.device_name} got the test notification`)
        else deps.io.out(`Companion Receipt (the app's delivery confirmation) observed from ${observed.delivery.device_name}.`)
        return 'closed'
      }
    } catch (err) {
      // The send went through; not being able to watch for its receipt is no
      // reason to keep anyone waiting.
      if (!(err instanceof NetworkError)) break
    }
    if (now() >= deadline) break
    await sleep(Math.min(PROOF_POLL_MS, Math.max(0, deadline - now())))
  }
  if (spinner) spinner.stop(`Test notification sent to ${target.display_name}`)
  else deps.io.out(`Its Companion Receipt (the app's delivery confirmation) was not observed within ${PROOF_TIMEOUT_MS / 1000}s; setup does not depend on it.`)
  return 'pending'
}

/** The phone's push service refused the setup notification: the User opens the app, setup retries once. */
function proofRejectedState(device: RoutableDevice): ReadinessState {
  return {
    id: 'proof',
    title: 'Test notification',
    status: 'gap',
    detail: `${device.display_name} could not receive the test notification: its push delivery was rejected`,
    message: `Your ${deviceNoun(device.platform)} couldn't get the test notification.\n\n**Open Notifai on it**, and I'll try again.`,
    remedy: {
      by: 'user-elsewhere',
      summary: `open Notifai on ${device.display_name} so it can reconnect, then run setup again`,
    },
  }
}

/**
 * Whether this computer's setup notification already went out in the last
 * day, from the browser's setup page or an earlier run. A service that
 * cannot say (older, or unreachable) counts as no.
 */
async function setupNotificationSentAt(client: ApiClient): Promise<string | null> {
  try {
    const sentAt = (await client.setupNotification()).sent_at
    return typeof sentAt === 'string' ? sentAt : null
  } catch {
    return null
  }
}

/** Closing a local gap cannot have changed the service, the keychain, or devices. */
function refreshAfterClose(id: string): readonly ReadinessRefresh[] | undefined {
  return id === 'project-enablement' || id === 'hooks' || id.startsWith('hooks-') || id === 'skill' || id === 'question-routing-settings' || id === 'claude-commands' || id === 'codex-commands'
    ? ['local']
    : undefined
}

/** The optional states init offers with a yes/no question of their own. */
function isOffered(id: string): boolean {
  // Every other hook sub-state is a report line about routing, not an errand
  // with a yes/no question of its own; offering the hooks question for one of
  // them would ask about something the answer does not change.
  return id === 'hooks' || id === 'skill' || id === 'claude-commands' || id === 'codex-commands'
}

function explicitChoice(state: ReadinessState, flags: InitFlags): boolean | undefined {
  return state.id === 'hooks' ? flags.hooks
    : state.id === 'skill' ? flags.skills
      : state.id === 'claude-commands' ? flags.claudeCommands
        : state.id === 'codex-commands' ? flags.codexCommands
          : undefined
}

/** Whether an optional gap should be closed, given flags and who is watching. */
function wantsOptional(deps: CommandDeps, state: ReadinessState, flags: InitFlags): Promise<boolean> {
  // Optional CLI updates are surfaced by doctor or when a missing feature is
  // relevant. Init does not turn them into setup work.
  if (state.id === 'contract') return Promise.resolve(false)
  if (state.id === 'project') return Promise.resolve(false)
  if (state.id === 'project-enablement') return Promise.resolve(true)
  // The setup notification is a confirmation, not a choice: sent unasked.
  if (state.id === 'proof') return Promise.resolve(true)
  if (!isOffered(state.id)) return Promise.resolve(false)
  const explicit = explicitChoice(state, flags)
  if (explicit !== undefined) return Promise.resolve(explicit)
  // An agent is never asked, and never assumed into a change it did not
  // request: silence means no, and the summary says what was skipped.
  if (deps.io.interactive !== true) return Promise.resolve(false)
  const question =
    state.id === 'hooks'
      ? 'Connect your agents to Notifai, so they notify you on their own and their questions reach you when you are away? This adds Notifai hooks to your agent apps.'
      : state.id === 'claude-commands'
        ? 'Let Claude Code run Notifai\'s own commands without asking each time? Otherwise a question can wait at a permission prompt while you are away.'
        : state.id === 'codex-commands'
          ? 'Let Codex run Notifai\'s own commands outside its sandbox without asking each time? Otherwise a question can wait at a permission prompt while you are away.'
          : 'Give your agents the Notifai skill, which tells them when and how to notify you?'
  return deps.io.confirm(question, true)
}

/** The one state whose remedy places files a scope choice is about. */
function needsSkillScope(state: ReadinessState): boolean {
  return state.id === 'skill'
}

function isSkillScope(value: string | undefined): value is SkillScope {
  return value === 'project' || value === 'global'
}

/**
 * Skill-scope flags are checked before anything runs, because a contradiction
 * is a usage error and reporting it after half a setup is worse than reporting
 * it now. Answering the question is a separate step (`scopeForSkillInstall`).
 *
 * Lifecycle wiring has no scope: it is installed for this machine, and whether
 * it does anything in a Project is Project Enablement's question.
 */
function checkSkillScopeFlags(deps: CommandDeps, flags: InitFlags): SkillScope | undefined | 'usage' {
  if (flags.skillsHarness !== undefined && (flags.skills !== true ||
      flags.skillsHarness.split(',').some(agent => !(SOURCE_CONTEXT_HARNESSES as readonly string[]).includes(agent.trim())))) {
    deps.io.err(`--skills-harness requires --skills and comma-separated supported harness names: ${SOURCE_CONTEXT_HARNESSES.join(', ')}.`)
    return 'usage'
  }
  if (flags.skillsScope !== undefined && !isSkillScope(flags.skillsScope)) {
    deps.io.err('Invalid skill scope. Choose `project` or `global`.')
    return 'usage'
  }
  if (flags.skillsScope !== undefined && flags.skills !== true) {
    deps.io.err('`--skills-scope` requires `--skills`.')
    return 'usage'
  }
  return flags.skillsScope
}

/**
 * Where the agent guidance skill lands: machine-wide, unless the User chose
 * this Project only with `--skills-scope project`. Never a question: an
 * earlier setup asked it of someone who had met none of these words.
 */
function scopeForSkillInstall(flags: InitFlags): SkillScope {
  return flags.skillsScope ?? 'global'
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
  const json = flags.json === true
  const workingDeps: CommandDeps = json
    ? {
        ...deps,
        io: {
          interactive: false,
          out: (line) => deps.io.err(line),
          err: (line) => deps.io.err(line),
          confirm: async () => false,
          openUrl: (url) => deps.io.openUrl(url),
        },
      }
    : deps
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const startedAt = now()
  const waitMs = parseWaitSeconds(flags.wait)
  if (waitMs === 'usage') {
    workingDeps.io.err('`--wait` takes a whole number of seconds between 0 and 3600.')
    return EXIT.usage
  }
  // A terminal run already waits for each step by itself; a flag that would
  // parse and then do nothing is refused instead.
  if (waitMs !== null && !json) {
    workingDeps.io.err('`--wait` works with `--json`; without it, setup waits for each step by itself.')
    return EXIT.usage
  }
  const hostPlatform = deps.hookPlatform ?? process.platform
  const detected = detectedHarnesses(deps.env, hostPlatform)
  let apps: HookInstallableHarness[] | null = null
  if (flags.apps !== undefined) {
    const parsed = parseApps(flags.apps, detected)
    if (typeof parsed === 'string') {
      workingDeps.io.err(parsed)
      return EXIT.usage
    }
    apps = parsed
  }
  const scopeFromFlags = checkSkillScopeFlags(workingDeps, flags)
  if (scopeFromFlags === 'usage') return EXIT.usage
  let resolved: InitFlags = { ...flags }
  // An agent continues one setup run across reruns; a terminal run is one process.
  const run = json ? loadSetupRun(deps.env, startedAt) : freshSetupRun(startedAt)
  const waitMode = json && waitMs !== null
  // Pages open for a person at this terminal or an agent's run; a plain
  // unattended script only prints them. Over SSH the browser would open on
  // the remote machine, so the link is given instead.
  const openPages = flags.open !== false && !isSshSession(deps.env) && (json || deps.io.interactive === true)
  await workingDeps.io.intro?.('Notifai setup')

  // Project inference is the default and writes nothing. An explicit id is the
  // User's own Project setting, stored on this machine outside the checkout,
  // the same file `config set project <id> --local` writes.
  if (resolved.projectId !== undefined) {
    if (projectLocation(workingDeps.cwd, workingDeps.env) === null) {
      workingDeps.io.err('Your home folder is never a Project. Run this from inside the Project\'s folder.')
      return EXIT.usage
    }
    const configPath = personalProjectConfigPath(workingDeps.cwd, workingDeps.env)
    const existing = existsSync(configPath)
      ? (parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
      : {}
    existing['project'] = projectSlugFrom(resolved.projectId)
    ensurePrivateDirectory(path.dirname(configPath))
    writeFileSync(configPath, `${stringifyToml(existing)}\n`)
  }

  // Which agent apps to connect is the one question setup asks. Apps already
  // connected are the answer on a later run. An agent that passes the older
  // per-piece flags keeps the behavior those flags always had.
  const installed = installedApps(deps)
  const legacyChoice = flags.hooks !== undefined || flags.skills !== undefined || flags.claudeCommands !== undefined ||
    flags.codexCommands !== undefined || flags.skillsHarness !== undefined || flags.skillsScope !== undefined
  let askApps = false
  // An answer to the apps question is kept, "none" included, so a later run
  // never asks it again.
  let answered = apps !== null
  if (apps === null && !(json && legacyChoice)) {
    const remembered = installed.length > 0 ? null : loadAppsChoice(deps.env)
    if (installed.length > 0) apps = installed
    else if (remembered !== null) apps = remembered
    else if (workingDeps.io.interactive === true) {
      answered = true
      apps = workingDeps.io.multiselect === undefined
        ? [...detected]
        : appsFrom(await workingDeps.io.multiselect(
            APPS_QUESTION,
            HOOK_INSTALLABLE_HARNESSES.map((app) => ({
              value: app,
              label: HARNESS_LABELS[app],
              ...(detected.includes(app) ? { hint: 'found' } : {}),
            })),
            [...detected],
          ))
    } else if (json) askApps = true
  }
  if (answered && apps !== null) saveAppsChoice(deps.env, apps, startedAt)
  // The older flags saying no to hooks are an answer too: no agent apps.
  else if (apps === null && flags.hooks === false && installed.length === 0) saveAppsChoice(deps.env, [], startedAt)

  let failed = false
  if (apps !== null) {
    resolved = { ...resolved, chosenApps: apps }
    resolved.hooks = flags.hooks ?? apps.length > 0
    resolved.claudeCommands = flags.claudeCommands ?? apps.includes('claude-code')
    resolved.codexCommands = flags.codexCommands ?? apps.includes('codex')
    if (flags.skills === undefined) {
      resolved.skills = apps.length > 0
      const inventory = skillInventory(workingDeps)
      const missing = apps.filter((app) => !inventory.copies.some((copy) => copy.condition === 'current' &&
        copy.harnesses.includes(app as SourceContextHarness)))
      if (missing.length > 0 && flags.skillsHarness === undefined) {
        resolved.skillsScope = flags.skillsScope ?? 'global'
        resolved.skillsHarness = missing.join(',')
      }
    }
    // Hooks first, for every chosen app not connected yet, before the
    // approval: none of it needs the computer to be connected.
    if (resolved.hooks === true) {
      for (const app of apps) {
        if (installed.includes(app)) continue
        if (hooksInstallCommand(workingDeps, { harness: app, narrate: false }) !== EXIT.ok) failed = true
      }
    }
  }

  const skillOpts = () => ({ ...(resolved.skillsScope === undefined ? {} : { skillScope: resolved.skillsScope }),
    ...(resolved.skillsHarness === undefined ? {} : { skillHarnesses: resolved.skillsHarness.split(',').map(value => value.trim()) }) })
  const assess = async (refresh?: readonly ReadinessRefresh[], previous?: Readiness): Promise<Readiness> =>
    codexTrustAsWarning(applyNotificationGrace(await assessReadiness(workingDeps, {
      ...skillOpts(),
      ...(json ? { json: true } : {}),
      ...(refresh === undefined || previous === undefined ? {} : { previous, refresh }),
    }), run, now()))
  let readiness = await assess()

  if (askApps) {
    const question = appsGapState(detected)
    readiness = { ...readiness, states: [question, ...readiness.states] }
    run.relayed = messageDigest(question.message!)
    saveSetupRun(deps.env, run, now())
    deps.io.out(JSON.stringify({ ...readinessJson(readiness), message: question.message, waiting: false, stopped: false, apps: null }, null, 2))
    return EXIT.failed
  }

  const reassess = (refresh?: readonly ReadinessRefresh[]) => assess(refresh, readiness)
  // What actually stopped a sign-in, when something did. Without it the close
  // renders the state as it was before the attempt — "not paired … run
  // `notifai init`" — which contradicts the correct line printed moments
  // earlier and sends the reader back into the command that just failed.
  let loginBlocker: ReadinessState | null = null
  const attempted = new Set<string>()
  // Offers the User answered no to in this run: the close does not offer
  // them straight back.
  const declined = new Set<string>()
  // What this run learned about the setup notification beyond the
  // assessment: a send that failed or was refused (the one outcome that says
  // something real about delivery), or one already sent elsewhere.
  let proofState: ReadinessState | null = null
  // A wait that ended with nothing changing, and what it leaves for later.
  let stoppedLeft: Leftover | 'approval' | null = null
  let connected: { email: string | null } | null = null
  const deadline = startedAt + (waitMs ?? 0)

  /** The local pieces for the chosen apps, before anything that needs the User. */
  const LOCAL_SETUP = new Set(['hooks', 'skill', CLAUDE_COMMANDS_STATE_ID, CODEX_COMMANDS_STATE_ID])
  if (apps !== null) {
    for (;;) {
      const state = readiness.states.find((candidate) => LOCAL_SETUP.has(candidate.id) &&
        (candidate.status === 'gap' || candidate.status === 'optional-gap') &&
        candidate.remedy?.by === 'cli' && !attempted.has(candidate.id))
      if (state === undefined) break
      attempted.add(state.id)
      if (!(await wantsOptional(workingDeps, state, resolved))) {
        declined.add(state.id)
        continue
      }
      if (needsSkillScope(state)) resolved = { ...resolved, skillsScope: scopeForSkillInstall(resolved) }
      if (await closeGap(workingDeps, state, resolved) === 'failed') failed = true
      readiness = await reassess(refreshAfterClose(state.id))
    }
  }

  const phonePage = (): PhonePage | null => {
    // Approved during this run: the browser page already walks the phone steps.
    if (run.connected_in_run === true) return null
    const credential = deps.store.load()
    if (credential === null) return null
    const config = loadLoggedConfig(workingDeps, { cwd: deps.cwd, env: deps.env })
    return {
      url: setupPhoneUrl(resolvedBaseUrl(config, credential), accountEmail(readiness), credential.machineId, credential.machineName),
      open: openPages,
    }
  }

  // Re-assess after every successful action. This is how a browser approval or
  // companion registration can unlock the next state while the user is still
  // here, without copying the dependency graph into a second setup script.
  const pass = async (): Promise<void> => {
    for (;;) {
      let advanced = false
      let stop = false

      for (const state of readiness.states) {
        if (state.status === 'ready') continue
        // Question Routing is optional automation, so it is reported and never
        // waited on. `doctor` still fails on a broken route; `init` walks past
        // it, because a hook diagnostic standing in front of the delivery proof
        // means a setup that can already send never proves that it can.
        const optional = isOptionalSetup(state.id)
        const halt = () => {
          if (!optional) stop = true
          return !optional
        }
        if (state.status === 'unknown') {
          if (halt()) break
          continue
        }

        const remedy = state.remedy
        if (remedy === undefined || attempted.has(state.id)) {
          if (state.status === 'gap' && halt()) break
          continue
        }

        if (state.status === 'optional-gap') {
          if (remedy.by !== 'cli') continue
          if (!(await wantsOptional(workingDeps, state, resolved))) {
            // Answered once per run: a later pass never asks again.
            attempted.add(state.id)
            if (isOffered(state.id)) declined.add(state.id)
            continue
          }
          if (needsSkillScope(state)) resolved = { ...resolved, skillsScope: scopeForSkillInstall(resolved) }
          attempted.add(state.id)
          const result = state.id === 'proof'
            ? await runSetupProof(workingDeps, (observed) => { proofState = observed })
            : await closeGap(workingDeps, state, resolved)
          if (result === 'failed') failed = true
          if (result === 'failed') {
            readiness = await reassess(refreshAfterClose(state.id))
            advanced = true
            break
          }
          if (result !== 'closed') {
            if (halt()) break
            continue
          }
          readiness = await reassess(refreshAfterClose(state.id))
          advanced = true
          break
        }

        if (remedy.by === 'cli') {
          if (needsSkillScope(state)) resolved = { ...resolved, skillsScope: scopeForSkillInstall(resolved) }
          attempted.add(state.id)
          const result = await closeGap(workingDeps, state, resolved)
          if (result === 'failed') failed = true
          if (result === 'failed' && state.id === 'skill') {
            readiness = await reassess(refreshAfterClose(state.id))
            advanced = true
            break
          }
          if (result !== 'closed') {
            if (halt()) break
            continue
          }
          readiness = await reassess(refreshAfterClose(state.id))
          advanced = true
          break
        }

        // The CLI starts approval and opens it in the browser; the User
        // approves there or in the app. Both callers wait the same bounded way.
        if (
          (state.id === 'credential' || state.id === 'auth') &&
          remedy.by === 'user-here' &&
          remedy.interactive === true
        ) {
          attempted.add(state.id)
          const loginResult = await loginCommand(workingDeps, {
            ...(resolved.approval ? { approval: resolved.approval } : {}),
            ...(resolved.approvalEmail ? { approvalEmail: resolved.approvalEmail } : {}),
            guided: {
              open: openPages,
              stopAfterMs: APPROVAL_STOP_MS,
              // An agent hears about a new code at once, and otherwise waits
              // as long as it asked to.
              waitUntil: (pending) => {
                const message = relayMessage(pending)
                return waitMode && message !== null && messageDigest(message) === run.relayed ? deadline : now()
              },
              onConnected: (email, browserOpened) => {
                connected = { email }
                run.connected_in_run = true
                if (browserOpened) run.phone_in_browser = true
              },
            },
          }, (blocker) => {
            loginBlocker = blocker
            // Both renderers must report what actually stopped approval: the
            // access errand when the Account has none, or the approval still
            // waiting in the browser — never the missing credential observed
            // before the attempt began.
            readiness = {
              states: readiness.states.map((observed) => observed.id === blocker.id
                ? blocker
                : blocker.id === 'auth' && observed.id === 'credential'
                  ? { id: 'credential', title: 'This machine', status: 'unknown', detail: 'approval stopped before a machine credential was stored' }
                  : observed),
            }
          })
          if (loginResult !== EXIT.ok) {
            const outcome = (loginBlocker as ReadinessState | null)?.technical as { pairing_outcome?: unknown } | undefined
            if (outcome?.pairing_outcome === 'stopped') stoppedLeft = 'approval'
            failed = true
            stop = true
            break
          }
          loginBlocker = null
          readiness = await reassess()
          advanced = true
          break
        }

        if (state.id === 'devices' && remedy.by === 'user-elsewhere') {
          attempted.add(state.id)
          if (workingDeps.io.interactive === true) {
            const result = await waitForReadyDevice(workingDeps, state, run, phonePage(), readiness.states.some(isPlanState))
            if (result === 'failed') failed = true
            if (result === 'stopped') stoppedLeft = 'phone'
            if (result !== 'closed') {
              stop = true
              break
            }
            readiness = await reassess()
            advanced = true
            break
          }
          // The computer was connected before this run: the browser's guided
          // phone steps, opened once.
          const page = phonePage()
          const devices = ((state.technical ?? {}) as { devices?: unknown[] }).devices ?? []
          if (page !== null && page.open && devices.length === 0 && !(run.opened ?? []).includes('phone')) {
            workingDeps.io.openUrl(page.url)
            run.opened = [...(run.opened ?? []), 'phone']
          }
          if (halt()) break
          continue
        }

        if (isPlanState(state) && remedy.by === 'user-elsewhere' && workingDeps.io.interactive === true) {
          attempted.add(state.id)
          const result = await waitForPlan(workingDeps, state)
          if (result === 'failed') failed = true
          if (result === 'stopped') stoppedLeft = 'plan'
          if (result !== 'closed') {
            stop = true
            break
          }
          readiness = await reassess()
          advanced = true
          break
        }

        // A human-only remedy is the first blocker for an unattended agent.
        if (halt()) break
        continue
      }

      if (stop || !advanced) break
    }
  }

  const withProofState = (): Readiness => {
    const failure = proofState as ReadinessState | null
    return failure === null
      ? readiness
      : { ...readiness, states: readiness.states.map((state) => state.id === 'proof' ? failure : state) }
  }
  const view = (): JourneyView => journeyView(withProofState(), loginBlocker, run, phonePage(), deps)

  await pass()

  // An agent's wait: while the next step is the User's, elsewhere, look again
  // until something changes, its wait is up, or 30 minutes pass with nothing.
  if (waitMode) {
    for (;;) {
      if (stoppedLeft !== null || connected !== null) break
      const current = view()
      if (current.kind !== 'wait' || current.key.startsWith('credential')) break
      if (run.progress_key !== current.key) {
        run.progress_key = current.key
        run.progress_since = now()
      }
      if (now() - (run.progress_since ?? now()) >= NO_PROGRESS_STOP_MS) {
        stoppedLeft = current.left
        break
      }
      if (messageDigest(current.message) !== run.relayed || now() >= deadline) break
      await sleep(Math.min(current.pollMs, Math.max(0, deadline - now())))
      for (const id of ['devices', 'auth', 'proof', 'credential']) attempted.delete(id)
      proofState = null
      readiness = await assess()
      await pass()
    }
  }

  // An explicit yes is never dropped silently: when the rules could not be
  // added, say why in plain words.
  if (flags.claudeCommands === true) {
    const notWritten = claudeCommandsNotWritten(
      readiness.states.find((state) => state.id === CLAUDE_COMMANDS_STATE_ID),
      claudeCommandRulesInstalled(workingDeps.env),
      attempted.has(CLAUDE_COMMANDS_STATE_ID),
    )
    if (notWritten !== null) workingDeps.io.out(notWritten)
  }

  readiness = withProofState()
  const blocker = loginBlocker ?? firstRequiredBlocker(readiness)
  const final = view()
  const facts = doneFacts(readiness, resolved.chosenApps ?? installedApps(deps), deps)
  const phoneUrl = phonePage()?.url ?? setupPhoneUrl(
    resolvedBaseUrl(loadLoggedConfig(workingDeps, { cwd: deps.cwd, env: deps.env }), deps.store.load()),
    facts.email,
    deps.store.load()?.machineId ?? null,
    deps.store.load()?.machineName ?? null,
  )
  let message: string | null
  let waiting = false
  const stoppedAt = stoppedLeft as Leftover | 'approval' | null
  if (stoppedAt !== null) {
    message = stoppedAt === 'approval' ? expiredStopMessage() : partialMessage(stoppedAt, facts.email, phoneUrl)
    clearSetupRun(deps.env)
  } else if (final.kind === 'done') {
    message = projectDisabledHere(readiness) ? null : doneMessage(facts)
    clearSetupRun(deps.env)
  } else if (final.kind === 'wait') {
    waiting = waitMode
    message = final.message
    if (waitMode) {
      if (messageDigest(message) === run.relayed) message = null
      else run.relayed = messageDigest(message)
    }
    if (json) saveSetupRun(deps.env, run, now())
  } else {
    message = final.message
    clearSetupRun(deps.env)
  }
  const joined = connected as { email: string | null } | null
  if (joined !== null) message = [connectedMessage(joined.email), message].filter((part) => part !== null).join('\n\n')

  if (json) {
    deps.io.out(JSON.stringify({
      ...readinessJson(readiness),
      message,
      waiting,
      stopped: stoppedAt !== null,
      apps: resolved.chosenApps ?? null,
    }, null, 2))
  } else {
    await printInitClose(deps, readiness, resolved, loginBlocker, declined, {
      stopped: stoppedAt,
      facts,
      phoneUrl,
    })
  }
  if (blocker === null) return failed ? EXIT.failed : EXIT.ok
  return failed || workingDeps.io.interactive !== true || stoppedAt !== null ? EXIT.failed : EXIT.ok
}

/** `--wait <seconds>`, in milliseconds; null when absent. */
function parseWaitSeconds(value: number | string | undefined): number | null | 'usage' {
  if (value === undefined) return null
  const seconds = typeof value === 'number' ? value : /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) return 'usage'
  return seconds * 1000
}

function appsFrom(picked: readonly string[] | null): HookInstallableHarness[] {
  return HOOK_INSTALLABLE_HARNESSES.filter((app) => (picked ?? []).includes(app))
}

/** The agent apps Notifai is connected to on this machine. */
function installedApps(deps: CommandDeps): HookInstallableHarness[] {
  const found = new Set(findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).map((item) => item.harness))
  return HOOK_INSTALLABLE_HARNESSES.filter((app) => found.has(app))
}

/** The first gap of a setup that has not chosen its agent apps yet. */
function appsGapState(detected: readonly HookInstallableHarness[]): ReadinessState {
  return {
    id: 'apps',
    title: 'Agent apps',
    status: 'gap',
    detail: 'the User has not chosen which agent apps to connect',
    message: appsQuestionMessage(detected),
    technical: {
      supported: HOOK_INSTALLABLE_HARNESSES.map((id) => ({ id, name: HARNESS_LABELS[id] })),
      detected: [...detected],
    },
    remedy: {
      by: 'user-here',
      summary: 'ask the User which agent apps to connect, then run setup again with them',
      command: 'notifai init --json --apps <ids>',
    },
  }
}

function isPlanState(state: ReadinessState | null | undefined): boolean {
  const technical = state?.technical
  return state?.id === 'auth' && typeof technical === 'object' && technical !== null &&
    (technical as { plan_required?: unknown }).plan_required === true
}

/** The Account email the assessment saw, wherever it saw it. */
function accountEmail(readiness: Readiness): string | null {
  for (const id of ['auth', 'devices']) {
    const technical = readiness.states.find((state) => state.id === id)?.technical as { account_email?: unknown } | undefined
    if (typeof technical?.account_email === 'string') return technical.account_email
  }
  return null
}

function doneFacts(readiness: Readiness, apps: readonly HookInstallableHarness[], deps: CommandDeps): DoneFacts {
  const devices = readiness.states.find((state) => state.id === 'devices')
  const off = (devices?.technical as { notifications_off?: PhoneKind } | undefined)?.notifications_off
  const status = (id: string) => readiness.states.find((state) => state.id === id)?.status
  return {
    email: accountEmail(readiness),
    notificationsOff: devices?.status === 'optional-gap' && off !== undefined ? off : null,
    apps,
    codexNeedsApproval: status('hooks-trust') !== 'ready',
    commandApps: apps.filter((app) => (app === 'claude-code' && status(CLAUDE_COMMANDS_STATE_ID) === 'ready') ||
      (app === 'codex' && status(CODEX_COMMANDS_STATE_ID) === 'ready')),
    mac: (deps.hookPlatform ?? process.platform) === 'darwin',
  }
}

type JourneyView =
  | { kind: 'done' }
  /** The User's step, elsewhere: setup can watch for it. */
  | { kind: 'wait'; key: string; message: string; pollMs: number; left: Leftover }
  /** Anything else: say it and end the turn. */
  | { kind: 'stop'; message: string | null }

/** What the agent says now, and whether setup can watch for the User's step. */
function journeyView(
  readiness: Readiness,
  loginBlocker: ReadinessState | null,
  run: SetupRun,
  phonePage: PhonePage | null,
  deps: CommandDeps,
): JourneyView {
  void deps
  const blocker = loginBlocker ?? firstRequiredBlocker(readiness)
  if (blocker === null) return { kind: 'done' }
  const technical = (blocker.technical ?? {}) as { pairing_outcome?: unknown; pairing?: { code?: unknown }; devices?: unknown[] }
  const message = relayMessage(blocker)
  if (blocker.id === 'credential' && technical.pairing_outcome === 'pending' && message !== null) {
    return { kind: 'wait', key: `credential:${String(technical.pairing?.code)}`, message, pollMs: WAIT_POLL_MS, left: 'phone' }
  }
  if (blocker.id === 'devices' && blocker.remedy?.by === 'user-elsewhere') {
    const email = accountEmail(readiness)
    const none = (technical.devices ?? []).length === 0
    const text = none
      ? phonePage !== null
        ? phoneWebMessage(email, phonePage.url, (run.opened ?? []).includes('phone'))
        : run.phone_in_browser === true ? PHONE_IN_BROWSER_MESSAGE : noPhoneMessage(email)
      : message ?? noPhoneMessage(email)
    return { kind: 'wait', key: `devices:${messageDigest(text)}`, message: text, pollMs: WAIT_POLL_MS, left: 'phone' }
  }
  if (isPlanState(blocker) && message !== null) {
    return { kind: 'wait', key: 'plan', message, pollMs: WAIT_POLL_MS, left: 'plan' }
  }
  if (blocker.id === 'proof' && blocker.remedy?.by === 'user-elsewhere' && message !== null) {
    return { kind: 'wait', key: 'proof', message, pollMs: WAIT_POLL_MS, left: 'test-notification' }
  }
  return { kind: 'stop', message }
}

function leftoverOptionals(readiness: Readiness, flags: InitFlags, declined: ReadonlySet<string>): ReadinessState[] {
  return readiness.states.filter((state) => {
    if (state.status !== 'optional-gap') return false
    if (declined.has(state.id)) return false
    if (isOptionalAutomation(state.id)) return false
    // Not an install anyone declined, so "Optional, not set up" would misread
    // it; it gets its own line below.
    if (state.id === 'cli-bin') return false
    // The User's own choice; the closing line names it and its command.
    if (state.id === 'project-enablement' && projectDisabledHere(readiness)) return false
    // A confirmation, not something left to set up.
    if (state.id === 'proof') return false
    if (state.id === 'skill' && flags.skills === false) return false
    return true
  })
}

/**
 * A `notifai` the reader cannot type.
 *
 * Said on the way out of every run, successful or not, because every next step
 * this command prints — here, in the skill, in the README — names a command
 * that will not be found until it is fixed.
 */
function printMissingCliBin(deps: CommandDeps, readiness: Readiness): void {
  const state = readiness.states.find((candidate) => candidate.id === 'cli-bin')
  if (state?.status !== 'optional-gap') return
  deps.io.out(`Heads up: ${state.detail}. ${remedyLine(state)}`)
}

function printOptionalLeftovers(deps: CommandDeps, leftovers: readonly ReadinessState[]): void {
  for (const state of leftovers) {
    deps.io.out(`Optional, not set up — ${remedyLine(state)}`)
  }
}

interface JourneyClose {
  stopped: Leftover | 'approval' | null
  facts: DoneFacts
  phoneUrl: string
}

async function printInitClose(
  deps: CommandDeps,
  readiness: Readiness,
  flags: InitFlags,
  stoppedBy: ReadinessState | null,
  declined: ReadonlySet<string>,
  journey: JourneyClose,
): Promise<void> {
  const blocker = stoppedBy ?? firstRequiredBlocker(readiness)
  // A phone whose notifications are off still finishes setup: the done
  // message says so, the same as an agent's.
  const canSend = readiness.states.find((state) => state.id === 'devices')?.status === 'ready' ||
    journey.facts.notificationsOff !== null
  const questions = questionRoutingReady(readiness)
  const leftovers = leftoverOptionals(readiness, flags, declined).filter(
    (state) => state.id !== 'contract',
  )

  if (blocker?.id === 'contract') {
    deps.io.out(blocker.detail)
    deps.io.out(
      blocker.remedy?.by !== 'user-elsewhere' && blocker.remedy?.command !== undefined
        ? blocker.remedy.command
        : updateCliCommand(deps),
    )
    return
  }

  printMissingCliBin(deps, readiness)

  // A wait that ended with nothing changing: what is left, said once.
  if (journey.stopped !== null) {
    if (journey.stopped === 'approval') {
      await deps.io.outro?.('Setup stopped')
      return
    }
    const [title, ...lines] = partialTerminalLines(journey.stopped, journey.facts.email, journey.phoneUrl)
    if (deps.io.interactive === true && deps.io.note) {
      await deps.io.note(lines.join('\n'), title)
      await deps.io.outro?.('Stopped for now')
    } else {
      for (const line of [title!, ...lines]) deps.io.out(line)
    }
    return
  }

  if (deps.io.interactive === true) {
    if (blocker === null) {
      const disabled = projectDisabledHere(readiness)
      if (disabled) {
        await deps.io.note?.(['You are signed in.', 'Nothing from this project reaches your devices.'].join('\n'), 'Ready')
      } else if (canSend) {
        const done = doneTerminalLines(journey.facts)
        await deps.io.note?.(done.lines.join('\n'), done.title)
      } else {
        await deps.io.note?.(['You are signed in.', questions ? 'Their questions reach your devices too.' : 'Their questions stay in the terminal.'].join('\n'), 'Ready')
      }
      printOptionalLeftovers(deps, leftovers)
      // The note already says what is true; only a disabled Project has a
      // command to add.
      if (disabled) deps.io.out(allSetLine(readiness, questions))
      await deps.io.outro?.('All set ✨')
      return
    }
    // No framed copy of what the next three lines already say. The "Ready"
    // note above adds something the close does not; this one only made a
    // stopped visit state its one step twice, box then text.
    deps.io.out(`Next: ${blocker.title} — ${blocker.detail}`)
    deps.io.out(`  ${remedyLine(blocker)}`)
    if (shouldRestateInit(blocker)) {
      deps.io.out(`  Then re-run \`${SETUP_COMMAND}\` and it will pick up from here.`)
    }
    await deps.io.outro?.('One step remains (above)')
    return
  }

  if (blocker === null) {
    printOptionalLeftovers(deps, leftovers)
    deps.io.out(allSetLine(readiness, questions))
    return
  }
  deps.io.out(`Next: ${blocker.title} — ${blocker.detail}`)
  deps.io.out(`  ${remedyLine(blocker)}`)
  if (shouldRestateInit(blocker)) {
    deps.io.out(`  Then re-run \`${SETUP_COMMAND}\` and it will pick up from here.`)
  }
}

/**
 * The closing line of a finished setup, which in a disabled Project says
 * nothing reaches the devices, and that the delivery proof was not sent
 * unless an earlier one already proved this machine.
 */
function allSetLine(readiness: Readiness, questions: boolean): string {
  const disabled = readiness.states.find((state) => state.id === 'project-enablement')
  if (disabled !== undefined && projectDisabledHere(readiness)) {
    const proof = readiness.states.find((state) => state.id === 'proof')
    const unproven = proof !== undefined && proof.status !== 'ready'
    return `Set up${unproven ? ' without the test notification' : ''}, but ${disabled.detail}. ` +
      `If the User asked for Notifai here, run \`notifai project enable\`${unproven ? ', then `notifai init` to send the test notification' : ''}.`
  }
  return questions
    ? 'All set. Agents in this project can notify you and ask you questions.'
    : 'All set. Agents in this project can notify you. Questions are terminal-only until Question Routing is ready.'
}

function shouldRestateInit(blocker: ReadinessState): boolean {
  if (blocker.remedy?.by !== 'user-elsewhere' && blocker.remedy?.by !== 'user-here') return false
  return !('command' in blocker.remedy) || blocker.remedy.command !== SETUP_COMMAND
}
