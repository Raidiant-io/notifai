import {
  NOTIFICATION_CONTRACT_FINGERPRINT,
  PLATFORMS,
  SHIPPED_CLI_CAPABILITIES,
  type RoutableDevice,
} from '@raidiant/notifai-protocol'
import { existsSync } from 'node:fs'
import { inspectClaudeInbox, systemClaudeWakeAdapters } from './claude-wake.js'
import { ApiCallError, type ApiClient } from './client.js'
import { inspectCodexResume } from './codex-wake.js'
import { type CliConfig } from './config.js'
import {
  HARNESS_LABELS,
  HERMES_QUESTION_ROUTING_UNAVAILABLE,
  isHookInstallableHarness,
  questionRoutingCapability,
} from './harnesses.js'
import {
  hookAdapterTargetsArtifact,
  inspectHookAdapter,
  isNpxAdapterTarget,
} from './hook-adapter.js'
import {
  readLiveProjectSessionPointers,
  readProjectSessionPointer,
} from './hook-project-sessions.js'
import { readSessionState } from './hook-session-state.js'
import {
  NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
  QUESTION_STOP_TIMEOUT_SECONDS,
  codexCoexistenceNotes,
  codexHomeNote,
  codexRepresentationProblems,
  codexTrustProblems,
  detectedHarnesses,
  findInstallations,
  findLegacyProjectInstallations,
  handlerEvent,
  type Installation,
} from './install-hooks.js'
import { inferInvocationContext } from './invocation-context.js'
import type { SkillScope } from './native-skills.js'
import {
  firstBlocker,
  readinessJson,
  type Readiness,
  type ReadinessRefresh,
  type ReadinessState,
  type StateStatus,
} from './readiness.js'
import { packageVersion } from './release.js'
import type { Tone } from './ui/theme.js'
import type { MachineCredential } from './credentials.js'
import {
  EXIT,
  SETUP_COMMAND,
  diagnoseIgnoredOriginOverride,
  loadLoggedConfig,
  makeClient,
  resolvedBaseUrl,
  updateCliCommand,
  type CommandDeps,
} from './commands-core.js'
import { deviceInstallRemedy, readyCompanionDevices } from './commands-devices.js'
import { setupAccessUrl } from './setup-destinations.js'
import {
  claudeSessionPid,
  resolveActiveHarness,
  type ActiveHarnessSession,
} from './commands-harness-context.js'
import { stopShapeProblems } from './commands-hook-shape.js'
import {
  CODEX_FRESH_SESSION_USER_ACTION,
  CODEX_HOOK_APPROVAL_USER_ACTION,
  CODEX_STOP_DEFINITION_NOT_SINGULAR_PROBLEM,
  CODEX_STALE_STOP_DEFINITION_PROBLEM,
  activeQuestionRouteProblems,
  hookActivationAdvice,
} from './commands-hook-diagnostics.js'
import { HOOK_EVENTS, requiredHookEvents } from './hook-events.js'
import { cliBinReadiness, inspectCliInstallations } from './cli-bin.js'
import {
  latestPublishedCliVersion,
  newerPublishedCli,
  shouldConsultCliRegistry,
  thisCliVersion,
} from './cli-release.js'
import {
  SETUP_PROOF_STALE_MS,
  observedCompanionReceipt,
  readSetupProof,
  setupProofProject,
  setupProofIsStale,
  setupProofApplies,
} from './commands-setup-proof.js'
import { skillReadiness } from './commands-skill.js'
import { projectBinding, projectEnabled } from './project-enablement.js'
import { CLI_UPDATE_AVAILABLE, SERVICE_UPDATE_IN_PROGRESS } from './cli-contract.js'

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/**
 * Server-owned support policy plus every shipped platform document. Artifact
 * versions and document integers are structured inventory, never routing or a
 * definition of "up to date".
 */
