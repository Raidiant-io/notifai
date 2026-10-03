/** Durable wake attempts. Native I/O never runs inside the session-state lock. */
import type { NativeTurnSnapshot } from './codex-native-turn.js'
import { randomUUID } from 'node:crypto'
import { NativeQueueNotSent, type QueueControl } from './codex-queue-control.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import { currentProcessIdentity, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { readAttendantLease } from './session-attendant-state.js'

export interface InputWakeAttempt {
  token: string
  ownerKey: string
  incarnation: string
  generation: number | null
  namespace: string
  inputIds: string[]
  text: string
  writer: ProcessIdentity
  phase: 'prepared' | 'sending' | 'accepted' | 'unknown' | 'consumed' | 'cancelled'
  detached: boolean
  nativeId?: string
  cleanupChecks?: number
  recoveryEvidence?: { identity: string; file: string; size: number; highWater: number; turnId: string; idleSince?: number; checkedAt: number }
  nextCheckAt?: number
}

type Scope = { sessionId: string; env: NodeJS.ProcessEnv }
type Owner = { key: string; incarnation: string; generation: number | null }
const CLEANUP_BATCH = 8
const RETAINED_DETACHED = 64
const terminal = (attempt: InputWakeAttempt) => ['consumed', 'cancelled'].includes(attempt.phase)
export const readInputWakes = ({ sessionId, env }: Scope): InputWakeAttempt[] => readSessionState(sessionId, env).input_wake_attempts ?? []

function owns(scope: Scope, owner: Owner): boolean {
  const current = readSessionIncarnation(scope.sessionId, scope.env)
  if (current?.key !== owner.key || current.incarnation !== owner.incarnation || sessionHasEnded(scope.sessionId, scope.env) ||
      current.harness_process === undefined || processIdentityLiveness(current.harness_process) !== 'alive') return false
  if (owner.generation === null) return true
  const lease = readAttendantLease(scope.sessionId, scope.env)
  return lease?.incarnation === owner.incarnation && lease.generation === owner.generation
}

function mutate(scope: Scope, transform: (attempts: InputWakeAttempt[]) => InputWakeAttempt[]): void {
  updateSessionState(scope.sessionId, scope.env, state => {
    const attempts = transform(state.input_wake_attempts ?? [])
    const finished = attempts.filter(terminal).slice(-32)
    // An evicted unresolved record is abandoned cleanup, never cancellation.
    // Keep live writers until their native operation's bounded deadline ends.
    const prunable = attempts.filter(a => !terminal(a) && a.detached &&
      !(a.phase === 'sending' && processIdentityLiveness(a.writer) !== 'gone'))
    const retained = new Set(prunable.slice(-RETAINED_DETACHED).map(a => a.token))
    const active = attempts.filter(a => !terminal(a) && (!prunable.includes(a) || retained.has(a.token)))
    return { ...state, input_wake_attempts: active.concat(finished) }
  })
}

/** Persist election before the first native byte. Pending IDs include input
 * revision, not just a reusable question ID. Callbacks must only read: this
 * runs under the session-state lock, including the final activity check. */
export function electInputWake(input: Scope & {
  owner: Owner; namespace: string; pendingIds(): string[] | null; mayWake(): boolean; text(token: string): string
}): InputWakeAttempt | null {
  const writer = currentProcessIdentity()
  if (writer === null) return null
  let elected: InputWakeAttempt | null = null
  mutate(input, attempts => {
    if (!owns(input, input.owner) || !input.mayWake()) return attempts
    const ids = input.pendingIds()
    if (ids === null || ids.length === 0) return attempts
    const outstanding = attempts.filter(a => a.incarnation === input.owner.incarnation && !a.detached && !terminal(a))
    const coalesced = outstanding.find(a => a.phase === 'accepted' || a.phase === 'prepared' ||
      (a.phase === 'sending' && processIdentityLiveness(a.writer) !== 'gone'))
    if (coalesced !== undefined) return attempts.map(a => a.token === coalesced.token
      ? { ...a, inputIds: [...new Set([...a.inputIds, ...ids])] } : a)
    // A genuinely new revision may escape an unresolved older wake.
    const covered = new Set(outstanding.flatMap(a => a.inputIds))
    if (outstanding.length > 0 && ids.every(id => covered.has(id))) return attempts
    // Bound admitted operations even if several callers stall before receipt.
    if (attempts.filter(a => a.phase === 'sending' && processIdentityLiveness(a.writer) !== 'gone').length >= CLEANUP_BATCH) return attempts
    attempts = attempts.map(a => outstanding.includes(a) ? { ...a, detached: true } : a)
    const token = randomUUID()
    elected = { token, ownerKey: input.owner.key, incarnation: input.owner.incarnation,
      generation: input.owner.generation, namespace: input.namespace, inputIds: ids,
      text: input.text(token), writer, phase: 'prepared', detached: false }
    return [...attempts, elected]
  })
  return elected
}

