import { CAPABILITIES_V1, PLATFORMS, REPLY_MAX_QUESTIONS } from '@raidiant/notifai-protocol'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_ACKNOWLEDGEMENT_MAX_LENGTH } from '@raidiant/notifai-protocol'
import type {
  CapabilityDocument,
  CompatibilityResponse,
  EvidenceSnapshot,
  ListRepliesResponse,
  Platform,
  ReplyView,
  SubmissionReceipt,
  SubmitNotificationRequestT,
  SupportAssessment,
} from '@raidiant/notifai-protocol'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import type { ClaudeWakeAdapters } from './claude-wake.js'
import {
  acknowledgeCommand,
  askCommand,
  accessStatusCommand,
  authStatusCommand,
  buildQuestions,
  assessReadiness,
  capabilitiesCommand,
  closeCommand,
  configExplainCommand,
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
  contradictingAnswer,
  describeHookFailure,
  devicesCommand,
  doctorCommand,
  EXIT,
  hooksInstallCommand,
  hooksUninstallCommand,
  initCommand,
  SKILLS_SOURCE,
  loginCommand,
  logsCommand,
  parseSince,
  projectSlugFrom,
  repliesCommand,
  sendCommand,
  statusCommand,
  updateCliCommand,
  agentSessionRenameCommand,
  type CommandDeps,
  type CommandIo,
  type CommandSpinner,
} from './commands.js'
import {
  applyPlan,
  buildHookConfig,
  hookCommand,
  codexHookIdentityHash,
  codexTrustKey,
  findInstallations,
  handlerEvent,
  QUESTION_STOP_TIMEOUT_SECONDS,
  settingsFile,
} from './install-hooks.js'
import {
  inspectQuestionState,
  readSessionState,
  writeProjectSession,
  writeSessionState,
} from './hooks.js'
import { nativeSkills as realNativeSkills, type NativeSkill, type NativeSkills, type SkillScope } from './native-skills.js'
import { CONFIG_KEYS, loadConfig, personalProjectConfigPath, sessionConfigPath, stateDir } from './config.js'
import { SETUP_PROOF_STALE_MS, writeSetupProof } from './commands-setup-proof.js'
import { resetLatestPublishedCliVersionForTest } from './cli-release.js'
import { activeLogPath, createLogger, logsDiskUsage, readLogRecords } from './logging.js'
import { hookAdapterPath, inspectHookAdapter, installHookAdapter } from './hook-adapter.js'
import type { Tone } from './ui/theme.js'
import { projectBinding, projectEnabled } from './project-enablement.js'
import { firstRequiredBlocker } from './readiness.js'
import { readOrcaSessionTitle, type OrcaCommand } from './orca-session-title.js'

afterEach(() => {
  resetLatestPublishedCliVersionForTest()
})

/**
 * The release tag this build pins the agent skill to.
 *
 * Read from the manifest for the same reason the CLI itself does: a fixture
 * carrying a literal tag stops matching the moment the version is bumped, and
 * a test that has to be hand-edited on every release is a copy of the constant
 * it is supposed to be checking.
 */
const RELEASE_REF = `v${
  (
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
  ).version
}`
const CLI_VERSION = RELEASE_REF.slice(1)

const RELEASE_SKILL = fileURLToPath(new URL('../../../skills/notifai/', import.meta.url))

function installCurrentSkill(destination: string): void {
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(RELEASE_SKILL, destination, { recursive: true })
}

const currentSupport: SupportAssessment = {
  state: 'current',
  reason: 'current',
  affected_operation: null,
  recovery_action: null,
  current_version: '5.0.0',
  current_build: null,
  recommended_version: '5.0.0',
  recommended_build: null,
  minimum_version: null,
  minimum_build: null,
  deprecation: null,
  sunset: null,
}

const currentCompatibility: CompatibilityResponse = {
  cli: currentSupport,
  platforms: [
    {
      platform: 'ios',
      recommended_version: null,
      recommended_build: null,
      minimum_receive_build: null,
      minimum_answer_build: null,
      deprecation: null,
      sunset: null,
      replacement_available: false,
      rollout_complete: false,
    },
    {
      platform: 'macos',
      recommended_version: null,
      recommended_build: null,
      minimum_receive_build: null,
      minimum_answer_build: null,
      deprecation: null,
      sunset: null,
      replacement_available: false,
      rollout_complete: false,
    },
    {
      platform: 'android',
      recommended_version: null,
      recommended_build: null,
      minimum_receive_build: null,
      minimum_answer_build: null,
      deprecation: null,
      sunset: null,
      replacement_available: false,
      rollout_complete: false,
    },
  ],
  server_capabilities: ['answer', 'agent_acknowledgement'],
}

function compatibilityWithCli(
  overrides: Partial<SupportAssessment>,
): CompatibilityResponse {
  return {
    ...currentCompatibility,
    cli: { ...currentSupport, ...overrides },
  }
}

function withCompatibilityDefaults(client: ApiClient): ApiClient {
  return {
    capabilities: async (platform: Platform = 'ios') => {
      const document = CAPABILITIES_V1.describe(platform)
      if (document === null) throw new Error(`missing ${platform} capability document`)
      return document
    },
    compatibility: async () => currentCompatibility,
    ...client,
  } as ApiClient
}

class CapturedIo implements CommandIo {
  outLines: string[] = []
  errLines: string[] = []
  openedUrls: string[] = []

  out(line: string) {
    this.outLines.push(line)
  }

  err(line: string) {
    this.errLines.push(line)
  }

  async confirm() {
    return false
  }

  openUrl(url: string) {
    this.openedUrls.push(url)
  }
}

class PlainInteractiveIo extends CapturedIo {
  interactive = true
}

class OutroCapturedIo extends CapturedIo {
  outros: string[] = []

  async outro(message: string) {
    this.outros.push(message)
  }
}

class InteractiveIo extends CapturedIo {
  interactive = true
  selectAnswer: string | null = 'global'
  /** When set, answers are consumed in order; falls back to confirmAnswer. */
  confirmAnswers: boolean[] | null = null
  confirmAnswer = true
  prompts: string[] = []
  notes: { message: string; title?: string }[] = []
  intros: string[] = []
  outros: string[] = []
  spinnerEvents: string[] = []
  checks: { ok: boolean; message: string; tone?: Tone }[] = []

  override async confirm(question: string) {
    this.prompts.push(question)
    if (this.confirmAnswers !== null && this.confirmAnswers.length > 0) {
      return this.confirmAnswers.shift()!
    }
    return this.confirmAnswer
  }

  async select(
    message: string,
    _options: { value: string; label: string; hint?: string }[],
  ): Promise<string | null> {
    this.prompts.push(message)
    return this.selectAnswer
  }

  multiselectAnswer: string[] | null = null

  async multiselect(
    message: string,
    _options: { value: string; label: string; hint?: string }[],
    _initial?: string[],
  ): Promise<string[] | null> {
    this.prompts.push(message)
    return this.multiselectAnswer
  }

  async intro(title: string) {
    this.intros.push(title)
  }

  async outro(message: string) {
    this.outros.push(message)
  }

  async note(message: string, title?: string) {
    this.notes.push({ message, ...(title === undefined ? {} : { title }) })
  }

  async spinner(message: string): Promise<CommandSpinner> {
    this.spinnerEvents.push(`start:${message}`)
    return {
      message: (next) => this.spinnerEvents.push(`message:${next}`),
      stop: (next) => this.spinnerEvents.push(`stop:${next}`),
      error: (next) => this.spinnerEvents.push(`error:${next}`),
    }
  }

  async check(ok: boolean, message: string, tone?: Tone) {
    this.checks.push({ ok, message, ...(tone === undefined ? {} : { tone }) })
  }
}

function trustInstalledCodexHooks(cwd: string, env: NodeJS.ProcessEnv): void {
  const home = env['HOME']
  if (home === undefined || home === '') {
    throw new Error(
      'trustInstalledCodexHooks requires env.HOME; refusing to use the real home directory',
    )
  }
  const resolvedHome = path.resolve(home)
  const tmpRoot = path.resolve(os.tmpdir())
  const underTmp = resolvedHome === tmpRoot || resolvedHome.startsWith(`${tmpRoot}${path.sep}`)
  if (!underTmp) {
    throw new Error(
      `trustInstalledCodexHooks will only write under ${tmpRoot}, not ${resolvedHome}`,
    )
  }
  const codexHome = env['CODEX_HOME'] !== undefined && env['CODEX_HOME'] !== ''
    ? path.resolve(env['CODEX_HOME'])
    : path.join(resolvedHome, '.codex')
  if (codexHome !== tmpRoot && !codexHome.startsWith(`${tmpRoot}${path.sep}`)) {
    throw new Error(
      `trustInstalledCodexHooks will only write under ${tmpRoot}, not ${codexHome}`,
    )
  }
  const file = path.join(codexHome, 'config.toml')
  const installations = findInstallations(cwd, env).filter(
    (installation) => installation.harness === 'codex',
  )
  const sections = installations.flatMap((installation) =>
    installation.handlers.map((handler) => {
      const key = codexTrustKey(installation, handler)
      return `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`
    }),
  )
  mkdirSync(path.dirname(file), { recursive: true })
  // Trust lives in the same config.toml as inline [hooks]. Overwriting the
  // file would delete the global handlers this helper is trying to trust.
  const existing = existsSync(file) ? readFileSync(file, 'utf8').trimEnd() : ''
  writeFileSync(file, [existing, ...sections].filter((block) => block.length > 0).join('\n') + '\n')
}

function makeDeps(io: CapturedIo, client: ApiClient): CommandDeps {
  const testRoot = path.join(os.tmpdir(), 'notifai-cli-command-tests')
  return {
    io,
    store: {
      load: () => ({
        machineId: 'mac_test',
        secret: 'test-secret',
        baseUrl: 'https://test.notifai.invalid',
        machineName: 'test-machine',
      }),
      save: () => {},
      clear: () => {},
      describe: () => 'test credential store',
    },
    env: {
      XDG_CONFIG_HOME: testRoot,
      XDG_STATE_HOME: path.join(os.tmpdir(), 'notifai-cli-command-tests-state'),
    },
    hookAdapterHome: path.join(testRoot, 'home'),
    cwd: os.tmpdir(),
    clientFactory: () => withCompatibilityDefaults(client),
    fetchImpl: async () => new Response('{}', { status: 503 }),
  }
}

/**
 * An environment that cannot see the machine running the suite.
 *
 * Harness discovery walks the real home directory whenever the environment
 * names no override, so a developer with Notifai's own global hooks installed
 * was silently running these cases against their own settings file — and a
 * check that failed on that file failed only for them. Every setup case that
 * asserts on readiness therefore gets its own home.
 */
function isolatedEnv(cwd: string): NodeJS.ProcessEnv {
  const home = path.join(cwd, 'home')
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode'),
    XDG_CONFIG_HOME: path.join(cwd, 'config'),
    XDG_STATE_HOME: path.join(cwd, 'state'),
  }
}

const receipt: SubmissionReceipt = {
  request_id: 'req_reply_test',
  reply_expires_at: '2026-08-02T18:00:00.000Z',
  agent_acknowledgement_required: true,
  agent_acknowledgement_text_required: true,
  replayed: false,
  overall: 'provider_accepted_all',
  deliveries: [
    {
      delivery_id: 'del_reply_test',
      device_id: 'dev_test',
      device_name: 'iPhone',
      state: 'provider_accepted',
      attempts: 1,
      provider_status: 200,
      provider_reason: null,
      provider_id: 'provider_test',
      updated_at: '2026-08-01T18:00:00.000Z',
    },
  ],
  warnings: [],
}

const reply: ReplyView = {
  reply_id: 'rpl_test',
  seq: 1,
  delivery_id: 'del_reply_test',
  device_id: 'dev_test',
  device_name: 'iPhone',
  text: 'yes, after the migration',
  answers: [],
  source: null,
  created_at: '2026-08-01T18:01:00.000Z',
}

function replyResponse(
  replies: ReplyView[] = [],
  options: {
    required?: boolean
    textRequired?: boolean
    acknowledgement?: ListRepliesResponse['agent_acknowledgement']
  } = {},
): ListRepliesResponse {
  return {
    request_id: receipt.request_id,
    reply_expires_at: '2026-08-02T18:00:00.000Z',
    agent_acknowledgement_required: options.required ?? true,
    agent_acknowledgement_text_required: options.textRequired ?? true,
    agent_acknowledgement: options.acknowledgement ?? null,
    replies,
  }
}

