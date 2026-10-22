/* Claude Code and Cursor hooks that Grok runs (macOS and Linux).
 *
 * Grok loads the hooks in ~/.claude/settings.json and ~/.cursor/hooks.json
 * beside its own and keeps `args`, so a Notifai copy reaches here whole, as
 * `hook <event> ... --harness claude-code` (or `cursor`). Grok runs `async`
 * handlers in line, so a Claude Code `hook attend` copy would become a session
 * child and hold Grok's prompt for about 20 seconds waiting for a Claude Code
 * session that never comes.
 *
 * Notifai's native Grok hooks already serve the event. Each copy ends here,
 * silent, with exit 0, before the session child, the hub or the runtime, and
 * before anything is read from or written to Notifai's state.
 *
 * Grok's hook runner gives every hook process GROK_HOOK_EVENT and strips any
 * value a handler's own env declares for it. Claude Code and Cursor never set
 * it. Same rule as src/grok-imported-hook.ts. */

static int grok_imported_hook(int argc, char **argv) {
    const char *event = getenv("GROK_HOOK_EVENT");
    if (!event || !*event) return 0;
    char harness[32];
    return argc >= 3 && !strcmp(argv[1], "hook") &&
        harness_argument(argc, argv, harness, sizeof(harness)) &&
        (!strcmp(harness, "claude-code") || !strcmp(harness, "cursor"));
}
