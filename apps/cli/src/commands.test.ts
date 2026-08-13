import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CapabilityDocument,
  EvidenceSnapshot,
  ListRepliesResponse,
  ReplyView,
  SubmissionReceipt,
  SubmitNotificationRequestT,
} from '@raidiant/notifai-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import type { ClaudeWakeAdapters } from './claude-wake.js'
import {
  askCommand,
  accessStatusCommand,
  buildQuestions,
  assessReadiness,
  capabilitiesCommand,
  configExplainCommand,
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
  contradictingAnswer,
  describeHookFailure,
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
  type CommandDeps,
  type CommandIo,
  type CommandSpinner,
} from './commands.js'
import {
  applyPlan,
  buildHookConfig,
  codexHookIdentityHash,
  codexTrustKey,
  findInstallations,
} from './install-hooks.js'
import { readSessionState, writeProjectSession, writeSessionState } from './hooks.js'
import { nativeSkills as realNativeSkills, type NativeSkill, type NativeSkills, type SkillScope } from './native-skills.js'
import { CONFIG_KEYS, loadConfig, personalProjectConfigPath, stateDir } from './config.js'
import { createLogger, logsDiskUsage, readLogRecords } from './logging.js'
import { hookAdapterPath, inspectHookAdapter } from './hook-adapter.js'
import type { Tone } from './ui/theme.js'

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
    clientFactory: () => client,
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
  created_at: '2026-08-01T18:01:00.000Z',
}

function replyResponse(replies: ReplyView[] = []): ListRepliesResponse {
  return {
    request_id: receipt.request_id,
    reply_expires_at: '2026-08-02T18:00:00.000Z',
    replies,
  }
}