/** The second gate covers a hook drain or a new prompt after election. A
 * drain after admission detaches the attempt; its late receipt is retained. */
export async function admitInputWake(input: Scope & {
  token: string; control: QueueControl; pendingIds(): string[] | null; mayWake(): boolean
}): Promise<void> {
  let sending: InputWakeAttempt | undefined
  mutate(input, attempts => attempts.map(a => {
    if (a.token !== input.token || a.phase !== 'prepared') return a
    const owner = { key: a.ownerKey, incarnation: a.incarnation, generation: a.generation }
    const ids = input.pendingIds()
    if (ids === null) return a
    const pending = new Set(ids)
    if (a.detached || input.control.threadId !== input.sessionId || input.control.namespace !== a.namespace || !owns(input, owner) || !input.mayWake() || !a.inputIds.some(id => pending.has(id))) {
      return { ...a, phase: 'cancelled', detached: true }
    }
    sending = { ...a, phase: 'sending' }
    return sending
  }))
  if (sending === undefined) return
  try {
    const id = await input.control.add(sending.token, sending.text)
    mutate(input, attempts => attempts.map(a => a.token !== input.token ? a : {
      ...a, nativeId: id, phase: terminal(a) ? a.phase : 'accepted',
    }))
  } catch (error) {
    if (error instanceof NativeQueueNotSent) {
      mutate(input, attempts => attempts.map(a => a.token === input.token && !terminal(a) ? { ...a, phase: 'cancelled', detached: true } : a))
      return
    }
    // A crash/timeout/refusal after admission can have reached the backend.
    // It never becomes a new add, including after this helper restarts.
    mutate(input, attempts => attempts.map(a => a.token === input.token && !terminal(a) ? { ...a, phase: 'unknown' } : a))
  }
}

/** Detach before cleanup I/O so an old deletion cannot suppress new input. */
export function detachInputWakes(input: Scope & { pendingIds(): string[] | null }): void {
  mutate(input, attempts => {
    const ids = input.pendingIds()
    if (ids === null) return attempts
    const pending = new Set(ids)
    return attempts.map(a => !terminal(a) && !a.inputIds.some(id => pending.has(id)) ? { ...a, detached: true } : a)
  })
}

/** A prompt identifies its own attempt. Manual receive has no such identity. */
export function observeInputWake(scope: Scope, token: string): void {
  mutate(scope, attempts => attempts.map(a => a.token === token ? { ...a, phase: 'consumed', detached: true } : a))
}

/** Reconnect is read/reconcile only: never add an uncertain attempt again. */
export async function reconcileInputWakes(scope: Scope, control: QueueControl, now = Date.now()): Promise<void> {
  if (control.threadId !== scope.sessionId) return
  const candidates = readInputWakes(scope)
    .filter(a => !terminal(a) && a.namespace === control.namespace && (a.nextCheckAt ?? 0) <= now)
    .sort((a, b) => (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0)).slice(0, CLEANUP_BATCH)
  for (const captured of candidates) {
    // Claim the backoff before native I/O so overlapping helpers cannot scan
    // the same whole backlog. Every pass does at most eight native lookups.
    let claimed = false
    mutate(scope, attempts => attempts.map(a => {
      if (a.token !== captured.token || terminal(a) || (a.nextCheckAt ?? 0) > now) return a
      claimed = true
      const checks = (a.cleanupChecks ?? 0) + 1
      return { ...a, cleanupChecks: checks, nextCheckAt: now + Math.min(30_000, 2_000 * 2 ** Math.min(checks - 1, 4)) }
    }))
    if (!claimed) continue
    let a = captured
    if (a.phase === 'prepared') {
      if (a.detached || !owns(scope, { key: a.ownerKey, incarnation: a.incarnation, generation: a.generation }) || processIdentityLiveness(a.writer) === 'gone') {
        mutate(scope, attempts => attempts.map(v => v.token === a.token && v.phase === 'prepared' ? { ...v, phase: 'cancelled', detached: true } : v))
      }
      continue
    }
    try {
      if (a.nativeId === undefined) {
        const found = await control.find(a.token, a.text)
        // Absence also means it may have dequeued. Ambiguity is not ownership.
        if (typeof found === 'string') continue
        mutate(scope, attempts => attempts.map(v => v.token === a.token ? { ...v, nativeId: found.id } : v))
      }
      // A drain/observation could have occurred during list. Use current state.
      const current = readInputWakes(scope).find(v => v.token === a.token)
      if (current === undefined || terminal(current) || !current.detached || current.nativeId === undefined) continue
      a = current
      const deleted = await control.remove(a.nativeId!)
      if (deleted) mutate(scope, attempts => attempts.map(v => v.token === a.token && !terminal(v) ? { ...v, phase: 'cancelled', detached: true } : v))
      // Delete-absent never means cancelled. A late token observation can still
      // settle this exact attempt without clearing a newer attempt.
    } catch { /* Keep unresolved intent for the next bounded reconciliation. */ }
  }
}


