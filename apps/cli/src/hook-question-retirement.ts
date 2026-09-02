/** Durable question retirement, including cross-session orphan recovery. */
import type { LifecycleEndState, ListRepliesResponse } from '@raidiant/notifai-protocol'
import { REPLY_MAX_WINDOW_SECONDS } from '@raidiant/notifai-protocol'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import {
  isSamePending,
  rememberQuestionState,
  sourceContextAtHookEvent,
} from './hook-question-state.js'
import { pendingList, readSessionState, updateSessionState } from './hook-session-state.js'
import type {
  HookContext,
  HookEnvelope,
  OrphanRetirement,
  PendingQuestion,
  RetiringQuestion,
  SessionState,
} from './hook-types.js'
/**
 * A retirement is only worth syncing while the question it retires could still
 * be answered, so this has to outlive the longest reply window a user can
 * choose — it is derived from that bound rather than from a guess about how
 * long questions stay open, which is exactly the assumption that broke when
 * the window stopped being one hour. Past it the companion shows the question
 * as dead on next open anyway. Also the backstop that keeps an unreachable
 * server from growing the queue for ever.
 */
const ORPHAN_TTL_MS = (REPLY_MAX_WINDOW_SECONDS + 3600) * 1000

/** More orphans than this means something is looping; keep the newest. */
const ORPHAN_QUEUE_CAP = 50

/**
 * Everything retirement needs. Narrower than a HookContext on purpose:
 * `notifai ask` supersedes the previous question and it is a plain command with
 * no hook payload, no idle probe and nothing to sleep for.
 */
export type RetireDeps = Pick<HookContext, 'client' | 'config'> & Pick<Partial<HookContext>, 'log'>

/**
 * Close is a server-side serialization fence: a successful response contains
 * every reply that committed before the window closed. `null` is deliberately
 * different from an empty reply set — it means ownership could not be proven
 * final and the local record must stay recoverable.
 */
export async function finalizeReplies(
  ctx: RetireDeps,
  requestId: string,
): Promise<ListRepliesResponse | null> {
  try {
    return await ctx.client.closeReplies(requestId)
  } catch {
    return null
  }
}

/** Best effort only for already-journaled retirement debt. */
export async function closeQuietly(ctx: RetireDeps, requestId: string): Promise<void> {
  await finalizeReplies(ctx, requestId)
}

/**
 * Close the reply window so the server can mint the retirement push. Client
 * submissions cannot carry `question_retired`; that event is reserved for
 * server-origin state syncs.
 */
async function proveRetirement(
  ctx: RetireDeps,
  requestId: string,
): Promise<boolean> {
  const response = await finalizeReplies(ctx, requestId)
  const proven = response !== null
  ctx.log?.info('hook.retirement', {
    request_id: requestId,
    attempted: true,
    proven,
  })
  return proven
}

/**
 * Park a delivered question for retirement. Called at the moment we learn it is
 * dead, which is frequently not a moment we can reach the network.
 *
 * Nothing is parked for a question that never reached a device: with no
 * request_id there is nothing on any device to retire.
 */
export function parkForRetirement(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  pending: PendingQuestion,
  state: LifecycleEndState,
): void {
  const retirement = retiringQuestion(pending, state)
  if (retirement === null) return
  updateSessionState(sessionId, env, (current) => {
    const already = current.retiring ?? []
    const existing = already.findIndex((entry) => entry.request_id === retirement.request_id)
    if (existing < 0) {
      return rememberQuestionState(
        { ...current, retiring: [...already, retirement] },
        pending,
        state === 'answered' ? 'answered' : 'retired',
      )
    }
    const retiring = [...already]
    // An observed answer is final truth and upgrades an earlier supersession
    // parked while the submission callback was racing a newer question.
    if (retirement.state === 'answered' && retiring[existing]!.state !== 'answered') {
      retiring[existing] = retirement
    }
    return rememberQuestionState(
      { ...current, retiring },
      pending,
      state === 'answered' ? 'answered' : 'retired',
    )
  })
}

