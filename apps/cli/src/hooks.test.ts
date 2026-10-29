import {
CAPABILITIES_V1,estimateFcmPayloadBytes,validateDraft,type ClaimDeliveryAttemptRequestT,type ListRepliesResponse,
type ReplyView,
type SubmissionReceipt,
type SubmitNotificationRequestT
} from '@raidiant/notifai-protocol'
import { execFileSync,spawn } from 'node:child_process'
import {
existsSync,
mkdirSync,
mkdtempSync,
rmSync,
readFileSync,
utimesSync,
writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe,expect,it,vi } from 'vitest'
import { type ClaudeWakeAdapters } from './claude-wake.js'
import { ApiCallError, type ApiClient } from './client.js'
import { guidanceShowCommand as readCurrentGuidance } from './commands-guidance.js'
import {
EXIT,
acknowledgeCommand,
askCommand as askWithCurrency,
closeCommand,
hookRunCommand,
repliesCommand,
statusCommand,
type CommandDeps,
type CommandIo
} from './commands.js'
import {
loadConfig,
sanitizeSessionId,
stateDir,
updateProjectFolder
} from './config.js'
import { buildQuestions } from './commands-ask.js'
import { hookAdapterPath,installHookAdapter } from './hook-adapter.js'
import {
registerQuestion as persistQuestion,
runEscalationWaiter
} from './hook-lifecycle.js'
import {
writeProjectSession
} from './hook-project-sessions.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { hubHeartbeatPath } from './hub-ipc.js'
import { processStartTime } from './process-identity.js'
import { inspectQuestionState } from './hook-question-state.js'
import {
writeSessionState as persistSessionState,
readSessionState
} from './hook-session-state.js'
import { type PendingQuestion,type SessionState } from './hook-types.js'
import { sessionMessageContext } from './injection-render.js'
import { buildHookConfig,codexHookIdentityHash,codexTrustKey,findInstallations } from './install-hooks.js'
import {
activeLogPath,
createLogger
} from './logging.js'
import { readOpenclawGeneration } from './openclaw-generation.js'
import { activeOpenclawGeneration,openclawOwnsReply } from './openclaw-session-access.js'
import {
disableProject,
enableProject,
projectBinding
} from './project-enablement.js'
import { attendantClaimPath,writeAttendantStatus } from './session-attendant-state.js'
import { deliveryJournalPath } from './session-delivery.js'
import { sessionInputWake } from './session-inputs.js'

/** Keep unrelated lifecycle fixtures valid under the authored content contract. */
function registerQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  question: PendingQuestion,
  now?: number,
): void {
  persistQuestion(
    sessionId,
    env,
    {
      summary: question.summary ?? question.question,
      ...question,
    },
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
            summary: entry.summary ?? entry.question,
            ...entry,
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
  /** Attendance reports sent outside a Session Attendant, such as a close. */
  attended?: Array<{ sessionId: string; body: unknown }>
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
      // The request has started; competing commands run while its response is
      // in flight, after the short synchronous admission transaction releases.
      await Promise.resolve()
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
    attend: async (sessionId, body) => {
      recorder.attended ??= []
      recorder.attended.push({ sessionId, body })
      return { status: 'withdrawn' }
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
  execFileSync('git', ['init', '-q', root])
  const home = path.join(root, 'home')
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
  }
  // Lifecycle assertions start from a healthy, per-test installation. Never
  // discover another fixture's hooks or inspect the account's shared adapter.
  installHookAdapter({ execPath: process.execPath, scriptPath: fileURLToPath(new URL('../dist/main.js', import.meta.url)) }, home)
  for (const [directory, file, kind] of [
    ['.claude', 'settings.json', 'claude-code'],
    ['.codex', 'hooks.json', 'codex'],
  ] as const) {
    mkdirSync(path.join(home, directory), { recursive: true })
    writeFileSync(path.join(home, directory, file), JSON.stringify({
      hooks: buildHookConfig({ adapterPath: hookAdapterPath(home), harness: kind }),
    }))
  }
  const codex = findInstallations(env, home).find(entry => entry.harness === 'codex')!
  writeFileSync(path.join(home, '.codex', 'config.toml'), codex.handlers.map(handler =>
    `[hooks.state.${JSON.stringify(codexTrustKey(codex, handler, env))}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`,
  ).join('\n'))
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
      hookAdapterHome: home,
      clientFactory: () => fakeClient(recorder, replies),
      fetchImpl: async () => { throw new Error('registry unused in lifecycle fixtures') },
      now: () => clock,
      sleep: async (milliseconds: number) => {
        clock += milliseconds
      },
      spawnQuestionSettlement: () => {},
    },
  }
}

function askCommand(...args: Parameters<typeof askWithCurrency>) {
  void readCurrentGuidance({ ...args[0], io: { ...args[0].io, out: () => undefined } }, {})
  return askWithCurrency(...args)
}