describe('command contracts', () => {
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
      'No active plan or temporary Alpha access for this account.',
      'next: Open https://test.notifai.invalid/support to request Alpha access, then retry.',
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
      await sendCommand(makeDeps(io, client), {
        title: 'T',
        body: 'B',
        project: 'Invalid Project!',
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('project')
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
      flags: { title: 'A title that is deliberately longer than forty characters', body: 'Plain.' },
      warning: /titles work best around 40/i,
    },
    {
      flags: { title: 'Details', body: '**bold Markdown**' },
      warning: /--body looks like Markdown.*--detail/i,
    },
    {
      flags: { title: 'Done · build', body: 'All green.' },
      warning: /Use --kind done/i,
    },
    {
      flags: { title: 'Failed · build', body: 'One integration test failed.' },
      warning: /Use --kind done/i,
    },
    {
      flags: { title: 'Update', body: 'Still relevant.', ttl: 259_201 },
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

    expect(await sendCommand(deps, { title: 'Update', body: 'Still relevant.' })).toBe(EXIT.ok)
    expect(io.errLines.join('\n')).toMatch(/machine-global config/i)
  })

  it('removes unmanaged provider fields from the public send flags', () => {
    const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    expect(source).not.toContain(".option('--badge")
    expect(source).not.toContain(".option('--relevance")
    expect(source).not.toContain(".option('--target-content-id")
    expect(source).toContain('Kind profiles apply automatically')
    expect(source).toContain('Pass --sound or --level only to override')
    expect(source).toContain('override kind profile / saved config')
  })

  it('rejects a question nobody will wait for', async () => {
    // --reply asks; --no-block declares nothing will wait. The answer would be
    // captured server-side and then reachable only by hand, so the user taps a
    // real button and nothing happens — worse than never asking, because it
    // spends their attention and their trust in the channel.
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
        replyWindow: 3_600,
        noBlock: true,
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('notifai ask')
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
    { title: 'Deploy?   ', body: 'Ready.' },
    { title: 'Deployment', body: 'Should I deploy?\n' },
  ])('warns on stderr when $title / $body ends in a question after trimming', async (flags) => {
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient

    expect(await sendCommand(makeDeps(io, client), flags)).toBe(EXIT.ok)
    expect(io.errLines).toEqual([
      'Heads up: this notification ends with a question but has no reply action. Add --reply (and optionally --reply-choice) so it can be answered from the notification.',
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

  it('rejects --reply-choice without the --reply action it configures', async () => {
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
        title: 'Deploy?',
        body: 'Choose when ready.',
        replyChoice: ['Now', 'Later'],
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines).toEqual([
      'Use --reply with --reply-timeout, --reply-window, --reply-choice, or --no-block.',
    ])
  })

  it('keeps a warned JSON send successful and stdout machine-pure', async () => {
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
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
    expect(io.outLines.at(-1)).toBe('reply from iPhone: yes, after the migration')
    const received = readLogRecords(deps.env, { event: ['reply.received'] }).records
    expect(received).toHaveLength(1)
    expect(received[0]?.data).toMatchObject({
      request_id: receipt.request_id,
      sequence: reply.seq,
      device: reply.device_name,
      text: reply.text,
    })
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
    expect(io.outLines.at(-1)).toBe('reply from iPhone: yes, after the migration')
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

  it('prints an NDJSON receipt before waiting and a result record on exit 3', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      submit: async () => receipt,
      replies: async (_requestId: string, options: { waitSeconds: number }) => {
        expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({ type: 'receipt', receipt })
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
    expect(io.outLines).toHaveLength(2)
    // `degraded` is part of the shape on every reply wait, not only when it is
    // true: an agent must be able to read it without knowing it might be absent.
    expect(JSON.parse(io.outLines[1] ?? '{}')).toEqual({
      type: 'reply_result',
      request_id: receipt.request_id,
      replies: [],
      degraded: false,
    })
    expect(io.errLines.join('\n')).toContain(`notifai replies ${receipt.request_id}`)
    expect(io.errLines.join('\n')).toContain(`notifai close ${receipt.request_id}`)
  })

  it('prints the receipt and reply result as two NDJSON records when answered', async () => {
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
    expect(io.outLines).toHaveLength(2)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({ type: 'receipt', receipt })
    expect(JSON.parse(io.outLines[1] ?? '{}')).toEqual({
      type: 'reply_result',
      request_id: receipt.request_id,
      replies: [reply],
      degraded: false,
    })
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
    expect(io.outLines).toEqual(['reply from iPhone: yes, after the migration'])
    expect(readLogRecords(deps.env, { event: ['reply.received'] }).records).toHaveLength(1)
  })

  it('resolves replies --pending through the project session pointer and prints its id', async () => {
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
    }
    writeSessionState('pending-session', deps.env, {
      pending: [{ question: 'Deploy?', request_id: receipt.request_id }],
    })
    writeProjectSession(root, deps.env, 'pending-session', Date.now(), 'codex')

    expect(await repliesCommand(deps, undefined, { pending: true })).toBe(EXIT.ok)
    expect(io.outLines).toEqual([
      `pending request ${receipt.request_id}`,
      'reply from iPhone: yes, after the migration',
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
    expect(io.outLines[0]).toBe('pending request req_first')
    expect(io.outLines[1]).toContain('yes, after the migration')
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

describe('delivery evidence status', () => {
  function snapshot(
    companionReceipt: EvidenceSnapshot['deliveries'][number]['companion_receipt'],
  ): EvidenceSnapshot {
    return {
      request_id: 'req_status_test',
      event: 'tests_passed',
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
      'stop',
    ])
    expect(installed.hooks['beforeSubmitPrompt']?.[0]?.command).toContain(
      'hook user-prompt-submit --owner notifai --harness cursor',
    )
    expect(installed.hooks['stop']?.[0]).toMatchObject({
      command: expect.stringContaining('hook stop --owner notifai --harness cursor'),
      loop_limit: 3,
    })
  })

  it('reports a native Cursor installation through doctor', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-doctor-'))
    const io = new CapturedIo()
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
    expect(io.outLines.some((line) => line.includes('Cursor: send one prompt'))).toBe(true)
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

  it('preserves a foreign inline Stop while collapsing our duplicate definition', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-collapse-'))
    const toml = writeInlineStop(cwd, 'gdh-stop')
    const json = path.join(cwd, '.codex', 'hooks.json')
    const env = isolatedEnv(cwd)
    const io = new CapturedIo()
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
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    const before = io.outLines.join('\n')
    expect(before).toMatch(/hooks \(codex representation\)/)
    expect(before).toMatch(/prefer a single representation/)
    expect(before).toMatch(/Stop handlers will both (run|fire)/i)
    expect(before).toContain('notifai hooks install --harness codex')

    io.outLines = []
    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(EXIT.ok)
    expect(existsSync(json)).toBe(false)
    expect(readFileSync(toml, 'utf8')).toContain('gdh-stop')
    expect(readFileSync(toml, 'utf8')).toContain('--owner notifai')
    expect(io.outLines.join('\n')).toMatch(/collaps/i)

    const installations = findInstallations(cwd, env, deps.hookAdapterHome).filter(
      (installation) => installation.harness === 'codex',
    )
    expect(installations).toHaveLength(1)
    expect(installations[0]?.file).toBe(toml)

    expect(hooksUninstallCommand(deps, { harness: 'codex', scriptPath })).toBe(EXIT.ok)
    expect(readFileSync(toml, 'utf8')).toContain('gdh-stop')
    expect(readFileSync(toml, 'utf8')).not.toContain('--owner notifai')
  })
})

describe('harness activation guidance', () => {
  const execPath = process.execPath
  const scriptPath = fileURLToPath(import.meta.url)

  it('does not require a Claude Code restart for project hook files', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-activation-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(
      hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath }),
    ).toBe(EXIT.ok)

    const output = io.outLines.join('\n')
    expect(output).toContain('Installed claude-code hooks in')
    expect(output).toContain('Send one Claude Code prompt, then check `notifai doctor`.')
    expect(output).not.toMatch(/timeout|asynchronous|600s/i)
  })

  it('does not invent a Codex hook trust gate', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-activation-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(
      EXIT.ok,
    )

    const output = io.outLines.join('\n')
    expect(output).toContain('Send one Codex prompt, then check `notifai doctor`.')
    expect(output).not.toMatch(/trust|approve/i)
  })

  it('names the installed harness in the close, never a different one', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-close-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }

    expect(hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath })).toBe(EXIT.ok)

    const output = io.outLines.join('\n')
    expect(output).toContain('Installed cursor hooks in')
    expect(output).toContain('Send one Cursor prompt, then check `notifai doctor`.')
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
    expect(io.outLines.join('\n')).toContain('Send one OpenCode prompt, then check `notifai doctor`.')
    expect(io.outLines.join('\n')).not.toMatch(/Permission prompts|exactly-once continuation/)
    const pluginFile = path.join(cwd, '.opencode', 'plugins', 'notifai.js')
    const plugin = readFileSync(pluginFile, 'utf8')
    expect(plugin).toContain('const TIMEOUT_MS = 540000')

    io.outLines = []
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('hooks (answer continuation)')
    expect(io.outLines.join('\n')).toContain('no proven answer continuation')
    expect(io.outLines.join('\n')).not.toContain('hooks (adapter)')

    writeFileSync(pluginFile, plugin.replace(/^const ADAPTER_VERSION = .*\n/m, ''))
    io.outLines = []
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('hooks (adapter)')
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
    expect(io.outLines.join('\n')).not.toMatch(/hooks \(duplicates\)/)

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

  it('refuses an enum value the sender would later reject', async () => {
    // `config set sound whatever` used to be written straight to disk: the
    // typo only surfaced when a notification failed to carry the sound.
    const io = new CapturedIo()
    expect(await configSetCommand(configDeps(io), 'sound', 'whatever', { yes: true })).toBe(
      EXIT.usage,
    )
    expect(io.errLines[0]).toContain('default, done, attention, alert, none')
  })

  it('still accepts a legal enum value', async () => {
    const io = new CapturedIo()
    expect(await configSetCommand(configDeps(io), 'sound', 'none', { yes: true })).toBe(EXIT.ok)
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
        approve_url: 'https://test.notifai.invalid/pair/ABCD-EFGH',
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
        message: 'Code: ABCD-EFGH\nhttps://test.notifai.invalid/pair/ABCD-EFGH',
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
        approve_url: 'https://test.notifai.invalid/pair/ABCD-EFGH',
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
      'Approve this machine at: https://test.notifai.invalid/pair/ABCD-EFGH',
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
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_HOME: path.join(cwd, 'codex'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.intros).toEqual(['Notifai doctor'])
    expect(io.checks.some((check) => !check.ok && check.message.startsWith('This machine:'))).toBe(true)
    expect(io.checks.some((check) => check.ok && check.message.startsWith('Protocol version:'))).toBe(true)
    expect(io.outLines).toEqual([])

    // Four tones, not two. A boolean has to round `optional-gap` and `unknown`
    // to pass or fail, and rounding them to pass put a tick beside things the
    // user had declined and beside things nothing had checked.
    const tone = (prefix: string): Tone | undefined =>
      io.checks.find((check) => check.message.startsWith(prefix))?.tone
    expect(tone('This machine:')).toBe('bad')
    expect(tone('Protocol version:')).toBe('ok')
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
})

describe('init', () => {
  const readyIphone = {
    device_id: 'dev_iphone',
    display_name: 'iPhone',
    platform: 'ios' as const,
    permission_status: 'authorized',
    registration_healthy: true,
    reply_protocol_version: 1,
    last_seen_at: '2026-08-05T18:00:00.000Z',
  }

  function setupEvidence(
    requestId: string,
    companionReceipt: EvidenceSnapshot['deliveries'][number]['companion_receipt'],
    device = readyIphone,
  ): EvidenceSnapshot {
    return {
      request_id: requestId,
      event: 'setup_verified',
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

  function setupReceipt(requestId = 'req_setup'): SubmissionReceipt {
    return {
      ...receipt,
      request_id: requestId,
      deliveries: [
        {
          ...receipt.deliveries[0]!,
          device_id: readyIphone.device_id,
          device_name: readyIphone.display_name,
        },
      ],
    }
  }

  function managedSkill(scope: SkillScope, cwd: string): NativeSkill {
    return {
      name: 'notifai',
      scope,
      path: path.join(cwd, '.agents', 'skills', 'notifai'),
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

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    const configPath = path.join(cwd, '.notifai', 'config.toml')
    expect(readFileSync(configPath, 'utf8')).toContain('project = "my-project-')
    // Safe by default: without an explicit --skills opt-in, init only writes
    // configuration and never spawns the skill installer.
    expect(io.outLines.join('\n')).not.toContain('Installing the notifai agent skill')
    expect(io.outLines.join('\n')).not.toContain('All set.')

    io.outLines = []
    expect(await initCommand(deps, { skills: false })).toBe(EXIT.failed)
    // Idempotent: the second run re-derives the same slug and does not reprint
    // doctor's ready-state dump.
    expect(io.outLines.join('\n')).toMatch(/^Next:/m)
    expect(io.outLines.join('\n')).not.toContain('Project identity:')
    expect(readFileSync(configPath, 'utf8')).toContain('project = "my-project-')
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
    expect(out).toContain('notifai login')
    expect(out).toContain('Then re-run `notifai init` and it will pick up from here.')
    // The device gap is real and downstream; it must stay hidden until the
    // sign-in that would let anyone actually check it has happened.
    expect(out).not.toContain('companion app')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('honors an explicit --project-id', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-explicit-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, { projectId: 'Custom Name', skills: false })).toBe(EXIT.failed)
    expect(readFileSync(path.join(cwd, '.notifai', 'config.toml'), 'utf8')).toContain(
      'project = "custom-name"',
    )
  })

  it('run unattended, names the optional steps instead of running or asking about them', async () => {
    // An agent's init must not reach for npx or a prompt.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-agent-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).not.toContain('Installing the notifai agent skill')
    // Never prompted, and never assumed into a change it did not request.
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
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      list: async (scope) => ({
        skills: [
          {
            name: 'notifai',
            scope,
            path: path.join(cwd, '.agents', 'skills', 'notifai'),
            source: 'Raidiant-io/notifai',
            sourceType: 'github',
            sourceUrl: 'https://github.com/Raidiant-io/notifai.git',
            ref: RELEASE_REF,
          },
        ],
      }),
    }
    const readiness = await assessReadiness(
      { ...makeDeps(io, client), cwd, nativeSkills },
      { skillScope: 'project' },
    )
    expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
      status: 'ready',
      detail: `installed from ${SKILLS_SOURCE} in the project scope`,
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
        list: async (selected) => {
          calls.push(selected)
          return { skills: [managedSkill(selected, cwd)] }
        },
      }

      const readiness = await assessReadiness(
        { ...makeDeps(io, client), cwd, nativeSkills },
        { skillScope: scope },
      )
      expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
        status: 'ready',
        detail: `installed from ${SKILLS_SOURCE} in the ${scope} scope`,
      })
      expect(calls).toEqual([scope])
    },
  )

  it.each(['project', 'global'] as const)(
    'does not trust unmanaged same-path content in the %s scope',
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
        list: async (selected) => ({
          skills: [{ ...managedSkill(selected, cwd), source: null, sourceType: null, ref: null }],
        }),
      }

      const readiness = await assessReadiness(
        { ...makeDeps(io, client), cwd, nativeSkills },
        { skillScope: scope },
      )
      expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
        status: 'optional-gap',
        detail: `not installed from ${SKILLS_SOURCE} in ${scope} scope`,
      })
    },
  )

  it('requires an explicit skill scope before unattended installation', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-scope-required-'))
    const io = new CapturedIo()
    let addCalls = 0
    const nativeSkills: NativeSkills = {
      add: async () => {
        addCalls += 1
        return 0
      },
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand({ ...makeDeps(io, {} as ApiClient), cwd, nativeSkills }, { skills: true })).toBe(
      EXIT.usage,
    )
    expect(addCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('--skills-scope project')
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

  it('lets the native interactive flow choose scope and resumes after cancellation', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-cancelled-'))
    const io = new InteractiveIo()
    const calls: { submit: number } = { submit: 0 }
    let receivedScope: SkillScope | undefined = 'global'
    const nativeSkills: NativeSkills = {
      add: async (options) => {
        receivedScope = options.scope
        return 0
      },
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand(setupReadyDeps(io, cwd, nativeSkills, calls), { skills: true, hooks: false })).toBe(
      EXIT.ok,
    )
    expect(receivedScope).toBeUndefined()
    expect(calls.submit).toBe(1)
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('installs every detected project harness when --hooks is set', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-hooks-all-detected-'))
    mkdirSync(path.join(cwd, '.claude'))
    mkdirSync(path.join(cwd, '.codex'))
    const io = new CapturedIo()
    const calls = { submit: 0 }
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      list: async () => ({ skills: [] }),
    }
    const deps = setupReadyDeps(io, cwd, nativeSkills, calls)
    await initCommand(deps, { hooks: true, skills: false })
    const wired = findInstallations(cwd, deps.env, deps.hookAdapterHome).map(
      (installation) => installation.harness,
    )
    expect(wired).toEqual(['claude-code', 'codex'])
    expect(existsSync(path.join(cwd, '.claude', 'settings.local.json'))).toBe(true)
    expect(existsSync(path.join(cwd, '.codex', 'hooks.json'))).toBe(true)
    expect(existsSync(path.join(cwd, '.codex', 'config.toml'))).toBe(false)
    expect(io.outLines.join('\n')).toContain('Installed claude-code hooks')
    expect(io.outLines.join('\n')).toContain('Installed codex hooks')
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
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand(setupReadyDeps(io, cwd, nativeSkills, calls), { skills: true, hooks: false })).toBe(
      EXIT.failed,
    )
    expect(calls.submit).toBe(1)
    expect(io.errLines.join('\n')).toContain('Skill installation failed')
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('tells the user what only they can do when nothing is signed in', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-nocred-'))
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('notifai login')
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

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    expect(asked.some((q) => q.includes('Sign in'))).toBe(false)
    const out = io.outLines.join('\n')
    expect(out).toContain('Opening your browser to approve this machine — Ctrl-C to stop.')
    expect(out).toContain('Next: This machine')
    expect(out).toContain('Then re-run `notifai init` and it will pick up from here.')
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
    expect(out).toContain('https://test.notifai.invalid/support')
    expect(out).toContain('sign in with the same email as this account (alpha@example.com)')
    expect(out).toContain('install Notifai on iPhone or Mac via https://test.notifai.invalid/support')
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
      env: {
        HOME: path.join(cwd, 'home'),
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_HOME: path.join(cwd, 'codex'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        OPENCODE_CONFIG_DIR: path.join(cwd, 'opencode'),
      },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.ok)
    expect(asked.some((q) => q.includes('hooks'))).toBe(true)
    expect(asked.some((q) => q.includes('skill'))).toBe(true)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    // Device wait prompts only after optionals have been considered.
    expect(asked.indexOf(asked.find((q) => q.includes('hooks'))!)).toBeLessThan(
      asked.findIndex((q) => q.includes('Wait here') || q.includes('Open install')),
    )
  })

  it.each([
    ['denied', 'system settings'],
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
    expect(out).toContain(`iPhone (${permission})`)
    expect(out).toContain(expected)
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('waits on the supported device registry, then ends with an observed real receipt', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-device-bridge-'))
    const io = new InteractiveIo()
    let now = 0
    let deviceReady = false
    let submitCalls = 0
    let submittedDraft: SubmitNotificationRequestT | null = null
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: deviceReady ? [readyIphone] : [] }),
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

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    expect(io.prompts).toEqual([
      'Open install instructions in your browser?',
      'Wait here while you finish that on your device?',
    ])
    expect(io.openedUrls).toEqual(['https://test.notifai.invalid/support'])
    expect(io.notes.some((n) => n.message.includes('I will wait up to 10 minutes'))).toBe(true)
    expect(io.spinnerEvents).toContain('stop:iPhone is ready to receive')
    expect(io.spinnerEvents).toContain('stop:Receipt observed from iPhone')
    expect(io.outLines.join('\n')).toContain(
      "Companion Receipt (the app's delivery confirmation) observed from iPhone.",
    )
    expect(io.outLines.join('\n')).toContain('All set.')
    expect(submitCalls).toBe(1)
    expect(submittedDraft?.draft.event).toBe('setup_verified')
    expect(submittedDraft?.draft.targets).toEqual({ mode: 'selected', device_ids: ['dev_iphone'] })

    io.outLines = []
    io.prompts = []
    io.openedUrls = []
    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
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

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
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

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    expect(out).toContain('https://test.notifai.invalid/support')
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

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
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

    await expect(initCommand(deps, { hooks: false, skills: false })).resolves.toBe(EXIT.failed)
    expect(submitCalls).toBe(1)
    expect(io.errLines.join('\n')).toContain('Could not save setup proof req_unwritable')
    expect(io.outLines.join('\n')).toContain('Next: Delivery proof')
  })

  it('treats macOS-only delivery proof as an honest non-blocking caveat', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-macos-proof-'))
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({
        devices: [{ ...readyIphone, device_id: 'dev_mac', display_name: 'Mac', platform: 'macos' }],
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

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    expect(submitCalls).toBe(0)
    const out = io.outLines.join('\n')
    expect(out).toContain('All set.')
    expect(out).toContain('receipt proof needs an iPhone in this release')
    expect(out).not.toContain('Next: Delivery proof')
    expect(out).not.toMatch(/Companion Receipt observed/i)

    // doctor must render the same non-blocking state (not FAIL / not a Next:).
    const doctorIo = new CapturedIo()
    expect(
      await doctorCommand(
        {
          ...makeDeps(doctorIo, client),
          cwd,
          env: isolatedEnv(cwd),
        },
        {},
      ),
    ).toBe(EXIT.ok)
    const doctorOut = doctorIo.outLines.join('\n')
    expect(doctorOut).toMatch(/--\s+Delivery proof:/)
    expect(doctorOut).toContain('receipt proof needs an iPhone')
    expect(doctorOut).not.toMatch(/FAIL\s+Delivery proof:/)
  })

  it('stops login when the approval page reports no Alpha access', async () => {
    const io = new CapturedIo()
    let now = 0
    let polls = 0
    const client = {
      beginPairing: async () => ({
        pairing_id: 'pair_no_plan',
        code: 'NOPE-PLAN',
        approve_url: 'https://test.notifai.invalid/approve?code=NOPE-PLAN',
        expires_at: new Date(60_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => {
        polls += 1
        return {
          status: 'no_active_plan' as const,
          next_action: 'Open https://test.notifai.invalid/support to request Alpha access, then retry.',
        }
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }

    expect(await loginCommand(deps, { open: false })).toBe(EXIT.auth)
    expect(polls).toBe(1)
    expect(io.errLines.join('\n')).toContain('no active plan or temporary Alpha access')
    expect(io.errLines.join('\n')).toContain(
      'Open https://test.notifai.invalid/support to request Alpha access, then retry.',
    )
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
    expect(out).toContain('notifai login')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('scopes proof to each project worktree even on the same paired machine', async () => {
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
        await initCommand(deps, { projectId: 'shared-project', hooks: false, skills: false }),
      ).toBe(EXIT.ok)
    }

    expect(submitCalls).toBe(2)
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

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
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
      detail: `installed from ${SKILLS_SOURCE} in the project scope`,
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

    const payload = JSON.parse(io.outLines[1] ?? '{}') as { degraded: boolean }
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
    expect(said).toMatch(/active Codex session/i)
    expect(said).toContain('notifai hooks install --harness codex')
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
    writeSessionState('codex-other-thread', env, { last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'codex-other-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/active Codex session:.*has not published/i)
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
    writeSessionState('codex-current-thread', env, { last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')
    writeSessionState('claude-concurrent', env, { last_prompt_at: 43, last_stop_at: 43 })
    writeProjectSession(cwd, env, 'claude-concurrent', 43, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(io.outLines).toContain(
      'Question registered. Ask it in the conversation, state the concrete work you will resume when the answer arrives, then end your turn.',
    )
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
    writeSessionState('codex-current-thread', env, { last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(readSessionState('codex-current-thread', env).pending?.[0]?.question).toBe('Ship it?')
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
    writeSessionState('codex-orchestrator', env, { last_prompt_at: 40, last_stop_at: 39 })
    writeProjectSession(cwd, env, 'codex-orchestrator', 40, 'codex')
    writeSessionState('claude-current', env, { last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'claude-current', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(readSessionState('claude-current', env).pending?.[0]?.question).toBe('Ship it?')
    expect(readSessionState('codex-orchestrator', env).pending).toBeUndefined()
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
    writeSessionState('codex-current-thread', env, { last_prompt_at: 42, last_stop_at: 41 })
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
    expect(fired?.detail).toMatch(/Codex: send one prompt/)

    io.errLines = []
    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/Several harness markers are present/i)
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
    writeSessionState('codex-commitment-thread', env, { last_prompt_at: 42, last_stop_at: 41 })
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
    writeSessionState('codex-free-text-thread', env, { last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-free-text-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'What rollout adjustment should I make?', {})).toBe(EXIT.ok)
    expect(io.outLines.join('\n')).toContain(
      'For the free-text answer: state how its content will determine the concrete work you resume.',
    )
  })

  it('refuses a Codex question when the installed Stop definition is no longer trusted', async () => {
    const cwd = scratchDir('notifai-codex-stale-trust-')
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
    const stop = findInstallations(cwd, env)
      .find((installation) => installation.harness === 'codex')
      ?.handlers.find((handler) => handler.event === 'Stop')
    expect(stop).toBeDefined()
    const configFile = path.join(env.CODEX_HOME!, 'config.toml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace(codexHookIdentityHash(stop!), 'sha256:obsolete'),
    )
    writeSessionState('codex-current-thread', env, { last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'codex-current-thread', 42, 'codex')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/Stop.*changed since it was trusted.*\/hooks/is)

    io.outLines = []
    await doctorCommand(deps, {})
    expect(io.outLines.join('\n')).toMatch(/FAIL\s+hooks \(trust\).*Stop/is)
    expect(io.outLines.join('\n')).toMatch(/best-effort.*never writes.*\/hooks/is)
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
    const deps = { ...makeDeps(io, client), cwd, env, nativeSkills }

    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(EXIT.ok)
    io.outLines = []

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    const said = io.outLines.join(' ')
    expect(said).toContain(`installed from ${SKILLS_SOURCE} in the global scope`)
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
    writeSessionState('claude-other', env, { last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'claude-other', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/active Claude Code session:.*has not published/i)
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
    writeSessionState('claude-parent-loop', env, { last_prompt_at: 42, last_stop_at: 41 })
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
    writeSessionState('claude-last-writer', env, { last_prompt_at: 42, last_stop_at: 41 })
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
    writeSessionState('codex-current-thread', env, { last_prompt_at: 42, last_stop_at: 41 })
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
    writeSessionState('claude-current', env, { last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'claude-current', 42, 'claude-code')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/Stop hook has not been observed/)

    const readiness = await assessReadiness(deps)
    const fired = readiness.states.find((state) => state.id === 'hooks-fired')
    expect(fired?.status).toBe('gap')
    expect(fired?.detail).toMatch(/UserPromptSubmit.*Stop has not been observed/)
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
    writeSessionState('opencode-other', env, { last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'opencode-other', 42, 'opencode')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/active OpenCode session:.*has not published/i)
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
    writeSessionState('opencode-current', env, { last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'opencode-current', 42, 'opencode')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/no proven answer continuation/i)
    expect(readSessionState('opencode-current', env).pending).toBeUndefined()
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
    writeSessionState('cursor-live', env, { last_prompt_at: 42, last_stop_at: 41 })
    writeProjectSession(cwd, env, 'cursor-live', 42, 'cursor')
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toMatch(/does not expose an exact session id/i)
    expect(readSessionState('cursor-live', env).pending).toBeUndefined()
  })

  it('fails doctor when another harness looks healthy but the active Claude Code session does not', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-active-claude-doctor-'))
    const io = new CapturedIo()
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
    writeSessionState('codex-live', env, { last_prompt_at: 42 })
    writeProjectSession(cwd, env, 'codex-live', 42, 'codex')
    io.outLines = []

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toMatch(/FAIL\s+Question routing:.*active Claude Code/is)
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
    expect(pointer?.detail).toMatch(/has not published a live pointer/)
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
    const io = new CapturedIo()
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
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: isolatedEnv(cwd) }
    expect(hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath })).toBe(
      EXIT.ok,
    )
    mkdirSync(path.join(cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(cwd, '.notifai', 'config.local.toml'), 'ask_grace_seconds = 300\n')
    io.outLines = []

    await doctorCommand(deps, {})
    expect(io.outLines.join('\n')).toMatch(/ok\s+hooks \(stop shape\)/)
  })

  it('names an old blocking Claude Stop handler as the reason no wake can happen', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-stale-shape-'))
    const io = new CapturedIo()
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
    expect(out).toMatch(/FAIL\s+hooks \(stop shape\)/)
    expect(out).toContain('needs `async: true`')
    expect(out).toContain('kills the backgrounded waiter at its 600s default')
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
      peerProtocol: 1,
      messagingSocketPath: socket,
      status: 'idle',
    }))

    await doctorCommand(deps, {})
    const out = io.outLines.join('\n')
    expect(out).toMatch(/ok\s+hooks \(wake route\)/)
    expect(out).toContain(socket)
    expect(out).toContain('an answer can start a turn here without you')
    // Doctor never widens the user's inbound policy to make Notifai work: the
    // poster is the session's own hook child and needs no such permission.
    expect(out).not.toContain('crossSessionInbound')
  })

  it('names a --bare session as the reason an answer would wait for the next turn', async () => {
    const io = new CapturedIo()
    const { deps } = claudeWakeDeps(io, () => {
      throw new Error('ENOENT: no such file or directory')
    })

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed) // unreachable test server
    const out = io.outLines.join('\n')
    // Honest, and not a blocker: nothing is lost, it simply arrives later.
    expect(out).toMatch(/--\s+hooks \(wake route\)/)
    expect(out).toContain('`--bare` binds no inbox socket')
    expect(out).toContain("at this session's next turn")
    expect(out).not.toMatch(/FAIL\s+hooks \(wake route\)/)
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
    const io = new CapturedIo()
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
    expect(out).toMatch(/ok\s+hooks \(wake route\)/)
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

  it('tells Claude Code to send a prompt without falsely requiring a restart', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-firstrun-'))
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    applyPlan(path.join(cwd, '.claude', 'settings.local.json'), {
      hooks: buildHookConfig({
        adapterPath: path.join(cwd, 'notifai', 'hook-adapter'),
      }),
    })

    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: { XDG_STATE_HOME: cwd } }

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    const said = io.errLines.join(' ')
    expect(said).toMatch(/project hook files reload without a restart/i)
    expect(said).not.toMatch(/Run `notifai hooks install` and send one prompt/)
  })

  it('gives Cursor its prompt-and-doctor activation path', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-first-run-'))
    const io = new CapturedIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: isolatedEnv(cwd),
    }

    expect(hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath })).toBe(EXIT.ok)
    io.outLines = []

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/Cursor: send one prompt, then run `notifai doctor`/)
  })

  it('keeps OpenCode activation separate from unsupported answer continuation', () => {
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

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    const said = io.errLines.join(' ')
    expect(said).toMatch(/OpenCode: restart it, then send one prompt/)
    expect(said).toContain('non-blocking question continuation is intentionally unsupported')
  })

  it('says to install when nothing is installed at all', () => {
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

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/hooks install/)
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

  it('doctor uses alpha-user wording when the server is behind the CLI', async () => {
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      // A server one schema version behind this build.
      capabilities: async () => ({ schema_version: 0, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skew-'))
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test store' },
    } as CommandDeps

    await doctorCommand(deps, {})

    const said = io.outLines.concat(io.errLines).join(' ')
    // The label is the user's word for it; the detail is what must survive.
    expect(said).toMatch(/Protocol version/)
    expect(said).toMatch(/service is being updated/)
    expect(said).not.toMatch(/needs deploying/)
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

describe('question sets', () => {
  it('maps --reply-multi into the single question', async () => {
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
        replyChoice: ['CLI', 'Server', 'Apps'],
        replyMulti: true,
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.reply?.questions?.[0]).toMatchObject({
      text: 'Which fronts?',
      multi: true,
    })
    expect(submitted?.draft.reply?.questions?.[0]?.choices).toHaveLength(3)
  })

  it('rejects a question body too long for the answering surface', async () => {
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
        body: 'x'.repeat(501),
        reply: true,
        replyTimeout: 30,
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join(' ')).toContain('--detail')
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

  it('rejects forms outside the documented shape', () => {
    expect(buildQuestions({ form: 'not json' }, undefined)).toMatchObject({ ok: false })
    expect(
      buildQuestions({ form: JSON.stringify({ questions: [] }) }, undefined),
    ).toMatchObject({ ok: false })
    expect(
      buildQuestions(
        { form: JSON.stringify({ questions: Array.from({ length: 5 }, (_, i) => ({ text: `Q${i}?` })) }) },
        undefined,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('1-4') })
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