describe('command contracts', () => {
  it('durably enables a valid in-Project send before missing authentication stops it', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-explicit-enable-'))
    const io = new CapturedIo()
    const env = isolatedEnv(cwd)
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }
    expect(await sendCommand(deps, { title: 'Ready', body: 'Ready.', kind: 'done' })).toBe(EXIT.auth)
    expect(projectEnabled(projectBinding(cwd, env))).toBe(true)
  })

  it('sends deliberately Projectless without enabling the inferred Project', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-projectless-'))
    const io = new CapturedIo()
    const env = isolatedEnv(cwd)
    let submitted: SubmitNotificationRequestT | undefined
    const client = { submit: async (body: SubmitNotificationRequestT) => ((submitted = body), receipt) } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env }
    expect(await sendCommand(deps, { title: 'Ready', body: 'Ready.', kind: 'done', projectless: true })).toBe(EXIT.ok)
    expect(submitted?.draft.project).toBeUndefined()
    expect(projectEnabled(projectBinding(cwd, env))).toBe(false)
  })
  it('tells an unsigned machine to run init, not login', () => {
    const io = new CapturedIo()
    const deps = makeDeps(io, {} as ApiClient)
    deps.store.load = () => null

    expect(authStatusCommand(deps, {})).toBe(EXIT.auth)
    expect(io.errLines.join('\n')).toMatch(/Not signed in\. Run `notifai init`/)
    expect(io.errLines.join('\n')).not.toContain('notifai login')
  })

  it('shows an actionable no-plan access state', async () => {
    const io = new CapturedIo()
    const client = {
      accessStatus: async () => ({
        status: 'no_active_plan',
        reason: 'no_active_grant',
        expires_at: null,
      }),
    } as unknown as ApiClient

    expect(await accessStatusCommand(makeDeps(io, client), {})).toBe(EXIT.failed)
    expect(io.outLines).toEqual([
      'This account does not have access to Notifai yet.',
      'next: Open https://test.notifai.invalid/setup/access to set up access, then retry.',
    ])
  })

  it('renders capability field paths instead of array indexes', async () => {
    const io = new CapturedIo()
    const document: CapabilityDocument = {
      schema_version: 1,
      platform: 'ios',
      payload_limit_bytes: 4096,
      sounds: ['default'],
      interruption_levels: ['passive', 'active', 'time_sensitive'],
      fields: [
        { path: 'presentation.title', status: 'supported' },
        { path: 'platform.ios.category', status: 'unsupported', reason: 'Deferred from V1.' },
      ],
    }
    const client = { capabilities: async () => document } as unknown as ApiClient

    expect(await capabilitiesCommand(makeDeps(io, client), {})).toBe(EXIT.ok)
    expect(io.outLines).toContain('  presentation.title: supported')
    expect(io.outLines).toContain('  platform.ios.category: unsupported — Deferred from V1.')
    expect(io.outLines.some((line) => line.startsWith('  0:'))).toBe(false)
  })

  it('passes the selected macOS platform through to the capability client', async () => {
    const io = new CapturedIo()
    let requestedPlatform: string | undefined
    const document: CapabilityDocument = {
      schema_version: 1,
      platform: 'macos',
      payload_limit_bytes: 4096,
      sounds: ['default'],
      interruption_levels: ['passive', 'active', 'time_sensitive'],
      fields: [],
    }
    const client = {
      capabilities: async (platform?: string) => {
        requestedPlatform = platform
        return document
      },
    } as unknown as ApiClient

    expect(await capabilitiesCommand(makeDeps(io, client), { platform: 'macos' })).toBe(EXIT.ok)
    expect(requestedPlatform).toBe('macos')
    expect(io.outLines[0]).toBe('macos capability contract v1 (payload limit 4096 bytes)')
  })

  it('passes the selected Android platform through to the capability client', async () => {
    const io = new CapturedIo()
    let requestedPlatform: string | undefined
    const document = CAPABILITIES_V1.describe('android')!
    const client = {
      capabilities: async (platform?: string) => {
        requestedPlatform = platform
        return document
      },
    } as unknown as ApiClient

    expect(await capabilitiesCommand(makeDeps(io, client), { platform: 'android' })).toBe(
      EXIT.ok,
    )
    expect(requestedPlatform).toBe('android')
    expect(io.outLines[0]).toBe(
      'android capability contract v1 (payload limit 4096 bytes)',
    )
  })

  it('filters Device Installations by Android in human and JSON output', async () => {
    const devices = [
      {
        device_id: 'dev_ios',
        display_name: 'iPhone',
        platform: 'ios' as const,
        permission_status: 'authorized',
        registration_healthy: true,
        app_version: '1.0.0',
        app_build: '1',
        os_version: '19',
        capabilities: ['answer'] as const,
        support: currentSupport,
        support_state: 'current' as const,
        derived_status: 'working' as const,
        status_message: null,
        last_seen_at: null,
      },
      {
        device_id: 'dev_android',
        display_name: 'Pixel',
        platform: 'android' as const,
        permission_status: 'authorized',
        registration_healthy: true,
        app_version: '1.0.0',
        app_build: '2',
        os_version: '16',
        capabilities: ['answer'] as const,
        support: currentSupport,
        support_state: 'current' as const,
        derived_status: 'working' as const,
        status_message: null,
        last_seen_at: null,
      },
    ]
    const client = { listDevices: async () => ({ devices }) } as unknown as ApiClient

    const human = new CapturedIo()
    expect(
      await devicesCommand(makeDeps(human, client), { platform: 'android' }),
    ).toBe(EXIT.ok)
    expect(human.outLines).toEqual(['dev_android  Pixel  android  Working'])

    const json = new CapturedIo()
    expect(
      await devicesCommand(makeDeps(json, client), { platform: 'android', json: true }),
    ).toBe(EXIT.ok)
    expect(JSON.parse(json.outLines[0]!)['devices']).toEqual([devices[1]])
  })

  it('rejects an unknown Device Installation platform filter locally', async () => {
    const io = new CapturedIo()
    let calls = 0
    const client = {
      listDevices: async () => {
        calls += 1
        return { devices: [] }
      },
    } as unknown as ApiClient

    expect(await devicesCommand(makeDeps(io, client), { platform: 'linux' })).toBe(
      EXIT.usage,
    )
    expect(calls).toBe(0)
    expect(io.errLines.join('\n')).toContain('ios or macos or android')
  })

  it('rejects an invalid draft before calling submit', async () => {
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      submit: async () => {
        submitCalls += 1
        throw new Error('submit should not be reached')
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), { kind: 'update',
        title: 'T',
        body: 'B',
        project: 'Invalid Project!',
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('project')
  })

  it('persists one opaque retry attempt after an ambiguous submit failure', async () => {
    const io = new CapturedIo()
    let attemptedKey = ''
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        attemptedKey = body.idempotency_key
        throw new NetworkError('Connection closed before a response arrived')
      },
    } as unknown as ApiClient

    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-send-attempt-'))
    const deps = makeDeps(io, client)
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'send' })
    expect(
      await sendCommand(deps, {
        kind: 'done',
        title: 'Checks finished',
        body: 'All checks passed.',
      }),
    ).toBe(EXIT.network)

    expect(attemptedKey).toMatch(/^cli-/)
    expect(io.errLines.join('\n')).toContain('exact semantic send with `--retry`')
    expect(io.errLines.join('\n')).toMatch(/Opaque retry attempt: sat_/)
    expect(
      readLogRecords(deps.env, { event: ['send.attempt'] }).records.at(-1)?.data,
    ).toMatchObject({
      idempotency_key: attemptedKey,
      attempt_id: expect.stringMatching(/^sat_/),
      replay: false,
    })
    rmSync(root, { recursive: true, force: true })
  })

  it('prints an opaque retry instruction for an ambiguous server failure', async () => {
    const io = new CapturedIo()
    const client = {
      submit: async () => {
        throw new ApiCallError(503, 'temporarily_unavailable', 'Try again later.')
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'failed',
        title: 'Validation could not finish',
        body: 'The service failed while accepting the result.',
      }),
    ).toBe(EXIT.network)
    expect(io.errLines.join('\n')).toContain('exact semantic send with `--retry`')
  })

  it('reuses the opaque attempt key only after an explicit exact semantic retry', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-send-retry-'))
    const io = new CapturedIo()
    const keys: string[] = []
    let calls = 0
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        keys.push(body.idempotency_key)
        calls += 1
        if (calls === 1) throw new NetworkError('killed after an ambiguous boundary')
        return { ...receipt, replayed: true }
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd: root,
      env: { XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') },
    }
    const semantic = { kind: 'done', title: 'Recovery completed', body: 'The exact work is done.' }

    expect(await sendCommand(deps, semantic)).toBe(EXIT.network)
    expect(await sendCommand(deps, { ...semantic, retry: true })).toBe(EXIT.ok)
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(await sendCommand(deps, { ...semantic, retry: true })).toBe(EXIT.usage)
  })

  it('routes a send with no active Companion devices into the setup coordinator', async () => {
    const io = new CapturedIo()
    const client = {
      submit: async () => {
        throw new ApiCallError(
          409,
          'no_active_devices',
          'No enabled active Device Installation can receive this request.',
          'Open the Companion App and enable notifications.',
        )
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'done',
        title: 'Checks finished',
        body: 'All checks passed.',
      }),
    ).toBe(EXIT.failed)

    expect(io.errLines.join('\n')).toMatch(/next:.*`notifai init`.*Companion/i)
    expect(io.errLines.join('\n')).toContain('exact original Notification Request with `--retry`')
    expect(io.errLines.join('\n')).toMatch(/verification request does not replace this Agent Event/i)
  })

  it('routes a send from an unpaired machine into the same setup coordinator', async () => {
    const io = new CapturedIo()
    const deps = makeDeps(io, {} as ApiClient)
    deps.store.load = () => null

    expect(
      await sendCommand(deps, {
        kind: 'done',
        title: 'Checks finished',
        body: 'All checks passed.',
      }),
    ).toBe(EXIT.auth)

    expect(io.errLines.join('\n')).toMatch(/`notifai init`.*login.*device setup/i)
  })

  it('authors and validates an Android-specific Notification Request', async () => {
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'done',
        title: 'Android build finished',
        body: 'All checks passed.',
        platform: 'android',
        sound: 'none',
        data: ['run_id=42'],
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.platform).toEqual({
      android: { sound: null, custom_data: { run_id: '42' } },
    })
    expect(io.errLines).toEqual([])
  })

  it('sends an Account custom sound name on the draft', async () => {
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'done',
        title: 'Build finished',
        body: 'All checks passed.',
        sound: 'Kitchen timer',
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.platform?.ios?.sound).toBe('Kitchen timer')
    expect(submitted?.draft.platform?.android?.sound).toBe('Kitchen timer')
  })

  it('prints Android downgrade warnings before submitting', async () => {
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      submit: async () => {
        submitCalls += 1
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'update',
        title: 'Android evidence',
        body: 'See the attached result.',
        platform: 'android',
        image: ['med_result'],
        threadId: 'android-results',
      }),
    ).toBe(EXIT.ok)
    expect(submitCalls).toBe(1)
    expect(io.errLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('presentation.media'),
        expect.stringContaining('platform.android.thread_id'),
      ]),
    )
  })

  it('rejects an Android interruption level before submission', async () => {
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      submit: async () => {
        submitCalls += 1
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'update',
        title: 'Android update',
        body: 'Ready.',
        platform: 'android',
        level: 'active',
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain(
      'Android does not support caller-selected interruption levels',
    )
  })

  it('infers Project and exact Claude Source Context without printing the opaque id', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'Notifai Project '))
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'opaque-claude-session-42',
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'All checks passed',
        body: '**42 checks** passed.',
        kind: 'done',
      }),
    ).toBe(EXIT.ok)

    expect(submitted?.draft.project).toMatch(/^notifai-project-/)
    expect(submitted?.draft.source).toMatchObject({
      session_id: 'opaque-claude-session-42',
      harness: 'claude-code',
    })
    expect(submitted?.draft.source?.session_label).toBe('Rapid Antelope')
    expect(io.errLines).toContain(
      'Heads up (source.session_label): No semantic Agent Session title was available; using generated fallback "Rapid Antelope". Pass --session-label with a concise task name when one is available.',
    )
    expect(io.outLines.join('\n')).not.toContain('opaque-claude-session-42')
    expect(io.errLines.join('\n')).not.toContain('opaque-claude-session-42')
  })

  it('uses trusted Orca task context for an active Claude Agent Session label', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-claude-title-'))
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const worktreeId = `repo-123::${cwd}`
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'orca-claude-session',
      TERM_PROGRAM: 'Orca',
      ORCA_WORKTREE_ID: worktreeId,
    }
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env,
      orcaSessionTitle: () => 'Agent Session context labels',
    }

    expect(
      await sendCommand(deps, {
        title: 'Resolver implemented',
        body: 'The Orca worktree title was frozen locally.',
        kind: 'done',
      }),
    ).toBe(EXIT.ok)

    expect(submitted?.draft.source).toMatchObject({
      session_id: 'orca-claude-session',
      session_label: 'Agent Session context labels',
      harness: 'claude-code',
    })
  })

  it('uses trusted Orca task context for an active Codex Agent Session label', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-codex-title-'))
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const worktreeId = `repo-123::${cwd}`
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_THREAD_ID: 'orca-codex-thread',
        TERM_PROGRAM: 'Orca',
        ORCA_WORKTREE_ID: worktreeId,
      },
      orcaSessionTitle: () => 'Release verification',
    }

    expect(
      await sendCommand(deps, {
        title: 'Resolver implemented',
        body: 'The worktree title belongs to every harness Orca starts in it.',
        kind: 'done',
      }),
    ).toBe(EXIT.ok)

    expect(submitted?.draft.source).toMatchObject({
      session_id: 'orca-codex-thread',
      session_label: 'Release verification',
      harness: 'codex',
    })
  })

  it('uses the native Codex Desktop/CLI title when no Orca context exists', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-desktop-title-'))
    const codexHome = path.join(cwd, 'codex-home')
    mkdirSync(codexHome)
    writeFileSync(
      path.join(codexHome, 'session_index.jsonl'),
      `${JSON.stringify({
        id: 'fixture-session-7409',
        thread_name: 'Synthetic desktop task',
        updated_at: '2026-08-30T10:02:00Z',
      })}\n`,
    )
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: 'fixture-session-7409',
        TERM_PROGRAM: 'Apple_Terminal',
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Resolver implemented',
        body: 'Codex supplied the semantic session title directly.',
        kind: 'done',
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.source).toMatchObject({
      session_id: 'fixture-session-7409',
      session_label: 'Synthetic desktop task',
      session_label_source: 'semantic',
      harness: 'codex',
    })
    expect(io.errLines.join('\n')).not.toContain('generated fallback')
  })

  it('uses the exact Orca Agent Session task title instead of an Ash Rabbit fallback', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-agent-session-title-'))
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const worktreeId = `repo-123::${cwd}`
    const paneKey = 'tab-synthetic:leaf-title-fixture'
    const orcaCommand: OrcaCommand = (_executable, args) => {
      if (args[0] === 'worktree' && args[1] === 'ps') {
        return JSON.stringify({
          ok: true,
          result: {
            worktrees: [
              {
                worktreeId,
                path: cwd,
                agents: [
                  {
                    paneKey,
                    taskTitle: 'Synthetic title fixture',
                  },
                ],
              },
            ],
          },
        })
      }
      return null
    }
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CODEX_THREAD_ID: 'fixture-session-7409',
      TERM_PROGRAM: 'Orca',
      ORCA_WORKTREE_ID: worktreeId,
      ORCA_PANE_KEY: paneKey,
    }

    expect(
      await sendCommand(
        {
          ...makeDeps(io, client),
          cwd,
          env,
          orcaSessionTitle: (sourceEnv) => readOrcaSessionTitle(sourceEnv, orcaCommand),
        },
        {
          title: 'Synthetic fixture is ready',
          body: 'The neutral regression fixture is complete.',
          kind: 'done',
        },
      ),
    ).toBe(EXIT.ok)

    expect(submitted?.draft.source).toMatchObject({
      session_id: 'fixture-session-7409',
      session_label: 'Synthetic title fixture',
      harness: 'codex',
    })
    expect(io.errLines.join('\n')).not.toContain('generated fallback')
  })

  it('sends after isolating an invalid session-name record without losing valid names', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-invalid-session-name-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CODEX_THREAD_ID: 'current-session',
    }
    const file = path.join(stateDir(env), 'session-labels.json')
    const validKey = createHash('sha256').update('unrelated-session').digest('hex')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [validKey]: {
              label: 'Unrelated work',
              source: 'explicit',
              first_seen_at: 1_777_777_777_000,
              harness: 'codex',
            },
            obsolete: {
              label: 'Old shape',
              source: 'legacy',
              first_seen_at: 'unknown',
            },
          },
        },
        null,
        2,
      )}\n`,
    )

    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(
        { ...makeDeps(io, client), cwd, env },
        { title: 'Store recovered', body: 'The valid Agent Session name survived.', kind: 'done' },
      ),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.source).toMatchObject({
      session_id: 'current-session',
      harness: 'codex',
    })

    const recovered = JSON.parse(readFileSync(file, 'utf8')) as {
      sessions: Record<string, { label: string }>
    }
    expect(recovered.sessions[validKey]?.label).toBe('Unrelated work')
    expect(recovered.sessions['obsolete']).toBeUndefined()
    const backups = readdirSync(path.dirname(file)).filter((name) =>
      /^session-labels\.invalid-[a-f0-9]{64}\.json$/u.test(name),
    )
    expect(backups).toHaveLength(1)
    expect(readFileSync(path.join(path.dirname(file), backups[0]!), 'utf8')).toContain(
      '"obsolete"',
    )
  })

  it('falls back safely when Orca returns a private path as its title', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-private-title-'))
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'orca-private-title-session',
        TERM_PROGRAM: 'Orca',
        ORCA_WORKTREE_ID: `repo-123::${cwd}`,
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Resolver implemented',
        body: 'Unsafe metadata must never become a visible name.',
        kind: 'done',
      }),
    ).toBe(EXIT.ok)

    expect(submitted?.draft.source?.session_label).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(submitted?.draft.source?.session_label).not.toContain('/private/')
  })

  it('uses the trusted OpenCode session title published by its managed adapter', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-title-'))
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        NOTIFAI_ACTIVE_HARNESS: 'opencode',
        NOTIFAI_ACTIVE_SESSION_ID: 'opencode-session',
        NOTIFAI_ACTIVE_SESSION_LABEL: 'Semantic session names',
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Resolver implemented',
        body: 'The first-party title was frozen locally.',
        kind: 'done',
      }),
    ).toBe(EXIT.ok)

    expect(submitted?.draft.source).toMatchObject({
      session_id: 'opencode-session',
      session_label: 'Semantic session names',
      harness: 'opencode',
    })
  })

  it('does not freeze or submit an OpenCode placeholder title', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-pending-'))
    const io = new CapturedIo()
    let submitted = false
    const client = {
      submit: async () => {
        submitted = true
        return receipt
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        NOTIFAI_ACTIVE_HARNESS: 'opencode',
        NOTIFAI_ACTIVE_SESSION_ID: 'opencode-session',
        NOTIFAI_ACTIVE_SESSION_LABEL_PENDING: '1',
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Resolver implemented',
        body: 'Wait for the semantic title before freezing a name.',
        kind: 'done',
      }),
    ).toBe(EXIT.usage)
    expect(submitted).toBe(false)
    expect(io.errLines.join('\n')).toContain('still generating this session')
    expect(existsSync(path.join(cwd, 'state', 'notifai', 'session-labels.json'))).toBe(false)
  })

  it('sends Hermes Source Context from HERMES_SESSION_ID and the invocation cwd', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-send-'))
    const repo = path.join(root, 'notifai')
    const worktree = path.join(root, 'hermes-topic')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    git('init')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(path.join(repo, 'file'), 'x')
    git('add', 'file')
    git('commit', '-m', 'fixture')
    git('worktree', 'add', worktree, '-b', 'feature/hermes-send')

    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const sessionId = '20260828_111302_29a404'
    const deps = {
      ...makeDeps(io, client),
      cwd: worktree,
      env: {
        ...isolatedEnv(worktree),
        HERMES_SESSION_ID: sessionId,
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Hermes baseline landed',
        body: 'Classic CLI send carries exact session identity.',
        kind: 'done',
      }),
    ).toBe(EXIT.ok)

    expect(submitted?.draft.source).toMatchObject({
      session_id: sessionId,
      harness: 'hermes',
      branch: 'feature/hermes-send',
      worktree: 'hermes-topic',
    })
    expect(io.outLines.join('\n')).not.toContain(sessionId)

    submitted = undefined
    expect(
      await sendCommand(
        {
          ...deps,
          env: {
            ...deps.env,
            HERMES_SESSION_KEY: 'gateway-route-key-must-not-be-session-id',
          },
        },
        {
          title: 'Hermes deferred surface sent',
          body: 'The send stays universal while unproven Source Context is omitted.',
          kind: 'done',
        },
      ),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.source).toMatchObject({
      branch: 'feature/hermes-send',
      worktree: 'hermes-topic',
    })
    expect(submitted?.draft.source).not.toHaveProperty('session_id')
    expect(submitted?.draft.source).not.toHaveProperty('harness')
    expect(JSON.stringify(submitted?.draft.source)).not.toContain('gateway-route-key')
  })

  it('does not attribute Hermes Source Context when another harness marker is nested', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-nested-send-'))
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        ...isolatedEnv(cwd),
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
        HERMES_SESSION_ID: '20260828_111302_29a404',
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Nested send stays honest',
        body: 'Ambiguous ownership omits harness identity.',
        kind: 'update',
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.source?.harness).toBeUndefined()
    expect(submitted?.draft.source?.session_id).toBeUndefined()
  })

  it('uploads repeatable images in order and sends only canonical media references', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-media-order-'))
    const first = path.join(root, 'first.png')
    const second = path.join(root, 'second.gif')
    writeFileSync(first, 'first image')
    writeFileSync(second, 'second image')
    const uploaded: string[] = []
    let grants = 0
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      createMediaUpload: async () => {
        grants += 1
        return {
          media_id: `med_uploaded_${grants}`,
          upload_url: `https://upload.invalid/${grants}`,
          upload_headers: {},
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }
      },
      uploadMedia: async (grant: { media_id: string }) => {
        uploaded.push(grant.media_id)
      },
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(new CapturedIo(), client), { kind: 'update',
        title: 'Visual comparison is ready',
        body:
          '![first](media:1) ![second](media:2) ![ready](media:med_existing)',
        image: [first, second, 'med_attached_only'],
        imageAlt: ['First state', 'Second state'],
      }),
    ).toBe(EXIT.ok)

    expect(uploaded).toEqual(['med_uploaded_1', 'med_uploaded_2'])
    expect(submitted?.draft.presentation.media).toEqual([
      { media_id: 'med_uploaded_1', alt: 'First state' },
      { media_id: 'med_uploaded_2', alt: 'Second state' },
      { media_id: 'med_attached_only' },
    ])
    expect(submitted?.draft.presentation.body).toBe(
      '![first](media:med_uploaded_1) ![second](media:med_uploaded_2) ![ready](media:med_existing)',
    )
    expect(submitted?.draft.presentation.body).not.toMatch(/media:[1-8](?!\d)/)
  })

  it('rejects media cardinality and alt pairing before any upload', async () => {
    const io = new CapturedIo()
    let uploads = 0
    const client = {
      createMediaUpload: async () => {
        uploads += 1
        throw new Error('must not upload')
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), { kind: 'update',
        title: 'Visual comparison',
        body: 'See it.',
        image: ['one.png'],
        imageAlt: ['one', 'two'],
      }),
    ).toBe(EXIT.usage)
    expect(uploads).toBe(0)
    expect(io.errLines.join(' ')).toContain('2 --image-alt')
  })

  it('rejects done plus reply before authentication or submission', async () => {
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      submit: async () => {
        submitCalls += 1
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Done',
        body: 'Answer?',
        kind: 'done',
        reply: true,
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('--kind done cannot be combined with --reply')
  })

  it.each([
    {
      flags: { kind: 'update', title: 'A title that is deliberately longer than forty characters', body: 'Plain.' },
      warning: /titles work best around 40/i,
    },
    {
      flags: { kind: 'done', title: 'Done · build', body: 'All green.' },
      warning: /keep the title to the specific substance/i,
    },
    {
      flags: { kind: 'failed', title: 'Failed · build', body: 'One integration test failed.' },
      warning: /Put notification type in --kind/i,
    },
    {
      flags: { kind: 'update', title: 'Update', body: 'Still relevant.', ttl: 259_201 },
      warning: /longer than 72 hours/i,
    },
  ])('warns without rejecting a send: $warning', async ({ flags, warning }) => {
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient

    expect(await sendCommand(makeDeps(io, client), flags)).toBe(EXIT.ok)
    expect(io.errLines.join('\n')).toMatch(warning)
  })

  it('warns when a collapse key comes from machine-global config', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-global-collapse-'))
    const configDir = path.join(root, 'notifai')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, 'config.toml'), 'collapse_key = "global-key"\n')
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      env: { XDG_CONFIG_HOME: root },
      cwd: root,
    }

    expect(await sendCommand(deps, { kind: 'update', title: 'Update', body: 'Still relevant.' })).toBe(EXIT.ok)
    expect(io.errLines.join('\n')).toMatch(/machine-global config/i)
  })

  it('keeps only the current public notification-authoring flags', () => {
    const source = readFileSync(new URL('./program.ts', import.meta.url), 'utf8')
    expect(source).not.toContain(".option('--badge")
    expect(source).not.toContain(".option('--relevance")
    expect(source).not.toContain(".option('--target-content-id")
    const sendGrammar = source.slice(source.indexOf(".command('send')"), source.indexOf('send.addHelpText'))
    const askGrammar = source.slice(source.indexOf(".command('ask [question]')"), source.indexOf(".command('close"))
    for (const grammar of [sendGrammar, askGrammar]) {
      expect(grammar).not.toContain(".option('--detail")
      expect(grammar).not.toContain(".option('--session <")
      expect(grammar).toContain(".option('--body-file")
      expect(grammar).toContain("'--session-label <text>'")
      expect(grammar).toContain("'--image <path|url|media_id>'")
      expect(grammar).toContain("'--image-alt <text>'")
    }
    expect(sendGrammar).toContain(".option('--session-id")
    expect(sendGrammar).toContain(".option('--retry'")
    expect(askGrammar).not.toContain(".option('--session-id")
    // Kind now selects the sound, so the help must say so — and must not carry
    // the retired separation it replaced.
    expect(source).toContain('Kind is required, and it selects the sound')
    expect(source).toContain('Device default')
    expect(source).toContain('custom name or id')
    expect(source).not.toContain('it never chooses banner sound or interruption level')
    expect(source).not.toContain('Kind profiles apply automatically')
  })

  it('maps reply flags into the draft and waits for the answer', async () => {
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyWindow: 3_600,
        replyTimeout: 30,
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.reply).toEqual({
      expires_in_seconds: 3_600,
      questions: [{ id: 'q1', text: 'Deploy?' }],
    })
  })

  it('rejects --reply-timeout 0, the other spelling of nobody waiting', async () => {
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      submit: async () => {
        submitCalls += 1
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 0,
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('notifai ask')
  })

  it.each([
    { kind: 'update', title: 'Deploy?   ', body: 'Ready.' },
    { kind: 'update', title: 'Deployment', body: 'Should I deploy?\n' },
  ])('warns on stderr when $title / $body ends in a question after trimming', async (flags) => {
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient

    expect(await sendCommand(makeDeps(io, client), flags)).toBe(EXIT.ok)
    expect(io.errLines).toEqual([
      'Heads up: this notification ends with a question but has no reply action. Add --reply (and optionally --choice) so it can be answered from the notification.',
    ])
  })

  it('suppresses the question warning when --reply is present', async () => {
    const io = new CapturedIo()
    const client = {
      submit: async () => receipt,
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Deploy?',
        body: 'Choose when ready.',
        reply: true,
        replyTimeout: 30,
      }),
    ).toBe(EXIT.ok)
    expect(io.errLines).toEqual([])
  })

  it('rejects --choice without the --reply action it configures', async () => {
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      submit: async () => {
        submitCalls += 1
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), { kind: 'update',
        title: 'Deploy?',
        body: 'Choose when ready.',
        choice: ['Now', 'Later'],
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines).toEqual([
      'Use --reply with --reply-timeout, --reply-window, or --choice.',
    ])
  })

  it('keeps a warned JSON send successful and stdout machine-pure', async () => {
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), { kind: 'update',
        title: 'Deployment',
        body: 'Should I deploy?',
        json: true,
      }),
    ).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual(receipt)
    expect(io.errLines).toHaveLength(1)
  })

  it('loops in server-capped long polls until a reply arrives', async () => {
    const io = new CapturedIo()
    let now = 0
    const polls: { waitSeconds: number; afterSeq: number }[] = []
    const client = {
      submit: async () => receipt,
      replies: async (_requestId: string, options: { waitSeconds: number; afterSeq: number }) => {
        polls.push(options)
        now += options.waitSeconds * 1_000
        return replyResponse(polls.length === 3 ? [reply] : [])
      },
    } as unknown as ApiClient
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-direct-reply-log-'))
    const deps = {
      ...makeDeps(io, client),
      env: {
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_STATE_HOME: path.join(root, 'state'),
      },
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'send' })

    expect(
      await sendCommand(deps, {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 60,
      }),
    ).toBe(EXIT.ok)
    expect(polls).toHaveLength(3)
    expect(polls.every((poll) => poll.waitSeconds <= 25)).toBe(true)
    expect(io.outLines).toContain('reply from iPhone: yes, after the migration')
    expect(io.outLines).toContain('Agent Acknowledgement required.')
    expect(io.outLines.join('\n')).toContain(
      `notifai acknowledge ${receipt.request_id} --text <text>`,
    )
    const received = readLogRecords(deps.env, { event: ['reply.received'] }).records
    expect(received).toHaveLength(1)
    expect(received[0]?.data).toMatchObject({
      request_id: receipt.request_id,
      sequence: reply.seq,
      device: reply.device_name,
      text_chars: reply.text.length,
      answers_count: reply.answers.length,
    })
    const raw = readFileSync(activeLogPath(deps.env), 'utf8')
    expect(raw).not.toContain(reply.text)
  })

  it('backs off and retries a transient network error while waiting', async () => {
    const io = new CapturedIo()
    let now = 0
    let replyCalls = 0
    const sleeps: number[] = []
    const client = {
      submit: async () => receipt,
      replies: async () => {
        replyCalls += 1
        if (replyCalls === 1) throw new NetworkError('temporary disconnect')
        return replyResponse([reply])
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds)
        now += milliseconds
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 10,
      }),
    ).toBe(EXIT.ok)
    expect(replyCalls).toBe(2)
    expect(sleeps).toEqual([250])
  })

  /**
   * Regression context: Provider Acceptance and Companion Receipt succeeded,
   * then a long-poll returned HTTP 500 internal_error and the blocking wait aborted
   * while the reply window was still open. The answer arrived ~1 minute later
   * and was recovered only on the next turn. Transient server faults must not
   * end the wait; permanent client errors still may.
   */
  it('keeps blocking through a transient internal_error on the replies poll', async () => {
    const io = new CapturedIo()
    let now = 0
    let replyCalls = 0
    const client = {
      submit: async () => receipt,
      replies: async () => {
        replyCalls += 1
        if (replyCalls <= 2) {
          throw new ApiCallError(500, 'internal_error', 'An unexpected server error occurred.')
        }
        return replyResponse([reply])
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 30,
      }),
    ).toBe(EXIT.ok)
    expect(replyCalls).toBe(3)
    expect(io.outLines).toContain('reply from iPhone: yes, after the migration')
    expect(io.outLines).toContain('Agent Acknowledgement required.')
    expect(io.outLines.join('\n')).toContain(
      `notifai acknowledge ${receipt.request_id} --text <text>`,
    )
    expect(io.errLines.join('\n')).not.toContain('internal_error')
  })

  it('does not treat a permanent replies error as a transient wait fault', async () => {
    const io = new CapturedIo()
    let now = 0
    let replyCalls = 0
    const client = {
      submit: async () => receipt,
      replies: async () => {
        replyCalls += 1
        throw new ApiCallError(404, 'not_found', 'No such request.')
      },
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }
    deps.env = {
      ...deps.env,
      XDG_STATE_HOME: mkdtempSync(path.join(os.tmpdir(), 'notifai-reply-wait-log-')),
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'send' })

    expect(
      await sendCommand(deps, {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 30,
      }),
    ).toBe(EXIT.failed)
    expect(replyCalls).toBe(1)
    expect(io.errLines.join('\n')).toContain('reply wait failed')
    expect(io.errLines.join('\n')).toContain(receipt.request_id)
    expect(io.errLines.join('\n')).toContain('not_found')
    // Receipt was already printed — the durable send is not the failure.
    expect(io.outLines[0]).toContain(receipt.request_id)
    const waitError = readLogRecords(deps.env, { event: ['cli.error'], limit: 20 }).records.find(
      (record) => record.data?.['operation'] === 'reply_wait',
    )
    expect(waitError?.data).toMatchObject({
      kind: 'api',
      request_id: receipt.request_id,
      status: 404,
      code: 'not_found',
    })
  })

  it('prints one combined reply_result object on exit 3, nothing before the wait', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      submit: async () => receipt,
      replies: async (_requestId: string, options: { waitSeconds: number }) => {
        // Nothing on stdout mid-wait: the single object arrives at the end.
        expect(io.outLines).toHaveLength(0)
        now += options.waitSeconds * 1_000
        return replyResponse()
      },
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), now: () => now, sleep: async () => {} }

    expect(
      await sendCommand(deps, {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 1,
        json: true,
      }),
    ).toBe(EXIT.noReply)
    expect(io.outLines).toHaveLength(1)
    // `degraded` is part of the shape on every reply wait, not only when it is
    // true: an agent must be able to read it without knowing it might be absent.
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({
      type: 'reply_result',
      receipt,
      request_id: receipt.request_id,
      reply_expires_at: '2026-08-02T18:00:00.000Z',
      replies: [],
      agent_acknowledgement_required: true,
      agent_acknowledgement_text_required: true,
      agent_acknowledgement: null,
      acknowledgement_command: null,
      degraded: false,
    })
    expect(io.outLines).not.toContain('Agent Acknowledgement required.')
    expect(io.errLines.join('\n')).toContain(`notifai replies ${receipt.request_id}`)
    expect(io.errLines.join('\n')).toContain(`notifai close ${receipt.request_id}`)
  })

  it('prints one combined reply_result object with the receipt when answered', async () => {
    const io = new CapturedIo()
    const client = {
      submit: async () => receipt,
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 10,
        json: true,
      }),
    ).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({
      type: 'reply_result',
      receipt,
      request_id: receipt.request_id,
      reply_expires_at: '2026-08-02T18:00:00.000Z',
      replies: [reply],
      agent_acknowledgement_required: true,
      agent_acknowledgement_text_required: true,
      agent_acknowledgement: null,
      acknowledgement_command: `notifai acknowledge ${receipt.request_id} --text <text>`,
      degraded: false,
    })
  })

  it('still prints the one reply_result object when the wait itself faults', async () => {
    const io = new CapturedIo()
    const client = {
      submit: async () => receipt,
      replies: async () => {
        throw new ApiCallError(404, 'not_found', 'no such request')
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 10,
        json: true,
      }),
    ).toBe(EXIT.failed)
    expect(io.outLines).toHaveLength(1)
    // The send is durable even though the wait failed; `degraded: true` says
    // "could not find out", not "no answer".
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({
      type: 'reply_result',
      receipt,
      request_id: receipt.request_id,
      replies: [],
      agent_acknowledgement_required: true,
      agent_acknowledgement_text_required: true,
      agent_acknowledgement: null,
      acknowledgement_command: null,
      degraded: true,
    })
    expect(io.errLines.join('\n')).toContain('reply wait failed')
  })

  it('acknowledges non-interactively, trims text, emits JSON, and logs request identity', async () => {
    const io = new CapturedIo()
    let submitted: { requestId: string; text: string } | undefined
    const client = {
      putAgentAcknowledgement: async (requestId: string, body: { text: string }) => {
        submitted = { requestId, text: body.text }
        return {
          status: 'recorded' as const,
          agent_acknowledgement: {
            text: body.text,
            created_at: '2026-08-13T12:01:00.000Z',
          },
        }
      },
    } as unknown as ApiClient
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-acknowledge-log-'))
    const deps = makeDeps(io, client)
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'acknowledge' })

    expect(
      await acknowledgeCommand(deps, receipt.request_id, {
        text: '  I will deploy staging now.  ',
        json: true,
      }),
    ).toBe(EXIT.ok)
    expect(submitted).toEqual({
      requestId: receipt.request_id,
      text: 'I will deploy staging now.',
    })
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({
      request_id: receipt.request_id,
      outcome: 'recorded',
      acknowledgement: {
        text: 'I will deploy staging now.',
        created_at: '2026-08-13T12:01:00.000Z',
      },
      agent_acknowledgement_required: true,
    })
    const events = readLogRecords(deps.env, {
      request: receipt.request_id,
      event: ['acknowledgement.attempted', 'acknowledgement.outcome'],
    }).records
    expect(events.map((event) => event.event)).toEqual([
      'acknowledgement.attempted',
      'acknowledgement.outcome',
    ])
    const raw = readFileSync(activeLogPath(deps.env), 'utf8')
    expect(raw).not.toContain('I will deploy staging now.')
    expect(events[0]?.data).toMatchObject({ characters: 'I will deploy staging now.'.length })
    expect(events[1]?.data).toMatchObject({ text_chars: 'I will deploy staging now.'.length })
  })

  it('clears the stable-id session obligation after acknowledgement from another checkout', async () => {
    const io = new CapturedIo()
    const client = {
      putAgentAcknowledgement: async () => ({
        status: 'recorded' as const,
        agent_acknowledgement: {
          text: 'I will deploy staging now.',
          created_at: '2026-08-13T12:01:00.000Z',
        },
      }),
    } as unknown as ApiClient
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-ack-clear-'))
    const deps = makeDeps(io, client)
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    const now = 1_800_000_000_000
    deps.now = () => now
    writeSessionState('ack-session', deps.env, {
      acknowledgement_due: [{ request_id: receipt.request_id, recorded_at: now }],
    })
    writeProjectSession(deps.cwd, deps.env, 'ack-session', now, 'codex')
    deps.cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-ack-other-checkout-'))

    expect(
      await acknowledgeCommand(deps, receipt.request_id, {
        text: 'I will deploy staging now.',
      }),
    ).toBe(EXIT.ok)
    expect(readSessionState('ack-session', deps.env).acknowledgement_due).toBeUndefined()
  })

  it('reports idempotent acknowledgement replay in concise human output', async () => {
    const io = new CapturedIo()
    const client = {
      putAgentAcknowledgement: async () => ({
        status: 'replayed' as const,
        agent_acknowledgement: {
          text: 'I will deploy staging now.',
          created_at: '2026-08-13T12:01:00.000Z',
        },
      }),
    } as unknown as ApiClient

    expect(
      await acknowledgeCommand(makeDeps(io, client), receipt.request_id, {
        text: 'I will deploy staging now.',
      }),
    ).toBe(EXIT.ok)
    expect(io.outLines).toEqual([
      `Agent Acknowledgement replayed for ${receipt.request_id} at 2026-08-13T12:01:00.000Z.`,
    ])
  })

  it.each([
    { text: '   ', message: 'must contain non-whitespace text' },
    {
      text: 'x'.repeat(AGENT_ACKNOWLEDGEMENT_MAX_LENGTH + 1),
      message: `at most ${AGENT_ACKNOWLEDGEMENT_MAX_LENGTH} characters`,
    },
  ])('rejects invalid acknowledgement text before network: $message', async ({ text, message }) => {
    const io = new CapturedIo()
    let calls = 0
    const client = {
      putAgentAcknowledgement: async () => {
        calls += 1
        throw new Error('should not be reached')
      },
    } as unknown as ApiClient

    expect(
      await acknowledgeCommand(makeDeps(io, client), receipt.request_id, { text }),
    ).toBe(EXIT.usage)
    expect(calls).toBe(0)
    expect(io.errLines.join('\n')).toContain(message)
  })

  it('records an acknowledgement with no text at all', async () => {
    const io = new CapturedIo()
    let submitted: { requestId: string; body: { text?: string } } | undefined
    const client = {
      putAgentAcknowledgement: async (requestId: string, body: { text?: string }) => {
        submitted = { requestId, body }
        return {
          status: 'recorded' as const,
          agent_acknowledgement: { text: '', created_at: '2026-08-13T12:01:00.000Z' },
        }
      },
    } as unknown as ApiClient

    expect(await acknowledgeCommand(makeDeps(io, client), receipt.request_id, {})).toBe(EXIT.ok)
    // No empty string either: an omitted field is what "no text" means on the
    // wire, and the account's snapshot decides whether that was allowed.
    expect(submitted).toEqual({ requestId: receipt.request_id, body: {} })
    expect(io.outLines.join('\n')).toContain(`Agent Acknowledgement recorded for ${receipt.request_id}`)
  })

  it('names the missing text, not a contract mismatch, when the account requires it', async () => {
    const io = new CapturedIo()
    const client = {
      putAgentAcknowledgement: async () => {
        throw new ApiCallError(
          422,
          'acknowledgement_text_required',
          'This account requires Agent Acknowledgement text.',
          'Re-send the acknowledgement with text saying what you will do because of the reply.',
        )
      },
    } as unknown as ApiClient

    expect(await acknowledgeCommand(makeDeps(io, client), receipt.request_id, {})).toBe(EXIT.failed)
    const err = io.errLines.join('\n')
    expect(err).toContain('acknowledgement_text_required')
    expect(err).toContain('next: Re-send the acknowledgement with text')
    // The contract held; only this body fell short of the account's choice.
    expect(err).not.toContain('disagree about the contract')
  })

  it('asks for a text-free acknowledgement when the account turned text off', async () => {
    const io = new CapturedIo()
    const client = {
      replies: async () => replyResponse([reply], { textRequired: false }),
    } as unknown as ApiClient

    expect(await repliesCommand(makeDeps(io, client), receipt.request_id, {})).toBe(EXIT.ok)
    const out = io.outLines.join('\n')
    expect(out).toContain('Agent Acknowledgement required.')
    expect(out).toContain(`notifai acknowledge ${receipt.request_id}\``)
    expect(out).not.toContain('--text')
  })

  it.each([
    [new ApiCallError(409, 'conflict', 'A different acknowledgement is already recorded.'), EXIT.failed, 'conflict'],
    [new ApiCallError(409, 'reply_not_enabled', 'Agent Acknowledgements are disabled.'), EXIT.failed, 'reply_not_enabled'],
    [new ApiCallError(409, 'conflict', 'No user reply has been recorded yet.'), EXIT.failed, 'No user reply'],
    [new ApiCallError(404, 'not_found', 'This request is unavailable or its content was purged.'), EXIT.failed, 'purged'],
    [new ApiCallError(401, 'machine_revoked', 'This machine was revoked.'), EXIT.auth, 'machine_revoked'],
    [new NetworkError('Could not reach the service'), EXIT.network, 'Could not reach'],
  ] as const)(
    'maps stable acknowledgement failure %#',
    async (error, expectedExit, expectedCopy) => {
      const io = new CapturedIo()
      const client = {
        putAgentAcknowledgement: async () => {
          throw error
        },
      } as unknown as ApiClient

      expect(
        await acknowledgeCommand(makeDeps(io, client), receipt.request_id, { text: 'Next work.' }),
      ).toBe(expectedExit)
      expect(io.errLines.join('\n')).toContain(expectedCopy)
    },
  )

  it('reports required-but-not-yet-due state before any user reply', async () => {
    const io = new CapturedIo()
    const client = {
      replies: async () => replyResponse([]),
    } as unknown as ApiClient

    expect(await repliesCommand(makeDeps(io, client), receipt.request_id, {})).toBe(EXIT.noReply)
    expect(io.outLines).toContain(
      'Agent Acknowledgement: required after a user reply; no reply is recorded yet.',
    )
    expect(io.outLines.join('\n')).not.toContain('notifai acknowledge')
  })

  it('exposes disabled acknowledgement state without a follow-up command', async () => {
    const io = new CapturedIo()
    const client = {
      replies: async () => replyResponse([reply], { required: false }),
    } as unknown as ApiClient

    expect(await repliesCommand(makeDeps(io, client), receipt.request_id, {})).toBe(EXIT.ok)
    expect(io.outLines).toContain('Agent Acknowledgement: not required for this request.')
    expect(io.outLines.join('\n')).not.toContain('notifai acknowledge')
  })

  it('exposes an existing acknowledgement without repeating the follow-up command', async () => {
    const io = new CapturedIo()
    const acknowledgement = {
      text: 'I will deploy staging now.',
      created_at: '2026-08-13T12:01:00.000Z',
    }
    const client = {
      replies: async () => replyResponse([reply], { acknowledgement }),
    } as unknown as ApiClient

    expect(
      await repliesCommand(makeDeps(io, client), receipt.request_id, { json: true }),
    ).toBe(EXIT.ok)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toMatchObject({
      agent_acknowledgement_required: true,
      agent_acknowledgement: acknowledgement,
      acknowledgement_command: null,
    })
  })

  it('close exposes the acknowledgement requirement and exact follow-up command', async () => {
    const io = new CapturedIo()
    const client = {
      closeReplies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    expect(await closeCommand(makeDeps(io, client), receipt.request_id, { json: true })).toBe(
      EXIT.ok,
    )
    expect(JSON.parse(io.outLines[0] ?? '{}')).toMatchObject({
      request_id: receipt.request_id,
      agent_acknowledgement_required: true,
      agent_acknowledgement: null,
      acknowledgement_command: `notifai acknowledge ${receipt.request_id} --text <text>`,
    })
  })

  it('close --pending withdraws an unpushed registration so a later Stop cannot send it', async () => {
    const io = new CapturedIo()
    const client = {
      closeReplies: async () => {
        throw new Error('unpushed questions must not call the server')
      },
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-close-unpushed-'))
    deps.cwd = root
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    writeSessionState('close-unpushed', deps.env, {
      pending: [{ question: 'Ship it?', question_id: 'q_local' }],
    })
    writeProjectSession(root, deps.env, 'close-unpushed', Date.now(), 'codex')

    expect(await closeCommand(deps, undefined, { pending: true, json: true })).toBe(EXIT.ok)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({
      session_id: 'close-unpushed',
      withdrawn: [{ question: 'Ship it?', question_id: 'q_local' }],
      closed: [],
    })
    expect(readSessionState('close-unpushed', deps.env).pending).toBeUndefined()
    expect(inspectQuestionState('q_local', deps.env)).toMatchObject({
      found: true,
      question: { state: 'withdrawn', submitted: false, request_id: null },
    })
  })

  it('close withdraws one unpushed question by stable id from another checkout', async () => {
    const io = new CapturedIo()
    const client = {
      closeReplies: async () => {
        throw new Error('unpushed questions must not call the server')
      },
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-close-one-unpushed-'))
    deps.cwd = root
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    writeSessionState('close-one', deps.env, {
      pending: [
        { question: 'Ship it?', question_id: 'q_local' },
        { question: 'Keep this?', question_id: 'q_keep' },
      ],
    })
    writeProjectSession(root, deps.env, 'close-one', Date.now(), 'codex')
    deps.cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-close-other-checkout-'))

    expect(await closeCommand(deps, 'q_local', { json: true })).toBe(EXIT.ok)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({
      session_id: 'close-one',
      withdrawn: [{ question: 'Ship it?', question_id: 'q_local' }],
      closed: [],
    })
    expect(readSessionState('close-one', deps.env).pending?.map((entry) => entry.question_id)).toEqual([
      'q_keep',
    ])
  })

  it('close --pending closes live questions and leaves nothing for a later Stop to push', async () => {
    const io = new CapturedIo()
    const closed: string[] = []
    const client = {
      closeReplies: async (requestId: string) => {
        closed.push(requestId)
        return replyResponse([])
      },
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-close-pending-mix-'))
    deps.cwd = root
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    writeSessionState('close-mix', deps.env, {
      pending: [
        { question: 'Unpushed?', question_id: 'q_local' },
        {
          question: 'Already on a device?',
          question_id: 'q_live',
          request_id: receipt.request_id,
          collapse_key: 'question-live',
          device_ids: ['dev_iphone'],
        },
      ],
    })
    writeProjectSession(root, deps.env, 'close-mix', Date.now(), 'codex')

    expect(await closeCommand(deps, undefined, { pending: true, json: true })).toBe(EXIT.ok)
    expect(closed).toEqual([receipt.request_id])
    expect(JSON.parse(io.outLines[0] ?? '{}')).toMatchObject({
      session_id: 'close-mix',
      withdrawn: [{ question: 'Unpushed?', question_id: 'q_local' }],
      closed: [receipt.request_id],
    })
    expect(readSessionState('close-mix', deps.env).pending).toBeUndefined()
    expect(inspectQuestionState('q_local', deps.env)).toMatchObject({
      found: true,
      question: { state: 'withdrawn', submitted: false, request_id: null },
    })
    expect(inspectQuestionState('q_live', deps.env)).toMatchObject({
      found: true,
      question: { state: 'retired', submitted: true, request_id: receipt.request_id },
    })
  })

  it('close requires a request id or --pending', async () => {
    const io = new CapturedIo()
    const client = {} as unknown as ApiClient
    expect(await closeCommand(makeDeps(io, client), undefined, {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('Pass a request id or --pending.')
  })

  it('passes the replies cursor and prints replies for later retrieval', async () => {
    const io = new CapturedIo()
    let requested: { waitSeconds: number; afterSeq: number } | undefined
    const client = {
      replies: async (_requestId: string, options: { waitSeconds: number; afterSeq: number }) => {
        requested = options
        return replyResponse([reply])
      },
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-replies-log-'))
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'replies' })

    expect(await repliesCommand(deps, receipt.request_id, { after: 7 })).toBe(EXIT.ok)
    expect(requested).toEqual({ waitSeconds: 0, afterSeq: 7 })
    expect(io.outLines).toEqual([
      'reply from iPhone: yes, after the migration',
      'Agent Acknowledgement required.',
      `next: Run \`notifai acknowledge ${receipt.request_id} --text <text>\` with concrete text saying what you will do because of the reply.`,
    ])
    expect(readLogRecords(deps.env, { event: ['reply.received'] }).records).toHaveLength(1)
  })

  it('resolves replies --pending by exact session from another checkout', async () => {
    const io = new CapturedIo()
    const client = {
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-pending-replies-'))
    deps.cwd = root
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
      CODEX_THREAD_ID: 'pending-session',
    }
    writeSessionState('pending-session', deps.env, {
      harness: 'codex',
      last_prompt_at: Date.now(),
      pending: [{ question: 'Deploy?', request_id: receipt.request_id }],
    })
    writeProjectSession(root, deps.env, 'pending-session', Date.now(), 'codex')
    deps.cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-pending-other-checkout-'))

    expect(await repliesCommand(deps, undefined, { pending: true })).toBe(EXIT.ok)
    expect(io.outLines).toEqual([
      `pending request ${receipt.request_id}`,
      'reply from iPhone: yes, after the migration',
      'Agent Acknowledgement required.',
      `next: Run \`notifai acknowledge ${receipt.request_id} --text <text>\` with concrete text saying what you will do because of the reply.`,
    ])
  })

  it('walks every delivered pending question in queue order', async () => {
    const io = new CapturedIo()
    const client = {
      replies: async (requestId: string) =>
        requestId === 'req_first'
          ? replyResponse([reply])
          : replyResponse([]),
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-pending-multi-'))
    deps.cwd = root
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    writeSessionState('pending-multi', deps.env, {
      pending: [
        { question: 'Deploy?', request_id: 'req_first' },
        { question: 'Which region?', request_id: 'req_second' },
        { question: 'Not yet asked?' },
      ],
    })
    writeProjectSession(root, deps.env, 'pending-multi', Date.now(), 'codex')

    expect(await repliesCommand(deps, undefined, { pending: true })).toBe(EXIT.ok)
    expect(io.outLines[0]).toBe('unpushed question: Not yet asked?')
    expect(io.outLines.join('\n')).toContain('pending request req_first')
    expect(io.outLines.join('\n')).toContain('yes, after the migration')
    expect(io.outLines.join('\n')).toContain('req_second')
  })

  it('keeps the failing request identity when one pending reply wait throws', async () => {
    const io = new CapturedIo()
    const client = {
      replies: async (requestId: string) => {
        if (requestId === 'req_failed') {
          throw new ApiCallError(404, 'not_found', 'That notification request does not exist.')
        }
        return replyResponse([reply])
      },
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-pending-error-log-'))
    deps.cwd = root
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'replies' })
    writeSessionState('pending-error-log', deps.env, {
      pending: [
        { question: 'First?', request_id: 'req_healthy' },
        { question: 'Second?', request_id: 'req_failed' },
        { question: 'Third?', request_id: 'req_unreached' },
      ],
    })
    writeProjectSession(root, deps.env, 'pending-error-log', Date.now(), 'codex')

    expect(await repliesCommand(deps, undefined, { pending: true })).toBe(EXIT.failed)

    io.outLines = []
    io.errLines = []
    expect(logsCommand(deps, { request: 'req_failed', json: true, allProjects: true })).toBe(
      EXIT.ok,
    )
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0]!)).toMatchObject({
      event: 'cli.error',
      data: { request_id: 'req_failed', operation: 'reply_wait' },
    })

    io.outLines = []
    expect(logsCommand(deps, { request: 'req_healthy', json: true, allProjects: true })).toBe(
      EXIT.ok,
    )
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0]!)).toMatchObject({
      event: 'reply.received',
      data: { request_id: 'req_healthy' },
    })

    io.outLines = []
    expect(logsCommand(deps, { request: 'req_unreached', json: true, allProjects: true })).toBe(
      EXIT.ok,
    )
    expect(io.outLines).toEqual([])
  })

  it('attributes a degraded multi-request wait only to the request whose polls failed', async () => {
    const io = new CapturedIo()
    let now = 0
    let failedPolls = 0
    const client = {
      replies: async (requestId: string) => {
        if (requestId !== 'req_degraded') return replyResponse([reply])
        failedPolls += 1
        if (failedPolls === 1) return replyResponse([])
        throw new NetworkError('temporary disconnect')
      },
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-pending-degraded-log-'))
    deps.cwd = root
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    deps.now = () => now
    deps.sleep = async (milliseconds: number) => {
      now += milliseconds
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'replies' })
    writeSessionState('pending-degraded-log', deps.env, {
      pending: [
        { question: 'First?', request_id: 'req_healthy_before' },
        { question: 'Second?', request_id: 'req_degraded' },
        { question: 'Third?', request_id: 'req_healthy_after' },
      ],
    })
    writeProjectSession(root, deps.env, 'pending-degraded-log', Date.now(), 'codex')

    expect(await repliesCommand(deps, undefined, { pending: true, wait: 1 })).toBe(EXIT.network)

    io.outLines = []
    io.errLines = []
    expect(logsCommand(deps, { request: 'req_degraded', json: true, allProjects: true })).toBe(
      EXIT.ok,
    )
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0]!)).toMatchObject({
      event: 'cli.error',
      data: { request_ids: ['req_degraded'], operation: 'reply_wait' },
    })

    for (const requestId of ['req_healthy_before', 'req_healthy_after']) {
      io.outLines = []
      expect(logsCommand(deps, { request: requestId, json: true, allProjects: true })).toBe(
        EXIT.ok,
      )
      expect(io.outLines).toHaveLength(1)
      expect(JSON.parse(io.outLines[0]!)).toMatchObject({
        event: 'reply.received',
        data: { request_id: requestId },
      })
    }
  })

  it('records earlier degraded requests before a later pending wait throws', async () => {
    const io = new CapturedIo()
    let now = 0
    let degradedPolls = 0
    const client = {
      replies: async (requestId: string) => {
        if (requestId === 'req_success') return replyResponse([reply])
        if (requestId === 'req_degraded') {
          degradedPolls += 1
          if (degradedPolls === 1) return replyResponse([])
          throw new NetworkError('temporary disconnect')
        }
        if (requestId === 'req_failed') {
          throw new ApiCallError(404, 'not_found', 'That notification request does not exist.')
        }
        return replyResponse([reply])
      },
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-pending-mixed-log-'))
    deps.cwd = root
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    deps.now = () => now
    deps.sleep = async (milliseconds: number) => {
      now += milliseconds
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'replies' })
    writeSessionState('pending-mixed-log', deps.env, {
      pending: [
        { question: 'Healthy?', request_id: 'req_success' },
        { question: 'Degraded?', request_id: 'req_degraded' },
        { question: 'Gone?', request_id: 'req_failed' },
        { question: 'Unreached?', request_id: 'req_unreached' },
      ],
    })
    writeProjectSession(root, deps.env, 'pending-mixed-log', Date.now(), 'codex')

    expect(await repliesCommand(deps, undefined, { pending: true, wait: 1 })).toBe(EXIT.failed)

    const recordsFor = (requestId: string): Array<Record<string, unknown>> => {
      io.outLines = []
      io.errLines = []
      expect(logsCommand(deps, { request: requestId, json: true, allProjects: true })).toBe(
        EXIT.ok,
      )
      return io.outLines.map((line) => JSON.parse(line) as Record<string, unknown>)
    }

    expect(recordsFor('req_success')).toEqual([
      expect.objectContaining({
        event: 'reply.received',
        data: expect.objectContaining({ request_id: 'req_success' }),
      }),
    ])
    expect(recordsFor('req_degraded')).toEqual([
      expect.objectContaining({
        event: 'cli.error',
        data: expect.objectContaining({
          request_ids: ['req_degraded'],
          operation: 'reply_wait',
          degraded: true,
        }),
      }),
    ])
    expect(recordsFor('req_failed')).toEqual([
      expect.objectContaining({
        event: 'cli.error',
        data: expect.objectContaining({ request_id: 'req_failed', operation: 'reply_wait' }),
      }),
    ])
    expect(recordsFor('req_unreached')).toEqual([])
  })
})

