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
  updateCliCommand,
  type CommandDeps,
} from './commands-core.js'
import { deviceNoun, readyCompanionDevices } from './commands-devices.js'
import { terminalQr } from './pairing-qr.js'
import {
  COMPANION_INSTALL_URLS,
  companionPlatformLabel,
  type CompanionPlatform,
} from './setup-destinations.js'
import { assessReadiness, remedyLine } from './commands-doctor.js'
import { hooksInstallCommand, pickHarnessesToInstall } from './commands-hook-install.js'
import { detectedHarnesses } from './install-hooks.js'
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
import { installCodexCommandRules } from './codex-command-rules.js'
import { packageVersion } from './release.js'
import { HARNESS_LABELS, SOURCE_CONTEXT_HARNESSES, type SourceContextHarness } from './harnesses.js'

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
}

/** Long enough for a first controlled Companion install; keep-waiting extends another budget. */
const DEVICE_BRIDGE_TIMEOUT_MS = 10 * 60 * 1000
const DEVICE_BRIDGE_POLL_MS = 2_000
/** A short look for the setup notification's receipt; nothing waits on it. */
const PROOF_TIMEOUT_MS = 10_000
const PROOF_POLL_MS = 1_000

function formatWaitBudget(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
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
    const harnesses = await pickHarnessesToInstall(deps)
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
    const installScope = flags.skillsScope
    if (installScope === undefined) {
      deps.io.err(
        'Skill installation refused — choose a skill scope: `notifai init --skills --skills-scope project` or `... global`.',
      )
      return 'failed'
    }
    const retry = `notifai init --skills --skills-scope ${installScope}`
    const before = skillInventory(deps)
    if (before.error !== undefined) {
      deps.io.err(`Could not inspect installed guidance. Retry with \`${retry}\`.`)
      return 'failed'
    }
    // Without a choice, the harnesses that already load the skill keep it.
    let harnesses: readonly string[] = flags.skillsHarness?.split(',').map((value) => value.trim())
      ?? [...new Set(before.copies.flatMap((copy) => copy.harnesses))]
    if (harnesses.length === 0 && deps.io.interactive === true && deps.io.multiselect) {
      const detected = detectedHarnesses(deps.env, deps.hookPlatform ?? process.platform).filter((value): value is SourceContextHarness =>
        (SOURCE_CONTEXT_HARNESSES as readonly string[]).includes(value))
      harnesses = await deps.io.multiselect('Which agent apps should get the Notifai skill?',
        SOURCE_CONTEXT_HARNESSES.map((value) => ({ value, label: HARNESS_LABELS[value] })), detected) ?? []
    }
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

/**
 * Observe the supported Device Installation path while the user finishes the
 * app-side work. The app goes on the phone, so the bridge is a QR the phone
 * scans straight to the store or download for the platform they just named,
 * with nothing to sign in to first. Nothing opens on this computer: the
 * computer is the wrong device for this errand. Non-interactive/agent paths
 * only print plain text and never wait on a prompt.
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
  // A phone that is registered but silent needs its permission allowed, not
  // install steps — and asking which phone would be asking about one they are
  // already holding. Only a User with nothing registered has a platform still
  // to name, and that is read from the account rather than from the wording of
  // the state that got us here.
  const needsPlatform = (await registeredCompanions(authed.client)) === 0
  const platform = needsPlatform ? await askCompanionPlatform(deps) : null
  if (needsPlatform && platform === null) return 'pending'
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
      `Get Notifai on your ${companionPlatformLabel(platform)}`,
    )
  }

  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const spinner = await deps.io.spinner?.(deviceBridgeMessage([]))
  let lastDevices: RoutableDevice[] = []
  let deadline = now() + DEVICE_BRIDGE_TIMEOUT_MS

  for (;;) {
    while (now() < deadline) {
      try {
        const response = await authed.client.listDevices()
        lastDevices = response.devices
        const ready = readyCompanionDevices(response.devices)[0]
        if (ready) {
          spinner?.stop(`${ready.display_name} is ready to receive`)
          return 'closed'
        }
        spinner?.message(deviceBridgeMessage(response.devices))
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
      `Re-run \`notifai init\` later and it will pick up from here${installUrl === null ? '' : ` (get the app: ${installUrl})`}.`,
    )

    const keepWaiting = await deps.io.confirm(
      `Keep waiting for another ${budgetLabel}?`,
      false,
    )
    if (!keepWaiting) {
      deps.io.out(
        'Stopping the wait. Companion setup can continue; re-run `notifai init` when ready.',
      )
      return 'pending'
    }
    spinner?.message(`Waiting another ${budgetLabel} for a Companion App…`)
    deadline = now() + DEVICE_BRIDGE_TIMEOUT_MS
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
    title: `${machineName} is set up`,
    summary: `Agents on ${machineName} can now send you notifications. They will arrive like this one.`,
    kind: 'done',
    platform: device.platform,
    device: [device.device_id],
    // Noticeable, not intrusive: a normal banner and sound. Deliberately not
    // `time_sensitive` — a setup confirmation has no business breaking a Focus.
    //
    // Android has no caller-selected interruption level. Explicit null keeps an
    // Apple preference in config from leaking into this Android-only proof.
    level: device.platform === 'ios' ? 'active' : null,
    collapseKey: 'notifai-setup-verification',
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
 * Send the setup notification once, then briefly watch for its Companion
 * Receipt. It confirms a setup that is already complete, so it is sent at most
 * once per machine and device, never re-sent, and an unconfirmed receipt is no
 * failure. A send that fails or is rejected is reported through `onFailure`:
 * that one says something real about delivery.
 */
async function runSetupProof(
  deps: CommandDeps,
  onFailure: (state: ReadinessState) => void,
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
  // Sent once already, to a device still here: never again.
  const existing = readSetupProof(deps)
  if (setupProofApplies(existing, candidates.map((device) => device.device_id))) {
    return existing.companion_receipt.state === 'observed' ? 'closed' : 'pending'
  }
  const target = candidates[0]
  if (!target) return 'pending'

  const interactive = deps.io.interactive === true
  const spinner = interactive
    ? await deps.io.spinner?.(`Sending a test notification to ${target.display_name}…`)
    : null
  const receipt = await submitSetupProof(deps, authed.client, config, target)
  if (receipt === null || receipt.overall === 'provider_rejected_all') {
    spinner?.error(`The test notification to ${target.display_name} did not go through`)
    if (receipt !== null) deps.io.err(formatReceipt(receipt))
    onFailure(receipt === null
      ? {
          id: 'proof',
          title: 'Test notification',
          status: 'gap',
          detail: `the test notification to ${target.display_name} could not be sent`,
          remedy: { by: 'cli', summary: 'run setup again to retry it', command: 'notifai init' },
        }
      : {
          id: 'proof',
          title: 'Test notification',
          status: 'gap',
          detail: `${target.display_name} could not receive the test notification: its push delivery was rejected`,
          message: `Your ${deviceNoun(target)} couldn't receive a test notification from Notifai. ` +
            `Open Notifai on it so it can reconnect, then tell me and I'll try again.`,
          remedy: {
            by: 'user-elsewhere',
            summary: `open Notifai on ${target.display_name} so it can reconnect, then run setup again`,
          },
        })
    return 'failed'
  }
  const proof: SetupProofRecord = {
    request_id: receipt.request_id,
    device_id: target.device_id,
    started_at: new Date((deps.now ?? Date.now)()).toISOString(),
    companion_receipt: { state: 'unknown', observed_at: null },
  }
  // A record that cannot be saved would make the next run send again.
  if (!writeSetupProof(deps, proof)) {
    spinner?.stop(`Test notification sent to ${target.display_name}`)
    return 'pending'
  }
  if (!interactive) deps.io.out(`Test notification sent to ${target.display_name} (${proof.request_id}).`)

  const now = deps.now ?? Date.now
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

/**
 * Whether an offer waits for the phone step.
 *
 * Hooks, command approval and the skill are asked once this computer is
 * connected: after the phone step when the run is about to walk the User
 * through it, and always before the plan and the setup notification, which
 * they do not depend on. A flag the caller passed is no question, so it is
 * acted on at once.
 */
function offerWaits(
  deps: CommandDeps,
  state: ReadinessState,
  flags: InitFlags,
  readiness: Readiness,
  attempted: ReadonlySet<string>,
): boolean {
  return deps.io.interactive === true &&
    isOffered(state.id) &&
    explicitChoice(state, flags) === undefined &&
    !attempted.has('devices') &&
    readiness.states.some((candidate) => candidate.id === 'devices' && candidate.status === 'gap' &&
      candidate.remedy?.by === 'user-elsewhere')
}

/** An offer that waited for the phone step and has not been answered yet. */
function offersHeldForPhone(deps: CommandDeps, readiness: Readiness, flags: InitFlags): boolean {
  return deps.io.interactive === true && readiness.states.some((state) =>
    state.status === 'optional-gap' && state.remedy?.by === 'cli' && isOffered(state.id) &&
    explicitChoice(state, flags) === undefined)
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
  // Asking for an install nobody can be asked about is a usage error, and it
  // is knowable from the flags alone — so it is reported before a setup runs
  // half way rather than after.
  if (flags.skillsScope === undefined && deps.io.interactive !== true && flags.skills === true) {
    deps.io.err(
      'Unattended skill installation requires an explicit scope: pass `--skills-scope project` or `--skills-scope global`.',
    )
    return 'usage'
  }
  return flags.skillsScope
}

/**
 * Where the agent guidance skill should land, asked at the moment it is about
 * to be installed and not before.
 *
 * It used to be the first thing the product ever said, as one question
 * covering skill, hook and shared-config placement, put to someone who had met
 * none of those words. Hooks and config no longer have a scope at all, and
 * the skill still has its own independent scope choice.
 */
async function scopeForSkillInstall(
  deps: CommandDeps,
  flags: InitFlags,
): Promise<SkillScope | 'declined'> {
  if (flags.skillsScope !== undefined) return flags.skillsScope
  if (deps.io.interactive === true && deps.io.select) {
    const selected = await deps.io.select(
      'Use the Notifai skill in this project only, or in every project on this computer?',
      [
        {
          value: 'project',
          label: 'This project',
          hint: 'only agents working here get it',
        },
        {
          value: 'global',
          label: 'Every project',
          hint: 'agents get it wherever they work',
        },
      ],
    )
    if (selected === 'project' || selected === 'global') return selected
    deps.io.err('No skill scope selected. Pass `--skills-scope project` or `--skills-scope global`.')
    return 'declined'
  }
  deps.io.err(
    'Unattended skill installation requires an explicit scope: pass `--skills-scope project` or `--skills-scope global`.',
  )
  return 'declined'
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
  const workingDeps: CommandDeps = flags.json === true
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
  const scopeFromFlags = checkSkillScopeFlags(workingDeps, flags)
  if (scopeFromFlags === 'usage') return EXIT.usage
  let resolved: InitFlags = { ...flags }
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

  const skillOpts = () => ({ ...(resolved.skillsScope === undefined ? {} : { skillScope: resolved.skillsScope }),
    ...(resolved.skillsHarness === undefined ? {} : { skillHarnesses: resolved.skillsHarness.split(',').map(value => value.trim()) }) })
  let readiness = await assessReadiness(workingDeps, { ...skillOpts(), ...(flags.json === true ? { json: true } : {}) })
  const reassess = (refresh?: readonly ReadinessRefresh[]) =>
    assessReadiness(workingDeps, {
      ...skillOpts(),
      ...(flags.json === true ? { json: true } : {}),
      ...(refresh === undefined ? {} : { previous: readiness, refresh }),
    })
  let failed = false
  // What actually stopped a sign-in, when something did. Without it the close
  // renders the state as it was before the attempt — "not paired … run
  // `notifai init`" — which contradicts the correct line printed moments
  // earlier and sends the reader back into the command that just failed.
  let loginBlocker: ReadinessState | null = null
  const attempted = new Set<string>()
  // Offers the User answered no to in this run: the close does not offer
  // them straight back.
  const declined = new Set<string>()
  // A setup notification that could not be sent or was rejected: the one
  // outcome of that confirmation that says something real about delivery.
  let proofFailure: ReadinessState | null = null

  // Re-assess after every successful action. This is how a browser approval or
  // companion registration can unlock the next state while the user is still
  // here, without copying the dependency graph into a second setup script.
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
        if (remedy.by !== 'cli' || offerWaits(workingDeps, state, resolved, readiness, attempted)) continue
        if (!(await wantsOptional(workingDeps, state, resolved))) {
          // Answered once per run: a later pass never asks again.
          attempted.add(state.id)
          if (isOffered(state.id)) declined.add(state.id)
          continue
        }
        if (needsSkillScope(state)) {
          const scope = await scopeForSkillInstall(workingDeps, resolved)
          if (scope === 'declined') {
            attempted.add(state.id)
            continue
          }
          resolved = { ...resolved, skillsScope: scope }
        }
        attempted.add(state.id)
        const result = state.id === 'proof'
          ? await runSetupProof(workingDeps, (failure) => { proofFailure = failure })
          : await closeGap(workingDeps, state, resolved)
        if (result === 'failed') failed = true
        if (result === 'failed' && state.status === 'optional-gap') {
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
        if (needsSkillScope(state)) {
          const scope = await scopeForSkillInstall(workingDeps, resolved)
          if (scope === 'declined') {
            attempted.add(state.id)
            if (halt()) break
            continue
          }
          resolved = { ...resolved, skillsScope: scope }
        }
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

      // The CLI starts approval; the User completes it in their browser.
      // Both human and unattended init use the same bounded approval flow.
      if (
        (state.id === 'credential' || state.id === 'auth') &&
        remedy.by === 'user-here' &&
        remedy.interactive === true
      ) {
        attempted.add(state.id)
        workingDeps.io.out(
          workingDeps.io.interactive === true
            ? 'Connect this computer — Ctrl-C to stop.'
            : 'Starting computer approval.',
        )
        const loginResult = await loginCommand(workingDeps, { ...(resolved.approval ? { approval: resolved.approval } : {}), ...(resolved.approvalEmail ? { approvalEmail: resolved.approvalEmail } : {}) }, (blocker) => {
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
        workingDeps.io.interactive === true
      ) {
        attempted.add(state.id)
        const result = await waitForReadyDevice(workingDeps, state)
        if (result === 'failed') failed = true
        // An unfinished phone step still lets the agent-wiring questions it
        // held back be asked before this run stops.
        if (result !== 'closed' && !offersHeldForPhone(workingDeps, readiness, resolved)) {
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

  // An explicit yes is never dropped silently: when the rules could not be
  // added, say why in plain words.
  if (resolved.claudeCommands === true) {
    const notWritten = claudeCommandsNotWritten(
      readiness.states.find((state) => state.id === CLAUDE_COMMANDS_STATE_ID),
      claudeCommandRulesInstalled(workingDeps.env),
      attempted.has(CLAUDE_COMMANDS_STATE_ID),
    )
    if (notWritten !== null) workingDeps.io.out(notWritten)
  }

  if (proofFailure !== null) {
    const failure: ReadinessState = proofFailure
    readiness = { ...readiness, states: readiness.states.map((state) => state.id === 'proof' ? failure : state) }
  }
  const blocker = loginBlocker ?? firstRequiredBlocker(readiness)
  if (flags.json === true) deps.io.out(JSON.stringify(readinessJson(readiness), null, 2))
  else await printInitClose(deps, readiness, resolved, loginBlocker, declined)
  if (blocker === null) return failed ? EXIT.failed : EXIT.ok
  return failed || workingDeps.io.interactive !== true ? EXIT.failed : EXIT.ok
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

async function printInitClose(
  deps: CommandDeps,
  readiness: Readiness,
  flags: InitFlags,
  stoppedBy: ReadinessState | null = null,
  declined: ReadonlySet<string> = new Set(),
): Promise<void> {
  const blocker = stoppedBy ?? firstRequiredBlocker(readiness)
  const canSend = readiness.states.find((state) => state.id === 'devices')?.status === 'ready'
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

  if (deps.io.interactive === true) {
    if (blocker === null) {
      const disabled = projectDisabledHere(readiness)
      const lines = disabled
        ? ['You are signed in.', 'Nothing from this project reaches your devices.']
        : [
            canSend ? 'Your agents can notify you.' : 'You are signed in.',
            questions
              ? 'Their questions reach your devices too.'
              : 'Their questions stay in the terminal.',
          ]
      await deps.io.note?.(lines.join('\n'), 'Ready')
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
