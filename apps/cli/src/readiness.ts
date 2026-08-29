/**
 * What "set up" means, in one place.
 *
 * `init` and `doctor` used to each carry their own idea of this — a fixed
 * five-step script in one, a flat list of checks in the other — which is two
 * copies of the same knowledge that can disagree, and did: doctor called
 * missing hooks fine while init offered to install them, and only doctor knew
 * what a revoked credential looked like.
 *
 * So the model lives here and both commands render it. `doctor` shows every
 * state at once, because a report is what it is for. `init` walks the same
 * list in order and stops at the first thing standing in the way, because
 * someone handed five tasks does none of them. An agent gets the same states
 * through a third renderer that never prompts.
 *
 * The ordering is a dependency chain, not a preference: there is no point
 * asking the server about devices before there is a credential to ask with,
 * and no point reporting a stale contract to someone who cannot reach the
 * server at all. Assessment stops descending when a prerequisite is missing
 * and marks what follows `unknown` rather than guessing.
 */

/** Whether the gap can be closed from here, and by whom. */
export type Remedy =
  /**
   * The CLI can do it unattended — no prompt, no human. `command` is how a
   * reader would ask for it later, for the case where it was declined or
   * skipped; it is never needed to perform the action.
   */
  | { by: 'cli'; summary: string; command?: string }
  /**
   * A human at this terminal. `interactive` marks the ones the CLI can drive
   * on their behalf when someone is actually watching — a browser sign-in is
   * the CLI's to launch but the human's to complete, so an agent must still
   * treat it as out of reach.
   */
  | {
      by: 'user-here'
      summary: string
      command: string
      interactive?: boolean
      /** Stable agent-facing description of an unavoidable harness-owned action. */
      user_action?: { code: string; harness: string; action: string; message: string }
    }
  /**
   * A human somewhere else entirely — phone in hand, app store, permission
   * dialog. The class the old init could only print a sentence about, and the
   * one most likely to end an onboarding.
   */
  | { by: 'user-elsewhere'; summary: string }

export type StateStatus =
  /** Satisfied. */
  | 'ready'
  /** Not satisfied, and it stands in the way. */
  | 'gap'
  /** Not satisfied, and that is a legitimate choice. */
  | 'optional-gap'
  /** A prerequisite is missing, so this was never evaluated. */
  | 'unknown'

export interface ReadinessState {
  id: string
  /** Human words for what this is, not the field name. */
  title: string
  status: StateStatus
  /** The current condition, phrased for the human renderer. */
  detail: string
  /** Structured diagnostics emitted only by --json / non-human surfaces. */
  technical?: unknown
  remedy?: Remedy
}

export interface Readiness {
  states: ReadinessState[]
}

/** The first thing standing in the way, or null when nothing is. */
export function firstBlocker(readiness: Readiness): ReadinessState | null {
  return readiness.states.find((s) => s.status === 'gap') ?? null
}

/**
 * Question Routing: what lets a question reach a phone when nobody is at the
 * terminal. Hooks, their sub-states, and the setting that admits them.
 *
 * Separate from `isOptionalSetup` because these are also the states a human
 * should not be handed as leftovers — "Optional, not set up" is a fair line
 * about the agent skill and a confusing one about a session pointer.
 */
export function isOptionalAutomation(id: string): boolean {
  return id === 'hooks' || id.startsWith('hooks-') || id === 'question-routing-settings'
}

/**
 * Automation layered on top of a product that already sends: Question Routing
 * and the agent guidance skill.
 *
 * Real, and reported. `doctor` is the report and judges it strictly. Anything
 * whose job is to get a first notification delivered treats it as a line to
 * print, never a gate — a hook diagnostic or a duplicate skill install in
 * front of the delivery proof means a setup that can already send never proves
 * that it can. The one that fires most often, a turn that has not ended yet,
 * cannot be closed by the agent standing inside that turn at all.
 */
export function isOptionalSetup(id: string): boolean {
  return id === 'skill' || isOptionalAutomation(id)
}

/** The first thing in the way that is not optional automation. */
export function firstRequiredBlocker(readiness: Readiness): ReadinessState | null {
  return readiness.states.find((s) => s.status === 'gap' && !isOptionalSetup(s.id)) ?? null
}

/**
 * Ready enough to be useful, which is not the same as every box ticked.
 *
 * Hooks and the agent skill are genuinely optional — `send` works without
 * them — so an install that declined both is finished, not half-done. Saying
 * otherwise trains people to ignore the summary line, and it is the summary
 * line an agent branches on.
 */
export function isReady(readiness: Readiness): boolean {
  return firstRequiredBlocker(readiness) === null
}

const SEND_PREREQUISITES = new Set([
  'cli-bin',
  'credential',
  'server',
  'contract',
  'auth',
  'devices',
])

/** Baseline Notification Requests can be submitted in the final assessed state. */
export function canSend(readiness: Readiness): boolean {
  return [...SEND_PREREQUISITES].every((id) => {
    const state = readiness.states.find((candidate) => candidate.id === id)
    return state?.status === 'ready' || state?.status === 'optional-gap'
  })
}

/** This exact invocation has a fully evidenced asynchronous question route. */
export function questionRoutingReady(readiness: Readiness): boolean {
  const relevant = readiness.states.filter(
    (state) =>
      state.id === 'question-routing-settings' ||
      (state.id === 'hooks' || state.id.startsWith('hooks-')) && state.id !== 'hooks-detected',
  )
  return relevant.length > 0 && relevant.every((state) => state.status === 'ready')
}

/** Stable machine renderer shared by init and doctor. */
export function readinessJson(readiness: Readiness): object {
  return {
    ready: isReady(readiness),
    can_send: canSend(readiness),
    question_routing_ready: questionRoutingReady(readiness),
    states: readiness.states.map((state) => ({
      id: state.id,
      title: state.title,
      status: state.status,
      detail: state.detail,
      technical: state.technical ?? null,
      remedy: state.remedy ?? null,
    })),
  }
}

/** Everything that could still be done, blocking or not, in dependency order. */
export function openItems(readiness: Readiness): ReadinessState[] {
  return readiness.states.filter((s) => s.status === 'gap' || s.status === 'optional-gap')
}

/**
 * Work an assessment can do.
 *
 * `local` is this machine's files: project config, hook installs, skill lock
 * files. `remote` is everything that leaves the process — the keychain, the
 * service, the account, devices, and delivery evidence. The split exists so a
 * redraw after a settings change does not pay for a health check.
 */
export type ReadinessRefresh = 'local' | 'remote'

/**
 * After a menu action, which readiness work is worth doing.
 *
 * `null` means keep the assessment already in hand. Doctor is the report, not
 * a mutation: the check it just ran is the redraw. A test send and a device
 * list cannot change setup. Settings and hook wiring stay on this machine
 * unless the caller says the service URL itself moved.
 */
export function refreshAfterMenuAction(
  action: 'setup' | 'account' | 'test' | 'devices' | 'settings' | 'routing' | 'doctor',
  changed: boolean,
  options: { remote?: boolean } = {},
): readonly ReadinessRefresh[] | null {
  switch (action) {
    case 'doctor':
    case 'test':
    case 'devices':
      return null
    case 'setup':
    case 'account':
      return changed ? ['local', 'remote'] : null
    case 'settings':
    case 'routing':
      if (!changed) return null
      return options.remote === true ? ['local', 'remote'] : ['local']
  }
}
