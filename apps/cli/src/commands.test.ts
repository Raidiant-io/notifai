import { createLogger, readLogRecords } from './logging.js'
import type {
CompatibilityResponse,
EvidenceSnapshot,
ListRepliesResponse,
Platform,
ReplyView,
SubmissionReceipt,
SubmitNotificationRequestT,
SupportAssessment
} from '@raidiant/notifai-protocol'
import {
CAPABILITIES_V1,
PLATFORMS
} from '@raidiant/notifai-protocol'
import { execFileSync } from 'node:child_process'
import {
existsSync,
symlinkSync,
mkdirSync,
mkdtempSync,
readFileSync,
rmSync,
writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { encodeFrame,ensurePrivateDirectory,FrameDecoder,hubRunDir,hubSocketPath } from './hub-ipc.js'
import { resetPublishedCliDistTagsForTest } from './cli-release.js'
import { ApiCallError,NetworkError,type ApiClient } from './client.js'
import { guidanceSessionNeedsToken } from './command-guidance.js'
import { PROGRAM_RECEIPT } from './commands-ask-wait.js'
import type { AskFlags } from './commands-ask.js'
import { MISSING_TITLE_NOTE } from './commands-ask.js'
import { defaultMachineName } from './commands-auth.js'
import { deviceInstallRemedy,deviceRelayMessage } from './commands-devices.js'
import { guidanceCheckCommand,guidanceShowCommand as readCurrentGuidance } from './commands-guidance.js'
import {
EXIT,
askCommand as askAuthoredCommand,
assessReadiness,
contradictingAnswer,
doctorCommand,
hooksInstallCommand,
initCommand,
sendCommand as sendAuthoredCommand,
updateCliCommand,
type CommandDeps,
type CommandIo
} from './commands.js'
import {
personalProjectConfigPath,
updateProjectFolder,
stateDir
} from './config.js'
import { settleBeforeExit } from './exit-work.js'
import { writeProjectSession } from './hook-project-sessions.js'
import { inspectQuestionState } from './hook-question-state.js'
import { readSessionState,updateSessionState,writeSessionState } from './hook-session-state.js'
import {
codexHookIdentityHash,
codexStopDefinitionFingerprint,
codexTrustKey,
findInstallations,
settingsFile
} from './install-hooks.js'
import { opencodePluginSource } from './opencode-plugin.js'
import { disableProject,projectBinding,projectEnablementState } from './project-enablement.js'
import { terminalQr } from './pairing-qr.js'
import { readinessJson } from './readiness.js'
import { relayMessage } from './relay-message.js'
import { COMPANION_INSTALL_URLS } from './setup-destinations.js'
import type { SendFlags } from './send.js'
import { reopenLine,reopenReport } from './session-reopen.js'


afterEach(() => {
  resetPublishedCliDistTagsForTest()
})

/** Keep unrelated command cases focused while exercising the current authored shape. */
/** Image bytes local uploads accept: the type's own header, then distinct content. */
function fakeImage(type: 'png' | 'gif', content: string): Buffer {
  const header = type === 'png' ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : Buffer.from('GIF89a')
  return Buffer.concat([header, Buffer.from(content)])
}

function sendCommand(
  deps: CommandDeps,
  flags: Omit<SendFlags, 'summary'> & {
    summary?: string
    json?: boolean
    deliveryTimeout?: number
    replyTimeout?: number
    idempotencyKey?: string
    retry?: boolean
    baseUrl?: string
  },
) {
  let token = flags.guidanceToken
  if (token === undefined && guidanceSessionNeedsToken(deps)) {
    guidanceCheckCommand({ ...deps, io: { ...deps.io, out: line => { token = (JSON.parse(line) as { token?: string }).token } } })
  }
  void readCurrentGuidance({ ...deps, io: { ...deps.io, out: () => undefined } }, { ...(token === undefined ? {} : { sessionToken: token }) })
  return sendAuthoredCommand(deps, {
    summary: flags.summary ?? flags.body ?? flags.title,
    ...flags,
    ...(token === undefined ? {} : { guidanceToken: token }),
  })
}

function askCommand(
  deps: CommandDeps,
  question: string | undefined,
  flags: AskFlags,
) {
  let token = flags.guidanceToken
  if (token === undefined && guidanceSessionNeedsToken(deps)) {
    guidanceCheckCommand({ ...deps, io: { ...deps.io, out: line => { token = (JSON.parse(line) as { token?: string }).token } } })
  }
  void readCurrentGuidance({ ...deps, io: { ...deps.io, out: () => undefined } }, { ...(token === undefined ? {} : { sessionToken: token }) })
  return askAuthoredCommand({ spawnQuestionSettlement: () => undefined, ...deps }, question, { ...flags, ...(token === undefined ? {} : { guidanceToken: token }) })
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
  server_capabilities: ['answer', 'agent_acknowledgement', 'session_attendance'],
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
  const installations = findInstallations(env).filter(
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

function writeCurrentCodexSessionState(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
  state: Parameters<typeof writeSessionState>[2],
): void {
  const fingerprint = codexStopDefinitionFingerprint(findInstallations(env))
  if (fingerprint === undefined) {
    throw new Error('expected exactly one installed Codex Stop definition')
  }
  writeSessionState(sessionId, env, {
    ...state,
    harness: 'codex',
    codex_stop_definition_fingerprint: fingerprint,
  })
}

function makeDeps(io: CapturedIo, client: ApiClient): CommandDeps {
  const testRoot = path.join(os.tmpdir(), 'notifai-cli-command-tests')
  // The hook adapter is one Machine-level file, so a shared adapter home makes
  // every case that installs hooks retarget every other case's adapter — and
  // whether that matters depends on the order vitest happened to pick.
  const adapterHome = mkdtempSync(path.join(os.tmpdir(), 'notifai-cli-adapter-home-'))
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
    hookAdapterHome: adapterHome,
    cwd: os.tmpdir(),
    clientFactory: () => withCompatibilityDefaults(client),
    fetchImpl: async () => new Response('{}', { status: 503 }),
  }
}


/** The User's own settings for the Project at `cwd`, stored outside the checkout. */
function writeProjectSettings(cwd: string, env: NodeJS.ProcessEnv, toml: string): void {
  const file = personalProjectConfigPath(cwd, env)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, toml)
}

function isolatedEnv(cwd: string): NodeJS.ProcessEnv {
  const home = path.join(cwd, 'home')
  return {
    HOME: home,
    USERPROFILE: home,
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

function claimedReplyResponse(replies: ReplyView[] = []) {
  return {
    ...replyResponse(replies),
    close_disposition: 'deliver' as const,
    delivered_reply_seq: replies.at(-1)?.seq ?? null,
  }
}

describe('command contracts', () => {
  it('finds send records by exact Agent Session without logging its name or content', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-send-log-'))
    const env = isolatedEnv(root)
    const logger = createLogger({ env })
    const deps = { ...makeDeps(new CapturedIo(), { submit: async () => receipt } as unknown as ApiClient), cwd: root, env, logger }
    try {
      expect(await sendCommand(deps, { kind: 'done', title: 'Completed', body: 'Private result text',
        sessionId: 'exact-log-session', sessionLabel: 'Private task name' })).toBe(EXIT.ok)
      const records = readLogRecords(env, { session: 'exact-log-session', limit: 100 }).records
      expect(records.map(record => record.event)).toEqual(expect.arrayContaining(['session.label', 'send.attempt', 'send.submitted', 'send.outcome']))
      expect(JSON.stringify(records)).not.toContain('Private task name')
      expect(JSON.stringify(records)).not.toContain('Private result text')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('names the Codex thread it sends from to the hub on every send, and once asks the agent to remind the User to approve the hooks in that home', async () => {
    // Short root: the fake hub's socket must fit in a Unix socket path.
    const root = mkdtempSync(path.join('/tmp', 'nfcx-'))
    const shadow = path.join(root, 'shadow')
    const env = { ...isolatedEnv(root), CODEX_HOME: shadow, CODEX_THREAD_ID: 'codex-unhooked-thread', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3 Code' }
    ensurePrivateDirectory(hubRunDir(env))
    const frames: Record<string, unknown>[] = []
    const hub = createServer((socket) => {
      const decoder = new FrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) { frames.push(frame); if (frame['type'] !== 'hello') socket.write(encodeFrame({ type: 'ok' })) }
      })
    })
    await new Promise<void>((resolve) => hub.listen(hubSocketPath(env), resolve))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, { submit: async () => receipt } as unknown as ApiClient), cwd: root, env }
    // Installed in this home, never approved there: Codex skips every handler.
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath: process.execPath, scriptPath: fileURLToPath(import.meta.url) })).toBe(EXIT.ok)
    io.errLines = []
    try {
      for (const title of ['Started', 'Finished']) expect(await sendCommand(deps, { kind: 'update', title })).toBe(EXIT.ok)
      // Each send's hint is work the CLI finishes before it exits: wait for exactly that.
      await settleBeforeExit()
      const hints = frames.filter((frame) => frame['type'] === 'notified')
      expect(hints).toHaveLength(2)
      for (const hint of hints) {
        expect(hint).toEqual({ type: 'notified', session_id: 'codex-unhooked-thread', harness: 'codex', codex_home: shadow, cwd: root, originator_override: 'T3 Code' })
      }
      const notices = io.errLines.filter((line) => line.includes('hooks aren\'t approved'))
      expect(notices).toEqual([
        "Notifai's hooks aren't approved in this Codex home. Carry on and never wait for it; end your reply to the User with this line, as written: " +
          "**Keep in mind:** Codex won't use Notifai in this Codex account until you approve its hooks there. In a terminal on this machine, run `notifai doctor codex`: it opens Codex's own hook review for this account, where you choose **Trust all and continue**.",
      ])
      // The User may run it from a terminal that knows nothing of this home.
      expect(JSON.parse(readFileSync(path.join(stateDir(env), 'codex-homes.json'), 'utf8'))).toEqual({ homes: [shadow] })
    } finally {
      hub.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    { name: 'inferred', selection: {}, configured: false, expected: 'writing' },
    { name: 'explicit', selection: { project: 'explicit' }, configured: true, expected: 'explicit' },
    { name: 'configured', selection: {}, configured: true, expected: 'configured' },
    { name: 'Projectless', selection: { projectless: true }, configured: true, expected: undefined },
  ])('sends and asks with $name identity in a registered folder descendant', async ({ selection, configured, expected }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-folder-requests-'))
    try {
      const folder = path.join(root, 'documents')
      const cwd = path.join(folder, 'notes')
      mkdirSync(cwd, { recursive: true })
      const env = isolatedEnv(root)
      updateProjectFolder('add', folder, 'writing', env)
      if (configured) writeProjectSettings(folder, env, 'project = "configured"\n')
      const io = new CapturedIo()
      const requests: SubmitNotificationRequestT[] = []
      const client = {
        submit: async (body: SubmitNotificationRequestT) => { requests.push(body); return receipt },
        replies: async () => replyResponse([reply]),
        closeReplies: async () => claimedReplyResponse([reply]),
        putAgentAcknowledgement: async () => ({}),
      } as unknown as ApiClient
      const deps = { ...makeDeps(io, client), cwd, env }
      expect(await sendCommand(deps, { kind: 'update', title: 'Writing', body: 'Draft finished.', ...selection })).toBe(EXIT.ok)
      expect(await askCommand(deps, 'Publish it?', { title: 'Writing', wait: true, json: true, ...selection })).toBe(EXIT.ok)
      expect(requests).toHaveLength(2)
      for (const request of requests) {
        expect(request.draft.project).toBe(expected)
        expect(JSON.stringify(request)).not.toContain(folder)
      }
      expect(projectEnablementState(projectBinding(folder, env))).toBe(expected === undefined ? 'unset' : 'enabled')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('asks Projectless outside a Project without creating Enablement state', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-projectless-ask-'))
    const io = new CapturedIo()
    const env = isolatedEnv(cwd)
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => ((submitted = body), receipt),
      replies: async () => replyResponse([reply]),
      closeReplies: async () => claimedReplyResponse([reply]),
      putAgentAcknowledgement: async () => ({}),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env }
    expect(await askCommand(deps, 'Ship it?', { title: 'Shipping', wait: true, projectless: true, json: true })).toBe(EXIT.ok)
    expect(submitted?.draft.project).toBeUndefined()
    expect(projectBinding(cwd, env)).toBeNull()
    expect(await askCommand(deps, 'Ship it?', { project: 'explicit', projectless: true, json: true })).toBe(EXIT.usage)
    expect(JSON.parse(io.outLines.at(-1)!)).toMatchObject({ code: 'invalid_input', registered: false })
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

  it('relays the no-plan refusal as one line with its stable code', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-send-no-plan-'))
    const io = new CapturedIo()
    const client = {
      submit: async () => {
        throw new ApiCallError(
          403,
          'no_active_plan',
          'Notifai needs an active plan to deliver notifications.',
          'Choose one at https://app.notifai.sh/plans',
        )
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd: root,
      env: { XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') },
    }

    expect(await sendCommand(deps, { kind: 'done', title: 'Build finished', body: 'All green.' })).toBe(EXIT.failed)
    expect(io.errLines).toEqual([
      'no_active_plan: Notifai needs an active plan to deliver notifications. Choose one at https://app.notifai.sh/plans',
    ])
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
})


describe('init', () => {
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


  function setupEvidence(
    requestId: string,
    companionReceipt: EvidenceSnapshot['deliveries'][number]['companion_receipt'],
    device: typeof readyIphone = readyIphone,
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
    device: typeof readyIphone = readyIphone,
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



  it('asks only which agent apps to connect, then sets them up without asking before the setup notification', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-offers-before-proof-'))
    const io = new InteractiveIo()
    io.multiselectAnswer = ['claude-code']
    const client = {
      health: async () => true,
      compatibility: async () => currentCompatibility,
      listDevices: async () => ({ devices: [readyIphone] }),
      accessStatus: async () => ({ status: 'active', reason: 'alpha_grant', expires_at: null, email: 'user@example.test' }),
      submit: async () => {
        io.prompts.push('<proof sent>')
        return setupReceipt('req_offers')
      },
      evidence: async () =>
        setupEvidence('req_offers', { state: 'observed', observed_at: '2026-08-18T18:00:02.000Z', latency_ms: 1_000 }),
    } as unknown as ApiClient
    const env = isolatedEnv(cwd)
    const deps = { ...makeDeps(io, client), cwd, env }

    // This test build has no bundled skill installer; the skill is covered elsewhere.
    expect(await initCommand(deps, { skills: false })).toBe(EXIT.ok)

    // One question, before anything else, and nothing asked after it.
    expect(io.prompts).toEqual(['Connect Notifai to which agent apps?', '<proof sent>'])
    expect(findInstallations(env, deps.hookAdapterHome).map((item) => item.harness)).toEqual(['claude-code'])
    const settings = JSON.parse(readFileSync(settingsFile('claude-code', env), 'utf8')) as { permissions?: { allow?: string[] } }
    expect(settings.permissions?.allow).toContain('Bash(notifai init *)')
    const done = io.notes.find((note) => note.title === 'Notifai is set up for user@example.test')
    expect(done?.message).toContain('To start: Claude Code: open a new session')
    expect(done?.message).toContain("Claude Code can now run Notifai's commands without asking.")
    expect(io.outros).toEqual(['All set ✨'])
  })

  /** A phone that is installed during the run once `installed` returns true. */
  function phoneStepInit(installed: () => boolean) {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-phone-step-'))
    const io = new InteractiveIo()
    io.selectAnswer = 'iphone'
    io.confirmAnswer = false
    let clock = 0
    let reported = false
    const client = {
      health: async () => true,
      compatibility: async () => currentCompatibility,
      listDevices: async () => {
        if (!installed()) return { devices: [] }
        if (!reported) io.prompts.push('<phone ready>')
        reported = true
        return { devices: [readyIphone] }
      },
      accessStatus: async () => ({ status: 'active', reason: 'alpha_grant', expires_at: null, email: 'user@example.test' }),
      submit: async () => {
        io.prompts.push('<proof sent>')
        return setupReceipt('req_phone_step')
      },
      evidence: async () =>
        setupEvidence('req_phone_step', { state: 'observed', observed_at: '2026-08-18T18:00:02.000Z', latency_ms: 1_000 }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client), cwd, env: isolatedEnv(cwd),
      now: () => clock,
      sleep: async (ms: number) => { clock += ms },
    }
    return { io, deps, clock: () => clock }
  }

  it('sends an already connected computer to the browser\'s phone steps, after the apps question', async () => {
    let clockAtStart: (() => number) | null = null
    const { io, deps, clock } = phoneStepInit(() => clockAtStart !== null && clockAtStart() > 0)
    clockAtStart = clock
    io.multiselectAnswer = []
    await initCommand(deps, {})
    const phone = io.prompts.indexOf('<phone ready>')
    const proof = io.prompts.indexOf('<proof sent>')
    expect(io.prompts[0]).toBe('Connect Notifai to which agent apps?')
    expect(io.prompts).not.toContain('Where do you want to receive notifications?')
    expect(io.openedUrls).toEqual(['https://test.notifai.invalid/setup/phone?email=user%40example.test&machine=mac_test&name=test-machine'])
    expect(io.outLines).toContain('Opened your browser to set up your phone.')
    expect(phone).toBeGreaterThan(0)
    expect(proof).toBeGreaterThan(phone)
  })

  it('stops waiting for the phone after 30 minutes without progress and says what is left', async () => {
    const { io, deps, clock } = phoneStepInit(() => false)
    io.multiselectAnswer = []
    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    expect(clock()).toBeGreaterThanOrEqual(30 * 60_000)
    expect(clock()).toBeLessThan(31 * 60_000)
    expect(io.prompts.some((prompt) => prompt.startsWith('Keep waiting'))).toBe(false)
    expect(io.prompts).not.toContain('<proof sent>')
    const left = io.notes.find((note) => note.title === 'Almost there. Set up for user@example.test, except your phone.')
    expect(left?.message).toContain('https://test.notifai.invalid/setup/phone?email=user%40example.test&machine=mac_test')
  })

  it('reports a rejected setup notification instead of claiming setup is done', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-rejected-proof-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      compatibility: async () => currentCompatibility,
      listDevices: async () => ({ devices: [readyIphone] }),
      accessStatus: async () => ({ status: 'active', reason: 'alpha_grant', expires_at: null, email: 'user@example.test' }),
      submit: async () => ({ ...setupReceipt('req_rejected'), overall: 'provider_rejected_all' }),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) }
    expect(await initCommand(deps, { hooks: false, skills: false, json: true })).toBe(EXIT.failed)
    const result = JSON.parse(io.outLines.at(-1) ?? '{}') as {
      ready: boolean
      states: { id: string; status: string; message?: string | null }[]
    }
    expect(result.ready).toBe(false)
    const proof = result.states.find((state) => state.id === 'proof')
    expect(proof?.status).toBe('gap')
    expect(proof?.message).toContain("couldn't get the test notification")
  })

  it('sends a refused setup notification once more only after the phone reconnects, and never a third time', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-rejected-retry-'))
    const io = new CapturedIo()
    let clock = Date.parse('2026-08-05T18:00:00.000Z')
    let device = { ...readyIphone }
    const submit = vi.fn(async () => ({ ...setupReceipt('req_rejected'), overall: 'provider_rejected_all' }))
    const client = {
      health: async () => true,
      compatibility: async () => currentCompatibility,
      listDevices: async () => ({ devices: [device] }),
      accessStatus: async () => ({ status: 'active', reason: 'alpha_grant', expires_at: null, email: 'user@example.test' }),
      setupNotification: async () => ({ sent_at: submit.mock.calls.length > 0 ? new Date(clock).toISOString() : null }),
      submit,
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd), now: () => clock, sleep: async (ms: number) => { clock += ms } }
    const run = async () => {
      io.outLines.length = 0
      await initCommand(deps, { hooks: false, skills: false, json: true, wait: 120 })
      return JSON.parse(io.outLines.at(-1) ?? '{}') as { waiting: boolean; message: string | null }
    }
    const first = await run()
    expect(first.message).toContain("couldn't get the test notification.\n\n**Open Notifai on it**")
    expect(submit).toHaveBeenCalledTimes(1)
    // Reruns and minutes of waiting send nothing while the phone stays away.
    expect(await run()).toMatchObject({ waiting: true, message: null })
    expect(submit).toHaveBeenCalledTimes(1)
    // The phone reconnects: one retry.
    device = { ...readyIphone, last_seen_at: new Date(clock + 1_000).toISOString() }
    clock += 2_000
    const retried = await run()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(retried.waiting).toBe(false)
    device = { ...readyIphone, last_seen_at: new Date(clock + 1_000).toISOString() }
    clock += 2_000
    await run()
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('sends no setup notification when the browser already sent one for this computer', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-sent-elsewhere-'))
    const io = new CapturedIo()
    const submit = vi.fn(async () => setupReceipt('req_never'))
    const client = {
      health: async () => true,
      compatibility: async () => currentCompatibility,
      listDevices: async () => ({ devices: [readyIphone] }),
      accessStatus: async () => ({ status: 'active', reason: 'alpha_grant', expires_at: null, email: 'user@example.test' }),
      setupNotification: async () => ({ sent_at: '2026-08-05T17:59:00.000Z' }),
      submit,
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) }
    expect(await initCommand(deps, { hooks: false, skills: false, json: true, wait: 30 })).toBe(EXIT.ok)
    const result = JSON.parse(io.outLines.at(-1) ?? '{}') as { message: string; states: { id: string; status: string }[] }
    expect(submit).not.toHaveBeenCalled()
    expect(result.states.find((state) => state.id === 'proof')?.status).toBe('ready')
    expect(result.message).toContain('✅ **Notifai is set up**')
  })

  /** A ready phone whose app never confirms the setup notification. */
  function unconfirmedProofInit() {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-unconfirmed-proof-'))
    const io = new CapturedIo()
    let clock = Date.parse('2026-08-05T18:00:00.000Z')
    const sleep = vi.fn(async (ms: number) => { clock += ms })
    const submit = vi.fn(async () => setupReceipt('req_unconfirmed'))
    const evidence = vi.fn(async () => setupEvidence('req_unconfirmed', { state: 'unknown', observed_at: null, latency_ms: null }))
    const client = {
      health: async () => true,
      compatibility: async () => currentCompatibility,
      listDevices: async () => ({ devices: [readyIphone] }),
      accessStatus: async () => ({ status: 'active', reason: 'alpha_grant', expires_at: null, email: 'user@example.test' }),
      submit,
      evidence,
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd), now: () => clock, sleep }
    const run = async () => {
      io.outLines.length = 0
      const code = await initCommand(deps, { hooks: false, skills: false, json: true })
      const result = JSON.parse(io.outLines.at(-1) ?? '{}') as {
        ready: boolean
        states: { id: string; status: string; message?: string | null }[]
      }
      return { code, result }
    }
    return { run, sleep, submit, evidence, later: (ms: number) => { clock += ms } }
  }

  it('finishes setup without the setup notification being confirmed', async () => {
    const { run } = unconfirmedProofInit()
    const { code, result } = await run()
    expect(code).toBe(EXIT.ok)
    expect(result.ready).toBe(true)
    const proof = result.states.find((state) => state.id === 'proof')
    expect(proof?.status).toBe('optional-gap')
    // Nothing is asked of the User about a confirmation.
    expect(proof?.message ?? null).toBeNull()
  })

  it('checks an earlier setup notification on a later run, without waiting or resending, even days later', async () => {
    const { run, sleep, submit, evidence, later } = unconfirmedProofInit()
    await run()
    expect(sleep).toHaveBeenCalled()
    sleep.mockClear()
    evidence.mockClear()
    later(3 * 24 * 60 * 60 * 1000)
    const { code, result } = await run()
    expect(code).toBe(EXIT.ok)
    expect(result.ready).toBe(true)
    expect(evidence).toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('names the computer without the .local suffix macOS adds', () => {
    expect(defaultMachineName('Rafaels-MacBook-Pro.local')).toBe('Rafaels-MacBook-Pro')
    expect(defaultMachineName('build-box')).toBe('build-box')
    expect(defaultMachineName('.local')).toBe('.local')
  })

  it('tells the User the one thing a registered device is missing', () => {
    const remedy = (device: Partial<typeof readyIphone>) =>
      deviceInstallRemedy({ email: null, devices: [{ ...readyIphone, ...device } as never] })
    expect(remedy({ permission_status: 'denied' })).toContain('Settings')
    expect(remedy({ permission_status: 'not_determined' })).toContain('allow notifications when it asks')
    expect(remedy({ registration_healthy: false })).toBe('open Notifai on the device so it can finish connecting')
    expect(remedy({ support: { ...currentSupport, state: 'must_update', affected_operation: 'receive_notifications' } as never }))
      .toBe('update the Notifai app on the device')
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
        skills: false,
      }),
    ).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    expect(out).toContain(COMPANION_INSTALL_URLS.iphone)
    expect(out).toContain(COMPANION_INSTALL_URLS.android)
    expect(out).not.toContain('/setup/companion')
    expect(out).not.toContain('/support')
    expect(out).toContain('sign in with the same email as this account (agent@example.com)')
    expect(io.openedUrls).toEqual([])
  })

  /** An Account without a plan: setup carries on; only delivery waits for the plan. */
  function noPlanInit(devices: unknown[], io: CapturedIo = new CapturedIo()) {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-no-plan-'))
    const submit = vi.fn(async () => receipt)
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices }),
      accessStatus: async () => ({
        status: 'no_active_plan',
        reason: 'no_active_grant',
        expires_at: null,
        email: 'new@example.com',
      }),
      submit,
    } as unknown as ApiClient
    return { io, submit, deps: { ...makeDeps(io, client), cwd, env: isolatedEnv(cwd) } }
  }

  it('asks for the app before the plan when an Account has no plan', async () => {
    const { io, submit, deps } = noPlanInit([])
    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    expect(out).toContain(COMPANION_INSTALL_URLS.iphone)
    expect(out).not.toMatch(/alpha/i)
    expect(submit).not.toHaveBeenCalled()
  })

  it('ends setup on the plan, without a proof notification, once the app is in', async () => {
    const { io, submit, deps } = noPlanInit([readyIphone])
    expect(await initCommand(deps, { hooks: false, skills: false, json: true })).toBe(EXIT.failed)
    const result = JSON.parse(io.outLines.at(-1) ?? '{}') as { states: { id: string; status: string; detail: string; technical?: { access_url?: string } }[] }
    const gaps = result.states.filter((state) => state.status === 'gap')
    expect(gaps.map((state) => state.id)).toEqual(['auth'])
    expect(gaps[0]!.detail).toBe('Notifai needs an active plan to deliver notifications.')
    expect(gaps[0]!.technical?.access_url).toBe('https://test.notifai.invalid/plans')
    const ids = result.states.map((state) => state.id)
    expect(ids.indexOf('auth')).toBeGreaterThan(ids.indexOf('devices'))
    expect(result.states.find((state) => state.id === 'proof')?.status).toBe('unknown')
    expect(submit).not.toHaveBeenCalled()
  })

  it('waits for the plan at the terminal, then stops after 30 minutes with what is left', async () => {
    const io = new InteractiveIo()
    io.multiselectAnswer = []
    const { submit, deps } = noPlanInit([readyIphone], io)
    let clock = 0
    const timed = { ...deps, now: () => clock, sleep: async (ms: number) => { clock += ms } }
    expect(await initCommand(timed, {})).toBe(EXIT.failed)
    expect(io.outLines).toContain('Last step: choose a plan in the Notifai app on your phone.')
    expect(io.spinnerEvents).toContain('start:Waiting for your plan…')
    expect(clock).toBeGreaterThanOrEqual(30 * 60_000)
    expect(io.notes.some((note) => note.title === 'Almost there. Set up for new@example.com, except your plan.')).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('counts a desktop app with permission as set up while the plan is missing', async () => {
    // Without a plan a desktop app cannot hold its delivery stream open.
    const desktop = { ...readyIphone, device_id: 'dev_mac', display_name: 'Mac', platform: 'macos' as never, registration_healthy: false }
    const { io, deps } = noPlanInit([desktop])
    expect(await initCommand(deps, { hooks: false, skills: false, json: true })).toBe(EXIT.failed)
    const result = JSON.parse(io.outLines.at(-1) ?? '{}') as { states: { id: string; status: string }[] }
    expect(result.states.find((state) => state.id === 'devices')?.status).toBe('ready')
    expect(result.states.filter((state) => state.status === 'gap').map((state) => state.id)).toEqual(['auth'])
  })
})