describe('registered folder lifecycle', () => {
  it('uses the folder-root Enablement decision for SessionStart in a descendant', async () => {
    const h = harness()
    const folder = mkdtempSync(path.join(os.tmpdir(), 'notifai-folder-lifecycle-'))
    try {
      const cwd = path.join(folder, 'notes')
      mkdirSync(cwd)
      updateProjectFolder('add', folder, 'Writing', h.env)
      const binding = projectBinding(folder, h.env)!
      disableProject(binding)
      const deps = { ...h.deps, cwd }
      await hookRunCommand(deps, 'session-start', stdin({ session_id: 'folder-disabled', cwd }), 'claude-code')
      expect(h.io.outLines.join('\n')).not.toContain('You own Notification Requests')
      h.io.outLines.length = 0
      enableProject(binding)
      await hookRunCommand(deps, 'session-start', stdin({ session_id: 'folder-enabled', cwd }), 'claude-code')
      expect(h.io.outLines.join('\n')).toContain('You own Notification Requests')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('OpenClaw generation fencing at the CLI boundary', () => {

  it('lets only the current generation read its own reply pointer, even after disabling', async () => {
    const h = harness()
    const sessionId = 'agent:main:reply-probe'
    const envelope = { session_id: sessionId, cwd: h.deps.cwd, openclaw_session_id: 'transcript-a' }
    await hookRunCommand(h.deps, 'openclaw-lifecycle', stdin({
      ...envelope, hook_event_name: 'SessionStart',
    }), 'openclaw')
    await hookRunCommand(h.deps, 'session-start', stdin(envelope), 'openclaw')
    const generation = readOpenclawGeneration(sessionId, h.env)?.id
    expect(generation).toBeDefined()
    writeSessionState(sessionId, h.env, {
      pending: [{ question: 'Ready?', summary: 'Ready?', request_id: 'req_owned' }],
    })
    const env = { ...h.env, NOTIFAI_ACTIVE_HARNESS: 'openclaw',
      NOTIFAI_ACTIVE_SESSION_ID: sessionId, NOTIFAI_ACTIVE_OPENCLAW_GENERATION: generation }
    expect(openclawOwnsReply(sessionId, 'req_owned', env)).toBe(true)
    expect(openclawOwnsReply(sessionId, 'req_other', env)).toBe(false)
    await hookRunCommand(h.deps, 'openclaw-generation', stdin(envelope), 'openclaw')
    expect(h.io.outLines.at(-1)).toBe(generation)

    const binding = projectBinding(h.deps.cwd, h.env)!
    disableProject(binding)
    // The generation is the conversation's, whatever the User decided for the Project.
    expect(activeOpenclawGeneration(sessionId, env)).toBe(generation)
    expect(openclawOwnsReply(sessionId, 'req_owned', env)).toBe(true)
    await hookRunCommand(h.deps, 'openclaw-generation', stdin(envelope), 'openclaw')
    expect(h.io.outLines.at(-1)).toBe(generation)
    enableProject(binding)
    await hookRunCommand(h.deps, 'openclaw-lifecycle', stdin({
      ...envelope, hook_event_name: 'BeforeReset', openclaw_reason: 'reset',
    }), 'openclaw')
    await hookRunCommand(h.deps, 'openclaw-lifecycle', stdin({
      ...envelope, hook_event_name: 'SessionStart',
    }), 'openclaw')
    await hookRunCommand(h.deps, 'session-start', stdin(envelope), 'openclaw')
    expect(activeOpenclawGeneration(sessionId, env)).toBeNull()
  })

  it('retains foreground question ownership when its held wait times out', async () => {
    const h = harness()
    const envelope = {
      session_id: 'agent:main:foreground-timeout', cwd: h.deps.cwd,
      openclaw_session_id: 'transcript-a',
    }
    await hookRunCommand(h.deps, 'openclaw-lifecycle', stdin({
      ...envelope, hook_event_name: 'SessionStart',
    }), 'openclaw')
    await hookRunCommand(h.deps, 'session-start', stdin(envelope), 'openclaw')
    const env = { ...h.env, NOTIFAI_ACTIVE_HARNESS: 'openclaw',
      NOTIFAI_ACTIVE_SESSION_ID: envelope.session_id,
      NOTIFAI_ACTIVE_OPENCLAW_GENERATION: readOpenclawGeneration(envelope.session_id, h.env)?.id }
    const client = {
      ...fakeClient(h.recorder, []),
      capabilities: async (platform: 'ios' | 'android' | 'macos') => CAPABILITIES_V1.describe(platform),
    } as ApiClient
    const deps = { ...h.deps, env, clientFactory: () => client, hookPlatform: 'linux' as const }
    expect(await askCommand(deps, 'Proceed with this task?', { title: 'Proceed?', wait: true, json: true })).toBe(EXIT.noReply)
    const requestId = h.recorder.receipts[0]!
    // The unanswered end withdrew it; a late answer is still readable by its owner.
    expect(h.recorder.closed).toEqual([requestId])
    h.recorder.repliesFor = () => [reply()]
    expect(await repliesCommand(deps, requestId, { json: true })).toBe(EXIT.ok)
    expect(await acknowledgeCommand(deps, requestId, { text: 'Proceeding.' })).toBe(EXIT.ok)
  })

  it('does not assign an in-flight foreground request to a replacement generation', async () => {
    const h = harness()
    const envelope = {
      session_id: 'agent:main:foreground-race', cwd: h.deps.cwd,
      openclaw_session_id: 'transcript-a',
    }
    await hookRunCommand(h.deps, 'openclaw-lifecycle', stdin({
      ...envelope, hook_event_name: 'SessionStart',
    }), 'openclaw')
    await hookRunCommand(h.deps, 'session-start', stdin(envelope), 'openclaw')
    const oldGeneration = readOpenclawGeneration(envelope.session_id, h.env)?.id
    const env = { ...h.env, NOTIFAI_ACTIVE_HARNESS: 'openclaw',
      NOTIFAI_ACTIVE_SESSION_ID: envelope.session_id,
      NOTIFAI_ACTIVE_OPENCLAW_GENERATION: oldGeneration }
    const baseClient = fakeClient(h.recorder, [])
    const client = {
      ...baseClient,
      capabilities: async (platform: 'ios' | 'android' | 'macos') => CAPABILITIES_V1.describe(platform),
      submit: async (body: SubmitNotificationRequestT, waitSeconds: number) => {
        const receipt = await baseClient.submit(body, waitSeconds)
        await hookRunCommand(h.deps, 'openclaw-lifecycle', stdin({
          ...envelope, hook_event_name: 'BeforeReset', openclaw_reason: 'reset',
        }), 'openclaw')
        await hookRunCommand(h.deps, 'session-start', stdin(envelope), 'openclaw')
        return receipt
      },
    } as ApiClient
    const deps = { ...h.deps, env, clientFactory: () => client, hookPlatform: 'linux' as const }
    expect(await askCommand(deps, 'Proceed with this task?', { title: 'Proceed?', wait: true, json: true })).toBe(EXIT.failed)
    const requestId = h.recorder.receipts[0]!
    const nextEnv = { ...env,
      NOTIFAI_ACTIVE_OPENCLAW_GENERATION: readOpenclawGeneration(envelope.session_id, h.env)?.id }
    expect(openclawOwnsReply(envelope.session_id, requestId, nextEnv)).toBe(false)
    expect(await acknowledgeCommand({ ...deps, env: nextEnv }, requestId, { text: 'Wrong owner.' })).toBe(EXIT.usage)
  })
})



function stdin(payload: unknown): () => Promise<string> {
  return async () => JSON.stringify(payload)
}







function writeGlobalConfig(h: Harness, toml: string): void {
  const dir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'config.toml'), toml)
}

/** Long enough ago that no test is accidentally sensitive to the stamp. */
const AWAY = NOW - 600_000

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

  it('never submits a question answered in the terminal during its delay', async () => {
    const h = harness([])
    const sessionId = 'answered-during-delay'
    writeGlobalConfig(h, 'ask_grace_seconds = 300\n')
    writeSessionState(sessionId, h.env, { harness: 'codex', last_prompt_at: AWAY })
    writeProjectSession(h.deps.cwd, h.env, sessionId, NOW, 'codex')
    registerQuestion(sessionId, h.env, { question: 'Ship it?', question_id: 'q_terminal' }, NOW)
    const virtualSleep = h.deps.sleep!
    let answered = false
    h.deps.sleep = async (milliseconds: number) => {
      if (answered) return virtualSleep(milliseconds)
      answered = true
      await virtualSleep(milliseconds / 2)
      await hookRunCommand(h.deps, 'user-prompt-submit',
        stdin({ session_id: sessionId, cwd: h.deps.cwd, prompt: 'yes' }), 'codex')
      await virtualSleep(milliseconds / 2)
    }
    await hookRunCommand(h.deps, 'question-submission', stdin({ session_id: sessionId, cwd: h.deps.cwd }), 'codex')
    expect(answered).toBe(true)
    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(0)
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
})

describe('late answer collection', () => {

  it('replays only the unacknowledged part of a journaled answer batch', async () => {
    const h = harness([])
    const answers = ['req_first', 'req_second'].map((requestId, index) => {
      const answer = reply({ text: `Decision ${index + 1}` })
      return {
        pending: { question: `Question ${index + 1}?`, summary: `Question ${index + 1}?`, request_id: requestId },
        reply: answer,
        replies: [answer],
        agent_acknowledgement_required: true,
      }
    })
    writeSessionState('partial-prompt', h.env, {
      accepted: { answers, remaining: 0, recorded_at: NOW },
      acknowledgement_due: answers.map(({ pending }) => ({ request_id: pending.request_id, recorded_at: NOW })),
    })
    h.recorder.acknowledged = new Set(['req_first'])

    await hookRunCommand(
      h.deps, 'user-prompt-submit',
      stdin({ session_id: 'partial-prompt', cwd: h.deps.cwd, prompt: 'Continue.' }), 'codex',
    )

    const context = JSON.parse(h.io.outLines.at(-1) ?? '{}').hookSpecificOutput?.additionalContext
    expect(context).toContain('Decision 2')
    expect(context).not.toContain('Decision 1')
    expect(readSessionState('partial-prompt', h.env).acknowledgement_due?.map((entry) => entry.request_id))
      .toEqual(['req_second'])
    expect(readSessionState('partial-prompt', h.env).accepted).toBeDefined()
  })

  it.each(['offline', 'session-ended'] as const)('preserves journal recovery across acknowledgement reconciliation (%s)', async (failure) => {
    const h = harness([])
    const answer = reply({ text: 'Keep the draft' })
    writeSessionState('reconcile-prompt', h.env, {
      accepted: {
        answers: [{
          pending: { question: 'Keep it?', summary: 'Keep it?', request_id: 'req_keep' },
          reply: answer, replies: [answer], agent_acknowledgement_required: true,
        }],
        remaining: 0, recorded_at: NOW,
      },
      acknowledgement_due: [{ request_id: 'req_keep', recorded_at: NOW }],
    })
    const deps: CommandDeps = {
      ...h.deps,
      clientFactory: () => ({
        ...fakeClient(h.recorder, []),
        agentAcknowledgement: async () => {
          if (failure === 'offline') throw new Error('offline')
          await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'reconcile-prompt' }), 'codex')
          return fakeClient(h.recorder, []).agentAcknowledgement('req_keep', { waitSeconds: 0 })
        },
      }),
    }

    await hookRunCommand(deps, 'user-prompt-submit', stdin({ session_id: 'reconcile-prompt' }), 'codex')

    if (failure === 'offline') {
      expect(h.io.outLines.join('\n')).toContain('Keep the draft')
    } else {
      expect(h.io.outLines).toEqual([])
    }
    expect(readSessionState('reconcile-prompt', h.env).accepted).toBeDefined()
    expect(readSessionState('reconcile-prompt', h.env).acknowledgement_due).toHaveLength(1)
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
})

describe('several questions in flight', () => {

  it('recovers a previously committed queue journal without losing its unacknowledged answer', async () => {
    const h = harness([])
    const sessionId = '11111111-2222-4333-8444-555555555555'
    const first = reply({ text: 'First decision' })
    writeSessionState(sessionId, h.env, {
      accepted: {
        answers: [{
          pending: { question: 'First?', summary: 'First?', request_id: 'req_first',
            collapse_key: 'first', device_ids: ['dev_iphone'] },
          reply: first, replies: [first], agent_acknowledgement_required: true,
        }],
        remaining: 1, recorded_at: NOW, delivered_at: NOW, delivered_route: 'session-queue',
      },
      acknowledgement_due: [{ request_id: 'req_first', recorded_at: NOW }],
      pending: [{
        question: 'Second?', request_id: 'req_second', collapse_key: 'second', device_ids: ['dev_iphone'],
        asked_at: NOW, reply_deadline_at: NOW + 60_000,
      }],
    })
    h.recorder.repliesFor = (id) => id === 'req_second' ? [reply({ text: 'Second decision' })] : []
    const queued: string[] = []
    const deps: CommandDeps = {
      ...h.deps, codexWake: { queue: async (_thread, _cwd, context) => void queued.push(context) },
    }

    await hookRunCommand(deps, 'question-settlement', stdin({ session_id: sessionId, cwd: deps.cwd }), 'codex')

    expect(queued).toHaveLength(1)
    expect(queued[0]).toBe(sessionInputWake())
    expect(readSessionState(sessionId, h.env).delivered_answers?.map((entry) => entry.reply.text)).toEqual(['First decision'])
    expect(readSessionState(sessionId, h.env).waiting_answers?.map((entry) => entry.reply.text)).toEqual(['Second decision'])
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
})

describe('user-prompt-submit hook', () => {

  it('records presence', async () => {
    const h = harness()
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 's10' }))
    expect(readSessionState('s10', h.env).last_prompt_at).toBe(NOW)
  })
})

describe('session-end hook', () => {

  it('cancels acknowledgement debt at SessionEnd and round-trips future fields beside a native report', async () => {
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
    const nativeReport = { question_id: 'q_native', operation_id: 'op_native', future_entry: { retained: true } }
    mkdirSync(path.dirname(stateFile), { recursive: true })
    writeFileSync(
      stateFile,
      `${JSON.stringify({
        future_root: { retained: true },
        acknowledgement_due: [acknowledgement],
        message_acknowledgement_due: [{ message_id: 'sm_future', recorded_at: NOW, text_required: true }],
        native_answer_operations: [nativeReport],
      })}\n`,
    )

    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: sessionId }))

    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({
      future_root: { retained: true },
      native_answer_operations: [nativeReport],
      session_id: sessionId,
    })
  })
})

