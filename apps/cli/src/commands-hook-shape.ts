import {
  BLOCKING_STOP_TIMEOUT_SECONDS,
  CLAUDE_ASYNC_STOP_TIMEOUT_SECONDS,
  handlerEvent,
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
 *   - Codex owns its Stop timeout. Declaring one changes the definition it
 *     hashes into `trusted_hash`, and an untrusted handler is simply not run.
 *   - Everything else blocks its turn and needs a ceiling above the wait.
 */
export function stopShapeProblems(
  installation: Installation,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (installation.harness === 'codex') return []
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
      if (handler.timeout === undefined || handler.timeout < CLAUDE_ASYNC_STOP_TIMEOUT_SECONDS) {
        problems.push(
          `${installation.file} gives Stop ${handler.timeout ?? 'no'} declared seconds; Claude Code then kills the backgrounded waiter at its 600s default without reporting anything, so it needs an explicit ${CLAUDE_ASYNC_STOP_TIMEOUT_SECONDS}s`,
        )
      }
      continue
    }
    if (handler.timeout === undefined || handler.timeout < BLOCKING_STOP_TIMEOUT_SECONDS) {
      problems.push(
        `${installation.file} gives Stop ${handler.timeout ?? 'no'}s, but the blocking answer owner requires ${BLOCKING_STOP_TIMEOUT_SECONDS}s`,
      )
    }
  }
  return problems
}
