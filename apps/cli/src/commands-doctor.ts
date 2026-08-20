import { PLATFORMS, SHIPPED_CLI_CAPABILITIES, type RoutableDevice } from '@raidiant/notifai-protocol'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { inspectClaudeInbox, systemClaudeWakeAdapters } from './claude-wake.js'
import { ApiCallError, type ApiClient } from './client.js'
import { inspectCodexResume } from './codex-wake.js'
import { type CliConfig } from './config.js'
import { HARNESS_CAPABILITIES, HARNESS_LABELS } from './harnesses.js'
import { inspectHookAdapter } from './hook-adapter.js'
import {
  readLiveProjectSessionPointers,
  readMatchingProjectSessionPointer,
  readProjectSessionPointer,
  readSessionState,
} from './hooks.js'
import {
  BLOCKING_STOP_TIMEOUT_SECONDS,
  CLAUDE_ASYNC_STOP_TIMEOUT_SECONDS,
  codexCoexistenceNotes,
  codexHomeNote,
  codexLayerDir,
  codexLayerPaths,
  codexProjectRoot,
  codexRepresentationProblems,
  codexTrustProblems,
  detectedHarnesses,
  findInstallations,
  handlerEvent,
  inspectCodexLayer,
  type Installation,
} from './install-hooks.js'
import { inferInvocationContext } from './invocation-context.js'
import type { SkillScope } from './native-skills.js'
import {
  firstBlocker,
  type Readiness,
  type ReadinessRefresh,
  type ReadinessState,
  type StateStatus,
} from './readiness.js'
import { packageVersion } from './release.js'
import type { Tone } from './ui/theme.js'
import {
  EXIT,
  UPDATE_CLI_COMMAND,
  loadLoggedConfig,
  makeClient,
  resolvedBaseUrl,
  type CommandDeps,
} from './commands-core.js'
import { deviceInstallRemedy, readyCompanionDevices, supportPageUrl } from './commands-devices.js'
import {
  activeHarnessSession,
  claudeSessionPid,
  resolveActiveHarness,
  type ActiveHarnessSession,
} from './commands-harness-context.js'
import { stopShapeProblems } from './commands-hook-shape.js'
import { HOOK_EVENTS, activeQuestionRouteProblems, hookActivationAdvice } from './commands-hooks.js'
import { observedCompanionReceipt, readSetupProof } from './commands-setup-proof.js'
import { skillReadiness } from './commands-skill.js'

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
    const serverCapabilities = new Set(compatibility.server_capabilities)
    const cliCapabilityIntersection = {
      available: SHIPPED_CLI_CAPABILITIES.filter((capability) => serverCapabilities.has(capability)),
      missing_on_server: SHIPPED_CLI_CAPABILITIES.filter(
        (capability) => !serverCapabilities.has(capability),
      ),
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
      })),
      cli_capability_intersection: cliCapabilityIntersection,
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
        detail: 'The service is being updated; try again later.',
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
                ? `no active Companion device registered yet; install Notifai via ${supportPageUrl(baseUrl)}`
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

  const companions = readyCompanionDevices(devices)
  if (companions.length === 0) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'unknown',
      detail: 'not checked — no iPhone or Android Companion App is ready',
    }
  }

  const proof = readSetupProof(deps)
  const target =
    proof === null
      ? null
      : companions.find((device) => device.device_id === proof.device_id)
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
