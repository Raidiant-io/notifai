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
 *     retain its own full-window lifetime: Claude does not enforce `timeout`
 *     after an ordinary async hook backgrounds. A short configured timeout
 *     alone therefore cannot prove that this route will lose its waiter.
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
      if (handler.asyncRewake === true) {
        problems.push(
          `${installation.file} enables \`asyncRewake\`, but the Claude Code inbox route requires ordinary \`async: true\`; reinstall the Claude Code hooks`,
        )
      }
      if (handler.async !== true) {
        problems.push(
          `${installation.file} declares a blocking Stop handler; the Claude Code wake route needs \`async: true\` so the turn ends while the waiter runs`,
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