describe('credential origin pinning', () => {
  it('never sends the machine bearer to a flag or env origin override', async () => {
    const io = new CapturedIo()
    const seen: { baseUrl: string; bearer: string | null }[] = []
    const client = {
      submit: async () => receipt,
    } as unknown as ApiClient
    const deps = makeDeps(io, client)
    deps.env = { ...deps.env, NOTIFAI_BASE_URL: 'https://attacker.example' }
    deps.clientFactory = (baseUrl, bearer) => {
      seen.push({ baseUrl, bearer })
      return withCompatibilityDefaults(client)
    }

    expect(
      await sendCommand(deps, {
        kind: 'update',
        title: 'T',
        body: 'B',
        baseUrl: 'https://attacker.flag',
      }),
    ).toBe(EXIT.ok)

    expect(seen).toEqual([
      {
        baseUrl: 'https://test.notifai.invalid',
        bearer: 'Bearer nfm_mac_test.test-secret',
      },
    ])
    expect(io.errLines.join('\n')).toContain('Ignoring base_url from flag')
    expect(io.errLines.join('\n')).not.toContain('test-secret')
    expect(io.errLines.join('\n')).not.toContain('nfm_')
    expect(io.errLines.join('\n')).not.toContain('https://attacker.example')
    expect(io.errLines.join('\n')).not.toContain('https://attacker.flag')
  })

  it('lets unsigned-in login target an origin override', async () => {
    const io = new CapturedIo()
    const seen: { baseUrl: string; bearer: string | null }[] = []
    let beginBody: Parameters<ApiClient['beginPairing']>[0] | null = null
    let now = 0
    const client = {
      beginPairing: async (body: Parameters<ApiClient['beginPairing']>[0]) => {
        beginBody = body
        return {
          pairing_id: 'pair_test',
          code: 'ABCD-EFGH',
          approve_url: 'https://selfhost.example/pair/ABCD-EFGH',
          expires_at: new Date(10_000).toISOString(),
          poll_interval_seconds: 1,
        }
      },
      pollPairing: async () => ({ status: 'approved', machine_id: 'mac_new' }),
    } as unknown as ApiClient
    const saved: { baseUrl?: string } = {}
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
      store: {
        load: () => null,
        save: (credential) => {
          saved.baseUrl = credential.baseUrl
        },
        clear: () => {},
        describe: () => 'test credential store',
      },
      clientFactory: (baseUrl, bearer) => {
        seen.push({ baseUrl, bearer })
        return withCompatibilityDefaults(client)
      },
    }

    expect(await loginCommand(deps, { baseUrl: 'https://selfhost.example', open: false })).toBe(
      EXIT.ok,
    )
    expect(seen[0]).toEqual({ baseUrl: 'https://selfhost.example', bearer: null })
    expect(saved.baseUrl).toBe('https://selfhost.example')
    expect(beginBody).toMatchObject({
      machine_name: expect.any(String),
      credential_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      poll_verifier_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      confirmation_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(io.outLines[1]).toMatch(
      /^Approve this machine at: https:\/\/selfhost\.example\/pair\/ABCD-EFGH#confirmation_secret=[A-Za-z0-9_-]{43}$/,
    )
  })

  it('stops login when the approving account has no product access', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      beginPairing: async () => ({
        pairing_id: 'pair_test',
        code: 'ABCD-EFGH',
        approve_url: 'https://app.notifai.sh/pair/ABCD-EFGH',
        expires_at: new Date(10_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => ({
        status: 'no_active_plan',
        next_action: 'Ask the account owner for Alpha access.',
      }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }

    expect(await loginCommand(deps, { open: false })).toBe(EXIT.auth)
    expect(io.errLines).toEqual([
      'This account has no active plan or temporary Alpha access.',
      'next: Ask the account owner for Alpha access.',
      'After access is granted, run `notifai init` again.',
    ])
    expect(io.errLines.join('\n')).not.toMatch(/Pairing expired/i)
    expect(io.errLines.join('\n')).not.toContain('notifai login')
    expect(now).toBeLessThan(10_000)
  })

  it('reports the access blocker to whoever asked for the sign-in', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      beginPairing: async () => ({
        pairing_id: 'pair_test',
        code: 'ABCD-EFGH',
        approve_url: 'https://app.notifai.sh/pair/ABCD-EFGH',
        expires_at: new Date(10_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => ({
        status: 'no_active_plan',
        next_action: 'Open https://app.notifai.sh/setup/access to set up access, then retry.',
      }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }

    let blocked: { title: string; detail: string } | null = null
    expect(
      await loginCommand(deps, { open: false }, (state) => {
        blocked = state
      }),
    ).toBe(EXIT.auth)
    // Handing the blocker over hands over the errand. Saying it here too gave
    // the caller's close a second, differently worded copy to contradict.
    expect(io.errLines).toEqual([])
    // Without this the caller falls back to the state it held before the
    // attempt — "not paired … run `notifai init`" — and prints it under the
    // correct line, in contradiction with it.
    expect(blocked).toMatchObject({
      id: 'auth',
      title: 'Access',
      status: 'gap',
      detail: 'this account does not have access to Notifai yet',
      remedy: {
        by: 'user-elsewhere',
        summary: 'Open https://app.notifai.sh/setup/access to set up access, then retry.',
      },
    })
  })

  it('reports expiry only when pairing times out without a no-access mark', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      beginPairing: async () => ({
        pairing_id: 'pair_test',
        code: 'ABCD-EFGH',
        approve_url: 'https://app.notifai.sh/pair/ABCD-EFGH',
        expires_at: new Date(10_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => ({ status: 'expired' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }

    expect(await loginCommand(deps, { open: false })).toBe(EXIT.auth)
    expect(io.errLines).toEqual([
      'Pairing expired before it was approved. Run `notifai init` again.',
    ])
    expect(io.errLines.join('\n')).not.toMatch(/no active plan/i)
    expect(io.errLines.join('\n')).not.toContain('notifai login')
  })

  it('keeps notification titles out of send logs', async () => {
    const io = new CapturedIo()
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-send-log-'))
    const client = { submit: async () => receipt } as unknown as ApiClient
    const deps = makeDeps(io, client)
    deps.env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    deps.logger = createLogger({ env: deps.env, cmd: 'send', settings: { level: 'debug' } })

    expect(
      await sendCommand(deps, {
        kind: 'update',
        title: 'SECRET_SEND_TITLE',
        body: 'SECRET_SEND_BODY',
      }),
    ).toBe(EXIT.ok)
    const raw = readFileSync(activeLogPath(deps.env), 'utf8')
    expect(raw).not.toContain('SECRET_SEND_TITLE')
    expect(raw).not.toContain('SECRET_SEND_BODY')
    const submitted = readLogRecords(deps.env, { event: ['send.submitted'] }).records
    expect(submitted[0]?.data).toMatchObject({
      request_id: receipt.request_id,
      title_chars: 'SECRET_SEND_TITLE'.length,
    })
  })

  it('refuses a shell-escaped backslash-n body unless the literal flag is set', async () => {
    const io = new CapturedIo()
    expect(
      await sendCommand(makeDeps(io, {} as ApiClient), {
        kind: 'update',
        title: 'Escaped',
        body: 'line1\\nline2',
      }),
    ).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('--body-file -')
    expect(io.errLines.join('\n')).toContain('--literal-backslash-n')

    io.errLines = []
    const client = { submit: async () => receipt } as unknown as ApiClient
    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'update',
        title: 'Escaped',
        body: 'line1\\nline2',
        literalBackslashN: true,
      }),
    ).toBe(EXIT.ok)
  })
})

describe('delivery evidence status', () => {
  function snapshot(
    companionReceipt: EvidenceSnapshot['deliveries'][number]['companion_receipt'],
  ): EvidenceSnapshot {
    return {
      request_id: 'req_status_test',
      accepted_at: '2026-08-05T13:05:48.000Z',
      overall: 'provider_accepted_all',
      deliveries: [
        {
          delivery_id: 'del_status_test',
          device_id: 'dev_status_test',
          device_name: 'iPhone',
          state: 'provider_accepted',
          attempts: 1,
          provider_status: 200,
          provider_reason: null,
          provider_id: 'provider_status_test',
          updated_at: '2026-08-05T13:05:50.000Z',
          companion_receipt: companionReceipt,
          events: [
            {
              stage: 'attempt_started',
              source: 'worker',
              reason: null,
              attempt: 1,
              occurred_at: '2026-08-05T13:05:49.000Z',
            },
            {
              stage: 'provider_accepted',
              source: 'worker',
              reason: null,
              attempt: 1,
              occurred_at: '2026-08-05T13:05:50.000Z',
            },
          ],
        },
      ],
    }
  }

  it('reports every local question state by q identity without creating or submitting anything', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-question-status-'))
    const env = {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    writeSessionState('question-states', env, {
      pending: [
        { question: 'Local?', question_id: 'q_local' },
        {
          question: 'Frozen?',
          question_id: 'q_frozen',
          submission: {
            request_id: 'req_frozen',
            idempotency_key: 'idem-frozen',
            collapse_key: 'collapse-frozen',
            device_ids: ['dev_status_test'],
            draft: {} as never,
            owner_deadline_at: Date.now() + 60_000,
          },
        },
        { question: 'Live?', question_id: 'q_live', request_id: 'req_live' },
      ],
      question_history: [
        { question_id: 'q_answered', state: 'answered', request_id: 'req_answered' },
        { question_id: 'q_withdrawn', state: 'withdrawn' },
        { question_id: 'q_retired', state: 'retired', request_id: 'req_retired' },
      ],
    })
    const evidenceCalls: string[] = []
    const client = {
      evidence: async (requestId: string) => {
        evidenceCalls.push(requestId)
        return { ...snapshot({ state: 'unknown', observed_at: null, latency_ms: null }), request_id: requestId }
      },
    } as unknown as ApiClient
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, client), cwd: root, env }

    const expected = [
      ['q_local', 'local', false, null, null],
      ['q_frozen', 'frozen', null, null, 'req_frozen'],
      ['q_live', 'live', true, 'req_live', null],
      ['q_answered', 'answered', true, 'req_answered', null],
      ['q_withdrawn', 'withdrawn', false, null, null],
      ['q_retired', 'retired', true, 'req_retired', null],
    ] as const
    for (const [questionId, state, submitted, requestId, frozenRequestId] of expected) {
      io.outLines = []
      expect(await statusCommand(deps, questionId, { json: true })).toBe(EXIT.ok)
      expect(JSON.parse(io.outLines.join('\n'))).toMatchObject({
        question_id: questionId,
        state,
        submitted,
        request_id: requestId,
        frozen_request_id: frozenRequestId,
        recovery: {
          inspect: `notifai status ${questionId}`,
          close: `notifai close ${questionId}`,
          register_replacement: false,
        },
      })
    }
    expect(evidenceCalls).toEqual(['req_live', 'req_answered', 'req_retired'])
  })

  it('states plainly that a local registration has no submission or Provider Acceptance', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-local-question-status-'))
    const env = { XDG_STATE_HOME: path.join(root, 'state') }
    writeSessionState('local-question', env, {
      pending: [{ question: 'Ship?', question_id: 'q_local_plain' }],
    })
    const io = new CapturedIo()
    const client = {
      evidence: async () => {
        throw new Error('local status must not call the service')
      },
    } as unknown as ApiClient

    expect(
      await statusCommand({ ...makeDeps(io, client), cwd: root, env }, 'q_local_plain', {}),
    ).toBe(EXIT.ok)
    const said = io.outLines.join('\n')
    expect(said).toContain('question q_local_plain — local')
    expect(said).toContain('not submitted')
    expect(said).toContain('only a local registration')
    expect(said).toContain('Provider Acceptance: not available')
    expect(said).toContain('do not register a replacement')
  })

  it('calls an unobserved first-minute receipt unknown rather than failed', async () => {
    const io = new CapturedIo()
    const client = {
      evidence: async () => snapshot({ state: 'unknown', observed_at: null, latency_ms: null }),
    } as unknown as ApiClient

    expect(await statusCommand(makeDeps(io, client), 'req_status_test', {})).toBe(EXIT.ok)
    const said = io.outLines.join('\n')
    expect(said).toContain('Provider Acceptance: accepted')
    expect(said).toContain("Companion Receipt (the app's delivery confirmation): unknown")
    expect(said).toContain('not a failure')
    expect(said).toContain('attempt_started')
    expect(said).toContain('OS presentation: not observed by Notifai')
    expect(said).toContain('Reply wait:')
  })

  it('reports the observed device receipt and measured provider-to-companion latency', async () => {
    const io = new CapturedIo()
    const client = {
      evidence: async () =>
        snapshot({
          state: 'observed',
          observed_at: '2026-08-05T13:17:17.000Z',
          latency_ms: 687_000,
        }),
    } as unknown as ApiClient

    expect(await statusCommand(makeDeps(io, client), 'req_status_test', {})).toBe(EXIT.ok)
    const said = io.outLines.join('\n')
    expect(said).toContain("Companion Receipt (the app's delivery confirmation): observed")
    expect(said).toContain('11m 27s after Provider Acceptance')
    expect(said).toContain('OS presentation: not observed by Notifai')
    expect(said).toContain('Reply received: not yet recorded')
    expect(said).toContain('Reply wait: no answer stored yet')
  })

  it('separates a stored reply from Delivery so a wait fault is not misread as non-delivery', async () => {
    const io = new CapturedIo()
    const base = snapshot({
      state: 'observed',
      observed_at: '2026-08-05T13:17:17.000Z',
      latency_ms: 1_000,
    })
    base.deliveries[0]!.events.push({
      stage: 'reply_received',
      source: 'companion',
      reason: null,
      attempt: null,
      occurred_at: '2026-08-05T13:18:00.000Z',
    })
    const client = { evidence: async () => base } as unknown as ApiClient

    expect(await statusCommand(makeDeps(io, client), 'req_status_test', {})).toBe(EXIT.ok)
    const said = io.outLines.join('\n')
    expect(said).toContain('Provider Acceptance: accepted')
    expect(said).toContain('Companion Receipt')
    expect(said).toContain('OS presentation: not observed by Notifai')
    expect(said).toContain('Reply received: yes')
    expect(said).toContain('answers are on the server')
  })

  it('treats an ordinary status Companion Receipt as doctor delivery proof', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-status-proof-'))
    const evidence = snapshot({
      state: 'observed',
      observed_at: '2026-08-05T13:17:17.000Z',
      latency_ms: 1_000,
    })
    const device = {
      device_id: evidence.deliveries[0]!.device_id,
      display_name: 'iPhone',
      platform: 'ios' as const,
      permission_status: 'authorized',
      registration_healthy: true,
      app_version: '0.1.0',
      app_build: '42',
      os_version: '19.0',
      capabilities: ['answer'] as const,
      support: currentSupport,
      support_state: 'current' as const,
      derived_status: 'working' as const,
      status_message: null,
      last_seen_at: '2026-08-05T18:00:00.000Z',
    }
    const client = {
      health: async () => true,
      listDevices: async () => ({ devices: [device] }),
      accessStatus: async () => ({
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'proof@example.com',
      }),
      evidence: async () => evidence,
    } as unknown as ApiClient
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) }

    expect(await statusCommand(deps, evidence.request_id, { json: true })).toBe(EXIT.ok)

    const doctorIo = new CapturedIo()
    expect(await doctorCommand({ ...deps, io: doctorIo }, { json: true })).toBe(EXIT.ok)
    const report = JSON.parse(doctorIo.outLines.join('\n')) as {
      states: { id: string; status: string }[]
    }
    expect(report.states.find((state) => state.id === 'proof')).toMatchObject({ status: 'ready' })
  })
})

describe('Cursor hook commands', () => {
  const execPath = process.execPath
  const scriptPath = fileURLToPath(import.meta.url)

  it('installs native Cursor hooks with bounded chained answer continuations', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-install-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(
      hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath }),
    ).toBe(EXIT.ok)

    const installed = JSON.parse(
      readFileSync(path.join(cwd, '.cursor', 'hooks.json'), 'utf8'),
    ) as {
      version: number
      hooks: Record<string, { command: string; timeout?: number; loop_limit?: number }[]>
    }
    expect(installed.version).toBe(1)
    expect(Object.keys(installed.hooks).sort()).toEqual([
      'beforeSubmitPrompt',
      'sessionEnd',
      'sessionStart',
      'stop',
    ])
    expect(installed.hooks['beforeSubmitPrompt']?.[0]?.command).toContain(
      'hook user-prompt-submit --owner notifai --harness cursor',
    )
    expect(installed.hooks['stop']?.[0]).toMatchObject({
      command: expect.stringContaining('hook activation-stop --owner notifai --harness cursor'),
      loop_limit: 1,
    })
    expect(installed.hooks['stop']?.[1]).toMatchObject({
      command: expect.stringContaining('hook stop --owner notifai --harness cursor'),
      loop_limit: 3,
    })
  })

  it('reports a native Cursor installation through doctor', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-doctor-'))
    const io = new PlainInteractiveIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        HOME: path.join(cwd, 'home'),
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_HOME: path.join(cwd, 'codex'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        OPENCODE_CONFIG_DIR: path.join(cwd, 'opencode'),
      },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }
    expect(
      hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath }),
    ).toBe(EXIT.ok)
    io.outLines = []

    await doctorCommand(deps, {})

    expect(io.outLines).toContain(
      `ok    Question routing: cursor project (${path.join(cwd, '.cursor', 'hooks.json')})`,
    )
    expect(io.outLines.some((line) => line.includes('Cursor: start one fresh conversation'))).toBe(true)
  })

  it('uninstalls only Notifai Cursor hooks and preserves foreign hooks', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-uninstall-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    expect(
      hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath }),
    ).toBe(EXIT.ok)
    const file = path.join(cwd, '.cursor', 'hooks.json')
    const installed = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      hooks: Record<string, { command: string }[]>
    }
    installed.hooks['stop']?.unshift({ command: './keep-my-cursor-hook.sh' })
    writeFileSync(file, `${JSON.stringify(installed, null, 2)}\n`)

    expect(
      hooksUninstallCommand(deps, { harness: 'cursor', scriptPath }),
    ).toBe(EXIT.ok)

    const remaining = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      hooks: Record<string, { command: string }[]>
    }
    expect(remaining.version).toBe(1)
    expect(remaining.hooks['stop']).toEqual([{ command: './keep-my-cursor-hook.sh' }])
    expect(JSON.stringify(remaining)).not.toContain('--owner notifai')
  })
})