describe('two hooks racing one question', () => {

  it('takes the wake route from a hub whose exchange loop stopped moving, and leaves it to one whose heartbeat is fresh', async () => {
    // A live process stands in for the hub: alive, holding the question, and (in the incident) waking nobody.
    const hub = spawn('sleep', ['60'], { stdio: 'ignore' })
    try {
      let start: string | null = null
      for (let tries = 0; start === null && tries < 200; tries += 1) {
        start = processStartTime(hub.pid!)
        if (start === null) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const h = harness([reply({ text: 'Continue' })])
      writeSessionState('hub-stalled', h.env, { last_prompt_at: AWAY })
      registerQuestion('hub-stalled', h.env, { question: 'Ship it?', question_id: 'q_hub' })
      const heartbeat = hubHeartbeatPath(h.env, hub.pid!)
      mkdirSync(path.dirname(heartbeat), { recursive: true })
      writeFileSync(heartbeat, `${hub.pid}\n`)
      const claim = path.join(stateDir(h.env), 'sessions', `${sanitizeSessionId('hub-stalled')}.claim`)
      writeFileSync(claim, JSON.stringify({ pid: hub.pid, start, at: Date.now(), token: 'hub-token', pending_question_ids: ['q_hub'],
        owner_role: 'hub', yields: true, heartbeat }))

      // A hub whose loop moves on owns the question: this Stop leaves it alone.
      await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'hub-stalled' }))
      expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(0)
      expect(JSON.parse(readFileSync(claim, 'utf8'))).toMatchObject({ token: 'hub-token' })

      // Its loop stops moving: the claim is as good as gone, and this Stop asks and hands the answer back itself.
      const stale = new Date(Date.now() - 10 * 60_000)
      utimesSync(heartbeat, stale, stale)
      await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'hub-stalled' }))
      expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(1)
      expect(h.io.outLines.join('\n')).toContain('Continue')
    } finally {
      hub.kill('SIGKILL')
    }
  })

  it('settles a stopped session once a guard nobody can name ages out, not never', async () => {
    const h = harness([reply({ text: 'Continue' })])
    writeSessionState('guard-unnamed', h.env, { last_prompt_at: AWAY })
    registerQuestion('guard-unnamed', h.env, { question: 'Ship it?' })
    // An older build's guard holds no holder; a crash inside it leaves only its age.
    const guard = path.join(stateDir(h.env), 'sessions', `${sanitizeSessionId('guard-unnamed')}.claim.guard`)
    writeFileSync(guard, '')
    let waited = 0
    h.deps.sleep = async (milliseconds: number) => {
      h.advanceClock(milliseconds)
      waited += milliseconds
      if (waited >= 3_000 && existsSync(guard)) utimesSync(guard, new Date(0), new Date(Date.now() - 31_000))
    }

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'guard-unnamed' }))

    expect(waited).toBeGreaterThanOrEqual(3_000)
    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(1)
    expect(h.io.errLines.join(' ')).not.toContain('claimed-elsewhere')
  })
})

