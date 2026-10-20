/* The native hook entry (macOS and Linux).
 *
 * A generated Claude Code or Codex hook runs the stable launcher with
 * `hook <event> --owner notifai --harness <h> [--integration-revision <r>]`.
 * For the frequent events the launcher first offers the invocation to the
 * running per-user hub, which runs the same hook handler in-process and hands
 * back its output; no runtime starts. See `src/hub-ingress.ts`.
 *
 * The hub may decline (`fallback`) before it does anything, and the launcher
 * then starts the runtime exactly as before, with the hook input it already
 * read replayed on the runtime's stdin. No hub, a slow hub, another active
 * build or any doubt all end the same way. Once the launcher has said `go`,
 * the hub owns the hook and its output.
 *
 * Nothing secret is sent: the hook's own environment without Claude's
 * per-session inbox token, to a socket in a directory only this user can
 * enter, whose peer the kernel confirms is this user. */

#define INGRESS_MAX_STDIN 1000000
/* As the runtime: input that has not ended within this is read by the runtime itself. */
#define INGRESS_STDIN_WAIT_MS 2000
/* How long a reachable hub has to accept or decline before the runtime starts
 * instead. A hub that is up but busy (many sessions' hooks at once) answers
 * within a few hundred milliseconds; starting runtimes beside it only slows it
 * further. Inside every served hook's budget (5 s at least) with room to spare. */
#define INGRESS_ANSWER_WAIT_MS 3000
#define INGRESS_SERVED 1
#define INGRESS_FALLBACK 0

typedef struct { char *data; size_t length; int ended; } ingress_input;

static int ingress_event_served(const char *harness, const char *event) {
    static const char *claude[] = { "session-start", "subagent-start", "user-prompt-submit", "stop", NULL };
    static const char *codex[] = { "session-start", "subagent-start", "user-prompt-submit", "stop", "post-tool-use", NULL };
    const char **events = !strcmp(harness, "claude-code") ? claude : !strcmp(harness, "codex") ? codex : NULL;
    for (int i = 0; events && events[i]; i++) if (!strcmp(events[i], event)) return 1;
    return 0;
}

/* `hook <event>` followed only by the options a generated hook carries, for a
 * harness and event the hub serves. */
static int ingress_requested(int argc, char **argv) {
    if (argc < 3 || strcmp(argv[1], "hook") || argv[2][0] == '-') return 0;
    const char *harness = NULL;
    for (int i = 3; i < argc; i++) {
        const char *arg = argv[i], *value;
        const char *equals = !strncmp(arg, "--", 2) ? strchr(arg, '=') : NULL;
        size_t name = equals ? (size_t)(equals - arg) : strlen(arg);
        if (!((name == 7 && !strncmp(arg, "--owner", 7)) || (name == 9 && !strncmp(arg, "--harness", 9)) ||
              (name == 22 && !strncmp(arg, "--integration-revision", 22)))) return 0;
        if (equals) value = equals + 1;
        else if (i + 1 < argc) value = argv[++i];
        else return 0;
        if (name == 9) harness = value;
    }
    return harness && ingress_event_served(harness, argv[2]);
}

static int ingress_input_ready(int fd, long long deadline_ms) {
    long long left = deadline_ms - (long long)(monotonic_ns() / 1000000ULL);
    if (left <= 0) return 0;
    struct pollfd wait = { fd, POLLIN, 0 };
    int n = poll(&wait, 1, (int)left);
    return n == 1;
}

/* The hook input, to its end, within the runtime's own bounds. A TTY, more
 * than the runtime would take, or input still open after the wait leaves the
 * reading to the runtime (`ended` stays 0). */
static int ingress_read_input(ingress_input *input) {
    memset(input, 0, sizeof(*input));
    if (isatty(0)) return 0;
    size_t capacity = 65536;
    input->data = malloc(capacity);
    if (!input->data) return 0;
    long long deadline = (long long)(monotonic_ns() / 1000000ULL) + INGRESS_STDIN_WAIT_MS;
    for (;;) {
        if (!ingress_input_ready(0, deadline)) return 1;
        if (input->length == capacity) {
            if (capacity > INGRESS_MAX_STDIN) return 1;
            char *grown = realloc(input->data, capacity * 2);
            if (!grown) return 1;
            input->data = grown;
            capacity *= 2;
        }
        ssize_t got = read(0, input->data + input->length, capacity - input->length);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0) return 1;
        if (got == 0) { input->ended = input->length <= INGRESS_MAX_STDIN; return 1; }
        input->length += (size_t)got;
    }
}

