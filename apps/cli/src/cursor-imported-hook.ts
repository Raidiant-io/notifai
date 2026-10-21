/**
 * Claude Code hooks that Cursor runs.
 *
 * Cursor imports the hooks in `~/.claude/settings.json` by default. Its
 * importer keeps a handler's `command` and `timeout` and nothing else, so an
 * exec-form Notifai handler (`command` is the executable, the hook is in
 * `args`) runs as a bare `notifai` on every Claude event Cursor maps to its
 * own. A shell-form handler arrives whole, as `hook <event> ... --harness
 * claude-code`, and Cursor imports it without a loop limit for Stop.
 *
 * Neither form can be written so that Cursor skips it: the importer takes any
 * handler that has a `command`, and its de-duplication compares that string
 * only. Notifai's native Cursor hooks already serve every such event, so each
 * copy ends silently with exit 0. On macOS and Linux the native launcher ends
 * them before the runtime starts (`launcher/cursor-imported-hook.h`, which
 * applies this same rule); this module covers every other entry.
 *
 * No imports: `main.ts` checks this before it loads the CLI.
 */

/**
 * Cursor gives every hook process `CURSOR_VERSION` and `CURSOR_PROJECT_DIR`
 * (empty when the editor has no folder open). Claude Code sets neither, and
 * neither do Cursor's agent shells or terminals.
 */
export function cursorHookEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env['CURSOR_PROJECT_DIR'] !== undefined || (env['CURSOR_VERSION'] ?? '') !== ''
}

/**
 * A bare `notifai` run as a Cursor hook. Input that is a terminal means a
 * person, who gets the interactive app as before.
 */
export function cursorBareHookRun(args: readonly string[], env: NodeJS.ProcessEnv, stdinIsTerminal: boolean): boolean {
  return args.length === 0 && !stdinIsTerminal && cursorHookEnvironment(env)
}
