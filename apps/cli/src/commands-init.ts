import {
  CAPABILITIES_V1,
  validateDraft,
  type RoutableDevice,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { ensurePrivateDirectory } from './atomic-file.js'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import { personalProjectConfigPath, type CliConfig } from './config.js'
import { projectSlugFrom as inferredProjectSlugFrom } from './invocation-context.js'
import { type SkillScope } from './native-skills.js'
import {
  firstRequiredBlocker,
  isOptionalAutomation,
  isOptionalSetup,
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
import { readyCompanionDevices } from './commands-devices.js'
import {
  companionPlatformLabel,
  setupCompanionUrl,
  type CompanionPlatform,
} from './setup-destinations.js'
import { assessReadiness, remedyLine } from './commands-doctor.js'
import { hooksInstallCommand, pickHarnessesToInstall } from './commands-hooks.js'
import {
  observedCompanionReceipt,
  readSetupProof,
  setupProofProject,
  setupProofApplies,
  setupProofIsStale,
  writeSetupProof,
} from './commands-setup-proof.js'
import { listScopedNotifaiSkills, SKILLS_SOURCE } from './commands-skill.js'
import { enableProject, projectBinding } from './project-enablement.js'
import { inspectCliInstallations } from './cli-bin.js'
import { installHookAdapter } from './hook-adapter.js'

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------


/** Derive a contract-valid project slug; init alone needs a non-empty fallback. */
export function projectSlugFrom(name: string): string {
  return inferredProjectSlugFrom(name) ?? 'project'
}

/** Project checkout vs this machine. Drives skill, hooks, and config together. */
export type SetupScope = SkillScope

export interface InitFlags {
  /** Emit the final shared readiness model and never prompt. */
  json?: boolean
  projectId?: string
  /**
   * Install the agent guidance skill. Tri-state on purpose:
   * true installs, false skips silently, and undefined means "offer it when a
   * human is present, do nothing when one is not" — an unattended run must
   * never spawn npx against the network by default.
   */
  skills?: boolean
  /**
   * One setup-scope for skill, hooks, and config. The unattended answer to
   * init's single project-vs-machine question. Pairing, devices, and the CLI
   * binary are not this flag.
   */
  setupScope?: SetupScope
  /** Alias of `--setup-scope` when installing the skill unattended. */
  skillsScope?: SkillScope
  /** Same tri-state, for the harness hooks. */
  hooks?: boolean
}


/** Long enough for a first controlled Companion install; keep-waiting extends another budget. */
const DEVICE_BRIDGE_TIMEOUT_MS = 10 * 60 * 1000
const DEVICE_BRIDGE_POLL_MS = 2_000
const PROOF_TIMEOUT_MS = 30_000
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
    // Naming this checkout is local bookkeeping, not skill or hook placement,
    // so it does not wait on the scope question. Without an explicit answer the
    // name lands in the checkout it describes, which is the answer a User who
    // never sees the question would have given.
    const slug = projectSlugFrom(flags.projectId ?? path.basename(deps.cwd))
    const configPath =
      flags.setupScope === 'global'
        ? personalProjectConfigPath(deps.cwd, deps.env)
        : path.join(deps.cwd, '.notifai', 'config.toml')
    const existing = existsSync(configPath)
      ? (parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
      : {}
    existing['project'] = slug
    if (flags.setupScope === 'global') ensurePrivateDirectory(path.dirname(configPath))
    else mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${stringifyToml(existing)}\n`)
    return 'closed'
  }

  if (state.id === 'project-enablement') {
    const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
    const binding = projectBinding(deps.cwd, deps.env, config.project.value)
    if (binding === null) return 'failed'
    enableProject(binding)
    return 'closed'
  }

  if (state.id === 'hooks') {
    const harnesses = await pickHarnessesToInstall(deps)
    if (harnesses === null || harnesses.length === 0) return 'failed'
    let ok = true
    const hookFlags = flags.setupScope === 'global' ? { global: true as const } : {}
    for (const harness of harnesses) {
      if (hooksInstallCommand(deps, { harness, ...hookFlags, narrate: false }) !== EXIT.ok) ok = false
    }
    return ok ? 'closed' : 'failed'
  }

  if (state.id === 'hooks-adapter') {
    const effective = inspectCliInstallations(
      deps.env,
      deps.hookPlatform ?? process.platform,
    ).effective
    if (effective === null || effective.artifact_path === null) return 'failed'
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
      deps.io.err('Skill installation failed — the native `npx skills` flow is unavailable.')
      return 'failed'
    }
    // Refuse rather than guess a release identity. The production adapter
    // verifies this tag against npm's bundled skill and replaces it with the
    // full commit SHA before it invokes the installer.
    if (SKILLS_SOURCE === null) {
      deps.io.err(
        'Skill installation failed — this build cannot determine its own version, so there is no release tag to install from.',
      )
      return 'failed'
    }
    const installScope = flags.setupScope ?? flags.skillsScope
    if (installScope === undefined) {
      deps.io.err(
        'Skill installation refused — choose a setup scope: `notifai init --skills --setup-scope project` or `... global`.',
      )
      return 'failed'
    }
    const { installed } = await listScopedNotifaiSkills(deps)
    const extras = installed.filter((skill) => skill.scope !== installScope)
    for (const extra of extras) {
      const code = await deps.nativeSkills.remove({
        skill: 'notifai',
        scope: extra.scope,
        cwd: deps.cwd,
        env: deps.env,
      })
      if (code !== 0) {
        deps.io.err(
          `Skill installation refused — could not uninstall the ${extra.scope} copy (${extra.ref ?? 'unknown pin'}), so installing ${installScope} would leave both active.`,
        )
        return 'failed'
      }
    }
    deps.io.out(`Starting the native npx skills setup for the notifai agent skill (${installScope} scope)...`)
    const operation = await deps.nativeSkills.add({
      source: SKILLS_SOURCE,
      skill: 'notifai',
      cwd: deps.cwd,
      env: deps.env,
      scope: installScope,
    })
    const code = typeof operation === 'number' ? operation : operation.code
    if (code !== 0) {
      deps.io.err(
        typeof operation === 'number'
          ? 'Skill installation failed — rerun `notifai init --skills` after checking the network connection.'
          : `Skill installation refused — ${operation.error}.`,
      )
    }
    return code === 0 ? 'closed' : 'failed'
  }

  if (state.id === 'proof') return await runSetupProof(deps)

  return 'failed'
}


function deviceBridgeMessage(devices: readonly RoutableDevice[]): string {
  if (devices.length === 0) {
    return 'Waiting for a Companion App to sign in and register…'
  }
  const denied = devices.find((device) => device.permission_status === 'denied')
  if (denied) return `Waiting for notifications to be allowed on ${denied.display_name}…`
  const undecided = devices.find((device) => device.permission_status === 'not_determined')
  if (undecided) return `Waiting for ${undecided.display_name} to allow the notification prompt…`
  return 'Waiting for a Companion device to become ready…'
}

/** How many Companion Apps this Account has registered, on any platform. */
async function registeredCompanions(client: ApiClient): Promise<number> {
  try {
    const response = await client.listDevices()
    return response.devices.filter(
      (device) => device.platform === 'ios' || device.platform === 'android',
    ).length
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
 * again on the other screen. A run with no human gets nothing — it opens no
 * browser and answers no question — so there is no prompt to hang on.
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
 * app-side work. The bridge is one focused setup destination for the platform
 * they just named — not the omnibus help page, whose own next step is to go
 * somewhere else. Interactive runs offer to open it so the user never types
 * the URL; non-interactive/agent paths only print plain text and never wait on
 * a prompt.
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
  const platform = (await registeredCompanions(authed.client)) === 0
    ? await askCompanionPlatform(deps)
    : null
  const setupUrl = setupCompanionUrl(authed.baseUrl, platform ?? undefined)
  const stepsLabel =
    platform === null ? 'Setup steps (no typing)' : `${companionPlatformLabel(platform)} steps (no typing)`
  await deps.io.note?.(
    [
      state.detail,
      remedy.summary,
      `${stepsLabel}: ${setupUrl}`,
      `I will wait up to ${budgetLabel} for a Companion App to become ready.`,
    ].join('\n'),
    'Finish setup on your phone',
  )

  // Open the destination so the user never has to type the URL. Decline is
  // fine — the URL remains in the note and in the Next: line if they leave.
  if (await deps.io.confirm('Open those steps in your browser?', true)) {
    deps.io.openUrl(setupUrl)
  }

  if (!(await deps.io.confirm('Wait here while you finish that on your phone?', true))) {
    deps.io.out(
      `OK — finish that when you can (steps: ${setupUrl}), then re-run \`notifai init\`.`,
    )
    return 'pending'
  }

  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const spinner = await deps.io.spinner?.(
    `Waiting up to ${budgetLabel} for a Companion device…`,
  )
  let lastDevices: RoutableDevice[] = []
  let deadline = now() + DEVICE_BRIDGE_TIMEOUT_MS

  for (;;) {
    while (now() < deadline) {
      try {
        const response = await authed.client.listDevices()
        const companionDevices = response.devices.filter(
          (device) => device.platform === 'ios' || device.platform === 'android',
        )
        lastDevices = companionDevices
        const ready = readyCompanionDevices(companionDevices)[0]
        if (ready) {
          spinner?.stop(`${ready.display_name} is ready to receive`)
          return 'closed'
        }
        spinner?.message(deviceBridgeMessage(companionDevices))
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
      `Re-run \`notifai init\` later and it will pick up from here (steps: ${setupUrl}).`,
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
 * The first notification a User ever receives from Notifai.
 *
 * It is the payoff of the whole setup, and it used to be written as an
 * internal receipt: "This real notification completed setup verification" — a
 * sentence about the check rather than about them — delivered silently, at
 * `passive`, with the sound turned off. So the one arrival that proves their
 * agents can reach them landed in Notification Center with no banner and no
 * sound, where a first-time User has no reason to look and every reason to
 * conclude that nothing came.
 *
 * It now says what is true for them and arrives the way their notifications
 * will. `done` is the honest kind — a body of work finished successfully — and
 * it is also what lets the server pick the sound through its own kind, Project
 * and Account layers instead of this command stamping one and skipping them.
 */
function setupProofDraft(
  config: CliConfig,
  device: RoutableDevice,
): ReturnType<typeof buildDraft> {
  const project = config.project.value
  return buildDraft(config, {
    title: 'Your agents can reach you',
    body:
      project === null
        ? 'Notifai setup is finished. Notifications from your agents will arrive like this one.'
        : `Notifai setup is finished for ${project}. Notifications from your agents will arrive like this one.`,
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
 * Provider Acceptance is intentionally insufficient: it proves a push provider
 * accepted the request, not that a companion process received it.
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
  const candidates = readyCompanionDevices(devices)
  const project = setupProofProject(deps, config.project.value)
  const existing = readSetupProof(deps, project)
  const existingApplies = setupProofApplies(
    existing,
    project,
    candidates.map((device) => device.device_id),
  )
  const target = (existingApplies
    ? candidates.find((device) => device.device_id === existing.device_id)
    : undefined) ?? candidates[0]
  if (!target) {
    deps.io.err('Setup proof needs a receipt-capable iPhone or Android Companion App.')
    return 'pending'
  }

  let proof =
    existingApplies && existing.device_id === target.device_id
      ? existing
      : null
  const nowMs = (deps.now ?? Date.now)()
  if (proof !== null && setupProofIsStale(proof, nowMs)) {
    let keepStale = false
    try {
      const snapshot = await authed.client.evidence(proof.request_id)
      keepStale = observedCompanionReceipt(snapshot, proof.device_id) !== null
    } catch {
      keepStale = false
    }
    if (!keepStale) {
      deps.io.out(
        `The saved proof ${proof.request_id} is older than 24h without a Companion Receipt; sending a replacement.`,
      )
      proof = null
    }
  }
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
      project,
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
          project,
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
  return id === 'project' || id === 'project-enablement' || id === 'hooks' || id.startsWith('hooks-') || id === 'skill' || id === 'question-routing-settings'
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
  if (state.id === 'project-enablement') return Promise.resolve(true)
  // Every other hook sub-state is a report line about routing, not an errand
  // with a yes/no question of its own; offering the hooks question for one of
  // them would ask about something the answer does not change.
  if (state.id !== 'hooks' && state.id !== 'skill') return Promise.resolve(false)
  const explicit = state.id === 'hooks' ? flags.hooks : flags.skills
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

/** The two states whose remedy actually places files the scope question is about. */
function needsInstallScope(state: ReadinessState): boolean {
  return state.id === 'hooks' || state.id === 'skill'
}

function isSetupScope(value: string | undefined): value is SetupScope {
  return value === 'project' || value === 'global'
}

/**
 * Scope flags are checked before anything runs, because a contradiction is a
 * usage error and reporting it after half a setup is worse than reporting it
 * now. Answering the question is a separate step (`scopeForLocalInstall`).
 */
function checkSetupScopeFlags(deps: CommandDeps, flags: InitFlags): SetupScope | undefined | 'usage' {
  if (flags.setupScope !== undefined && !isSetupScope(flags.setupScope)) {
    deps.io.err('Invalid setup scope. Choose `project` or `global`.')
    return 'usage'
  }
  if (flags.skillsScope !== undefined && !isSetupScope(flags.skillsScope)) {
    deps.io.err('Invalid skill scope. Choose `project` or `global`.')
    return 'usage'
  }
  if (
    flags.setupScope !== undefined &&
    flags.skillsScope !== undefined &&
    flags.setupScope !== flags.skillsScope
  ) {
    deps.io.err('`--setup-scope` and `--skills-scope` disagree. Pass one, or pass the same value twice.')
    return 'usage'
  }
  if (flags.skillsScope !== undefined && flags.skills !== true) {
    deps.io.err('`--skills-scope` requires `--skills`. Use `--setup-scope` to choose project or machine for the whole setup.')
    return 'usage'
  }
  const fromFlags = flags.setupScope ?? flags.skillsScope
  // Asking for an install nobody can be asked about is a usage error, and it
  // is knowable from the flags alone — so it is reported before a setup runs
  // half way rather than after.
  if (
    fromFlags === undefined &&
    deps.io.interactive !== true &&
    (flags.skills === true || flags.hooks === true)
  ) {
    deps.io.err(
      'Unattended setup changes require an explicit scope: pass `--setup-scope project` or `--setup-scope global`.',
    )
    return 'usage'
  }
  return fromFlags
}

/**
 * Where a skill or hook install should land, asked at the moment one is about
 * to happen and not before.
 *
 * It used to be the first thing the product ever said, in front of the
 * assessment, sign-in and every other gate — a question about skill, hook and
 * shared-config placement put to someone who had met none of those words and
 * might never reach the step it decides. Worse, project identity and Project
 * Enablement were gated on the answer, so an unattended run that could not
 * produce one advanced nothing at all.
 *
 * Now nothing depends on it except the two installs it actually describes.
 */
async function scopeForLocalInstall(
  deps: CommandDeps,
  flags: InitFlags,
): Promise<SetupScope | 'declined'> {
  const fromFlags = flags.setupScope ?? flags.skillsScope
  if (fromFlags !== undefined) return fromFlags
  if (deps.io.interactive === true && deps.io.select) {
    const selected = await deps.io.select(
      'Should this Notifai setup apply to this project only, or to every project on this machine?',
      [
        {
          value: 'project',
          label: 'This project',
          hint: 'skill, hooks, and shared config stay in this checkout',
        },
        {
          value: 'global',
          label: 'This machine',
          hint: 'skill and hooks follow you into every repo',
        },
      ],
    )
    if (selected === 'project' || selected === 'global') return selected
    deps.io.err('No setup scope selected. Pass `--setup-scope project` or `--setup-scope global`.')
    return 'declined'
  }
  deps.io.err(
    'Unattended setup changes require an explicit scope: pass `--setup-scope project` or `--setup-scope global`.',
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
          out: () => {},
          err: (line) => deps.io.err(line),
          confirm: async () => false,
          openUrl: (url) => deps.io.openUrl(url),
        },
      }
    : deps
  const scopeFromFlags = checkSetupScopeFlags(workingDeps, flags)
  if (scopeFromFlags === 'usage') return EXIT.usage
  let resolved: InitFlags = {
    ...flags,
    ...(scopeFromFlags === undefined
      ? {}
      : { setupScope: scopeFromFlags, skillsScope: flags.skillsScope ?? scopeFromFlags }),
  }
  await workingDeps.io.intro?.('Notifai setup')

  const skillOpts = resolved.setupScope === undefined ? {} : { skillScope: resolved.setupScope }
  let readiness = await assessReadiness(workingDeps, { ...skillOpts, ...(flags.json === true ? { json: true } : {}) })
  const reassess = (refresh?: readonly ReadinessRefresh[]) =>
    assessReadiness(workingDeps, {
      ...skillOpts,
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
        if (remedy.by !== 'cli' || !(await wantsOptional(workingDeps, state, resolved))) continue
        if (needsInstallScope(state)) {
          const scope = await scopeForLocalInstall(workingDeps, resolved)
          if (scope === 'declined') {
            attempted.add(state.id)
            continue
          }
          resolved = { ...resolved, setupScope: scope, skillsScope: resolved.skillsScope ?? scope }
        }
        attempted.add(state.id)
        const result = await closeGap(workingDeps, state, resolved)
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
        if (needsInstallScope(state)) {
          const scope = await scopeForLocalInstall(workingDeps, resolved)
          if (scope === 'declined') {
            attempted.add(state.id)
            if (halt()) break
            continue
          }
          resolved = { ...resolved, setupScope: scope, skillsScope: resolved.skillsScope ?? scope }
        }
        attempted.add(state.id)
        const result = await closeGap(workingDeps, state, resolved)
        if (result === 'failed') failed = true
        if (result !== 'closed') {
          if (halt()) break
          continue
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
        workingDeps.io.interactive === true
      ) {
        attempted.add(state.id)
        workingDeps.io.out('Opening your browser to approve this machine — Ctrl-C to stop.')
        if ((await loginCommand(workingDeps, {}, (blocker) => (loginBlocker = blocker))) !== EXIT.ok) {
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

  const blocker = loginBlocker ?? firstRequiredBlocker(readiness)
  if (flags.json === true) deps.io.out(JSON.stringify(readinessJson(readiness), null, 2))
  else await printInitClose(deps, readiness, resolved, loginBlocker)
  if (blocker === null) return failed ? EXIT.failed : EXIT.ok
  return failed || workingDeps.io.interactive !== true ? EXIT.failed : EXIT.ok
}

function leftoverOptionals(readiness: Readiness, flags: InitFlags): ReadinessState[] {
  return readiness.states.filter((state) => {
    if (state.status !== 'optional-gap') return false
    if (isOptionalAutomation(state.id)) return false
    // Not an install anyone declined, so "Optional, not set up" would misread
    // it; it gets its own line below.
    if (state.id === 'cli-bin') return false
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
): Promise<void> {
  const blocker = stoppedBy ?? firstRequiredBlocker(readiness)
  const canSend = readiness.states.find((state) => state.id === 'devices')?.status === 'ready'
  const questions = questionRoutingReady(readiness)
  const leftovers = leftoverOptionals(readiness, flags).filter(
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
      const lines = [
        canSend ? 'You can send notifications.' : 'You are signed in.',
        questions
          ? 'Questions will reach your devices.'
          : 'Questions are terminal-only until Question Routing is ready.',
      ]
      await deps.io.note?.(lines.join('\n'), 'Ready')
      printOptionalLeftovers(deps, leftovers)
      deps.io.out(
      questions
        ? 'All set. Agents in this project can notify you and ask you questions.'
        : 'All set. Agents in this project can notify you. Questions are terminal-only until Question Routing is ready.',
    )
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
    deps.io.out(
      questions
        ? 'All set. Agents in this project can notify you and ask you questions.'
        : 'All set. Agents in this project can notify you. Questions are terminal-only until Question Routing is ready.',
    )
    return
  }
  deps.io.out(`Next: ${blocker.title} — ${blocker.detail}`)
  deps.io.out(`  ${remedyLine(blocker)}`)
  if (shouldRestateInit(blocker)) {
    deps.io.out(`  Then re-run \`${SETUP_COMMAND}\` and it will pick up from here.`)
  }
}

function shouldRestateInit(blocker: ReadinessState): boolean {
  if (blocker.remedy?.by !== 'user-elsewhere' && blocker.remedy?.by !== 'user-here') return false
  return !('command' in blocker.remedy) || blocker.remedy.command !== SETUP_COMMAND
}
