import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import {
  type ListRepliesResponse,
  type ReplyView,
  type SubmissionReceipt,
  type SubmitNotificationRequestT,
} from '@raidiant/notifai-protocol'
import { describe, expect, it, vi } from 'vitest'
import { ApiCallError, type ApiClient } from './client.js'
import { CLAUDE_POST_SEND_LIVENESS_MS, type ClaudeWakeAdapters } from './claude-wake.js'
import type { CodexWakeAdapters, CodexWakeObservation } from './codex-wake.js'
import { readStdinWithTimeout } from './hook-input.js'
import {
  activeLogPath,
  bootstrapLogger,
  createLogger,
  readLogRecords,
  type LogRecord,
} from './logging.js'
import { EXIT, askCommand, buildQuestions, hookRunCommand, type CommandDeps, type CommandIo } from './commands.js'
import {
  loadConfig,
  personalProjectConfigPath,
  projectSessionPointerPath,
  sanitizeSessionId,
  sessionConfigPath,
  stateDir,
} from './config.js'
import {
  claimQuestionPush,
  clearSessionState,
  dropPendingQuestion,
  drainRetirements,
  drainOrphanRetirements,
  handleSessionEnd,
  runEscalationWaiter,
  MAX_CONTINUATION_COUNT,
  MAX_HELD_DELIVERIES,
  orphanRetirements,
  pendingAnsweredByPrompt,
  pruneAbandonedSessions,
  releaseQuestionPush,
  readMatchingProjectSessionPointer,
  readProjectSession,
  readSessionState,
  registerQuestion as persistQuestion,
  writeProjectSession,
  writeSessionState as persistSessionState,
  type PendingQuestion,
  type SessionState,
} from './hooks.js'
import { REPLY_MAX_WINDOW_SECONDS } from '@raidiant/notifai-protocol'
import { QUESTION_STOP_TIMEOUT_SECONDS } from './install-hooks.js'
import { QUESTION_WAITER_CEILING_SECONDS } from './question-timing.js'
import { GUIDANCE_CONTEXT_MAX_BYTES } from './guidance-render.js'
import {
  disableProject,
  enableProject,
  projectBinding,
  projectEnabled,
} from './project-enablement.js'

/** New-format test fixtures always carry the canonical body explicitly. */
function registerQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  question: PendingQuestion,
  now?: number,
): void {
  persistQuestion(
    sessionId,
    env,
    { ...question, body: question.body ?? question.question },
    now,
  )
}

function writeSessionState(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  state: SessionState,
): void {
  persistSessionState(sessionId, env, {
    ...state,
    ...(state.pending === undefined
      ? {}
      : {
          pending: state.pending.map((entry) => ({
            ...entry,
            body: entry.body ?? entry.question,
          })),
        }),
  })
}

class CapturedIo implements CommandIo {
  outLines: string[] = []
  errLines: string[] = []
  out(line: string) {
    this.outLines.push(line)
  }
  err(line: string) {
    this.errLines.push(line)
  }
  async confirm() {
    return false
  }
  openUrl() {}
}

interface Recorder {
  submitted: SubmitNotificationRequestT[]
  /** `submitted[i]`'s request id, so a test can name what it just sent. */
  receipts: string[]
  /** Stable test aliases survive the fresh client created for each hook. */
  aliases: Map<string, number>
  closed: string[]
  /** Simulates an offline machine; retirement has to survive one. */
  failSubmits?: boolean
  /** Simulates an unreachable close fence so retirement stays queued. */
  failCloses?: boolean
  /** Runs while an agent_question submit is in flight, before onSubmitted. */
  beforeQuestionSubmit?: () => void
  /** Lets race tests hold every replies call until all contenders are polling. */
  beforeReplies?: () => Promise<void>
  /** Per-request answer stream for multi-question ownership tests. */
  repliesFor?: (requestId: string) => ReplyView[]
  acknowledgementRequiredFor?: (requestId: string) => boolean
  /** The window the server commits to, when a test needs one unlike the waiter's. */
  replyExpiresAt?: string
  /** Whether that request's acknowledgement must carry text; default true. */
  acknowledgementTextRequiredFor?: (requestId: string) => boolean
  acknowledged?: Set<string>
  acknowledgementChecks?: string[]
}

function isQuestionSubmit(entry: { draft: { reply?: unknown } }): boolean {
  return entry.draft.reply !== undefined
}

function isRetirementSubmit(entry: {
  draft: { lifecycle?: { retires_request_id?: string } }
}): boolean {
  return entry.draft.lifecycle?.retires_request_id !== undefined
}

function fakeClient(recorder: Recorder, replies: ReplyView[]): ApiClient {
  let submissions = 0
  const recordedReplies = (requestId: string): ReplyView[] => {
    const direct = recorder.repliesFor?.(requestId)
    if (direct !== undefined && direct.length > 0) return direct
    const ordinal = recorder.aliases.get(requestId)
    if (ordinal !== undefined) {
      const legacyAlias = recorder.repliesFor?.(`req_hook_${ordinal}`)
      if (legacyAlias !== undefined) return legacyAlias
    }
    return direct ?? replies
  }
  return {
    beginPairing: notUsed,
    pollPairing: notUsed,
    // Current reply-capable Companion fixtures.
    listDevices: async () => ({
      devices: [
        {
          device_id: 'dev_iphone',
          display_name: 'Furankuphone',
          platform: 'ios' as const,
          permission_status: 'authorized',
          registration_healthy: true,
          capabilities: ['answer'],
          derived_status: 'working',
          last_seen_at: null,
        },
        {
          device_id: 'dev_mac',
          display_name: 'FurankuMac',
          platform: 'macos' as const,
          permission_status: 'authorized',
          registration_healthy: true,
          capabilities: ['answer'],
          derived_status: 'working',
          last_seen_at: null,
        },
      ],
    }),
    capabilities: notUsed,
    evidence: notUsed,
    putAgentAcknowledgement: async (requestId, body) => {
      recorder.acknowledged ??= new Set()
      recorder.acknowledged.add(requestId)
      return {
        status: 'recorded',
        agent_acknowledgement: {
          text: body.text ?? '',
          created_at: new Date(NOW).toISOString(),
        },
      }
    },
    agentAcknowledgement: async (requestId) => {
      recorder.acknowledgementChecks ??= []
      recorder.acknowledgementChecks.push(requestId)
      const required = recorder.acknowledgementRequiredFor?.(requestId) ?? true
      return {
        request_id: requestId,
        agent_acknowledgement_required: required,
        agent_acknowledgement_text_required:
          recorder.acknowledgementTextRequiredFor?.(requestId) ?? true,
        agent_acknowledgement: recorder.acknowledged?.has(requestId)
          ? { text: 'I will continue.', created_at: new Date(NOW).toISOString() }
          : null,
      }
    },
    createMediaUpload: notUsed,
    finalizeMediaUpload: notUsed,
    uploadMedia: notUsed,
    health: async () => true,
    submit: async (body) => {
      if (recorder.failSubmits === true) throw new Error('offline')
      if (body.draft.reply !== undefined) recorder.beforeQuestionSubmit?.()
      recorder.submitted.push(body)
      submissions += 1
      const requestId = body.request_id ?? `req_hook_${submissions}`
      recorder.aliases.set(requestId, recorder.receipts.length + 1)
      recorder.receipts.push(requestId)
      return {
        request_id: requestId,
        reply_expires_at: recorder.replyExpiresAt ?? new Date(NOW + 480_000).toISOString(),
        agent_acknowledgement_required:
          recorder.acknowledgementRequiredFor?.(requestId) ?? true,
        agent_acknowledgement_text_required:
          recorder.acknowledgementTextRequiredFor?.(requestId) ?? true,
        replayed: false,
        overall: 'provider_accepted_all',
        deliveries: [],
        warnings: [],
      } satisfies SubmissionReceipt
    },
    replies: async (requestId) => {
      await recorder.beforeReplies?.()
      return ({
        request_id: requestId,
        reply_expires_at: null,
        agent_acknowledgement_required:
          recorder.acknowledgementRequiredFor?.(requestId) ?? true,
        agent_acknowledgement_text_required:
          recorder.acknowledgementTextRequiredFor?.(requestId) ?? true,
        agent_acknowledgement: recorder.acknowledged?.has(requestId)
          ? { text: 'I will continue.', created_at: new Date(NOW).toISOString() }
          : null,
        replies: recordedReplies(requestId),
      }) satisfies ListRepliesResponse
    },
    closeReplies: async (requestId) => {
      if (recorder.failCloses === true) throw new Error('offline')
      recorder.closed.push(requestId)
      return {
        request_id: requestId,
        reply_expires_at: new Date(NOW).toISOString(),
        agent_acknowledgement_required:
          recorder.acknowledgementRequiredFor?.(requestId) ?? true,
        agent_acknowledgement_text_required:
          recorder.acknowledgementTextRequiredFor?.(requestId) ?? true,
        agent_acknowledgement: recorder.acknowledged?.has(requestId)
          ? { text: 'I will continue.', created_at: new Date(NOW).toISOString() }
          : null,
        replies: recordedReplies(requestId),
      } satisfies ListRepliesResponse
    },
  } as ApiClient
}

function notUsed(): never {
  throw new Error('not used in these tests')
}

function reply(overrides: Partial<ReplyView> = {}): ReplyView {
  return {
    reply_id: 'rpl_test',
    seq: 1,
    delivery_id: 'del_test',
    device_id: 'dev_test',
    device_name: 'Furankuphone',
    text: 'Allow',
    answers: [{ question_id: 'q1', choice_ids: ['allow'], text: null }],
    source: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

interface Harness {
  deps: CommandDeps
  io: CapturedIo
  recorder: Recorder
  env: NodeJS.ProcessEnv
  advanceClock(milliseconds: number): void
}

const NOW = 1_800_000_000_000

function harness(replies: ReplyView[] = []): Harness {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hooks-'))
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
  }
  const io = new CapturedIo()
  const recorder: Recorder = { submitted: [], receipts: [], closed: [], aliases: new Map() }
  // Virtual clock: sleeps advance it instead of costing wall time. A frozen
  // clock would make the reply poll's deadline unreachable and spin forever.
  let clock = NOW
  const binding = projectBinding(root, env)
  if (binding === null) throw new Error('test Project binding unavailable')
  enableProject(binding, new Date(NOW))
  return {
    io,
    recorder,
    env,
    advanceClock(milliseconds: number) {
      clock += milliseconds
    },
    deps: {
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
      env,
      cwd: root,
      clientFactory: () => fakeClient(recorder, replies),
      now: () => clock,
      sleep: async (milliseconds: number) => {
        clock += milliseconds
      },
    },
  }
}

function runFixtureGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function initializeFixtureRepository(root: string, branch = 'branch-a'): void {
  runFixtureGit(root, 'init')
  runFixtureGit(root, 'config', 'user.email', 'notifai-tests@example.invalid')
  runFixtureGit(root, 'config', 'user.name', 'Notifai Tests')
  writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n')
  runFixtureGit(root, 'add', 'tracked.txt')
  runFixtureGit(root, 'commit', '-m', 'fixture')
  runFixtureGit(root, 'branch', '-M', branch)
}

function stdin(payload: unknown): () => Promise<string> {
  return async () => JSON.stringify(payload)
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  failure: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(failure)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface SessionEndLogLockHolder {
  child: ChildProcess
  readyPath: string
  releasePath: string
  done: Promise<void>
}

function runSessionEndLogLockHolder(
  root: string,
  env: NodeJS.ProcessEnv,
  lockPath: string,
): SessionEndLogLockHolder {
  const readyPath = path.join(root, 'session-end-log-lock-ready')
  const releasePath = path.join(root, 'session-end-log-lock-release')
  const vitest = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
  const child = spawn(
    process.execPath,
    [
      vitest,
      'run',
      'src/session-end-log-lock-worker.test.ts',
      '--reporter=dot',
      '--maxWorkers=1',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        NOTIFAI_SESSION_END_LOG_LOCK_WORKER_MODE: 'hold',
        NOTIFAI_SESSION_END_LOG_LOCK_PATH: lockPath,
        NOTIFAI_SESSION_END_LOG_LOCK_READY: readyPath,
        NOTIFAI_SESSION_END_LOG_LOCK_RELEASE: releasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            `SessionEnd log lock worker exited ${String(code)}\n${Buffer.concat(stdout).toString()}\n${Buffer.concat(stderr).toString()}`,
          ),
        )
      }
    })
  })
  void done.catch(() => undefined)
  return { child, readyPath, releasePath, done }
}

interface CliProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
}

function runSessionEndCli(
  env: NodeJS.ProcessEnv,
  cwd: string,
  sessionId: string,
): { child: ChildProcess; done: Promise<CliProcessResult> } {
  const startedAt = Date.now()
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'dist', 'main.js'),
      'hook',
      'session-end',
      '--owner',
      'notifai',
      '--harness',
      'codex',
    ],
    {
      cwd,
      env: { ...process.env, ...env, NOTIFAI_CREDENTIALS: 'file' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdin!.end(JSON.stringify({ session_id: sessionId, cwd }))
  const done = new Promise<CliProcessResult>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        durationMs: Date.now() - startedAt,
      })
    })
  })
  void done.catch(() => undefined)
  return { child, done }
}

function writeGlobalConfig(h: Harness, toml: string): void {
  const dir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'config.toml'), toml)
}

/** Long enough ago that no test is accidentally sensitive to the stamp. */
const AWAY = NOW - 600_000

describe('the waiter wall clock', () => {
  it('keeps both ownership routes alive beyond the longest answer window', () => {
    expect(QUESTION_WAITER_CEILING_SECONDS).toBeGreaterThan(REPLY_MAX_WINDOW_SECONDS)
  })

  it('stays under the timeout every Question Routing Stop declares', () => {
    expect(QUESTION_WAITER_CEILING_SECONDS).toBeLessThan(QUESTION_STOP_TIMEOUT_SECONDS)
  })
})