static void jb_base64(jbuf *b, const unsigned char *data, size_t length) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char quad[4];
    for (size_t i = 0; i < length; i += 3) {
        unsigned v = (unsigned)data[i] << 16;
        if (i + 1 < length) v |= (unsigned)data[i + 1] << 8;
        if (i + 2 < length) v |= data[i + 2];
        quad[0] = alphabet[(v >> 18) & 63];
        quad[1] = alphabet[(v >> 12) & 63];
        quad[2] = i + 1 < length ? alphabet[(v >> 6) & 63] : '=';
        quad[3] = i + 2 < length ? alphabet[v & 63] : '=';
        jb_raw(b, quad, 4);
    }
}

/* The hub's socket, as `hubSocketPath` and the session child name it, but
 * never created here: only a directory this user owns and alone can enter. */
static int ingress_socket_path(char *out, size_t size) {
    char state[PATH_MAX], run[PATH_MAX];
    if (!state_directory(state, sizeof(state)) || snprintf(run, sizeof(run), "%s/run", state) >= (int)sizeof(run) ||
        snprintf(out, size, "%s/hub.sock", run) >= (int)size) return 0;
    char directory[PATH_MAX];
    if (strlen(out) < CHILD_SOCKET_PATH_LIMIT) snprintf(directory, sizeof(directory), "%s", run);
    else {
        snprintf(directory, sizeof(directory), "/tmp/notifai-%ld", (long)getuid());
        if (snprintf(out, size, "%s/%016llx.sock", directory, fnv64(state)) >= (int)size) return 0;
    }
    struct stat info;
    return !lstat(directory, &info) && S_ISDIR(info.st_mode) && info.st_uid == getuid() && !(info.st_mode & 077);
}

static int ingress_peer_is_user(int fd) {
#ifdef __APPLE__
    uid_t uid;
    gid_t gid;
    return !getpeereid(fd, &uid, &gid) && uid == getuid();
#else
    struct notifai_peer_credentials credentials;
    socklen_t length = sizeof(credentials);
    return !getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) && credentials.uid == getuid();
#endif
}

/* The request: argv, directory, environment (as the runtime would see it, less
 * Claude's inbox token), the input, and the build this launcher selected. */
static int ingress_request(jbuf *b, int argc, char **argv, const char *runtime, const ingress_input *input) {
    char root[PATH_MAX], build[65], cwd[PATH_MAX];
    /* runtime: <root>/versions/<build>/notifai-runtime */
    if (snprintf(root, sizeof(root), "%s", runtime) >= (int)sizeof(root)) return 0;
    char *slash = strrchr(root, '/');
    if (!slash) return 0;
    *slash = 0;
    slash = strrchr(root, '/');
    if (!slash || strlen(slash + 1) != 64) return 0;
    memcpy(build, slash + 1, 65);
    *slash = 0;
    slash = strrchr(root, '/');
    if (!slash || strcmp(slash + 1, "versions")) return 0;
    *slash = 0;
    if (!getcwd(cwd, sizeof(cwd)) || cwd[0] != '/') return 0;
    jb_text(b, "{");
    jb_field(b, "type", "hook");
    jb_raw(b, ",\"args\":[", 9);
    for (int i = 1; i < argc; i++) {
        if (i > 1) jb_raw(b, ",", 1);
        jb_string(b, argv[i]);
    }
    jb_raw(b, "]", 1);
    jb_field(b, "build", build);
    jb_field(b, "root", root);
    jb_field(b, "cwd", cwd);
    jbuf environment = {0};
    for (char **entry = environ; *entry; entry++) {
        if (!strncmp(*entry, "CLAUDE_CODE_MESSAGING_TOKEN=", 28) || !strncmp(*entry, "NOTIFAI_HOOK_SOURCE_PID=", 24) ||
            !strncmp(*entry, "BUN_", 4) || !strncmp(*entry, "JSC_", 4) || !strncmp(*entry, "DYLD_", 5) ||
            !strncmp(*entry, "LD_PRELOAD=", 11) || !strncmp(*entry, "LD_LIBRARY_PATH=", 16)) continue;
        jb_raw(&environment, *entry, strlen(*entry) + 1);
    }
    /* The harness that ran this hook, exactly as the runtime is told it. */
    char source[64];
    int n = snprintf(source, sizeof(source), "NOTIFAI_HOOK_SOURCE_PID=%ld", (long)getppid());
    jb_raw(&environment, source, (size_t)n + 1);
    if (environment.failed) { free(environment.data); return 0; }
    jb_raw(b, ",\"env_b64\":\"", 12);
    jb_base64(b, (const unsigned char *)environment.data, environment.length);
    free(environment.data);
    jb_raw(b, "\",\"stdin_b64\":\"", 15);
    jb_base64(b, (const unsigned char *)input->data, input->length);
    jb_text(b, "\"}");
    return !b->failed;
}

