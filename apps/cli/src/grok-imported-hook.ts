/**
 * Claude Code and Cursor hooks that Grok runs.
 *
 * Grok loads the hooks in `~/.claude/settings.json` and `~/.cursor/hooks.json`
 * by default, beside its own, and runs every handler it finds there. It keeps
 * `args`, so a Notifai copy arrives whole, as `hook <event> ... --harness
 * claude-code` (or `cursor`). Grok also runs `async` handlers in line, so a
 * Claude Code `hook attend` copy held each prompt and turn end for about 20
 * seconds while it waited for a Claude Code session that never comes.
 *
 * Neither file can be written so that Grok skips it without changing what
 * Claude Code or Cursor reads: Grok's only opt-out is the User's own
 * `[compat.<vendor>] hooks` setting, which also drops every other tool's
 * hooks. Notifai's native Grok hooks already serve every event, so each copy
 * ends silently with exit 0. On macOS and Linux the native launcher ends them
 * before the runtime starts (`launcher/grok-imported-hook.h`, which applies
 * this same rule); `main.ts` covers every other entry before the CLI loads.
 *
 * No imports: `main.ts` checks this before it loads the CLI.
 */

/**
 * Grok's hook runner gives every hook process `GROK_HOOK_EVENT` and strips any
 * value a handler's own `env` declares for it. Claude Code and Cursor never
 * set it.
 */
export function grokHookEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (env['GROK_HOOK_EVENT'] ?? '') !== ''
}

/** The harnesses whose Notifai hooks Grok imports. */
const IMPORTED_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'cursor'])

/** A `hook <event> ... --harness claude-code|cursor` run by Grok's hook runner. */
export function grokImportedHookRun(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (!grokHookEnvironment(env) || args[0] !== 'hook' || args.length < 2) return false
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!
    const value = arg === '--harness' ? args[i + 1] : arg.startsWith('--harness=') ? arg.slice('--harness='.length) : undefined
    if (value !== undefined) return IMPORTED_HARNESSES.has(value)
  }
  return false
}