describe('Codex hook representation', () => {
  const execPath = process.execPath
  const scriptPath = fileURLToPath(import.meta.url)

  function writeInlineStop(repo: string, command: string): string {
    const file = path.join(repo, '.codex', 'config.toml')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      ['[[hooks.Stop]]', '', '[[hooks.Stop.hooks]]', 'type = "command"', `command = "${command}"`, ''].join(
        '\n',
      ),
    )
    return file
  }

  it('installs a new layer into config.toml without creating hooks.json', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-new-layer-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)

    const toml = path.join(cwd, '.codex', 'config.toml')
    expect(existsSync(toml)).toBe(true)
    expect(existsSync(path.join(cwd, '.codex', 'hooks.json'))).toBe(false)
    expect(readFileSync(toml, 'utf8')).toContain('[[hooks.UserPromptSubmit]]')
    expect(io.outLines.join('\n')).toContain(toml)
  })

  it('installs into existing inline [hooks] and does not create hooks.json', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-inline-install-'))
    const toml = writeInlineStop(cwd, 'gdh-stop')
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)

    expect(existsSync(path.join(cwd, '.codex', 'hooks.json'))).toBe(false)
    const text = readFileSync(toml, 'utf8')
    expect(text).toContain('gdh-stop')
    expect(text).toContain('--owner notifai')
    expect(text).toContain('[[hooks.UserPromptSubmit]]')
    expect(io.outLines.join('\n')).toContain(toml)
    expect(io.outLines.join('\n')).toMatch(/Stop and the existing one will both fire/i)
  })

  it('joins a populated hooks.json without introducing a second representation', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-json-install-'))
    const layer = path.join(cwd, '.codex')
    const json = path.join(layer, 'hooks.json')
    const toml = path.join(layer, 'config.toml')
    mkdirSync(layer, { recursive: true })
    applyPlan(json, {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'gdh-stop' }] }],
      },
    })
    writeFileSync(toml, '# keep this comment\nmodel = "gpt-5.6"\n')
    const beforeToml = readFileSync(toml, 'utf8')
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)

    const afterJson = readFileSync(json, 'utf8')
    expect(afterJson).toContain('gdh-stop')
    expect(afterJson).toContain('--owner notifai')
    expect(readFileSync(toml, 'utf8')).toBe(beforeToml)
    expect(io.outLines.join('\n')).toContain(json)
    expect(io.outLines.join('\n')).not.toMatch(/both representations|not a Notifai fault/i)
  })

  it('leaves config.toml byte-identical when uninstall finds no Notifai hooks', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-noop-uninstall-'))
    const toml = writeInlineStop(cwd, 'gdh-stop')
    const before = `# keep this comment\n${readFileSync(toml, 'utf8')}`
    writeFileSync(toml, before)
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(hooksUninstallCommand(deps, { harness: 'codex', scriptPath })).toBe(EXIT.ok)

    expect(readFileSync(toml, 'utf8')).toBe(before)
    expect(io.outLines.join('\n')).toContain('No Notifai hooks found')
  })

  it('leaves config.toml byte-identical on a no-op reinstall', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-noop-install-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    const toml = path.join(cwd, '.codex', 'config.toml')
    const before = readFileSync(toml, 'utf8')
    io.outLines = []
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    expect(readFileSync(toml, 'utf8')).toBe(before)
  })

  it('deletes an emptied hooks.json instead of leaving an empty residue', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-empty-json-'))
    const layer = path.join(cwd, '.codex')
    const json = path.join(layer, 'hooks.json')
    mkdirSync(layer, { recursive: true })
    applyPlan(json, {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: hookCommand(scriptPath, 'stop', 'codex') }] }],
      },
    })
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    expect(hooksUninstallCommand(deps, { harness: 'codex', scriptPath })).toBe(EXIT.ok)
    expect(existsSync(json)).toBe(false)
  })

  it('global install does not leave a dead project .codex after uninstalling that layer', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-global-migrate-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    expect(existsSync(path.join(cwd, '.codex'))).toBe(true)
    expect(hooksInstallCommand(deps, { harness: 'codex', global: true, execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    expect(existsSync(path.join(cwd, '.codex', 'hooks.json'))).toBe(false)
    const leftover = existsSync(path.join(cwd, '.codex'))
      ? readdirSync(path.join(cwd, '.codex'))
      : []
    expect(leftover.every((name) => name !== 'hooks.json')).toBe(true)
  })

  /**
   * Notifai in one file, someone else's hooks in the other: every handler
   * fires once, so doctor has nothing to report and the foreign file is not
   * ours to rewrite. Doctor used to fail here — the check read "two files" as
   * "two Notifai copies" and pointed at configuration another program owns.
   */
  it('passes doctor when only the other representation is foreign', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-foreign-rep-'))
    const toml = writeInlineStop(cwd, 'gdh-stop')
    const json = path.join(cwd, '.codex', 'hooks.json')
    const env = isolatedEnv(cwd)
    const io = new PlainInteractiveIo()
    const client = {
      health: async () => false,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env }

    applyPlan(json, {
      hooks: buildHookConfig({
        adapterPath: hookAdapterPath(deps.hookAdapterHome),
        harness: 'codex',
      }),
    })

    io.outLines = []
    await doctorCommand(deps, {})
    // Their assertions, this branch's check title.
    const report = io.outLines.join('\n')
    expect(report).not.toMatch(/FAIL {2}Codex hook representation/)
    expect(report).toMatch(/ok {4}Codex hook representation/)
    expect(report).toMatch(/Notifai will not modify it/)

    io.outLines = []
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    expect(existsSync(json)).toBe(true)
    expect(readFileSync(json, 'utf8')).toContain('--owner notifai')
    expect(readFileSync(toml, 'utf8')).toContain('gdh-stop')
    expect(readFileSync(toml, 'utf8')).not.toContain('--owner notifai')
    expect(io.outLines.join('\n')).not.toMatch(/installed in both/i)
    expect(io.outLines.join('\n')).not.toMatch(/collaps/i)

    const installations = findInstallations(cwd, env, deps.hookAdapterHome).filter(
      (installation) => installation.harness === 'codex',
    )
    expect(installations).toHaveLength(1)
    expect(installations[0]?.file).toBe(json)
  })

  it('fails doctor when Notifai itself is installed in both representations', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-dual-'))
    const json = path.join(cwd, '.codex', 'hooks.json')
    const env = isolatedEnv(cwd)
    const io = new CapturedIo()
    const client = {
      health: async () => false,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    applyPlan(json, {
      hooks: buildHookConfig({
        adapterPath: hookAdapterPath(deps.hookAdapterHome),
        harness: 'codex',
      }),
    })

    io.outLines = []
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    const reported = io.outLines.join('\n')
    expect(reported).toMatch(/Codex hook representation/)
    expect(reported).toMatch(/installed in both/i)
    expect(reported).toMatch(/notifies twice per turn/)
    expect(reported).toMatch(/notifai hooks uninstall --harness codex/)

    // The named remedy has to actually clear it, including the copy in the
    // file Notifai would not have chosen to write.
    io.outLines = []
    expect(hooksUninstallCommand(deps, { harness: 'codex', scriptPath })).toBe(EXIT.ok)
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    io.outLines = []
    await doctorCommand(deps, {})
    expect(io.outLines.join('\n')).not.toMatch(/Codex hook representation/)
  })
})

describe('harness activation guidance', () => {
  const execPath = process.execPath
  const scriptPath = fileURLToPath(import.meta.url)

  it('requires a fresh Claude Code session so SessionStart can activate it', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-activation-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(
      hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath }),
    ).toBe(EXIT.ok)

    const output = io.outLines.join('\n')
    expect(output).toContain('Installed claude-code hooks in')
    expect(output).toContain('Start one fresh Claude Code session, send one prompt, then run `notifai doctor`.')
    expect(output).not.toMatch(/timeout|asynchronous|600s/i)
  })

  it('names Codex trust and fresh-session activation in the correct order', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-activation-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(
      EXIT.ok,
    )

    const output = io.outLines.join('\n')
    expect(output).toContain('Approve the Notifai handlers in `/hooks` if Codex asks')
    expect(output).toMatch(/approve[\s\S]*start one fresh Codex session[\s\S]*`notifai doctor`/i)
  })

  it('names the installed harness in the close, never a different one', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-close-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath })).toBe(EXIT.ok)

    const output = io.outLines.join('\n')
    expect(output).toContain('Installed cursor hooks in')
    expect(output).toContain('Start one fresh Cursor conversation, send one prompt, finish its first turn, then run `notifai doctor`.')
    expect(output).not.toMatch(/Codex|Claude Code|OpenCode/)
    expect(output).not.toMatch(/timeout|worktree|fails closed/i)
  })

  it('pins hooks to npx when that is how this CLI is running', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-npx-hooks-'))
    const npmCli = path.join(cwd, 'npm-cli.js')
    writeFileSync(npmCli, '')
    const io = new CapturedIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: {
        npm_command: 'exec',
        npm_execpath: npmCli,
        HOME: path.join(cwd, 'home'),
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
      },
    }

    expect(
      hooksInstallCommand(deps, {
        harness: 'claude-code',
        execPath: process.execPath,
        scriptPath: path.join(cwd, '_npx', 'hash', 'node_modules', '@raidiant', 'notifai', 'dist', 'main.js'),
      }),
    ).toBe(EXIT.ok)

    const inspected = inspectHookAdapter(deps.hookAdapterHome)
    expect(inspected.problems).toEqual([])
    expect(inspected.target && 'spec' in inspected.target ? inspected.target.spec : null).toMatch(
      /^@raidiant\/notifai@/,
    )
  })

  it('keeps OpenCode permission prompts local and reports unsupported continuation', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-activation-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const base = makeDeps(io, client)
    const deps = {
      ...base,
      cwd,
      env: {
        ...base.env,
        HOME: path.join(cwd, 'home'),
        CODEX_HOME: path.join(cwd, 'codex-home'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
        OPENCODE_CONFIG_DIR: path.join(cwd, 'opencode-home'),
      },
    }

    expect(hooksInstallCommand(deps, { harness: 'opencode', execPath, scriptPath })).toBe(
      EXIT.ok,
    )

    expect(io.outLines.join('\n')).toContain('Installed opencode hooks in')
    expect(io.outLines.join('\n')).toContain('Restart OpenCode, start one fresh session, send one prompt, then run `notifai doctor`.')
    expect(io.outLines.join('\n')).not.toMatch(/Permission prompts|exactly-once continuation/)
    const pluginFile = path.join(cwd, '.opencode', 'plugins', 'notifai.js')
    const plugin = readFileSync(pluginFile, 'utf8')
    expect(plugin).toContain('const TIMEOUT_MS = 540000')

    io.outLines = []
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('How an answer returns')
    expect(io.outLines.join('\n')).toContain('no proven answer continuation')
    expect(io.outLines.join('\n')).not.toContain('Hook adapter')

    writeFileSync(pluginFile, plugin.replace(/^const ADAPTER_VERSION = .*\n/m, ''))
    io.outLines = []
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('Hook adapter')
    expect(io.outLines.join('\n')).toContain('obsolete OpenCode event wiring')
  })

  it('refuses a symlinked OpenCode plugin without touching its target', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-symlink-'))
    const plugin = path.join(cwd, '.opencode', 'plugins', 'notifai.js')
    const target = path.join(cwd, 'foreign.js')
    mkdirSync(path.dirname(plugin), { recursive: true })
    writeFileSync(target, '// notifai managed opencode plugin\nleave me\n')
    symlinkSync(target, plugin)
    const io = new CapturedIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: {
        HOME: path.join(cwd, 'home'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        OPENCODE_CONFIG_DIR: path.join(cwd, 'opencode-home'),
      },
    }

    expect(hooksInstallCommand(deps, { harness: 'opencode', execPath, scriptPath })).toBe(
      EXIT.failed,
    )
    expect(io.errLines.join('\n')).toMatch(/not a regular file/)
    expect(readFileSync(target, 'utf8')).toBe('// notifai managed opencode plugin\nleave me\n')
    // Adapter preparation commits first. A definition failure leaves a valid
    // shared adapter (useful to any existing harness) and never half-writes the
    // rejected definition.
    expect(inspectHookAdapter(deps.hookAdapterHome).problems).toEqual([])
    expect(inspectHookAdapter(deps.hookAdapterHome).target?.scriptPath).toBe(scriptPath)
  })

  it('installs an owned OpenClaw plugin and reports unsupported continuation', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-activation-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const home = path.join(cwd, 'home')
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        OPENCLAW_STATE_DIR: path.join(cwd, 'openclaw-home'),
      },
    }

    expect(hooksInstallCommand(deps, { harness: 'openclaw', execPath, scriptPath })).toBe(EXIT.ok)
    expect(io.outLines.join('\n')).toContain('Installed openclaw hooks in')
    expect(io.outLines.join('\n')).toContain(
      'Restart the OpenClaw Gateway, start one fresh Agent Session, send one prompt, then run `notifai doctor`.',
    )
    const pluginFile = path.join(cwd, '.openclaw', 'extensions', 'notifai', 'index.js')
    const plugin = readFileSync(pluginFile, 'utf8')
    expect(plugin).toContain('api.on("before_prompt_build"')
    expect(plugin).toContain('api.on("resolve_exec_env"')
    expect(plugin).not.toContain('command:stop')
    const config = JSON.parse(
      readFileSync(path.join(cwd, 'openclaw-home', 'openclaw.json'), 'utf8'),
    ) as {
      plugins: { entries: { notifai: { enabled: boolean; hooks: { allowConversationAccess: boolean } } } }
    }
    expect(config.plugins.entries.notifai).toEqual({
      enabled: true,
      hooks: { allowConversationAccess: true },
    })

    io.outLines = []
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('no proven answer continuation')
  })

  it('refuses to overwrite a foreign OpenClaw plugin', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-foreign-'))
    const plugin = path.join(cwd, '.openclaw', 'extensions', 'notifai', 'index.js')
    mkdirSync(path.dirname(plugin), { recursive: true })
    writeFileSync(plugin, 'export default { id: "foreign" }\n')
    const io = new CapturedIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: {
        HOME: path.join(cwd, 'home'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        OPENCLAW_STATE_DIR: path.join(cwd, 'openclaw-home'),
      },
    }
    expect(hooksInstallCommand(deps, { harness: 'openclaw', execPath, scriptPath })).toBe(EXIT.failed)
    expect(io.errLines.join('\n')).toMatch(/was not written by Notifai/)
    expect(readFileSync(plugin, 'utf8')).toBe('export default { id: "foreign" }\n')
  })
})

describe('stable hook installation', () => {
  it('keeps definition bytes stable across config, CLI target, and project/global changes', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-stable-hook-install-'))
    const firstCli = path.join(cwd, 'first cli.js')
    const secondCli = path.join(cwd, 'second cli.js')
    writeFileSync(firstCli, '')
    writeFileSync(secondCli, '')
    const io = new CapturedIo()
    const env = {
      HOME: path.join(cwd, 'home'),
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
    }
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env }
    const local = path.join(cwd, '.claude', 'settings.local.json')

    expect(
      hooksInstallCommand(deps, {
        harness: 'claude-code',
        execPath: process.execPath,
        scriptPath: firstCli,
      }),
    ).toBe(EXIT.ok)
    const firstDefinition = readFileSync(local, 'utf8')
    const firstAdapter = readFileSync(hookAdapterPath(deps.hookAdapterHome), 'utf8')
    mkdirSync(path.join(cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(cwd, '.notifai', 'config.local.toml'), 'ask_grace_seconds = 300\n')
    env.XDG_CONFIG_HOME = path.join(cwd, 'different-config')
    env.XDG_STATE_HOME = path.join(cwd, 'different-state')

    expect(
      hooksInstallCommand(deps, {
        harness: 'claude-code',
        execPath: process.execPath,
        scriptPath: secondCli,
      }),
    ).toBe(EXIT.ok)
    expect(readFileSync(local, 'utf8')).toBe(firstDefinition)
    expect(readFileSync(hookAdapterPath(deps.hookAdapterHome), 'utf8')).not.toBe(firstAdapter)
    expect(firstDefinition).toContain(hookAdapterPath(deps.hookAdapterHome))
    expect(firstDefinition).not.toContain(firstCli)
    expect(firstDefinition).not.toContain(secondCli)

    expect(
      hooksInstallCommand(deps, {
        harness: 'claude-code',
        global: true,
        execPath: process.execPath,
        scriptPath: secondCli,
      }),
    ).toBe(EXIT.ok)
    const global = readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')
    expect(global).toBe(firstDefinition)
    expect(readFileSync(local, 'utf8')).not.toContain('--owner notifai')

    io.outLines = []
    await doctorCommand(deps, {})
    expect(io.outLines.join('\n')).not.toMatch(/Duplicate hook installs/)

    expect(hooksUninstallCommand(deps, { harness: 'claude-code' })).toBe(EXIT.ok)
    expect(existsSync(hookAdapterPath(deps.hookAdapterHome))).toBe(true)
    expect(
      findInstallations(cwd, env, deps.hookAdapterHome).filter(
        (item) => item.harness === 'claude-code',
      ),
    ).toHaveLength(1)
  })

  it('does not add a project copy when global hooks already cover the machine', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hooks-global-enough-'))
    const io = new CapturedIo()
    const env = isolatedEnv(cwd)
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env }
    const execPath = process.execPath
    const scriptPath = fileURLToPath(import.meta.url)

    expect(hooksInstallCommand(deps, { harness: 'codex', global: true, execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    io.outLines = []
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    expect(existsSync(path.join(cwd, '.codex', 'config.toml'))).toBe(false)
    expect(io.outLines.join('\n')).toMatch(/already cover this machine/)
    expect(io.outLines.join('\n')).toMatch(/uninstall --harness codex --global/)
    expect(
      findInstallations(cwd, env, deps.hookAdapterHome).filter((item) => item.harness === 'codex'),
    ).toEqual([expect.objectContaining({ global: true })])
  })

  it('refreshes stale global lifecycle coverage instead of declining a project install', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hooks-global-stale-'))
    const io = new CapturedIo()
    const env = isolatedEnv(cwd)
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env }
    const execPath = process.execPath
    const scriptPath = fileURLToPath(import.meta.url)

    expect(
      hooksInstallCommand(deps, {
        harness: 'cursor',
        global: true,
        execPath,
        scriptPath,
      }),
    ).toBe(EXIT.ok)
    const globalFile = settingsFile('cursor', true, cwd, env)
    const settings = JSON.parse(readFileSync(globalFile, 'utf8')) as {
      hooks: { stop: Array<{ command?: string }> }
    }
    settings.hooks.stop = settings.hooks.stop.filter(
      (handler) => !handler.command?.includes(' hook activation-stop '),
    )
    writeFileSync(globalFile, `${JSON.stringify(settings, null, 2)}\n`)

    io.outLines = []
    expect(hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath })).toBe(EXIT.ok)
    expect(existsSync(path.join(cwd, '.cursor', 'hooks.json'))).toBe(false)
    const installation = findInstallations(cwd, env, deps.hookAdapterHome).find(
      (item) => item.harness === 'cursor' && item.global,
    )
    expect(installation?.handlers.map((handler) => handlerEvent(handler.command))).toContain(
      'activation-stop',
    )
    expect(io.outLines.join('\n')).toMatch(/Installed cursor hooks/)
  })

  it('refreshes a stale global Stop shape instead of declining a project install', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hooks-global-shape-'))
    const io = new CapturedIo()
    const env = isolatedEnv(cwd)
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env }
    const execPath = process.execPath
    const scriptPath = fileURLToPath(import.meta.url)

    expect(
      hooksInstallCommand(deps, {
        harness: 'cursor',
        global: true,
        execPath,
        scriptPath,
      }),
    ).toBe(EXIT.ok)
    const globalFile = settingsFile('cursor', true, cwd, env)
    const settings = JSON.parse(readFileSync(globalFile, 'utf8')) as {
      hooks: { stop: Array<{ command?: string; timeout?: number }> }
    }
    const stop = settings.hooks.stop.find((handler) => handler.command?.includes(' hook stop '))
    expect(stop).toBeDefined()
    stop!.timeout = 1
    writeFileSync(globalFile, `${JSON.stringify(settings, null, 2)}\n`)

    io.outLines = []
    expect(hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath })).toBe(EXIT.ok)
    expect(existsSync(path.join(cwd, '.cursor', 'hooks.json'))).toBe(false)
    const refreshed = JSON.parse(readFileSync(globalFile, 'utf8')) as {
      hooks: { stop: Array<{ command?: string; timeout?: number }> }
    }
    expect(
      refreshed.hooks.stop.find((handler) => handler.command?.includes(' hook stop '))?.timeout,
    ).toBeGreaterThan(1)
    expect(io.outLines.join('\n')).toMatch(/Installed cursor hooks/)
  })

  it('consolidates duplicate global Codex representations before declining a project install', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hooks-global-codex-duplicate-'))
    const io = new CapturedIo()
    const env = isolatedEnv(cwd)
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env }
    const execPath = process.execPath
    const scriptPath = fileURLToPath(import.meta.url)

    expect(
      hooksInstallCommand(deps, { harness: 'codex', global: true, execPath, scriptPath }),
    ).toBe(EXIT.ok)
    const json = path.join(env.CODEX_HOME!, 'hooks.json')
    applyPlan(json, {
      hooks: {
        ...buildHookConfig({ adapterPath: hookAdapterPath(deps.hookAdapterHome), harness: 'codex' }),
        PostToolUse: [{ hooks: [{ type: 'command', command: 'foreign-post-tool' }] }],
      },
    })

    io.outLines = []
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    expect(existsSync(path.join(cwd, '.codex', 'config.toml'))).toBe(false)
    expect(readFileSync(json, 'utf8')).toContain('foreign-post-tool')
    expect(readFileSync(json, 'utf8')).not.toContain('--owner notifai')
    expect(
      findInstallations(cwd, env, deps.hookAdapterHome).filter(
        (installation) => installation.harness === 'codex',
      ),
    ).toEqual([expect.objectContaining({ global: true })])
    expect(io.outLines.join('\n')).toMatch(/Installed codex hooks/)
  })

  it('refreshes an obsolete global OpenCode plugin instead of treating empty event requirements as coverage', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hooks-global-opencode-stale-'))
    const io = new CapturedIo()
    const env = isolatedEnv(cwd)
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env }
    const execPath = process.execPath
    const scriptPath = fileURLToPath(import.meta.url)

    expect(
      hooksInstallCommand(deps, {
        harness: 'opencode',
        global: true,
        execPath,
        scriptPath,
      }),
    ).toBe(EXIT.ok)
    const globalFile = settingsFile('opencode', true, cwd, env)
    const current = readFileSync(globalFile, 'utf8')
    writeFileSync(globalFile, current.replace('const ADAPTER_VERSION = 12', 'const ADAPTER_VERSION = 11'))

    io.outLines = []
    expect(hooksInstallCommand(deps, { harness: 'opencode', execPath, scriptPath })).toBe(EXIT.ok)
    expect(existsSync(path.join(cwd, '.opencode', 'plugins', 'notifai.js'))).toBe(false)
    const refreshed = readFileSync(globalFile, 'utf8')
    expect(refreshed).toContain('const ADAPTER_VERSION = 12')
    expect(refreshed).toContain('experimental.chat.system.transform')
    expect(io.outLines.join('\n')).toMatch(/Installed opencode hooks/)
  })
})

describe('projectSlugFrom', () => {
  it('canonicalizes directory names into contract-valid slugs', () => {
    expect(projectSlugFrom('My App')).toBe('my-app')
    expect(projectSlugFrom('Notifai')).toBe('notifai')
    expect(projectSlugFrom('--weird__Name.2')).toBe('weird__name.2')
    expect(projectSlugFrom('!!!')).toBe('project')
  })
})

describe('logs', () => {
  function logDeps(io: CapturedIo): CommandDeps {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-logs-cmd-'))
    return {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'xdg'), XDG_STATE_HOME: path.join(cwd, 'state') },
    }
  }

  function seed(deps: CommandDeps, project?: string): void {
    const logger = createLogger({ env: deps.env, runId: 'r_seed', cmd: 'send' })
    if (project !== undefined) logger.bind({ project })
    logger.info('send.submitted', { request_id: 'req_seeded' })
    logger.error('cli.error', { message: 'the server said no' })
  }

  it('shows the recent records, newest last', () => {
    const io = new CapturedIo()
    const deps = logDeps(io)
    seed(deps)
    expect(logsCommand(deps, {})).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(2)
    expect(io.outLines[0]).toContain('send.submitted')
    expect(io.outLines[1]).toContain('cli.error')
  })

  it('keeps stdout pure JSONL under --json so a parser needs no filtering', () => {
    // Every word of explanation goes to stderr. A machine reading stdout gets
    // records and nothing else.
    const io = new CapturedIo()
    const deps = logDeps(io)
    seed(deps)
    expect(logsCommand(deps, { json: true })).toBe(EXIT.ok)
    for (const line of io.outLines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    }
    expect(io.outLines).toHaveLength(2)
  })

  it('narrows to the failures', () => {
    const io = new CapturedIo()
    const deps = logDeps(io)
    seed(deps)
    expect(logsCommand(deps, { level: 'error', json: true })).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(1)
    expect(io.outLines[0]).toContain('cli.error')
  })

  it('narrows to one notification request', () => {
    const io = new CapturedIo()
    const deps = logDeps(io)
    seed(deps)
    expect(logsCommand(deps, { request: 'req_seeded', json: true })).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(1)
  })

  it('scopes to this project unless told otherwise', () => {
    const io = new CapturedIo()
    const deps = logDeps(io)
    mkdirSync(path.join(deps.cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(deps.cwd, '.notifai', 'config.toml'), 'project = "mine"\n')
    seed(deps, 'mine')
    seed(deps, 'someone-elses')

    // A machine commonly runs several agents in several worktrees at once, and
    // an answer interleaved with three other projects answers nothing.
    expect(logsCommand(deps, { json: true })).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(2)
    io.outLines.length = 0
    expect(logsCommand(deps, { json: true, allProjects: true })).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(4)
  })

  it('rejects an unreadable time, unknown event, and invalid limits', () => {
    const io = new CapturedIo()
    const deps = logDeps(io)
    expect(logsCommand(deps, { since: 'yesterday-ish' })).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('10m')
    io.errLines.length = 0
    expect(logsCommand(deps, { event: ['send.exploded'] })).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('send.submitted')
    io.errLines.length = 0
    expect(logsCommand(deps, { limit: Number.NaN })).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('--limit')
    io.errLines.length = 0
    expect(logsCommand(deps, { limit: 2_001 })).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('cannot exceed 2000')
  })

  it.each([
    [{ path: true, clear: true }, '--path'],
    [{ path: true, request: 'req_seeded' }, '--path'],
    [{ clear: true, since: '1d' }, '--clear'],
    [{ project: 'mine', allProjects: true }, '--project'],
    [{ limit: 10, all: true }, '--limit'],
  ] as const)('rejects incompatible log options %j', (flags, namedFlag) => {
    const io = new CapturedIo()
    expect(logsCommand(logDeps(io), flags)).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain(namedFlag)
  })

  it('accepts relative and absolute times', () => {
    const now = Date.parse('2026-08-11T12:00:00Z')
    expect(parseSince('10m', now)).toBe(now - 600_000)
    expect(parseSince('2h', now)).toBe(now - 7_200_000)
    expect(parseSince('1d', now)).toBe(now - 86_400_000)
    expect(parseSince('2026-08-11T11:00:00Z', now)).toBe(Date.parse('2026-08-11T11:00:00Z'))
    expect(parseSince('whenever', now)).toBeNull()
  })

  it('says why it is empty, and what to do about it', () => {
    // "No records" with no explanation sends the reader looking for a bug that
    // is actually a setting.
    const io = new CapturedIo()
    const deps = logDeps(io)
    mkdirSync(path.join(deps.cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(deps.cwd, '.notifai', 'config.toml'), 'log_level = "off"\n')
    expect(logsCommand(deps, {})).toBe(EXIT.ok)
    expect(io.errLines.join('\n')).toContain('log_level is off')
    expect(io.errLines.join('\n')).toContain('config set log_level info')
  })

  it('points at the files, and says they stay here', () => {
    const io = new CapturedIo()
    const deps = logDeps(io)
    seed(deps)
    expect(logsCommand(deps, { path: true })).toBe(EXIT.ok)
    expect(io.outLines[0]).toContain('notifai.jsonl')
    expect(io.errLines.join('\n')).toContain('stay on this machine')
  })

  it('reports local_only in the machine-readable form', () => {
    const io = new CapturedIo()
    const deps = logDeps(io)
    expect(logsCommand(deps, { path: true, json: true })).toBe(EXIT.ok)
    const parsed = JSON.parse(io.outLines.join('\n')) as Record<string, unknown>
    expect(parsed['local_only']).toBe(true)
    expect(parsed['level']).toBe('info')
  })

  it('clears the files when asked', () => {
    const io = new CapturedIo()
    const deps = logDeps(io)
    seed(deps)
    expect(logsCommand(deps, { clear: true })).toBe(EXIT.ok)
    expect(logsDiskUsage(deps.env).files).toBe(0)
  })
})