/* One frame from the hub within `wait_ms` (-1: no bound). 1 with the frame in
 * `frame`, 0 on timeout, -1 on close or error. */
static int ingress_frame(int fd, char *buffer, size_t *buffered, char **frame, size_t *length, int wait_ms) {
    long long deadline = wait_ms < 0 ? -1 : (long long)(monotonic_ns() / 1000000ULL) + wait_ms;
    for (;;) {
        if (*buffered >= 4) {
            unsigned char *h = (unsigned char *)buffer;
            size_t size = ((size_t)h[0] << 24) | ((size_t)h[1] << 16) | ((size_t)h[2] << 8) | h[3];
            if (size > CHILD_MAX_FRAME) return -1;
            if (*buffered >= size + 4) {
                *frame = malloc(size + 1);
                if (!*frame) return -1;
                memcpy(*frame, buffer + 4, size);
                (*frame)[size] = 0;
                memmove(buffer, buffer + 4 + size, *buffered - 4 - size);
                *buffered -= 4 + size;
                *length = size;
                return 1;
            }
        }
        if (deadline >= 0 && !ingress_input_ready(fd, deadline)) return 0;
        ssize_t n = read(fd, buffer + *buffered, CHILD_MAX_FRAME + 4 - *buffered);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        *buffered += (size_t)n;
    }
}

static int ingress_exchange(int fd, int argc, char **argv, const char *runtime, const ingress_input *input, int *code);

/* Offer the hook to the hub. INGRESS_SERVED with the hook's exit status in
 * `code`, or INGRESS_FALLBACK when the runtime must run it (nothing was done
 * on its behalf, or the hub went away before it printed anything). */
static int hook_ingress(int argc, char **argv, const char *runtime, const ingress_input *input, int *code) {
    char socket_path[PATH_MAX];
    if (!input->ended || !ingress_socket_path(socket_path, sizeof(socket_path))) return INGRESS_FALLBACK;
    int fd = connect_unix(socket_path, 200);
    if (fd < 0) return INGRESS_FALLBACK;
    if (!ingress_peer_is_user(fd)) { close(fd); return INGRESS_FALLBACK; }
    /* A gone hub must not kill the hook; the runtime gets the disposition back. */
    void (*pipe_disposition)(int) = signal(SIGPIPE, SIG_IGN);
    int outcome = ingress_exchange(fd, argc, argv, runtime, input, code);
    signal(SIGPIPE, pipe_disposition);
    close(fd);
    return outcome;
}

