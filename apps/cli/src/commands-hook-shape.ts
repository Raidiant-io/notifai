import {
  NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
  handlerEvent,
  QUESTION_STOP_TIMEOUT_SECONDS,
  stopHandlerIsDetached,
  type Installation,
} from './install-hooks.js'

/**
 * Whether an installed Stop handler declares the shape its harness needs.
 *
 * The three answers differ, and getting one wrong fails silently in a
 * different way each time:
 *
 *   - Claude Code's handler must be `async: true`, or the waiter holds the
 *     user's turn for its whole wait instead of returning at once. It must
 *     also declare a `timeout`, because the harness default is 600 s and the
 *     kill is silent — the backgrounded waiter vanishes and the answer the
 *     user already gave is never delivered.
 *   - Codex must declare the same full-window timeout. That changes its trusted
 *     definition and deliberately requires the User to approve it once.
 *   - Everything else cannot own asynchronous Question Routing; it receives
 *     only the shorter bounded cleanup/refusal timeout.
 */
export function stopShapeProblems(
  installation: Installation,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const problems: string[] = []
  for (const handler of installation.handlers.filter(
    (entry) => handlerEvent(entry.command) === 'stop',
  )) {
    if (stopHandlerIsDetached(installation.harness, platform)) {
      if (handler.async !== true) {
        problems.push(
          `${installation.file} declares a blocking Stop handler; the Claude Code wake route needs \`async: true\` so the turn ends while the waiter runs`,
        )
      }
      if (handler.timeout === undefined || handler.timeout < QUESTION_STOP_TIMEOUT_SECONDS) {
        problems.push(
          `${installation.file} gives Stop ${handler.timeout ?? 'no'} declared seconds; Claude Code then kills the backgrounded waiter silently before the complete answer window, so it needs an explicit ${QUESTION_STOP_TIMEOUT_SECONDS}s`,
        )
      }
      continue
    }
    if (installation.harness === 'codex' || installation.harness === 'claude-code') {
      if (handler.async === true) {
        problems.push(
          `${installation.file} declares an asynchronous ${installation.harness} Stop handler, but this platform needs the blocking continuation so the harness consumes the answer output`,
        )
      }
      if (handler.timeout === undefined || handler.timeout < QUESTION_STOP_TIMEOUT_SECONDS) {
        problems.push(
          `${installation.file} gives Stop ${handler.timeout ?? 'no'}s, but ${installation.harness} Question Routing requires ${QUESTION_STOP_TIMEOUT_SECONDS}s to own the complete answer window`,
        )
      }
      continue
    }
    if (
      handler.timeout === undefined ||
      handler.timeout < NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS
    ) {
      problems.push(
        `${installation.file} gives Stop ${handler.timeout ?? 'no'}s, but the non-routing blocking handler requires ${NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS}s`,
      )
    }
  }
  return problems
}