describe('conversational close racing lifecycle retry', () => {

  it('still submits a queued question in another session after this session is closed', async () => {
    const h = harness([])
    writeSessionState('closed-session', h.env, { last_prompt_at: AWAY })
    writeSessionState('other-session', h.env, { last_prompt_at: AWAY })
    registerQuestion('closed-session', h.env, { question: 'Retire me?', question_id: 'q_closed' }, NOW)
    registerQuestion('other-session', h.env, { question: 'Keep asking?', question_id: 'q_other' }, NOW)
    writeProjectSession(h.deps.cwd, h.env, 'closed-session', NOW, 'codex')

    expect(await closeCommand(h.deps, undefined, { pending: true, json: true })).toBe(EXIT.ok)
    await hookRunCommand(
      h.deps,
      'question-settlement',
      stdin({ session_id: 'other-session', cwd: h.deps.cwd }),
      'codex',
    )

    const sent = h.recorder.submitted
      .filter((entry) => isQuestionSubmit(entry))
      .map((entry) => entry.draft.presentation.summary)
    expect(sent).toEqual(['Keep asking?'])
    expect(inspectQuestionState('q_closed', h.env)).toMatchObject({
      found: true,
      question: { state: 'withdrawn', submitted: false },
    })
  })
})

describe('serialized question admission and withdrawal', () => {

  it('lets a matching conversational prompt withdraw during preflight without touching another session', async () => {
    const h = harness([])
    const sessionId = 'prompt-preflight-withdrawal'
    const otherId = 'prompt-unrelated-session'
    writeSessionState(sessionId, h.env, { last_prompt_at: AWAY })
    registerQuestion(sessionId, h.env, { question: 'Ship it?', question_id: 'q_prompt' }, NOW)
    registerQuestion(otherId, h.env, { question: 'Keep asking?', question_id: 'q_other_prompt' }, NOW)
    const factory = h.deps.clientFactory!
    h.deps.clientFactory = (...args) => {
      const client = factory(...args)
      return { ...client, listDevices: async () => {
        await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: sessionId, cwd: h.deps.cwd, prompt: 'yes' }), 'codex')
        return client.listDevices()
      } }
    }
    await hookRunCommand(h.deps, 'question-settlement', stdin({ session_id: sessionId, cwd: h.deps.cwd }), 'codex')
    expect(h.recorder.submitted).toEqual([])
    expect(h.recorder.closed).toEqual([])
    expect(inspectQuestionState('q_prompt', h.env)).toMatchObject({ question: { state: 'withdrawn', submitted: false } })
    expect(readSessionState(otherId, h.env).pending?.map((entry) => entry.question_id)).toEqual(['q_other_prompt'])
  })
})

