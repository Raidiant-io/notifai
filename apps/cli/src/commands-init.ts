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
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import { type CliConfig } from './config.js'
import { projectSlugFrom as inferredProjectSlugFrom } from './invocation-context.js'
import { SKILLS_INSTALLER_SPEC, type SkillScope } from './native-skills.js'
import { firstBlocker, type Readiness, type ReadinessRefresh, type ReadinessState } from './readiness.js'
import { buildDraft, formatReceipt } from './send.js'
import { loginCommand } from './commands-auth.js'
import {
  EXIT,
  UPDATE_CLI_COMMAND,
  authedClient,
  loadLoggedConfig,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import { readyCompanionDevices, supportPageUrl } from './commands-devices.js'
import { assessReadiness, remedyLine } from './commands-doctor.js'
import { hooksInstallCommand, pickHarnessesToInstall } from './commands-hooks.js'
import { observedCompanionReceipt, readSetupProof, writeSetupProof } from './commands-setup-proof.js'
import { SKILLS_SOURCE } from './commands-skill.js'

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------


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
        `  npx -y ${SKILLS_INSTALLER_SPEC} add ${SKILLS_SOURCE} --skill notifai${
          flags.skillsScope === 'global' ? ' --global' : ''
        }${flags.skillsScope === undefined ? '' : ' --yes'}`,
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

/**
 * Observe the supported Device Installation path while the user finishes the
 * app-side work. The live bridge is the dashboard `/support` page (controlled
 * Companion installation steps). Interactive runs offer to open it so the user
 * never types the URL; non-interactive/agent paths only print plain text and
 * never wait on a prompt.
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
      `I will wait up to ${budgetLabel} for a Companion device to become ready.`,
    ].join('\n'),
    'Finish setup on your Companion device',
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
      `Re-run \`notifai init\` later and it will pick up from here (install steps: ${supportUrl}).`,
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
    spinner?.message(`Waiting another ${budgetLabel} for a Companion device…`)
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
    platform: device.platform,
    device: [device.device_id],
    sound: 'none',
    // Android has no caller-selected interruption level. Explicit null keeps an
    // Apple preference in config from leaking into this Android-only proof.
    level: device.platform === 'ios' ? 'passive' : null,
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
  const existing = readSetupProof(deps)
  const target =
    candidates.find(
      (device) =>
        device.device_id === existing?.device_id && existing.project === config.project.value,
    ) ?? candidates[0]
  if (!target) {
    deps.io.err('Setup proof needs a receipt-capable iPhone or Android Companion App.')
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