describe('pushing a registered question', () => {
  it('keeps unknown future session keys through an older read-modify-write', () => {
    const h = harness([])
    const sessionId = 'future-session-format'
    const file = path.join(stateDir(h.env), 'sessions', `${sanitizeSessionId(sessionId)}.json`)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify({
        last_prompt_at: NOW,
        future_session_key: { nested: ['kept'] },
      })}\n`,
    )

    registerQuestion(sessionId, h.env, { question: 'Still preserved?' }, NOW)

    const rewritten = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(rewritten['future_session_key']).toEqual({ nested: ['kept'] })
    expect(rewritten['pending']).toHaveLength(1)
  })

  // Found by a live Claude Code session: a spawned agent always has a
  // just-set last_prompt_at, and the routing gate once read that as the user
  // being present — so its FIRST question could never escalate, which is the
  // "kick off agents and walk away" case the feature exists for.
  it('pushes a freshly spawned session first question', async () => {
    const h = harness([reply({ text: 'Yes' })])
    // Prompt 20s ago, exactly as a just-spawned agent has.
    writeSessionState('spawn1', h.env, { last_prompt_at: NOW - 20_000 })
    registerQuestion('spawn1', h.env, { question: 'Ship it?' }, NOW)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'spawn1' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    expect(h.recorder.submitted[0]?.draft.targets).toEqual({
      mode: 'selected',
      device_ids: ['dev_iphone', 'dev_mac'],
    })
    expect(h.recorder.submitted[0]?.draft.presentation).toMatchObject({
      title: 'Ship it?',
      body: 'Ship it?',
    })
    // A pushed question is a question, and a question has an attention tone.
    expect(h.recorder.submitted[0]?.draft.platform?.ios?.sound).toBe('attention')
  })

  it('routes a registered question to an answer-capable Android installation', async () => {
    const h = harness([reply({ text: 'Yes' })])
    const client = {
      ...fakeClient(h.recorder, [reply({ text: 'Yes' })]),
      listDevices: async () => ({
        devices: [
          {
            device_id: 'dev_android',
            display_name: 'Pixel',
            platform: 'android' as const,
            permission_status: 'authorized',
            registration_healthy: true,
            capabilities: ['answer'],
            derived_status: 'working',
            last_seen_at: null,
          },
        ],
      }),
    } as ApiClient
    const deps = { ...h.deps, clientFactory: () => client }
    writeSessionState('android-answer', h.env, { last_prompt_at: AWAY })
    registerQuestion('android-answer', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(deps, 'stop', stdin({ session_id: 'android-answer' }))

    expect(h.recorder.submitted[0]?.draft.targets).toEqual({
      mode: 'selected',
      device_ids: ['dev_android'],
    })
    expect(h.recorder.submitted[0]?.draft.platform?.android?.sound).toBe('attention')
  })

  it('keeps sparse alt text paired with its original media item', async () => {
    const h = harness([reply({ text: 'Yes' })])
    writeSessionState('media-order', h.env, { last_prompt_at: AWAY })
    registerQuestion(
      'media-order',
      h.env,
      {
        question: 'Which image should ship?',
        body: 'Compare ![the second image](media:med_second).',
        media: [
          { media_id: 'med_first' },
          { media_id: 'med_second', alt: 'Second image' },
        ],
      },
      NOW,
    )

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'media-order' }))

    expect(h.recorder.submitted[0]?.draft.presentation.media).toEqual([
      { media_id: 'med_first' },
      { media_id: 'med_second', alt: 'Second image' },
    ])
  })

  it('keeps Project identity out of the substantive question title', async () => {
    const h = harness([reply({ text: 'Yes' })])
    const projectDir = path.join(h.deps.cwd, '.notifai')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      path.join(projectDir, 'config.toml'),
      'project = "notifai-cli"\nask_grace_seconds = 0\n',
    )
    writeSessionState('project-title', h.env, { last_prompt_at: AWAY })
    registerQuestion(
      'project-title',
      h.env,
      { question: 'Ship it?', project: 'notifai-cli' },
      NOW,
    )

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'project-title', cwd: h.deps.cwd }))

    expect(h.recorder.submitted[0]?.draft.presentation.title).toBe('Ship it?')
    expect(h.recorder.submitted[0]?.draft.project).toBe('notifai-cli')
  })
})

/**
 * A hook's decisions are invisible from everywhere else: its stderr belongs to
 * the harness, and its usual outcome is to do nothing at all. These are the
 * tests that the local log closes that gap — that "my question never reached my
 * phone" has an answer rather than a silence.
 */
describe('what the hook leaves behind', () => {
  function recording(h: Harness): CommandDeps {
    return { ...h.deps, logger: createLogger({ env: h.env, cmd: 'hook stop' }) }
  }

  function gates(h: Harness): LogRecord[] {
    return readLogRecords(h.env, { event: ['hook.gate'], limit: 50 }).records
  }

  it('records why a question was held, in a name a filter can match', async () => {
    const h = harness([])
    writeSessionState('held', h.env, { accepted: undefined })
    registerQuestion('held', h.env, { question: 'Ship it?' }, NOW)
    // A continuation turn must not re-ask the question it is continuing from.
    writeSessionState('held', h.env, {
      ...readSessionState('held', h.env),
      continuation: { answered_at: NOW + 1000, count: 1 },
    })

    await hookRunCommand(
      recording(h),
      'stop',
      stdin({ session_id: 'held', cwd: h.deps.cwd, stop_hook_active: true }),
    )

    const held = gates(h).find((record) => record.data?.['reason'] === 'continuation-repeat')
    expect(held).toBeDefined()
    expect(held!.data).toMatchObject({ verdict: 'held' })
    expect(h.recorder.submitted).toHaveLength(0)
  })

  it('records the switch being off, which the user is deliberately never told', async () => {
    // Silent to the user by design, so from outside "you turned it off" and "a
    // bug ate my question" look identical. This is what tells them apart.
    const h = harness([])
    const dir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'config.toml'), 'ask_notifications = false\n')
    writeSessionState('off', h.env, { last_prompt_at: AWAY })
    registerQuestion('off', h.env, { question: 'Ship it?' })

    await hookRunCommand(recording(h), 'stop', stdin({ session_id: 'off', cwd: h.deps.cwd }))

    expect(h.recorder.submitted).toHaveLength(0)
    // Nothing was printed, and the log is the only account of it.
    expect(h.io.errLines.join('\n')).not.toContain('notifications')
    expect(gates(h).map((record) => record.data?.['reason'])).toContain('notifications-off')
  })

  it('records a turn with no question at all, so "did the hook run" is answerable', async () => {
    const h = harness()
    await hookRunCommand(recording(h), 'stop', stdin({ session_id: 'quiet', cwd: h.deps.cwd }))
    const events = readLogRecords(h.env, { limit: 50 }).records.map((record) => record.event)
    expect(events).toContain('hook.start')
    expect(events).toContain('hook.end')
    expect(gates(h).map((record) => record.data?.['reason'])).toContain('no-question')
  })

  it('lets the hook project re-enable a bootstrap logger and records resolved config', async () => {
    const h = harness()
    writeGlobalConfig(h, 'log_level = "off"\n')
    const startup = path.join(h.deps.cwd, 'startup')
    const project = path.join(h.deps.cwd, 'project')
    mkdirSync(startup, { recursive: true })
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    writeFileSync(
      path.join(project, '.notifai', 'config.toml'),
      'project = "hook-project"\nlog_level = "debug"\n',
    )
    const deps = { ...h.deps, cwd: startup, logger: bootstrapLogger({ env: h.env, cwd: startup }) }

    await hookRunCommand(deps, 'stop', stdin({ session_id: 'reenabled', cwd: project }))

    const records = readLogRecords(h.env, { limit: 50 }).records
    expect(records.map((record) => record.event)).toEqual(
      expect.arrayContaining(['config.resolved', 'hook.start', 'hook.end']),
    )
    expect(records.find((record) => record.event === 'config.resolved')).toMatchObject({
      project: 'hook-project',
      session: 'reenabled',
    })
  })

  it('persists an answer once while still reporting it to the harness', async () => {
    const h = harness([reply({ text: 'Allow exactly once' })])
    writeSessionState('answer-log', h.env, { last_prompt_at: AWAY })
    registerQuestion('answer-log', h.env, { question: 'Ship it?' })

    await hookRunCommand(
      recording(h),
      'stop',
      stdin({ session_id: 'answer-log', cwd: h.deps.cwd }),
    )

    const raw = readFileSync(activeLogPath(h.env), 'utf8')
    expect(raw).not.toContain('Allow exactly once')
    const answerRecords = readLogRecords(h.env, { event: ['hook.answer'] }).records
    expect(answerRecords.map((record) => record.data?.['stage'])).toEqual([
      'queued',
      'delivered',
    ])
    expect(h.io.errLines.join('\n')).toContain('Allow exactly once')
  })

  it('records the push and ties it to the request id the server knows', async () => {
    const h = harness([])
    const dir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'config.toml'), 'ask_grace_seconds = 0\n')
    writeSessionState('pushed', h.env, { last_prompt_at: AWAY })
    registerQuestion('pushed', h.env, { question: 'Ship it?' })

    await hookRunCommand(recording(h), 'stop', stdin({ session_id: 'pushed', cwd: h.deps.cwd }))

    const pushed = readLogRecords(h.env, { event: ['hook.pushed'] }).records
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.data).toMatchObject({ ok: true })
    // The local record and the server's evidence trail share one id, which is
    // what makes `notifai logs --request <id>` and `notifai status <id>` two
    // views of one thing.
    expect(pushed[0]!.data!['request_id']).toBe(h.recorder.receipts[0])
  })

  it('stores every request in a multi-question wait as a structured identity', async () => {
    const h = harness([])
    writeSessionState('request-log', h.env, { last_prompt_at: AWAY })
    registerQuestion('request-log', h.env, { question: 'Ship it?' }, NOW)
    registerQuestion('request-log', h.env, { question: 'Deploy it?' }, NOW + 1)

    await hookRunCommand(
      recording(h),
      'stop',
      stdin({ session_id: 'request-log', cwd: h.deps.cwd }),
    )

    const unanswered = readLogRecords(h.env, { event: ['hook.answer'] }).records.at(-1)
    expect(unanswered?.data?.['request_ids']).toEqual(h.recorder.receipts)
    expect(readSessionState('request-log', h.env).pending).toBeUndefined()

    for (const requestId of h.recorder.receipts) {
      const matching = readLogRecords(h.env, { request: requestId }).records
      expect(matching).toContainEqual(unanswered)
    }
    expect(readLogRecords(h.env, { request: 'req_hook' }).records).not.toContainEqual(unanswered)
  })

  it('records a config parse failure as a complete fail-open lifecycle', async () => {
    const h = harness()
    mkdirSync(path.join(h.deps.cwd, '.notifai'), { recursive: true })
    writeFileSync(path.join(h.deps.cwd, '.notifai', 'config.toml'), 'not valid = [toml')

    await hookRunCommand(
      { ...h.deps, logger: createLogger({ env: h.env }) },
      'stop',
      stdin({ session_id: 'bad-config', cwd: h.deps.cwd }),
    )

    const records = readLogRecords(h.env, { limit: 10 }).records
    expect(records.map((record) => record.event)).toEqual(['hook.start', 'hook.end'])
    expect(records.at(-1)?.data).toMatchObject({ outcome: 'failed', reason: 'config-failed' })
  })

  it('records a hook failure with the server own words, not just that it failed', async () => {
    const h = harness()
    const deps: CommandDeps = {
      ...recording(h),
      clientFactory: () => {
        throw new ApiCallError(422, 'validation_failed', 'draft rejected', null, [
          { path: '/draft/lifecycle' },
        ])
      },
    }
    registerQuestion('broken', h.env, { question: 'Ship it?' })
    writeSessionState('broken', h.env, { last_prompt_at: AWAY })

    await hookRunCommand(deps, 'stop', stdin({ session_id: 'broken', cwd: h.deps.cwd }))

    const failures = readLogRecords(h.env, { level: 'error' }).records
    expect(failures.length).toBeGreaterThan(0)
    expect(JSON.stringify(failures)).toContain('/draft/lifecycle')
    expect(JSON.stringify(failures)).toContain('validation_failed')
  })

  it('never writes the machine credential, whatever the hook did', async () => {
    const h = harness([])
    const dir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'config.toml'), 'ask_grace_seconds = 0\n')
    writeSessionState('secret', h.env, { last_prompt_at: AWAY })
    registerQuestion('secret', h.env, { question: 'Ship it?' })

    await hookRunCommand(recording(h), 'stop', stdin({ session_id: 'secret', cwd: h.deps.cwd }))

    // The log is the artefact most likely to be pasted into a conversation.
    const raw = readFileSync(activeLogPath(h.env), 'utf8')
    expect(raw).not.toContain('test-secret')
    expect(raw).not.toContain('nfm_mac_test')
  })
})

/**
 * Wanting notifications while still at the machine is a legitimate setting —
 * nobody should have to stop using their computer in order to be reached.
 * Presence is a precondition only while the user wants it to be, and switching
 * it off must not disturb the grace timer.
 */
describe('terminal-first grace window', () => {
  /** Registers a question asked `agoMs` ago. */
  function pending(h: Harness, session: string, agoMs: number): void {
    writeSessionState(session, h.env, { last_prompt_at: AWAY })
    registerQuestion(session, h.env, { question: 'Ship it?' }, NOW - agoMs)
  }

  it('pushes as soon as the turn ends when no window is configured', async () => {
    const h = harness([])
    let submittedAt: number | undefined
    h.recorder.beforeQuestionSubmit = () => {
      submittedAt = h.deps.now?.()
    }
    // The user typed this very instant. It changes nothing: the waiter does
    // not hold their terminal, so their being here is not a reason to wait.
    writeSessionState('present1', h.env, { last_prompt_at: NOW })
    registerQuestion('present1', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'present1' }))

    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(1)
    expect(submittedAt).toBe(NOW)
  })

  it('holds the question in the terminal until the window elapses', async () => {
    const h = harness([reply({ text: 'Yes' })])
    writeGlobalConfig(h, 'ask_grace_seconds = 300\n')
    pending(h, 'g1', 0)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'g1' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    // Sleeps advance the virtual clock, so this is proof the wait happened.
    expect(h.deps.now?.()).toBeGreaterThanOrEqual(NOW + 300_000)
  })

  it('counts the window from when the question was sent, not from the turn end', async () => {
    // Asked 290s ago while the agent kept working: only 10s of wait remains.
    const h = harness([reply({ text: 'Yes' })])
    writeGlobalConfig(h, 'ask_grace_seconds = 300\n')
    pending(h, 'g2', 290_000)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'g2' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    expect(h.deps.now?.()).toBeLessThan(NOW + 60_000)
  })

  it('waits the window out on a machine with no idle signal at all', async () => {
    // The timer once refused to run without an idle source to watch, because
    // it was holding a terminal it could not monitor. It holds nothing now.
    const h = harness([])
    writeGlobalConfig(h, 'ask_grace_seconds = 120\n')
    registerQuestion('present3', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'present3' }))

    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(1)
    expect((h.deps.now?.() ?? NOW) - NOW).toBeGreaterThanOrEqual(120_000)
  })

  it('is not a way to switch escalation on when the user has switched it off', async () => {
    // ask_notifications is the "do not reach me" switch and outranks the timer.
    const h = harness([])
    writeGlobalConfig(h, 'ask_grace_seconds = 0\nask_notifications = false\n')
    registerQuestion('present4', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'present4' }))

    expect(h.recorder.submitted).toHaveLength(0)
  })

  it('keeps the longest grace inside the owner startup allowance', async () => {
    // Real timers do not wake on the exact requested millisecond, so the sleep
    // deliberately overshoots the supported six-minute preference.
    const h = harness([reply({ text: 'Yes' })])
    const virtualSleep = h.deps.sleep!
    h.deps.sleep = async (milliseconds: number) => virtualSleep(milliseconds + 1)
    writeGlobalConfig(h, 'ask_grace_seconds = 360\n')
    pending(h, 'g5', 0)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'g5' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    expect(h.deps.now?.()).toBeGreaterThanOrEqual(NOW + 360_000)
    expect(h.deps.now?.()).toBeLessThan(NOW + 361_000)
    expect(
      h.recorder.submitted.find((entry) => isQuestionSubmit(entry))?.draft.reply
        ?.expires_in_seconds,
    ).toBeGreaterThanOrEqual(60)
  })

  it('never pushes a question to a Companion that did not advertise answer', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        listDevices: async () => ({
          devices: (await client.listDevices()).devices.map((device) => ({
            ...device,
            capabilities: [],
          })),
        }),
      } as ApiClient
    }
    writeSessionState('old-companion', h.env, { last_prompt_at: AWAY })
    registerQuestion('old-companion', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'old-companion' }))

    expect(h.recorder.submitted).toHaveLength(0)
    expect(h.io.errLines.join('\n')).toContain('no device can answer a question yet')
  })

  it('charges transport overrun and close time to the one waiter ceiling', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        listDevices: async () => {
          h.advanceClock(20_000)
          return client.listDevices()
        },
        submit: async (body: SubmitNotificationRequestT, waitSeconds: number) => {
          h.advanceClock(20_000)
          return client.submit(body, waitSeconds)
        },
        replies: async (
          requestId: string,
          options: { waitSeconds: number; afterSeq: number },
        ) => {
          // Server hold plus the client's 20s AbortSignal allowance.
          h.advanceClock((options.waitSeconds + 20) * 1000)
          return {
            request_id: requestId,
            reply_expires_at: new Date(NOW + 480_000).toISOString(),
            replies: [],
          }
        },
        closeReplies: async (requestId: string) => {
          h.advanceClock(20_000)
          return client.closeReplies(requestId)
        },
      } as ApiClient
    }
    writeGlobalConfig(h, 'ask_grace_seconds = 250\n')
    pending(h, 'transport-budget', 0)

    await hookRunCommand(h.deps, 'stop', async () => {
      // stdin/config/setup belong to the same invocation budget as polling.
      h.advanceClock(30_000)
      return JSON.stringify({ session_id: 'transport-budget' })
    })

    // This fixture commits a short eight-minute answer window. Transport and
    // the close fence still fit inside the Stop definition's teardown margin.
    expect(h.deps.now?.()).toBeLessThanOrEqual(NOW + 540_000)
    expect(readSessionState('transport-budget', h.env).pending).toBeUndefined()
  })
})

describe('config resolution inside a hook', () => {
  it('reads project config from the session cwd, not the hook process cwd', async () => {
    const h = harness([reply({ choice_id: 'allow' })])
    // A project that has turned the feature off.
    const project = mkdtempSync(path.join(os.tmpdir(), 'notifai-proj-'))
    const localFile = personalProjectConfigPath(project, h.env)
    mkdirSync(path.dirname(localFile), { recursive: true })
    writeFileSync(localFile, 'ask_notifications = false\n')
    writeSessionState('c1', h.env, { last_prompt_at: AWAY })
    registerQuestion('c1', h.env, { question: 'Ship it?' })

    // deps.cwd is elsewhere; only envelope.cwd points at the project. The
    // payload's cwd is the harness's statement of which project this is, and
    // must win over whatever directory we were spawned in.
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'c1', cwd: project }))

    expect(h.recorder.submitted).toEqual([])
    expect(h.io.outLines).toEqual([])
  })
})

describe('nagging guards', () => {
  it('does not ask twice for one question across successive Stops', async () => {
    const h = harness([])
    writeSessionState('n1', h.env, { last_prompt_at: AWAY })
    registerQuestion('n1', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n1' }))
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n1' }))

    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(1)
  })

  it('respects the harness recursion guard', async () => {
    const h = harness([reply({ text: 'Yes' })])
    writeSessionState('n2', h.env, { last_prompt_at: AWAY })
    registerQuestion('n2', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n2', stop_hook_active: true }))

    expect(h.recorder.submitted).toEqual([])
    expect(h.io.outLines).toEqual([])
  })

  it('delivers a new question registered during an answer continuation', async () => {
    const h = harness([reply({ text: 'First answer' })])
    writeSessionState('n3', h.env, { last_prompt_at: AWAY })
    registerQuestion('n3', h.env, { question: 'First question?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n3' }))
    h.recorder.acknowledged ??= new Set()
    h.recorder.acknowledged.add(h.recorder.receipts[0]!)
    await h.deps.sleep?.(1)
    registerQuestion('n3', h.env, { question: 'Follow-up question?' }, (h.deps.now?.() ?? NOW))
    h.io.outLines = []

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n3', stop_hook_active: true }))

    const questions = h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))
    expect(questions.map((entry) => entry.draft.presentation.body)).toEqual([
      'First question?',
      'Follow-up question?',
    ])
    expect(h.io.outLines.join('\n')).toContain('First answer')
  })

  it('stops chained questions at the consecutive continuation cap', async () => {
    const h = harness([])
    writeSessionState('n4', h.env, {
      last_prompt_at: AWAY,
      continuation: { answered_at: NOW - 1, count: 3 },
    })
    registerQuestion('n4', h.env, { question: 'One more?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n4', stop_hook_active: true }))

    expect(h.recorder.submitted).toEqual([])
    expect(readSessionState('n4', h.env).pending?.[0]?.question).toBe('One more?')
    expect(h.io.errLines.join('\n')).toContain('continuation limit (3) reached')
  })

  it('starts the consecutive continuation count over when the user takes a turn', async () => {
    // The cap bounds an agent running on its own. A human at the keyboard is
    // the end of that chain, not another link in it.
    const h = harness([])
    writeSessionState('n5', h.env, {
      continuation: { answered_at: NOW - 1, count: MAX_CONTINUATION_COUNT },
    })

    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'n5' }))

    expect(readSessionState('n5', h.env).continuation).toEqual({
      answered_at: NOW - 1,
      count: 0,
    })
  })
})

describe('late answer collection', () => {
  it('collects an answer that arrived during the resumed model turn', async () => {
    const h = harness([reply({ text: 'Ship it' })])
    writeSessionState('late-stop', h.env, {
      last_prompt_at: AWAY,
      pending: [{
        question: 'Ship it?',
        asked_at: NOW,
        request_id: 'req_live',
        collapse_key: 'collapse-live',
        device_ids: ['dev_iphone'],
        reply_deadline_at: NOW + 60_000,
      }],
    })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'late-stop' }))

    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(0)
    expect(h.recorder.closed).toContain('req_live')
    expect(readSessionState('late-stop', h.env).pending).toBeUndefined()
    expect(h.io.outLines).toHaveLength(1)
    expect(JSON.parse(h.io.outLines[0] ?? '{}')).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('Ship it'),
    })
  })

  it('collects a late answer on UserPromptSubmit and retires it truthfully', async () => {
    const h = harness([reply({ text: 'Hold' })])
    writeSessionState('late-prompt', h.env, {
      last_prompt_at: AWAY,
      pending: [{
        question: 'Ship it?',
        asked_at: NOW,
        request_id: 'req_live',
        collapse_key: 'collapse-live',
        device_ids: ['dev_iphone'],
        reply_deadline_at: NOW + 60_000,
      }],
    })

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'late-prompt', cwd: h.deps.cwd }),
    )

    expect(readSessionState('late-prompt', h.env).accepted?.answers[0]?.reply.text).toBe('Hold')
    expect(h.io.outLines).toEqual([])

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'late-prompt' }))
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}').reason).toContain('Hold')
    // The obligation survives the user typing — that is the whole point of
    // recording it — so the turn after the answer is held for it. Satisfy it
    // the way the agent would, then the retirement proceeds.
    expect(readSessionState('late-prompt', h.env).acknowledgement_due).toHaveLength(1)
    h.recorder.acknowledged = new Set(['req_live'])

    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'late-prompt', stop_hook_active: true }),
    )

    expect(h.recorder.closed).toContain('req_live')
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
    expect(readSessionState('late-prompt', h.env).pending).toBeUndefined()
    expect(readSessionState('late-prompt', h.env).accepted).toBeUndefined()
  })
})

describe('OpenCode answer continuation', () => {
  it('fails closed instead of accepting an answer the idle event cannot deliver', async () => {
    const h = harness([reply({ text: 'Approve' })])
    writeSessionState('open1', h.env, { last_prompt_at: AWAY })
    registerQuestion('open1', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'open1' }), 'opencode')

    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(0)
    expect(h.recorder.closed).toEqual([])
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
    expect(readSessionState('open1', h.env).pending).toBeUndefined()
    expect(h.io.outLines).toEqual([])
    expect(h.io.errLines.join('\n')).toContain('no proven answer continuation')
  })
})

describe('the waiter owning one question to the end', () => {
  it('does not admit a max-window question after setup consumes its allowance', async () => {
    const h = harness([])
    writeGlobalConfig(h, `reply_window_seconds = ${REPLY_MAX_WINDOW_SECONDS}\n`)
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        listDevices: async () => {
          h.advanceClock(10 * 60 * 1000 + 1)
          return client.listDevices()
        },
      } as ApiClient
    }
    writeSessionState('setup-overrun', h.env, { last_prompt_at: AWAY })
    registerQuestion('setup-overrun', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'setup-overrun' }))

    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toEqual([])
    const pending = readSessionState('setup-overrun', h.env).pending?.[0]
    expect(pending?.request_id).toBeUndefined()
    expect(pending?.submission?.request_id).toBeDefined()
    expect(h.io.errLines.join('\n')).toContain('setup consumed the admission allowance')
  })

  it('continues the same turn when the default one-day answer arrives just before expiry', async () => {
    const h = harness([])
    const answerAt = NOW + (86_400 - 10) * 1000
    h.recorder.replyExpiresAt = new Date(NOW + 86_400_000).toISOString()
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        replies: async (
          requestId: string,
          options: { waitSeconds: number; afterSeq: number },
        ) => {
          const remaining = Math.max(0, answerAt - (h.deps.now?.() ?? NOW))
          h.advanceClock(Math.min(options.waitSeconds * 1000, remaining))
          const response = await client.replies(requestId, options)
          return {
            ...response,
            replies:
              (h.deps.now?.() ?? NOW) >= answerAt
                ? [reply({ text: 'Answer near the one-day edge' })]
                : [],
          }
        },
      } as ApiClient
    }
    writeSessionState('full-default-window', h.env, { last_prompt_at: AWAY })
    registerQuestion('full-default-window', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'full-default-window' }),
      'codex',
    )

    expect((h.deps.now?.() ?? NOW) - NOW).toBeGreaterThan(8 * 60 * 1000)
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}').reason).toContain(
      'Answer near the one-day edge',
    )
  })

  it('delivers a reply that commits while the server close fence is finalizing silence', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        replies: async (requestId: string) => ({
          request_id: requestId,
          reply_expires_at: new Date(NOW + 60_000).toISOString(),
          replies: [],
        }),
        closeReplies: async (requestId: string) => {
          h.recorder.closed.push(requestId)
          return {
            request_id: requestId,
            reply_expires_at: new Date(NOW + 60_000).toISOString(),
            replies: [reply({ text: 'Committed at the fence' })],
          }
        },
      } as ApiClient
    }
    writeSessionState('fenced-reply', h.env, { last_prompt_at: AWAY })
    registerQuestion('fenced-reply', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'fenced-reply' }))

    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}').reason).toContain(
      'Committed at the fence',
    )
    expect(readSessionState('fenced-reply', h.env).accepted).toBeDefined()
  })

  it('preserves a silent question when the close fence cannot be proven', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        closeReplies: async () => {
          throw new Error('partitioned during close')
        },
      } as ApiClient
    }
    writeSessionState('unproven-close', h.env, { last_prompt_at: AWAY })
    registerQuestion('unproven-close', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'unproven-close' }))

    const state = readSessionState('unproven-close', h.env)
    expect(state.pending?.[0]?.request_id).toBe(h.recorder.receipts[0])
    expect(state.retiring).toBeUndefined()
    expect(h.io.errLines.join('\n')).toContain('preserving ownership')
  })

  it('recovers an accepted question after its submit response is lost', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    let acceptedRequestId: string | undefined
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async (body: SubmitNotificationRequestT) => {
          if (body.draft.reply === undefined) return client.submit(body, 0)
          acceptedRequestId = body.request_id
          h.recorder.submitted.push(body)
          h.recorder.receipts.push(body.request_id!)
          h.recorder.aliases.set(body.request_id!, 1)
          throw new Error('response lost after commit')
        },
        replies: async (requestId: string) => ({
          request_id: requestId,
          reply_expires_at: new Date(NOW + 60_000).toISOString(),
          replies: requestId === acceptedRequestId ? [reply({ text: 'Yes, recover it' })] : [],
        }),
        closeReplies: async (requestId: string) => ({
          request_id: requestId,
          reply_expires_at: new Date(NOW).toISOString(),
          replies: requestId === acceptedRequestId ? [reply({ text: 'Yes, recover it' })] : [],
        }),
      } as ApiClient
    }
    writeSessionState('ambiguous-submit', h.env, { last_prompt_at: AWAY })
    registerQuestion('ambiguous-submit', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'ambiguous-submit' }))

    expect(acceptedRequestId).toMatch(/^req_[A-Za-z0-9_-]{22,24}$/)
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}').reason).toContain('Yes, recover it')
    expect(readSessionState('ambiguous-submit', h.env).accepted?.answers[0]?.pending.request_id)
      .toBe(acceptedRequestId)
  })

  it('replays the frozen intent when an ambiguous submit never reached the server', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    let firstAttempt: SubmitNotificationRequestT | undefined
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async (body: SubmitNotificationRequestT) => {
          firstAttempt = body
          throw new Error('connection failed before commit')
        },
        replies: async () => {
          throw new ApiCallError(404, 'not_found', 'No such request.')
        },
        closeReplies: async () => {
          throw new ApiCallError(404, 'not_found', 'No such request.')
        },
      } as ApiClient
    }
    writeSessionState('precommit-loss', h.env, { last_prompt_at: AWAY })
    registerQuestion('precommit-loss', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'precommit-loss' }))

    const stranded = readSessionState('precommit-loss', h.env).pending?.[0]
    expect(stranded?.request_id).toBeUndefined()
    expect(stranded?.submission).toBeDefined()
    expect(h.io.errLines.join('\n')).toContain('response was ambiguous')

    h.advanceClock(600_000)
    h.deps.clientFactory = factory
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'precommit-loss' }))

    expect(h.recorder.submitted[0]).toEqual(firstAttempt)
  })

  it('remints a frozen draft after a terminal 422 instead of replaying it', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async () => {
          throw new ApiCallError(401, 'unauthorized', 'Sign in again.')
        },
      } as ApiClient
    }
    writeSessionState('rejected-submit', h.env, { last_prompt_at: AWAY })
    registerQuestion('rejected-submit', h.env, { question: 'Deploy?' }, NOW)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'rejected-submit' }))
    const frozen = readSessionState('rejected-submit', h.env).pending?.[0]?.submission
    if (frozen === undefined) throw new Error('expected a persisted submission intent')

    let submits = 0
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async (body: SubmitNotificationRequestT, waitSeconds: number) => {
          submits += 1
          if (body.request_id === frozen.request_id) {
            throw new ApiCallError(422, 'invalid_request', 'The draft was rejected.', null, [
              { path: 'presentation.detail', message: 'Unexpected property' },
            ])
          }
          return client.submit(body, waitSeconds)
        },
      } as ApiClient
    }
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'rejected-submit' }))

    expect(submits).toBe(2)
    expect(h.recorder.submitted[0]?.request_id).toBeDefined()
    expect(h.recorder.submitted[0]?.request_id).not.toBe(frozen.request_id)
    expect(h.io.errLines.join('\n')).toContain('reminting the draft')
    expect(readSessionState('rejected-submit', h.env).pending).toBeUndefined()
  })

  it('retires a reminted draft that the server still rejects', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async () => {
          throw new ApiCallError(401, 'unauthorized', 'Sign in again.')
        },
      } as ApiClient
    }
    writeSessionState('rejected-forever', h.env, { last_prompt_at: AWAY })
    registerQuestion('rejected-forever', h.env, { question: 'Deploy?' }, NOW)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'rejected-forever' }))
    expect(readSessionState('rejected-forever', h.env).pending?.[0]?.submission).toBeDefined()

    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async () => {
          throw new ApiCallError(422, 'invalid_request', 'The draft was rejected.')
        },
      } as ApiClient
    }
    h.advanceClock(600_000)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'rejected-forever' }))
    expect(readSessionState('rejected-forever', h.env).pending).toBeUndefined()

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'rejected-forever' }))
    expect(h.recorder.submitted).toEqual([])
    expect(h.io.errLines.join('\n')).toContain('retiring the question so it is not retried forever')
  })

  it('retires a freshly minted draft the current contract rejects', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async () => {
          throw new ApiCallError(422, 'invalid_request', 'The draft was rejected.')
        },
      } as ApiClient
    }
    writeSessionState('fresh-422', h.env, { last_prompt_at: AWAY })
    registerQuestion('fresh-422', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'fresh-422' }))

    expect(readSessionState('fresh-422', h.env).pending).toBeUndefined()
    expect(h.io.errLines.join('\n')).toContain('retiring it because the current draft will never be accepted')
  })

  it('preserves a frozen intent after a retryable client rejection', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    let polls = 0
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async () => {
          throw new ApiCallError(401, 'unauthorized', 'Sign in again.')
        },
        replies: async () => {
          polls += 1
          throw new Error('must not poll an unaccepted request')
        },
      } as ApiClient
    }
    writeSessionState('auth-submit', h.env, { last_prompt_at: AWAY })
    registerQuestion('auth-submit', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'auth-submit' }))

    const pending = readSessionState('auth-submit', h.env).pending?.[0]
    expect(pending?.request_id).toBeUndefined()
    expect(pending?.submission?.request_id).toMatch(/^req_[A-Za-z0-9_-]{22,24}$/)
    expect(polls).toBe(0)
    expect(h.io.errLines.join('\n')).toContain('preserving it for recovery')

    const frozen = pending?.submission
    if (frozen === undefined) throw new Error('expected a persisted submission intent')
    writeGlobalConfig(h, 'project = "changed-after-crash"\n')
    h.advanceClock(600_000)
    h.deps.clientFactory = factory
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'auth-submit' }))

    expect(h.recorder.submitted[0]).toEqual({
      request_id: frozen.request_id,
      idempotency_key: frozen.idempotency_key,
      draft: frozen.draft,
    })
  })

  it('does not close silence before the committed answer deadline', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        submit: async (body: SubmitNotificationRequestT, waitSeconds: number) => ({
          ...(await client.submit(body, waitSeconds)),
          // Pin a short real-server deadline so the virtual clock proves the
          // waiter did not borrow even its close fence from the answer window.
          reply_expires_at: new Date(NOW + 60_000).toISOString(),
        }),
      } as ApiClient
    }
    writeSessionState('deadline', h.env, { last_prompt_at: AWAY })
    registerQuestion('deadline', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'deadline' }))

    expect(h.deps.now?.()).toBe(NOW + 60_000)
    expect(h.recorder.closed).toContain(h.recorder.receipts[0])
    expect(readSessionState('deadline', h.env).pending).toBeUndefined()
    expect(h.io.errLines.join('\n')).toContain('expired with its continuation owner')
  })

  it('closes a server window whose committed deadline exceeds its process owner', async () => {
    const h = harness([])
    h.recorder.replyExpiresAt = new Date(
      NOW + (QUESTION_WAITER_CEILING_SECONDS + 60) * 1000,
    ).toISOString()
    writeSessionState('deadline-overrun', h.env, { last_prompt_at: AWAY })
    registerQuestion('deadline-overrun', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'deadline-overrun' }))

    expect(h.recorder.closed).toEqual([h.recorder.receipts[0]])
    expect(readSessionState('deadline-overrun', h.env).pending).toBeUndefined()
    expect(h.io.errLines.join('\n')).toContain('deadline beyond this process owner')
  })

  it('keeps anomalous live state when immediate closure is unreachable', async () => {
    const h = harness([])
    h.recorder.failCloses = true
    h.recorder.replyExpiresAt = new Date(
      NOW + (QUESTION_WAITER_CEILING_SECONDS + 60) * 1000,
    ).toISOString()
    writeSessionState('deadline-recovery', h.env, { last_prompt_at: AWAY })
    registerQuestion('deadline-recovery', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'deadline-recovery' }))

    const live = readSessionState('deadline-recovery', h.env).pending?.[0]
    expect(live?.request_id).toBe(h.recorder.receipts[0])
    expect(h.io.errLines.join('\n')).toContain('preserving the live question')

    h.recorder.failCloses = false
    h.recorder.repliesFor = (requestId) =>
      requestId === live?.request_id ? [reply({ text: 'Recovered answer' })] : []
    h.io.outLines = []
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'deadline-recovery' }))

    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}').reason).toContain('Recovered answer')
  })

  it('parks anomalous retirement when terminal input removes the frozen entry', async () => {
    const h = harness([])
    h.recorder.failCloses = true
    h.recorder.replyExpiresAt = new Date(
      NOW + (QUESTION_WAITER_CEILING_SECONDS + 60) * 1000,
    ).toISOString()
    const factory = h.deps.clientFactory!
    let markClose: (() => void) | undefined
    const closeStarted = new Promise<void>((resolve) => {
      markClose = resolve
    })
    let releaseClose: (() => void) | undefined
    const heldClose = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    h.deps.clientFactory = (...args) => {
      const client = factory(...args)
      return {
        ...client,
        closeReplies: async (requestId: string) => {
          markClose?.()
          await heldClose
          return client.closeReplies(requestId)
        },
      } as ApiClient
    }
    writeSessionState('deadline-prompt-race', h.env, { last_prompt_at: AWAY })
    registerQuestion('deadline-prompt-race', h.env, { question: 'Deploy?' }, NOW)

    const stop = hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'deadline-prompt-race' }),
    )
    await closeStarted
    const frozen = readSessionState('deadline-prompt-race', h.env).pending?.[0]
    if (frozen === undefined) throw new Error('expected frozen submission state')
    dropPendingQuestion('deadline-prompt-race', h.env, frozen)
    releaseClose?.()
    await stop

    expect(
      readSessionState('deadline-prompt-race', h.env).retiring?.map(
        (entry) => entry.request_id,
      ),
    ).toEqual([h.recorder.receipts[0]])
  })

  it('charges sequential submission latency to one owner deadline, not to the answer window', async () => {
    const h = harness([reply({ text: 'Done' })])
    writeSessionState('latency', h.env, { last_prompt_at: AWAY })
    registerQuestion('latency', h.env, { question: 'First?' }, NOW)
    registerQuestion('latency', h.env, { question: 'Second?' }, NOW)
    h.recorder.beforeQuestionSubmit = () => h.advanceClock(40_000)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'latency' }))

    const windows = h.recorder.submitted
      .filter((entry) => isQuestionSubmit(entry))
      .map((entry) => entry.draft.reply?.expires_in_seconds)
    // How long the user may answer does not shrink because this owner spent
    // part of its own budget getting the question out. Both questions stay
    // answerable for the configured window.
    expect(windows).toEqual([86_400, 86_400])
    // Submission latency is charged to the one owner lifetime, without
    // shrinking either server answer window.
    expect(h.deps.now?.()).toBeLessThanOrEqual(
      NOW + QUESTION_WAITER_CEILING_SECONDS * 1000,
    )
  })

  it('re-arms the next Stop for an independently pending answer', async () => {
    const h = harness([])
    const answers = new Map<string, ReplyView[]>([
      ['req_hook_1', [reply({ text: 'First answer' })]],
      ['req_hook_2', []],
    ])
    h.recorder.repliesFor = (requestId) => answers.get(requestId) ?? []
    writeSessionState('successor', h.env, { last_prompt_at: AWAY })
    registerQuestion('successor', h.env, { question: 'First?' }, NOW)
    registerQuestion('successor', h.env, { question: 'Second?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'successor' }))
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}').reason).toContain('First answer')
    expect(readSessionState('successor', h.env).pending?.map((entry) => entry.question)).toEqual([
      'Second?',
    ])

    answers.set('req_hook_2', [reply({ text: 'Second answer' })])
    h.recorder.acknowledged ??= new Set()
    h.recorder.acknowledged.add(h.recorder.receipts[0]!)
    h.io.outLines = []
    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'successor', stop_hook_active: true }),
    )

    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}').reason).toContain('Second answer')
    expect(readSessionState('successor', h.env).pending).toBeUndefined()
    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(2)
  })

  it('does not start another waiter for a live question whose owner lease is already spent', async () => {
    const h = harness([])
    h.recorder.replyExpiresAt = new Date(NOW + 86_400_000).toISOString()
    writeSessionState('spent-owner', h.env, {
      last_prompt_at: AWAY,
      pending: [
        {
          question: 'Old question?',
          asked_at: NOW - 3_300_000,
          request_id: 'req_old',
          collapse_key: 'question-old',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 86_400_000,
          owner_deadline_at: NOW - 1,
        },
      ],
    })

    const started = h.deps.now?.() ?? NOW
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'spent-owner' }))

    expect(h.deps.now?.()).toBeLessThan(started + 30_000)
    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(0)
    expect(readSessionState('spent-owner', h.env).pending?.[0]?.request_id).toBe('req_old')
    expect(h.io.errLines.join('\n')).toContain('previous answer owner ended')
  })

  it('does not re-arm a live question written before owner leases were persisted', async () => {
    const h = harness([])
    h.recorder.replyExpiresAt = new Date(NOW + 86_400_000).toISOString()
    writeSessionState('legacy-spent', h.env, {
      last_prompt_at: AWAY,
      pending: [
        {
          question: 'Degraded waiter leftover?',
          asked_at: NOW - 3_300_000,
          request_id: 'req_ATU4_legacy',
          collapse_key: 'question-legacy',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 86_400_000,
        },
      ],
    })

    const started = h.deps.now?.() ?? NOW
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'legacy-spent' }))

    expect(h.deps.now?.()).toBeLessThan(started + 30_000)
    expect(readSessionState('legacy-spent', h.env).pending?.[0]?.request_id).toBe(
      'req_ATU4_legacy',
    )
  })

  it('pushes and owns a newly registered question after a spent legacy waiter', async () => {
    const h = harness([])
    h.recorder.replyExpiresAt = new Date(NOW + 86_400_000).toISOString()
    writeSessionState('after-degraded', h.env, {
      last_prompt_at: AWAY,
      pending: [
        {
          question: 'Earlier question?',
          asked_at: NOW - 3_300_000,
          request_id: 'req_earlier',
          collapse_key: 'question-earlier',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 86_400_000,
        },
      ],
    })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'after-degraded' }))
    registerQuestion('after-degraded', h.env, { question: 'New question?' }, h.deps.now?.())
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'after-degraded' }))

    const questions = h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))
    expect(questions.map((entry) => entry.draft.presentation.body)).toEqual(['New question?'])
    expect(readSessionState('after-degraded', h.env).pending?.map((entry) => entry.question)).toEqual(
      ['Earlier question?'],
    )
    expect((h.deps.now?.() ?? NOW) - NOW).toBeGreaterThan(8 * 60 * 1000)
  })

  it('still waits out a live owner lease for an independent answer', async () => {
    const h = harness([])
    const answerAt = NOW + 10_000
    h.recorder.repliesFor = (requestId) =>
      requestId === 'req_live' && (h.deps.now?.() ?? 0) >= answerAt
        ? [reply({ text: 'Later' })]
        : []
    writeSessionState('lease', h.env, {
      last_prompt_at: AWAY,
      pending: [
        {
          question: 'Still waiting?',
          asked_at: NOW,
          request_id: 'req_live',
          collapse_key: 'question-live',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 86_400_000,
          owner_deadline_at: NOW + 60_000,
        },
      ],
    })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'lease' }))

    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}').reason).toContain('Later')
    expect(h.deps.now?.()).toBeGreaterThanOrEqual(answerAt)
  })
})

describe('Cursor stop output', () => {
  it('fails closed when the invoking shell cannot name the exact conversation', async () => {
    const h = harness([reply({ text: 'Ship it' })])
    writeSessionState('cursor-conversation', h.env, { last_prompt_at: AWAY })
    registerQuestion('cursor-conversation', h.env, { question: 'Deploy now?' })

    await hookRunCommand(
      h.deps,
      'stop',
      stdin({
        conversation_id: 'cursor-conversation',
        workspace_roots: [h.deps.cwd],
        loop_count: 0,
      }),
      'cursor',
    )

    expect(h.recorder.submitted).toHaveLength(0)
    expect(h.io.outLines).toHaveLength(0)
    expect(h.io.errLines.join('\n')).toContain('asynchronous ask is unsupported')
  })
})

/**
 * Questions never supersede questions — a second ask joins the first, and
 * both reach the user (superseding is reply semantics). What remains from the
 * old supersede model is the retirement debt machinery: a delivered question
 * that dies (the user came back to the terminal) must be truthfully retired
 * even when the network fails at the moment we learn it, because stale
 * questions piling up on a phone teach the user to ignore the surface.
 */
describe('question queueing and retirement debt', () => {
  /** Request ids whose close fence proved retirement. */
  function retirements(h: Harness): string[] {
    return h.recorder.closed
  }

  function seedLive(h: Harness, sessionId: string, requestId = 'req_live'): void {
    writeSessionState(sessionId, h.env, {
      last_prompt_at: AWAY,
      pending: [{
        question: 'Ship it?',
        asked_at: NOW,
        request_id: requestId,
        collapse_key: 'collapse-live',
        device_ids: ['dev_iphone', 'dev_mac'],
        reply_deadline_at: NOW + 60_000,
      }],
    })
  }

  it('registers a second question without mutating the live first question', () => {
    const h = harness([])
    seedLive(h, 'sup1')

    // The agent carried on and asked something else. The first question is
    // still the user's to answer — a second question never ends the first;
    // superseding is reply semantics, not question semantics.
    registerQuestion('sup1', h.env, { question: 'Deploy it?' })

    expect(retirements(h)).toEqual([])
    const live = readSessionState('sup1', h.env).pending
    expect(live).toHaveLength(2)
    expect(live?.map((entry) => entry.question)).toEqual(['Ship it?', 'Deploy it?'])
    expect(live?.map((entry) => entry.request_id)).toEqual(['req_live', undefined])
  })

  it('keeps the ids when the retirement cannot be sent, and retries later', async () => {
    const h = harness([])
    seedLive(h, 'sup2')
    const first = 'req_live'

    // Offline when the user returns: the wipe parks the retirement, the
    // drain fails, and it must not forget what it was for.
    h.recorder.failCloses = true
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'sup2', prompt: 'done' }),
    )
    expect(readSessionState('sup2', h.env).retiring).toHaveLength(1)

    h.recorder.failCloses = false
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup2' }))
    expect(retirements(h)).toContain(first)
    expect(readSessionState('sup2', h.env).retiring).toEqual([])
  })

  it('keeps the original delivery targets when routing changes before retirement', async () => {
    const h = harness([])
    seedLive(h, 'sup-targets')

    const live = readSessionState('sup-targets', h.env).pending?.[0]
    expect(live).toMatchObject({
      request_id: 'req_live',
      device_ids: ['dev_iphone', 'dev_mac'],
    })

    // The user changes their default routing before the question dies.
    // Retirement belongs to the Deliveries that actually carried the
    // question, not to whichever Device Installation is selected now.
    const configDir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, 'config.toml'), 'devices = ["dev_iphone"]\n')
    h.recorder.failCloses = true
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'sup-targets', prompt: 'done' }),
    )

    expect(readSessionState('sup-targets', h.env).retiring).toEqual([
      expect.objectContaining({
        request_id: 'req_live',
        device_ids: ['dev_iphone', 'dev_mac'],
      }),
    ])
    expect(
      h.recorder.submitted.filter((submission) => isRetirementSubmit(submission)),
    ).toHaveLength(0)
  })

  it('sweeps a queued retirement even on a turn continuing from an answer', async () => {
    // stop_hook_active short-circuits the escalation path, but the drain runs
    // before every guard — retirement debt has nothing to do with whether
    // this turn may ask.
    const h = harness([])
    seedLive(h, 'sup3')
    const first = 'req_live'

    h.recorder.failCloses = true
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'sup3', prompt: 'done' }),
    )
    expect(readSessionState('sup3', h.env).retiring).toHaveLength(1)
    h.recorder.failCloses = false

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup3', stop_hook_active: true }))

    expect(retirements(h)).toContain(first)
    expect(readSessionState('sup3', h.env).retiring).toEqual([])
  })

  it('does not lose a queued retirement when the user comes back to the terminal', async () => {
    // UserPromptSubmit resets session state to record presence, and that reset
    // used to take the retirement queue with it.
    const h = harness([])
    seedLive(h, 'sup4')
    const first = 'req_live'

    // The first return is offline: the wipe parks, the drain fails, and the
    // next prompt must still find the debt.
    h.recorder.failCloses = true
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'sup4', prompt: 'done' }),
    )
    h.recorder.failCloses = false

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'sup4', prompt: 'ok' }),
    )

    expect(retirements(h)).toContain(first)
    expect(readSessionState('sup4', h.env).retiring).toEqual([])
  })

  it('parks nothing for questions that never reached a device', async () => {
    // No request_id means there is no notification anywhere to retire, and a
    // retirement push for one would be pure noise. Both questions simply
    // queue.
    const h = harness([])
    registerQuestion('sup5', h.env, { question: 'Ship it?' })
    registerQuestion('sup5', h.env, { question: 'Deploy it?' })

    expect(readSessionState('sup5', h.env).retiring ?? []).toEqual([])
    expect(readSessionState('sup5', h.env).pending?.map((entry) => entry.question)).toEqual([
      'Ship it?',
      'Deploy it?',
    ])
  })
})

describe('several questions in flight', () => {
  /** Route each live request its own replies; the shared list cannot say who answered what. */
  function repliesByRequest(h: Harness, byRequest: Map<string, ReplyView[]>): void {
    h.recorder.repliesFor = (requestId) => byRequest.get(requestId) ?? []
  }

  it('escalates every registered question in one pass, each as its own notification', async () => {
    const h = harness([])
    writeSessionState('multi1', h.env, { last_prompt_at: AWAY })
    registerQuestion('multi1', h.env, { question: 'Ship it?' }, NOW)
    registerQuestion('multi1', h.env, { question: 'Deploy where?' }, NOW + 1)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'multi1' }))

    const questions = h.recorder.submitted.filter((s) => isQuestionSubmit(s))
    expect(questions.map((s) => s.draft.presentation.body)).toEqual(['Ship it?', 'Deploy where?'])
    // Each is its own notification with its own collapse key — one ask never
    // stands in for, or replaces, another.
    expect(new Set(questions.map((s) => s.draft.delivery.collapse_key)).size).toBe(2)
    expect(readSessionState('multi1', h.env).pending).toBeUndefined()
    expect(new Set(h.recorder.closed)).toEqual(new Set(h.recorder.receipts))
  })

  /**
   * A registered form/ask must become a durable server request at turn-end.
   * Codex and Claude both enter through the same Stop
   * handler; the harness flag only changes answer injection, not settlement.
   */
  it('settles a registered form into a durable request_id on the Codex Stop path', async () => {
    const h = harness([])
    writeSessionState('codex-form', h.env, { last_prompt_at: AWAY })
    const built = buildQuestions(
      { form: JSON.stringify({
          questions: [
            { text: 'Start personally?', choices: ['Yes', 'No'] },
            { text: 'Which region?', choices: ['US', 'EU'] },
          ],
        }) },
      undefined,
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    registerQuestion('codex-form', h.env, {
      question: built.questions[0]!.text,
      questions: built.questions,
    })

    // Registration alone must not submit; durability happens at turn-end.
    expect(h.recorder.submitted).toEqual([])
    expect(readSessionState('codex-form', h.env).pending?.[0]?.request_id).toBeUndefined()

    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'codex-form' }),
      'codex',
    )

    expect(h.recorder.submitted.filter((s) => isQuestionSubmit(s))).toHaveLength(1)
    expect(readSessionState('codex-form', h.env).pending).toBeUndefined()
    expect(h.recorder.closed).toContain(h.recorder.receipts[0])
    expect(h.io.errLines.join('\n')).toMatch(/expired with its continuation owner/)
  })

  it('keeps a settled ask durable and collects the answer after a transient internal_error', async () => {
    const h = harness([])
    let polls = 0
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        replies: async (requestId: string) => {
          polls += 1
          if (polls <= 2) {
            throw new ApiCallError(500, 'internal_error', 'An unexpected server error occurred.')
          }
          return {
            request_id: requestId,
            reply_expires_at: null,
            replies: [reply({ text: 'Yes — start personally' })],
          } satisfies ListRepliesResponse
        },
      } as ApiClient
    }
    writeSessionState('recover-500', h.env, { last_prompt_at: AWAY })
    registerQuestion('recover-500', h.env, { question: 'Start personally?' }, NOW - 300_000)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'recover-500' }), 'codex')

    // Submit recorded the durable id before any wait; a 500 must not erase it
    // mid-flight, and recovery must still surface the late answer.
    const questions = h.recorder.submitted.filter((s) => isQuestionSubmit(s))
    expect(questions).toHaveLength(1)
    expect(h.recorder.receipts[0]).toMatch(/^req_[A-Za-z0-9_-]{22,24}$/)
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(h.recorder.closed).toContain(h.recorder.receipts[0])
    expect(readSessionState('recover-500', h.env).pending).toBeUndefined()
    const output = JSON.parse(h.io.outLines[0] ?? '{}') as { decision?: string; reason?: string }
    expect(output.decision).toBe('block')
    expect(output.reason).toContain('Yes — start personally')
  })

  it('stops retrying and names a permanent rejection during the blocking multi-wait', async () => {
    const h = harness([])
    let polls = 0
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        replies: async () => {
          polls += 1
          throw new ApiCallError(404, 'not_found', 'No such request.')
        },
      } as ApiClient
    }
    writeSessionState('permanent-wait', h.env, { last_prompt_at: AWAY })
    registerQuestion('permanent-wait', h.env, { question: 'Still there?' }, NOW - 300_000)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'permanent-wait' }), 'codex')

    expect(polls).toBe(1)
    expect(readSessionState('permanent-wait', h.env).pending).toBeUndefined()
    expect(h.io.errLines.join('\n')).toContain(
      `${h.recorder.receipts[0]}: not_found (HTTP 404): No such request.`,
    )
    expect(h.io.errLines.join('\n')).not.toContain('could not reach the server')
  })

  it('distinguishes a permanent late-poll rejection from transient trouble', async () => {
    const h = harness([])
    let polls = 0
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        replies: async () => {
          polls += 1
          throw new ApiCallError(401, 'machine_revoked', 'This machine was revoked.')
        },
      } as ApiClient
    }
    writeSessionState('permanent-late', h.env, {
      last_prompt_at: AWAY,
      pending: [
        {
          question: 'Deploy?',
          asked_at: NOW - 300_000,
          request_id: 'req_existing',
          collapse_key: 'question-existing',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 60_000,
        },
      ],
    })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'permanent-late' }), 'codex')

    expect(polls).toBe(1)
    expect(h.io.errLines.join('\n')).toContain(
      'req_existing: machine_revoked (HTTP 401): This machine was revoked.',
    )
    expect(h.io.errLines.join('\n')).toContain(
      'reply polling stopped after a permanent server rejection',
    )
    expect(h.io.errLines.join('\n')).not.toContain('could not check whether its answer arrived')
  })

  it('resumes with every answer that arrived, each tied to its question', async () => {
    const h = harness([])
    repliesByRequest(
      h,
      new Map([
        ['req_hook_1', [reply({ text: 'Ship it' })]],
        ['req_hook_2', [reply({ text: 'Staging' })]],
      ]),
    )
    writeSessionState('multi2', h.env, { last_prompt_at: AWAY })
    registerQuestion('multi2', h.env, { question: 'Ship it?' }, NOW)
    registerQuestion('multi2', h.env, { question: 'Deploy where?' }, NOW + 1)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'multi2' }))

    // Both reply windows close immediately (first answer claims each
    // question); the retirement drain closes again, which is idempotent.
    expect(new Set(h.recorder.closed)).toEqual(new Set(h.recorder.receipts))
    expect(readSessionState('multi2', h.env).pending).toBeUndefined()
    const output = JSON.parse(h.io.outLines[0] ?? '{}') as { decision?: string; reason?: string }
    expect(output.decision).toBe('block')
    expect(output.reason).toContain('answered 2 questions')
    expect(output.reason).toContain('"Ship it?" → "Ship it"')
    expect(output.reason).toContain('"Deploy where?" → "Staging"')
  })

  it('journals an accepted answer until a successor Stop proves delivery', async () => {
    const h = harness([reply({ text: 'Ship it' })])
    writeSessionState('answer-handoff', h.env, {
      last_prompt_at: AWAY,
      pending: [
        {
          question: 'Ship it?',
          asked_at: NOW,
          request_id: 'req_existing',
          collapse_key: 'question-existing',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 60_000,
        },
      ],
    })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'answer-handoff' }))
    const staged = readSessionState('answer-handoff', h.env)
    expect(staged.accepted?.answers[0]?.reply.text).toBe('Ship it')
    expect(JSON.parse(h.io.outLines.at(-1)!).decision).toBe('block')

    h.io.outLines = []
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'answer-handoff' }))
    expect(JSON.parse(h.io.outLines.at(-1)!).reason).toContain('Ship it')
    expect(readSessionState('answer-handoff', h.env).accepted).toBeDefined()

    h.recorder.acknowledged ??= new Set()
    h.recorder.acknowledged.add('req_existing')
    h.io.outLines = []
    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'answer-handoff', stop_hook_active: true }),
    )
    expect(h.io.outLines).toEqual([])
    expect(readSessionState('answer-handoff', h.env).accepted).toBeUndefined()
    expect(h.recorder.closed).toContain('req_existing')
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
  })

  it('blocks Stop with the exact command until a required Agent Acknowledgement is recorded', async () => {
    const h = harness([reply({ text: 'Ship it' })])
    writeSessionState('ack-required', h.env, {
      pending: [
        {
          question: 'Ship it?',
          request_id: 'req_ack_required',
          collapse_key: 'collapse-ack-required',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 60_000,
        },
      ],
    })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'ack-required' }))
    expect(readSessionState('ack-required', h.env).acknowledgement_due).toEqual([
      { request_id: 'req_ack_required', recorded_at: NOW, text_required: true },
    ])

    h.io.outLines = []
    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'ack-required', stop_hook_active: true }),
    )

    const blocked = JSON.parse(h.io.outLines[0] ?? '{}') as { decision?: string; reason?: string }
    expect(blocked.decision).toBe('block')
    expect(blocked.reason).toContain('req_ack_required')
    expect(blocked.reason).toContain(
      'notifai acknowledge req_ack_required --text <text>',
    )
    expect(blocked.reason).toContain('concrete work')
    expect(readSessionState('ack-required', h.env).accepted).toBeUndefined()
  })

  it('still blocks Stop, without asking for text, when the account turned text off', async () => {
    const h = harness([reply({ text: 'Ship it' })])
    h.recorder.acknowledgementTextRequiredFor = () => false
    writeSessionState('ack-textless', h.env, {
      pending: [
        {
          question: 'Ship it?',
          request_id: 'req_ack_textless',
          collapse_key: 'collapse-ack-textless',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 60_000,
        },
      ],
    })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'ack-textless' }))
    // The obligation is unchanged by the preference: the acknowledgement still
    // has to happen, because the user's read-state depends on it.
    expect(readSessionState('ack-textless', h.env).acknowledgement_due).toEqual([
      { request_id: 'req_ack_textless', recorded_at: NOW, text_required: false },
    ])

    h.io.outLines = []
    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'ack-textless', stop_hook_active: true }),
    )

    const blocked = JSON.parse(h.io.outLines[0] ?? '{}') as { decision?: string; reason?: string }
    expect(blocked.decision).toBe('block')
    expect(blocked.reason).toContain('notifai acknowledge req_ack_textless`')
    expect(blocked.reason).not.toContain('--text')
  })

  it('gives up holding the turn rather than wedging the session for ever', async () => {
    // The acknowledgement gate is the one place hooks break the fail-open rule.
    // Unbounded, an agent that never acknowledges — or a server that stays
    // unreachable, since an error counts as unresolved — held every turn of
    // this session for good.
    const h = harness([])
    writeSessionState('ack-wedge', h.env, {
      acknowledgement_due: [{ request_id: 'req_wedge', recorded_at: NOW }],
    })

    const blocked: unknown[] = []
    for (let turn = 0; turn < 3; turn += 1) {
      h.io.outLines.length = 0
      await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'ack-wedge' }))
      blocked.push(h.io.outLines.length > 0)
    }
    expect(blocked).toEqual([true, true, true])

    // The fourth turn is let through, and the obligation stops being owed.
    h.io.outLines.length = 0
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'ack-wedge' }))
    expect(h.io.outLines).toEqual([])
    expect(readSessionState('ack-wedge', h.env).acknowledgement_due).toBeUndefined()
  })

  it('reconciles a server-recorded Agent Acknowledgement after a local clearing crash', async () => {
    const h = harness([])
    writeSessionState('ack-heal', h.env, {
      acknowledgement_due: [{ request_id: 'req_ack_heal', recorded_at: NOW }],
    })
    h.recorder.acknowledged = new Set(['req_ack_heal'])

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'ack-heal' }))

    expect(h.recorder.acknowledgementChecks).toEqual(['req_ack_heal'])
    expect(readSessionState('ack-heal', h.env).acknowledgement_due).toBeUndefined()
    expect(h.io.outLines).toEqual([])
  })

  it('records only the requests whose immutable snapshot requires acknowledgement', async () => {
    const h = harness([])
    repliesByRequest(
      h,
      new Map([
        ['req_hook_1', [reply({ text: 'Ship it' })]],
        ['req_hook_2', [reply({ text: 'Staging' })]],
      ]),
    )
    h.recorder.acknowledgementRequiredFor = (requestId) =>
      h.recorder.aliases.get(requestId) === 1
    writeSessionState('ack-mixed', h.env, { last_prompt_at: AWAY })
    registerQuestion('ack-mixed', h.env, { question: 'Ship it?' }, NOW)
    registerQuestion('ack-mixed', h.env, { question: 'Deploy where?' }, NOW + 1)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'ack-mixed' }))

    const state = readSessionState('ack-mixed', h.env)
    expect(state.acknowledgement_due?.map((entry) => entry.request_id)).toEqual([
      h.recorder.receipts[0],
    ])
    const output = JSON.parse(h.io.outLines[0] ?? '{}') as { reason?: string }
    expect(output.reason).toContain(h.recorder.receipts[0]!)
    expect(output.reason).not.toContain(h.recorder.receipts[1]!)
  })

  it('lists every required request and command in a multi-answer continuation', async () => {
    const h = harness([])
    repliesByRequest(
      h,
      new Map([
        ['req_hook_1', [reply({ text: 'Ship it' })]],
        ['req_hook_2', [reply({ text: 'Staging' })]],
      ]),
    )
    writeSessionState('ack-multiple', h.env, { last_prompt_at: AWAY })
    registerQuestion('ack-multiple', h.env, { question: 'Ship it?' }, NOW)
    registerQuestion('ack-multiple', h.env, { question: 'Deploy where?' }, NOW + 1)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'ack-multiple' }))

    const output = JSON.parse(h.io.outLines[0] ?? '{}') as { reason?: string }
    for (const requestId of h.recorder.receipts) {
      expect(output.reason).toContain(requestId)
      expect(output.reason).toContain(`notifai acknowledge ${requestId} --text <text>`)
    }
  })

  it('resumes with a partial answer and keeps the rest registered', async () => {
    const h = harness([])
    const byRequest = new Map([['req_hook_1', [reply({ text: 'Ship it' })]]])
    repliesByRequest(h, byRequest)
    writeSessionState('multi3', h.env, { last_prompt_at: AWAY })
    registerQuestion('multi3', h.env, { question: 'Ship it?' }, NOW)
    registerQuestion('multi3', h.env, { question: 'Deploy where?' }, NOW + 1)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'multi3' }))

    const output = JSON.parse(h.io.outLines[0] ?? '{}') as { reason?: string }
    expect(output.reason).toContain('Ship it')
    expect(output.reason).toContain('1 more registered question is still waiting')
    const live = readSessionState('multi3', h.env).pending
    expect(live?.map((entry) => entry.question)).toEqual(['Deploy where?'])
    expect(live?.[0]?.request_id).toBe(h.recorder.receipts[1])

    // The remaining question's answer arrives before the next turn ends; the
    // late-answer path hands it over without asking anything twice.
    byRequest.set('req_hook_2', [reply({ text: 'Staging' })])
    h.recorder.acknowledged ??= new Set()
    h.recorder.acknowledged.add(h.recorder.receipts[0]!)
    h.io.outLines = []
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'multi3', stop_hook_active: true }))

    const followup = JSON.parse(h.io.outLines[0] ?? '{}') as { reason?: string }
    expect(followup.reason).toContain('Staging')
    expect(readSessionState('multi3', h.env).pending).toBeUndefined()
    expect(
      h.recorder.submitted.filter((s) => isQuestionSubmit(s)),
    ).toHaveLength(2)
  })
})