describe('Claude Code Stop wake route', () => {

  function claudeWake(status: 'idle' | 'busy' = 'idle'): ClaudeWakeAdapters & {
    sent: string[]
    sleeps: number[]
  } {
    const sent: string[] = []
    const sleeps: number[] = []
    return {
      sent,
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
      async sleep(milliseconds) {
        sleeps.push(milliseconds)
      },
    }
  }


  /**
   * A live attendant for `claude-route` holding `generation`, as the answer
   * waiter reads it: its status file and its claim, both naming this process.
   */
  function attendClaudeRoute(env: NodeJS.ProcessEnv, generation = 4): void {
    writeAttendantStatus('claude-route', env, {
      phase: 'attending',
      incarnation: 'inc_answerclaimtest',
      generation,
      activity: 'idle',
      reason: null,
      accepts_messages: true,
      updated_at: NOW,
    })
    expect(
      acquireClaimFile(attendantClaimPath('claude-route', env), { incarnation: 'inc_answerclaimtest' }),
    ).not.toBeNull()
  }

  /** Records every close disposition and serves the claim protocol. */
  function claimingClient(h: Harness) {
    const closes: Array<{ requestId: string; disposition: string | null }> = []
    const claims: ClaimDeliveryAttemptRequestT[] = []
    const reports: Array<{ attemptId: string; outcome: string }> = []
    const factory = h.deps.clientFactory!
    h.deps.clientFactory = () => {
      const client = factory()
      return {
        ...client,
        closeReplies: async (requestId: string, disposition?: 'deliver' | 'retire') => {
          closes.push({ requestId, disposition: disposition ?? null })
          const listed = await client.closeReplies(requestId)
          if (disposition === undefined) return listed
          return {
            ...listed,
            close_disposition: disposition,
            delivered_reply_seq: disposition === 'deliver' ? (listed.replies.at(-1)?.seq ?? null) : null,
          }
        },
        claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
          claims.push(body)
          return { attempt_id: `att_answer_${claims.length}`, claim_remaining_ms: 30_000 }
        },
        reportDeliveryAttempt: async (attemptId: string, body: { outcome: string }) => {
          reports.push({ attemptId, outcome: body.outcome })
          return { attempt_id: attemptId, outcome: body.outcome, replayed: false }
        },
      } as ApiClient
    }
    return { closes, claims, reports }
  }

  /** A journaled, selected answer to `question`, as a Stop that died after closing left it. */
  function selectedAccepted(env: NodeJS.ProcessEnv, requestId: string): void {
    const pending = {
      question: 'Ship it?',
      summary: 'Ship it?',
      question_id: 'q_ship',
      request_id: requestId,
      collapse_key: `collapse_${requestId}`,
      device_ids: ['dev_iphone'],
    }
    const answer = reply({ text: 'Ship it', seq: 2 })
    writeSessionState('claude-route', env, {
      last_prompt_at: AWAY,
      accepted: {
        answers: [
          {
            pending,
            reply: answer,
            replies: [answer],
            agent_acknowledgement_required: true,
            delivery_claim: true,
          },
        ],
        remaining: 0,
        recorded_at: NOW,
      },
      acknowledgement_due: [{ request_id: requestId, recorded_at: NOW, text_required: true }],
    })
  }

  for (const stage of ['writing', 'failed', 'written'] as const) {
    it(`never writes again an answer whose earlier hand-off journaled ${stage}, even when a new claim is refused`, async () => {
      const h = harness([])
      selectedAccepted(h.env, 'req_crashed')
      const journal = deliveryJournalPath('claude-route', h.env)
      mkdirSync(path.dirname(journal), { recursive: true })
      writeFileSync(
        journal,
        JSON.stringify({
          session_id: 'claude-route',
          entries: [
            {
              attempt_id: 'att_before_crash',
              subject: { type: 'answer', request_id: 'req_crashed' },
              stage,
              // A waiter that died after its socket write, before it saved delivered_at.
              writer: { pid: 2_147_483_000, start: 'Thu Jan  1 00:00:00 1970' },
              claimed_at: NOW,
            },
          ],
        }),
      )
      attendClaudeRoute(h.env)
      const service = claimingClient(h)
      const wake = claudeWake()

      await hookRunCommand(
        { ...h.deps, claudeWake: wake, claudeSourcePid: 12345 },
        'stop',
        stdin({ session_id: 'claude-route', cwd: '/tmp/claude-route' }),
        'claude-code',
      )

      expect(wake.sent).toEqual([])
      expect(service.claims).toEqual([])
      expect(service.reports).toEqual([
        { attemptId: 'att_before_crash', outcome: stage === 'written' ? 'handed_off' : 'unconfirmed' },
      ])
      expect(readSessionState('claude-route', h.env).accepted).toBeUndefined()
    })
  }

  for (const unclaimed of [false, true]) {
    it(`never adds to a prompt an answer whose ${unclaimed ? 'unclaimed' : 'claimed'} write the journal records`, async () => {
      const h = harness([])
      selectedAccepted(h.env, 'req_already')
      const journal = deliveryJournalPath('claude-route', h.env)
      mkdirSync(path.dirname(journal), { recursive: true })
      writeFileSync(
        journal,
        JSON.stringify({
          session_id: 'claude-route',
          entries: [
            {
              attempt_id: unclaimed ? 'unclaimed:req_already' : 'att_written',
              subject: { type: 'answer', request_id: 'req_already' },
              stage: 'written',
              writer: { pid: process.pid, start: 'this test' },
              ...(unclaimed ? { unclaimed: true, reported: 'handed_off', reported_at: NOW } : {}),
              claimed_at: NOW,
            },
          ],
        }),
      )

      await hookRunCommand(
        h.deps,
        'user-prompt-submit',
        stdin({ session_id: 'claude-route', cwd: h.deps.cwd, prompt: 'carry on' }),
        'claude-code',
      )

      expect(h.io.outLines.join('\n')).not.toContain('Ship it')
      const state = readSessionState('claude-route', h.env)
      expect(state.accepted).toBeUndefined()
      // Handed over once; the acknowledgement is still owed.
      expect(state.acknowledgement_due?.map((entry) => entry.request_id)).toEqual(['req_already'])
    })
  }
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

  it('observes a fresh answer without spending invisible acknowledgement reminders', async () => {
    const h = harness([reply({ text: 'New answer' })])
    writeSessionState('background-debt', h.env, {
      acknowledgement_due: [{ request_id: 'req_previous', recorded_at: NOW }],
      acknowledgement_blocks: 2,
    })
    registerQuestion('background-debt', h.env, { question: 'Next decision?' }, NOW)
    const deferred = vi.fn(async () => undefined)
    const outcome = await runEscalationWaiter({ ...waiterContext(h), harness: 'claude-code' }, {
      sessionId: 'background-debt', envelope: { session_id: 'background-debt' },
      route: { kind: 'inbox-socket', deliver: vi.fn(), defer: deferred }, recordStop: false,
    })
    expect(deferred).toHaveBeenCalledTimes(1)
    expect(deferred.mock.calls[0]?.[0]).toMatchObject({ answers: [expect.objectContaining({ reply: expect.objectContaining({ text: 'New answer' }) })] })
    expect(outcome.stdout).toBeUndefined()
    expect(readSessionState('background-debt', h.env).acknowledgement_blocks).toBe(2)
    expect(readSessionState('background-debt', h.env).acknowledgement_due).toContainEqual(expect.objectContaining({ request_id: 'req_previous' }))
  })

  it('stops holding a stop_hook_active continuation that never acknowledges, while another question waits', async () => {
    // A harness's own block cap (Claude Code ends the turn after 8) must never be what ends this.
    const h = harness([])
    const live = (id: string, question: string) =>
      ({ question, summary: question, request_id: id, collapse_key: `ck_${id}`, device_ids: ['dev_iphone'] })
    const answered = live('req_answered', 'Ship it?')
    writeSessionState('unacknowledged', h.env, {
      pending: [live('req_waiting', 'Next decision?')],
      accepted: { answers: [{ pending: answered, reply: reply(), replies: [reply()] }], remaining: 1, recorded_at: NOW },
      acknowledgement_due: [{ request_id: 'req_answered', recorded_at: NOW }],
    })
    const blocks: string[] = []
    for (let stop = 0; stop < 6; stop += 1) {
      const outcome = await runEscalationWaiter({ ...waiterContext(h), harness: 'grok' }, {
        sessionId: 'unacknowledged', envelope: { session_id: 'unacknowledged', stop_hook_active: true },
        route: { kind: 'hook-continuation', deliver: vi.fn() }, processDeadlineAt: h.deps.now!() + 1_000,
      })
      if (outcome.stdout?.includes('"decision":"block"') === true) blocks.push(outcome.stdout)
      else break
    }
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toContain('req_answered')
    expect(readSessionState('unacknowledged', h.env).acknowledgement_due).toBeUndefined()
  })

})

