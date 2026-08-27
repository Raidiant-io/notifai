import { REPLY_MAX_WINDOW_SECONDS } from '@raidiant/notifai-protocol'

/**
 * Time before reply-window admission that the Stop owner may spend reading its
 * input, serving terminal-first grace, resolving devices, and submitting.
 *
 * Grace is capped at six minutes and every network operation is independently
 * bounded. Twenty minutes lets setup spend up to ten while preserving the
 * separate completion margin below; neither may borrow from the answer window
 * the service actually commits.
 */
export const QUESTION_WAITER_STARTUP_HEADROOM_SECONDS = 20 * 60

/**
 * Minimum lifetime still available when a question is admitted.
 *
 * The server window starts during submission, not when the hook process
 * started. Keeping ten minutes beyond the requested window covers the bounded
 * submit, clock skew, close fence, and route handoff. If setup used more of the
 * allowance, the frozen question remains local for a successor owner instead
 * of publishing a window this process cannot observe completely.
 */
export const QUESTION_SUBMISSION_COMPLETION_HEADROOM_SECONDS = 10 * 60

/**
 * The longest one Stop owner may live from process start.
 *
 * The service can accept an answer for up to 72 hours. Starting this budget
 * before submission is deliberate: the startup allowance above ensures that
 * even the maximum reply window still ends before the owner does.
 */
export const QUESTION_WAITER_CEILING_SECONDS =
  REPLY_MAX_WINDOW_SECONDS + QUESTION_WAITER_STARTUP_HEADROOM_SECONDS

/** Time for final fencing, diagnostics, stdout handoff, and clean process exit. */
export const QUESTION_STOP_TEARDOWN_HEADROOM_SECONDS = 60

/**
 * Declared harness timeout for every Stop handler that owns Question Routing.
 * It must outlive the runtime owner; otherwise the harness silently kills the
 * only process capable of continuing the exact Agent Session.
 */
export const QUESTION_STOP_TIMEOUT_SECONDS =
  QUESTION_WAITER_CEILING_SECONDS + QUESTION_STOP_TEARDOWN_HEADROOM_SECONDS

/**
 * Short Stop budget for harnesses that cannot own asynchronous Question
 * Routing. They retire/refuse promptly and never wait through an answer window.
 */
export const NON_ROUTING_STOP_TIMEOUT_SECONDS = 540

/**
 * Pre-PID claim files came only from the former eight-minute owner. Retain that
 * recovery bound instead of making a corrupt legacy file block for 72 hours.
 */
export const LEGACY_QUESTION_CLAIM_TTL_SECONDS = 480