/**
 * Convert live question state into a complete retirement instruction.
 *
 * A request/collapse pair without the original Delivery targets is not safe to
 * send: re-resolving today's routing can miss a device that still shows the
 * question or retire a device that never received it. Fail explicitly and keep
 * the pending record instead of silently broadening or narrowing the fanout.
 */
export function retiringQuestion(
  pending: PendingQuestion,
  state: LifecycleEndState,
  cwd?: string,
): RetiringQuestion | null {
  // A submit journal is written before the first network byte. SessionEnd can
  // therefore race a request that the server accepts after local cleanup. Its
  // reserved request id and exact fanout are already sufficient retirement
  // identity, even though the ordinary live fields have not been promoted yet.
  const requestId = pending.request_id ?? pending.submission?.request_id
  const collapseKey = pending.collapse_key ?? pending.submission?.collapse_key
  const deviceIds = pending.device_ids ?? pending.submission?.device_ids
  const hasRequest = requestId !== undefined
  const hasCollapse = collapseKey !== undefined
  const hasDevices = deviceIds !== undefined && deviceIds.length > 0
  if (!hasRequest && !hasCollapse && !hasDevices) return null
  if (!hasRequest || !hasCollapse || !hasDevices) {
    throw new Error(
      'live question state is incomplete; refusing to retire it without request, collapse, and device identifiers',
    )
  }
  const source = sourceContextAtHookEvent(pending.source, cwd)
  return {
    ...(pending.question_id !== undefined ? { question_id: pending.question_id } : {}),
    request_id: requestId!,
    collapse_key: collapseKey!,
    device_ids: [...deviceIds!],
    question: pending.question,
    ...(pending.project !== undefined ? { project: pending.project } : {}),
    ...(source !== undefined ? { source } : {}),
    state,
  }
}

const SHORT_CONFIRMATIONS = new Set(['done', 'yes', 'y', 'no', 'n', 'ok', 'okay'])

function normalizePrompt(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function pendingChoiceLabels(pending: PendingQuestion): string[] {
  const fromQuestions = (pending.questions ?? []).flatMap((question) =>
    (question.choices ?? []).flatMap((choice) => [choice.label, choice.id]),
  )
  return fromQuestions.map(normalizePrompt).filter((label) => label.length > 0)
}

function pendingHasMatchingChoice(pending: PendingQuestion, normalizedPrompt: string): boolean {
  return pendingChoiceLabels(pending).includes(normalizedPrompt)
}

/**
 * Which outstanding questions this prompt plausibly answers.
 *
 * A unique closed-choice match is enough. A short confirmation such as "done"
 * matches only when exactly one question is outstanding. Long unrelated
 * prompts leave every question open for the reply window.
 */
export function pendingAnsweredByPrompt(
  prompt: string | undefined,
  pending: readonly PendingQuestion[],
): PendingQuestion[] {
  const normalized = normalizePrompt(prompt ?? '')
  if (normalized.length === 0 || pending.length === 0) return []

  const labelled = pending.filter((entry) => pendingHasMatchingChoice(entry, normalized))
  if (labelled.length === 1) return labelled
  if (labelled.length > 1) return []
  if (pending.length === 1 && SHORT_CONFIRMATIONS.has(normalized)) return [...pending]
  return []
}

/**
 * Send every parked retirement, and forget the ones that landed. A failure
 * leaves the entry in place for the next hook rather than losing it, which is
 * the whole reason the queue exists.
 */
export async function drainRetirements(
  ctx: RetireDeps,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const queue = readSessionState(sessionId, env).retiring ?? []
  if (queue.length === 0) return []

  const retired: string[] = []
  for (const entry of queue) {
    const proven = await proveRetirement(ctx, entry.request_id)
    if (proven) {
      retired.push(entry.request_id)
      // Persist each success before touching the next entry. A later corrupt
      // record or interrupted process must not resurrect work already done.
      updateSessionState(sessionId, env, (current) => ({
        ...current,
        retiring: (current.retiring ?? []).filter(
          (candidate) => candidate.request_id !== entry.request_id,
        ),
      }))
    }
  }
  return retired
}

function orphanQueuePath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'retire-queue.json')
}