describe('a question reaching the end of its answer window', () => {

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

describe('Session Message acknowledgement debt', () => {
  it('lets a working Codex turn become idle before demanding acknowledgement of its queued Edit', async () => {
    const h = harness([])
    const acknowledged = new Set<string>()
    const checks = withMessageAcknowledgements(h, acknowledged)
    const context = sessionMessageContext({
      message_id: 'sm_green', kind: 'answer_edit', request_id: 'req_color',
      created_at: new Date(NOW).toISOString(), agent_acknowledgement_text_required: true,
      answers: [{ question_id: 'q_color', choice_ids: ['green'], text: null }], text: 'Green',
    })
    writeSessionState('working-edit', h.env, {
      message_acknowledgement_due: [{
        message_id: 'sm_green', recorded_at: NOW, text_required: true, queued_context: context,
      }],
    })

    // codex queue exits successfully while the old turn is still working.
    // Codex can start this queued input only after Stop allows it to be idle.
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'working-edit' }), 'codex')
    expect(h.io.outLines).toEqual([])
    expect(checks).toEqual([])
    expect(readSessionState('working-edit', h.env).message_acknowledgement_due?.[0]?.queued_context).toBe(context)

    // An unrelated prompt (even one naming the message ID) proves no content.
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({
      session_id: 'working-edit', cwd: h.deps.cwd, prompt: 'Check sm_green',
    }), 'codex')
    expect(h.io.outLines).toEqual([])
    expect(checks).toEqual([])

    // The queue now starts the new turn with the complete Green Edit body.
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({
      session_id: 'working-edit', cwd: h.deps.cwd, prompt: context,
    }), 'codex')
    expect(checks).toEqual(['sm_green'])
    expect(readSessionState('working-edit', h.env).message_acknowledgement_due?.[0]).not.toHaveProperty('queued_context')
    h.io.outLines.length = 0
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'working-edit' }), 'codex')
    expect(JSON.parse(h.io.outLines.at(-1)!).reason).toContain('sm_green')

    acknowledged.add('sm_green')
    h.io.outLines.length = 0
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'working-edit' }), 'codex')
    expect(h.io.outLines).toEqual([])
    expect(readSessionState('working-edit', h.env).message_acknowledgement_due).toBeUndefined()
  })

  /** Serves Session Message acknowledgement reads from `acknowledged`. */
  function withMessageAcknowledgements(h: Harness, acknowledged: Set<string>): string[] {
    const checks: string[] = []
    const factory = h.deps.clientFactory!
    h.deps.clientFactory = () => ({
      ...factory(),
      sessionMessageAcknowledgement: async (messageId: string) => {
        checks.push(messageId)
        return {
          message_id: messageId,
          agent_acknowledgement_text_required: true,
          agent_acknowledgement: acknowledged.has(messageId)
            ? { text: 'Switching databases now.', created_at: new Date(NOW).toISOString() }
            : null,
        }
      },
    }) as ApiClient
    return checks
  }

  it.each(['claude-code', 'codex', 'opencode'] as const)('reminds %s of a durable owed answer acknowledgement at the next prompt', async (harnessName) => {
    const h = harness([])
    const acknowledged = new Set<string>()
    const factory = h.deps.clientFactory!
    h.deps.clientFactory = () => ({
      ...factory(),
      agentAcknowledgement: async (requestId: string) => acknowledged.has(requestId)
        ? { request_id: requestId, text: 'On it.', created_at: new Date(NOW).toISOString() } : null,
    }) as ApiClient
    writeSessionState('answer-debt', h.env, { acknowledgement_due: [{ request_id: 'req_owed', recorded_at: NOW }] })

    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'answer-debt', cwd: h.deps.cwd, prompt: 'keep going' }), harnessName)
    const context = harnessName === 'opencode' ? h.io.outLines.join('\n')
      : (JSON.parse(h.io.outLines.at(-1)!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    expect(context).toContain('notifai acknowledge req_owed')

    acknowledged.add('req_owed')
    h.io.outLines.length = 0
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'answer-debt', cwd: h.deps.cwd, prompt: 'next' }), harnessName)
    expect(h.io.outLines.join('\n')).not.toContain('req_owed')
  })
})

