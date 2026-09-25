import { existsSync } from 'node:fs'
import path from 'node:path'
import { configHome } from './install-hooks.js'
import {
  type ContinuationEvent,
  type DeliveryOutcome,
  type EscalationDeliveryRoute,
} from './hook-types.js'
import { deliverIntoCodexThread } from './session-handoff.js'
import { cancelledDelivery, holdForNextTurn, runWakeCommand } from './wake-support.js'

/** Codex thread ids are UUIDs, and `--thread` wants that exact id. */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The per-thread durable inbox `codex queue` writes to, relative to `$CODEX_HOME`.
 *
 * Named for diagnostics only. Notifai never opens it: the schema is private to
 * Codex, versioned by its own migration table, and the supported writer is the
 * CLI. Reading it here would couple Notifai to an internal shape it does not own.
 */
export const CODEX_QUEUE_STORE_FILE = 'queue_1.sqlite'

export interface CodexWakeAdapters {
  /** Write one message into the thread's durable inbox via `codex queue`. */
  queue(threadId: string, cwd: string, context: string): Promise<void>
}

export type CodexQueueReadiness =
  | { state: 'ready'; threadId: string }
  | { state: 'unavailable'; reason: string }

export function codexHome(env: NodeJS.ProcessEnv): string {
  return configHome(env, 'CODEX_HOME', '.codex')
}

export function codexQueueStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(codexHome(env), CODEX_QUEUE_STORE_FILE)
}

/**
 * Whether this Stop hook could queue an answer into its own thread.
 *
 * The only precondition the route actually has is an exact thread id: queueing
 * needs no writer lock, no daemon, no socket and no platform syscall, and it
 * succeeds against a live, busy or stopped thread alike. The absence of the
 * queue store is deliberately *not* a blocker — Codex creates it on first
 * write — so this reports readiness, never a store-existence gate.
 */
export function inspectCodexQueue(
  threadId: string | undefined,
  _env: NodeJS.ProcessEnv,
): CodexQueueReadiness {
  if (threadId === undefined || !THREAD_ID.test(threadId)) {
    return {
      state: 'unavailable',
      reason: 'the Codex session id is not a thread id, so no inbox can be named',
    }
  }
  return { state: 'ready', threadId }
}

/**
 * Codex's answer-delivery route: the thread's own durable inbox.
 *
 * `codex queue --thread <id> --message <text>` is not an IPC call into a live
 * process. It writes one FIFO item into a per-thread inbox in `$CODEX_HOME`,
 * and whichever client owns that thread drains it: a live idle session within
 * seconds, a busy one at its next turn boundary, a stopped one the next time it
 * is opened. The answer arrives as an ordinary user turn, firing
 * `UserPromptSubmit` with the queued text.
 *
 * That is why this route replaced the writer-lock probe rather than joining it.
 * The probe existed so a cold resume could never ghost-write a thread another
 * process owned; queueing cannot ghost-write, because the message is delivered
 * *by* the owner and simply waits when there is none. There is no race to lose,
 * and nothing here depends on a BSD `O_EXLOCK`.
 *
 * Two limits are load-bearing and are honoured here:
 *
 * 1. **Exit 0 is not delivery.** `codex queue` reports the same success against
 *    an exited session as a live one, so this route never claims `delivered`.
 *    It reports `queued`, and Notifai's own `UserPromptSubmit` hook is what
 *    observes actual consumption.
 * 2. **Never queue and cold-resume the same answer.** `codex exec resume <id>
 *    "<prompt>"` drains the pending queue *and* runs the prompt, delivering it
 *    twice. This module therefore has no resume path at all: the routes must be
 *    mutually exclusive per answer, and the simplest way to guarantee that is
 *    for only one of them to exist.
 */
export function codexWakeRoute(options: {
  threadId: string
  cwd: string
  env?: NodeJS.ProcessEnv
  adapters?: CodexWakeAdapters
}): EscalationDeliveryRoute {
  const env = options.env ?? process.env
  const adapters = options.adapters ?? systemCodexWakeAdapters(env)
  return {
    kind: 'session-queue',
    async deliver(event: ContinuationEvent): Promise<DeliveryOutcome> {
      const written = await deliverIntoCodexThread({
        threadId: options.threadId,
        cwd: options.cwd,
        env,
        adapters,
        text: event.context,
        begin: event.commitDelivery,
      })
      if (written.status === 'unavailable') return holdForNextTurn(written.reason)
      if (written.status === 'cancelled' || written.status === 'stopped') return cancelledDelivery()
      if (written.status === 'failed') {
        return holdForNextTurn(`queueing the answer into the Codex thread failed: ${written.reason}`)
      }
      return {
        notes: [
          "queued the accepted answer into the Codex thread's durable inbox; it starts a turn when that thread is next live",
        ],
        // `stage: queued`, never `delivered`: exit 0 is identical against an
        // exited thread, so this write proves storage and never consumption.
        // Consumption is observable elsewhere and only elsewhere — this
        // session's own UserPromptSubmit fires with the queued text.
        log: { route: 'session-queue', stage: 'queued' },
        // The journal still settles here, and must. `delivered` is this
        // codebase's token for "the harness itself accepted the write", which
        // is exactly what happened; it has never meant the model acted on it
        // (see DeliveryAcknowledgement). Holding instead would replay the
        // answer at every turn-end while Codex also delivers the queued copy,
        // which is the one failure this route has to avoid.
        acknowledgement: 'delivered',
      }
    },
  }
}

function runCodex(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  return runWakeCommand('codex', args, options)
}

export function systemCodexWakeAdapters(
  env: NodeJS.ProcessEnv = process.env,
): CodexWakeAdapters {
  return {
    async queue(threadId, cwd, context) {
      if (!existsSync(cwd)) throw new Error(`Codex thread cwd no longer exists: ${cwd}`)
      await runCodex(['queue', '--thread', threadId, '--message', context], { cwd, env })
    },
  }
}