describe('a question that outlives its session', () => {
  function retirements(h: Harness): string[] {
    return h.recorder.closed
  }

  /** State a still-owned request can have when SessionEnd races its Stop. */
  async function pushUnanswered(h: Harness, sessionId: string): Promise<string> {
    writeSessionState(sessionId, h.env, {
      last_prompt_at: AWAY,
      pending: [{
        question: 'Ship it?',
        asked_at: NOW,
        request_id: 'req_live',
        collapse_key: 'collapse-live',
        device_ids: ['dev_iphone'],
        reply_deadline_at: NOW + 60_000,
      }],
    })
    return 'req_live'
  }

  it('retires a question the harness exited on, from a later session', async () => {
    const h = harness([])
    const first = await pushUnanswered(h, 'dead1')

    // The user quits the harness. SessionEnd cannot reach the network, so the
    // question must survive the state file it used to die with.
    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'dead1' }))
    expect(readSessionState('dead1', h.env)).toEqual({})

    // A different session's next hook holds a client and inherits the debt.
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'next1' }))
    expect(h.recorder.closed).toContain(first)
    expect(retirements(h)).toContain(first)
  })

  it('carries parked retirements across SessionEnd too', async () => {
    const h = harness([])
    const first = await pushUnanswered(h, 'dead2')

    // Died while offline: the user came back, the wipe parked the
    // retirement, and the drain could not send it.
    h.recorder.failCloses = true
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'dead2', prompt: 'done' }),
    )
    h.recorder.failCloses = false

    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'dead2' }))
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next2' }))
    expect(retirements(h)).toContain(first)
  })

  it('keeps the debt when the drain fails, and drops entries past the TTL', async () => {
    const h = harness([])
    const first = await pushUnanswered(h, 'dead3')
    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'dead3' }))

    // Still offline: the queue must survive a failed drain.
    h.recorder.failCloses = true
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next3' }))
    h.recorder.failCloses = false
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next3' }))
    expect(retirements(h)).toContain(first)

    // And a second drain does not send it twice.
    const count = retirements(h).filter((id) => id === first).length
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next3' }))
    expect(retirements(h).filter((id) => id === first)).toHaveLength(count)
  })

  it('gives up on an orphan that outlived the longest answerable window', async () => {
    const h = harness([])
    orphanRetirements(
      h.env,
      [{
        request_id: 'req_old',
        collapse_key: 'ck_old',
        device_ids: ['dev_iphone'],
        question: 'Old?',
        state: 'expired',
      }],
      NOW - (REPLY_MAX_WINDOW_SECONDS + 2 * 3600) * 1000,
    )
    const drained = await drainOrphanRetirements(
      { client: h.deps.clientFactory('https://test.notifai.invalid', 'Bearer x'), config: loadConfig({ cwd: h.deps.cwd, env: h.env }) },
      h.env,
      NOW,
    )
    // Dropped as handled, but no retirement push was spent on it.
    expect(drained).toContain('req_old')
    expect(h.recorder.submitted).toHaveLength(0)
  })

  it('queues nothing for a session with nothing live on the devices', async () => {
    const h = harness([])
    registerQuestion('dead4', h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'dead4' }))
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next4' }))
    expect(h.recorder.submitted).toHaveLength(0)
    expect(h.recorder.closed).toHaveLength(0)
  })
})