describe('config surfaces', () => {
  function configDeps(io: CapturedIo): CommandDeps {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-config-surface-'))
    return { ...makeDeps(io, {} as ApiClient), cwd, env: { XDG_CONFIG_HOME: path.join(cwd, 'xdg') } }
  }

  it('gives an agent the same flat key = value output it always had', () => {
    // The whole point of gating the readable rendering on a human terminal.
    // Anything parsing this today must keep parsing it tomorrow.
    const io = new CapturedIo()
    expect(configShowCommand(configDeps(io), {})).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(CONFIG_KEYS.length)
    expect(io.outLines[0]).toMatch(/^wait_seconds = /)
    for (const line of io.outLines) expect(line).toMatch(/^[a-z_]+ = /)
  })

  it('gives agents the current value, source, and one-line meaning', () => {
    const io = new CapturedIo()
    expect(configShowCommand(configDeps(io), { json: true })).toBe(EXIT.ok)
    const parsed = JSON.parse(io.outLines.join('\n')) as Record<
      string,
      { value: unknown; source: string; summary: string }
    >
    expect(parsed['base_url']).toBeUndefined()
    expect(parsed['ttl_seconds']).toEqual({
      value: 86400,
      source: 'default',
      summary: expect.stringContaining('deliver'),
    })
    expect(parsed['ask_grace_seconds']?.value).toBe(0)
    expect(parsed['ask_grace_seconds']?.summary).toBeTruthy()
    expect(Object.keys(parsed).sort()).toEqual([...CONFIG_KEYS].sort())
  })

  it('refuses to treat the service origin as a setting', async () => {
    const io = new CapturedIo()
    expect(await configSetCommand(configDeps(io), 'base_url', 'https://attacker.example', { yes: true })).toBe(
      EXIT.usage,
    )
    expect(io.errLines[0]).toBe('Unknown setting "base_url".')
  })

  it('explains each setting once a human is at the terminal', () => {
    const io = new InteractiveIo()
    expect(configShowCommand(configDeps(io), {})).toBe(EXIT.ok)
    const text = io.outLines.join('\n')
    expect(text).toContain('Questions')
    expect(text).toContain('Optional delay before a question may reach your devices')
  })

  it('keeps --plain available to a human who wants the parseable form', () => {
    const io = new InteractiveIo()
    expect(configShowCommand(configDeps(io), { plain: true })).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(CONFIG_KEYS.length)
  })

  it('explains one setting, and says so in JSON when asked', () => {
    const io = new InteractiveIo()
    expect(configExplainCommand(configDeps(io), 'ask_notifications', { json: true })).toBe(EXIT.ok)
    const parsed = JSON.parse(io.outLines.join('\n')) as Record<string, unknown>
    expect(parsed['key']).toBe('ask_notifications')
    expect(parsed['accepts']).toBe('true or false')
    expect(parsed['detail']).toContain('The master switch')
    expect(parsed['detail']).toContain('Turn it off')
  })

  it('rejects an unknown setting and points at the nearest real one', () => {
    const io = new CapturedIo()
    expect(configExplainCommand(configDeps(io), 'ask_notification')).toBe(EXIT.usage)
    expect(io.errLines[0]).toBe('Unknown setting "ask_notification".')
  })

  it('refuses a sound that cannot be a shipped name, custom id, or custom name', async () => {
    const io = new CapturedIo()
    expect(await configSetCommand(configDeps(io), 'sound', 'n'.repeat(200), { yes: true })).toBe(
      EXIT.usage,
    )
    expect(io.errLines[0]).toContain('custom sound')
  })

  it('accepts a shipped sound and an Account custom name', async () => {
    const io = new CapturedIo()
    expect(await configSetCommand(configDeps(io), 'sound', 'none', { yes: true })).toBe(EXIT.ok)
    expect(await configSetCommand(configDeps(io), 'sound', 'Kitchen timer', { yes: true })).toBe(
      EXIT.ok,
    )
  })

  it('removes one machine setting, preserves its siblings, and restores default provenance', async () => {
    const io = new CapturedIo()
    const deps = configDeps(io)
    const configFile = path.join(deps.env['XDG_CONFIG_HOME']!, 'notifai', 'config.toml')
    mkdirSync(path.dirname(configFile), { recursive: true })
    writeFileSync(configFile, 'wait_seconds = 20\nsound = "done"\n')

    expect(await configUnsetCommand(deps, 'wait_seconds', { yes: true })).toBe(EXIT.ok)

    const remaining = readFileSync(configFile, 'utf8')
    expect(remaining).toContain('sound = "done"')
    expect(remaining).not.toContain('wait_seconds')
    const resolved = loadConfig({ cwd: deps.cwd, env: deps.env })
    expect(resolved.wait_seconds).toEqual({ value: 10, source: 'default' })
    expect(resolved.sound.source).toMatch(/^global:/)
  })

  it('round-trips unknown root and table keys through config set and unset', async () => {
    const io = new CapturedIo()
    const deps = configDeps(io)
    const configFile = path.join(deps.env['XDG_CONFIG_HOME']!, 'notifai', 'config.toml')
    mkdirSync(path.dirname(configFile), { recursive: true })
    writeFileSync(
      configFile,
      [
        'future_root = "keep-root"',
        'wait_seconds = 20',
        '',
        '[future_table]',
        'future_key = "keep-table"',
        '',
      ].join('\n'),
    )

    expect(await configSetCommand(deps, 'sound', 'done', { yes: true })).toBe(EXIT.ok)
    expect(parseToml(readFileSync(configFile, 'utf8'))).toEqual({
      future_root: 'keep-root',
      wait_seconds: 20,
      sound: 'done',
      future_table: { future_key: 'keep-table' },
    })

    expect(await configUnsetCommand(deps, 'wait_seconds', { yes: true })).toBe(EXIT.ok)
    expect(parseToml(readFileSync(configFile, 'utf8'))).toEqual({
      future_root: 'keep-root',
      sound: 'done',
      future_table: { future_key: 'keep-table' },
    })
  })

  it('refuses to create a redundant machine override equal to the shipped default', async () => {
    const io = new CapturedIo()
    const deps = configDeps(io)

    expect(await configSetCommand(deps, 'wait_seconds', '10', { yes: true })).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('already the shipped default')
    expect(io.errLines.join('\n')).toContain('notifai config unset wait_seconds')
    expect(existsSync(path.join(deps.env['XDG_CONFIG_HOME']!, 'notifai', 'config.toml'))).toBe(false)
  })

  it('allows a project to choose the shipped value when it masks a machine override', async () => {
    const io = new CapturedIo()
    const deps = configDeps(io)
    const globalFile = path.join(deps.env['XDG_CONFIG_HOME']!, 'notifai', 'config.toml')
    mkdirSync(path.dirname(globalFile), { recursive: true })
    writeFileSync(globalFile, 'wait_seconds = 20\n')

    expect(await configSetCommand(deps, 'wait_seconds', '10', { project: true, yes: true })).toBe(
      EXIT.ok,
    )
    expect(loadConfig({ cwd: deps.cwd, env: deps.env }).wait_seconds).toMatchObject({
      value: 10,
      source: expect.stringMatching(/^project:/),
    })
  })
})

describe('interactive command UX', () => {
  it('styles login pairing progress for a human terminal', async () => {
    const io = new InteractiveIo()
    let now = 0
    let savedMachine = ''
    let polls = 0
    const client = {
      beginPairing: async () => ({
        pairing_id: 'pair_test',
        code: 'ABCD-EFGH',
        approve_url: 'https://app.notifai.sh/pair/ABCD-EFGH',
        expires_at: new Date(10_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => {
        polls += 1
        return polls === 1 ? { status: 'pending' } : { status: 'approved', machine_id: 'mac_new' }
      },
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
      store: {
        load: () => null,
        save: (credential) => {
          savedMachine = credential.machineId
        },
        clear: () => {},
        describe: () => 'test credential store',
      },
    }

    expect(await loginCommand(deps, { name: 'workstation', open: false })).toBe(EXIT.ok)
    expect(io.intros).toEqual(['Notifai sign in'])
    expect(io.notes).toEqual([
      {
        title: 'Approve this machine',
        message: expect.stringMatching(
          /^Code: ABCD-EFGH\nhttps:\/\/app\.notifai\.sh\/pair\/ABCD-EFGH#confirmation_secret=[A-Za-z0-9_-]{43}$/,
        ),
      },
    ])
    expect(io.spinnerEvents).toEqual([
      'start:Waiting for approval… code ABCD-EFGH · 10s left',
      'message:Waiting for approval… code ABCD-EFGH · 9s left',
      'stop:Machine "workstation" approved',
    ])
    expect(io.outLines).toEqual([])
    expect(savedMachine).toBe('mac_new')
  })

  it('keeps unattended login progress plain and unstyled', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      beginPairing: async () => ({
        pairing_id: 'pair_test',
        code: 'ABCD-EFGH',
        approve_url: 'https://app.notifai.sh/pair/ABCD-EFGH',
        expires_at: new Date(10_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => ({ status: 'approved', machine_id: 'mac_new' }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }

    expect(await loginCommand(deps, { open: false })).toBe(EXIT.ok)
    expect(io.outLines.slice(0, 3)).toEqual([
      'Pairing code: ABCD-EFGH',
      expect.stringMatching(
        /^Approve this machine at: https:\/\/app\.notifai\.sh\/pair\/ABCD-EFGH#confirmation_secret=[A-Za-z0-9_-]{43}$/,
      ),
      'Waiting for approval…',
    ])
  })

  it('asks a human to choose a config layer when no layer flag was passed', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-config-layer-'))
    const io = new InteractiveIo()
    io.selectAnswer = 'local'
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'xdg') },
    }

    expect(await configSetCommand(deps, 'sound', 'done', {})).toBe(EXIT.ok)
    const localFile = personalProjectConfigPath(cwd, deps.env)
    expect(io.prompts[0]).toBe('Where should this setting live?')
    expect(io.prompts[1]).toContain(localFile)
    expect(readFileSync(localFile, 'utf8')).toContain('sound = "done"')
    expect(existsSync(path.join(cwd, '.notifai', 'config.local.toml'))).toBe(false)
  })

  it('bypasses interactive config selection with --yes and uses the global default', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-config-global-'))
    const io = new InteractiveIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'xdg') },
    }

    expect(await configSetCommand(deps, 'sound', 'done', { yes: true })).toBe(EXIT.ok)
    expect(io.prompts).toEqual([])
    expect(readFileSync(path.join(cwd, 'xdg', 'notifai', 'config.toml'), 'utf8')).toContain(
      'sound = "done"',
    )
  })

  it('asks the same layer question when returning a setting to its inherited value', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-config-unset-layer-'))
    const io = new InteractiveIo()
    io.selectAnswer = 'local'
    const env = { XDG_CONFIG_HOME: path.join(cwd, 'xdg') }
    const localFile = personalProjectConfigPath(cwd, env)
    mkdirSync(path.dirname(localFile), { recursive: true })
    writeFileSync(localFile, 'sound = "done"\n')
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env,
    }

    expect(await configUnsetCommand(deps, 'sound', {})).toBe(EXIT.ok)
    expect(io.prompts[0]).toBe('Where should this setting live?')
    expect(io.prompts[1]).toContain(localFile)
    expect(existsSync(localFile)).toBe(false)
  })

  it('rejects numeric config values that resolution would otherwise silently clamp', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-config-bounds-'))
    const io = new CapturedIo()
    const configFile = path.join(cwd, 'xdg', 'notifai', 'config.toml')
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'xdg') },
    }

    expect(await configSetCommand(deps, 'ask_grace_seconds', '600', { yes: true })).toBe(
      EXIT.usage,
    )
    expect(await configSetCommand(deps, 'ask_grace_seconds', '1.5', { yes: true })).toBe(
      EXIT.usage,
    )
    expect(io.errLines).toEqual([
      'ask_grace_seconds must be between 0 and 360.',
      // Names the key and its range: `"1.5" is not an integer` left the reader
      // to work out which of the two settings they had just mistyped.
      'ask_grace_seconds takes a whole number from 0s–360s, not "1.5".',
    ])
    expect(existsSync(configFile)).toBe(false)
  })

  it('renders doctor checks through the styled seam for humans', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-style-'))
    const io = new InteractiveIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.intros).toEqual(['Notifai doctor'])
    expect(io.checks.some((check) => !check.ok && check.message.startsWith('This machine:'))).toBe(true)
    expect(io.checks.some((check) => check.message.startsWith('Notifai update:'))).toBe(false)
    expect(io.outLines).toEqual([])

    // Four tones, not two. A boolean has to round `optional-gap` and `unknown`
    // to pass or fail, and rounding them to pass put a tick beside things the
    // user had declined and beside things nothing had checked.
    const tone = (prefix: string): Tone | undefined =>
      io.checks.find((check) => check.message.startsWith(prefix))?.tone
    expect(tone('This machine:')).toBe('bad')
    // Never evaluated: the account cannot be checked without a credential.
    expect(tone('Account:')).toBe('pending')
    // Legitimately declined rather than broken.
    expect(tone('Project identity:')).toBe('warn')
  })

  it('keeps doctor JSON as one machine-readable stdout document', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-json-'))
    const io = new InteractiveIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_HOME: path.join(cwd, 'codex'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    await doctorCommand(deps, { json: true })
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toHaveProperty('states')
    expect(io.intros).toEqual([])
    expect(io.checks).toEqual([])
  })

  it('consults npm latest from an interactive doctor without failing the run', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-registry-'))
    const io = new InteractiveIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
      fetchImpl: async () => new Response(JSON.stringify({ latest: '99.0.0' }), { status: 200 }),
    }

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines).toContain('A newer Notifai is available.')
    expect(io.outLines).toContain(updateCliCommand(deps))
  })
})

describe('compatibility-first update guidance', () => {
  const cases: Array<{
    name: string
    support: Partial<SupportAssessment>
    status: 'ready' | 'optional-gap' | 'gap'
    detail: string
    exit: number
  }> = [
    {
      name: 'current',
      support: {},
      status: 'ready',
      detail: 'Notifai can send notifications.',
      exit: EXIT.ok,
    },
    {
      name: 'optional newer release',
      support: {
        state: 'update_available',
        reason: 'newer_release',
        recovery_action: 'update_cli',
        recommended_version: '6.0.0',
      },
      status: 'optional-gap',
      detail: 'A newer Notifai is available.',
      exit: EXIT.ok,
    },
    {
      name: 'scheduled Sunset',
      support: {
        state: 'update_available',
        reason: 'sunset_scheduled',
        recovery_action: 'update_cli',
        recommended_version: '6.0.0',
        deprecation: 'Tue, 18 Aug 2026 00:00:00 GMT',
        sunset: 'Tue, 15 Sep 2026 00:00:00 GMT',
      },
      status: 'optional-gap',
      detail: 'Update Notifai soon to keep sending notifications.',
      exit: EXIT.ok,
    },
    {
      name: 'required update',
      support: {
        state: 'must_update',
        reason: 'minimum_not_met',
        affected_operation: 'send_notifications',
        recovery_action: 'update_cli',
        recommended_version: '6.0.0',
        minimum_version: '6.0.0',
      },
      status: 'gap',
      detail: "Notifai can't send notifications until you update.",
      exit: EXIT.failed,
    },
  ]

  it.each(cases)(
    'maps $name policy to closed human copy and structured JSON',
    async ({ support, status, detail, exit }) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-update-guidance-'))
      const client = {
        health: async () => true,
        compatibility: async () => compatibilityWithCli(support),
        listDevices: async () => ({ devices: [] }),
        accessStatus: async () => ({ email: 'user@example.test' }),
      } as unknown as ApiClient
      const humanIo = new InteractiveIo()
      const deps = {
        ...makeDeps(humanIo, client),
        cwd,
        env: isolatedEnv(cwd),
      }
      const readiness = await assessReadiness(deps)
      const contract = readiness.states.find((state) => state.id === 'contract')
      expect(contract).toMatchObject({ status, detail })

      expect(
        await doctorCommand(deps, {}, { readiness: { states: [contract!] } }),
      ).toBe(exit)
      expect(humanIo.outLines).toEqual(
        status === 'ready' ? [] : [detail, updateCliCommand(deps)],
      )
      expect(humanIo.errLines).toEqual([])
      expect(humanIo.outros).toEqual(
        status === 'ready' ? ['Everything looks good'] : [],
      )

      const jsonIo = new CapturedIo()
      expect(
        await doctorCommand(
          { ...deps, io: jsonIo },
          { json: true },
          { readiness: { states: [contract!] } },
        ),
      ).toBe(exit)
      expect(jsonIo.outLines).toHaveLength(1)
      const payload = JSON.parse(jsonIo.outLines[0] ?? '{}') as {
        ok: boolean
        exit_code: number
        states: Array<{
          status: string
          detail: string
          remedy?: { command?: string }
        }>
      }
      expect(payload).toMatchObject({
        ok: exit === EXIT.ok,
        exit_code: exit,
        states: [{ status, detail }],
      })
      expect(payload.states[0]?.remedy?.command ?? null).toBe(
        status === 'ready' ? null : updateCliCommand(deps),
      )
      expect(jsonIo.errLines).toEqual([])

      const nonTtyIo = new CapturedIo()
      expect(
        await doctorCommand(
          { ...deps, io: nonTtyIo },
          {},
          { readiness: { states: [contract!] } },
        ),
      ).toBe(exit)
      expect(nonTtyIo.outLines).toHaveLength(1)
      expect(JSON.parse(nonTtyIo.outLines[0] ?? '{}')).toEqual(payload)
      expect(nonTtyIo.errLines).toEqual([])
    },
  )

  it('reports a missing named CLI capability without blocking ordinary sends', async () => {
    const requestedPlatforms: Platform[] = []
    let submissions = 0
    const client = {
      health: async () => true,
      compatibility: async (): Promise<CompatibilityResponse> => ({
        ...currentCompatibility,
        // This service can still accept baseline Notification Requests, but it
        // cannot honor this CLI's Agent Acknowledgement feature yet.
        server_capabilities: ['answer'],
      }),
      capabilities: async (platform: Platform = 'ios') => {
        requestedPlatforms.push(platform)
        const document = CAPABILITIES_V1.describe(platform)
        if (document === null) throw new Error(`missing ${platform} capability document`)
        return document
      },
      listDevices: async () => ({ devices: [] }),
      accessStatus: async () => ({ email: 'user@example.test' }),
      submit: async () => {
        submissions += 1
        return receipt
      },
    } as unknown as ApiClient
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-capability-guidance-'))
    const io = new PlainInteractiveIo()
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    const readiness = await assessReadiness(deps)
    const contract = readiness.states.find((state) => state.id === 'contract')
    expect(requestedPlatforms).toEqual([...PLATFORMS])
    expect(contract).toMatchObject({
      status: 'optional-gap',
      detail: 'The service is being updated; try again later.',
      technical: {
        capability_documents: PLATFORMS.map((platform) => ({ platform, schema_version: 1 })),
        cli_capability_intersection: {
          available: [],
          missing_on_server: ['agent_acknowledgement'],
        },
      },
    })

    expect(
      await doctorCommand(deps, {}, { readiness: { states: [contract!] } }),
    ).toBe(EXIT.ok)
    expect(io.outLines).toEqual(['The service is being updated; try again later.'])
    expect(io.outLines.join('\n')).not.toContain('notifai update')

    const sendIo = new CapturedIo()
    expect(
      await sendCommand(
        { ...deps, io: sendIo },
        { kind: 'update', title: 'Build finished', body: 'All checks passed.' },
      ),
    ).toBe(EXIT.ok)
    expect(submissions).toBe(1)
    expect(sendIo.errLines).toEqual([])
  })
})