async function compatibilityCheck(client: ApiClient, deps: CommandDeps): Promise<ReadinessState> {
  try {
    const [compatibility, documents] = await Promise.all([
      client.compatibility(),
      Promise.all(PLATFORMS.map((platform) => client.capabilities(platform))),
    ])
    const serverCapabilities = new Set(compatibility.server_capabilities)
    const cliCapabilityIntersection = {
      available: SHIPPED_CLI_CAPABILITIES.filter((capability) => serverCapabilities.has(capability)),
      missing_on_server: SHIPPED_CLI_CAPABILITIES.filter(
        (capability) => !serverCapabilities.has(capability),
      ),
    }
    const notificationContract = {
      local: NOTIFICATION_CONTRACT_FINGERPRINT,
      mismatched_platforms: documents
        .filter(
          (document) =>
            document.notification_contract_fingerprint !== NOTIFICATION_CONTRACT_FINGERPRINT,
        )
        .map((document) => document.platform),
    }
    const technical = {
      local: {
        cli_version: packageVersion(),
        capabilities: [...SHIPPED_CLI_CAPABILITIES],
      },
      server: compatibility,
      capability_documents: documents.map((document) => ({
        platform: document.platform,
        schema_version: document.schema_version,
        notification_contract_fingerprint: document.notification_contract_fingerprint,
      })),
      cli_capability_intersection: cliCapabilityIntersection,
      notification_contract: notificationContract,
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
          command: updateCliCommand(deps),
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
          : CLI_UPDATE_AVAILABLE,
        technical,
        remedy: {
          by: 'user-here',
          summary: 'update Notifai',
          command: updateCliCommand(deps),
        },
      }
    }
    if (notificationContract.mismatched_platforms.length > 0) {
      return {
        id: 'contract',
        title: 'Notifai update',
        status: 'optional-gap',
        detail: SERVICE_UPDATE_IN_PROGRESS,
        technical,
        remedy: {
          by: 'user-here',
          summary: 'try again after the service update',
          command: 'notifai doctor',
        },
      }
    }
    if (cliCapabilityIntersection.missing_on_server.length > 0) {
      // Named capabilities are feature-scoped. A service that has not learned
      // this CLI's optional feature yet does not make baseline Notification
      // Requests unavailable, even when every document carries the same schema
      // integer. Structured output names the gap; the human path stays on the
      // local service-update sentence and never invents a version diagnosis.
      return {
        id: 'contract',
        title: 'Notifai update',
        status: 'optional-gap',
        detail: SERVICE_UPDATE_IN_PROGRESS,
        technical,
        remedy: {
          by: 'user-here',
          summary: 'try again after the service update',
          command: 'notifai doctor',
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
      detail: SERVICE_UPDATE_IN_PROGRESS,
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
      status: 'ready',
      detail: `"${inferred}" (inferred from Git or the current directory)`,
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

function projectEnablementReadiness(deps: CommandDeps, config: CliConfig): ReadinessState {
  const binding = projectBinding(deps.cwd, deps.env, config.project.value)
  if (binding === null) {
    return {
      id: 'project-enablement',
      title: 'Project enablement',
      status: 'optional-gap',
      detail: 'no Project is available here; lifecycle hooks stay silent',
    }
  }
  if (projectEnabled(binding)) {
    return {
      id: 'project-enablement',
      title: 'Project enablement',
      status: 'ready',
      detail: `enabled by the User for Project "${binding.project}"`,
    }
  }
  return {
    id: 'project-enablement',
    title: 'Project enablement',
    status: 'optional-gap',
    detail: `disabled for Project "${binding.project}"; installed lifecycle hooks will emit no model guidance`,
    remedy: {
      by: 'cli',
      summary: 'enable Notifai lifecycle behavior for this Project',
      command: 'notifai project enable',
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

function remoteInvalidatedByConfig(
  previous: Readiness,
  config: CliConfig,
  credential: MachineCredential | null,
): boolean {
  const origin = resolvedBaseUrl(config, credential)
  const server = previous.states.find((state) => state.id === 'server')
  return server === undefined || !server.detail.includes(origin)
}

function isNoActivePlanError(err: unknown): err is ApiCallError {
  return err instanceof ApiCallError && err.code === 'no_active_plan'
}

/**
 * Device listing is grant-gated; access status is not. A paired Account whose
 * plan lapsed must not be diagnosed as a revoked machine.
 */
async function probeAccount(
  client: ApiClient,
  credential: MachineCredential,
  baseUrl: string,
): Promise<{
  email: string | null
  devices: RoutableDevice[] | null
  lookupFailed: boolean
  auth: ReadinessState
}> {
  const [devicesOutcome, accessOutcome, requestOutcome] = await Promise.allSettled([
    Promise.resolve().then(() => client.listDevices()),
    Promise.resolve().then(() => client.accessStatus()),
    Promise.resolve().then(() => client.accessRequest()),
  ])
  const access = accessOutcome.status === 'fulfilled' ? accessOutcome.value : null
  const pendingRequest =
    requestOutcome.status === 'fulfilled' ? requestOutcome.value.request : null
  const devices = devicesOutcome.status === 'fulfilled' ? devicesOutcome.value.devices : null
  const email = access?.email ?? null
  const devicesErr = devicesOutcome.status === 'rejected' ? devicesOutcome.reason : null
  const noActivePlan =
    access?.status === 'no_active_plan' || isNoActivePlanError(devicesErr)

  if (noActivePlan) {
    const next =
      (isNoActivePlanError(devicesErr) ? devicesErr.nextAction : null) ??
      `Open ${setupAccessUrl(baseUrl)} to set up access, then retry.`
    const who = email ? ` (${email})` : ''
    // Three values, not two. Someone who asked yesterday is waiting on a person,
    // not on an action of theirs, and telling them to ask again — every run,
    // forever — is the only thing this terminal could get wrong about a wait it
    // cannot shorten.
    return {
      email,
      devices: null,
      lookupFailed: true,
      auth:
        pendingRequest === null
          ? {
              id: 'auth',
              title: 'Account',
              status: 'gap',
              detail: `this account does not have access to Notifai yet${who}`,
              remedy: { by: 'user-elsewhere', summary: next },
            }
          : {
              id: 'auth',
              title: 'Account',
              status: 'gap',
              detail: `access requested on ${pendingRequest.requested_at.slice(0, 10)}${who} — waiting to be granted`,
              remedy: {
                by: 'user-elsewhere',
                summary:
                  'nothing is needed from you; this resumes on the next run once access is granted',
              },
            },
    }
  }

  if (devices !== null) {
    return {
      email,
      devices,
      lookupFailed: false,
      auth: {
        id: 'auth',
        title: 'Account',
        status: 'ready',
        detail: email
          ? `machine ${credential.machineId} accepted (${email})`
          : `machine ${credential.machineId} accepted`,
      },
    }
  }

  const accessErr = accessOutcome.status === 'rejected' ? accessOutcome.reason : null
  const err = [devicesErr, accessErr].find((error) => error instanceof ApiCallError && error.status === 401)
    ?? devicesErr ?? accessErr
  const rejectedCredential = err instanceof ApiCallError && err.status === 401
  if (!rejectedCredential) {
    return {
      email,
      devices: null,
      lookupFailed: true,
      auth: access?.status === 'active'
        ? {
            id: 'auth',
            title: 'Account',
            status: 'ready',
            detail: email
              ? `machine ${credential.machineId} accepted (${email})`
              : `machine ${credential.machineId} accepted`,
          }
        : {
            id: 'auth',
            title: 'Account',
            status: 'gap',
            detail: 'could not check Account access; the saved machine approval is unchanged',
            remedy: { by: 'user-here', summary: 'try again when the service is reachable', command: SETUP_COMMAND },
          },
    }
  }
  return {
    email: null,
    devices: null,
    lookupFailed: true,
    auth: {
      id: 'auth',
      title: 'Account',
      status: 'gap',
      detail: err instanceof ApiCallError ? `${err.code}: ${err.message}` : String(err),
      remedy: {
        by: 'user-here',
        summary: 'this machine is no longer recognised; pair it again',
        command: SETUP_COMMAND,
        interactive: true,
      },
    },
  }
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
    json?: boolean
  } = {},
): Promise<Readiness> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const credential = deps.store.load()
  if (credential) diagnoseIgnoredOriginOverride(deps.io, config, credential)
  const previous = options.previous
  const refresh = options.refresh
  if (previous !== undefined && refresh !== undefined && refresh.length === 0) return previous

  const reuseRemote =
    previous !== undefined &&
    refresh !== undefined &&
    !refresh.includes('remote') &&
    !remoteInvalidatedByConfig(previous, config, credential)
  if (reuseRemote) {
    const reused = remoteStatesFrom(previous)
    if (reused !== null) {
      return {
        states: [
          cliBinReadiness(deps.env, deps.hookPlatform ?? process.platform),
          projectEnablementReadiness(deps, config),
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

  states.push(cliBinReadiness(deps.env, deps.hookPlatform ?? process.platform))
  states.push(projectEnablementReadiness(deps, config))
  states.push(projectReadiness(deps, config))

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
            command: SETUP_COMMAND,
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
    states.push(await compatibilityCheck(compatibilityClient, deps))
  }

  let accountEmail: string | null = null
  let accountLookupFailed = false
  if (!credential || !reachable) {
    const why = !credential ? 'this machine is not paired' : 'the server is unreachable'
    states.push({ id: 'auth', title: 'Account', status: 'unknown', detail: `not checked — ${why}` })
  } else {
    const client = makeClient(deps, baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
    accountClient = client
    const probed = await probeAccount(client, credential, baseUrl)
    accountDevices = probed.devices
    accountEmail = probed.email
    accountLookupFailed = probed.lookupFailed
    states.push(probed.auth)
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
    states.push(states.find((state) => state.id === 'auth')?.status === 'ready'
      ? {
          id: 'devices', title: 'Your devices', status: 'gap',
          detail: 'could not check your Companion Apps',
          remedy: { by: 'user-here', summary: 'retry the device lookup', command: SETUP_COMMAND },
        }
      : { id: 'devices', title: 'Your devices', status: 'unknown', detail: 'not checked — Account access is unresolved' })
  } else {
    const devices = accountDevices
    const companionDevices = devices.filter(
      (device) => device.platform === 'ios' || device.platform === 'android',
    )
    const ready = readyCompanionDevices(companionDevices)
    states.push(
      ready.length > 0
        ? {
            id: 'devices',
            title: 'Your devices',
            status: 'ready',
            detail: `${ready.map((d) => `${d.display_name} (${d.platform})`).join(', ')} ready to receive`,
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
              companionDevices.length === 0
                ? 'no active Companion App registered yet'
                : `${companionDevices.map((d) => `${d.display_name} (${d.platform}, ${d.permission_status})`).join(', ')} — registered but not able to receive`,
            remedy: {
              by: 'user-elsewhere',
              summary: deviceInstallRemedy({
                baseUrl,
                email: accountEmail,
                devices: companionDevices,
              }),
            },
          },
    )
  }

  states.push(await setupProofState(deps, config, accountClient, accountDevices))
  await applyRegistryRecommendation(deps, options.json === true, states)

  return { states }
}

async function applyRegistryRecommendation(
  deps: CommandDeps,
  json: boolean,
  states: ReadinessState[],
): Promise<void> {
  if (
    !shouldConsultCliRegistry({
      ...(deps.io.interactive === undefined ? {} : { interactive: deps.io.interactive }),
      json,
      env: deps.env,
    })
  ) {
    return
  }
  const latest = await latestPublishedCliVersion(deps.fetchImpl)
  const newer = newerPublishedCli(thisCliVersion(), latest)
  if (newer === null) return
  const contract = states.find((state) => state.id === 'contract')
  if (contract === undefined || contract.status === 'gap') return
  contract.status = 'optional-gap'
  contract.detail = CLI_UPDATE_AVAILABLE
  contract.remedy = {
    by: 'user-here',
    summary: 'update Notifai',
    command: updateCliCommand(deps),
  }
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

  const companions = readyCompanionDevices(devices)
  if (companions.length === 0) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'unknown',
      detail: 'not checked — no iPhone or Android Companion App is ready',
    }
  }

  const project = setupProofProject(deps, config.project.value)
  const proof = readSetupProof(deps, project)
  const applies = setupProofApplies(proof, project, companions.map((device) => device.device_id))
  if (!applies) {
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
    const now = (deps.now ?? Date.now)()
    if (setupProofIsStale(proof, now)) {
      return {
        id: 'proof',
        title: 'Delivery proof',
        status: 'gap',
        detail: `${proof.request_id} is older than ${SETUP_PROOF_STALE_MS / 36e5}h with no Companion Receipt; init will send a replacement`,
        remedy: {
          by: 'cli',
          summary: 'replace the stale verification notification',
          command: 'notifai init',
        },
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
  const readiness =
    options.readiness ?? (await assessReadiness(deps, flags.json === true ? { json: true } : {}))
  const blocker = firstBlocker(readiness)
  const ok = blocker === null

  // A human fallback exists only at a real terminal. Pipes, harnesses and
  // non-TTY callers get the structured agent variant even without --json.
  if (flags.json || deps.io.interactive !== true) {
    deps.io.out(
      JSON.stringify(
        { ...readinessJson(readiness), ok, exit_code: ok ? EXIT.ok : EXIT.failed },
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
      if (
        s.remedy?.by !== 'user-elsewhere' &&
        s.remedy?.summary === 'update Notifai' &&
        s.remedy.command !== undefined
      ) {
        deps.io.out(s.remedy.command)
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
  const surfacedUpdate = readiness.states.some(
    (state) => state.id === 'contract' && (state.status === 'gap' || state.status === 'optional-gap'),
  )
  if (blocker !== null && blocker.id !== 'contract') {
    await deps.io.outro?.(`Start with: ${remedyLine(blocker)}`)
  } else if (!surfacedUpdate) {
    await deps.io.outro?.('Everything looks good')
  }
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
export function remedyLine(state: ReadinessState): string {
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
 * `doctor` is a report and keeps its strict verdict here: a Codex Stop handler
 * that would swallow an answer is a real failure and reads as one. `init` is
 * the other consumer, and it treats every state in this group as a report line
 * rather than a blocker — Question Routing is optional automation, and nothing
 * optional may stand between a send-capable setup and its delivery proof.
 *
 * `reportOnly` marks the checks that no command can close, only the passage of
 * a turn. Those are report lines even in `doctor`, because "look again" is not
 * a remedy.
 */
function hookStates(deps: CommandDeps): ReadinessState[] {
  const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)
  const { active, contested } = resolveActiveHarness(
    deps.env,
    deps.cwd,
    (deps.now ?? Date.now)(),
  )
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
    if (contested.length > 1) {
      return [
        {
          id: 'hooks',
          title: 'Question routing',
          status: 'optional-gap',
          detail: `Several harness sessions could own this shell (${contested.map((candidate) => candidate.label).join(', ')}); routing readiness is intentionally not attributed to either one`,
        },
        settings,
      ]
    }
    if (active !== null && !isHookInstallableHarness(active.harness)) {
      return [
        {
          id: 'hooks',
          title: 'Question routing',
          status: 'optional-gap',
          detail: `${active.label}: ${HERMES_QUESTION_ROUTING_UNAVAILABLE.deliveryContract}`,
        },
        settings,
      ]
    }
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
  'hooks (legacy project install)': 'Leftover project hook install',
  'hooks (codex representation)': 'Codex hook representation',
  'hooks (question admission)': 'Question admission',
  'hooks (fired)': 'Hooks have run here',
  'hooks (answer continuation)': 'How an answer returns',
  'hooks (wake route)': 'Direct wake route',
}

function checkTitle(name: string): string {
  return CHECK_TITLES[name] ?? name
}

  return [
    ...hookChecks(deps).map((check) => ({
      id: check.name.replace(/[ ()]+/g, '-').replace(/-$/, ''),
      title: checkTitle(check.name),
      status: check.ok
        ? ('ready' as const)
        : check.reportOnly === true
          ? ('optional-gap' as const)
          : ('gap' as const),
      detail: check.detail,
      ...(check.technical === undefined ? {} : { technical: check.technical }),
      ...(check.ok || (check.reportOnly === true && check.remedy === undefined)
        ? {}
        : {
            remedy: {
              // The check's own remedy when it has one; the generic reinstall
              // line was wrong exactly where it mattered (an unfired pointer
              // needs a prompt, not `hooks install`). A report-only capability
              // with no remedy is intentionally absent, not repairable.
              ...(check.remedy ?? {
                summary: 'the detail above names what to change',
                command: 'notifai hooks install',
              }),
              by: check.remedy?.by ?? ('user-here' as const),
            },
          }),
    })),
    settings,
  ]
}

interface HookCheck {
  /** No command closes this; only a turn that has not happened yet. */
  reportOnly?: boolean
  name: string
  ok: boolean
  detail: string
  technical?: unknown
  /** A remedy truer than the generic `notifai hooks install`. */
  remedy?: {
    by?: 'cli' | 'user-here'
    summary: string
    command: string
    user_action?: { code: string; harness: string; action: string; message: string }
  }
}

function hookChecks(deps: CommandDeps): HookCheck[] {
  const checks: HookCheck[] = []
  const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)

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
    detail: installations.map((i) => `${i.harness} (${i.file})`).join(', '),
  })

  const wired = new Set(installations.map((installation) => installation.harness))
  const unwired = detectedHarnesses(deps.cwd, deps.env).filter((harness) => !wired.has(harness))
  if (unwired.length > 0) {
    checks.push({
      name: 'hooks (detected)',
      ok: false,
      reportOnly: true,
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
  if (contested.length > 1) {
    checks.push({
      name: 'hooks (active harness)',
      ok: false,
      reportOnly: true,
      detail: `Several harness sessions could own this shell (${contested.map((candidate) => candidate.label).join(', ')}); routing readiness is intentionally not attributed to either one`,
    })
  } else if (active !== null && !isHookInstallableHarness(active.harness)) {
    checks.push({
      name: 'hooks (active harness)',
      ok: true,
      reportOnly: true,
      detail: `${active.label}: ${HERMES_QUESTION_ROUTING_UNAVAILABLE.deliveryContract}`,
    })
  } else if (active !== null) {
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
      const exactState = active.sessionId === undefined
        ? null
        : readSessionState(active.sessionId, deps.env)
      const activated = exactState?.harness === active.harness && exactState.last_prompt_at !== undefined
      if (!activated) {
        // The normal condition of hooks installed moments ago: the pointer
        // appears when the harness next fires a hook, and no command can
        // force that. Informational, so `init` walks on to the states it can
        // actually prove instead of exiting over evidence only time produces.
        checks.push({
          name: 'hooks (active session)',
          ok: false,
          reportOnly: true,
          detail: `active ${active.label} session has not published exact lifecycle state — send one ${active.label} prompt, then check again`,
          remedy: {
            summary: `send one ${active.label} prompt — its hook publishes the routing pointer`,
            command: 'notifai doctor',
          },
        })
      } else {
        checks.push({
          name: 'hooks (active session)',
          ok: true,
          detail: `the exact active ${active.label} session has published lifecycle state`,
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
  const missing = installations.flatMap((installation) => {
    const required = requiredHookEvents(installation.harness)
    const installed = new Set(
      installation.handlers
        .map((handler) => handlerEvent(handler.command))
        .filter((event): event is string => event !== null),
    )
    const absent = required.filter((event) => !installed.has(event))
    return absent.length === 0
      ? []
      : [`${installation.file} is missing ${absent.join(', ')}`]
  })
  checks.push({
    name: 'hooks (stale)',
    ok: stale.length === 0 && missing.length === 0,
    detail:
      stale.length === 0 && missing.length === 0
        ? 'every installed handler names an event this build serves, and every required lifecycle handler is present'
        : `${[...stale, ...missing].join('; ')} — rerun \`notifai hooks install\` to refresh the complete lifecycle set`,
  })

  const adapterProblems = installations.flatMap((installation) =>
    (installation.problems ?? []).map((problem) => `${installation.file}: ${problem}`),
  )
  const sharedAdapter = inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform)
  adapterProblems.push(...sharedAdapter.problems)
  const runningTarget = deps.hookInstallTarget
  const runningArtifact =
    runningTarget !== undefined && !isNpxAdapterTarget(runningTarget)
      ? runningTarget.scriptPath
      : process.argv[1]
  const cliInstallations = inspectCliInstallations(
    deps.env,
    deps.hookPlatform ?? process.platform,
    {
      ...(runningArtifact === undefined ? {} : { runningArtifactPath: runningArtifact }),
      currentVersion: packageVersion(),
    },
  )
  const effectiveArtifact = cliInstallations.effective?.artifact_path ?? null
  const adapterMismatch =
    sharedAdapter.problems.length === 0 &&
    effectiveArtifact !== null &&
    !hookAdapterTargetsArtifact(sharedAdapter.target, effectiveArtifact)
  if (adapterMismatch) {
    adapterProblems.push('the registered CLI does not match the effective notifai command')
  }
  if (adapterProblems.length > 0) {
    checks.push({
      name: 'hooks (adapter)',
      ok: false,
      // The adapter is one Machine-level file every harness runs through, so
      // a defect in it is always this machine's to fix and always fixable.
      detail: adapterProblems.join('; '),
      ...(adapterMismatch
        ? { technical: { effective_cli_artifact: effectiveArtifact, registered_target: sharedAdapter.target } }
        : {}),
      ...(adapterMismatch && adapterProblems.length === 1
        ? {
            remedy: {
              by: 'cli' as const,
              summary: 'retarget Question Routing to the effective notifai command',
              command: 'notifai init',
            },
          }
        : {}),
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
            user_action: CODEX_HOOK_APPROVAL_USER_ACTION,
          },
        }),
  })

  const shapeProblems = installations.flatMap((installation) =>
    stopShapeProblems(installation, deps.hookPlatform).map(
      (problem) =>
        `${problem} — run \`notifai hooks install --harness ${installation.harness}\``,
    ),
  )
  checks.push({
    name: 'hooks (stop shape)',
    ok: shapeProblems.length === 0,
    detail:
      shapeProblems.length === 0
        ? `every installed Stop handler declares the shape its harness and host need: Claude Code async on POSIX and blocking on Windows, Codex blocking, each with an explicit ${QUESTION_STOP_TIMEOUT_SECONDS}s full-window budget; non-routing blocking hosts ${NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS}s`
        : shapeProblems.join('; '),
  })

  // A Project-scoped definition an older build wrote still fires beside the
  // Machine one, so each event runs twice and the Project copy keeps serving a
  // definition no install refreshes. Notifai no longer creates these and never
  // accepts one as a working route: it is a gap with an exact removal command.
  const legacy = findLegacyProjectInstallations(
    deps.cwd,
    deps.env,
    deps.hookAdapterHome,
    deps.hookPlatform,
  )
  if (legacy.length > 0) {
    const harnesses = [...new Set(legacy.map((installation) => installation.harness))]
    const command = harnesses
      .map((harness) => `notifai hooks install --harness ${harness}`)
      .join(' && ')
    checks.push({
      name: 'hooks (legacy project install)',
      ok: false,
      detail: `${legacy
        .map((installation) => `${installation.harness} (${installation.file})`)
        .join(', ')} — Notifai installs for this machine only, and a leftover Project copy fires beside it. Run \`${command}\` to remove it`,
      remedy: {
        by: 'cli' as const,
        summary: 'remove the leftover Project-scoped Notifai hooks',
        command,
      },
    })
  }

  const representationProblems = codexRepresentationProblems(deps.env, deps.hookPlatform)
  if (representationProblems.length > 0) {
    checks.push({
      name: 'hooks (codex representation)',
      ok: false,
      detail: representationProblems.join('; '),
    })
  } else {
    const coexistence = codexCoexistenceNotes(deps.env, deps.hookPlatform)
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
    // One Machine installation per harness means the inventory no longer
    // depends on which checkout activated the session, so admission reads the
    // same installations doctor already listed.
    const admissionProblems = activeQuestionRouteProblems(deps, active, installations)
    checks.push({
      name: 'hooks (question admission)',
      ok: admissionProblems.length === 0,
      detail:
        admissionProblems.length === 0
          ? `the active ${active.label} route is exact, current, singular, trusted where applicable, and bounded by a live owner`
          : admissionProblems.join('; '),
      ...(admissionProblems.includes(CODEX_STOP_DEFINITION_NOT_SINGULAR_PROBLEM)
        ? {
            remedy: {
              by: 'cli' as const,
              summary: 'restore exactly one current Codex Stop definition',
              command: 'notifai hooks install --harness codex',
            },
          }
        : admissionProblems.includes(CODEX_STALE_STOP_DEFINITION_PROBLEM)
        ? {
            remedy: {
              summary: 'start one fresh Codex session so it loads the current trusted Stop definition',
              command: 'notifai doctor',
              user_action: CODEX_FRESH_SESSION_USER_ACTION,
            },
          }
        : {}),
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
        : readSessionState(active.sessionId, deps.env).harness === active.harness
          ? { sessionId: active.sessionId, harness: active.harness }
          : null
  const firedState = firedPointer === null ? null : readSessionState(firedPointer.sessionId, deps.env)
  const promptFired = firedState?.last_prompt_at !== undefined
  const stopFired = firedState?.last_stop_at !== undefined
  const fired = firedPointer !== null && promptFired
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
    // UserPromptSubmit proves that this exact session reached the installed
    // lifecycle path. A historical Stop is only telemetry: requiring one made
    // a first-turn question impossible even after the current Stop definition,
    // trust, shape, and continuation owner had all been proven above.
    reportOnly: true,
    detail: fired
      ? active === null
        ? `a session in this directory has run UserPromptSubmit and is ready for this turn's Stop${stopFired ? '; an earlier Stop was also observed' : ''}`
        : `the active ${active.label} session has run UserPromptSubmit and is ready for this turn's Stop${stopFired ? '; an earlier Stop was also observed' : ''}`
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
        : `the routed session has not fired UserPromptSubmit — send one prompt, then check again`,
    ...(fired
      ? {}
      : {
          remedy: {
            summary:
              firedPointer === null
                ? `send one ${active === null || contested.length > 1 ? '' : `${active.label} `}prompt in a session here, then re-check`
                : 'send one prompt in the routed session, then re-check',
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
        (harness) =>
          questionRoutingCapability(harness, deps.hookPlatform ?? process.platform)
            .stopContinuation !== 'unsupported',
      ),
    reportOnly: active === null,
    detail:
      continuationHarnesses.length === 0
        ? active === null
          ? 'no installed harness route to assess'
          : `the active ${active.label} session has no matching continuation adapter`
        : continuationHarnesses
            .map(
              (harness) =>
                `${harness}: ${questionRoutingCapability(harness, deps.hookPlatform ?? process.platform).deliveryContract}`,
            )
            .join('; '),
  })

  const wakeRoute = wakeRouteCheck(deps, active, activeInstallations)
  if (wakeRoute !== null) checks.push(wakeRoute)

  return checks
}

/**
 * Whether an answer arriving after this turn's ordinary continuation returns
 * could start another turn in this exact session without a new User prompt.
 * This is a named optional capability, separate from the held Stop
 * continuation that already makes Question Routing usable.
 *
 * Read-only, and deliberately so: nothing here connects to a socket, takes a
 * lock, or sends a message. A diagnostic that wakes the agent it is diagnosing
 * would be its own bug report.
 *
 * Everything it can report negatively is optional rather than a routing
 * failure: a held continuation can still return the answer, or the accepted
 * journal can replay it at the session's next turn. What it buys is that the
 * direct-wake capability and its limits have an explicit name.
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
    const platform = deps.hookPlatform ?? process.platform
    if (platform === 'win32') {
      return {
        name: 'hooks (wake route)',
        ok: false,
        reportOnly: true,
        technical: { held_stop_continuation: true },
        detail:
          'direct inbox wake is unavailable on Windows; the held Stop still returns the answer to this same Agent Session without another User prompt',
      }
    }
    const readiness = inspectClaudeInbox({
      pid: deps.claudeSourcePid ?? claudeSessionPid(deps.env),
      platform,
      readDescriptor:
        deps.claudeWake?.readDescriptor ?? systemClaudeWakeAdapters(deps.env).readDescriptor,
      socketExists: (socketPath) => existsSync(socketPath),
    })
    return {
      name: 'hooks (wake route)',
      ok: readiness.state === 'ready',
      reportOnly: true,
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
      reportOnly: true,
      technical: { held_stop_continuation: true },
      detail:
        readiness.state === 'ready'
          ? `the held Codex turn continues from its own hook, and after it returns ${readiness.lockDirectory} can prove a stopped thread unowned before resuming it`
          : `the held Codex turn still continues from its own hook, but after it returns nothing can be resumed: ${readiness.reason}. Answers wait for the next turn`,
    }
  }
  return null
}