describe('hostile input', () => {
  it('never sends the credential to a base_url a repository asked for', async () => {
    const h = harness([reply({ text: 'Yes' })])
    const project = mkdtempSync(path.join(os.tmpdir(), 'notifai-evil-'))
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    writeFileSync(
      path.join(project, '.notifai', 'config.toml'),
      'base_url = "https://attacker.example"\n',
    )
    writeSessionState('h1', h.env, { last_prompt_at: AWAY })
    registerQuestion('h1', h.env, { question: 'Ship it?' })

    let seen: string | null = null
    h.deps.clientFactory = (baseUrl) => {
      seen = baseUrl
      return fakeClient(h.recorder, [reply({ text: 'Yes' })])
    }
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'h1', cwd: project }))

    expect(seen).toBe('https://test.notifai.invalid')
  })

  it('clamps an out-of-range grace window instead of trusting it', () => {
    const h = harness()
    const project = mkdtempSync(path.join(os.tmpdir(), 'notifai-bounds-'))
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    writeFileSync(path.join(project, '.notifai', 'config.toml'), 'ask_grace_seconds = 99999\n')
    const config = loadConfig({ cwd: project, env: h.env })
    // A committed repository file must not be able to replace the supported
    // terminal-first preference with an arbitrary multi-hour hold.
    expect(config.ask_grace_seconds.value).toBeLessThanOrEqual(360)
  })
})