static int ingress_exchange(int fd, int argc, char **argv, const char *runtime, const ingress_input *input, int *code) {
    jbuf hello = {0}, request = {0};
    jb_text(&hello, "{");
    jb_field(&hello, "type", "hello");
    jb_number(&hello, "ipc_version", CHILD_IPC_VERSION);
    jb_field(&hello, "role", "ingress");
    jb_number(&hello, "pid", getpid());
    jb_text(&hello, "}");
    /* One frame each way, within the hub's frame limit: a larger input (a big
     * tool result) is read by the runtime. */
    int sent = !hello.failed && ingress_request(&request, argc, argv, runtime, input) && request.length <= CHILD_MAX_FRAME &&
        send_frame(fd, hello.data) && send_frame(fd, request.data);
    free(hello.data);
    free(request.data);
    if (!sent) return INGRESS_FALLBACK;
    static char buffer[CHILD_MAX_FRAME + 8], text[CHILD_MAX_FRAME];
    static unsigned char bytes[CHILD_MAX_FRAME];
    size_t buffered = 0;
    int committed = 0, wrote = 0;
    for (;;) {
        char *frame = NULL, type[32];
        size_t length = 0;
        int got = ingress_frame(fd, buffer, &buffered, &frame, &length, committed ? -1 : INGRESS_ANSWER_WAIT_MS);
        if (got <= 0) {
            /* No answer in time, or the hub went away: the runtime runs it,
             * unless the hub already printed part of the hook's output. */
            if (wrote) { *code = 0; return INGRESS_SERVED; }
            return INGRESS_FALLBACK;
        }
        int ok = json_field(frame, length, "type", type, sizeof(type)) == 1;
        if (ok && !strcmp(type, "accepted") && !committed) {
            /* From here the hub runs the hook; this launcher only relays. */
            ok = send_frame(fd, "{\"type\":\"go\"}");
            committed = ok;
        } else if (ok && !strcmp(type, "out") && committed) {
            char fd_text[8];
            size_t count = 0;
            int target = json_field(frame, length, "fd", fd_text, sizeof(fd_text)) == 2 && !strcmp(fd_text, "2") ? 2 : 1;
            ok = json_field(frame, length, "data_b64", text, sizeof(text)) == 1 && base64_decode(text, bytes, sizeof(bytes), &count);
            if (ok) { write_all(target, bytes, count); wrote = 1; }
        } else if (ok && !strcmp(type, "exit") && committed) {
            char value[16];
            *code = json_field(frame, length, "code", value, sizeof(value)) == 2 ? (int)strtol(value, NULL, 10) : 0;
            free(frame);
            return INGRESS_SERVED;
        } else ok = 0;
        free(frame);
        if (!ok) {
            /* A refusal, or anything unexpected before the hub committed. */
            if (wrote) { *code = 0; return INGRESS_SERVED; }
            return INGRESS_FALLBACK;
        }
    }
}

/* The runtime reads the hook input the launcher already consumed: a pipe on
 * its stdin carries those bytes and then whatever is still to come. A small,
 * complete input fits the pipe at once; otherwise a detached feeder writes it,
 * holding nothing of the hook's but stdin. */
static int ingress_replay_input(ingress_input *input) {
    if (!input->data) return 1; /* Nothing was read (a TTY): the runtime reads stdin itself. */
    int pipes[2];
    if (pipe(pipes)) return 0;
    if (input->ended && input->length <= 16384) {
        int ok = write_all(pipes[1], input->data, input->length);
        close(pipes[1]);
        if (!ok || dup2(pipes[0], 0) < 0) { close(pipes[0]); return 0; }
        close(pipes[0]);
        return 1;
    }
    pid_t first = fork();
    if (first < 0) { close(pipes[0]); close(pipes[1]); return 0; }
    if (first == 0) {
        pid_t feeder = fork();
        if (feeder != 0) _exit(feeder < 0);
        signal(SIGPIPE, SIG_IGN);
        close(pipes[0]);
        int null = open("/dev/null", O_RDWR);
        if (null >= 0) { dup2(null, 1); dup2(null, 2); if (null > 2) close(null); }
        int ok = write_all(pipes[1], input->data, input->length);
        if (!input->ended) {
            char chunk[65536];
            for (;;) {
                ssize_t n = read(0, chunk, sizeof(chunk));
                if (n < 0 && errno == EINTR) continue;
                if (n <= 0 || !ok) break;
                ok = write_all(pipes[1], chunk, (size_t)n);
            }
        }
        _exit(ok ? 0 : 1);
    }
    int status = 1;
    waitpid(first, &status, 0);
    close(pipes[1]);
    int ok = WIFEXITED(status) && WEXITSTATUS(status) == 0 && dup2(pipes[0], 0) >= 0;
    close(pipes[0]);
    return ok;
}