describe('guided setup', () => {
  const phone = {
    device_id: 'dev_iphone', display_name: 'iPhone', platform: 'ios' as const, permission_status: 'authorized',
    registration_healthy: true, app_version: '1.1.3', app_build: '1', os_version: '19.0', capabilities: ['answer'] as const,
    support: currentSupport, support_state: 'current' as const, derived_status: 'working' as const, status_message: null,
    last_seen_at: '2026-10-26T12:00:00.000Z',
  }

  /** A computer setup run from scratch against a fake service with a clock. */
  function journey(options: { connected?: boolean; devices?: () => unknown[]; plan?: () => boolean; approveAt?: number | null; tooOld?: boolean; platform?: NodeJS.Platform; macApp?: boolean } = {}) {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-guided-'))
    const env = isolatedEnv(cwd)
    let clock = Date.parse('2026-10-26T12:00:00.000Z')
    let credential: { machineId: string; secret: string; baseUrl: string; machineName: string } | null = options.connected === true
      ? { machineId: 'mac_test', secret: 'test-secret', baseUrl: 'https://test.notifai.invalid', machineName: 'MacBook Pro' }
      : null
    const begun: unknown[] = []
    const extended: number[] = []
    let expiresAt = clock + 30 * 60_000
    const startedAt = clock
    const client = {
      health: async () => true,
      compatibility: async () => currentCompatibility,
      beginPairing: async (body: unknown) => {
        begun.push(body)
        expiresAt = clock + 30 * 60_000
        return { pairing_id: 'pair_1', code: 'W5Z-CZN', approve_url: 'https://app.notifai.sh/approve?code=W5Z-CZN',
          expires_at: new Date(expiresAt).toISOString(), poll_interval_seconds: 3 }
      },
      extendPairing: async () => {
        if (options.tooOld === true) throw new ApiCallError(410, 'pairing_too_old', 'This approval is too old to keep open.')
        extended.push(clock)
        expiresAt = clock + 30 * 60_000
        return { pairing_id: 'pair_1', code: 'W5Z-CZN', approve_url: 'https://app.notifai.sh/approve?code=W5Z-CZN',
          expires_at: new Date(expiresAt).toISOString(), poll_interval_seconds: 3 }
      },
      pollPairing: async () => {
        if (options.approveAt !== undefined && options.approveAt !== null && clock - startedAt >= options.approveAt) {
          return { status: 'approved', machine_id: 'mac_test' }
        }
        return { status: clock > expiresAt ? 'expired' : 'pending' }
      },
      listDevices: async () => ({ devices: options.devices?.() ?? [] }),
      accessStatus: async () => ({
        status: options.plan?.() === false ? 'no_active_plan' : 'active',
        reason: 'alpha_grant', expires_at: null, email: 'you@example.com',
      }),
      submit: async () => ({ ...receipt, request_id: 'req_setup' }),
      evidence: async () => { throw new NetworkError('offline') },
      requestPairingNotification: async () => ({ ok: true }),
    } as unknown as ApiClient
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env,
      store: {
        load: () => credential,
        save: (saved) => { credential = saved },
        clear: () => { credential = null },
        describe: () => 'test credential store',
      },
      now: () => clock,
      sleep: async (ms: number) => { clock += Math.max(ms, 1) },
      hookPlatform: options.platform ?? 'linux',
      macAppInstalled: options.macApp ?? false,
    }
    const run = async (flags: Record<string, unknown> = {}) => {
      io.outLines = []
      const code = await initCommand(deps, { json: true, hooks: false, skills: false, ...flags })
      return { code, result: JSON.parse(io.outLines.join('\n')) as {
        ready: boolean; message: string | null; waiting: boolean; stopped: boolean
        states: { id: string; status: string; technical: Record<string, unknown> | null }[]
      } }
    }
    return { io, deps, run, begun, extended, elapsed: () => clock - startedAt, later: (ms: number) => { clock += ms } }
  }

  it('asks which agent apps to connect before anything else, once, and never for an agent that chose the older flags', async () => {
    const { deps, io } = journey({ connected: true, devices: () => [phone] })
    mkdirSync(path.join(deps.env['HOME']!, '.codex'), { recursive: true })
    await initCommand(deps, { json: true })
    const result = JSON.parse(io.outLines.join('\n')) as { message: string; states: { id: string; status: string; technical: unknown }[] }
    expect(result.states[0]).toMatchObject({ id: 'apps', status: 'gap', technical: {
      supported: expect.arrayContaining([{ id: 'claude-code', name: 'Claude Code' }, { id: 'codex', name: 'Codex (CLI, IDE or ChatGPT app)' }]),
      detected: ['codex'],
    } })
    expect(result.message).toBe('**Which agent apps should Notifai connect?**\n\nFound on this computer: Codex (CLI, IDE or ChatGPT app). Keep these, or pick others.')

    io.outLines = []
    await initCommand(deps, { json: true, hooks: false, skills: false })
    const legacy = JSON.parse(io.outLines.join('\n')) as { states: { id: string }[] }
    expect(legacy.states.map((state) => state.id)).not.toContain('apps')

    // "No apps" is an answer: a later plain run does not ask again.
    io.outLines = []
    await initCommand(deps, { json: true })
    const later = JSON.parse(io.outLines.join('\n')) as { states: { id: string }[] }
    expect(later.states.map((state) => state.id)).not.toContain('apps')
  })

  it('opens the approval page once, says so once, and keeps the same code open while the agent waits', async () => {
    const test = journey()
    const first = await test.run({ wait: 240 })
    expect(first.result.waiting).toBe(true)
    expect(first.result.message).toBe('**Connect this computer** in the browser I opened.\n\nCheck the code: **W5Z-CZN**\n\n' +
      "Didn't open? [Open the approval page](https://app.notifai.sh/approve?code=W5Z-CZN#confirmation_secret=" +
      `${first.result.message!.match(/confirmation_secret=([^)]+)\)/)![1]})\n\nOr scan this with the Notifai app:`)
    const pairing = first.result.states.find((state) => state.id === 'credential')!.technical!['pairing'] as Record<string, unknown>
    expect(pairing['qr_text_path']).toEqual(expect.any(String))
    expect(test.io.openedUrls).toHaveLength(1)

    // Reruns wait out their --wait without repeating anything, renewing before the code lapses.
    for (let i = 0; i < 10; i += 1) {
      const again = await test.run({ wait: 240 })
      expect(again.result).toMatchObject({ waiting: true, message: null, stopped: false })
    }
    expect(test.elapsed()).toBeGreaterThanOrEqual(40 * 60_000)
    expect(test.extended.length).toBeGreaterThanOrEqual(1)
    expect(test.begun).toHaveLength(1)
    expect(test.io.openedUrls).toHaveLength(1)
  })

  it('stops after 90 minutes without approval, with the "almost there" message', async () => {
    const test = journey()
    await test.run({ wait: 3600 })
    let last = await test.run({ wait: 3600 })
    let reruns = 1
    while (!last.result.stopped && reruns < 5) { last = await test.run({ wait: 3600 }); reruns += 1 }
    expect(reruns).toBe(2)
    expect(last.result).toMatchObject({ stopped: true, waiting: false,
      message: "**Setup stopped:** this computer wasn't approved within 90 minutes.\n\nAsk me any time to try again." })
    expect(test.elapsed()).toBeLessThanOrEqual(91 * 60_000)
  })

  it('counts the 90 minutes from when the approval began, through a paused agent, and waits afresh when asked again', async () => {
    const test = journey()
    await test.run({ wait: 60 })
    // Long enough for the agent's setup run to start over; the approval's wait does not.
    test.later(80 * 60_000)
    // A fresh run says the code again, then waits only what is left of the 90 minutes.
    await test.run({ wait: 3600 })
    const stopped = await test.run({ wait: 3600 })
    expect(stopped.result.stopped).toBe(true)
    expect(test.elapsed()).toBeLessThanOrEqual(91 * 60_000)
    // The User asks again: the same code, a new wait.
    const again = await test.run({ wait: 0 })
    expect(again.result).toMatchObject({ stopped: false, waiting: true })
    expect(again.result.message).toContain('Check the code: **W5Z-CZN**')
    expect(test.begun).toHaveLength(1)
  })

  it('refuses --wait without --json, where it would do nothing', async () => {
    const test = journey()
    expect(await initCommand(test.deps, { wait: 60 })).toBe(EXIT.usage)
    expect(test.io.errLines.join('\n')).toContain('`--wait` works with `--json`')
    expect(test.begun).toHaveLength(0)
  })

  it('names a replacement code once at the terminal', async () => {
    const test = journey({ tooOld: true })
    const io = new InteractiveIo()
    io.multiselectAnswer = []
    await initCommand({ ...test.deps, io }, { skills: false })
    expect(test.begun.length).toBeGreaterThanOrEqual(2)
    expect(io.outLines.filter((line) => /(Code|New one): W5Z-CZN/.test(line))).toHaveLength(test.begun.length)
    expect(io.outLines.filter((line) => line.startsWith('That code expired. New one: W5Z-CZN'))).toHaveLength(test.begun.length - 1)
  })

  it('ends a terminal setup whose phone has notifications off with the same done message an agent gets', async () => {
    const denied = { ...phone, permission_status: 'denied' }
    const test = journey({ connected: true, devices: () => [denied] })
    const io = new InteractiveIo()
    io.multiselectAnswer = []
    await initCommand({ ...test.deps, io }, { skills: false })
    const done = io.notes.find((note) => note.title === 'Notifai is set up for you@example.com')
    expect(done?.message).toContain('⚠ Notifications are off on your iPhone: Settings → Notifai → Notifications')
    expect(io.notes.find((note) => note.title === 'Ready')).toBeUndefined()
  })

  it('names the Account once approved, then leaves the phone to the approval page it opened', async () => {
    const test = journey({ approveAt: 60_000 })
    await test.run({ wait: 240 })
    const connected = await test.run({ wait: 240 })
    expect(connected.result.message).toBe("✓ **Connected** to **you@example.com**.\n\n_Not your Account? Tell me and I'll disconnect it._\n\n" +
      '**Now your phone:** follow the page in your browser.')
    expect(connected.result.waiting).toBe(true)
    // The approval page already walks the phone steps: no second page.
    expect(test.io.openedUrls).toHaveLength(1)
  })

  it('gives the store links after an approval no browser page of its own walks on', async () => {
    const test = journey({ approveAt: 60_000 })
    await test.run({ wait: 240, open: false })
    const connected = await test.run({ wait: 240, open: false })
    expect(connected.result.message).toBe("✓ **Connected** to **you@example.com**.\n\n_Not your Account? Tell me and I'll disconnect it._\n\n" +
      '**Now set up your phone**\n\n' +
      '1. Get the Notifai app: [iPhone](https://apps.apple.com/app/id6799027730) or [Android (free test)](https://app.notifai.sh/test-android)\n' +
      '2. Sign in as **you@example.com**\n3. Allow notifications')
  })

  it('opens nothing for an approval notification', async () => {
    const test = journey()
    const result = (await test.run({ wait: 0, approval: 'notification', approvalEmail: 'you@example.com' })).result
    expect(test.io.openedUrls).toEqual([])
    expect(result.message).toContain('**Connect this computer:** [open the approval page](https://app.notifai.sh/approve?code=W5Z-CZN')
  })

  it('replaces a code it can no longer keep open with the expired message, in a new tab', async () => {
    const test = journey({ tooOld: true })
    await test.run({ wait: 0 })
    test.later(31 * 60_000)
    const renewed = (await test.run({ wait: 60 })).result
    expect(test.begun).toHaveLength(2)
    expect(renewed.message).toMatch(/^\*\*That code expired\.\*\* I opened a new approval page\.\n\nCheck the new code: \*\*W5Z-CZN\*\*\n\nDidn't open\? \[Open the approval page\]\(https:\/\/app\.notifai\.sh\/approve\?code=W5Z-CZN#confirmation_secret=[^)]+\)\n\nOr scan this with the Notifai app:$/)
    expect(test.io.openedUrls).toHaveLength(2)
  })

  it('opens the phone steps for an already connected computer, once, and stops after 30 minutes with what is left', async () => {
    const test = journey({ connected: true })
    const first = await test.run({ wait: 240 })
    const url = 'https://test.notifai.invalid/setup/phone?email=you%40example.com&machine=mac_test&name=MacBook+Pro'
    expect(test.io.openedUrls).toEqual([url])
    expect(first.result.message).toBe(`This computer is already connected to **you@example.com**.\n\n**Now your phone:** follow the page I opened in your browser.\n\nDidn't open? [Open the phone setup page](${url})`)
    let last = await test.run({ wait: 240 })
    expect(last.result).toMatchObject({ waiting: true, message: null })
    while (!last.result.stopped) last = await test.run({ wait: 240 })
    expect(test.elapsed()).toBeLessThanOrEqual(31 * 60_000)
    expect(last.result.message).toContain('**Almost there:** this computer and your agent apps are set up for **you@example.com**.')
    // Finishing later in the app sends nothing, so the stop promises nothing.
    expect(last.result.message).not.toContain('test notification')
    expect(test.io.openedUrls).toEqual([url])
    // The next run starts fresh and says it again.
    expect((await test.run({ wait: 0 })).result.message).toContain('This computer is already connected')
  })

  it('never opens a page over SSH or with --no-open, and says where to open it instead', async () => {
    const test = journey()
    test.deps.env['SSH_CONNECTION'] = '10.0.0.2 50000 10.0.0.3 22'
    const result = (await test.run({ wait: 0 })).result
    expect(test.io.openedUrls).toEqual([])
    expect(result.message).toContain('**Connect this computer:** [open the approval page](https://app.notifai.sh/approve?code=W5Z-CZN')
    const local = journey()
    await local.run({ wait: 0, open: false })
    expect(local.io.openedUrls).toEqual([])
  })

  it('waits for a phone that is deciding on notifications, then finishes without them and says so', async () => {
    const undecided = { ...phone, permission_status: 'not_determined' }
    const test = journey({ connected: true, devices: () => [undecided] })
    const first = await test.run({ wait: 240 })
    expect(first.result).toMatchObject({ waiting: true, message: 'Open Notifai on your iPhone and **allow notifications**.' })
    const done = await test.run({ wait: 240 })
    expect(test.elapsed()).toBeGreaterThanOrEqual(2 * 60_000)
    expect(done.result.ready).toBe(true)
    expect(done.result.waiting).toBe(false)
    expect(done.result.message).toContain('⚠️ **Notifications are off on your iPhone.** Turn them on in Settings → Notifai → Notifications.')
  })

  it('waits for the plan and ends with the done message once it is active', async () => {
    let active = false
    const test = journey({ connected: true, devices: () => [phone], plan: () => active })
    const first = await test.run({ wait: 240 })
    expect(first.result.message).toContain('**Last step: choose a plan** in the Notifai app on your phone.')
    active = true
    const done = await test.run({ wait: 240 })
    expect(done.result.ready).toBe(true)
    expect(done.result.message).toMatch(/^✅ \*\*Notifai is set up\*\* for \*\*you@example.com\*\*\.\n\nYou can answer your agents from your phone\.$/)
  })

  it('offers the desktop app last, only on a Mac without it', async () => {
    const mac = await journey({ connected: true, devices: () => [phone], platform: 'darwin' }).run({ wait: 240 })
    expect(mac.result.ready).toBe(true)
    expect(mac.result.message).toMatch(/\n\nWant notifications on your Mac\? \[Download the desktop app here\]\(https:\/\/app\.notifai\.sh\/download\/mac\)$/)
    const linux = await journey({ connected: true, devices: () => [phone], platform: 'linux' }).run({ wait: 240 })
    expect(linux.result.message).not.toContain('Mac')
    const installed = await journey({ connected: true, devices: () => [phone], platform: 'darwin', macApp: true }).run({ wait: 240 })
    expect(installed.result.message).not.toContain('Mac')
  })

  it('walks a person at the terminal through approval and the phone, naming the Account', async () => {
    const test = journey({ approveAt: 30_000 })
    const io = new InteractiveIo()
    io.selectAnswer = 'iphone'
    io.multiselectAnswer = []
    const deps = { ...test.deps, io }
    await initCommand(deps, { skills: false })
    expect(io.openedUrls[0]).toMatch(/^https:\/\/app\.notifai\.sh\/approve\?code=W5Z-CZN#confirmation_secret=/)
    expect(io.outLines).toContain('Opened your browser to connect this computer. Code: W5Z-CZN')
    expect(io.spinnerEvents).toContain('stop:Connected to you@example.com as "' + defaultMachineName(os.hostname()) + '".')
    expect(io.outLines).toContain('  Not your Account? Run notifai logout --revoke')
    expect(io.prompts).not.toContain('How do you want to approve it?')
    // Approved on the page setup opened: that page walks the phone, so no store QR here.
    expect(io.outLines).toContain('Now your phone: follow the page in your browser.')
    expect(io.prompts).not.toContain('Where do you want to receive notifications?')
    expect(io.notes.find((n) => n.title === 'Get Notifai on your iPhone')).toBeUndefined()
    expect(io.openedUrls).toHaveLength(1)

    // Nothing opened (SSH, --no-open): the phone app comes from the store QR.
    const remote = journey({ approveAt: 30_000 })
    const remoteIo = new InteractiveIo()
    remoteIo.selectAnswer = 'iphone'
    remoteIo.multiselectAnswer = []
    await initCommand({ ...remote.deps, io: remoteIo }, { skills: false, open: false })
    const note = remoteIo.notes.find((n) => n.title === 'Get Notifai on your iPhone')
    expect(note?.message).toContain((await terminalQr(COMPANION_INSTALL_URLS.iphone)).trimEnd())
  })

  it('moves a terminal on to the plan once a Companion App is only waiting for it', async () => {
    let calls = 0
    // A desktop app allowed notifications but cannot finish connecting without a plan.
    const desktop = { ...phone, device_id: 'dev_desktop', display_name: 'Mac app', platform: 'macos' as const, registration_healthy: false }
    const test = journey({ connected: true, plan: () => false, devices: () => (++calls > 3 ? [desktop] : []) })
    const io = new InteractiveIo()
    io.multiselectAnswer = []
    await initCommand({ ...test.deps, io }, { skills: false })
    expect(io.spinnerEvents).toContain('stop:Mac app is set up; it receives once your plan is active')
    expect(io.outLines).toContain('Last step: choose a plan in the Notifai app on your phone.')
    expect(io.spinnerEvents.some((event) => event.startsWith('error:Stopped waiting for your phone'))).toBe(false)
  })
})

describe('the phone install hand-off', () => {
  const noDevicesClient = () => ({
    health: async () => true,
    capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    listDevices: async () => ({ devices: [] }),
    accessStatus: async () => ({ status: 'active', reason: 'alpha_grant', expires_at: null, email: 'user@example.test' }),
  }) as unknown as ApiClient

  it('gives every gap in init --json the exact line to relay', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-relay-messages-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, noDevicesClient()), cwd, env: isolatedEnv(cwd) }

    await initCommand(deps, { json: true, hooks: false, skills: false })

    const result = JSON.parse(io.outLines.join('\n')) as { states: { id: string; status: string; message: string | null }[] }
    const gaps = result.states.filter((state) => state.status === 'gap')
    expect(gaps.map((gap) => gap.id)).toContain('devices')
    for (const gap of gaps) expect(gap.message, gap.id).toMatch(/\S/)
    expect(result.states.find((state) => state.id === 'devices')!.message).toBe(
      deviceRelayMessage({ email: 'user@example.test', devices: [] }),
    )
    for (const state of result.states.filter((s) => s.status === 'ready')) expect(state.message).toBeNull()
  })

  it('names what a registered phone is missing, in the User\'s words', () => {
    const phone = (device: Record<string, unknown>) => ({
      device_id: 'dev', display_name: 'Pixel', platform: 'android', permission_status: 'authorized',
      registration_healthy: true, ...device,
    }) as never
    const empty = deviceRelayMessage({ email: null, devices: [] })
    expect(empty).toContain(COMPANION_INSTALL_URLS.iphone)
    expect(empty).toContain(COMPANION_INSTALL_URLS.android)
    expect(empty).toContain('the email you approved this computer with')
    expect(deviceRelayMessage({ email: null, devices: [phone({ permission_status: 'denied' })] }))
      .toContain('Settings → Apps → Notifai → Notifications')
    expect(deviceRelayMessage({ email: null, devices: [phone({ platform: 'ios', permission_status: 'denied' })] }))
      .toContain('Settings → Notifai → Notifications')
    expect(deviceRelayMessage({ email: null, devices: [phone({ permission_status: 'not_determined' })] }))
      .toBe('Open Notifai on your Android phone and **allow notifications**.')
    expect(deviceRelayMessage({ email: null, devices: [phone({ registration_healthy: false })] }))
      .toBe('**Open Notifai** on your Android phone so it can finish connecting.')
  })

  it('relays the prepared lines a gap already carries, and says something for any other gap', () => {
    expect(relayMessage({ id: 'credential', title: 'This machine', status: 'gap', detail: 'x', technical: { pairing: { message: 'Scan it.' } } }))
      .toBe('Scan it.')
    expect(relayMessage({ id: 'credential', title: 'This machine', status: 'gap', detail: 'x', technical: { pairing_outcome: 'denied' } }))
      .toBe('**Setup stopped:** you declined this computer.\n\nAsk me any time to try again.')
    expect(relayMessage({ id: 'credential', title: 'This machine', status: 'gap', detail: 'x', technical: { pairing_outcome: 'stopped' } }))
      .toContain("wasn't approved within 90 minutes")
    expect(relayMessage({ id: 'server', title: 'Service', status: 'gap', detail: 'x' })).toContain("I can't reach Notifai")
    expect(relayMessage({ id: 'auth', title: 'Plan', status: 'gap', detail: 'x', technical: { plan_required: true, access_url: 'https://app.example/plans' } }))
      .toBe('**Last step: choose a plan** in the Notifai app on your phone.\n\nOr on the web: [app.example/plans](https://app.example/plans)\n\nI\'ll send a test notification once it\'s active.')
    expect(relayMessage({
      id: 'hooks-codex', title: 'Codex', status: 'optional-gap', detail: 'x',
      remedy: { by: 'user-here', summary: 's', command: 'c', user_action: { code: 'c', harness: 'codex', action: 'a', message: 'Type /hooks.' } },
    })).toBe('Type /hooks.')
    expect(relayMessage({ id: 'contract', title: 'Update', status: 'gap', detail: 'too old', remedy: { by: 'user-here', summary: 'update Notifai', command: 'notifai update' } }))
      .toBe('**I couldn\'t finish setting up Notifai.**\n\nIt said: "too old". Update Notifai.')
    expect(relayMessage({ id: 'skill', title: 'Skill', status: 'optional-gap', detail: 'x' })).toBeNull()
  })
})