describe('init', () => {
  const readyIphone = {
    device_id: 'dev_iphone',
    display_name: 'iPhone',
    platform: 'ios' as const,
    permission_status: 'authorized',
    registration_healthy: true,
    app_version: '0.1.0',
    app_build: '42',
    os_version: '19.0',
    capabilities: ['answer'] as const,
    support: currentSupport,
    support_state: 'current' as const,
    derived_status: 'working' as const,
    status_message: null,
    last_seen_at: '2026-08-05T18:00:00.000Z',
  }
  const readyMac = {
    ...readyIphone,
    device_id: 'dev_mac',
    display_name: 'Mac',
    platform: 'macos' as const,
  }
  const readyAndroid = {
    ...readyIphone,
    device_id: 'dev_android',
    display_name: 'Pixel',
    platform: 'android' as const,
    os_version: '16',
  }

  function setupEvidence(
    requestId: string,
    companionReceipt: EvidenceSnapshot['deliveries'][number]['companion_receipt'],
    device: typeof readyIphone | typeof readyAndroid = readyIphone,
  ): EvidenceSnapshot {
    return {
      request_id: requestId,
      accepted_at: '2026-08-05T18:00:00.000Z',
      overall: 'provider_accepted_all',
      deliveries: [
        {
          delivery_id: 'del_setup',
          device_id: device.device_id,
          device_name: device.display_name,
          state: 'provider_accepted',
          attempts: 1,
          provider_status: 200,
          provider_reason: null,
          provider_id: 'provider_setup',
          updated_at: '2026-08-05T18:00:01.000Z',
          companion_receipt: companionReceipt,
          events:
            companionReceipt.state === 'observed'
              ? [
                  {
                    stage: 'companion_received',
                    source: 'companion',
                    reason: null,
                    attempt: null,
                    occurred_at: companionReceipt.observed_at!,
                  },
                ]
              : [],
        },
      ],
    }
  }

  function setupReceipt(
    requestId = 'req_setup',
    device: typeof readyIphone | typeof readyAndroid = readyIphone,
  ): SubmissionReceipt {
    return {
      ...receipt,
      request_id: requestId,
      deliveries: [
        {
          ...receipt.deliveries[0]!,
          device_id: device.device_id,
          device_name: device.display_name,
        },
      ],
    }
  }

  function managedSkill(scope: SkillScope, cwd: string): NativeSkill {
    const skillPath = path.join(cwd, '.agents', 'skills', 'notifai')
    if (!existsSync(skillPath)) installCurrentSkill(skillPath)
    return {
      name: 'notifai',
      scope,
      path: skillPath,
      source: 'Raidiant-io/notifai',
      sourceType: 'github',
      sourceUrl: 'https://github.com/Raidiant-io/notifai.git',
      ref: RELEASE_REF,
    }
  }

  function setupReadyDeps(
    io: CapturedIo,
    cwd: string,
    nativeSkills: NativeSkills,
    calls: { submit: number },
  ): CommandDeps {
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        calls.submit += 1
        return setupReceipt()
      },
      evidence: async () =>
        setupEvidence('req_setup', {
          state: 'observed',
          observed_at: '2026-08-05T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient
    return {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      nativeSkills,
      hookInstallTarget: {
        execPath: process.execPath,
        scriptPath: fileURLToPath(import.meta.url),
      },
    }
  }

  it('writes the project identifier into .notifai/config.toml and is idempotent', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'My Project-'))
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, { setupScope: 'project' })).toBe(EXIT.failed)
    const configPath = path.join(cwd, '.notifai', 'config.toml')
    expect(readFileSync(configPath, 'utf8')).toContain('project = "my-project-')
    // Safe by default: without an explicit --skills opt-in, init only writes
    // configuration and never spawns the skill installer.
    expect(io.outLines.join('\n')).not.toContain('Installing the notifai agent skill')
    expect(io.outLines.join('\n')).not.toContain('All set.')

    io.outLines = []
    expect(await initCommand(deps, { setupScope: 'project', skills: false })).toBe(EXIT.failed)
    // Idempotent: the second run re-derives the same slug and does not reprint
    // doctor's ready-state dump.
    expect(io.outLines.join('\n')).toMatch(/^Next:/m)
    expect(io.outLines.join('\n')).not.toContain('Project identity:')
    expect(readFileSync(configPath, 'utf8')).toContain('project = "my-project-')
  })

  it('resumes the same init after a required CLI update becomes current', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-init-update-resume-'))
    const io = new OutroCapturedIo()
    let cliSupport = compatibilityWithCli({
      state: 'must_update',
      reason: 'minimum_not_met',
      affected_operation: 'send_notifications',
      recovery_action: 'update_cli',
      recommended_version: '6.0.0',
      minimum_version: '6.0.0',
    })
    let submissions = 0
    const client = {
      health: async () => true,
      compatibility: async () => cliSupport,
      listDevices: async () => ({ devices: [readyIphone] }),
      accessStatus: async () => ({ email: 'user@example.test' }),
      submit: async () => {
        submissions += 1
        return setupReceipt('req_after_update')
      },
      evidence: async () =>
        setupEvidence('req_after_update', {
          state: 'observed',
          observed_at: '2026-08-18T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(
      await initCommand(deps, {
        hooks: false,
        setupScope: 'project',
        skills: false,
      }),
    ).toBe(EXIT.failed)
    expect(io.outLines).toContain("Notifai can't send notifications until you update.")
    expect(io.outLines).toContain(updateCliCommand(deps))
    expect(io.outros).toEqual([])
    expect(submissions).toBe(0)

    cliSupport = currentCompatibility
    io.outLines = []
    io.errLines = []
    io.outros = []

    expect(
      await initCommand(deps, {
        hooks: false,
        setupScope: 'project',
        skills: false,
      }),
    ).toBe(EXIT.ok)
    expect(submissions).toBe(1)
    expect(io.outLines).toContain(
      'All set. Agents in this project can notify you. Questions are terminal-only until Question Routing is ready.',
    )
    expect(io.outLines).not.toContain('notifai update')
    expect(io.errLines).toEqual([])
  })

  it('retargets Question Routing while the post-update init resumes', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-init-update-adapter-'))
    const io = new CapturedIo()
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      remove: async () => 0,
      list: async () => ({ skills: [] }),
    }
    const deps = setupReadyDeps(io, cwd, nativeSkills, { submit: 0 })
    const oldArtifact = path.join(cwd, 'old', 'dist', 'main.js')
    const prefix = path.join(cwd, 'current')
    const packageRoot = path.join(prefix, 'lib', 'node_modules', '@raidiant', 'notifai')
    const currentArtifact = path.join(packageRoot, 'dist', 'main.js')
    const currentCommand = path.join(prefix, 'bin', 'notifai')
    mkdirSync(path.dirname(oldArtifact), { recursive: true })
    mkdirSync(path.dirname(currentArtifact), { recursive: true })
    mkdirSync(path.dirname(currentCommand), { recursive: true })
    writeFileSync(oldArtifact, '#!/usr/bin/env node\n')
    writeFileSync(currentArtifact, '#!/usr/bin/env node\n')
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version: RELEASE_REF.slice(1) }))
    chmodSync(oldArtifact, 0o755)
    chmodSync(currentArtifact, 0o755)
    symlinkSync(path.relative(path.dirname(currentCommand), currentArtifact), currentCommand)
    deps.env = { ...deps.env, PATH: path.dirname(currentCommand) }
    deps.hookInstallTarget = { execPath: process.execPath, scriptPath: currentArtifact }

    installHookAdapter({ execPath: process.execPath, scriptPath: oldArtifact }, deps.hookAdapterHome)
    applyPlan(path.join(cwd, '.codex', 'hooks.json'), {
      hooks: buildHookConfig({
        adapterPath: hookAdapterPath(deps.hookAdapterHome),
        harness: 'codex',
      }),
    })

    expect(inspectHookAdapter(deps.hookAdapterHome).target).toMatchObject({ scriptPath: oldArtifact })
    expect(
      await initCommand(deps, { hooks: false, setupScope: 'project', skills: false }),
    ).toBe(EXIT.ok)
    expect(inspectHookAdapter(deps.hookAdapterHome).target).toMatchObject({
      scriptPath: realpathSync(currentArtifact),
    })
    expect(io.outLines.join('\n')).not.toContain('notifai hooks install')
  })

  it('surfaces one next step, not the whole remaining list', async () => {
    // The behavioural core of the design: someone handed five things to do
    // does none of them. Signing in gates the device check, so naming both
    // would send the reader to fix something not yet known to be wrong.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-one-step-'))
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, { health: async () => true } as unknown as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: cwd, XDG_STATE_HOME: cwd },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: This machine')
    expect(out).toContain('notifai init')
    expect(out).not.toContain('notifai login')
    expect(out).not.toContain('Then re-run')
    // The device gap is real and downstream; it must stay hidden until the
    // sign-in that would let anyone actually check it has happened.
    expect(out).not.toContain('companion app')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('honors an explicit --project-id', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-explicit-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(
      await initCommand(deps, {
        projectId: 'Custom Name',
        setupScope: 'project',
        skills: false,
      }),
    ).toBe(EXIT.failed)
    expect(readFileSync(path.join(cwd, '.notifai', 'config.toml'), 'utf8')).toContain(
      'project = "custom-name"',
    )
  })

  it('closes what a process can close when no scope was passed, and asks nothing', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-agent-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, { json: true, hooks: false, skills: false })).toBe(EXIT.failed)
    // Naming this checkout is not skill or hook placement, so it no longer
    // waits on a scope question nobody can answer here.
    expect(readFileSync(path.join(cwd, '.notifai', 'config.toml'), 'utf8')).toContain('project = "')
    const result = JSON.parse(io.outLines[0] ?? '{}') as {
      states: Array<{ id: string; status: string; remedy: { command?: string } | null }>
    }
    expect(result.states.find((state) => state.id === 'project')).toMatchObject({ status: 'ready' })
    // The run stops where a human genuinely is required, and never hands back
    // the command that produced this output as the thing to do about it.
    const project = result.states.find((state) => state.id === 'project')
    expect(project?.remedy).toBeNull()
    expect(io.errLines).toEqual([])
  })

  it('pins the skill installer to the tagged release this build actually is', () => {
    expect(SKILLS_SOURCE).toBe(`Raidiant-io/notifai#${RELEASE_REF}`)
    // `#` selects a Git ref; `@` would select a skill name instead.
    expect(SKILLS_SOURCE).not.toContain('@v')
  })

  it('recognizes a skill installed from the exact immutable release', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-pinned-skill-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const installedPath = path.join(cwd, '.agents', 'skills', 'notifai')
    installCurrentSkill(installedPath)
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      remove: async () => 0,
      list: async (scope) => ({
        skills:
          scope === 'project'
            ? [
                {
                  name: 'notifai',
                  scope,
                  path: installedPath,
                  source: 'Raidiant-io/notifai',
                  sourceType: 'github',
                  sourceUrl: 'https://github.com/Raidiant-io/notifai.git',
                  ref: RELEASE_REF,
                },
              ]
            : [],
      }),
    }
    const readiness = await assessReadiness(
      { ...makeDeps(io, client), cwd, nativeSkills },
      { skillScope: 'project' },
    )
    expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
      status: 'ready',
      detail: `installed in the project scope and verified against the guidance shipped with CLI ${CLI_VERSION}`,
    })
  })

  it.each(['project', 'global'] as const)(
    'recognizes native installer provenance in the selected %s scope',
    async (scope) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), `init-managed-${scope}-`))
      const io = new CapturedIo()
      const client = {
        health: async () => true,
        capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
        listDevices: async () => ({ devices: [] }),
      } as unknown as ApiClient
      const calls: SkillScope[] = []
      const nativeSkills: NativeSkills = {
        add: async () => 0,
        remove: async () => 0,
        list: async (selected) => {
          calls.push(selected)
          return { skills: selected === scope ? [managedSkill(selected, cwd)] : [] }
        },
      }

      const readiness = await assessReadiness(
        { ...makeDeps(io, client), cwd, nativeSkills },
        { skillScope: scope },
      )
      expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
        status: 'ready',
        detail: `installed in the ${scope} scope and verified against the guidance shipped with CLI ${CLI_VERSION}`,
      })
      expect(calls).toEqual(['project', 'global'])
    },
  )

  it.each(['project', 'global'] as const)(
    'trusts exact installed content independently of mutable %s provenance metadata',
    async (scope) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), `init-unmanaged-${scope}-`))
      const io = new CapturedIo()
      const client = {
        health: async () => true,
        capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
        listDevices: async () => ({ devices: [] }),
      } as unknown as ApiClient
      const nativeSkills: NativeSkills = {
        add: async () => 0,
        remove: async () => 0,
        list: async (selected) => ({
          skills:
            selected === scope
              ? [{ ...managedSkill(selected, cwd), source: null, sourceType: null, ref: null }]
              : [],
        }),
      }

      const readiness = await assessReadiness(
        { ...makeDeps(io, client), cwd, nativeSkills },
        { skillScope: scope },
      )
      expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
        status: 'ready',
        detail: `installed in the ${scope} scope and verified against the guidance shipped with CLI ${CLI_VERSION}`,
      })
    },
  )

  it('reports a duplicate notifai skill across project and global scope', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'assess-skill-duplicate-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      remove: async () => 0,
      list: async (scope) => ({
        skills: [
          {
            ...managedSkill(scope, cwd),
            ref: scope === 'project' ? RELEASE_REF : 'v0.2.1',
            path:
              scope === 'project'
                ? path.join(cwd, '.agents', 'skills', 'notifai')
                : path.join(cwd, 'home', '.agents', 'skills', 'notifai'),
          },
        ],
      }),
    }

    const readiness = await assessReadiness({ ...makeDeps(io, client), cwd, nativeSkills })
    const skill = readiness.states.find((state) => state.id === 'skill')
    expect(skill).toMatchObject({
      status: 'gap',
      detail: `project (${RELEASE_REF}) and global (v0.2.1) are both installed, so the harness lists both. Keep either project or global and uninstall the other.`,
      technical: {
        project: {
          ref: RELEASE_REF,
          path: path.join(cwd, '.agents', 'skills', 'notifai'),
          current: true,
        },
        global: {
          ref: 'v0.2.1',
          path: path.join(cwd, 'home', '.agents', 'skills', 'notifai'),
          current: false,
        },
        resolution: 'both-listed',
      },
    })

    expect(await doctorCommand({ ...makeDeps(io, client), cwd, nativeSkills }, { json: true })).toBe(
      EXIT.failed,
    )
    const payload = JSON.parse(io.outLines[0] ?? '{}') as {
      ok: boolean
      states: Array<{ id: string; status: string; detail: string }>
    }
    expect(payload.ok).toBe(false)
    expect(payload.states.find((state) => state.id === 'skill')).toMatchObject({
      status: 'gap',
      detail: expect.stringContaining('harness lists both'),
    })
  })

  it('does not treat a current pin as ready when a stale duplicate is also installed', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'assess-skill-shadow-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      remove: async () => 0,
      list: async (scope) => ({
        skills: [
          {
            ...managedSkill(scope, cwd),
            ref: scope === 'global' ? RELEASE_REF : 'v0.2.1',
          },
        ],
      }),
    }

    const readiness = await assessReadiness(
      { ...makeDeps(io, client), cwd, nativeSkills },
      { skillScope: 'global' },
    )
    expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
      status: 'gap',
      detail: `project (v0.2.1) and global (${RELEASE_REF}) are both installed, so the harness lists both. Keep either project or global and uninstall the other.`,
    })
  })

  it('uninstalls the other skill scope before installing the chosen one', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-duplicate-prevented-'))
    const io = new CapturedIo()
    const removed: SkillScope[] = []
    const added: Array<SkillScope | undefined> = []
    let globalPresent = true
    const nativeSkills: NativeSkills = {
      add: async (options) => {
        added.push(options.scope)
        return 0
      },
      remove: async (options) => {
        removed.push(options.scope)
        if (options.scope === 'global') globalPresent = false
        return 0
      },
      list: async (scope) => ({
        skills: scope === 'global' && globalPresent ? [{ ...managedSkill('global', cwd), ref: 'v0.2.1' }] : [],
      }),
    }

    expect(
      await initCommand(setupReadyDeps(io, cwd, nativeSkills, { submit: 0 }), {
        skills: true,
        setupScope: 'project',
        hooks: false,
      }),
    ).toBe(EXIT.ok)
    expect(removed).toEqual(['global'])
    expect(added).toEqual(['project'])
  })

  it('clears a pre-existing skill duplicate by keeping the chosen setup scope', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-duplicate-clear-'))
    const io = new CapturedIo()
    const removed: SkillScope[] = []
    const present = new Set<SkillScope>(['project', 'global'])
    const nativeSkills: NativeSkills = {
      add: async (options) => {
        if (options.scope !== undefined) present.add(options.scope)
        return 0
      },
      remove: async (options) => {
        removed.push(options.scope)
        present.delete(options.scope)
        return 0
      },
      list: async (scope) => ({
        skills: present.has(scope)
          ? [
              {
                ...managedSkill(scope, cwd),
                ref: scope === 'project' ? RELEASE_REF : 'v0.2.1',
              },
            ]
          : [],
      }),
    }

    expect(
      await initCommand(setupReadyDeps(io, cwd, nativeSkills, { submit: 0 }), {
        skills: true,
        setupScope: 'project',
        hooks: false,
      }),
    ).toBe(EXIT.ok)
    expect(removed).toEqual(['global'])
    expect([...present]).toEqual(['project'])
  })

  it('does not reinstall content-current guidance because mutable ref metadata is stale', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-update-existing-'))
    const io = new InteractiveIo()
    const received: Array<SkillScope | undefined> = []
    const installed = true
    const nativeSkills: NativeSkills = {
      add: async (options) => {
        received.push(options.scope)
        return 0
      },
      remove: async () => 0,
      list: async (scope) => ({
        skills: installed && scope === 'global' ? [{ ...managedSkill('global', cwd), ref: 'v0.2.1' }] : [],
      }),
    }

    expect(
      await initCommand(setupReadyDeps(io, cwd, nativeSkills, { submit: 0 }), {
        skills: true,
        hooks: false,
      }),
    ).toBe(EXIT.ok)
    expect(received).toEqual([])
  })

  it('requires an explicit skill scope before unattended installation', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-scope-required-'))
    const io = new CapturedIo()
    let addCalls = 0
    const nativeSkills: NativeSkills = {
      add: async () => {
        addCalls += 1
        return 0
      },
      remove: async () => 0,
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand({ ...makeDeps(io, {} as ApiClient), cwd, nativeSkills }, { skills: true })).toBe(
      EXIT.usage,
    )
    expect(addCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('--setup-scope project')
  })

  it('rejects an invalid unattended skill scope instead of guessing', async () => {
    const io = new CapturedIo()
    expect(
      await initCommand(
        { ...makeDeps(io, {} as ApiClient), cwd: mkdtempSync(path.join(os.tmpdir(), 'init-skill-invalid-')) },
        { skills: true, skillsScope: 'machine' as SkillScope },
      ),
    ).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('Choose `project` or `global`')
  })

  it.each(['project', 'global'] as const)(
    'passes an unattended %s choice to the native installer and continues setup',
    async (scope) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), `init-skill-${scope}-`))
      const io = new CapturedIo()
      const calls: { submit: number } = { submit: 0 }
      let installed = false
      let receivedScope: SkillScope | undefined
      const nativeSkills: NativeSkills = {
        add: async (options) => {
          receivedScope = options.scope
          installed = true
          return 0
        },
        remove: async () => 0,
        list: async (selected) => ({
          skills: installed && selected === scope ? [managedSkill(scope, cwd)] : [],
        }),
      }

      const result = await initCommand(
        setupReadyDeps(io, cwd, nativeSkills, calls),
        { skills: true, skillsScope: scope, hooks: false },
      )
      expect(result).toBe(EXIT.ok)
      expect(receivedScope).toBe(scope)
      expect(calls.submit).toBe(1)
      expect(io.outLines.join('\n')).toContain('All set.')
    },
  )

  it('asks one setup-scope question and passes that scope to the native installer', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-setup-scope-ask-'))
    const io = new InteractiveIo()
    io.selectAnswer = 'project'
    const calls: { submit: number } = { submit: 0 }
    let receivedScope: SkillScope | undefined
    const nativeSkills: NativeSkills = {
      add: async (options) => {
        receivedScope = options.scope
        return 0
      },
      remove: async () => 0,
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand(setupReadyDeps(io, cwd, nativeSkills, calls), { skills: true, hooks: false })).toBe(
      EXIT.ok,
    )
    expect(io.prompts[0]).toContain('this project only, or to every project on this machine')
    expect(receivedScope).toBe('project')
    expect(calls.submit).toBe(1)
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('accepts --setup-scope as the unattended skill, hooks, and config scope', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-setup-scope-flag-'))
    const io = new CapturedIo()
    let receivedScope: SkillScope | undefined
    const nativeSkills: NativeSkills = {
      add: async (options) => {
        receivedScope = options.scope
        return 0
      },
      remove: async () => 0,
      list: async (scope) => ({
        skills: receivedScope === scope ? [managedSkill(scope, cwd)] : [],
      }),
    }

    expect(
      await initCommand(setupReadyDeps(io, cwd, nativeSkills, { submit: 0 }), {
        skills: true,
        setupScope: 'project',
        hooks: false,
      }),
    ).toBe(EXIT.ok)
    expect(receivedScope).toBe('project')
    expect(existsSync(path.join(cwd, '.notifai', 'config.toml'))).toBe(true)
  })

  it('stamps project identity outside the repo when setup-scope is global', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-setup-scope-global-config-'))
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: isolatedEnv(cwd),
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, { setupScope: 'global', skills: false, hooks: false })).toBe(EXIT.failed)
    expect(existsSync(path.join(cwd, '.notifai', 'config.toml'))).toBe(false)
    expect(readFileSync(personalProjectConfigPath(cwd, deps.env), 'utf8')).toMatch(/project = "/)
  })

  it('rejects disagreeing --setup-scope and --skills-scope', async () => {
    const io = new CapturedIo()
    expect(
      await initCommand(
        { ...makeDeps(io, {} as ApiClient), cwd: mkdtempSync(path.join(os.tmpdir(), 'init-scope-conflict-')) },
        { skills: true, setupScope: 'project', skillsScope: 'global' },
      ),
    ).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('disagree')
  })

  it('installs every detected project harness when --hooks is set', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-hooks-all-detected-'))
    mkdirSync(path.join(cwd, '.claude'))
    mkdirSync(path.join(cwd, '.codex'))
    const io = new CapturedIo()
    const calls = { submit: 0 }
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      remove: async () => 0,
      list: async () => ({ skills: [] }),
    }
    const deps = setupReadyDeps(io, cwd, nativeSkills, calls)
    await initCommand(deps, { hooks: true, setupScope: 'project', skills: false })
    const wired = findInstallations(cwd, deps.env, deps.hookAdapterHome).map(
      (installation) => installation.harness,
    )
    expect(wired).toEqual(['claude-code', 'codex'])
    expect(existsSync(path.join(cwd, '.claude', 'settings.local.json'))).toBe(true)
    expect(existsSync(path.join(cwd, '.codex', 'hooks.json'))).toBe(false)
    expect(existsSync(path.join(cwd, '.codex', 'config.toml'))).toBe(true)
    expect(io.outLines.join('\n')).not.toContain('Installed claude-code hooks')
    expect(io.outLines.join('\n')).not.toContain('Installed codex hooks')
    // A hook diagnostic is a report line. The run it appears in still reaches
    // the delivery proof, which is the thing `init` is there to produce.
    expect(io.outLines.join('\n')).toContain('Companion Receipt')
    expect(io.outLines.join('\n')).toContain('All set.')
    expect(io.outLines.join('\n')).not.toContain('Next: Codex hook trust')
  })

  it('lets a human keep a subset of the detected harnesses', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-hooks-pick-'))
    mkdirSync(path.join(cwd, '.claude'))
    mkdirSync(path.join(cwd, '.codex'))
    const io = new InteractiveIo()
    io.multiselectAnswer = ['claude-code']
    const calls = { submit: 0 }
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      remove: async () => 0,
      list: async () => ({ skills: [] }),
    }
    const deps = setupReadyDeps(io, cwd, nativeSkills, calls)
    expect(await initCommand(deps, { skills: false })).toBe(EXIT.ok)
    expect(io.prompts.some((prompt) => prompt.includes('Which agent harnesses'))).toBe(true)
    const wired = findInstallations(cwd, deps.env, deps.hookAdapterHome).map(
      (installation) => installation.harness,
    )
    expect(wired).toEqual(['claude-code'])
  })

  it('reports an optional native installer failure without blocking remaining setup', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-failed-'))
    const io = new InteractiveIo()
    const calls: { submit: number } = { submit: 0 }
    const nativeSkills: NativeSkills = {
      add: async () => 1,
      remove: async () => 0,
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand(setupReadyDeps(io, cwd, nativeSkills, calls), { skills: true, hooks: false })).toBe(
      EXIT.failed,
    )
    expect(calls.submit).toBe(1)
    expect(io.errLines.join('\n')).toContain('Skill installation failed')
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('explains a local Windows npm launch failure without blaming the network', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-local-launch-failed-'))
    const io = new InteractiveIo()
    const nativeSkills: NativeSkills = {
      add: async () => ({
        code: 1,
        error:
          'this Windows Node.js installation is missing its bundled npm tools; repair or reinstall Node.js, then rerun setup',
      }),
      remove: async () => 0,
      list: async () => ({ skills: [] }),
    }

    expect(
      await initCommand(setupReadyDeps(io, cwd, nativeSkills, { submit: 0 }), {
        skills: true,
        setupScope: 'project',
        hooks: false,
      }),
    ).toBe(EXIT.failed)
    expect(io.errLines.join('\n')).toContain('missing its bundled npm tools')
    expect(io.errLines.join('\n')).not.toContain('network')
  })

  it('tells the user what only they can do when nothing is signed in', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-nocred-'))
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, { setupScope: 'project' })).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('notifai init')
    expect(io.outLines.join('\n')).not.toContain('notifai login')
  })

  it('announces sign-in for a present human without re-confirming', async () => {
    // Running `init` is the consent; re-asking "Sign in now?" is noise.
    // Ctrl-C is the escape hatch (announced). Here beginPairing fails so we
    // still end on the credential Next line with a re-run hint.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-human-'))
    const asked: string[] = []
    const io = new (class extends CapturedIo {
      interactive = true
      override async confirm(question: string) {
        asked.push(question)
        return false
      }
    })()
    const client = {
      health: async () => true,
      beginPairing: async () => {
        throw new NetworkError('offline for test')
      },
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, { setupScope: 'project' })).toBe(EXIT.failed)
    expect(asked.some((q) => q.includes('Sign in'))).toBe(false)
    const out = io.outLines.join('\n')
    expect(out).toContain('Opening your browser to approve this machine — Ctrl-C to stop.')
    expect(out).toContain('Next: This machine')
    expect(out).toContain('notifai init')
    expect(out).not.toContain('notifai login')
  })

  it('never prompts or opens a browser when an agent runs it unattended', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-agent-no-input-'))
    const io = new (class extends CapturedIo {
      override async confirm(): Promise<boolean> {
        throw new Error('an unattended init reached a prompt')
      }

      override openUrl(): void {
        throw new Error('an unattended init opened a browser')
      }
    })()
    const deps: CommandDeps = {
      ...makeDeps(io, { health: async () => true } as unknown as ApiClient),
      cwd,
      env: isolatedEnv(cwd),
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('Next: This machine')
  })

  it('makes the unavailable distribution bridge explicit when no app has registered', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-no-device-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
      accessStatus: async () => ({
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'alpha@example.com',
      }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    // One focused destination for this errand, never the omnibus help page.
    expect(out).toContain('https://test.notifai.invalid/setup/companion')
    expect(out).not.toContain('/support')
    expect(out).toContain('sign in with the same email as this account (alpha@example.com)')
    expect(out).toContain('no active Companion App registered yet')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('offers hooks and skill before stopping at a phone-less device gap', async () => {
    // P2.1: optionals that work without a phone must not be trapped behind the
    // user-elsewhere device blocker.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-optionals-first-'))
    const asked: string[] = []
    const io = new (class extends CapturedIo {
      interactive = true
      override async confirm(question: string) {
        asked.push(question)
        return false
      }
    })()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
      accessStatus: async () => ({
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'alpha@example.com',
      }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      nativeSkills: {
        list: async () => ({ skills: [] }),
        add: async () => 0,
        remove: async () => 0,
      } satisfies NativeSkills,
    }

    expect(await initCommand(deps, { setupScope: 'project' })).toBe(EXIT.ok)
    expect(asked).toEqual(expect.arrayContaining([expect.stringMatching(/hooks/)]))
    expect(asked).toEqual(expect.arrayContaining([expect.stringMatching(/skill/)]))
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    // Device wait prompts only after optionals have been considered.
    expect(asked.indexOf(asked.find((q) => q.includes('hooks'))!)).toBeLessThan(
      asked.findIndex((q) => q.includes('Wait here') || q.includes('Open install')),
    )
  })

  it.each([
    ['denied', "the device's Settings"],
    ['not_determined', 'allow its notification prompt'],
  ])('gives one permission-specific next action for %s', async (permission, expected) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), `init-permission-${permission}-`))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({
        devices: [{ ...readyIphone, permission_status: permission, registration_healthy: false }],
      }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain(`iPhone (ios, ${permission})`)
    expect(out).toContain(expected)
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('ignores a dormant Mac installation while waiting for an active Companion, then proves the iPhone receipt', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-device-bridge-'))
    const io = new InteractiveIo()
    let now = 0
    let deviceReady = false
    let submitCalls = 0
    let submittedDraft: SubmitNotificationRequestT | null = null
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: deviceReady ? [readyIphone] : [readyMac] }),
      accessStatus: async () => ({
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'alpha@example.com',
      }),
      submit: async (draft: SubmitNotificationRequestT) => {
        submitCalls += 1
        submittedDraft = draft
        return setupReceipt()
      },
      evidence: async (requestId: string) =>
        setupEvidence(requestId, {
          state: 'observed',
          observed_at: '2026-08-05T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
        deviceReady = true
      },
    }

    // The terminal asks which phone, in those words, and the destination it
    // opens is already about that answer — nobody chooses twice.
    io.selectAnswer = 'iphone'
    expect(
      await initCommand(deps, {
        hooks: false,
        setupScope: 'project',
        skills: false,
      }),
    ).toBe(EXIT.ok)
    expect(io.prompts).toEqual([
      'Where do you want to receive notifications?',
      'Open those steps in your browser?',
      'Wait here while you finish that on your phone?',
    ])
    expect(io.openedUrls).toEqual(['https://test.notifai.invalid/setup/companion?platform=iphone'])
    expect(io.notes.some((n) => n.message.includes('I will wait up to 10 minutes'))).toBe(true)
    expect(io.spinnerEvents).toContain(
      'message:Waiting for a Companion App to sign in and register…',
    )
    expect(io.spinnerEvents).toContain('stop:iPhone is ready to receive')
    expect(io.spinnerEvents).toContain('stop:Receipt observed from iPhone')
    expect(io.outLines.join('\n')).toContain(
      "Companion Receipt (the app's delivery confirmation) observed from iPhone.",
    )
    expect(io.outLines.join('\n')).toContain('All set.')
    expect(submitCalls).toBe(1)
    expect(submittedDraft?.draft).not.toHaveProperty('event')
    expect(submittedDraft?.draft.targets).toEqual({ mode: 'selected', device_ids: ['dev_iphone'] })
    // The proof is a real send that has to be seen: a normal banner and sound,
    // not a silent arrival in Notification Center a first-time User never
    // looks at. Its sound is left to the server's kind/Project/Account layers.
    expect(submittedDraft?.draft.platform).toEqual({ ios: { interruption_level: 'active' } })
    expect(submittedDraft?.draft.kind).toBe('done')

    io.outLines = []
    io.prompts = []
    io.openedUrls = []
    expect(
      await initCommand(deps, {
        hooks: false,
        setupScope: 'project',
        skills: false,
      }),
    ).toBe(EXIT.ok)
    expect(submitCalls).toBe(1)
    expect(io.prompts).toEqual([])
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('says the wait timer expired and can keep waiting for a late device', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-device-keep-waiting-'))
    const io = new InteractiveIo()
    // Open browser, wait yes, keep-waiting yes on first expiry.
    io.confirmAnswers = [true, true, true]
    let now = 0
    // Match DEVICE_BRIDGE_TIMEOUT_MS (10 minutes): device appears only after
    // the first budget has fully elapsed and keep-waiting has restarted.
    const firstBudgetMs = 10 * 60 * 1000
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({
        devices: now >= firstBudgetMs ? [readyIphone] : [],
      }),
      accessStatus: async () => ({
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'late@example.com',
      }),
      submit: async () => setupReceipt(),
      evidence: async (requestId: string) =>
        setupEvidence(requestId, {
          state: 'observed',
          observed_at: '2026-08-05T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    }

    expect(
      await initCommand(deps, {
        hooks: false,
        setupScope: 'project',
        skills: false,
      }),
    ).toBe(EXIT.ok)
    expect(io.errLines.join('\n')).toContain('wait timer expired')
    expect(io.errLines.join('\n')).toMatch(/setup is not finished, only this wait/)
    expect(io.prompts.some((q) => q.includes('Keep waiting'))).toBe(true)
    expect(io.spinnerEvents).toContain('stop:iPhone is ready to receive')
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('never hangs an agent on the device wait or keep-waiting prompt', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-device-agent-'))
    const io = new (class extends CapturedIo {
      override async confirm(): Promise<boolean> {
        throw new Error('an unattended init reached a device-wait prompt')
      }

      override openUrl(): void {
        throw new Error('an unattended init opened a browser')
      }
    })()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
      accessStatus: async () => ({
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'agent@example.com',
      }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(
      await initCommand(deps, {
        hooks: false,
        setupScope: 'project',
        skills: false,
      }),
    ).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    expect(out).toContain('https://test.notifai.invalid/setup/companion')
    expect(out).not.toContain('/support')
    expect(out).toContain('sign in with the same email as this account (agent@example.com)')
    expect(io.openedUrls).toEqual([])
  })

  it('persists a partial proof and checks the same request instead of sending again', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-proof-partial-'))
    const io = new CapturedIo()
    let now = 0
    let submitCalls = 0
    let savedRequestMissing = false
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt(submitCalls === 1 ? 'req_partial' : 'req_replacement')
      },
      evidence: async (requestId: string) => {
        if (savedRequestMissing && requestId === 'req_partial') {
          throw new ApiCallError(404, 'not_found', 'No such request.')
        }
        return setupEvidence(
          requestId,
          savedRequestMissing
            ? {
                state: 'observed',
                observed_at: '2026-08-05T18:00:02.000Z',
                latency_ms: 1_000,
              }
            : { state: 'unknown', observed_at: null, latency_ms: null },
        )
      },
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    }

    expect(
      await initCommand(deps, {
        hooks: false,
        setupScope: 'project',
        skills: false,
      }),
    ).toBe(EXIT.failed)
    expect(submitCalls).toBe(1)
    expect(io.outLines.join('\n')).toContain('Next: Delivery proof')
    expect(io.outLines.join('\n')).toContain('Provider accepted the notification')
    expect(io.outLines.join('\n')).toContain('Proof may still arrive')
    const proofDir = path.join(stateDir(deps.env), 'setup-proofs')
    expect(readdirSync(proofDir).some((name) => name.endsWith('.json'))).toBe(true)

    io.outLines = []
    io.errLines = []
    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    expect(submitCalls).toBe(1)
    expect(io.outLines.join('\n')).toContain('Checking verification notification req_partial again.')

    io.outLines = []
    io.errLines = []
    savedRequestMissing = true
    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    expect(submitCalls).toBe(2)
    expect(io.outLines.join('\n')).toContain('saved proof had expired; sent replacement req_replacement')
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('replaces a stale unknown setup proof instead of rechecking it forever', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-proof-stale-'))
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt('req_fresh')
      },
      evidence: async (requestId: string) =>
        setupEvidence(
          requestId,
          requestId === 'req_fresh'
            ? {
                state: 'observed',
                observed_at: '2026-08-25T00:00:02.000Z',
                latency_ms: 1_000,
              }
            : { state: 'unknown', observed_at: null, latency_ms: null },
        ),
    } as unknown as ApiClient
    const now = Date.parse('2026-08-25T00:00:00.000Z')
    mkdirSync(path.join(cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(cwd, '.notifai', 'config.toml'), 'project = "stale-proof"\n')
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      now: () => now,
    }
    writeSetupProof(deps, {
      request_id: 'req_old',
      device_id: readyIphone.device_id,
      project: 'stale-proof',
      started_at: new Date(now - SETUP_PROOF_STALE_MS - 1).toISOString(),
    })

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    expect(submitCalls).toBe(1)
    expect(io.outLines.join('\n')).toContain('older than 24h without a Companion Receipt')
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('reports a proof-state write failure instead of crashing or sending twice', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-proof-unwritable-'))
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt('req_unwritable')
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { ...isolatedEnv(cwd), XDG_STATE_HOME: '/dev/null' },
    }

    await expect(
      initCommand(deps, {
        hooks: false,
        setupScope: 'project',
        skills: false,
      }),
    ).resolves.toBe(EXIT.failed)
    expect(submitCalls).toBe(1)
    expect(io.errLines.join('\n')).toContain('Could not save setup proof req_unwritable')
    expect(io.outLines.join('\n')).toContain('Next: Delivery proof')
  })

  it('writes the first notification about the User, not about the check', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-proof-copy-'))
    mkdirSync(path.join(cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(cwd, '.notifai', 'config.toml'), 'project = "orders-api"\n')
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | null = null
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return setupReceipt()
      },
      evidence: async (requestId: string) =>
        setupEvidence(requestId, {
          state: 'observed',
          observed_at: '2026-08-05T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    const presentation = submitted!.draft.presentation

    // A title says what is now true for the reader, alone on a lock screen,
    // and carries neither the kind nor the Project — both travel as their own
    // fields.
    expect(presentation.title).toBe('Your agents can reach you')
    expect(presentation.title.length).toBeLessThanOrEqual(40)
    expect(presentation.title).not.toMatch(/orders-api|done/i)

    // None of the vocabulary of the check that produced it: the reader has not
    // met "verification", a "proof", or the distinction between a real
    // notification and any other kind.
    const copy = `${presentation.title} ${presentation.body}`
    expect(copy).not.toMatch(/verification|verify|proof|receipt|real notification|test/i)
    // And nothing about where it landed or what to do to it.
    expect(copy).not.toMatch(/iPhone|Android|phone|tap|swipe|banner|lock screen/i)

    expect(presentation.body).toContain('orders-api')
    expect(presentation.body).toMatch(/^Notifai setup is finished/)

    // Still the same bar: a real send whose Companion Receipt was observed.
    expect(io.outLines.join('\n')).toContain(
      "Companion Receipt (the app's delivery confirmation) observed from iPhone.",
    )
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('treats Android as active Companion readiness and sends a platform-correct proof', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-android-proof-'))
    mkdirSync(path.join(cwd, '.notifai'), { recursive: true })
    writeFileSync(
      path.join(cwd, '.notifai', 'config.toml'),
      'project = "android-project"\ninterruption_level = "passive"\n',
    )
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | null = null
    const client = {
      health: async () => true,
      listDevices: async () => ({ devices: [readyAndroid] }),
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return setupReceipt('req_android_setup', readyAndroid)
      },
      evidence: async (requestId: string) =>
        setupEvidence(
          requestId,
          {
            state: 'observed',
            observed_at: '2026-08-05T18:00:02.000Z',
            latency_ms: 1_000,
          },
          readyAndroid,
        ),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    expect(submitted?.draft.targets).toEqual({
      mode: 'selected',
      device_ids: [readyAndroid.device_id],
    })
    // Android has no caller-selected interruption level, so a configured Apple
    // preference must not reach it — and nothing else is stamped either, so the
    // server's kind sound applies rather than the old hard silence.
    expect(submitted?.draft.platform).toBeUndefined()
    expect(JSON.stringify(submitted?.draft)).not.toContain('interruption_level')
    expect(submitted?.draft.kind).toBe('done')
    expect(io.outLines.join('\n')).toContain(
      "Companion Receipt (the app's delivery confirmation) observed from Pixel.",
    )
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('does not treat a macOS-only installation as active-release readiness', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-macos-proof-'))
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({
        devices: [readyMac],
      }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt()
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    expect(submitCalls).toBe(0)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    expect(out).toContain('no active Companion App registered yet')
    expect(out).not.toContain('All set.')
    expect(out).not.toMatch(/Companion Receipt observed/i)

    // A human doctor must render the same active-Companion readiness failure.
    const doctorIo = new PlainInteractiveIo()
    expect(
      await doctorCommand(
        {
          ...makeDeps(doctorIo, client),
          cwd,
          env: isolatedEnv(cwd),
        },
        {},
      ),
    ).toBe(EXIT.failed)
    const doctorOut = doctorIo.outLines.join('\n')
    expect(doctorOut).toMatch(/FAIL\s+Your devices: no active Companion App registered yet/)
    expect(doctorOut).toContain(
      'Delivery proof: not checked — no iPhone or Android Companion App is ready',
    )
  })

  it('says access is already requested rather than asking for it again', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-access-requested-'))
    const io = new CapturedIo()
    const nextAction = 'Open https://app.notifai.sh/setup/access to set up access, then retry.'
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => {
        throw new ApiCallError(403, 'no_active_plan', 'No active plan.', nextAction)
      },
      accessStatus: async () => ({
        status: 'no_active_plan',
        reason: 'no_active_grant',
        expires_at: null,
        email: 'waiting@example.test',
        public_v1_cutover: false,
      }),
      accessRequest: async () => ({
        request: {
          status: 'requested',
          requested_at: '2026-08-21T09:15:00.000Z',
          updated_at: '2026-08-21T09:15:00.000Z',
        },
      }),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) }

    const readiness = await assessReadiness(deps)
    const auth = readiness.states.find((state) => state.id === 'auth')
    // The middle value. Without it, someone who asked in August is told to ask
    // again on every run, forever, for a wait no command of theirs can shorten.
    expect(auth?.detail).toContain('access requested on 2026-08-21')
    expect(auth?.detail).toContain('waiting@example.test')
    expect(auth?.remedy).toMatchObject({ by: 'user-elsewhere' })
    expect(JSON.stringify(auth)).not.toContain('/setup/access')

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('nothing is needed from you')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('asks for access only when this account has never asked', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-access-never-asked-'))
    const io = new CapturedIo()
    const nextAction = 'Open https://app.notifai.sh/setup/access to set up access, then retry.'
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => {
        throw new ApiCallError(403, 'no_active_plan', 'No active plan.', nextAction)
      },
      accessStatus: async () => ({
        status: 'no_active_plan',
        reason: 'no_active_grant',
        expires_at: null,
        email: 'fresh@example.test',
        public_v1_cutover: false,
      }),
      accessRequest: async () => ({ request: null }),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) }

    const auth = (await assessReadiness(deps)).states.find((state) => state.id === 'auth')
    expect(auth?.detail).toContain('does not have access to Notifai yet')
    expect(auth?.remedy).toMatchObject({ by: 'user-elsewhere', summary: nextAction })
  })

  it('does not let a duplicate agent-skill install stand in front of the proof', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-duplicate-'))
    const io = new CapturedIo()
    const calls = { submit: 0 }
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      remove: async () => 0,
      // Both scopes installed: the harness lists two, which is a real problem
      // and a human decision — and still not a reason to withhold the proof.
      list: async (scope) => ({ skills: [managedSkill(scope ?? 'project', cwd)] }),
    }
    const deps = setupReadyDeps(io, cwd, nativeSkills, calls)

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    const readiness = await assessReadiness(deps)
    expect(readiness.states.find((state) => state.id === 'skill')?.status).toBe('gap')
    expect(firstRequiredBlocker(readiness)).toBeNull()
    expect(calls.submit).toBe(1)
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('closes on the blocker that stopped the run, not the state before it', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-login-access-'))
    const io = new InteractiveIo()
    let now = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      beginPairing: async () => ({
        pairing_id: 'pair_test',
        code: 'ABCD-EFGH',
        approve_url: 'https://app.notifai.sh/pair/ABCD-EFGH',
        expires_at: new Date(10_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => ({
        status: 'no_active_plan',
        next_action: 'Open https://app.notifai.sh/setup/access to set up access, then retry.',
      }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test store' },
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    // One next step, and it is the one that actually stopped the run. The
    // pairing state that preceded it would send the reader straight back into
    // the command that just failed, for a reason it never names.
    expect(out.match(/^Next:/gm)).toHaveLength(1)
    expect(out).toContain('Next: Access')
    expect(out).toContain('https://app.notifai.sh/setup/access')
    expect(out).not.toContain('not paired with your account')

    // …and the wall is stated once across the whole visit. It used to arrive
    // three ways — a lowercase `next:` from the pairing failure, an "after
    // access … run `notifai init`" remedy, and this close — so a stopped User
    // had to work out which of three destinations-and-commands was theirs.
    const said = [
      ...io.outLines,
      ...io.errLines,
      ...io.notes.map((note) => note.message),
      ...io.spinnerEvents,
    ].join('\n')
    expect(said.match(/setup\/access/g)).toHaveLength(1)
    expect(said.match(/does not have access/g)).toHaveLength(1)
    expect(said).not.toContain('After access is granted')
    expect(said).not.toContain('next: ')
    // Rerunning is how they resume, not how they get access.
    expect(out).toContain('Then re-run `notifai init` and it will pick up from here.')
  })

  it('treats a revoked credential as the one blocker and points back to pairing', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-revoked-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => {
        throw new ApiCallError(401, 'machine_revoked', 'This machine was revoked.')
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Account')
    expect(out).toContain('pair it again')
    expect(out).toContain('notifai init')
    expect(out).not.toContain('notifai login')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('names the support next action when a paired account has no active plan', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-no-plan-'))
    const io = new CapturedIo()
    const nextAction = 'Open https://app.notifai.sh/support to request Alpha access, then retry.'
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => {
        throw new ApiCallError(403, 'no_active_plan', 'No active plan.', nextAction)
      },
      accessStatus: async () => ({
        status: 'no_active_plan',
        reason: 'no_active_grant',
        expires_at: null,
        email: 'rafael@example.test',
      }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    const readiness = await assessReadiness(deps)
    const auth = readiness.states.find((state) => state.id === 'auth')
    expect(auth).toMatchObject({
      status: 'gap',
      detail: 'this account does not have access to Notifai yet (rafael@example.test)',
      remedy: { by: 'user-elsewhere', summary: nextAction },
    })
    expect(auth?.remedy && 'command' in auth.remedy ? auth.remedy.command : undefined).toBeUndefined()

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Account')
    expect(out).toContain(nextAction)
    expect(out).not.toContain('pair it again')
    expect(out).not.toContain('notifai login')
    expect(out.match(/^Next:/gm)).toHaveLength(1)

    const doctorIo = new CapturedIo()
    expect(await doctorCommand({ ...deps, io: doctorIo }, { json: true })).toBe(EXIT.failed)
    const payload = JSON.parse(doctorIo.outLines[0] ?? '{}') as {
      states: Array<{ id: string; remedy?: { summary?: string; command?: string } }>
    }
    const doctorAuth = payload.states.find((state) => state.id === 'auth')
    expect(doctorAuth?.remedy?.summary).toBe(nextAction)
    expect(doctorAuth?.remedy?.command).toBeUndefined()
  })

  it('does not treat a listDevices no-plan 403 as a revoked machine when accessStatus fails', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-no-plan-devices-only-'))
    const io = new CapturedIo()
    const nextAction = 'Open https://app.notifai.sh/support to request Alpha access, then retry.'
    const client = {
      health: async () => true,
      listDevices: async () => {
        throw new ApiCallError(403, 'no_active_plan', 'No active plan.', nextAction)
      },
      accessStatus: async () => {
        throw new ApiCallError(500, 'internal_error', 'access status unavailable')
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
    }

    const readiness = await assessReadiness(deps)
    const auth = readiness.states.find((state) => state.id === 'auth')
    expect(auth?.status).toBe('gap')
    expect(auth?.detail).toContain('does not have access to Notifai yet')
    expect(auth?.remedy).toMatchObject({ by: 'user-elsewhere', summary: nextAction })
    expect(JSON.stringify(auth)).not.toContain('pair it again')
  })

  it('reuses proof across worktrees of one Project on the same Approved Machine', async () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'init-worktrees-state-'))
    let submitCalls = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt(`req_worktree_${submitCalls}`)
      },
      evidence: async (requestId: string) =>
        setupEvidence(requestId, {
          state: 'observed',
          observed_at: '2026-08-05T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient

    for (const name of ['worktree-a', 'worktree-b']) {
      const cwd = mkdtempSync(path.join(os.tmpdir(), `${name}-`))
      const io = new CapturedIo()
      const deps = {
        ...makeDeps(io, client),
        cwd,
        env: { ...isolatedEnv(cwd), XDG_CONFIG_HOME: stateRoot, XDG_STATE_HOME: stateRoot },
      }
      expect(
        await initCommand(deps, {
          projectId: 'shared-project',
          hooks: false,
          setupScope: 'project',
          skills: false,
        }),
      ).toBe(EXIT.ok)
    }

    expect(submitCalls).toBe(1)
  })

  it('returns one authoritative structured final readiness without duplicate probes', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-json-ready-'))
    const io = new InteractiveIo()
    let healthCalls = 0
    let compatibilityCalls = 0
    let deviceCalls = 0
    const client = {
      health: async () => {
        healthCalls += 1
        return true
      },
      compatibility: async () => {
        compatibilityCalls += 1
        return currentCompatibility
      },
      listDevices: async () => {
        deviceCalls += 1
        return { devices: [readyIphone] }
      },
      evidence: async (requestId: string) =>
        setupEvidence(requestId, {
          state: 'observed',
          observed_at: '2026-08-25T00:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient
    mkdirSync(path.join(cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(cwd, '.notifai', 'config.toml'), 'project = "json-ready"\n')
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) }
    writeSetupProof(deps, {
      request_id: 'req_json_ready',
      device_id: readyIphone.device_id,
      project: 'json-ready',
      started_at: '2026-08-25T00:00:00.000Z',
    })

    expect(await initCommand(deps, { json: true, hooks: false, skills: false })).toBe(EXIT.ok)
    expect(io.prompts).toEqual([])
    expect(io.outLines).toHaveLength(1)
    const result = JSON.parse(io.outLines[0] ?? '{}') as {
      ready: boolean
      can_send: boolean
      question_routing_ready: boolean
      states: Array<{ id: string; status: string; remedy: unknown }>
    }
    expect(result.ready).toBe(true)
    expect(result.can_send).toBe(true)
    expect(result.question_routing_ready).toBe(false)
    expect(result.states.length).toBeGreaterThan(8)
    expect(result.states.every((state) => 'remedy' in state)).toBe(true)
    expect(healthCalls).toBe(1)
    expect(compatibilityCalls).toBe(1)
    expect(deviceCalls).toBe(1)
  })
})

describe('readiness assessment cost', () => {
  it('does not re-probe the service after init closes a local-only gap', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-local-reassess-'))
    const io = new CapturedIo()
    let healthCalls = 0
    const client = {
      health: async () => {
        healthCalls += 1
        return true
      },
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, { setupScope: 'project' })).toBe(EXIT.failed)
    expect(healthCalls).toBe(1)
    expect(readFileSync(path.join(cwd, '.notifai', 'config.toml'), 'utf8')).toContain('project =')
  })

  it('reuses remote probes when only local state could have changed', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'assess-local-only-'))
    const io = new CapturedIo()
    let healthCalls = 0
    let deviceCalls = 0
    let evidenceCalls = 0
    const client = {
      health: async () => {
        healthCalls += 1
        return true
      },
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => {
        deviceCalls += 1
        return { devices: [] }
      },
      accessStatus: async () => ({ email: 'user@example.com' }),
      evidence: async () => {
        evidenceCalls += 1
        throw new Error('unused')
      },
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) }

    const previous = await assessReadiness(deps)
    expect(healthCalls).toBe(1)
    expect(deviceCalls).toBe(1)

    const next = await assessReadiness(deps, { previous, refresh: ['local'] })
    expect(healthCalls).toBe(1)
    expect(deviceCalls).toBe(1)
    expect(evidenceCalls).toBe(0)
    expect(next.states.find((state) => state.id === 'server')).toEqual(
      previous.states.find((state) => state.id === 'server'),
    )
  })

  it('renders a supplied doctor report without probing again', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'doctor-reuse-'))
    const io = new CapturedIo()
    let healthCalls = 0
    const client = {
      health: async () => {
        healthCalls += 1
        return true
      },
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: isolatedEnv(cwd),
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    const readiness = await assessReadiness(deps)
    expect(healthCalls).toBe(1)
    expect(await doctorCommand(deps, { json: true }, { readiness })).toBe(EXIT.failed)
    expect(healthCalls).toBe(1)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toHaveProperty('states')
  })

  it('treats a lock-file pin as installed without asking npx', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'assess-lock-skill-'))
    installCurrentSkill(path.join(cwd, '.agents', 'skills', 'notifai'))
    writeFileSync(
      path.join(cwd, 'skills-lock.json'),
      `${JSON.stringify({
        skills: {
          notifai: {
            source: 'Raidiant-io/notifai',
            sourceType: 'github',
            ref: RELEASE_REF,
          },
        },
      })}\n`,
    )
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient

    const readiness = await assessReadiness({
      ...makeDeps(io, client),
      cwd,
      env: { ...isolatedEnv(cwd), PATH: '/nonexistent' },
      nativeSkills: realNativeSkills,
    })
    expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
      status: 'ready',
      detail: `installed in the project scope and verified against the guidance shipped with CLI ${CLI_VERSION}`,
    })
  })

  it('detects a lock-file duplicate across project and global scope', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'assess-lock-skill-duplicate-'))
    const env = { ...isolatedEnv(cwd), PATH: '/nonexistent' }
    writeFileSync(
      path.join(cwd, 'skills-lock.json'),
      `${JSON.stringify({
        skills: {
          notifai: {
            source: 'Raidiant-io/notifai',
            sourceType: 'github',
            ref: RELEASE_REF,
          },
        },
      })}\n`,
    )
    mkdirSync(path.join(env.XDG_STATE_HOME!, 'skills'), { recursive: true })
    writeFileSync(
      path.join(env.XDG_STATE_HOME!, 'skills', '.skill-lock.json'),
      `${JSON.stringify({
        skills: {
          notifai: {
            source: 'Raidiant-io/notifai',
            sourceType: 'github',
            ref: 'v0.2.1',
          },
        },
      })}\n`,
    )
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient

    const readiness = await assessReadiness({
      ...makeDeps(io, client),
      cwd,
      env,
      nativeSkills: realNativeSkills,
    })
    expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
      status: 'gap',
      detail: `project (${RELEASE_REF}) and global (v0.2.1) are both installed, so the harness lists both. Keep either project or global and uninstall the other.`,
      technical: { resolution: 'both-listed' },
    })
  })
})