function readOrphanQueue(env: NodeJS.ProcessEnv): OrphanRetirement[] {
  const file = orphanQueuePath(env)
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as OrphanRetirement[]) : []
  } catch {
    // Same stance as session state: corruption fails closed to "nothing queued".
    return []
  }
}

function writeOrphanQueueUnlocked(file: string, queue: OrphanRetirement[]): void {
  atomicWriteFileSync(file, `${JSON.stringify(queue, null, 2)}\n`)
}

function updateOrphanQueue(
  env: NodeJS.ProcessEnv,
  update: (current: OrphanRetirement[]) => OrphanRetirement[],
): OrphanRetirement[] {
  const file = orphanQueuePath(env)
  return withFileLock(`${file}.lock`, () => {
    const next = update(readOrphanQueue(env))
    writeOrphanQueueUnlocked(file, next)
    return next
  })
}

/** Move retirements into the global queue; deduped so a retry costs nothing. */
export function orphanRetirements(
  env: NodeJS.ProcessEnv,
  entries: RetiringQuestion[],
  now: number,
): void {
  if (entries.length === 0) return
  updateOrphanQueue(env, (queue) => {
    const known = new Set(queue.map((entry) => entry.request_id))
    const added = entries
      .filter((entry) => !known.has(entry.request_id))
      .map((entry) => ({ ...entry, enqueued_at: now }))
    return [...queue, ...added].slice(-ORPHAN_QUEUE_CAP)
  })
}

/**
 * Retire everything a dead session left behind. Failures stay queued for the
 * next holder of a client; entries past the TTL are dropped as already dead.
 */
export async function drainOrphanRetirements(
  ctx: RetireDeps,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<string[]> {
  const queue = readOrphanQueue(env)
  if (queue.length === 0) return []

  const done: string[] = []
  for (const entry of queue) {
    const age = now - entry.enqueued_at
    // A negative age is a clock jump, not a fresh entry; retiring is idempotent
    // and cheap, so treat it as due rather than letting it linger for ever.
    if (age > ORPHAN_TTL_MS) {
      done.push(entry.request_id)
      updateOrphanQueue(env, (current) =>
        current.filter((candidate) => candidate.request_id !== entry.request_id),
      )
      continue
    }
    const proven = await proveRetirement(ctx, entry.request_id)
    if (proven) {
      done.push(entry.request_id)
      updateOrphanQueue(env, (current) =>
        current.filter((candidate) => candidate.request_id !== entry.request_id),
      )
    }
  }
  return done
}

export async function retirePendings(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  entries: PendingQuestion[],
  state: LifecycleEndState,
): Promise<void> {
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    for (const entry of entries) {
      const retirement = retiringQuestion(entry, state, envelope.cwd)
      if (retirement !== null && !retiring.some((item) => item.request_id === retirement.request_id)) {
        retiring.push(retirement)
      }
    }
    const pending = pendingList(current).filter(
      (candidate) => !entries.some((entry) => isSamePending(candidate, entry)),
    )
    const next: SessionState = { ...current }
    if (pending.length > 0) next.pending = pending
    else delete next.pending
    if (retiring.length > 0) next.retiring = retiring
    else delete next.retiring
    return entries.reduce(
      (remembered, entry) => rememberQuestionState(
        remembered,
        entry,
        state === 'answered' ? 'answered' : 'retired',
      ),
      next,
    )
  })
  // Network retirement is deliberately deferred to a later no-question hook.
  // The state write above is the durable operation; blocking here creates a
  // crash window before an answer can reach harness stdout.
}