describe('a held ask --wait', () => {

  /** A script's shell: no harness marker, so no later answer could return. */
  function scriptDeps(io: CapturedIo, client: Partial<ApiClient>, start = 1_000_000) {
    let now = start
    const deps: CommandDeps = {
      ...makeDeps(io, client as ApiClient),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }
    return { deps, clock: { get now() { return now }, advance: (ms: number) => { now += ms } } }
  }

  const ask = (deps: CommandDeps, flags: Partial<AskFlags> = {}) =>
    askCommand(deps, 'Deploy to production?', { title: 'Production deploy', wait: true, ...flags })

  it('submits at once for the answer window, prints the answer and records the fixed receipt', async () => {
    const io = new CapturedIo()
    const submit = vi.fn(async (_body: SubmitNotificationRequestT, _wait: number) => receipt)
    const closeReplies = vi.fn(async () => claimedReplyResponse([reply]))
    const putAgentAcknowledgement = vi.fn(async () => ({
      agent_acknowledgement: { text: PROGRAM_RECEIPT, recorded_at: '2026-08-01T18:01:01.000Z' },
    }))
    const { deps } = scriptDeps(io, { submit, replies: async () => replyResponse([reply]), closeReplies, putAgentAcknowledgement } as never)

    expect(await ask(deps)).toBe(EXIT.ok)
    expect(submit).toHaveBeenCalledTimes(1)
    // The service owns the end: the window is the wait.
    expect(submit.mock.calls[0]![0].draft.reply?.expires_in_seconds).toBe(86_400)
    // Returns at acceptance: no provider-outcome wait inside the limit.
    expect(submit.mock.calls[0]![1]).toBe(0)
    expect(closeReplies).toHaveBeenCalledWith(receipt.request_id, 'deliver')
    expect(putAgentAcknowledgement).toHaveBeenCalledWith(receipt.request_id, { text: PROGRAM_RECEIPT })
    expect(PROGRAM_RECEIPT).toBe('Received by the program that asked.')
    expect(io.outLines[0]).toMatch(/^Question submitted as req_reply_test; waiting up to 86400s for the answer \(until .+\)\. Keep this command running until it returns\.$/)
    expect(io.outLines).toContain(`User reply: ${JSON.stringify(reply.text)}`)
  })

  /** An admitted OpenCode session whose current plugin reported whether it is a worker. */
  function opencodeSession(worker: '0' | '1') {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-handback-'))
    const env = { ...isolatedEnv(cwd), NOTIFAI_ACTIVE_HARNESS: 'opencode', NOTIFAI_ACTIVE_SESSION_ID: 'ses_root',
      NOTIFAI_ACTIVE_SESSION_LABEL: 'Release the beta', NOTIFAI_ACTIVE_SESSION_WORKER: worker }
    const plugin = path.join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'notifai.js')
    mkdirSync(path.dirname(plugin), { recursive: true })
    writeFileSync(plugin, opencodePluginSource({ adapterPath: path.join(cwd, 'adapter'), timeoutSeconds: 10 }))
    updateSessionState('ses_root', env, (state) => ({ ...state, harness: 'opencode', last_prompt_at: Date.now() - 1_000 }))
    return { cwd, env }
  }

  it('refuses a Projectless OpenCode wait when the cwd Project is disabled', async () => {
    const { cwd, env } = opencodeSession('0')
    writeProjectSettings(cwd, env, 'project = "disabled-wait"\n')
    const binding = projectBinding(cwd, env, 'disabled-wait')!
    disableProject(binding)
    const io = new CapturedIo()
    const submit = vi.fn(async () => receipt)
    const { deps } = scriptDeps(io, { submit, replies: async () => replyResponse([reply]), closeReplies: async () => claimedReplyResponse([reply]), claimDeliveryAttempt: async () => ({ status: 'recorded' }) } as never)
    expect(await askCommand({ ...deps, cwd, env }, 'Why?', { title: 'Reason', wait: true, projectless: true, json: true })).toBe(EXIT.usage)
    expect(submit).not.toHaveBeenCalled()
    expect(JSON.parse(io.outLines.at(-1)!)).toMatchObject({ code: 'project_disabled', registered: false })
    expect(io.outLines.join(' ')).not.toContain('open_form')
    expect(projectEnablementState(binding)).toBe('disabled')
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

  it.each([false, true])('registers a first-turn question with account-specific Codex state (shared files: %s)', async (shared) => {
    const root = scratchDir('notifai-active-codex-matching-')
    const repo = path.join(root, 'repo')
    const worktree = path.join(root, 'linked-worktree')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    git('init')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(path.join(repo, 'file'), 'x')
    git('add', 'file')
    git('commit', '-m', 'fixture')
    git('worktree', 'add', worktree, '-b', 'feature/first-turn-ask')
    const cwd = path.join(worktree, 'nested')
    mkdirSync(cwd)
    const io = new CapturedIo()
    const accountHome = path.join(root, 'account-home')
    const codexHome = path.join(root, 'codex-account-home')
    const env = {
      XDG_CONFIG_HOME: path.join(accountHome, 'config'),
      XDG_STATE_HOME: path.join(accountHome, 'state'),
      HOME: accountHome,
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env, now: () => 42 }
    writeProjectSettings(worktree, env, 'project = "linked-first-turn"\n')

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    if (shared) {
      const shadow = path.join(root, 'shadow')
      mkdirSync(shadow)
      for (const name of ['hooks.json', 'config.toml']) symlinkSync(path.join(codexHome, name), path.join(shadow, name))
      env.CODEX_HOME = shadow
      // Source-home approval must not admit a question in a different home.
      expect(askCommand(deps, 'Ship it?', { title: 'Decision', json: true })).toBe(EXIT.usage)
      expect(JSON.parse(io.outLines.at(-1)!)).toMatchObject({
        code: 'codex_hook_approval_required',
        remedy: expect.stringContaining('ask this question in the conversation instead and carry on'),
        user_action: { message: "**Keep in mind:** Codex won't use Notifai until you approve its hooks. Type `/hooks` and approve them." },
      })
      trustInstalledCodexHooks(cwd, env)
    }
    writeCurrentCodexSessionState(cwd, env, 'codex-current-thread', {
      last_prompt_at: 42,
    })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')
    writeSessionState('claude-concurrent', env, { harness: 'claude-code', last_prompt_at: 43, last_stop_at: 43 })
    writeProjectSession(cwd, env, 'claude-concurrent', 43, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', { title: 'Decision' })).toBe(EXIT.ok)
    expect(io.outLines.some((line) => line.startsWith('Question registered (q_'))).toBe(true)
    expect(readSessionState('codex-current-thread', env).pending?.[0]?.source).toMatchObject({
      session_id: 'codex-current-thread',
      harness: 'codex',
    })
    expect(readSessionState('codex-current-thread', env).pending?.[0]?.project).toBe(
      'linked-first-turn',
    )
    expect(
      readSessionState('codex-current-thread', env).pending?.[0]?.source?.session_label,
    ).toBe('Gentle Salmon')
    expect(readSessionState('codex-current-thread', env).pending?.[0]?.title).toBe('Decision')
    // An agent on an older skill passes no --title: the question still registers,
    // titled by the Agent Session name, with one note naming --title.
    expect(askCommand(deps, 'Ship it now?', {})).toBe(EXIT.ok)
    expect(readSessionState('codex-current-thread', env).pending?.[1]?.title).toBe('Gentle Salmon')
    expect(io.errLines).toContain(MISSING_TITLE_NOTE)
    expect(settingsFile('codex', env)).toBe(path.join(env.CODEX_HOME, 'hooks.json'))
    expect(existsSync(path.join(repo, '.codex'))).toBe(false)
    expect(existsSync(path.join(worktree, '.codex'))).toBe(false)

    const readiness = await assessReadiness(deps)
    const fired = readiness.states.find((state) => state.id === 'hooks-fired')
    expect(fired).toMatchObject({ status: 'ready' })
    expect(fired?.detail).toMatch(/UserPromptSubmit.*ready for this turn's Stop/i)
    expect(readiness.states.find((state) => state.id === 'hooks-native-activity'))
      .toMatchObject({ status: 'optional-gap' })
    // Local registration and working hooks do not prove delivery: this
    // fixture has no reachable service or active Companion App.
    expect(readinessJson(readiness)).toMatchObject({ can_send: false, question_routing_ready: false })

    io.outLines = []
    expect(askCommand(deps, 'Wait?', { title: 'Decision', json: true })).toBe(EXIT.ok)
    const registered = JSON.parse(io.outLines.join('\n')) as Record<string, unknown>
    expect(registered).toMatchObject({
      registered: true,
      state: 'local',
      submitted: false,
      request_id: null,
      provider_acceptance: 'not_available',
      submission: 'scheduled',
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

  it('rejects a legacy Codex session without a Stop-definition fingerprint before uploading or registering', async () => {
    const cwd = scratchDir('notifai-codex-legacy-stop-definition-')
    const image = path.join(cwd, 'proof.png')
    writeFileSync(image, fakeImage('png', 'proof'))
    const io = new PlainInteractiveIo()
    const env = {
      ...isolatedEnv(cwd),
      CODEX_THREAD_ID: 'codex-legacy-definition',
    }
    let uploadGrants = 0
    const client = {
      createMediaUpload: async () => {
        uploadGrants += 1
        throw new Error('stale session must fail before upload')
      },
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env, now: () => 42 }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    trustInstalledCodexHooks(cwd, env)
    writeSessionState('codex-legacy-definition', env, {
      harness: 'codex',
      activation_cwd: cwd,
      last_prompt_at: 42,
      last_stop_at: 41,
    })
    writeProjectSession(cwd, env, 'codex-legacy-definition', 42, 'codex')
    io.outLines = []
    io.errLines = []

    expect(await askCommand(deps, 'Ship it?', { title: 'Decision', image: [image], json: true })).toBe(EXIT.usage)
    expect(JSON.parse(io.outLines.join('\n'))).toMatchObject({
      ok: false,
      registered: false,
      code: 'codex_fresh_session_required',
      check_id: 'stop_hook',
      remedy: expect.stringMatching(/start one fresh Codex session.*send one prompt/i),
      user_action: {
        code: 'codex_fresh_session_required',
        harness: 'codex',
        action: 'start_fresh_codex_session',
      },
    })
    expect(uploadGrants).toBe(0)
    expect(readSessionState('codex-legacy-definition', env).pending).toBeUndefined()

    io.outLines = []
    await doctorCommand(deps, {})
    const doctorOutput = io.outLines.join('\n')
    expect(doctorOutput).toMatch(/FAIL\s+Question admission.*activated before the current Stop definition/is)
    expect(doctorOutput).toMatch(/start one fresh Codex session/i)
    expect(doctorOutput).not.toMatch(/Question admission.*hooks install/is)
    const readiness = await assessReadiness(deps)
    expect(readiness.states.find((state) => state.id === 'hooks-question-admission')?.remedy)
      .toMatchObject({
        by: 'user-here',
        summary: expect.stringMatching(/fresh Codex session/i),
        command: 'notifai doctor',
        user_action: {
          code: 'codex_fresh_session_required',
          harness: 'codex',
          action: 'start_fresh_codex_session',
        },
      })
  })

})

/**
 * A CLI newer than its server produced "hook failed, deferring to
 * the terminal", which reads like a flaky network, while escalation was in
 * fact completely broken in production.
 */
describe('a server behind this CLI', () => {

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
      await askCommand(makeDeps(io, client), 'Should I ship this build?', { title: 'Ship decision', wait: true }),
    ).toBe(EXIT.failed)

    expect(io.errLines).toEqual([
      "feature_unavailable: The selected device can't answer questions.",
      'next: Update Notifai on Old phone.',
    ])
    expect(io.errLines.join(' ')).not.toContain('untrusted')
    expect(io.errLines.join(' ')).not.toContain('disagree about the contract')
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

  it('preserves distinct free-text replies as ordered parts to interpret', () => {
    const said = contradictingAnswer([
      view({ seq: 1, device_name: 'iPhone', text: 'Yes' }),
      view({ seq: 2, device_name: 'FurankuMac', text: 'No' }),
    ])
    expect(said).toContain('extend or correct')
    expect(said).not.toContain('superseded')
  })
})


describe('public guidance recovery sequence', () => {

  it('recovers a Projectless Cursor question through check, read and ask --wait', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-question-recovery-'))
    const env = { ...isolatedEnv(cwd), CURSOR_AGENT: '1' }
    const io = new CapturedIo()
    const submit = vi.fn(async () => receipt)
    const client = { submit, replies: async () => replyResponse([reply]), closeReplies: async () => claimedReplyResponse([reply]), putAgentAcknowledgement: async () => ({}) } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd, env }
    const flags = { title: 'Shipping', resumes: 'Ship the selected version', wait: true, projectless: true, json: true }
    expect(await askAuthoredCommand(deps, 'Ship it?', flags)).toBe(EXIT.usage)
    expect(JSON.parse(io.outLines.at(-1)!).code).toBe('guidance_required')
    expect(guidanceCheckCommand(deps)).toBe(EXIT.ok)
    const check = JSON.parse(io.outLines.at(-1)!) as { token: string }
    expect(await readCurrentGuidance(deps, { sessionToken: check.token })).toBe(EXIT.ok)
    expect(await askAuthoredCommand(deps, 'Ship it?', { ...flags, guidanceToken: check.token })).toBe(EXIT.ok)
    expect(submit).toHaveBeenCalledOnce()
    expect(projectEnablementState(projectBinding(cwd, env))).toBe('unset')
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

  it("shows another harness's gap as a line naming that harness, without failing this one", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-other-harness-'))
    const io = new PlainInteractiveIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    const states = [{ id: 'skill', title: 'Agent guidance skill', status: 'gap' as const,
      detail: 'Grok loads outdated guidance', harnesses: ['grok'] }]
    expect(await doctorCommand(deps, {}, { readiness: { states, harness: 'claude-code' } })).toBe(EXIT.ok)
    expect(io.outLines).toEqual(['  --  Agent guidance skill (Grok, not this harness): Grok loads outdated guidance', ...doctorReopenLines(deps)])
    io.outLines = []
    expect(await doctorCommand(deps, {}, { readiness: { states, harness: 'grok' } })).toBe(EXIT.failed)
    expect(io.outLines).toEqual(['FAIL  Agent guidance skill: Grok loads outdated guidance', ...doctorReopenLines(deps)])
  })

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
      expect(humanIo.outLines).toEqual([
        ...(status === 'ready' ? [] : [detail, updateCliCommand(deps)]),
        ...doctorReopenLines(deps),
      ])
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

  it.each(cases.filter(({ status }) => status !== 'ready'))(
    'preserves $name recovery when one capability document is unavailable',
    async ({ support, status, detail }) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-partial-update-discovery-'))
      const client = {
        health: async () => true,
        compatibility: async () => compatibilityWithCli(support),
        capabilities: async (platform: Platform = 'ios') => {
          if (platform === 'android') throw new NetworkError('temporarily offline')
          return CAPABILITIES_V1.describe(platform)
        },
        listDevices: async () => ({ devices: [] }),
        accessStatus: async () => ({ email: 'user@example.test' }),
      } as unknown as ApiClient
      const deps = { ...makeDeps(new CapturedIo(), client), cwd, env: isolatedEnv(cwd) }
      const readiness = await assessReadiness(deps)
      expect(readiness.states.find((state) => state.id === 'contract')).toMatchObject({
        status,
        detail,
        remedy: { command: updateCliCommand(deps) },
        technical: { capability_document_errors: [{ platform: 'android' }] },
      })
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
          missing_on_server: ['agent_acknowledgement', 'session_attendance'],
        },
      },
    })

    expect(
      await doctorCommand(deps, {}, { readiness: { states: [contract!] } }),
    ).toBe(EXIT.ok)
    expect(io.outLines).toEqual(['The service is being updated; try again later.', ...doctorReopenLines(deps)])
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

function compatibilityWithCli(
  overrides: Partial<SupportAssessment>,
): CompatibilityResponse {
  return {
    ...currentCompatibility,
    cli: { ...currentSupport, ...overrides },
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

function doctorReopenLines(deps: CommandDeps): string[] {
  const report = reopenReport(deps.env, deps.hookPlatform ?? process.platform)
  return report.available ? [reopenLine(report)] : []
}

class OutroCapturedIo extends CapturedIo {
  outros: string[] = []

  async outro(message: string) {
    this.outros.push(message)
  }
}