describe('an outage is not an answer', () => {
  /**
   * The dangerous shape: the first poll succeeds, then connectivity drops and
   * never comes back. waitForReply only throws when NO poll ever succeeded, so
   * this used to return the stale empty response as a plain exit 3 — and an
   * agent scripted to read exit 3 as "nobody objected" would proceed against a
   * refusal it never saw.
   */
  function outageAfterFirstPoll(io: CapturedIo, fault: () => never = () => {
    throw new NetworkError('link went down')
  }): CommandDeps {
    let now = 0
    let polls = 0
    const client = {
      submit: async () => receipt,
      replies: async () => {
        polls += 1
        if (polls === 1) return replyResponse([])
        fault()
      },
    } as unknown as ApiClient
    return {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }
  }

  it('does not report an unreachable server as "no reply yet"', async () => {
    const io = new CapturedIo()
    const exit = await sendCommand(outageAfterFirstPoll(io), {
      title: 'Question',
      body: 'Deploy to production?',
      reply: true,
      replyTimeout: 10,
    })

    // Whatever code this is, it must not be the one that means "asked, and the
    // user stayed silent".
    expect(exit).not.toBe(EXIT.noReply)
    expect(exit).toBe(EXIT.network)
    expect(io.errLines.join('\n')).toContain('could not find out')
    expect(io.errLines.join('\n')).toContain(receipt.request_id)
  })

  it('treats a late internal_error outage the same as a network outage', async () => {
    const io = new CapturedIo()
    const exit = await sendCommand(
      outageAfterFirstPoll(io, () => {
        throw new ApiCallError(500, 'internal_error', 'An unexpected server error occurred.')
      }),
      {
        title: 'Question',
        body: 'Deploy to production?',
        reply: true,
        replyTimeout: 10,
      },
    )

    expect(exit).not.toBe(EXIT.noReply)
    expect(exit).toBe(EXIT.network)
    expect(io.errLines.join('\n')).toContain('could not find out')
    expect(io.errLines.join('\n')).toContain('Provider Acceptance')
  })

  it('marks the JSON so an agent reading it programmatically can tell', async () => {
    const io = new CapturedIo()
    await sendCommand(outageAfterFirstPoll(io), {
      title: 'Question',
      body: 'Deploy?',
      reply: true,
      replyTimeout: 10,
      json: true,
    })

    expect(io.outLines).toHaveLength(1)
    const payload = JSON.parse(io.outLines[0] ?? '{}') as { degraded: boolean }
    expect(payload.degraded).toBe(true)
  })

  it('still reports a genuine silence as no-reply', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      submit: async () => receipt,
      replies: async () => replyResponse([]),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
    }

    expect(
      await sendCommand(deps, { title: 'Q', body: 'B', reply: true, replyTimeout: 5 }),
    ).toBe(EXIT.noReply)
  })
})