/**
 * The same form shapes as question-push-budget.test.ts: a title per question,
 * two or three choices, one recommended.
 */
function sampleForm(count: number, textLength: number): string {
  const sentence = 'Close the older tracking issue now that the replacement work shipped and its parts are done? '
  const text = (index: number) => `${index + 1}. ${sentence.repeat(4)}`.slice(0, textLength).trimEnd()
  return JSON.stringify({
    title: 'Old issues to retire',
    summary: `${count} old issues: keep or retire?`,
    questions: Array.from({ length: count }, (_, index) => ({
      title: `Issue ${index + 1}`,
      text: text(index),
      choices: [
        { label: 'Close it', recommended: true },
        { label: 'Keep it for later' },
        ...(index % 3 === 0 ? [{ label: 'Ask me again next week' }] : []),
      ],
    })),
  })
}

/** Short yes/no checks: the kind of 10-question form that fits a phone push. */
function checklistForm(count: number): string {
  return JSON.stringify({
    title: 'Release checks',
    summary: `${count} release checks`,
    questions: Array.from({ length: count }, (_, index) => ({
      title: `Check ${index + 1}`,
      text: `Ship component ${index + 1} as it is today?`,
      choices: ['Yes', 'No'],
    })),
  })
}

/**
 * A form too large for a phone push used to register, then the service refused
 * it in the background and the question ended `retired` with no reason
 * anywhere. Submission now carries what fits, and a refusal says why.
 */