describe('ask registration', () => {
  it('rejects a malformed choice set at registration, not at push time', () => {
    const h = harness()
    // Inside a hook, a rejection is only a stderr note the agent never reads —
    // so it would look registered and then silently never ask.
    expect(askCommand(h.deps, 'Ship it?', { choice: ['Only one'], sessionId: 'a1' })).toBe(EXIT.usage)
    expect(readSessionState('a1', h.env).pending).toBeUndefined()
  })

  it('stores the validated question set, comma-bearing labels verbatim', () => {
    const h = harness()
    const built = buildQuestions({ choice: ['Yes, ship it', 'No, hold'] }, 'Ship it?')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    registerQuestion('a2', h.env, { question: built.questions[0]!.text, questions: built.questions })
    expect(readSessionState('a2', h.env).pending?.[0]?.questions).toEqual([
      {
        id: 'ship-it',
        text: 'Ship it?',
        choices: [
          { id: 'yes-ship-it', label: 'Yes, ship it' },
          { id: 'no-hold', label: 'No, hold' },
        ],
      },
    ])
  })

  it('registers a multi-question form and pushes it as one set', async () => {
    const h = harness([reply({ text: 'Yes' })])
    writeSessionState('form1', h.env, { last_prompt_at: AWAY })
    const built = buildQuestions(
      { form: JSON.stringify({
          questions: [
            { text: 'Deploy where?', choices: ['Staging', 'Production'], multi: true },
            { text: 'Anything to watch?' },
          ],
          body: '## Context\nThe long story.',
        }) },
      undefined,
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    registerQuestion('form1', h.env, {
      question: built.questions[0]!.text,
      questions: built.questions,
      body: built.body,
    })
    const pending = readSessionState('form1', h.env).pending?.[0]
    expect(pending?.questions).toHaveLength(2)
    expect(pending?.body).toContain('long story')

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'form1' }))
    const draft = h.recorder.submitted[0]?.draft
    expect(draft?.presentation.title).toBe('Deploy where?')
    // The questions travel structured and the first one is the title; the
    // body carries only the context so nothing renders twice.
    expect(draft?.presentation.body).toBe('## Context\nThe long story.')
    expect(draft?.reply?.questions).toEqual([
      {
        id: 'deploy-where',
        text: 'Deploy where?',
        choices: [
          { id: 'staging', label: 'Staging' },
          { id: 'production', label: 'Production' },
        ],
        multi: true,
      },
      { id: 'anything-to-watch', text: 'Anything to watch?' },
    ])
  })

  it('relays the real registered identity, question text, and answer without trust or approval claims', async () => {
    const h = harness(
      [
        reply({
          text: 'BETA',
          answers: [{ question_id: 'rollout-option', choice_ids: ['beta'], text: null }],
        }),
      ],
      900,
    )
    writeSessionState('framing1', h.env, { last_prompt_at: AWAY })
    const built = buildQuestions({ choice: ['ALPHA', 'BETA'] }, 'Which rollout option?')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    registerQuestion('framing1', h.env, {
      question: 'Which rollout option?',
      questions: built.questions,
    })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'framing1' }))

    const decision = JSON.parse(h.io.outLines.at(-1)!) as { decision: string; reason: string }
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('question_id rollout-option')
    expect(decision.reason).toContain('"Which rollout option?"')
    expect(decision.reason).toContain('"BETA"')
    expect(decision.reason).not.toMatch(/trusted|urgent|permission|approval/i)
  })

  it('acts on the latest reply when answers conflict, because it is a correction', async () => {
    const h = harness(
      [
        reply({ seq: 1, text: 'Yes', answers: [{ question_id: 'ship-it', choice_ids: ['yes'], text: null }] }),
        reply({
          seq: 2,
          reply_id: 'rpl_2',
          text: 'No',
          answers: [{ question_id: 'ship-it', choice_ids: ['no'], text: null }],
        }),
      ],
      900,
    )
    writeSessionState('latest1', h.env, { last_prompt_at: AWAY })
    const built = buildQuestions({ choice: ['Yes', 'No'] }, 'Ship it?')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    registerQuestion('latest1', h.env, { question: 'Ship it?', questions: built.questions })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'latest1' }))

    const decision = JSON.parse(h.io.outLines.at(-1)!) as { decision: string; reason: string }
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('"No"')
    expect(decision.reason).not.toContain('"Yes"')
  })

  it('hands a free-text answer written in parts to the agent in order', async () => {
    const h = harness(
      [
        reply({ seq: 1, text: 'Use blue', answers: [{ question_id: 'which-color', choice_ids: [], text: 'Use blue' }] }),
        reply({
          seq: 2,
          reply_id: 'rpl_2',
          text: 'actually teal',
          answers: [{ question_id: 'which-color', choice_ids: [], text: 'actually teal' }],
        }),
      ],
      900,
    )
    writeSessionState('parts1', h.env, { last_prompt_at: AWAY })
    registerQuestion('parts1', h.env, { question: 'Which color?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'parts1' }))

    const decision = JSON.parse(h.io.outLines.at(-1)!) as { reason: string }
    expect(decision.reason).toContain('in the order written')
    expect(decision.reason).toContain('"Use blue", then "actually teal"')
  })

  it('does not let an explicit session bypass exact active-harness proof', () => {
    const h = harness()
    expect(askCommand(h.deps, 'Ship it?', { sessionId: 'guessed' })).toBe(EXIT.usage)
    expect(readSessionState('guessed', h.env).pending).toBeUndefined()
  })

  it('does not route from NOTIFAI_SESSION where no exact harness has spoken', () => {
    const h = harness()
    h.deps.env['NOTIFAI_SESSION'] = 'solo-session'
    expect(askCommand(h.deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(readSessionState('solo-session', h.env).pending).toBeUndefined()
  })

  it('queues alongside incomplete live state without touching it', () => {
    // Registering never retires, so even a live entry too incomplete to
    // retire is no obstacle — it stays exactly as found, and the new
    // question joins the queue behind it.
    const h = harness()
    writeSessionState('incomplete', h.env, {
      pending: [
        {
          question: 'Original?',
          request_id: 'req_original',
          collapse_key: 'collapse-original',
        },
      ],
    })

    registerQuestion('incomplete', h.env, { question: 'Another?' })
    const pending = readSessionState('incomplete', h.env).pending
    expect(pending?.map((entry) => entry.question)).toEqual(['Original?', 'Another?'])
    expect(pending?.[0]).toMatchObject({
      request_id: 'req_original',
      collapse_key: 'collapse-original',
    })
  })

  it('refuses a fifth question and names the form alternative', () => {
    const h = harness()
    for (const question of ['One?', 'Two?', 'Three?', 'Four?']) {
      registerQuestion('crowded', h.env, { question })
    }

    expect(() => registerQuestion('crowded', h.env, { question: 'Five?' })).toThrow(/ask --form/)
    expect(readSessionState('crowded', h.env).pending).toHaveLength(4)
  })
})

describe('session-start hook', () => {
  it('is completely silent when the Project is disabled', async () => {
    const h = harness()
    const binding = projectBinding(h.deps.cwd, h.env)
    if (binding === null) throw new Error('test Project binding unavailable')
    disableProject(binding)

    for (const [event, hookHarness] of [
      ['session-start', 'claude-code'],
      ['subagent-start', 'codex'],
      ['activation-stop', 'cursor'],
    ] as const) {
      h.io.outLines = []
      await hookRunCommand(
        h.deps,
        event,
        stdin({ session_id: 'disabled', conversation_id: 'disabled', workspace_roots: [h.deps.cwd], loop_count: 0 }),
        hookHarness,
      )
      expect(h.io.outLines).toEqual([])
    }
    expect(projectEnabled(binding)).toBe(false)
    expect(readSessionState('disabled', h.env).started_at).toBeUndefined()
  })

  it('adds proactive Notifai context for an enabled Project before machine authentication exists', async () => {
    const h = harness()
    h.deps.store.load = () => null

    for (const hookHarness of ['claude-code', 'codex'] as const) {
      h.io.outLines = []
      await hookRunCommand(
        h.deps,
        'session-start',
        stdin({ session_id: `proactive-guidance-${hookHarness}`, source: 'startup' }),
        hookHarness,
      )

      const first = JSON.parse(h.io.outLines.at(-1)!) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
      }
      expect(first.hookSpecificOutput).toMatchObject({
        hookEventName: 'SessionStart',
      })
      expect(first.hookSpecificOutput?.additionalContext).toMatch(/Notifai.*enabled.*Project/i)
      expect(first.hookSpecificOutput?.additionalContext).toContain('# How to read this guidance')
      expect(first.hookSpecificOutput?.additionalContext).toContain(
        '<!-- notifai:guidance topic=when-to-notify from=shipped default -->',
      )
      expect(first.hookSpecificOutput?.additionalContext).not.toContain('run `notifai guidance` once')
      expect(h.io.errLines.join('\n')).not.toMatch(/not paired/i)
    }
  })

  it('caps the total root lifecycle context and falls back without partial guidance', async () => {
    const h = harness()
    const guidance = path.join(h.deps.cwd, '.notifai', 'guidance')
    mkdirSync(guidance, { recursive: true })
    writeFileSync(path.join(guidance, 'titles.md'), `private-start-${'x'.repeat(16_000)}`)
    writeFileSync(path.join(guidance, 'bodies.md'), `private-end-${'y'.repeat(16_000)}`)

    await hookRunCommand(
      h.deps,
      'session-start',
      stdin({ session_id: 'bounded-root-guidance', source: 'startup' }),
      'claude-code',
    )
    const output = JSON.parse(h.io.outLines.at(-1) ?? '{}') as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    const context = output.hookSpecificOutput?.additionalContext ?? ''
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(GUIDANCE_CONTEXT_MAX_BYTES)
    expect(context).toContain('above the')
    expect(context).toContain('run `notifai guidance` once')
    expect(context).not.toContain('private-start-')
    expect(context).not.toContain('private-end-')
  })

  it('uses each supported lifecycle output contract and gives workers deterministic ownership', async () => {
    const h = harness()
    h.deps.store.load = () => null

    await hookRunCommand(
      h.deps,
      'session-start',
      stdin({ conversation_id: 'cursor-session', workspace_roots: [h.deps.cwd] }),
      'cursor',
    )
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}')).toMatchObject({
      additional_context: expect.stringMatching(/Notifai.*enabled.*Project/i),
    })

    h.io.outLines = []
    await hookRunCommand(
      h.deps,
      'subagent-start',
      stdin({ session_id: 'subagent-session' }),
      'claude-code',
    )
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}')).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: expect.stringMatching(
          /report Agent Events to the parent.*do not send.*unless the parent explicitly delegated/i,
        ),
      },
    })
    expect(h.io.outLines.at(-1)).not.toContain('topic=titles')
    expect(h.io.outLines.at(-1)).not.toContain('topic=bodies')
  })

  it('uses Cursor native Stop follow-up once when its SessionStart context is lossy', async () => {
    const h = harness()
    h.deps.store.load = () => null
    const input = stdin({
      conversation_id: 'cursor-activation',
      workspace_roots: [h.deps.cwd],
      loop_count: 0,
    })

    await hookRunCommand(h.deps, 'activation-stop', input, 'cursor')
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}')).toMatchObject({
      followup_message: expect.stringMatching(/effective, provenance-marked guidance.*when-to-notify/is),
    })

    h.io.outLines = []
    await hookRunCommand(
      h.deps,
      'activation-stop',
      stdin({
        conversation_id: 'cursor-activation',
        workspace_roots: [h.deps.cwd],
        loop_count: 1,
      }),
      'cursor',
    )
    expect(h.io.outLines).toEqual([])
    expect(readSessionState('cursor-activation', h.env).cursor_activation_confirmed_at).toBe(NOW)

    await hookRunCommand(
      h.deps,
      'session-start',
      stdin({ conversation_id: 'cursor-activation', workspace_roots: [h.deps.cwd] }),
      'cursor',
    )
    h.io.outLines = []
    await hookRunCommand(h.deps, 'activation-stop', input, 'cursor')
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}')).toHaveProperty('followup_message')
  })

  it('does not let Cursor activation override cancellation or a live question continuation', async () => {
    const h = harness()
    const base = {
      conversation_id: 'cursor-coexistence',
      workspace_roots: [h.deps.cwd],
      loop_count: 0,
    }

    await hookRunCommand(
      h.deps,
      'activation-stop',
      stdin({ ...base, status: 'aborted' }),
      'cursor',
    )
    expect(h.io.outLines).toEqual([])

    registerQuestion('cursor-coexistence', h.env, { question: 'Choose a path?' })
    await hookRunCommand(
      h.deps,
      'activation-stop',
      stdin({ ...base, status: 'completed' }),
      'cursor',
    )
    expect(h.io.outLines).toEqual([])
    expect(readSessionState('cursor-coexistence', h.env).cursor_activation_claimed_at).toBeUndefined()

    await hookRunCommand(
      h.deps,
      'activation-stop',
      stdin({ ...base, status: 'completed', loop_count: 1 }),
      'cursor',
    )
    expect(h.io.outLines).toEqual([])
    expect(readSessionState('cursor-coexistence', h.env).cursor_activation_confirmed_at).toBeUndefined()
  })

  it('retries an unconfirmed Cursor activation claim after the crash guard expires', async () => {
    const h = harness()
    const input = stdin({
      conversation_id: 'cursor-activation-retry',
      workspace_roots: [h.deps.cwd],
      status: 'completed',
      loop_count: 0,
    })

    await hookRunCommand(h.deps, 'activation-stop', input, 'cursor')
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}')).toHaveProperty('followup_message')

    h.io.outLines = []
    await hookRunCommand(h.deps, 'activation-stop', input, 'cursor')
    expect(h.io.outLines).toEqual([])

    h.advanceClock(30_001)
    await hookRunCommand(h.deps, 'activation-stop', input, 'cursor')
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}')).toHaveProperty('followup_message')
  })

  it('fails closed without a Cursor conversation id and still activates after an errored turn', async () => {
    const h = harness()

    await hookRunCommand(
      h.deps,
      'activation-stop',
      stdin({ workspace_roots: [h.deps.cwd], status: 'completed', loop_count: 0 }),
      'cursor',
    )
    expect(h.io.outLines).toEqual([])

    await hookRunCommand(
      h.deps,
      'activation-stop',
      stdin({
        conversation_id: 'cursor-error-activation',
        workspace_roots: [h.deps.cwd],
        status: 'error',
        loop_count: 0,
      }),
      'cursor',
    )
    expect(JSON.parse(h.io.outLines.at(-1) ?? '{}')).toHaveProperty('followup_message')
  })

  it('makes a Claude compatibility copy inside Cursor a no-op', async () => {
    const h = harness()
    h.deps.env['CURSOR_PROJECT_DIR'] = h.deps.cwd

    await hookRunCommand(
      h.deps,
      'session-start',
      stdin({ session_id: 'cursor-compat-copy', source: 'startup' }),
      'claude-code',
    )

    expect(h.io.outLines).toEqual([])
  })
})

describe('user-prompt-submit hook', () => {
  it('stays silent when SessionStart was absent while preserving prompt lifecycle', async () => {
    const h = harness()

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'presence-only' }),
      'claude-code',
    )

    expect(h.io.outLines).toEqual([])
    expect(readSessionState('presence-only', h.env)).toEqual({
      harness: 'claude-code',
      last_prompt_at: NOW,
    })
  })

  it('records presence', async () => {
    const h = harness()
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 's10' }))
    expect(readSessionState('s10', h.env).last_prompt_at).toBe(NOW)
  })

  it('records Stop separately so a prompt hook cannot impersonate turn-end routing', async () => {
    const h = harness()
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'events' }))
    expect(readSessionState('events', h.env).last_stop_at).toBeUndefined()

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'events' }))
    expect(readSessionState('events', h.env).last_stop_at).toBe(NOW)
  })

  it('diagnoses partial production input as malformed or truncated', async () => {
    const h = harness()
    const deps = { ...h.deps, logger: createLogger({ env: h.env }) }
    const input = new PassThrough()
    input.write('{"session_id":')

    expect(
      await hookRunCommand(
        deps,
        'user-prompt-submit',
        () => readStdinWithTimeout(input, 5),
      ),
    ).toBe(EXIT.ok)

    expect(h.io.errLines.join('\n')).toMatch(/malformed|truncated/i)
    const records = readLogRecords(h.env, { limit: 10 }).records
    expect(records.map((record) => record.event)).toEqual(['hook.start', 'hook.end'])
    expect(records.at(-1)?.data).toMatchObject({ reason: 'malformed-input' })
  })

  it('records an empty production input timeout before failing open', async () => {
    const h = harness()
    const deps = { ...h.deps, logger: createLogger({ env: h.env }) }
    const input = new PassThrough()

    expect(
      await hookRunCommand(
        deps,
        'user-prompt-submit',
        () => readStdinWithTimeout(input, 5),
      ),
    ).toBe(EXIT.ok)

    const records = readLogRecords(h.env, { limit: 10 }).records
    expect(records.map((record) => record.event)).toEqual(['hook.start', 'hook.end'])
    expect(records.at(-1)?.data).toMatchObject({ reason: 'input-read-failed' })
    expect(records.at(-1)?.data?.['message']).toMatch(/timed out waiting/)
  })

  it('explains when a missing machine credential makes a hook skip routing', async () => {
    const h = harness()
    h.deps.store.load = () => null

    expect(
      await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'unpaired' })),
    ).toBe(EXIT.ok)

    expect(h.io.errLines.join('\n')).toMatch(/not paired|credential/i)
  })

  it('preserves a delivered question through a second ask and an unrelated prompt', async () => {
    const h = harness([])
    const live = {
      question: 'Ship it?',
      request_id: 'req_live',
      collapse_key: 'collapse-live',
      device_ids: ['dev_iphone', 'dev_mac'],
      reply_deadline_at: NOW + 60_000,
    }
    writeSessionState('transition', h.env, { last_prompt_at: AWAY, pending: [live] })

    registerQuestion('transition', h.env, { question: 'Deploy it?' })
    const queued = readSessionState('transition', h.env)
    expect(queued.retiring ?? []).toEqual([])
    expect(queued.pending?.map((entry) => entry.question)).toEqual(['Ship it?', 'Deploy it?'])

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({
        session_id: 'transition',
        cwd: h.deps.cwd,
        prompt: 'keep going on the billing work',
      }),
      'claude-code',
    )

    expect(h.recorder.closed).toEqual([])
    expect(
      h.recorder.submitted.filter((s) => isRetirementSubmit(s)),
    ).toHaveLength(0)
    expect(readSessionState('transition', h.env).pending?.map((entry) => entry.question)).toEqual([
      'Ship it?',
      'Deploy it?',
    ])
  })

  it('retires a real timed-out Stop before a later prompt can accept an answer', async () => {
    const h = harness([])
    writeSessionState('s11', h.env, { last_prompt_at: AWAY })
    registerQuestion('s11', h.env, { question: 'Which environment?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 's11' }))
    expect(readSessionState('s11', h.env).pending).toBeUndefined()
    expect(h.recorder.closed).toContain(h.recorder.receipts[0])

    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 's11', cwd: '/repo' }))

    expect(h.recorder.closed).toContain(h.recorder.receipts[0])
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
  })

  it('marks the retirement done/answered_elsewhere so it ships silently', async () => {
    // A state change is not news: the retirement must ride the wire as a
    // lifecycle update, which the server renders as a background push — the
    // old "Answered" tombstone alert told the user what they just did.
    const h = harness([])
    writeSessionState('s15', h.env, {
      last_prompt_at: AWAY,
      pending: [{
        question: 'Which environment?',
        request_id: 'req_live',
        collapse_key: 'collapse-live',
        device_ids: ['dev_iphone'],
        reply_deadline_at: NOW + 60_000,
      }],
    })

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 's15', cwd: '/repo', prompt: 'done' }),
    )

    expect(h.recorder.closed).toContain('req_live')
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
  })

  it('retires as done/answered when the answer came from a device', async () => {
    const h = harness([reply({ text: 'Yes' })])
    registerQuestion('s16', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 's16' }))
    h.recorder.acknowledged ??= new Set()
    h.recorder.acknowledged.add(h.recorder.receipts[0]!)
    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 's16', stop_hook_active: true }),
    )

    expect(h.recorder.closed).toContain(h.recorder.receipts[0])
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
  })

  it('retires only the outstanding question a prompt uniquely answers', async () => {
    const h = harness([])
    writeSessionState('prompt-match', h.env, {
      last_prompt_at: AWAY,
      pending: [
        {
          question: 'Ship it?',
          questions: [
            {
              id: 'q1',
              text: 'Ship it?',
              choices: [
                { id: 'ship', label: 'Ship it' },
                { id: 'wait', label: 'Wait' },
              ],
            },
          ],
          request_id: 'req_live',
          collapse_key: 'collapse-live',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 60_000,
        },
      ],
    })

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'prompt-match', prompt: 'Ship it' }),
    )

    expect(h.recorder.closed).toContain('req_live')
    expect(readSessionState('prompt-match', h.env).pending).toBeUndefined()
  })

  it('leaves an unrelated prompt’s live question open for the reply window', async () => {
    const h = harness([])
    writeSessionState('prompt-unrelated', h.env, {
      last_prompt_at: AWAY,
      pending: [{
        question: 'Ship it?',
        request_id: 'req_live',
        collapse_key: 'collapse-live',
        device_ids: ['dev_iphone'],
        reply_deadline_at: NOW + 60_000,
      }],
    })

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({
        session_id: 'prompt-unrelated',
        prompt: 'continue investigating the billing failure on staging',
      }),
    )

    expect(h.recorder.closed).toEqual([])
    expect(readSessionState('prompt-unrelated', h.env).pending?.[0]?.request_id).toBe('req_live')
  })

  it('publishes a session pointer so a plain `notifai ask` can find itself', async () => {
    const h = harness()
    // A real directory reachable by two names. os.tmpdir() is /var/folders on
    // macOS, so create under /tmp explicitly to get the symlinked pair that
    // broke this live: the harness reports cwd unresolved, a shell resolved.
    const viaSymlink = mkdtempSync('/tmp/notifai-ptr-')
    const project = realpathSync(viaSymlink)
    if (project === viaSymlink) return // no symlink on this platform; nothing to prove

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 's14', cwd: viaSymlink }),
      'claude-code',
    )

    expect(readProjectSession(project, h.env, NOW)).toBe('s14')
    expect(readProjectSession(viaSymlink, h.env, NOW)).toBe('s14')
    // A pointer older than a day is not evidence of a live session.
    expect(readProjectSession(project, h.env, NOW + 2 * 24 * 3600 * 1000)).toBeNull()

    clearSessionState('s14', h.env)
    expect(readProjectSession(project, h.env, NOW)).toBeNull()
  })

  it('round-trips future project-pointer fields while publishing a session', () => {
    const h = harness()
    const pointer = projectSessionPointerPath(h.deps.cwd, h.env)
    const futureEntry = {
      format: 2,
      session: { id: 'future-session', runtime: 'future-harness' },
    }
    mkdirSync(path.dirname(pointer), { recursive: true })
    writeFileSync(
      pointer,
      `${JSON.stringify({
        future_root: { retained: true },
        sessions: [
          {
            session_id: 'still-running',
            updated_at: NOW - 1,
            harness: 'codex',
            future_entry: { retained: true },
          },
          {
            session_id: 'new-session',
            updated_at: NOW - 2,
            harness: 'claude-code',
            future_current_entry: { retained: true },
          },
          futureEntry,
        ],
      })}\n`,
    )

    writeProjectSession(h.deps.cwd, h.env, 'new-session', NOW, 'claude-code')

    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toEqual({
      future_root: { retained: true },
      sessions: [
        {
          session_id: 'still-running',
          updated_at: NOW - 1,
          harness: 'codex',
          future_entry: { retained: true },
        },
        futureEntry,
        {
          session_id: 'new-session',
          updated_at: NOW,
          harness: 'claude-code',
          future_current_entry: { retained: true },
        },
      ],
    })
  })
})

describe('reconciling a conversation answer', () => {
  it('matches a unique closed choice and a lone short confirmation', () => {
    const choiceQuestion: PendingQuestion = {
      question: 'Ship it?',
      questions: [
        {
          id: 'q1',
          text: 'Ship it?',
          choices: [
            { id: 'ship', label: 'Ship it' },
            { id: 'wait', label: 'Wait' },
          ],
        },
      ],
    }
    const freeText: PendingQuestion = { question: 'Create the key?' }
    expect(pendingAnsweredByPrompt('Ship it', [choiceQuestion]).map((entry) => entry.question)).toEqual([
      'Ship it?',
    ])
    expect(pendingAnsweredByPrompt('done', [freeText])).toEqual([freeText])
    expect(pendingAnsweredByPrompt('done', [choiceQuestion, freeText])).toEqual([])
    expect(pendingAnsweredByPrompt('keep going on the billing work', [freeText])).toEqual([])
  })

  it('does not push a conversation-answered question after a newer one is registered', async () => {
    const h = harness([])
    writeSessionState('stale-then-new', h.env, { last_prompt_at: AWAY })
    registerQuestion('stale-then-new', h.env, { question: 'Create the Apple IAP key?' })

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'stale-then-new', prompt: 'done' }),
    )
    expect(readSessionState('stale-then-new', h.env).pending).toBeUndefined()

    registerQuestion('stale-then-new', h.env, { question: 'Which ASN endpoint?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'stale-then-new' }))

    const questions = h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))
    expect(questions.map((entry) => entry.draft.presentation.body)).toEqual(['Which ASN endpoint?'])
  })

  it('reserves a close-fence budget when the owner deadline is nearly now', async () => {
    const h = harness([])
    const dir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'config.toml'), 'ask_grace_seconds = 0\n')
    writeSessionState('near-zero', h.env, {
      last_prompt_at: AWAY,
      pending: [{
        question: 'Ship it?',
        asked_at: NOW - 60_000,
        request_id: 'req_live',
        collapse_key: 'collapse-live',
        device_ids: ['dev_iphone'],
        reply_deadline_at: NOW + 4_001,
        owner_deadline_at: NOW + 4_001,
      }],
    })

    await hookRunCommand(
      { ...h.deps, logger: createLogger({ env: h.env, cmd: 'hook stop' }) },
      'stop',
      stdin({ session_id: 'near-zero', cwd: h.deps.cwd }),
    )

    expect(h.recorder.closed).toContain('req_live')
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
    expect(h.deps.now?.()).toBeLessThan(NOW + 10_000)
    const records = readLogRecords(h.env, { event: ['hook.retirement'] }).records
    expect(records.some((record) => record.data?.['proven'] === true)).toBe(true)
  })
})