/** One content-free liveness replacement for each immutable pending revision.
 * Absence is not rejection: an old wake may still arrive. This does not alter
 * the input delivery journal or repeat any answer presentation.
 * Native/eligibility readers must be synchronous and mutation-free. */
export async function recoverUncertainInputWake(input: Scope & {
  owner: Owner; control: QueueControl; pendingIds(): string[] | null; mayWake(): boolean
  native(): NativeTurnSnapshot | null; text(token: string): string
  monotonic?: () => number
}): Promise<InputWakeAttempt | null> {
  if (input.control.threadId !== input.sessionId) return null
  const old = readInputWakes(input).find(a => !a.detached && !terminal(a) && a.phase !== 'prepared' &&
    a.incarnation === input.owner.incarnation && a.namespace === input.control.namespace)
  if (old === undefined || (old.phase === 'sending' && processIdentityLiveness(old.writer) !== 'gone')) return null
  // Every fresh connection has already established this home/thread association.
  let found: Awaited<ReturnType<QueueControl['find']>>
  try { found = await input.control.find(old.token, old.text) } catch { return null }
  if (typeof found !== 'string') {
    mutate(input, attempts => attempts.map(a => a.token === old.token ? { ...a, nativeId: found.id } : a))
    return null
  }
  if (found !== 'absent') return null
  const writer = currentProcessIdentity()
  if (writer === null) return null
  let replacement: InputWakeAttempt | null = null
  updateSessionState(input.sessionId, input.env, state => {
    if (!owns(input, input.owner)) return state
    const attempts = state.input_wake_attempts ?? []
    const current = attempts.find(a => a.token === old.token)
    if (current === undefined || current.detached || terminal(current) || current.nativeId !== old.nativeId || current.phase !== old.phase) return state
    const native = input.native()
    const ids = input.pendingIds()
    if (native === null || ids === null || ids.length === 0 || !current.inputIds.some(id => ids.includes(id))) return state
    const now = (input.monotonic ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))()
    const prior = current.recoveryEvidence
    if (prior !== undefined && (prior.identity !== native.identity || prior.file !== native.file || native.size < prior.highWater)) return state
    const same = prior !== undefined && prior.identity === native.identity && prior.file === native.file &&
      native.size >= prior.size && now >= prior.checkedAt
    const advanced = same && native.latest.ended && native.latest.id !== prior.turnId && native.latest.offset >= prior.size
    const continuous = same && now - prior.checkedAt <= 6_000 && native.latest.id === prior.turnId
    const idleSince = native.latest.ended ? continuous ? prior.idleSince ?? now : now : undefined
    const evidence = { identity: native.identity, file: native.file,
      size: same ? prior.size : native.size, highWater: native.size, turnId: same ? prior.turnId : native.latest.id,
      ...(idleSince === undefined ? {} : { idleSince }), checkedAt: now }
    const eligible = native.latest.ended && input.mayWake() && (advanced || (idleSince !== undefined && now - idleSince >= 30_000))
    const used = state.input_wake_recovery?.incarnation === current.incarnation ? state.input_wake_recovery.inputIds : []
    const fresh = ids.filter(id => !used.includes(id))
    // Retain the budget across drain/re-add and process restart. Reaching this
    // safety cap disables uncertainty replacement, never ordinary new wakes.
    if (!eligible || fresh.length === 0 || used.length + fresh.length > 256) {
      return { ...state, input_wake_attempts: attempts.map(a => a.token === current.token ? { ...a, recoveryEvidence: evidence } : a) }
    }
    const token = randomUUID()
    replacement = { token, ownerKey: input.owner.key, incarnation: input.owner.incarnation,
      generation: input.owner.generation, namespace: input.control.namespace, inputIds: ids,
      text: input.text(token), writer, phase: 'prepared', detached: false }
    return { ...state,
      input_wake_recovery: { incarnation: current.incarnation, inputIds: [...used, ...fresh] },
      input_wake_attempts: [...attempts.map(a => a.token === current.token ? { ...a, detached: true } : a), replacement] }
  })
  return replacement
}
