/**
 * Bounded work a command starts but does not wait for (a hand-off to the hub,
 * a credential-change notice). The process waits for it before it exits; each
 * piece carries its own timeout.
 */
const inFlight = new Set<Promise<unknown>>()

export function finishBeforeExit(work: Promise<unknown>): void {
  const tracked = work.catch(() => undefined).finally(() => { inFlight.delete(tracked) })
  inFlight.add(tracked)
}

export async function settleBeforeExit(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight])
}