describe('session-end hook', () => {
  it('drops local state without touching the network and records the lifecycle', async () => {
    const h = harness()
    writeSessionState('s12', h.env, { last_prompt_at: NOW })
    const deps = { ...h.deps, logger: createLogger({ env: h.env }) }

    const code = await hookRunCommand(deps, 'session-end', stdin({ session_id: 's12' }))

    expect(code).toBe(EXIT.ok)
    expect(readSessionState('s12', h.env)).toEqual({})
    expect(h.recorder.closed).toEqual([])
    const records = readLogRecords(h.env, { limit: 10 }).records
    expect(records.map((record) => record.event)).toEqual(['hook.start', 'hook.end'])
    expect(records.at(-1)?.data).toMatchObject({ outcome: 'cleaned', queued_retirements: 0 })
  })

  it('round-trips future session-state fields when SessionEnd preserves an obligation', async () => {
    const h = harness()
    const sessionId = 'session-end-future-state'
    const stateFile = path.join(
      stateDir(h.env),
      'sessions',
      `${sanitizeSessionId(sessionId)}.json`,
    )
    const acknowledgement = {
      request_id: 'req_future_ack',
      recorded_at: NOW,
      future_entry: { retained: true },
    }
    mkdirSync(path.dirname(stateFile), { recursive: true })
    writeFileSync(
      stateFile,
      `${JSON.stringify({
        future_root: { retained: true },
        acknowledgement_due: [acknowledgement],
      })}\n`,
    )

    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: sessionId }))

    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({
      future_root: { retained: true },
      acknowledgement_due: [acknowledgement],
      session_id: sessionId,
    })
  })

  it('runs the real Codex SessionEnd cleanup before contended diagnostics and exits fail-open', async () => {
    const h = harness()
    const sessionId = 'session-end-budget'
    writeSessionState(sessionId, h.env, { last_prompt_at: NOW })
    writeProjectSession(h.deps.cwd, h.env, sessionId, Date.now(), 'codex')
    const configFile = sessionConfigPath(sessionId, h.env)
    mkdirSync(path.dirname(configFile), { recursive: true })
    writeFileSync(configFile, 'ask_notifications = false\nlog_level = "info"\n')
    expect(loadConfig({ cwd: h.deps.cwd, env: h.env, sessionId }).ask_notifications).toMatchObject({
      value: false,
      source: expect.stringMatching(/^session:/),
    })

    const stateFile = path.join(
      stateDir(h.env),
      'sessions',
      `${sanitizeSessionId(sessionId)}.json`,
    )
    const projectPointer = projectSessionPointerPath(h.deps.cwd, h.env)
    expect(existsSync(stateFile)).toBe(true)
    expect(existsSync(configFile)).toBe(true)
    expect(existsSync(projectPointer)).toBe(true)

    const logLock = `${activeLogPath(h.env)}.lock`
    const holder = runSessionEndLogLockHolder(h.deps.cwd, h.env, logLock)
    let cli: ReturnType<typeof runSessionEndCli> | undefined
    try {
      await waitUntil(
        () => existsSync(holder.readyPath),
        10_000,
        'SessionEnd log lock worker did not acquire its bakery ticket',
      )
      expect(readdirSync(logLock).filter((name) => name.startsWith('ticket-'))).toHaveLength(1)

      cli = runSessionEndCli(h.env, h.deps.cwd, sessionId)
      await waitUntil(
        () =>
          readdirSync(logLock).filter((name) => name.startsWith('ticket-')).length >= 2,
        5_000,
        'the real Codex hook did not reach contended diagnostics before its deadline',
      )

      // Reaching the second bakery ticket proves program.ts preAction did not write
      // first. Every durable cleanup must already be visible while diagnostics
      // are still blocked behind the live holder.
      expect(existsSync(stateFile)).toBe(false)
      expect(existsSync(configFile)).toBe(false)
      expect(existsSync(projectPointer)).toBe(false)

      const result = await cli.done
      expect(result).toMatchObject({ code: EXIT.ok, signal: null, stdout: '', stderr: '' })
      expect(result.durationMs).toBeGreaterThanOrEqual(900)
      expect(result.durationMs).toBeLessThan(2_000)
      // The diagnostic contender timed out rather than stealing the held lock,
      // disabled its sink, and still let the real CLI exit successfully.
      expect(existsSync(activeLogPath(h.env))).toBe(false)

      writeFileSync(holder.releasePath, 'release')
      await holder.done

      expect(readSessionState(sessionId, h.env)).toEqual({})
      expect(readProjectSession(h.deps.cwd, h.env, Date.now())).toBeNull()
      expect(loadConfig({ cwd: h.deps.cwd, env: h.env, sessionId }).ask_notifications).toEqual({
        value: true,
        source: 'default',
      })
    } finally {
      if (!existsSync(holder.releasePath)) writeFileSync(holder.releasePath, 'release')
      if (cli?.child.exitCode === null && cli.child.signalCode === null) cli.child.kill('SIGKILL')
      if (holder.child.exitCode === null && holder.child.signalCode === null) {
        holder.child.kill('SIGKILL')
      }
      rmSync(h.deps.cwd, { recursive: true, force: true })
    }
  })

  it('clears only the ending session from a concurrent project index', async () => {
    const h = harness()
    writeSessionState('still-running', h.env, { last_prompt_at: NOW })
    writeProjectSession(h.deps.cwd, h.env, 'still-running', NOW - 1, 'codex')
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'ending', cwd: h.deps.cwd }),
      'claude-code',
    )
    expect(readProjectSession(h.deps.cwd, h.env, NOW)).toBe('ending')
    expect(
      readMatchingProjectSessionPointer(
        h.deps.cwd,
        h.env,
        NOW,
        'still-running',
        'codex',
      ),
    ).toEqual({ sessionId: 'still-running', harness: 'codex' })

    await hookRunCommand(
      h.deps,
      'session-end',
      stdin({ session_id: 'ending', cwd: h.deps.cwd }),
      'claude-code',
    )

    expect(readProjectSession(h.deps.cwd, h.env, NOW)).toBe('still-running')
    expect(
      readMatchingProjectSessionPointer(
        h.deps.cwd,
        h.env,
        NOW,
        'still-running',
        'codex',
      ),
    ).toEqual({ sessionId: 'still-running', harness: 'codex' })
  })

  it('keeps future project-pointer data when clearing the ending session', async () => {
    const h = harness()
    const pointer = projectSessionPointerPath(h.deps.cwd, h.env)
    const futureEntry = {
      format: 2,
      session: { id: 'future-session', runtime: 'future-harness' },
    }
    writeSessionState('still-running', h.env, { last_prompt_at: NOW })
    writeSessionState('ending', h.env, { last_prompt_at: NOW })
    mkdirSync(path.dirname(pointer), { recursive: true })
    writeFileSync(
      pointer,
      `${JSON.stringify({
        future_root: { retained: true },
        sessions: [
          {
            session_id: 'still-running',
            updated_at: NOW - 1,
            harness: 'codex',
            future_entry: { retained: true },
          },
          futureEntry,
          { session_id: 'ending', updated_at: NOW, harness: 'claude-code' },
        ],
      })}\n`,
    )

    await hookRunCommand(
      h.deps,
      'session-end',
      stdin({ session_id: 'ending', cwd: h.deps.cwd }),
      'claude-code',
    )

    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toEqual({
      future_root: { retained: true },
      sessions: [
        {
          session_id: 'still-running',
          updated_at: NOW - 1,
          harness: 'codex',
          future_entry: { retained: true },
        },
        futureEntry,
      ],
    })
  })

  it('preserves incomplete live state and reports why it cannot retire it', async () => {
    const h = harness()
    writeSessionState('s-incomplete', h.env, {
      pending: [
        {
          question: 'Still live?',
          request_id: 'req_incomplete',
          collapse_key: 'collapse-incomplete',
        },
      ],
    })

    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 's-incomplete' }))

    expect(readSessionState('s-incomplete', h.env).pending?.[0]?.request_id).toBe('req_incomplete')
    expect(h.io.errLines.join('\n')).toContain(
      'refusing to retire it without request, collapse, and device identifiers',
    )
  })
})

describe('malformed input', () => {
  it('never fails the harness on unparseable hook JSON', async () => {
    const h = harness()
    const code = await hookRunCommand(h.deps, 'stop', async () => 'not json{')
    expect(code).toBe(EXIT.ok)
    expect(h.io.outLines).toEqual([])
  })
})

describe('telling concurrent agents apart', () => {
  it('uses each hook event branch while keeping one immutable session identity', async () => {
    const h = harness([reply({ text: 'Yes' })])
    initializeFixtureRepository(h.deps.cwd)
    registerQuestion(
      'session-branch-transition',
      h.env,
      {
        question: 'Ship it?',
        source: {
          session_id: 'session-branch-transition',
          session_label: 'Branch transition',
          harness: 'claude-code',
          branch: 'branch-a',
        },
      },
      NOW,
    )

    runFixtureGit(h.deps.cwd, 'checkout', '-b', 'branch-b')
    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'session-branch-transition', cwd: h.deps.cwd }),
      'claude-code',
    )

    const question = h.recorder.submitted.find((entry) => isQuestionSubmit(entry))
    expect(question?.draft.source).toEqual({
      session_id: 'session-branch-transition',
      session_label: 'Branch transition',
      harness: 'claude-code',
      branch: 'branch-b',
    })

    runFixtureGit(h.deps.cwd, 'checkout', 'branch-a')
    h.recorder.acknowledged ??= new Set()
    h.recorder.acknowledged.add(h.recorder.receipts[0]!)
    await hookRunCommand(
      h.deps,
      'stop',
      stdin({
        session_id: 'session-branch-transition',
        cwd: h.deps.cwd,
        stop_hook_active: true,
      }),
      'claude-code',
    )

    expect(h.recorder.closed).toContain(h.recorder.receipts[0])
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
  })

  it('clears registration-time branch and worktree on a detached-HEAD hook event', async () => {
    const h = harness([])
    initializeFixtureRepository(h.deps.cwd)
    registerQuestion(
      'session-detached',
      h.env,
      {
        question: 'Ship it?',
        source: {
          session_id: 'session-detached',
          session_label: 'Detached review',
          harness: 'claude-code',
          branch: 'branch-a',
          worktree: 'stale-worktree',
        },
      },
      NOW,
    )
    runFixtureGit(h.deps.cwd, 'checkout', '--detach', 'HEAD')

    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'session-detached', cwd: h.deps.cwd }),
      'claude-code',
    )

    const question = h.recorder.submitted.find((entry) => isQuestionSubmit(entry))
    expect(question?.draft.source).toEqual({
      session_id: 'session-detached',
      session_label: 'Detached review',
      harness: 'claude-code',
    })
  })

  it('captures entry into and exit from a linked worktree on the same session', async () => {
    const h = harness([reply({ text: 'Yes' })])
    initializeFixtureRepository(h.deps.cwd, 'main')
    const linked = `${h.deps.cwd}-linked`
    runFixtureGit(h.deps.cwd, 'worktree', 'add', '-b', 'worktree-branch', linked)
    try {
      registerQuestion(
        'session-worktree-transition',
        h.env,
        {
          question: 'Ship it?',
          source: {
            session_id: 'session-worktree-transition',
            session_label: 'Worktree transition',
            harness: 'claude-code',
            branch: 'main',
          },
        },
        NOW,
      )

      await hookRunCommand(
        h.deps,
        'stop',
        stdin({ session_id: 'session-worktree-transition', cwd: linked }),
        'claude-code',
      )
      const question = h.recorder.submitted.find(
        (entry) => isQuestionSubmit(entry),
      )
      expect(question?.draft.source).toEqual({
        session_id: 'session-worktree-transition',
        session_label: 'Worktree transition',
        harness: 'claude-code',
        branch: 'worktree-branch',
        worktree: path.basename(linked),
      })

      h.recorder.acknowledged ??= new Set()
      h.recorder.acknowledged.add(h.recorder.receipts[0]!)
      await hookRunCommand(
        h.deps,
        'stop',
        stdin({
          session_id: 'session-worktree-transition',
          cwd: h.deps.cwd,
          stop_hook_active: true,
        }),
        'claude-code',
      )
      expect(h.recorder.closed).toContain(h.recorder.receipts[0])
      expect(
        h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
      ).toHaveLength(0)
    } finally {
      runFixtureGit(h.deps.cwd, 'worktree', 'remove', '--force', linked)
    }
  })

  it('stamps structured Source Context on the question it pushes', async () => {
    const h = harness([])
    registerQuestion(
      'sess-abc',
      h.env,
      {
        question: 'Ship it?',
        source: {
          session_id: 'sess-abc',
          session_label: 'Semantic session',
          harness: 'claude-code',
        },
      },
      NOW,
    )

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sess-abc' }))

    expect(h.recorder.submitted[0]?.draft.source).toEqual({
      session_id: 'sess-abc',
      session_label: 'Semantic session',
      harness: 'claude-code',
    })
  })

  it('stamps the retirement too, so it lands on the right agent’s notification', async () => {
    const h = harness([reply({ text: 'Yes' })])
    registerQuestion(
      'sess-abc',
      h.env,
      {
        question: 'Ship it?',
        source: {
          session_id: 'sess-abc',
          session_label: 'Semantic session',
          harness: 'claude-code',
        },
      },
      NOW,
    )

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sess-abc' }))
    h.recorder.acknowledged ??= new Set()
    h.recorder.acknowledged.add(h.recorder.receipts[0]!)
    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'sess-abc', stop_hook_active: true }),
    )

    expect(h.recorder.closed).toContain(h.recorder.receipts[0])
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
  })

  it('preserves a human session label without displaying the opaque id', async () => {
    const h = harness([])
    registerQuestion(
      'sess-abc',
      h.env,
      {
        question: 'Ship it?',
        source: {
          session_id: 'sess-abc',
          session_label: 'Migration Worktree',
          harness: 'claude-code',
        },
      },
      NOW,
    )

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sess-abc' }))

    const draft = h.recorder.submitted[0]?.draft
    expect(draft?.source?.session_label).toBe('Migration Worktree')
    expect(draft?.presentation.title).not.toContain('sess-abc')
    expect(draft?.presentation.body).not.toContain('sess-abc')
  })
})

describe('clock jumps', () => {
  it('does not let a stamp from the future consume the whole waiter ceiling', async () => {
    // `asked_at` is wall-clock, and an NTP correction or VM resume can move it.
    // A stamp thirty days out would otherwise make the grace window unreachable
    // and leave nothing of the ceiling for an answer to arrive in.
    const h = harness([])
    writeGlobalConfig(h, 'ask_grace_seconds = 300\n')
    registerQuestion('sess-jump', h.env, { question: 'Ship it?' }, NOW + 30 * 24 * 3600 * 1000)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sess-jump' }))

    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    // The window ran from now, not from the impossible stamp.
    expect(h.deps.now?.()).toBeGreaterThanOrEqual(NOW + 300_000)
  })
})

/**
 * SessionEnd cleans up, but a crashed harness never reaches it,
 * and roughly a hundred sessions a day is tens of thousands of dead files a
 * year that nothing reads.
 */
describe('pruning abandoned session state', () => {
  function sessionFile(h: Harness, name: string): string {
    return path.join(h.env['XDG_STATE_HOME'] as string, 'notifai', 'sessions', name)
  }

  // Real wall-clock, because this reasons about file mtimes.
  const REAL = Date.now()

  it('removes state a crashed harness left behind, and keeps live state', () => {
    const h = harness()
    writeSessionState('alive', h.env, { last_prompt_at: NOW })
    writeSessionState('abandoned', h.env, { last_prompt_at: NOW })
    const old = new Date(REAL - 30 * 24 * 3600 * 1000)
    utimesSync(sessionFile(h, `${sanitizeSessionId('abandoned')}.json`), old, old)

    expect(pruneAbandonedSessions(h.env, REAL)).toBe(1)

    expect(readSessionState('alive', h.env).last_prompt_at).toBe(NOW)
    expect(readSessionState('abandoned', h.env)).toEqual({})
  })

  it('does not walk the directory again for a day', () => {
    const h = harness()
    writeSessionState('a', h.env, { last_prompt_at: NOW })
    pruneAbandonedSessions(h.env, REAL)

    const old = new Date(REAL - 30 * 24 * 3600 * 1000)
    utimesSync(sessionFile(h, `${sanitizeSessionId('a')}.json`), old, old)

    // Same day: skipped entirely, so the stale file survives.
    expect(pruneAbandonedSessions(h.env, REAL + 3600_000)).toBe(0)
    expect(readSessionState('a', h.env).last_prompt_at).toBe(NOW)
    // Next day: swept.
    expect(pruneAbandonedSessions(h.env, REAL + 25 * 3600 * 1000)).toBe(1)
  })

  it('does not read a clock jump as a directory full of dead sessions', () => {
    // A backward jump makes every file look like it came from the future.
    // Deleting live state there would lose a question already on the phone.
    const h = harness()
    writeSessionState('jumped', h.env, { last_prompt_at: NOW })

    expect(pruneAbandonedSessions(h.env, REAL - 400 * 24 * 3600 * 1000)).toBe(0)
    expect(readSessionState('jumped', h.env).last_prompt_at).toBe(NOW)
  })

  it('never fails a hook because housekeeping could not run', () => {
    expect(pruneAbandonedSessions({ XDG_STATE_HOME: '/dev/null' }, REAL)).toBe(0)
  })

  it('bounds what one runaway question can write to disk', () => {
    const h = harness()
    registerQuestion('big', h.env, { question: 'x'.repeat(50_000) })
    expect(readSessionState('big', h.env).pending?.[0]?.question.length).toBeLessThanOrEqual(2000)
  })
})

describe('durable state writes', () => {
  function sessionFile(h: Harness, sessionId: string): string {
    return path.join(
      h.env['XDG_STATE_HOME'] as string,
      'notifai',
      'sessions',
      `${sanitizeSessionId(sessionId)}.json`,
    )
  }

  it('recovers a truncated state file with one complete atomic document', () => {
    const h = harness()
    const file = sessionFile(h, 'truncated')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{"pending":')
    expect(readSessionState('truncated', h.env)).toEqual({})

    writeSessionState('truncated', h.env, { last_prompt_at: NOW })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      last_prompt_at: NOW,
      session_id: 'truncated',
    })
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('refuses a session-state symlink instead of writing through it', () => {
    const h = harness()
    const file = sessionFile(h, 'linked')
    const target = path.join(path.dirname(file), 'target.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(target, '{"untouched":true}\n')
    symlinkSync(target, file)

    expect(() => writeSessionState('linked', h.env, { last_prompt_at: NOW })).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('{"untouched":true}\n')
  })

  it('refuses project-pointer and retirement-queue symlinks too', () => {
    const h = harness()
    writeSessionState('linked-pointer', h.env, { last_prompt_at: NOW })
    const target = path.join(h.env['XDG_STATE_HOME'] as string, 'pointer-target.json')
    writeFileSync(target, '{"untouched":true}\n')
    const pointer = projectSessionPointerPath(h.deps.cwd, h.env)
    mkdirSync(path.dirname(pointer), { recursive: true })
    symlinkSync(target, pointer)

    expect(() =>
      writeProjectSession(h.deps.cwd, h.env, 'linked-pointer', NOW, 'claude-code'),
    ).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('{"untouched":true}\n')

    const queueTarget = path.join(h.env['XDG_STATE_HOME'] as string, 'queue-target.json')
    const queue = path.join(h.env['XDG_STATE_HOME'] as string, 'notifai', 'retire-queue.json')
    writeFileSync(queueTarget, '[]\n')
    symlinkSync(queueTarget, queue)
    expect(() =>
      orphanRetirements(
        h.env,
        [
          {
            request_id: 'req_linked',
            collapse_key: 'collapse-linked',
            device_ids: ['dev_iphone'],
            question: 'Still there?',
            state: 'expired',
          },
        ],
        NOW,
      ),
    ).toThrow(/symlink/)
    expect(readFileSync(queueTarget, 'utf8')).toBe('[]\n')
  })

  it('persists each successful retirement before a later close failure interrupts the drain', async () => {
    const h = harness()
    writeSessionState('partial-drain', h.env, {
      retiring: [
        {
          request_id: 'req_good',
          collapse_key: 'collapse-good',
          device_ids: ['dev_iphone'],
          question: 'First?',
          state: 'expired',
        },
        {
          request_id: 'req_bad',
          collapse_key: 'collapse-bad',
          device_ids: ['dev_iphone'],
          question: 'Second?',
          state: 'expired',
        },
      ],
    })
    const base = h.deps.clientFactory!('https://test.notifai.invalid', 'Bearer x')
    const ctx = {
      client: {
        ...base,
        closeReplies: async (requestId: string) => {
          if (requestId === 'req_bad') throw new Error('offline')
          return base.closeReplies(requestId)
        },
      },
      config: loadConfig({ cwd: h.deps.cwd, env: h.env }),
    }

    await drainRetirements(ctx, 'partial-drain', h.env)

    expect(readSessionState('partial-drain', h.env).retiring?.map((entry) => entry.request_id)).toEqual([
      'req_bad',
    ])
    expect(h.recorder.closed).toEqual(['req_good'])
  })
})

/**
 * Path-independent ownership stops the usual cause
 * of two handlers firing; this stops the consequence when something else does.
 */
describe('two hooks racing one question', () => {
  const REAL = Date.now()

  it('lets exactly one process push', () => {
    const h = harness()
    expect(claimQuestionPush('race1', h.env, REAL)).toBe(true)
    expect(claimQuestionPush('race1', h.env, REAL)).toBe(false)
  })

  it('frees the claim for the next turn', () => {
    const h = harness()
    claimQuestionPush('race2', h.env, REAL)
    releaseQuestionPush('race2', h.env)
    expect(claimQuestionPush('race2', h.env, REAL)).toBe(true)
  })

  it('breaks a claim whose holder cannot still be running', () => {
    // A crashed hook must not suppress every question for this session for
    // ever — that is worse than the duplicate the claim prevents.
    const h = harness()
    const file = path.join(stateDir(h.env), 'sessions', `${sanitizeSessionId('race3')}.claim`)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify({ pid: 999_999_999, at: REAL - 1, token: 'dead' })}\n`,
    )
    expect(claimQuestionPush('race3', h.env, REAL)).toBe(true)
  })

  it('never steals an old claim while its process is still alive', () => {
    const h = harness()
    expect(claimQuestionPush('race-live', h.env, REAL - 10 * 60_000)).toBe(true)
    expect(claimQuestionPush('race-live', h.env, REAL)).toBe(false)
  })

  it('serializes a contender that arrives while a stale claim is being replaced', () => {
    const h = harness()
    const file = path.join(
      stateDir(h.env),
      'sessions',
      `${sanitizeSessionId('race-break')}.claim`,
    )
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify({ pid: 999_999_999, at: REAL - 10 * 60_000, token: 'dead' })}\n`,
    )
    let contender: ReturnType<typeof claimQuestionPush> | undefined

    const recovered = claimQuestionPush('race-break', h.env, REAL, () => {
      contender = claimQuestionPush('race-break', h.env, REAL)
    })

    expect(contender).toBeDefined()
    expect([recovered, contender].filter(Boolean)).toHaveLength(1)
  })

  it('does not let two sessions block each other', () => {
    const h = harness()
    expect(claimQuestionPush('race4a', h.env, REAL)).toBe(true)
    expect(claimQuestionPush('race4b', h.env, REAL)).toBe(true)
  })

  it('sends one notification when a second Stop arrives mid-flight', async () => {
    const h = harness([])
    writeSessionState('race5', h.env, { last_prompt_at: AWAY })
    registerQuestion('race5', h.env, { question: 'Ship it?' })
    // Standing in for the other process: the claim is already held.
    claimQuestionPush('race5', h.env, Date.now())

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'race5' }))

    expect(h.recorder.submitted).toHaveLength(0)
    expect(h.io.errLines.join(" ")).toContain('already handling')
  })

  it('waits past fifteen seconds for an older owner to hand off a newer ask', async () => {
    const h = harness([reply({ text: 'Continue' })])
    writeSessionState('race-long-handoff', h.env, { last_prompt_at: AWAY })
    registerQuestion('race-long-handoff', h.env, { question: 'Original?' }, NOW)
    expect(claimQuestionPush('race-long-handoff', h.env, Date.now())).toBe(true)
    h.advanceClock(1)
    registerQuestion(
      'race-long-handoff',
      h.env,
      { question: 'New independent ask?' },
      NOW + 1,
    )
    const startedAt = h.deps.now!()
    let handedOff = false
    h.deps.sleep = async (milliseconds: number) => {
      h.advanceClock(milliseconds)
      if (!handedOff && h.deps.now!() - startedAt >= 20_000) {
        handedOff = true
        releaseQuestionPush('race-long-handoff', h.env)
      }
    }

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'race-long-handoff' }))

    expect(handedOff).toBe(true)
    expect(h.deps.now!() - startedAt).toBeGreaterThanOrEqual(20_000)
    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(2)
    expect(h.io.errLines.join(' ')).not.toContain('claimed-elsewhere')
  })

  it('waits through the holder teardown margin instead of stranding a boundary ask', async () => {
    const h = harness([reply({ text: 'Continue' })])
    writeSessionState('race-holder-deadline', h.env, { last_prompt_at: AWAY })
    registerQuestion('race-holder-deadline', h.env, { question: 'Original?' }, NOW)
    expect(
      claimQuestionPush(
        'race-holder-deadline',
        h.env,
        Date.now(),
        undefined,
        NOW + 20_000,
      ),
    ).toBe(true)
    h.advanceClock(1)
    registerQuestion(
      'race-holder-deadline',
      h.env,
      { question: 'New?' },
      NOW + 1,
    )
    let released = false
    h.deps.sleep = async (milliseconds: number) => {
      h.advanceClock(milliseconds)
      if (!released && h.deps.now!() >= NOW + 25_000) {
        released = true
        releaseQuestionPush('race-holder-deadline', h.env)
      }
    }

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'race-holder-deadline' }))

    expect(released).toBe(true)
    expect(h.deps.now!()).toBeGreaterThanOrEqual(NOW + 25_000)
    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(2)
  })

  it('stops waiting when another successor snapshots the new ask', async () => {
    const h = harness([])
    writeSessionState('race-resnapshot', h.env, { last_prompt_at: AWAY })
    registerQuestion('race-resnapshot', h.env, { question: 'Original?' }, NOW)
    expect(
      claimQuestionPush(
        'race-resnapshot',
        h.env,
        Date.now(),
        undefined,
        NOW + 60_000,
      ),
    ).toBe(true)
    h.advanceClock(1)
    registerQuestion('race-resnapshot', h.env, { question: 'New?' }, NOW + 1)
    const startedAt = h.deps.now!()
    let replacementClaimed = false
    h.deps.sleep = async (milliseconds: number) => {
      h.advanceClock(milliseconds)
      if (!replacementClaimed && h.deps.now!() - startedAt >= 20_000) {
        releaseQuestionPush('race-resnapshot', h.env)
        replacementClaimed = claimQuestionPush(
          'race-resnapshot',
          h.env,
          Date.now(),
          undefined,
          NOW + 40_000,
        )
      }
    }

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'race-resnapshot' }))

    expect(replacementClaimed).toBe(true)
    expect(h.deps.now!() - startedAt).toBe(20_000)
    expect(h.recorder.submitted).toEqual([])
    releaseQuestionPush('race-resnapshot', h.env)
  })

  it('resumes the agent once when two Stops collect the same late answer', async () => {
    const answers: ReplyView[] = []
    const h = harness(answers)
    writeSessionState('race-late-answer', h.env, {
      last_prompt_at: AWAY,
      pending: [
        {
          question: 'Ship it?',
          asked_at: NOW,
          request_id: 'req_existing',
          collapse_key: 'question-existing',
          device_ids: ['dev_iphone'],
          reply_deadline_at: NOW + 60_000,
        },
      ],
    })
    answers.push(reply({ text: 'Ship it' }))
    h.io.outLines = []

    let polls = 0
    let markFirstPoll: (() => void) | undefined
    const firstPoll = new Promise<void>((resolve) => {
      markFirstPoll = resolve
    })
    let releasePolls: (() => void) | undefined
    const heldPoll = new Promise<void>((resolve) => {
      releasePolls = resolve
    })
    h.recorder.beforeReplies = async () => {
      polls += 1
      markFirstPoll?.()
      await heldPoll
    }

    const firstStop = hookRunCommand(h.deps, 'stop', stdin({ session_id: 'race-late-answer' }))
    await firstPoll
    const secondStop = hookRunCommand(h.deps, 'stop', stdin({ session_id: 'race-late-answer' }))
    await Promise.race([secondStop, new Promise<void>((resolve) => setImmediate(resolve))])
    releasePolls?.()
    await Promise.all([firstStop, secondStop])

    const resumes = h.io.outLines.map((line) => JSON.parse(line) as { decision?: string })
    expect(polls).toBe(1)
    expect(resumes.filter((entry) => entry.decision === 'block')).toHaveLength(1)
  })

  it('hands the claim to a later Stop so its independent question is sent now', async () => {
    const h = harness([])
    h.deps.sleep = async (milliseconds: number) => {
      h.advanceClock(milliseconds)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    h.recorder.repliesFor = (requestId) =>
      h.recorder.aliases.get(requestId) === 2
        ? [reply({ text: 'Answer the newer question' })]
        : []
    let markFirstPoll: (() => void) | undefined
    const firstPoll = new Promise<void>((resolve) => {
      markFirstPoll = resolve
    })
    let releaseFirstPoll: (() => void) | undefined
    const heldFirstPoll = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve
    })
    let hold = true
    h.recorder.beforeReplies = async () => {
      if (!hold) return
      hold = false
      markFirstPoll?.()
      await heldFirstPoll
    }
    writeSessionState('claim-handoff', h.env, { last_prompt_at: AWAY })
    registerQuestion('claim-handoff', h.env, { question: 'Older question?' }, NOW)

    const firstStop = hookRunCommand(h.deps, 'stop', stdin({ session_id: 'claim-handoff' }))
    await firstPoll
    registerQuestion('claim-handoff', h.env, { question: 'Newer question?' }, NOW + 1)
    const secondStop = hookRunCommand(h.deps, 'stop', stdin({ session_id: 'claim-handoff' }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFirstPoll?.()
    await Promise.all([firstStop, secondStop])

    const sent = h.recorder.submitted
      .filter((entry) => isQuestionSubmit(entry))
      .map((entry) => entry.draft.presentation.body)
    expect(sent).toEqual(['Older question?', 'Newer question?'])
    expect(h.io.outLines.join('\n')).toContain('Answer the newer question')
    expect(h.io.errLines.join('\n')).toContain('yielding the answer owner')
  })
})

