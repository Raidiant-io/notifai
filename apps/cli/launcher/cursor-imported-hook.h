/* Claude Code hooks that Cursor runs (macOS and Linux).
 *
 * Cursor imports the hooks in ~/.claude/settings.json by default. Its importer
 * copies a handler's `command` and `timeout` only, so an exec-form Notifai
 * handler (`command` is this launcher, the hook in `args`) reaches here bare,
 * with no arguments, on every Claude event Cursor maps to its own. A
 * shell-form handler arrives whole, as `hook <event> ... --harness
 * claude-code`. Cursor imports these without a loop limit for Stop.
 *
 * Either is a copy: Notifai's native Cursor hooks already serve the event.
 * Both end here, silent, with exit 0, before the runtime starts and before
 * anything is read from or written to Notifai's state.
 *
 * Cursor gives every hook process CURSOR_VERSION and CURSOR_PROJECT_DIR (empty
 * when the editor has no folder open). Claude Code sets neither, and Cursor's
 * agent shells and terminals do not either. A bare run also needs input that
 * is not a terminal, so a person typing `notifai` gets the app as before. */

#define IMPORTED_HOOK_INPUT_WAIT_MS 500
#define IMPORTED_HOOK_INPUT_MAX 4000000

static int cursor_hook_environment(void) {
    const char *version = getenv("CURSOR_VERSION");
    return getenv("CURSOR_PROJECT_DIR") != NULL || (version && *version);
}

static int cursor_imported_claude_hook(int argc, char **argv) {
    if (!cursor_hook_environment()) return 0;
    if (argc == 1) return !isatty(0);
    char harness[32];
    return argc >= 3 && !strcmp(argv[1], "hook") &&
        harness_argument(argc, argv, harness, sizeof(harness)) && !strcmp(harness, "claude-code");
}

/* Take the hook input Cursor or Grok writes to a copy, so a writer never
 * meets a closed pipe, within a short bound: input that does not end in time
 * is left behind. */
static void imported_hook_discard_input(void) {
    if (isatty(0)) return;
    long long deadline = (long long)(monotonic_ns() / 1000000ULL) + IMPORTED_HOOK_INPUT_WAIT_MS;
    size_t total = 0;
    char chunk[65536];
    while (total < IMPORTED_HOOK_INPUT_MAX) {
        long long left = deadline - (long long)(monotonic_ns() / 1000000ULL);
        if (left <= 0) return;
        struct pollfd wait = { 0, POLLIN, 0 };
        int ready = poll(&wait, 1, (int)left);
        if (ready < 0 && errno == EINTR) continue;
        if (ready != 1) return;
        ssize_t got = read(0, chunk, sizeof(chunk));
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) return;
        total += (size_t)got;
    }
}