describe('a form against the phone push limit', () => {
  /** The service's rule: iPhone and Android pushes, after its device stamp, fit 4096 bytes. */
  function sizeCheckingService(h: Harness): void {
    const factory = h.deps.clientFactory!
    h.deps.clientFactory = () => {
      const base = factory()
      return {
        ...base,
        submit: async (body: SubmitNotificationRequestT, waitSeconds: number) => {
          const documents = [CAPABILITIES_V1.describe('ios')!, CAPABILITIES_V1.describe('android')!]
          const stamped = estimateFcmPayloadBytes(body.draft) + 45
          const tooLarge = validateDraft(body.draft, documents).errors.find((issue) => issue.code === 'payload_too_large') ??
            (stamped > 4096 ? { code: 'payload_too_large', path: 'platform.android',
              message: `Estimated android FCM payload is ${stamped} bytes; the limit is 4096.` } : undefined)
          if (tooLarge !== undefined) {
            throw new ApiCallError(422, 'payload_too_large', 'The draft was not accepted.', null, [tooLarge])
          }
          return base.submit(body, waitSeconds)
        },
      } as ApiClient
    }
  }

  function registerForm(h: Harness, sessionId: string, form: string): string {
    const built = buildQuestions({ form }, undefined)
    if (!built.ok) throw new Error(built.error)
    const registered = persistQuestion(sessionId, h.env, {
      question: built.questions[0]!.text,
      title: built.title!,
      summary: built.summary,
      questions: built.questions,
      project: 'notifai',
      source: { session_id: sessionId, session_label: 'Gentle Salmon', harness: 'codex' },
    }, NOW)
    return registered.question_id
  }

  async function settle(h: Harness, sessionId: string): Promise<void> {
    await hookRunCommand(h.deps, 'question-submission', stdin({ session_id: sessionId, cwd: h.deps.cwd }), 'codex')
  }

  function retiredLog(h: Harness): Array<Record<string, unknown> | undefined> {
    return readFileSync(activeLogPath(h.env), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> })
      .filter((record) => record.event === 'ask.retired')
      .map((record) => record.data)
  }

  it.each([
    ['an 8-question form', 8, sampleForm(8, 60)],
    ['a 10-question form', 10, checklistForm(10)],
  ])('submits %s that ask accepted', async (_name, count, form) => {
    const h = harness([])
    sizeCheckingService(h)
    writeGlobalConfig(h, 'ask_grace_seconds = 0\n')
    const sessionId = `form-fits-${count}`
    writeSessionState(sessionId, h.env, { harness: 'codex', last_prompt_at: AWAY })
    const questionId = registerForm(h, sessionId, form)

    await settle(h, sessionId)

    const pushed = h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.draft.reply?.questions).toHaveLength(count)
    expect(inspectQuestionState(questionId, h.env)).toMatchObject({ found: true, question: { state: 'live', submitted: true } })
  })

  it('records, logs and shows why the service refused a form registered before ask checked its size', async () => {
    const h = harness([])
    sizeCheckingService(h)
    writeGlobalConfig(h, 'ask_grace_seconds = 0\n')
    const sessionId = 'form-too-large'
    writeSessionState(sessionId, h.env, { harness: 'codex', last_prompt_at: AWAY })
    const questionId = registerForm(h, sessionId, sampleForm(8, 110))

    await settle(h, sessionId)

    expect(h.recorder.submitted.filter((entry) => isQuestionSubmit(entry))).toHaveLength(0)
    expect(inspectQuestionState(questionId, h.env)).toMatchObject({ found: true, question: {
      state: 'retired', submitted: false, reason: 'rejected_by_service',
      detail: expect.stringMatching(/^payload_too_large, HTTP 422: platform\.android: Estimated android FCM payload is \d+ bytes; the limit is 4096\.$/),
    } })
    expect(retiredLog(h)).toEqual([expect.objectContaining({
      question_id: questionId, state: 'retired', reason: 'rejected_by_service', submitted: false,
    })])

    h.io.outLines.length = 0
    expect(await statusCommand(h.deps, questionId, {})).toBe(EXIT.ok)
    expect(h.io.outLines).toContain('  Submission: refused by the service — the User never saw this question')
    expect(h.io.outLines.find((line) => line.startsWith('  Reason: '))).toMatch(/^ {2}Reason: the service refused it \(payload_too_large, HTTP 422: /)
    h.io.outLines.length = 0
    expect(await statusCommand(h.deps, questionId, { json: true })).toBe(EXIT.ok)
    expect(JSON.parse(h.io.outLines.join('\n'))).toMatchObject({ state: 'retired', submitted: false, end_reason: 'rejected_by_service' })
  })

  it('records why a closed question ended and logs it once', async () => {
    const h = harness([])
    const sessionId = 'closed-before-submission'
    writeSessionState(sessionId, h.env, { harness: 'codex', last_prompt_at: AWAY })
    const questionId = registerForm(h, sessionId, checklistForm(2))

    expect(await closeCommand(h.deps, questionId, { json: true })).toBe(EXIT.ok)

    expect(inspectQuestionState(questionId, h.env)).toMatchObject({ found: true, question: { state: 'withdrawn', reason: 'closed' } })
    expect(retiredLog(h)).toEqual([expect.objectContaining({ question_id: questionId, state: 'withdrawn', reason: 'closed' })])
  })
})