describe('question registration racing a Stop submission', () => {
  it('preserves both questions while the old owner yields to the new ask', async () => {
    const h = harness([])
    writeSessionState('submit-race', h.env, { last_prompt_at: AWAY })
    registerQuestion('submit-race', h.env, { question: 'Old question?' }, NOW)
    h.recorder.beforeQuestionSubmit = () => {
      h.recorder.beforeQuestionSubmit = undefined
      registerQuestion('submit-race', h.env, { question: 'New question?' }, NOW + 1)
    }

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'submit-race' }))

    // The racing ask is a handoff signal. This owner leaves the delivered old
    // question and the new unasked one intact for the successor Stop.
    const state = readSessionState('submit-race', h.env)
    expect(state.pending?.map((entry) => entry.question)).toEqual([
      'Old question?',
      'New question?',
    ])
    expect(state.pending?.[0]?.request_id).toBe(h.recorder.receipts[0])
    expect(state.pending?.[1]?.request_id).toBeUndefined()
    expect(h.io.errLines.join('\n')).toContain('yielding the answer owner')
  })

  it('lets the successor owner collect an old answer without losing the newer question', async () => {
    const h = harness([reply({ text: 'Old answer' })])
    writeSessionState('answer-race', h.env, { last_prompt_at: AWAY })
    registerQuestion('answer-race', h.env, { question: 'Old question?' }, NOW)
    h.recorder.beforeQuestionSubmit = () => {
      h.recorder.beforeQuestionSubmit = undefined
      registerQuestion('answer-race', h.env, { question: 'New question?' }, NOW + 1)
    }

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'answer-race' }))
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'answer-race' }))

    const state = readSessionState('answer-race', h.env)
    expect(state.pending?.map((entry) => entry.question)).toEqual(['New question?'])
    expect(state.accepted?.answers[0]?.pending.request_id).toBe(h.recorder.receipts[0])
    expect(state.accepted?.answers[0]?.reply.text).toBe('Old answer')
  })
})

describe('Claude Code Stop wake route', () => {
  function claudeWake(status: 'idle' | 'busy' = 'idle'): ClaudeWakeAdapters & {
    sent: string[]
    resumed: string[]
    sleeps: number[]
  } {
    const sent: string[] = []
    const resumed: string[] = []
    const sleeps: number[] = []
    return {
      sent,
      resumed,
      sleeps,
      async listAgents() {
        return [
          {
            pid: 12345,
            sessionId: 'claude-route',
            startedAt: NOW,
            status,
          },
        ]
      },
      readDescriptor() {
        return {
          pid: 12345,
          sessionId: 'claude-route',
          cwd: '/tmp/claude-route',
          startedAt: NOW,
          procStart: 'Wed Aug 12 08:17:53 2026',
          version: '2.1.228',
          peerProtocol: 1,
          messagingSocketPath: '/tmp/cc-socks/12345.sock',
          status,
        }
      },
      async sendSocket(_socketPath, line) {
        sent.push(line)
      },
      async resume(_sessionId, _cwd, context) {
        resumed.push(context)
      },
      async sleep(milliseconds) {
        sleeps.push(milliseconds)
      },
    }
  }

  it('routes an accepted answer through the Claude inbox instead of hook stdout', async () => {
    const h = harness([reply({ text: 'BETA' })])
    writeGlobalConfig(h, 'ask_grace_seconds = 0\n')
    writeSessionState('claude-route', h.env, { last_prompt_at: AWAY })
    const built = buildQuestions({ choice: ['ALPHA', 'BETA'] }, 'Which rollout option?')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    registerQuestion('claude-route', h.env, {
      question: 'Which rollout option?',
      questions: built.questions,
    })
    const wake = claudeWake()

    await hookRunCommand(
      { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 },
      'stop',
      stdin({ session_id: 'claude-route', cwd: '/tmp/claude-route' }),
      'claude-code',
    )

    expect(h.io.outLines).toEqual([])
    expect(wake.sent).toHaveLength(1)
    const message = JSON.parse(wake.sent[0]!) as {
      type: string
      message: { role: string; content: string }
    }
    expect(message).toMatchObject({ type: 'user', message: { role: 'user' } })
    expect(message.message.content).toContain('question_id')
    expect(message.message.content).toContain('"Which rollout option?"')
    expect(message.message.content).toContain('"BETA"')
    expect(message.message.content).not.toMatch(/trusted|urgent|permission|approval/i)
    expect(wake.sleeps).toEqual([CLAUDE_POST_SEND_LIVENESS_MS])
    expect(readSessionState('claude-route', h.env).accepted).toBeDefined()
  })

  it('keeps the detached owner through the default one-day answer window', async () => {
    const h = harness([])
    const answerAt = NOW + (86_400 - 10) * 1000
    h.recorder.replyExpiresAt = new Date(NOW + 86_400_000).toISOString()
    const factory = h.deps.clientFactory
    h.deps.clientFactory = () => {
      const client = factory!()
      return {
        ...client,
        replies: async (
          requestId: string,
          options: { waitSeconds: number; afterSeq: number },
        ) => {
          const remaining = Math.max(0, answerAt - (h.deps.now?.() ?? NOW))
          h.advanceClock(Math.min(options.waitSeconds * 1000, remaining))
          const response = await client.replies(requestId, options)
          return {
            ...response,
            replies:
              (h.deps.now?.() ?? NOW) >= answerAt
                ? [reply({ text: 'Wake near the one-day edge' })]
                : [],
          }
        },
      } as ApiClient
    }
    writeSessionState('claude-route', h.env, { last_prompt_at: AWAY })
    registerQuestion('claude-route', h.env, { question: 'Deploy?' }, NOW)
    const wake = claudeWake()

    await hookRunCommand(
      { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 },
      'stop',
      stdin({ session_id: 'claude-route', cwd: '/tmp/claude-route' }),
      'claude-code',
    )

    expect((h.deps.now?.() ?? NOW) - NOW).toBeGreaterThan(8 * 60 * 1000)
    expect(wake.sent).toHaveLength(1)
    expect(wake.sent[0]).toContain('Wake near the one-day edge')
  })

  it('stops a detached observer when SessionEnd removes its ownership', async () => {
    const h = harness([reply({ text: 'Too late' })])
    let markPoll: (() => void) | undefined
    const pollStarted = new Promise<void>((resolve) => {
      markPoll = resolve
    })
    let releasePoll: (() => void) | undefined
    const heldPoll = new Promise<void>((resolve) => {
      releasePoll = resolve
    })
    h.recorder.beforeReplies = async () => {
      markPoll?.()
      await heldPoll
    }
    writeSessionState('claude-route', h.env, { last_prompt_at: AWAY })
    registerQuestion('claude-route', h.env, { question: 'Deploy?' }, NOW)
    const wake = claudeWake()
    const deps = { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 }

    const stop = hookRunCommand(
      deps,
      'stop',
      stdin({ session_id: 'claude-route', cwd: '/tmp/claude-route' }),
      'claude-code',
    )
    await pollStarted
    await hookRunCommand(
      deps,
      'session-end',
      stdin({ session_id: 'claude-route', cwd: '/tmp/claude-route' }),
      'claude-code',
    )
    releasePoll?.()
    await stop

    expect(wake.sent).toEqual([])
    expect(readSessionState('claude-route', h.env).accepted).toBeUndefined()
    expect(h.io.errLines.join('\n')).toContain('stopping this observer')
    expect(claimQuestionPush('claude-route', h.env)).toBe(true)
    releaseQuestionPush('claude-route', h.env)
  })

  it('does not resurrect or wake an ended session after its close fence returns', async () => {
    const h = harness([reply({ text: 'Too late' })])
    const factory = h.deps.clientFactory!
    let markClose: (() => void) | undefined
    const closeStarted = new Promise<void>((resolve) => {
      markClose = resolve
    })
    let releaseClose: (() => void) | undefined
    const heldClose = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    h.deps.clientFactory = (...args) => {
      const client = factory(...args)
      return {
        ...client,
        closeReplies: async (requestId: string) => {
          markClose?.()
          await heldClose
          return client.closeReplies(requestId)
        },
      } as ApiClient
    }
    writeSessionState('claude-fence-end', h.env, { last_prompt_at: AWAY })
    registerQuestion('claude-fence-end', h.env, { question: 'Deploy?' }, NOW)
    const wake = claudeWake()
    const deps = { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 }

    const stop = hookRunCommand(
      deps,
      'stop',
      stdin({ session_id: 'claude-fence-end', cwd: '/tmp/claude-fence-end' }),
      'claude-code',
    )
    await closeStarted
    await hookRunCommand(
      deps,
      'session-end',
      stdin({ session_id: 'claude-fence-end', cwd: '/tmp/claude-fence-end' }),
      'claude-code',
    )
    releaseClose?.()
    await stop

    expect(wake.sent).toEqual([])
    expect(readSessionState('claude-fence-end', h.env).accepted).toBeUndefined()
    expect(h.io.errLines.join('\n')).toContain('ended before answer delivery')
  })

  it('globally retires a submission that commits after SessionEnd', async () => {
    const h = harness([])
    const factory = h.deps.clientFactory!
    let markSubmit: (() => void) | undefined
    const submitStarted = new Promise<void>((resolve) => {
      markSubmit = resolve
    })
    let releaseSubmit: (() => void) | undefined
    const heldSubmit = new Promise<void>((resolve) => {
      releaseSubmit = resolve
    })
    h.deps.clientFactory = (...args) => {
      const client = factory(...args)
      return {
        ...client,
        submit: async (body: SubmitNotificationRequestT, waitSeconds: number) => {
          if (body.draft.reply !== undefined) {
            markSubmit?.()
            await heldSubmit
          }
          return client.submit(body, waitSeconds)
        },
      } as ApiClient
    }
    writeSessionState('claude-submit-end', h.env, { last_prompt_at: AWAY })
    registerQuestion('claude-submit-end', h.env, { question: 'Deploy?' }, NOW)
    const wake = claudeWake()
    const deps = { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 }

    const stop = hookRunCommand(
      deps,
      'stop',
      stdin({ session_id: 'claude-submit-end', cwd: '/tmp/claude-submit-end' }),
      'claude-code',
    )
    await submitStarted
    await hookRunCommand(
      deps,
      'session-end',
      stdin({ session_id: 'claude-submit-end', cwd: '/tmp/claude-submit-end' }),
      'claude-code',
    )
    releaseSubmit?.()
    await stop

    const client = factory('https://test.notifai.invalid', 'Bearer test')
    await drainOrphanRetirements(
      { client, config: loadConfig({ cwd: h.deps.cwd, env: h.env }) },
      h.env,
      NOW,
    )
    expect(wake.sent).toEqual([])
    expect(h.recorder.closed).toContain(h.recorder.receipts[0])
    expect(readSessionState('claude-submit-end', h.env).pending).toBeUndefined()
  })

  /** One answer already accepted and journaled, ready for the next Stop. */
  function journaledAnswer(
    h: Harness,
    options: { recordedAt?: number; deliveredAt?: number } = {},
  ): void {
    const recordedAt = options.recordedAt ?? NOW
    writeSessionState('claude-route', h.env, {
      ...readSessionState('claude-route', h.env),
      accepted: {
        ...(options.deliveredAt === undefined
          ? {}
          : { delivered_at: options.deliveredAt, delivered_route: 'inbox-socket' }),
        answers: [
          {
            pending: {
              question: 'Which rollout option?',
              request_id: 'req_existing',
              collapse_key: 'question-existing',
              device_ids: ['dev_iphone'],
            },
            reply: reply({ text: 'BETA' }),
            replies: [reply({ text: 'BETA' })],
          },
        ],
        remaining: 0,
        recorded_at: recordedAt,
      },
    })
  }

  it('settles a socket delivery so the woken turn cannot redeliver the answer', async () => {
    // The exact device-proof failure. A socket delivery starts a brand-new turn
    // rather than continuing this one, so the Stop that ends the woken turn
    // reports stop_hook_active=false — for ever. While that flag was the only
    // acknowledgement, the journal never settled and every turn-end delivered
    // the same answer again: 250 times, in the transcript that found this.
    const h = harness([])
    journaledAnswer(h)
    const wake = claudeWake()
    const deps = { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 }
    const stop = (stopHookActive: boolean) =>
      hookRunCommand(
        deps,
        'stop',
        stdin({
          session_id: 'claude-route',
          cwd: '/tmp/claude-route',
          stop_hook_active: stopHookActive,
        }),
        'claude-code',
      )

    await stop(false)

    expect(wake.sent).toHaveLength(1)
    const delivered = readSessionState('claude-route', h.env).accepted
    expect(delivered?.delivered_route).toBe('inbox-socket')
    expect(typeof delivered?.delivered_at).toBe('number')

    // Three more turn-ends of the woken session, none of them a continuation.
    await stop(false)
    await stop(false)
    await stop(false)

    expect(wake.sent).toHaveLength(1)
    expect(wake.resumed).toEqual([])
    expect(readSessionState('claude-route', h.env).accepted).toBeUndefined()
    expect(h.recorder.closed).toContain('req_existing')
    expect(
      h.recorder.submitted.filter((entry) => isRetirementSubmit(entry)),
    ).toHaveLength(0)
  })

  it('applies the continuation cap to a woken turn that never sets stop_hook_active', async () => {
    // The chained loop the cap exists for, on a route that starts new turns.
    // Keyed to stop_hook_active the cap could never fire here at all.
    const h = harness([])
    writeGlobalConfig(h, 'ask_grace_seconds = 0\n')
    writeSessionState('claude-route', h.env, {
      last_prompt_at: AWAY,
      continuation: { answered_at: NOW - 2000, count: MAX_CONTINUATION_COUNT - 1 },
    })
    journaledAnswer(h, { recordedAt: NOW - 1000, deliveredAt: NOW - 900 })
    // The woken turn asked a genuinely new question before it ended.
    registerQuestion('claude-route', h.env, { question: 'And after that?' }, NOW)
    const wake = claudeWake()

    await hookRunCommand(
      { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 },
      'stop',
      stdin({
        session_id: 'claude-route',
        cwd: '/tmp/claude-route',
        stop_hook_active: false,
      }),
      'claude-code',
    )

    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toEqual(
      [],
    )
    expect(readSessionState('claude-route', h.env).pending?.[0]?.question).toBe('And after that?')
    expect(h.io.errLines.join('\n')).toContain(
      `continuation limit (${MAX_CONTINUATION_COUNT}) reached`,
    )
  })

  it('uses the accepted journal as the loop guard after a socket wake fires Stop again', async () => {
    const h = harness([])
    writeSessionState('claude-route', h.env, {
      accepted: {
        answers: [
          {
            pending: {
              question: 'Which rollout option?',
              request_id: 'req_existing',
              collapse_key: 'question-existing',
              device_ids: ['dev_iphone'],
            },
            reply: reply({ text: 'BETA' }),
            replies: [reply({ text: 'BETA' })],
          },
        ],
        remaining: 0,
        recorded_at: NOW,
      },
    })
    const wake = claudeWake()

    await hookRunCommand(
      { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 },
      'stop',
      stdin({
        session_id: 'claude-route',
        cwd: '/tmp/claude-route',
        stop_hook_active: true,
      }),
      'claude-code',
    )

    expect(wake.sent).toEqual([])
    expect(wake.resumed).toEqual([])
    expect(h.io.outLines).toEqual([])
    expect(readSessionState('claude-route', h.env).accepted).toBeUndefined()
  })
})