describe('asking before the hooks have ever run', () => {
  const execPath = process.execPath
  const scriptPath = fileURLToPath(import.meta.url)
  const scratch: string[] = []

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
    scratch.push(dir)
    return dir
  }

  afterEach(() => {
    while (scratch.length > 0) {
      rmSync(scratch.pop()!, { recursive: true, force: true })
    }
  })

  it('refuses to write Codex trust outside the isolated test account', () => {
    expect(() => trustInstalledCodexHooks(os.tmpdir(), {})).toThrow(/requires env.HOME/)
    expect(() => trustInstalledCodexHooks(os.tmpdir(), { HOME: path.dirname(os.tmpdir()) })).toThrow(
      /will only write under/,
    )
    expect(os.homedir()).toBe(process.env['NOTIFAI_TEST_HOME'])
  })

  it('names the active Codex harness instead of unrelated installed adapters', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-codex-missing-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-current-thread',
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
      OPENCODE_CONFIG_DIR: path.join(cwd, 'opencode-home'),
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env }

    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(EXIT.ok)
    expect(hooksInstallCommand(deps, { harness: 'opencode', execPath, scriptPath })).toBe(EXIT.ok)
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    const said = io.errLines.join(' ')
    expect(said).toMatch(/Codex hooks are not installed/i)
    expect(said).toContain('notifai init --json')
    expect(said).not.toMatch(/Claude Code: send one new prompt|OpenCode: restart/)
  })

  it('refuses a recent pointer owned by another Codex thread', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-codex-mismatch-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-other-thread', env, { harness: 'codex', last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'codex-other-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/exact Codex session has not fired UserPromptSubmit/i)
    expect(io.outLines).not.toContain(
      'Question registered. Ask it in the conversation as usual and end your turn.',
    )
  })

  it('registers only when the active Codex thread owns the project pointer', () => {
    const cwd = scratchDir('notifai-active-codex-matching-')
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-current-thread', env, { harness: 'codex', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')
    writeSessionState('claude-concurrent', env, { harness: 'claude-code', last_prompt_at: 43, last_stop_at: 43 })
    writeProjectSession(cwd, env, 'claude-concurrent', 43, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(io.outLines.some((line) => line.startsWith('Question registered locally (q_'))).toBe(true)
    expect(readSessionState('codex-current-thread', env).pending?.[0]?.source).toMatchObject({
      session_id: 'codex-current-thread',
      harness: 'codex',
    })
    expect(
      readSessionState('codex-current-thread', env).pending?.[0]?.source?.session_label,
    ).toBe('Gentle Salmon')

    io.outLines = []
    expect(askCommand(deps, 'Wait?', { json: true })).toBe(EXIT.ok)
    const registered = JSON.parse(io.outLines.join('\n')) as Record<string, unknown>
    expect(registered).toMatchObject({
      registered: true,
      state: 'local',
      submitted: false,
      request_id: null,
      provider_acceptance: 'not_available',
      status: `notifai status ${registered.question_id as string}`,
      close: `notifai close ${registered.question_id as string}`,
    })
    expect(inspectQuestionState(registered.question_id as string, env)).toMatchObject({
      found: true,
      question: {
        question_id: registered.question_id,
        state: 'local',
        submitted: false,
        request_id: null,
      },
    })
  })

  it('uses exact lifecycle state across checkouts while Project stays invocation-owned', () => {
    const first = scratchDir('notifai-exact-session-first-')
    const second = scratchDir('notifai-exact-session-second-')
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(first),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-cross-checkout',
    }
    const firstDeps = { ...makeDeps(io, {} as ApiClient), cwd: first, env, now: () => 42 }
    expect(
      hooksInstallCommand(firstDeps, {
        harness: 'claude-code',
        execPath,
        scriptPath,
      }),
    ).toBe(EXIT.ok)
    writeSessionState('claude-cross-checkout', env, {
      harness: 'claude-code',
      activation_cwd: first,
      last_prompt_at: 42,
      last_stop_at: 41,
    })
    writeProjectSession(first, env, 'claude-cross-checkout', 42, 'claude-code')
    mkdirSync(path.join(second, '.notifai'), { recursive: true })
    writeFileSync(
      path.join(second, '.notifai', 'config.toml'),
      'project = "second-project"\nask_notifications = false\n',
    )
    mkdirSync(path.dirname(sessionConfigPath('claude-cross-checkout', env)), { recursive: true })
    writeFileSync(sessionConfigPath('claude-cross-checkout', env), 'ask_notifications = true\n')
    io.outLines = []

    const secondDeps = { ...firstDeps, cwd: second }
    expect(askCommand(secondDeps, 'Use this checkout?', {})).toBe(EXIT.ok)
    const pending = readSessionState('claude-cross-checkout', env).pending?.[0]
    expect(pending?.project).toBe('second-project')
    expect(pending?.source).toMatchObject({
      session_id: 'claude-cross-checkout',
      harness: 'claude-code',
    })
  })

  it('uploads ask images before registration and freezes canonical body media', async () => {
    const cwd = scratchDir('notifai-ask-media-')
    const first = path.join(cwd, 'first.png')
    const second = path.join(cwd, 'second.gif')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-media-thread',
    }
    let grant = 0
    const uploaded: string[] = []
    const client = {
      createMediaUpload: async () => {
        grant += 1
        return {
          media_id: `med_ask_${grant}`,
          upload_url: `https://upload.invalid/${grant}`,
          upload_headers: {},
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }
      },
      uploadMedia: async (value: { media_id: string }) => {
        uploaded.push(value.media_id)
      },
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-media-thread', env, { harness: 'codex', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-media-thread', 42, 'codex')
    io.outLines = []

    expect(
      await askCommand(deps, 'Which visual should I use?', {
        body: 'Compare ![first](media:1) with ![second](media:2).',
        image: [first, second],
        imageAlt: ['First option', 'Second option'],
      }),
    ).toBe(EXIT.ok)

    const pending = readSessionState('codex-media-thread', env).pending?.[0]
    expect(uploaded).toEqual(['med_ask_1', 'med_ask_2'])
    expect(pending?.body).toBe(
      'Compare ![first](media:med_ask_1) with ![second](media:med_ask_2).',
    )
    expect(pending?.media).toEqual([
      { media_id: 'med_ask_1', alt: 'First option' },
      { media_id: 'med_ask_2', alt: 'Second option' },
    ])
    expect(pending?.source).toMatchObject({
      session_id: 'codex-media-thread',
      harness: 'codex',
    })
  })

  // A harness exports its markers into everything it starts, so a nested
  // harness sees its parent's markers alongside its own. Neither order between
  // two markers can be right, and both nestings are ordinary: an orchestrator
  // running inside Claude Code starts Codex, and the reverse happens just as
  // often. The environment cannot settle it; the pointer index can.
  it('routes to the live Codex thread when a Claude Code orchestrator started it', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-under-claude-'))
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      // Inherited from the parent Claude Code process, and unstrippable.
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    // The configuration that made this unrecoverable: Claude Code hooks
    // installed machine-wide match every directory, including this one.
    expect(
      hooksInstallCommand(deps, { harness: 'claude-code', global: true, execPath, scriptPath }),
    ).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-current-thread', env, { harness: 'codex', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(readSessionState('codex-current-thread', env).pending?.[0]).toMatchObject({
      question: 'Ship it?',
      source: { session_id: 'codex-current-thread', harness: 'codex' },
    })
    expect(readSessionState('claude-orchestrator', env).pending).toBeUndefined()
  })

  it('routes to the live Claude Code session when a Codex orchestrator started it', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-under-codex-'))
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      CODEX_THREAD_ID: 'codex-orchestrator',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-current',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    // Both sessions are live here. The parent fired when its own turn began;
    // the child fired for the turn that is running this command.
    writeSessionState('codex-orchestrator', env, { harness: 'codex', last_prompt_at: 40, last_stop_at: 39 })
    writeProjectSession(cwd, env, 'codex-orchestrator', 40, 'codex')
    writeSessionState('claude-current', env, { harness: 'claude-code', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'claude-current', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(readSessionState('claude-current', env).pending?.[0]).toMatchObject({
      question: 'Ship it?',
      source: { session_id: 'claude-current', harness: 'claude-code' },
    })
    expect(readSessionState('codex-orchestrator', env).pending).toBeUndefined()
  })

  it('registers an Orca-managed Claude question without borrowing the worktree title', () => {
    const cwd = scratchDir('notifai-orca-claude-ask-')
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'orca-claude-question',
      TERM_PROGRAM: 'Orca',
      ORCA_WORKTREE_ID: `repo-123::${cwd}`,
    }
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env,
      now: () => 42,
    }

    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    writeSessionState('orca-claude-question', env, { harness: 'claude-code', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'orca-claude-question', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship the semantic resolver?', {})).toBe(EXIT.ok)
    expect(readSessionState('orca-claude-question', env).pending?.[0]?.source).toMatchObject({
      session_id: 'orca-claude-question',
      harness: 'claude-code',
    })
    expect(readSessionState('orca-claude-question', env).pending?.[0]?.source?.session_label)
      .toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  })

  it('judges the fired check against the active harness, not a global installation of another', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-fired-active-harness-'))
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    expect(
      hooksInstallCommand(deps, { harness: 'claude-code', global: true, execPath, scriptPath }),
    ).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-current-thread', env, { harness: 'codex', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')

    const readiness = await assessReadiness(deps)
    const fired = readiness.states.find((state) => state.id === 'hooks-fired')
    // The Codex hooks fired. A missing Claude Code pointer says nothing about
    // that, and telling this agent to send a Claude Code prompt is advice it
    // cannot act on: it would refuse to ask, forever.
    expect(fired?.status).toBe('ready')
    expect(fired?.detail).toMatch(/active Codex session/i)
    expect(fired?.detail).not.toMatch(/Claude Code/i)
  })

  it('advises every harness whose markers are present when none of them has fired here', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-fired-contested-'))
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    expect(
      hooksInstallCommand(deps, { harness: 'claude-code', global: true, execPath, scriptPath }),
    ).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)

    const readiness = await assessReadiness(deps)
    const fired = readiness.states.find((state) => state.id === 'hooks-fired')
    expect(fired?.status).toBe('optional-gap')
    expect(fired?.detail).toMatch(/Claude Code/)
    expect(fired?.detail).toMatch(/Codex: approve[\s\S]*start one fresh session/i)

    io.errLines = []
    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/Several harness sessions could own this shell/i)
  })

  it('makes one work-resumption commitment per offered answer part of the asking turn', () => {
    const cwd = scratchDir('notifai-ask-commitment-')
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-commitment-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-commitment-thread', env, { harness: 'codex', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-commitment-thread', 42, 'codex')
    io.outLines = []

    expect(
      askCommand(deps, 'Which environment should I deploy to?', {
        choice: ['Staging', 'Production', 'Cancel'],
      }),
    ).toBe(EXIT.ok)

    const said = io.outLines.join('\n')
    expect(said).toContain('Before ending this turn')
    for (const answer of ['Staging', 'Production', 'Cancel']) {
      expect(said).toContain(`If the answer is "${answer}"`)
    }
    expect(said).toContain('unexpected typed answer')
    expect(said).toContain('work you will resume')
    expect(said).toContain('without asking the user to confirm again')
    expect(said).toContain('not as approval')
    expect(said).toContain('cannot answer a harness permission prompt or interactive picker')
  })

  it('requires a concrete fallback for free-text answers before the turn ends', () => {
    const cwd = scratchDir('notifai-ask-free-text-')
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-free-text-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-free-text-thread', env, { harness: 'codex', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-free-text-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'What rollout adjustment should I make?', {})).toBe(EXIT.ok)
    expect(io.outLines.join('\n')).toContain(
      'For the free-text answer: state how its content will determine the concrete work you resume.',
    )
  })

  it('refuses a Codex question when the installed Stop definition is no longer trusted', async () => {
    const cwd = scratchDir('notifai-codex-stale-trust-')
    const io = new PlainInteractiveIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    const stop = findInstallations(cwd, env)
      .find((installation) => installation.harness === 'codex')
      ?.handlers.find((handler) => handler.event === 'Stop')
    expect(stop).toBeDefined()
    const configFile = path.join(env.CODEX_HOME!, 'config.toml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace(codexHookIdentityHash(stop!), 'sha256:obsolete'),
    )
    writeSessionState('codex-current-thread', env, { harness: 'codex', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/Stop.*changed since it was trusted.*\/hooks/is)

    io.outLines = []
    await doctorCommand(deps, {})
    expect(io.outLines.join('\n')).toMatch(/FAIL\s+Codex hook trust.*Stop/is)
    expect(io.outLines.join('\n')).toMatch(/best-effort.*never writes.*\/hooks/is)
    const readiness = await assessReadiness(deps)
    expect(readiness.states.find((state) => state.id === 'hooks-trust')?.remedy).toMatchObject({
      command: '/hooks',
      user_action: {
        code: 'codex_hook_approval_required',
        harness: 'codex',
        action: 'approve_or_enable_notifai_hooks',
        message: expect.stringContaining('Open `/hooks` in Codex'),
      },
    })
  })

  it('gives doctor the same active-Codex diagnosis as ask', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-codex-doctor-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-current-thread',
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
    }
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      remove: async () => 0,
      list: async (scope) => ({
        skills:
          scope === 'global'
            ? [
                {
                  name: 'notifai',
                  scope,
                  path: path.join(cwd, 'global-skills', 'notifai'),
                  source: 'Raidiant-io/notifai',
                  sourceType: 'github',
                  sourceUrl: 'https://github.com/Raidiant-io/notifai.git',
                  ref: RELEASE_REF,
                },
              ]
            : [],
      }),
    }
    installCurrentSkill(path.join(cwd, 'global-skills', 'notifai'))
    const deps = { ...makeDeps(io, client), cwd, env, nativeSkills }

    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(EXIT.ok)
    io.outLines = []

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    const said = io.outLines.join(' ')
    expect(said).toContain(
      `installed in the global scope and verified against the guidance shipped with CLI ${CLI_VERSION}`,
    )
    expect(said).toMatch(/active Codex/i)
    expect(said).toContain('notifai hooks install --harness codex')
  })

  it('refuses a Claude Code pointer owned by another live session', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-claude-mismatch-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-current',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    writeSessionState('claude-other', env, { harness: 'claude-code', last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'claude-other', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/exact Claude Code session has not fired UserPromptSubmit/i)
  })

  it('accepts a Claude Code subprocess when its documented session id owns the pointer', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-claude-child-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-parent-loop',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    writeSessionState('claude-parent-loop', env, { harness: 'claude-code', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'claude-parent-loop', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(readSessionState('claude-parent-loop', env).pending?.[0]?.question).toBe('Ship it?')
  })

  it('fails closed when Claude Code does not expose an exact session id', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-claude-no-id-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
      CLAUDECODE: '1',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    writeSessionState('claude-last-writer', env, { harness: 'claude-code', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'claude-last-writer', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/does not expose an exact session id/i)
    expect(readSessionState('claude-last-writer', env).pending).toBeUndefined()
  })

  it('rejects duplicate active Codex definitions before registration', () => {
    const cwd = scratchDir('notifai-active-codex-duplicate-')
    const io = new CapturedIo()
    const env = {
      HOME: path.join(cwd, 'home'),
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    mkdirSync(env.CODEX_HOME!, { recursive: true })
    applyPlan(path.join(env.CODEX_HOME!, 'config.toml'), {
      hooks: buildHookConfig({
        adapterPath: hookAdapterPath(deps.hookAdapterHome),
        harness: 'codex',
      }),
    })
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-current-thread', env, { harness: 'codex', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/2 Codex definitions are active/i)
    expect(readSessionState('codex-current-thread', env).pending).toBeUndefined()
  })

  it('does not let UserPromptSubmit alone count as a working turn-end route', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-prompt-only-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-current',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    writeSessionState('claude-current', env, { harness: 'claude-code', last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'claude-current', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/Stop hook has not been observed/)

    const readiness = await assessReadiness(deps)
    const fired = readiness.states.find((state) => state.id === 'hooks-fired')
    // Reported, never a blocker: the only thing that closes this is a turn
    // ending, which the agent standing inside that turn cannot supply.
    expect(fired?.status).toBe('optional-gap')
    expect(fired?.detail).toMatch(/UserPromptSubmit.*Stop has not been observed/)
    expect(firstRequiredBlocker(readiness)?.id).not.toBe('hooks-fired')
  })

  it('uses the OpenCode adapter marker instead of its config-directory variable', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-opencode-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      OPENCODE_CONFIG_DIR: path.join(cwd, 'opencode-home'),
      NOTIFAI_ACTIVE_HARNESS: 'opencode',
      NOTIFAI_ACTIVE_SESSION_ID: 'opencode-current',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'opencode', execPath, scriptPath })).toBe(EXIT.ok)
    writeSessionState('opencode-other', env, { harness: 'opencode', last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'opencode-other', 42, 'opencode')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/no proven answer continuation/i)
  })

  it('rejects OpenCode before registration even with an exact matching pointer', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-opencode-unsupported-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      OPENCODE_CONFIG_DIR: path.join(cwd, 'opencode-home'),
      NOTIFAI_ACTIVE_HARNESS: 'opencode',
      NOTIFAI_ACTIVE_SESSION_ID: 'opencode-current',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'opencode', execPath, scriptPath })).toBe(EXIT.ok)
    writeSessionState('opencode-current', env, { harness: 'opencode', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'opencode-current', 42, 'opencode')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/no proven answer continuation/i)
    expect(readSessionState('opencode-current', env).pending).toBeUndefined()
  })

  it('rejects OpenClaw before registration even with an exact matching pointer', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-openclaw-unsupported-'))
    const io = new CapturedIo()
    const env = {
      HOME: path.join(cwd, 'home'),
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      OPENCLAW_STATE_DIR: path.join(cwd, 'openclaw-home'),
      NOTIFAI_ACTIVE_HARNESS: 'openclaw',
      NOTIFAI_ACTIVE_SESSION_ID: 'agent:main:main',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'openclaw', execPath, scriptPath })).toBe(EXIT.ok)
    writeSessionState('agent:main:main', env, { harness: 'openclaw', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'agent:main:main', 42, 'openclaw')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/no proven answer continuation/i)
    expect(readSessionState('agent:main:main', env).pending).toBeUndefined()
  })

  it('refuses Hermes ask as unsupported rather than as missing hooks', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-ask-unsupported-'))
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      HERMES_SESSION_ID: '20260828_111302_29a404',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }

    expect(askCommand(deps, 'Ship it?', { json: true })).toBe(EXIT.usage)
    const payload = JSON.parse(io.outLines.join('\n')) as { code: string; message: string; remedy: string }
    expect(payload.code).toBe('question_routing_unavailable')
    expect(payload.message).toMatch(/no proven continuation owner/i)
    expect(payload.message).not.toMatch(/hooks are not installed/i)
    expect(payload.remedy).toMatch(/send --reply/)
    expect(hooksInstallCommand(deps, { harness: 'hermes', execPath, scriptPath })).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/Unknown harness "hermes"/)
  })

  it('fails closed when Hermes nested markers leave session ownership ambiguous', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-nested-ask-'))
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
      HERMES_SESSION_ID: '20260828_111302_29a404',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(EXIT.ok)
    writeSessionState('claude-orchestrator', env, {
      harness: 'claude-code',
      last_prompt_at: 42,
      last_stop_at: 41,
    })
    writeProjectSession(cwd, env, 'claude-orchestrator', 42, 'claude-code')
    io.outLines = []
    io.errLines = []

    expect(askCommand(deps, 'Ship it?', { json: true })).toBe(EXIT.usage)
    const payload = JSON.parse(io.outLines.join('\n')) as { code: string; message: string }
    expect(payload.code).toBe('session_identity_ambiguous')
    expect(payload.message).toMatch(/Several harness sessions could own this shell/i)
    expect(payload.message).toMatch(/Hermes/)
    expect(readSessionState('claude-orchestrator', env).pending).toBeUndefined()
  })

  it('does not attribute doctor readiness when Hermes nested markers are ambiguous', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-nested-doctor-'))
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
      HERMES_SESSION_ID: '20260828_111302_29a404',
    }
    const readiness = await assessReadiness({
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env,
      now: () => 42,
    })
    const hooks = readiness.states.find((state) => state.id === 'hooks')
    expect(hooks?.status).toBe('optional-gap')
    expect(hooks?.detail).toMatch(/Several harness sessions could own this shell/i)
    expect(hooks?.detail).toMatch(/Claude Code, Hermes/)
    expect(hooks?.remedy).toBeUndefined()
    expect(JSON.stringify(hooks)).not.toContain('hooks install --harness claude-code')
  })

  it('does not tell an active Hermes session to install managed hooks', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-doctor-'))
    const io = new CapturedIo()
    const env = {
      ...isolatedEnv(cwd),
      HERMES_SESSION_ID: '20260828_111302_29a404',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    const readiness = await assessReadiness(deps)
    const hooks = readiness.states.find((state) => state.id === 'hooks')
    expect(hooks?.status).toBe('optional-gap')
    expect(hooks?.remedy).toBeUndefined()
    expect(JSON.stringify(hooks)).not.toContain('hooks install --harness hermes')
    expect(hooks?.detail).toMatch(/no proven continuation owner/i)
  })

  it('refuses Cursor when its active-agent marker has no exact conversation id', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-cursor-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CURSOR_AGENT: '1',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath })).toBe(EXIT.ok)
    writeSessionState('cursor-live', env, { harness: 'cursor', last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'cursor-live', 42, 'cursor')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/does not expose an exact session id/i)
    expect(readSessionState('cursor-live', env).pending).toBeUndefined()
  })

  it('fails doctor when another harness looks healthy but the active Claude Code session does not', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-claude-doctor-'))
    const io = new PlainInteractiveIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-current',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    writeSessionState('codex-live', env, { harness: 'codex', last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'codex-live', 42, 'codex')
    io.outLines = []

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toMatch(/FAIL\s+Routing for this harness.*active Claude Code/is)
  })

  it('treats an unfired pointer as informational, with a prompt as the remedy', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-unfired-pointer-'))
    const io = new CapturedIo()
    const env = {
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_STATE_HOME: path.join(cwd, 'state'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-home'),
      HOME: path.join(cwd, 'home'),
      CODEX_HOME: path.join(cwd, 'codex-home'),
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-current',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    // Hooks installed seconds ago, nothing has fired: the exact state a
    // fresh-project agent `init` runs from. Neither pointer state may block
    // the walk, and neither may prescribe a reinstall.
    const readiness = await assessReadiness(deps)

    const pointer = readiness.states.find((s) => s.id === 'hooks-active-session')
    expect(pointer?.status).toBe('optional-gap')
    expect(pointer?.detail).toMatch(/has not published exact lifecycle state/)
    expect(pointer?.remedy?.summary).toMatch(/send one Claude Code prompt/)
    expect(pointer?.remedy?.by === 'user-here' ? pointer.remedy.command : '').toBe(
      'notifai doctor',
    )

    const fired = readiness.states.find((s) => s.id === 'hooks-fired')
    expect(fired?.status).toBe('optional-gap')
    expect(fired?.remedy?.summary).not.toMatch(/hooks install/)
  })

  it('shows resolved question-routing values with their winning config sources', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-routing-config-'))
    const env = { XDG_CONFIG_HOME: path.join(cwd, 'xdg') }
    const localFile = personalProjectConfigPath(cwd, env)
    mkdirSync(path.dirname(localFile), { recursive: true })
    writeFileSync(localFile, 'ask_notifications = false\nask_grace_seconds = 90\n')
    const io = new PlainInteractiveIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env }

    await doctorCommand(deps, {})

    const said = io.outLines.join('\n')
    expect(said).toContain('Question routing settings:')
    expect(said).toContain('ask_notifications=false (project-local:')
    expect(said).toContain('ask_grace_seconds=90 (project-local:')
    // Nothing about where the user is standing is listed, because nothing
    // about where they are standing decides anything any more.
    expect(said).not.toMatch(/require_idle|away_after_seconds|hook_reply_timeout_seconds/)
  })

  it('keeps a freshly installed Stop definition valid when timing preferences change', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-timeout-drift-'))
    const io = new PlainInteractiveIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    mkdirSync(path.join(cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(cwd, '.notifai', 'config.local.toml'), 'ask_grace_seconds = 300\n')
    io.outLines = []

    await doctorCommand(deps, {})
    expect(io.outLines.join('\n')).toMatch(/ok\s+Turn\-end hook shape/)
  })

  it('diagnoses an older hook install that lacks proactive lifecycle handlers', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-missing-lifecycle-'))
    const io = new PlainInteractiveIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    const settingsPath = path.join(cwd, '.claude', 'settings.local.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown>
    }
    delete settings.hooks.SessionStart
    delete settings.hooks.SubagentStart
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)

    const readiness = await assessReadiness(deps)
    const current = readiness.states.find((state) => state.id === 'hooks-stale')
    expect(current?.status).toBe('gap')
    expect(current?.detail).toMatch(/missing session-start, subagent-start/i)
    expect(current?.detail).toMatch(/notifai hooks install/i)
  })

  it('names an old blocking Claude Stop handler as the reason no wake can happen', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-stale-shape-'))
    const io = new PlainInteractiveIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    // Exactly what every build before the asynchronous waiter wrote: a blocking
    // handler with the old ceiling. It looks installed and it fires, but the
    // waiter would hold the turn and then be killed at Claude's silent default.
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    applyPlan(path.join(cwd, '.claude', 'settings.local.json'), {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `'${path.join(cwd, 'home', '.notifai', 'bin', 'hook-adapter')}' hook stop --owner notifai --harness claude-code`,
                timeout: 540,
              },
            ],
          },
        ],
      },
    })

    await doctorCommand(deps, {})
    const out = io.outLines.join('\n')
    expect(out).toMatch(/FAIL\s+Turn\-end hook shape/)
    expect(out).toContain('needs `async: true`')
    expect(out).toContain('kills the backgrounded waiter silently before the complete answer window')
    expect(out).toContain(`needs an explicit ${QUESTION_STOP_TIMEOUT_SECONDS}s`)
  })

  /** A configured Claude Code project with one live session claiming `pid`. */
  function claudeWakeDeps(
    io: CapturedIo,
    descriptor: (pid: number) => unknown,
  ): { deps: CommandDeps; cwd: string } {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-wake-'))
    const base = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { ...isolatedEnv(cwd), CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-live' },
      claudeSourcePid: 4242,
      claudeWake: { readDescriptor: descriptor } as unknown as ClaudeWakeAdapters,
    }
    expect(hooksInstallCommand(base, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    io.outLines = []
    return { deps: base, cwd }
  }

  it('reports a live Claude session as reachable without connecting to its socket', async () => {
    const io = new PlainInteractiveIo()
    const socket = path.join(mkdtempSync(path.join(os.tmpdir(), 'cc-socks-')), '4242.sock')
    writeFileSync(socket, '')
    const { deps } = claudeWakeDeps(io, (pid) => ({
      pid,
      sessionId: 'sess-live',
      cwd: '/tmp',
      startedAt: 1,
      procStart: 'x',
      version: '2.1.228',
      peerProtocol: 1,
      messagingSocketPath: socket,
      status: 'idle',
    }))

    await doctorCommand(deps, {})
    const out = io.outLines.join('\n')
    expect(out).toMatch(/ok\s+Direct wake route/)
    expect(out).toContain(socket)
    expect(out).toContain('an answer can start a turn here without you')
    // Doctor never widens the user's inbound policy to make Notifai work: the
    // poster is the session's own hook child and needs no such permission.
    expect(out).not.toContain('crossSessionInbound')
  })

  it('names a --bare session as the reason an answer would wait for the next turn', async () => {
    const io = new PlainInteractiveIo()
    const { deps } = claudeWakeDeps(io, () => {
      throw new Error('ENOENT: no such file or directory')
    })

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed) // unreachable test server
    const out = io.outLines.join('\n')
    // Honest, and not a blocker: nothing is lost, it simply arrives later.
    expect(out).toMatch(/--\s+Direct wake route/)
    expect(out).toContain('`--bare` binds no inbox socket')
    expect(out).toContain("at this session's next turn")
    expect(out).not.toMatch(/FAIL\s+Direct wake route/)
  })

  it('fails closed on an inbox protocol it does not recognise', async () => {
    const io = new CapturedIo()
    const socket = path.join(mkdtempSync(path.join(os.tmpdir(), 'cc-socks-')), '4242.sock')
    writeFileSync(socket, '')
    const { deps } = claudeWakeDeps(io, (pid) => ({
      pid,
      sessionId: 'sess-live',
      cwd: '/tmp',
      startedAt: 1,
      procStart: 'x',
      version: '2.1.228',
      peerProtocol: 7,
      messagingSocketPath: socket,
      status: 'idle',
    }))

    await doctorCommand(deps, {})
    const out = io.outLines.join('\n')
    expect(out).toContain('speaks inbox protocol 7')
    expect(out).toContain('refusing to guess at an undocumented wire format')
  })

  it('reports Codex resume readiness from its writer-lock directory alone', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-codex-wake-'))
    const io = new PlainInteractiveIo()
    const env = {
      ...isolatedEnv(cwd),
      CODEX_THREAD_ID: '9f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8',
    }
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env,
      hookPlatform: 'darwin' as NodeJS.Platform,
    }
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)

    io.outLines = []
    await doctorCommand(deps, {})
    expect(io.outLines.join('\n')).toContain('nothing can be resumed: no thread-writer-lock')

    mkdirSync(path.join(env['CODEX_HOME']!, 'thread-writer-locks'), { recursive: true })
    io.outLines = []
    await doctorCommand(deps, {})
    const out = io.outLines.join('\n')
    expect(out).toMatch(/ok\s+Direct wake route/)
    expect(out).toContain('can prove a stopped thread unowned before resuming it')
  })

  it('documents the failing exit contract in doctor JSON', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-exit-json-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: {} }

    expect(await doctorCommand(deps, { json: true })).toBe(EXIT.failed)
    const payload = JSON.parse(io.outLines[0] ?? '{}') as { ok?: boolean; exit_code?: number }
    expect(payload).toMatchObject({ ok: false, exit_code: EXIT.failed })
  })

  it('returns a stable exact-session failure when lifecycle context is absent', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-firstrun-'))
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    applyPlan(path.join(cwd, '.claude', 'settings.local.json'), {
      hooks: buildHookConfig({
        adapterPath: path.join(cwd, 'notifai', 'hook-adapter'),
      }),
    })

    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: { XDG_STATE_HOME: cwd } }

    expect(askCommand(deps, 'Ship it?', { json: true })).toBe(EXIT.usage)
    expect(JSON.parse(io.outLines.at(-1) ?? '{}')).toMatchObject({
      ok: false,
      registered: false,
      code: 'session_identity_missing',
      check_id: 'exact_session',
      exit_code: EXIT.usage,
      remedy: expect.stringMatching(/exact session|blocking/i),
    })
  })

  it('does not guess a Cursor conversation when lifecycle context is absent', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-first-run-'))
    const io = new CapturedIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath })).toBe(EXIT.ok)
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', { json: true })).toBe(EXIT.usage)
    expect(JSON.parse(io.outLines.at(-1) ?? '{}')).toMatchObject({
      code: 'session_identity_missing',
      check_id: 'exact_session',
    })
  })

  it('does not infer OpenCode from an installed adapter alone', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-first-run-'))
    const io = new CapturedIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: {
        XDG_STATE_HOME: path.join(cwd, 'state'),
        OPENCODE_CONFIG_DIR: path.join(cwd, 'opencode-home'),
      },
    }

    expect(hooksInstallCommand(deps, { harness: 'opencode', execPath, scriptPath })).toBe(EXIT.ok)
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', { json: true })).toBe(EXIT.usage)
    expect(JSON.parse(io.outLines.at(-1) ?? '{}')).toMatchObject({
      code: 'session_identity_missing',
      check_id: 'exact_session',
    })
  })

  it('does not turn missing harness identity into an installation guess', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-noinstall-'))
    const io = new CapturedIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: {
        HOME: path.join(cwd, 'home'),
        XDG_STATE_HOME: cwd,
        CODEX_HOME: path.join(cwd, 'none'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'none'),
        OPENCODE_CONFIG_DIR: path.join(cwd, 'none'),
      },
    }

    expect(askCommand(deps, 'Ship it?', { json: true })).toBe(EXIT.usage)
    expect(JSON.parse(io.outLines.at(-1) ?? '{}')).toMatchObject({
      code: 'session_identity_missing',
      check_id: 'exact_session',
    })
  })
})

/**
 * A CLI newer than its server produced "hook failed, deferring to
 * the terminal", which reads like a flaky network, while escalation was in
 * fact completely broken in production.
 */
describe('a server behind this CLI', () => {
  it('names the field the server rejected instead of swallowing it', () => {
    const rejection = new ApiCallError(422, 'unsupported_field', 'The draft was not accepted.', null, [
      { code: 'unsupported_field', path: '/lifecycle', message: 'Unknown property.' },
    ])

    const said = describeHookFailure(rejection).join(' ')

    expect(said).toContain('/lifecycle')
    expect(said).toContain('unsupported_field')
    // And says which way round the mismatch is, which is the whole diagnosis.
    expect(said).toMatch(/server is older than this CLI/)
  })

  it('still reports a plain failure for anything that is not a rejection', () => {
    const said = describeHookFailure(new Error('socket hang up')).join(' ')
    expect(said).toContain('socket hang up')
    expect(said).not.toMatch(/older than this CLI/)
  })

  it('keeps baseline sends available while an older server lacks compatibility metadata', async () => {
    const io = new PlainInteractiveIo()
    let submissions = 0
    const client = {
      health: async () => true,
      compatibility: async () => {
        throw new ApiCallError(404, 'not_found', 'Compatibility metadata is unavailable.')
      },
      listDevices: async () => ({ devices: [] }),
      accessStatus: async () => ({ email: 'user@example.test' }),
      submit: async () => {
        submissions += 1
        return receipt
      },
    } as unknown as ApiClient
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skew-'))
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd },
    } as CommandDeps

    await doctorCommand(deps, {})

    const said = io.outLines.concat(io.errLines).join(' ')
    expect(said).toMatch(/service is being updated/)
    expect(said).not.toContain('notifai update')
    expect(said).not.toMatch(/Protocol version|schema v/i)

    const sendIo = new CapturedIo()
    expect(
      await sendCommand(makeDeps(sendIo, client), {
        kind: 'update',
        title: 'Build finished',
        body: 'All checks passed.',
      }),
    ).toBe(EXIT.ok)
    expect(submissions).toBe(1)
    expect(sendIo.errLines).toEqual([])
  })

  it('doctor is quiet when both sides agree', async () => {
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-noskew-'))
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test store' },
    } as CommandDeps

    await doctorCommand(deps, {})

    expect(io.outLines.concat(io.errLines).join(' ')).not.toMatch(/needs deploying|update the CLI/)
  })
})

/**
 * The same class of failure through the command path. A rejected `send` printed
 * only "invalid_request: The draft was not accepted." while the server's
 * details — naming the exact offending field — went to the local log alone.
 * stderr is the one line an agent's next turn actually reads, so the diagnosis
 * has to be on it. Direction-neutral on purpose: the mismatch has been seen
 * with the server behind the CLI and with the CLI behind the server.
 */
describe('command failures carrying server details', () => {
  const throwingClient = (status: number, details: unknown = null): ApiClient =>
    ({
      submit: async () => {
        throw new ApiCallError(status, 'invalid_request', 'The draft was not accepted.', null, details)
      },
    }) as unknown as ApiClient

  it('names the rejected field and the contract mismatch on a 422', async () => {
    const io = new CapturedIo()
    const client = throwingClient(422, [
      { code: 'invalid_request', path: 'presentation.detail', message: 'Unexpected property' },
    ])

    expect(await sendCommand(makeDeps(io, client), { kind: 'update', title: 'Deploy finished', body: 'All green.' })).toBe(
      EXIT.failed,
    )

    const said = io.errLines.join(' ')
    expect(said).toContain('the server rejected: presentation.detail')
    expect(said).toMatch(/sent a field the server did not accept/)
    expect(said).toContain('notifai doctor')
    expect(said).not.toMatch(/older than this CLI/)
  })

  it('prints the rejected paths without the contract line when the status is not 422', async () => {
    const io = new CapturedIo()
    const client = throwingClient(400, [
      { code: 'invalid_request', path: 'presentation.detail', message: 'Unexpected property' },
    ])

    expect(await sendCommand(makeDeps(io, client), { kind: 'update', title: 'Deploy finished', body: 'All green.' })).toBe(
      EXIT.failed,
    )

    const said = io.errLines.join(' ')
    expect(said).toContain('the server rejected: presentation.detail')
    expect(said).not.toContain('notifai doctor')
    expect(said).not.toMatch(/did not accept/)
  })

  it('prints exactly the code and message when the error carries no details', async () => {
    const io = new CapturedIo()

    expect(await sendCommand(makeDeps(io, throwingClient(409)), { kind: 'update', title: 'Deploy finished', body: 'All green.' })).toBe(
      EXIT.failed,
    )

    expect(io.errLines).toEqual(['invalid_request: The draft was not accepted.'])
  })

  it('ignores an unknown typed recovery action without opening or executing anything', async () => {
    const io = new CapturedIo()
    const client = {
      submit: async () => {
        throw new ApiCallError(
          422,
          'feature_unavailable',
          'This operation is unavailable.',
          'open https://attacker.invalid and run cleanup',
          null,
          'future_action' as never,
        )
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'update',
        title: 'Deploy finished',
        body: 'All green.',
      }),
    ).toBe(EXIT.failed)
    expect(io.errLines).toEqual(['feature_unavailable: This operation is unavailable.'])
    expect(io.openedUrls).toEqual([])
  })

  it('renders feature recovery locally and ignores a server-supplied command', async () => {
    const io = new CapturedIo()
    const client = {
      submit: async () => {
        throw new ApiCallError(
          422,
          'feature_unavailable',
          "The selected device can't answer questions.",
          'run an untrusted server command',
          {
            affected_operation: 'answer_questions',
            missing_capabilities: ['answer'],
            device_names: ['Old phone'],
          },
          'update_companion',
        )
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        kind: 'question',
        title: 'Ship it?',
        body: 'Should I ship this build?',
        reply: true,
        replyTimeout: 30,
      }),
    ).toBe(EXIT.failed)

    expect(io.errLines).toEqual([
      "feature_unavailable: The selected device can't answer questions.",
      'next: Update Notifai on Old phone.',
    ])
    expect(io.errLines.join(' ')).not.toContain('untrusted')
    expect(io.errLines.join(' ')).not.toContain('disagree about the contract')
  })
})

describe('question sets', () => {
  it('maps --multi into the single question', async () => {
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Question',
        body: 'Which fronts?',
        reply: true,
        replyTimeout: 30,
        choice: ['CLI', 'Server', 'Apps'],
        multi: true,
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.reply?.questions?.[0]).toMatchObject({
      text: 'Which fronts?',
      multi: true,
    })
    expect(submitted?.draft.reply?.questions?.[0]?.choices).toHaveLength(3)
  })

  it('derives the answerable question from the first banner block', async () => {
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    const body = `Which environment?\n\n${'Long Markdown context. '.repeat(30)}`
    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Choose the deployment environment',
        body,
        reply: true,
        replyTimeout: 30,
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.presentation.body).toBe(body)
    expect(submitted?.draft.reply?.questions[0]?.text).toBe('Which environment?')
  })

  it('keeps the question out of a body that carries context', () => {
    // The question already travels as the title and as structured questions;
    // repeating it in the body showed it twice on the lock screen and the
    // reply screen.
    expect(
      buildQuestions(
        { body: '## Why\nThe release window closes today.' },
        'Which environment?',
      ),
    ).toMatchObject({
      ok: true,
      body: '## Why\nThe release window closes today.',
      questions: [{ text: 'Which environment?' }],
    })
  })

  it('lets the question stand in for the body only when there is no context', () => {
    expect(buildQuestions({}, 'Which environment?')).toMatchObject({
      ok: true,
      body: 'Which environment?',
    })
    expect(
      buildQuestions(
        { form: JSON.stringify({ questions: [{ text: 'Deploy where?' }, { text: 'What should I monitor?' }] }) },
        undefined,
      ),
    ).toMatchObject({
      ok: true,
      body: '1. Deploy where?\n2. What should I monitor?',
    })
  })

  it('keeps form questions out of a body that carries form context', () => {
    expect(
      buildQuestions(
        {
          form: JSON.stringify({
            questions: [{ text: 'Deploy where?' }, { text: 'What should I monitor?' }],
            body: '## Context\nTraffic is elevated.',
          }),
        },
        undefined,
      ),
    ).toMatchObject({
      ok: true,
      body: '## Context\nTraffic is elevated.',
    })
  })

  it('rejects the deleted form detail key instead of treating it as context', () => {
    expect(
      buildQuestions(
        {
          form: JSON.stringify({
            questions: [{ text: 'Deploy?' }],
            detail: 'legacy context',
          }),
        },
        undefined,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown --form key: detail'),
    })
  })

  it('generates unique question ids when texts collide', () => {
    const built = buildQuestions(
      {
        form: JSON.stringify({
          questions: [{ text: 'Ready?' }, { text: 'Ready?' }],
        }),
      },
      undefined,
    )
    expect(built).toMatchObject({ ok: true })
    if (built.ok) {
      expect(built.questions.map((question) => question.id)).toEqual(['ready', 'q2'])
    }
  })

  it('reports a registration as data, with the ids an agent must branch on', () => {
    // The prose block is the densest guidance this CLI prints, but a choice id
    // cannot be read back out of prose.
    const built = buildQuestions(
      { choice: ['Deploy now', 'Hold'] },
      'Deploy migration 0007 to production?',
    )
    if (!built.ok) throw new Error(built.error)
    expect(built.questions[0]?.choices?.map((choice) => choice.id)).toEqual(['deploy-now', 'hold'])
  })

  it('rejects forms outside the documented shape', () => {
    expect(buildQuestions({ form: 'not json' }, undefined)).toMatchObject({ ok: false })
    expect(
      buildQuestions({ form: JSON.stringify({ questions: [] }) }, undefined),
    ).toMatchObject({ ok: false })
    expect(
      buildQuestions(
        {
          form: JSON.stringify({
            questions: Array.from({ length: REPLY_MAX_QUESTIONS + 1 }, (_, i) => ({ text: `Q${i}?` })),
          }),
        },
        undefined,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining(`1-${REPLY_MAX_QUESTIONS}`) })
    expect(
      buildQuestions(
        { form: JSON.stringify({ questions: [{ text: 'Pick?', multi: true }] }) },
        undefined,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('--choice') })
    // --form replaces the flag surface; mixing them is a usage error.
    expect(
      buildQuestions({ form: JSON.stringify({ questions: [{ text: 'Q?' }] }) }, 'Also a question?'),
    ).toMatchObject({ ok: false })
  })
})

/** Latest-reply-wins, and never silently: a correction is named as one. */
describe('a second device that disagrees', () => {
  function view(overrides: Partial<ReplyView>): ReplyView {
    return {
      reply_id: 'rpl',
      seq: 1,
      delivery_id: 'del',
      device_id: 'dev',
      device_name: 'iPhone',
      text: 'Yes',
      answers: [],
      source: null,
      created_at: new Date().toISOString(),
      ...overrides,
    }
  }

  it('says the latest answer counted and which were superseded', () => {
    const said = contradictingAnswer([
      view({ seq: 1, device_name: 'iPhone', text: 'Yes' }),
      view({ seq: 2, device_name: 'FurankuMac', text: 'No' }),
    ])
    expect(said).toContain('"No" from FurankuMac')
    expect(said).toContain('iPhone')
    expect(said).toMatch(/corrects an earlier one/)
  })

  it('is silent when the second answer agrees', () => {
    expect(
      contradictingAnswer([
        view({ seq: 1, device_name: 'iPhone', text: 'Ship it', answers: [{ question_id: 'q1', choice_ids: ['ship'], text: null }] }),
        view({ seq: 2, device_name: 'FurankuMac', text: 'Ship it', answers: [{ question_id: 'q1', choice_ids: ['ship'], text: null }] }),
      ]),
    ).toBeNull()
  })

  it('is silent for a single answer', () => {
    expect(contradictingAnswer([view({})])).toBeNull()
    expect(contradictingAnswer([])).toBeNull()
  })
})

describe('Agent Session rename command', () => {
  it('renames only the exact active Agent Session and updates its local frozen label', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-session-rename-'))
    const io = new CapturedIo()
    const seen: { session_id: string; label: string }[] = []
    const client = {
      putAgentSessionLabel: async (body: { session_id: string; label: string }) => {
        seen.push(body)
        return {
          ...body,
          renamed_by: 'agent' as const,
          updated_at: '2026-08-28T10:00:00.000Z',
        }
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_THREAD_ID: '01a04789-9589-76b2-82c8-bfe63062c867',
      },
    }

    expect(await agentSessionRenameCommand(deps, '  Hermes   Runtime Support  ')).toBe(EXIT.ok)
    expect(seen).toEqual([{
      session_id: '01a04789-9589-76b2-82c8-bfe63062c867',
      label: 'Hermes Runtime Support',
    }])
    expect(io.outLines.join('\n')).toContain('Hermes Runtime Support')
  })

  it('fails closed when the harness does not expose an exact current Agent Session', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-session-rename-none-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(await agentSessionRenameCommand(deps, 'A new job')).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/exact active Agent Session/i)
  })
})