describe('Codex Stop wake route', () => {
  const CODEX_THREAD = '019ff69d-a07f-7161-ab6e-bd06b3b93c8e'

  function codexWake(
    options: { sourceAlive?: boolean; probe?: CodexWakeObservation } = {},
  ): CodexWakeAdapters & { resumed: string[]; probed: string[] } {
    const resumed: string[] = []
    const probed: string[] = []
    return {
      resumed,
      probed,
      probeThreadWriter(lockPath) {
        probed.push(lockPath)
        return options.probe ?? { state: 'stopped' }
      },
      sourceAlive() {
        return options.sourceAlive ?? true
      },
      async resume(_threadId, _cwd, context) {
        resumed.push(context)
      },
    }
  }

  function journaledAnswer(h: Harness): void {
    writeSessionState(CODEX_THREAD, h.env, {
      accepted: {
        answers: [
          {
            pending: {
              question: 'Which rollout option?',
              request_id: 'req_existing',
              collapse_key: 'question-existing',
              device_ids: ['dev_iphone'],
            },
            reply: reply({ text: 'BETA' }),
            replies: [reply({ text: 'BETA' })],
          },
        ],
        remaining: 0,
        recorded_at: NOW,
      },
    })
  }

  it('continues the held turn with decision:block when the answer arrives during the hold', async () => {
    const h = harness([reply({ text: 'BETA' })])
    writeGlobalConfig(h, 'ask_grace_seconds = 0\n')
    writeSessionState(CODEX_THREAD, h.env, { last_prompt_at: AWAY })
    const built = buildQuestions({ choice: ['ALPHA', 'BETA'] }, 'Which rollout option?')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    registerQuestion(CODEX_THREAD, h.env, {
      question: 'Which rollout option?',
      questions: built.questions,
    })
    const wake = codexWake()

    await hookRunCommand(
      { ...h.deps, codexWake: wake, codexSourcePid: 12345 },
      'stop',
      stdin({ session_id: CODEX_THREAD, cwd: '/tmp/codex-route' }),
      'codex',
    )

    expect(h.io.outLines).toHaveLength(1)
    const decision = JSON.parse(h.io.outLines[0]!) as { decision: string; reason: string }
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('"BETA"')
    // The default route owes the thread-writer lock nothing: a live Codex is
    // reading this stdout, and a probe could only take the answer away.
    expect(wake.probed).toEqual([])
    expect(wake.resumed).toEqual([])
    expect(readSessionState(CODEX_THREAD, h.env).accepted).toBeDefined()
  })

  it('replays an answer journaled after the hold on the next Stop', async () => {
    const h = harness([])
    journaledAnswer(h)
    const wake = codexWake()

    await hookRunCommand(
      { ...h.deps, codexWake: wake, codexSourcePid: 12345 },
      'stop',
      stdin({ session_id: CODEX_THREAD, cwd: '/tmp/codex-route' }),
      'codex',
    )

    expect(h.io.outLines).toHaveLength(1)
    expect(JSON.parse(h.io.outLines[0]!)).toMatchObject({ decision: 'block' })
    // Still journaled: only a successor Stop proves the continued turn ran.
    expect(readSessionState(CODEX_THREAD, h.env).accepted).toBeDefined()
  })

  it('cold-resumes the journaled answer when the Codex process is gone and no writer holds the thread', async () => {
    const h = harness([])
    journaledAnswer(h)
    const wake = codexWake({ sourceAlive: false, probe: { state: 'stopped' } })

    await hookRunCommand(
      { ...h.deps, codexWake: wake, codexSourcePid: 12345 },
      'stop',
      stdin({ session_id: CODEX_THREAD, cwd: '/tmp/codex-route' }),
      'codex',
    )

    expect(h.io.outLines).toEqual([])
    expect(wake.resumed).toHaveLength(1)
    expect(wake.resumed[0]).toContain('"BETA"')
    expect(wake.probed).toHaveLength(2)
  })

  it('holds the answer rather than resuming a thread a live writer owns', async () => {
    const h = harness([])
    journaledAnswer(h)
    const wake = codexWake({ sourceAlive: false, probe: { state: 'live' } })

    await hookRunCommand(
      { ...h.deps, codexWake: wake, codexSourcePid: 12345 },
      'stop',
      stdin({ session_id: CODEX_THREAD, cwd: '/tmp/codex-route' }),
      'codex',
    )

    expect(h.io.outLines).toEqual([])
    expect(wake.resumed).toEqual([])
    expect(readSessionState(CODEX_THREAD, h.env).accepted).toBeDefined()
    expect(h.io.errLines.join('\n')).toContain('holding the accepted answer for the next turn')
  })
})

describe('escalation waiter delivery seam', () => {
  function waiterContext(h: Harness) {
    const client = h.deps.clientFactory!('https://test.notifai.invalid', 'Bearer test')
    return {
      client,
      config: loadConfig({ cwd: h.deps.cwd, env: h.env }),
      env: h.env,
      now: h.deps.now!,
      sleep: h.deps.sleep!,
      waitForFirstReply: async (requestId: string, timeoutSeconds: number) => {
        const response = await client.replies(requestId, {
          waitSeconds: timeoutSeconds,
          afterSeq: 0,
        })
        return { replies: response.replies, timedOut: response.replies.length === 0 }
      },
      harness: 'codex' as const,
    }
  }

  it('waits through grace, routes the fenced answer, and holds the claim until delivery settles', async () => {
    const h = harness([reply({ text: 'Ship it' })])
    writeGlobalConfig(h, 'ask_grace_seconds = 120\n')
    writeSessionState('waiter-route', h.env, { last_prompt_at: AWAY })
    registerQuestion('waiter-route', h.env, { question: 'Ship it?' }, NOW)

    const context = waiterContext(h)
    const deliveries: Array<{ route: string; context: string }> = []
    let claimHeldDuringDelivery = false
    const deliver = vi.fn(async (event: { context: string }) => {
      deliveries.push({ route: 'hook-continuation', context: event.context })
      claimHeldDuringDelivery = !claimQuestionPush('waiter-route', h.env)
      return { stdout: JSON.stringify({ decision: 'block', reason: event.context }) }
    })

    const outcome = await runEscalationWaiter(context, {
      sessionId: 'waiter-route',
      envelope: { session_id: 'waiter-route' },
      route: { kind: 'hook-continuation', deliver },
      processDeadlineAt: NOW + QUESTION_WAITER_CEILING_SECONDS * 1000,
    })

    expect((h.deps.now?.() ?? NOW) - NOW).toBeGreaterThanOrEqual(120_000)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ journal_recorded_at: expect.any(Number) }),
    )
    expect(deliveries).toEqual([
      { route: 'hook-continuation', context: expect.stringContaining('Ship it') },
    ])
    expect(claimHeldDuringDelivery).toBe(true)
    expect(JSON.parse(outcome.stdout ?? '{}')).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('Ship it'),
    })
    expect(claimQuestionPush('waiter-route', h.env)).toBe(true)
    releaseQuestionPush('waiter-route', h.env)
  })

  it('races a second Stop while grace, polling, fencing, and route delivery are still owned', async () => {
    const h = harness([])
    writeGlobalConfig(h, 'ask_grace_seconds = 10\n')
    writeSessionState('waiter-race-lifetime', h.env, { last_prompt_at: AWAY })
    registerQuestion('waiter-race-lifetime', h.env, { question: 'Ship it?' }, NOW)
    const context = waiterContext(h)
    const phases: string[] = []

    let waitingForReply = false
    context.sleep = async (milliseconds: number) => {
      if (!waitingForReply) {
        phases.push('grace')
        expect(claimQuestionPush('waiter-race-lifetime', h.env)).toBe(false)
      }
      h.advanceClock(milliseconds)
    }
    context.waitForFirstReply = async () => {
      waitingForReply = true
      phases.push('reply-wait')
      expect(claimQuestionPush('waiter-race-lifetime', h.env)).toBe(false)
      return { replies: [reply({ text: 'Ship it' })], timedOut: false }
    }
    const closeReplies = context.client.closeReplies.bind(context.client)
    context.client.closeReplies = async (requestId) => {
      phases.push('close-fence')
      expect(claimQuestionPush('waiter-race-lifetime', h.env)).toBe(false)
      return closeReplies(requestId)
    }

    await runEscalationWaiter(context, {
      sessionId: 'waiter-race-lifetime',
      envelope: { session_id: 'waiter-race-lifetime' },
      route: {
        kind: 'hook-continuation',
        deliver: async (event) => {
          phases.push('delivery')
          expect(claimQuestionPush('waiter-race-lifetime', h.env)).toBe(false)
          return { stdout: JSON.stringify({ decision: 'block', reason: event.context }), notes: [] }
        },
      },
      processDeadlineAt: NOW + QUESTION_WAITER_CEILING_SECONDS * 1000,
    })

    expect(phases.filter((phase) => phase === 'grace').length).toBeGreaterThan(0)
    expect(phases.filter((phase) => phase !== 'grace')).toEqual([
      'reply-wait',
      'close-fence',
      'delivery',
    ])
    expect(claimQuestionPush('waiter-race-lifetime', h.env)).toBe(true)
    releaseQuestionPush('waiter-race-lifetime', h.env)
  })

  it('keeps an unrelated answer when another owned question is retired mid-poll', async () => {
    const h = harness([])
    const first: PendingQuestion = {
      question: 'First?',
      body: 'First?',
      asked_at: NOW,
      request_id: 'req_partial_1',
      collapse_key: 'collapse-partial-1',
      device_ids: ['dev_iphone'],
      reply_deadline_at: NOW + 60_000,
      owner_deadline_at: NOW + 120_000,
    }
    const second: PendingQuestion = {
      question: 'Second?',
      body: 'Second?',
      asked_at: NOW,
      request_id: 'req_partial_2',
      collapse_key: 'collapse-partial-2',
      device_ids: ['dev_iphone'],
      reply_deadline_at: NOW + 60_000,
      owner_deadline_at: NOW + 120_000,
    }
    writeSessionState('waiter-partial', h.env, {
      last_prompt_at: AWAY,
      pending: [first, second],
    })
    const context = waiterContext(h)
    const polls = new Map<string, number>()
    let longPolls = 0
    let releaseLongPolls: (() => void) | undefined
    const heldLongPolls = new Promise<void>((resolve) => {
      releaseLongPolls = resolve
    })
    context.waitForFirstReply = async (requestId: string) => {
      const count = (polls.get(requestId) ?? 0) + 1
      polls.set(requestId, count)
      if (count === 1) return { replies: [], timedOut: true }
      longPolls += 1
      await heldLongPolls
      return {
        replies: requestId === second.request_id ? [reply({ text: 'Second answer' })] : [],
        timedOut: requestId !== second.request_id,
      }
    }
    const deliveries: string[] = []

    const waiter = runEscalationWaiter(context, {
      sessionId: 'waiter-partial',
      envelope: { session_id: 'waiter-partial' },
      route: {
        kind: 'hook-continuation',
        deliver: async (event) => {
          deliveries.push(event.context)
          return { acknowledgement: 'stdout', stdout: event.context }
        },
      },
      processDeadlineAt: NOW + 120_000,
    })
    await waitUntil(() => longPolls === 2, 1_000, 'long reply polls did not start')
    dropPendingQuestion('waiter-partial', h.env, first)
    releaseLongPolls?.()
    await waiter

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toContain('Second answer')
    expect(deliveries[0]).not.toContain('First?')
  })

  /** One accepted answer on the journal, whatever route is about to own it. */
  function journaled(h: Harness, sessionId: string): void {
    writeSessionState(sessionId, h.env, {
      accepted: {
        answers: [
          {
            pending: {
              question: 'Ship it?',
              request_id: 'req_existing',
              collapse_key: 'question-existing',
              device_ids: ['dev_iphone'],
            },
            reply: reply({ text: 'Ship it' }),
            replies: [reply({ text: 'Ship it' })],
          },
        ],
        remaining: 0,
        recorded_at: NOW,
      },
    })
  }

  it('lets SessionEnd cancel at the final route commit boundary', async () => {
    const h = harness([])
    journaled(h, 'waiter-final-cancel')
    const context = waiterContext(h)
    let markRoute: (() => void) | undefined
    const routeStarted = new Promise<void>((resolve) => {
      markRoute = resolve
    })
    let releaseRoute: (() => void) | undefined
    const heldRoute = new Promise<void>((resolve) => {
      releaseRoute = resolve
    })
    let wrote = false

    const waiter = runEscalationWaiter(context, {
      sessionId: 'waiter-final-cancel',
      envelope: { session_id: 'waiter-final-cancel' },
      route: {
        kind: 'inbox-socket',
        deliver: async (event) => {
          markRoute?.()
          await heldRoute
          if (event.commitDelivery()) wrote = true
          return { acknowledgement: wrote ? 'delivered' : 'held' }
        },
      },
      processDeadlineAt: NOW + 120_000,
    })
    await routeStarted
    await hookRunCommand(
      h.deps,
      'session-end',
      stdin({ session_id: 'waiter-final-cancel' }),
      'claude-code',
    )
    releaseRoute?.()
    await waiter

    expect(wrote).toBe(false)
  })

  it('fences production blocking stdout immediately before the harness write', async () => {
    const h = harness([reply({ text: 'Too late for stdout' })])
    writeSessionState('waiter-stdout-cancel', h.env, { last_prompt_at: AWAY })
    registerQuestion('waiter-stdout-cancel', h.env, { question: 'Deploy?' }, NOW)
    const originalErr = h.io.err.bind(h.io)
    let ended = false
    h.io.err = (line: string) => {
      originalErr(line)
      if (!ended && line.includes('answer from')) {
        ended = true
        handleSessionEnd(h.env, { session_id: 'waiter-stdout-cancel' }, NOW)
      }
    }

    await hookRunCommand(
      h.deps,
      'stop',
      stdin({ session_id: 'waiter-stdout-cancel' }),
      'codex',
    )

    expect(ended).toBe(true)
    expect(h.io.outLines).toEqual([])
    expect(h.io.errLines.join('\n')).toContain('no continuation was written')
  })

  it('finishes a delivery that committed before SessionEnd without replaying it', async () => {
    const h = harness([])
    journaled(h, 'waiter-commit-first')
    const context = waiterContext(h)
    let markCommitted: (() => void) | undefined
    const committed = new Promise<void>((resolve) => {
      markCommitted = resolve
    })
    let releaseWrite: (() => void) | undefined
    const heldWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let writes = 0

    const waiter = runEscalationWaiter(context, {
      sessionId: 'waiter-commit-first',
      envelope: { session_id: 'waiter-commit-first' },
      route: {
        kind: 'inbox-socket',
        deliver: async (event) => {
          expect(event.commitDelivery()).toBe(true)
          markCommitted?.()
          await heldWrite
          writes += 1
          return { acknowledgement: 'delivered' }
        },
      },
      processDeadlineAt: NOW + 120_000,
    })
    await committed
    await hookRunCommand(
      h.deps,
      'session-end',
      stdin({ session_id: 'waiter-commit-first' }),
      'claude-code',
    )
    releaseWrite?.()
    await waiter

    expect(writes).toBe(1)
    expect(readSessionState('waiter-commit-first', h.env).accepted?.delivered_at).toBe(
      NOW,
    )

    await hookRunCommand(
      h.deps,
      'session-start',
      stdin({ session_id: 'waiter-commit-first' }),
      'claude-code',
    )
    await runEscalationWaiter(context, {
      sessionId: 'waiter-commit-first',
      envelope: { session_id: 'waiter-commit-first' },
      route: {
        kind: 'inbox-socket',
        deliver: async () => {
          writes += 1
          return { acknowledgement: 'delivered' }
        },
      },
      processDeadlineAt: NOW + 120_000,
    })
    expect(writes).toBe(1)
  })

  it('delivers an accepted answer once on a route that acknowledges its own write', async () => {
    const h = harness([])
    journaled(h, 'waiter-once')
    const context = waiterContext(h)
    const deliveries: string[] = []
    const route = {
      kind: 'inbox-socket' as const,
      deliver: async (event: { context: string; commitDelivery(): boolean }) => {
        expect(event.commitDelivery()).toBe(true)
        deliveries.push(event.context)
        return {
          notes: ['posted the accepted answer'],
          log: { route: 'inbox-socket', stage: 'delivered' },
          acknowledgement: 'delivered' as const,
        }
      },
    }

    // Five turn-ends, none of them a harness continuation — the shape of every
    // route that wakes a new turn instead of continuing this one.
    for (let pass = 0; pass < 5; pass += 1) {
      await runEscalationWaiter(context, {
        sessionId: 'waiter-once',
        envelope: { session_id: 'waiter-once', stop_hook_active: false },
        route,
        processDeadlineAt: NOW + QUESTION_WAITER_CEILING_SECONDS * 1000,
      })
    }

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toContain('Ship it')
    expect(readSessionState('waiter-once', h.env).accepted).toBeUndefined()
  })

  it('does not settle a route that reports delivery without the SessionEnd commit', async () => {
    const h = harness([])
    journaled(h, 'waiter-uncommitted-route')
    const context = waiterContext(h)

    const outcome = await runEscalationWaiter(context, {
      sessionId: 'waiter-uncommitted-route',
      envelope: { session_id: 'waiter-uncommitted-route' },
      route: {
        kind: 'inbox-socket',
        deliver: async () => ({ acknowledgement: 'delivered' }),
      },
      processDeadlineAt: NOW + 120_000,
    })

    expect(readSessionState('waiter-uncommitted-route', h.env).accepted).toBeDefined()
    expect(outcome.notes.join('\n')).toContain('reported delivery without committing')
  })

  it('does not spend the delivery cap on turns where nothing was handed over', async () => {
    // The bug: holds counted against MAX_CONTINUATION_COUNT, so three turns
    // where a liveness probe could not reach a busy session were enough to
    // settle an answer the user had already given, unread.
    const h = harness([])
    const sessionId = 'waiter-transient-holds'
    journaled(h, sessionId)
    const context = waiterContext(h)
    let handedOver = 0
    let pass = 0

    for (; pass < MAX_CONTINUATION_COUNT + 2; pass += 1) {
      await runEscalationWaiter(context, {
        sessionId,
        envelope: { session_id: sessionId, stop_hook_active: false },
        route: {
          kind: 'inbox-socket',
          deliver: async () => ({ notes: [], acknowledgement: 'held' as const }),
        },
        processDeadlineAt: NOW + QUESTION_WAITER_CEILING_SECONDS * 1000,
      })
    }
    // Still journaled after more holds than the delivery cap allows.
    expect(readSessionState(sessionId, h.env).accepted).toBeDefined()

    // And when a route can finally take it, it is delivered rather than lost.
    await runEscalationWaiter(context, {
      sessionId,
      envelope: { session_id: sessionId, stop_hook_active: false },
      route: {
        kind: 'inbox-socket',
        deliver: async (event) => {
          expect(event.commitDelivery()).toBe(true)
          handedOver += 1
          return { notes: [], acknowledgement: 'delivered' as const }
        },
      },
      processDeadlineAt: NOW + QUESTION_WAITER_CEILING_SECONDS * 1000,
    })
    expect(handedOver).toBe(1)
  })

  it('bounds deliveries by the continuation cap on every route', async () => {
    // A route that never acknowledges must still stop. The cap lives where all
    // routes pass, so no future route can be the one it does not cover.
    for (const kind of ['inbox-socket', 'hook-continuation'] as const) {
      const h = harness([])
      const sessionId = `waiter-cap-${kind}`
      journaled(h, sessionId)
      const context = waiterContext(h)
      let deliveries = 0
      const notes: string[] = []

      for (let pass = 0; pass < MAX_HELD_DELIVERIES + 3; pass += 1) {
        const outcome = await runEscalationWaiter(context, {
          sessionId,
          envelope: { session_id: sessionId, stop_hook_active: false },
          route: {
            kind,
            deliver: async () => {
              deliveries += 1
              return { notes: [], acknowledgement: 'held' as const }
            },
          },
          processDeadlineAt: NOW + QUESTION_WAITER_CEILING_SECONDS * 1000,
        })
        notes.push(...outcome.notes)
      }

      // A hold is not a delivery — nothing was handed over — so it does not
      // spend the wake-loop cap. It still has to end, on its own looser bound.
      expect(deliveries).toBe(MAX_HELD_DELIVERIES)
      expect(notes.join('\n')).toContain(
        `could hand the user's answer over in ${MAX_HELD_DELIVERIES} turns`,
      )
      expect(readSessionState(sessionId, h.env).accepted).toBeUndefined()
    }
  })

  it('keeps the accepted journal when an out-of-band route rejects delivery', async () => {
    const h = harness([reply({ text: 'Hold it' })])
    writeGlobalConfig(h, 'ask_grace_seconds = 0\n')
    writeSessionState('waiter-failed-route', h.env, { last_prompt_at: AWAY })
    registerQuestion('waiter-failed-route', h.env, { question: 'Ship it?' }, NOW)
    const context = waiterContext(h)

    await expect(
      runEscalationWaiter(context, {
        sessionId: 'waiter-failed-route',
        envelope: { session_id: 'waiter-failed-route' },
        route: {
          kind: 'inbox-socket',
          deliver: async () => {
            throw new Error('socket unavailable')
          },
        },
        processDeadlineAt: NOW + QUESTION_WAITER_CEILING_SECONDS * 1000,
      }),
    ).rejects.toThrow('socket unavailable')

    expect(readSessionState('waiter-failed-route', h.env).accepted?.answers[0]?.reply.text).toBe(
      'Hold it',
    )
    expect(claimQuestionPush('waiter-failed-route', h.env)).toBe(true)
    releaseQuestionPush('waiter-failed-route', h.env)
  })
})


describe('session state across a prompt', () => {
  it('carries known and future session state across a typed prompt', async () => {
    // The prompt transition deliberately changes pending/retiring state and the
    // continuation count, but fields introduced by a newer CLI remain opaque.
    const h = harness([])
    const before = {
      last_prompt_at: AWAY,
      last_stop_at: NOW - 1_000,
      retiring: [
        {
          request_id: 'req_carry',
          collapse_key: 'collapse-carry',
          device_ids: ['dev_iphone'],
          question: 'Carried?',
          state: 'expired' as const,
        },
      ],
      continuation: { answered_at: NOW - 2_000, count: 2 },
      acknowledgement_due: [{ request_id: 'req_carry_ack', recorded_at: NOW }],
      acknowledgement_blocks: 2,
    }
    const futureSessionValue = { nested: ['kept'], revision: 2 }
    writeSessionState('carry-all', h.env, {
      ...before,
      future_session_key: futureSessionValue,
    } as SessionState & { future_session_key: typeof futureSessionValue })

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'carry-all', cwd: h.deps.cwd }),
    )

    const after = readSessionState('carry-all', h.env)
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      expect(after[key], `${key} did not survive the prompt`).toBeDefined()
    }
    const persisted = JSON.parse(
      readFileSync(
        path.join(
          stateDir(h.env),
          'sessions',
          `${sanitizeSessionId('carry-all')}.json`,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>
    expect(persisted['future_session_key']).toEqual(futureSessionValue)
    // The one field a prompt resets rather than carries.
    expect(after.continuation?.count).toBe(0)
    expect(after.acknowledgement_blocks).toBe(2)
  })
})

describe('a question reaching the end of its answer window', () => {
  it('keeps the owner alive until the server stops accepting', async () => {
    const h = harness([])
    const aDayOut = NOW + 86_400_000
    h.recorder.replyExpiresAt = new Date(aDayOut).toISOString()
    writeSessionState('outlive', h.env, { last_prompt_at: AWAY })
    registerQuestion('outlive', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'outlive' }))

    const state = readSessionState('outlive', h.env)
    expect(state.pending).toBeUndefined()
    expect(state.retiring).toEqual([
      expect.objectContaining({ request_id: h.recorder.receipts[0], state: 'expired' }),
    ])
    expect(h.recorder.closed).toHaveLength(1)
    expect(h.deps.now?.()).toBeGreaterThan(NOW + 8 * 60 * 1000)
    expect(h.deps.now?.()).toBeLessThanOrEqual(aDayOut)
  })

  it('still closes a question the server has genuinely stopped accepting', async () => {
    const h = harness([])
    h.recorder.replyExpiresAt = new Date(NOW + 90_000).toISOString()
    writeSessionState('short-window', h.env, { last_prompt_at: AWAY })
    registerQuestion('short-window', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'short-window' }))

    // Its short window closes under the same owner, so it is retired here
    // rather than left for a turn that could never collect it.
    expect(readSessionState('short-window', h.env).pending).toBeUndefined()
    expect(h.recorder.closed.length).toBe(1)
  })
})
