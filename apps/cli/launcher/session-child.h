/* The POSIX session child: one tiny native process per Agent Session.
 *
 * `hook attend --harness claude-code|codex` runs here instead of the runtime.
 * The process stays the harness's own child for the life of the session:
 * - it identifies the harness (its parent, or its grandparent through a shell
 *   that did not exec), checked against Claude's session descriptor;
 * - it learns of the harness's exit from the kernel (kqueue / pidfd), with no
 *   timer while the hub is reachable;
 * - it registers with the shared per-user hub over a Unix socket in a 0700
 *   directory, starting the hub when nothing answers;
 * - it writes content-free wakes into Claude's inbox when the hub asks, opening
 *   the connection with Claude's per-session token.
 * It holds no Notifai credential and opens no network connection. */
#include <poll.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/event.h>
#include <sys/sysctl.h>
#else
#include <sys/signalfd.h>
#include <sys/syscall.h>
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SO_PEERCRED
#define SO_PEERCRED 17
#endif
/* `struct ucred` and `syscall` need _GNU_SOURCE; the launcher builds with POSIX feature macros. */
long syscall(long number, ...);
struct notifai_peer_credentials { pid_t pid; uid_t uid; gid_t gid; };
#endif

#define CHILD_SOCKET_PATH_LIMIT 100

#include "session-child-common.h"

/* main.c: whether an uninstall has closed admission for this installation. */
static int uninstall_pending(const char *executable);

/* ---- identities ----------------------------------------------------------- */

typedef struct { pid_t pid, ppid; char comm[64]; long long start; char ticks[32]; } proc_record;

#ifndef __APPLE__
/* `btime` from /proc/stat, read whole: the interrupt line before it can run
 * far past any fixed buffer on a large host. */
static long long linux_boot_seconds(void) {
    int fd = open("/proc/stat", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    size_t capacity = 65536, n = 0;
    char *text = malloc(capacity + 1);
    long long result = -1;
    while (text) {
        if (n == capacity) {
            if (capacity >= 16 * 1024 * 1024) break;
            char *grown = realloc(text, capacity * 2 + 1);
            if (!grown) break;
            text = grown;
            capacity *= 2;
        }
        ssize_t got = read(fd, text + n, capacity - n);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) {
            text[n] = 0;
            char *btime = strstr(text, "\nbtime ");
            if (btime) result = strtoll(btime + 7, NULL, 10);
            break;
        }
        n += (size_t)got;
    }
    free(text);
    close(fd);
    return result;
}
#endif

/* The kernel's record of one process: parent, short name, start in epoch
 * seconds (what `ps -o lstart` shows, and Claude's macOS descriptor) and, on
 * Linux, the raw start in clock ticks since boot (field 22 of
 * /proc/<pid>/stat, which is what Claude's Linux descriptor carries and which
 * no clock step moves). */
static int proc_lookup(pid_t pid, proc_record *out) {
    memset(out, 0, sizeof(*out));
    if (pid <= 0) return 0;
#ifdef __APPLE__
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, PROC_PIDTBSDINFO_SIZE) != PROC_PIDTBSDINFO_SIZE) return 0;
    out->pid = pid;
    out->ppid = (pid_t)info.pbi_ppid;
    out->start = (long long)info.pbi_start_tvsec;
    snprintf(out->comm, sizeof(out->comm), "%s", info.pbi_name[0] ? info.pbi_name : info.pbi_comm);
    return 1;
#else
    char path[64], text[4096];
    snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    ssize_t n = read(fd, text, sizeof(text) - 1);
    close(fd);
    if (n <= 0) return 0;
    text[n] = 0;
    char *open_paren = strchr(text, '('), *close_paren = strrchr(text, ')');
    if (!open_paren || !close_paren || close_paren < open_paren) return 0;
    size_t name = (size_t)(close_paren - open_paren - 1);
    if (name >= sizeof(out->comm)) name = sizeof(out->comm) - 1;
    memcpy(out->comm, open_paren + 1, name);
    out->comm[name] = 0;
    /* Fields after the name start at field 3 (state). */
    char *cursor = close_paren + 2;
    unsigned long long starttime = 0;
    long ppid = 0;
    int seen = 0;
    for (int field = 3; field <= 22 && *cursor; field++) {
        char *end;
        if (field == 4) ppid = strtol(cursor, &end, 10);
        else if (field == 22) { starttime = strtoull(cursor, &end, 10); seen = 1; }
        end = strchr(cursor, ' ');
        if (!end) { if (field != 22) return 0; break; }
        cursor = end + 1;
    }
    long long boot = linux_boot_seconds();
    long ticks = sysconf(_SC_CLK_TCK);
    if (!seen || boot < 0 || ticks <= 0) return 0;
    out->pid = pid;
    out->ppid = (pid_t)ppid;
    out->start = boot + (long long)(starttime / (unsigned long long)ticks);
    snprintf(out->ticks, sizeof(out->ticks), "%llu", starttime);
    return 1;
#endif
}

/* `ps -o lstart=` under TZ=UTC and the C locale: how Claude writes procStart. */
static void format_start(long long seconds, char *out, size_t size) {
    time_t value = (time_t)seconds;
    struct tm utc;
    if (!gmtime_r(&value, &utc) || !strftime(out, size, "%a %b %e %H:%M:%S %Y", &utc)) { out[0] = 0; return; }
}

/* Whitespace collapsed, as `normalizeProcessStart` compares. */
static void normalize_spaces(char *text) {
    char *write = text;
    int space = 0;
    for (char *read = text; *read; read++) {
        if (isspace((unsigned char)*read)) { space = write != text; continue; }
        if (space) *write++ = ' ';
        space = 0;
        *write++ = *read;
    }
    *write = 0;
}

static void boot_identity(char *out, size_t size) {
    out[0] = 0;
#ifdef __APPLE__
    /* A boot's own UUID: `kern.boottime` moves when the calendar clock is set. */
    char uuid[64] = {0};
    size_t length = sizeof(uuid) - 1;
    if (!sysctlbyname("kern.bootsessionuuid", uuid, &length, NULL, 0) && uuid[0]) snprintf(out, size, "darwin:%s", uuid);
#else
    int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return;
    char id[64] = {0};
    ssize_t n = read(fd, id, sizeof(id) - 1);
    close(fd);
    if (n <= 0) return;
    id[n] = 0;
    id[strcspn(id, "\r\n")] = 0;
    snprintf(out, size, "linux:%s", id);
#endif
}

static unsigned long long monotonic_ns(void) {
#ifdef __APPLE__
    /* The clock `systemMonotonicNs` reads in the native runtime. */
    return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
#else
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (unsigned long long)now.tv_sec * 1000000000ULL + (unsigned long long)now.tv_nsec;
#endif
}

static long long wall_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int is_shell(const char *comm) {
    static const char *shells[] = { "sh", "dash", "bash", "zsh", "ksh", "mksh", "fish", NULL };
    for (int i = 0; shells[i]; i++) if (!strcmp(comm, shells[i])) return 1;
    return 0;
}

static void home_directory(char *out, size_t size) {
    const char *home = getenv("HOME");
    if (home && *home) { snprintf(out, size, "%s", home); return; }
    struct passwd record, *found = NULL;
    char buffer[16384];
    if (!getpwuid_r(getuid(), &record, buffer, sizeof(buffer), &found) && found && record.pw_dir)
        snprintf(out, size, "%s", record.pw_dir);
    else out[0] = 0;
}

/* `stateDir` in config.ts: $XDG_STATE_HOME/notifai or ~/.local/state/notifai. */
static int state_directory(char *out, size_t size) {
    const char *xdg = getenv("XDG_STATE_HOME");
    if (xdg && *xdg) return snprintf(out, size, "%s/notifai", xdg) < (int)size;
    char home[PATH_MAX];
    home_directory(home, sizeof(home));
    if (!home[0]) return 0;
    return snprintf(out, size, "%s/.local/state/notifai", home) < (int)size;
}

/* A directory only this user can enter: created 0700, refused when another
 * user owns it or it is a link. */
static int private_directory(const char *path) {
    char partial[PATH_MAX];
    if (snprintf(partial, sizeof(partial), "%s", path) >= (int)sizeof(partial)) return 0;
    for (char *s = partial + 1; *s; s++) {
        if (*s != '/') continue;
        *s = 0;
        if (mkdir(partial, 0700) && errno != EEXIST) return 0;
        *s = '/';
    }
    if (mkdir(partial, 0700) && errno != EEXIST) return 0;
    struct stat info;
    if (lstat(path, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid()) return 0;
    if ((info.st_mode & 077) && chmod(path, 0700)) return 0;
    return 1;
}

/* `hubSocketPath` in hub-ipc.ts: the run directory, or a short per-user
 * fallback when that path is too long for a Unix socket. */
static int hub_paths(const char *state, char *run, size_t run_size, char *socket_path, size_t socket_size) {
    if (snprintf(run, run_size, "%s/run", state) >= (int)run_size || !private_directory(run)) return 0;
    if (snprintf(socket_path, socket_size, "%s/hub.sock", run) >= (int)socket_size) return 0;
    if (strlen(socket_path) < CHILD_SOCKET_PATH_LIMIT) return 1;
    char directory[64];
    snprintf(directory, sizeof(directory), "/tmp/notifai-%ld", (long)getuid());
    if (!private_directory(directory)) return 0;
    return snprintf(socket_path, socket_size, "%s/%016llx.sock", directory, fnv64(state)) < (int)socket_size;
}

static int write_all(int fd, const void *data, size_t length) {
    const char *p = data;
    while (length) {
        ssize_t n = write(fd, p, length);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return 0;
        p += n;
        length -= (size_t)n;
    }
    return 1;
}

static int send_frame(int fd, const char *json) {
    size_t length = strlen(json);
    unsigned char header[4] = { (unsigned char)(length >> 24), (unsigned char)(length >> 16),
                                (unsigned char)(length >> 8), (unsigned char)length };
    return write_all(fd, header, 4) && write_all(fd, json, length);
}

static int connect_unix(const char *path, int timeout_ms) {
    struct sockaddr_un address;
    if (strlen(path) >= sizeof(address.sun_path)) return -1;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, path, strlen(path));
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    int flags = fcntl(fd, F_GETFL);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address))) {
        if (errno != EINPROGRESS && errno != EAGAIN) { close(fd); return -1; }
        struct pollfd wait = { fd, POLLOUT, 0 };
        int error = 0;
        socklen_t length = sizeof(error);
        if (poll(&wait, 1, timeout_ms) != 1 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) || error) {
            close(fd);
            return -1;
        }
    }
    fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
    return fd;
}

/* ---- the child's own state ------------------------------------------------ */

typedef struct {
    char session[512], harness[16], event[64], source[64], cwd[PATH_MAX], transcript[PATH_MAX];
    char state[PATH_MAX], run[PATH_MAX], socket_path[PATH_MAX], self[PATH_MAX];
    char harness_start[64], harness_ticks[32], boot[128];
    char inbox_socket[PATH_MAX], token[1024];
    char writer_lock[PATH_MAX];
    pid_t harness_pid;
    int refusals;
    long long stamp_wall;
    unsigned long long stamp_mono;
    int hub, lock, writer;
} child_state;

static void child_end_record(child_state *child) {
    char directory[PATH_MAX], file[PATH_MAX], temporary[PATH_MAX];
    if (snprintf(directory, sizeof(directory), "%s/ended", child->run) >= (int)sizeof(directory) ||
        !private_directory(directory)) return;
    if (snprintf(file, sizeof(file), "%s/%016llx-%ld.json", directory, fnv64(child->session), (long)child->harness_pid) >= (int)sizeof(file) ||
        snprintf(temporary, sizeof(temporary), "%s.%ld.tmp", file, (long)getpid()) >= (int)sizeof(temporary)) return;
    jbuf record = {0};
    jb_text(&record, "{");
    jb_field(&record, "session_id", child->session);
    jb_field(&record, "harness", child->harness);
    jb_number(&record, "harness_pid", child->harness_pid);
    jb_field(&record, "harness_start", child->harness_start);
    jb_field(&record, "boot", child->boot);
    jb_field(&record, "reason", "harness-gone");
    jb_number(&record, "at", wall_ms());
    jb_text(&record, "}\n");
    if (record.failed) { free(record.data); return; }
    int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd >= 0) {
        int ok = write_all(fd, record.data, record.length) && !fsync(fd);
        close(fd);
        if (!ok || rename(temporary, file)) unlink(temporary);
    }
    free(record.data);
}

/* Start the hub detached: a new session, null stdio, a fresh environment with
 * nothing session-specific in it, and the launcher's own path so the hub runs
 * whatever build is active now. */
static void child_start_hub(child_state *child) {
    char lock_path[PATH_MAX];
    if (snprintf(lock_path, sizeof(lock_path), "%s/hub-start.lock", child->run) >= (int)sizeof(lock_path)) return;
    int lock = open(lock_path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (lock < 0) return;
    if (flock(lock, LOCK_EX | LOCK_NB)) { close(lock); return; }
    pid_t first = fork();
    if (first == 0) {
        if (setsid() < 0) _exit(1);
        pid_t second = fork();
        if (second != 0) _exit(second < 0);
        int null = open("/dev/null", O_RDWR);
        if (null >= 0) { dup2(null, 0); dup2(null, 1); dup2(null, 2); if (null > 2) close(null); }
        /* The child ignores or blocks its stop signals; the hub must not
         * inherit that (a blocked mask survives exec and Bun keeps it). */
        int stop_signals[] = { SIGTERM, SIGHUP, SIGINT, SIGPIPE };
        for (int i = 0; i < 4; i++) signal(stop_signals[i], SIG_DFL);
        sigset_t none;
        sigemptyset(&none);
        sigprocmask(SIG_SETMASK, &none, NULL);
        /* The start lock is close-on-exec: the parent child holds it until
         * this hub answers, so a racing child waits instead of starting another. */
        static const char *keep[] = { "HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR",
            "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS", NULL };
        char *environment[64];
        int count = 0;
        for (char **entry = environ; *entry && count < 60; entry++) {
            int wanted = !strncmp(*entry, "NOTIFAI_", 8) && strncmp(*entry, "NOTIFAI_HOOK_SOURCE_PID=", 24) &&
                strncmp(*entry, "NOTIFAI_NATIVE_", 15) && strncmp(*entry, "NOTIFAI_ACTIVE_", 15);
            wanted |= !strncmp(*entry, "LC_", 3);
            for (int i = 0; !wanted && keep[i]; i++) {
                size_t n = strlen(keep[i]);
                wanted = !strncmp(*entry, keep[i], n) && (*entry)[n] == '=';
            }
            if (wanted) environment[count++] = *entry;
        }
        environment[count] = NULL;
        char *arguments[] = { child->self, "hub", "--owner", "notifai", NULL };
        execve(child->self, arguments, environment);
        _exit(127);
    }
    if (first > 0) waitpid(first, NULL, 0);
    /* Hold the start lock until the hub answers (or five seconds pass), so a
     * sibling child waits for this hub instead of starting another. */
    for (int i = 0; i < 50; i++) {
        int fd = connect_unix(child->socket_path, 100);
        if (fd >= 0) { close(fd); break; }
        struct timespec pause = { 0, 100 * 1000000L };
        nanosleep(&pause, NULL);
    }
    flock(lock, LOCK_UN);
    close(lock);
}

static int child_register(child_state *child) {
    jbuf hello = {0};
    jb_text(&hello, "{");
    jb_field(&hello, "type", "hello");
    jb_number(&hello, "ipc_version", CHILD_IPC_VERSION);
    jb_field(&hello, "role", "child");
    jb_number(&hello, "pid", getpid());
    jb_text(&hello, "}");
    jbuf reg = {0};
    char mono[32];
    snprintf(mono, sizeof(mono), "%llu", child->stamp_mono);
    jb_text(&reg, "{");
    jb_field(&reg, "type", "register");
    jb_field(&reg, "session_id", child->session);
    jb_field(&reg, "harness", child->harness);
    jb_number(&reg, "harness_pid", child->harness_pid);
    jb_field(&reg, "harness_start", child->harness_start);
    if (child->harness_ticks[0]) jb_field(&reg, "harness_ticks", child->harness_ticks);
    jb_field(&reg, "boot", child->boot);
    jb_number(&reg, "stamp_wall", child->stamp_wall);
    jb_field(&reg, "stamp_mono", mono);
    jb_field(&reg, "hook_event", child->event);
    if (child->source[0]) jb_field(&reg, "source", child->source);
    if (child->cwd[0]) jb_field(&reg, "cwd", child->cwd);
    if (child->transcript[0]) jb_field(&reg, "transcript_path", child->transcript);
    if (child->inbox_socket[0]) jb_field(&reg, "inbox_socket", child->inbox_socket);
    jb_field(&reg, "inbox_token", child->token[0] ? "present" : "absent");
    const char *claude = getenv("CLAUDE_CONFIG_DIR"), *codex = getenv("CODEX_HOME");
    if (claude && claude[0] == '/') jb_field(&reg, "claude_config_dir", claude);
    /* Where the conversation runs. An Orca chat tab drives the harness itself;
     * an Orca terminal pane names its pane. */
    const char *orca = getenv("ORCA_STRUCTURED_SESSION"), *pane = getenv("ORCA_AGENT_PANE"), *handle = getenv("ORCA_TERMINAL_HANDLE");
    if (orca && !strcmp(orca, "1")) jb_field(&reg, "orca_structured", "1");
    if ((pane && pane[0]) || (handle && handle[0])) jb_field(&reg, "orca_pane", "1");
    if (!strcmp(child->harness, "claude-code")) {
        /* A terminal, the desktop app, a scripted run: always sent, empty
         * when Claude Code did not say. */
        const char *entrypoint = getenv("CLAUDE_CODE_ENTRYPOINT"), *kind = getenv("CLAUDE_CODE_SESSION_KIND");
        jb_field(&reg, "entrypoint", entrypoint && strlen(entrypoint) < 64 ? entrypoint : "");
        if (kind && kind[0] && strlen(kind) < 32) jb_field(&reg, "session_kind", kind);
    } else {
        /* T3 Code names itself as the originator of the app-server it starts. */
        const char *override = getenv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE");
        if (override && override[0] && strlen(override) < 64) jb_field(&reg, "originator_override", override);
    }
    if (codex && codex[0] == '/') jb_field(&reg, "codex_home", codex);
    jb_field(&reg, "launcher", child->self);
    jb_text(&reg, "}");
    int ok = !hello.failed && !reg.failed && send_frame(child->hub, hello.data) && send_frame(child->hub, reg.data);
    free(hello.data);
    free(reg.data);
    return ok;
}

static int child_connect(child_state *child, int start) {
    int fd = connect_unix(child->socket_path, 1000);
    if (fd < 0 && start) {
        child_start_hub(child);
        for (int attempt = 0, delay = 100; fd < 0 && attempt < 12; attempt++, delay = delay < 1000 ? delay * 2 : 1000) {
            fd = connect_unix(child->socket_path, 1000);
            if (fd >= 0) break;
            struct timespec pause = { delay / 1000, (long)(delay % 1000) * 1000000L };
            nanosleep(&pause, NULL);
        }
    }
    if (fd < 0) return 0;
    child->hub = fd;
    if (!child_register(child)) { close(fd); child->hub = -1; return 0; }
    return 1;
}

/* Claude's inbox: an optional auth line with the session's own token, then
 * the line the hub prepared. Never offered to any socket but the one Claude
 * exported with that token. */
static void child_write_inbox(child_state *child, const char *frame, size_t length) {
    /* Static: one write at a time, and two megabytes do not belong on the stack. */
    static char line_b64[CHILD_MAX_FRAME];
    static unsigned char line[CHILD_MAX_FRAME];
    char id[32] = "0", deadline_text[32] = "0", socket_b64[PATH_MAX * 2];
    unsigned char socket_raw[PATH_MAX];
    size_t line_length = 0, socket_length = 0;
    const char *stage = "before-write", *error = NULL;
    unsigned long long began = monotonic_ns();
    json_field(frame, length, "id", id, sizeof(id));
    json_field(frame, length, "deadline_ms", deadline_text, sizeof(deadline_text));
    long long deadline_ms = strtoll(deadline_text, NULL, 10);
    if (json_field(frame, length, "socket_b64", socket_b64, sizeof(socket_b64)) != 1 ||
        !base64_decode(socket_b64, socket_raw, sizeof(socket_raw) - 1, &socket_length) ||
        json_field(frame, length, "line_b64", line_b64, sizeof(line_b64)) != 1 ||
        !base64_decode(line_b64, line, sizeof(line), &line_length) || !line_length || line[line_length - 1] != '\n') {
        error = "malformed write request";
    }
    socket_raw[socket_length] = 0;
    if (!error && child->inbox_socket[0] && strcmp((char *)socket_raw, child->inbox_socket))
        error = "the descriptor names another inbox than the one Claude exported";
    int fd = -1;
    if (!error) {
        fd = connect_unix((char *)socket_raw, 5000);
        if (fd < 0) error = "the inbox socket refused the connection";
    }
    if (!error && deadline_ms > 0 && (long long)((monotonic_ns() - began) / 1000000ULL) >= deadline_ms)
        error = "the write deadline passed before the first byte";
    if (!error) {
        stage = "during-write";
        jbuf auth = {0};
        if (child->token[0] && child->inbox_socket[0]) {
            jb_text(&auth, "{");
            jb_field(&auth, "type", "auth");
            jb_field(&auth, "token", child->token);
            jb_text(&auth, "}\n");
        }
        int ok = !auth.failed && (!auth.length || write_all(fd, auth.data, auth.length)) && write_all(fd, line, line_length);
        free(auth.data);
        shutdown(fd, SHUT_WR);
        if (!ok) error = "the inbox write failed";
    }
    if (fd >= 0) close(fd);
    jbuf reply = {0};
    jb_text(&reply, "{");
    jb_field(&reply, "type", "written");
    jb_field(&reply, "id", id);
    jb_field(&reply, "result", error ? "failed" : "ok");
    if (error) { jb_field(&reply, "stage", stage); jb_field(&reply, "error", error); }
    jb_text(&reply, "}");
    if (!reply.failed && child->hub >= 0 && !send_frame(child->hub, reply.data)) { close(child->hub); child->hub = -1; }
    free(reply.data);
}

/* Frames from the hub. Returns 0 when the child should exit. */
static int child_handle(child_state *child, const char *frame, size_t length) {
    char type[32];
    if (json_field(frame, length, "type", type, sizeof(type)) != 1) return 1;
    if (!strcmp(type, "bye")) return 0;
    if (!strcmp(type, "refused")) {
        /* A passing refusal (the hub is exiting, its peer check timed out, an
         * older attendant still hands over): try again later. */
        char retry[8] = "";
        if (json_field(frame, length, "retry", retry, sizeof(retry)) == 2 && !strcmp(retry, "true")) {
            child->refusals++;
            return -1;
        }
        return 0;
    }
    if (!strcmp(type, "registered")) child->refusals = 0;
    if (!strcmp(type, "write")) child_write_inbox(child, frame, length);
    return 1;
}

static int harness_alive(child_state *child) {
    proc_record now;
    if (!proc_lookup(child->harness_pid, &now)) return 0;
    /* Ticks where the kernel has them: no clock step moves them. */
    if (child->harness_ticks[0]) return !strcmp(now.ticks, child->harness_ticks);
    char start[64];
    format_start(now.start, start, sizeof(start));
    normalize_spaces(start);
    return !strcmp(start, child->harness_start);
}

static void child_ended(child_state *child) {
    child_end_record(child);
    /* The harness is gone, so no later hook of it can want this lock. */
    if (child->writer_lock[0]) unlink(child->writer_lock);
    if (child->hub >= 0) {
        jbuf ended = {0};
        jb_text(&ended, "{");
        jb_field(&ended, "type", "ended");
        jb_field(&ended, "session_id", child->session);
        jb_number(&ended, "harness_pid", child->harness_pid);
        jb_field(&ended, "reason", "harness-gone");
        jb_text(&ended, "}");
        if (!ended.failed) send_frame(child->hub, ended.data);
        free(ended.data);
    }
}

/* Reads every complete frame now buffered; returns 0 on EOF or exit request. */
static int child_read(child_state *child, char *buffer, size_t *buffered) {
    ssize_t n = read(child->hub, buffer + *buffered, CHILD_MAX_FRAME + 4 - *buffered);
    if (n < 0 && errno == EINTR) return 1;
    if (n <= 0) return -1;
    *buffered += (size_t)n;
    for (;;) {
        if (*buffered < 4) return 1;
        unsigned char *h = (unsigned char *)buffer;
        size_t length = ((size_t)h[0] << 24) | ((size_t)h[1] << 16) | ((size_t)h[2] << 8) | h[3];
        if (length > CHILD_MAX_FRAME) return -1;
        if (*buffered < length + 4) return 1;
        char *frame = malloc(length + 1);
        if (!frame) return -1;
        memcpy(frame, buffer + 4, length);
        frame[length] = 0;
        memmove(buffer, buffer + 4 + length, *buffered - 4 - length);
        *buffered -= 4 + length;
        int keep = child_handle(child, frame, length);
        free(frame);
        if (keep <= 0) return keep;
    }
}

/* Identify the process hosting this session: the parent, or the grandparent
 * through a shell that did not exec. Claude is recognised by its own session
 * descriptor naming this session at that process's start; Codex by its name. */
static int claude_descriptor_matches(const char *session, const proc_record *candidate, char *socket, size_t socket_size) {
    char config[PATH_MAX], file[PATH_MAX], text[65536];
    const char *configured = getenv("CLAUDE_CONFIG_DIR");
    if (configured && configured[0] == '/') snprintf(config, sizeof(config), "%s", configured);
    else {
        char home[PATH_MAX];
        home_directory(home, sizeof(home));
        if (snprintf(config, sizeof(config), "%s/.claude", home) >= (int)sizeof(config)) return 0;
    }
    if (snprintf(file, sizeof(file), "%s/sessions/%ld.json", config, (long)candidate->pid) >= (int)sizeof(file)) return 0;
    int fd = open(file, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    ssize_t n = read(fd, text, sizeof(text) - 1);
    close(fd);
    if (n <= 0) return 0;
    char named[512], start[128], pid[32], expected[64];
    if (json_field(text, (size_t)n, "sessionId", named, sizeof(named)) != 1 ||
        json_field(text, (size_t)n, "procStart", start, sizeof(start)) != 1 ||
        json_field(text, (size_t)n, "pid", pid, sizeof(pid)) != 2) return 0;
    format_start(candidate->start, expected, sizeof(expected));
    normalize_spaces(expected);
    normalize_spaces(start);
    /* macOS: `ps -o lstart` text. Linux: the raw start ticks. */
    int same_start = !strcmp(start, expected) || (candidate->ticks[0] && !strcmp(start, candidate->ticks));
    if (strcmp(named, session) || strtol(pid, NULL, 10) != (long)candidate->pid || !same_start) return 0;
    if (socket && json_field(text, (size_t)n, "messagingSocketPath", socket, socket_size) != 1) socket[0] = 0;
    return 1;
}

/* The process `identify_harness` will name, read cheaply before anything
 * waits: the parent, or the grandparent through a shell that did not exec. */
static pid_t expected_harness(void) {
    proc_record parent, grandparent;
    if (!proc_lookup(getppid(), &parent)) return -1;
    if (is_shell(parent.comm)) return proc_lookup(parent.ppid, &grandparent) ? grandparent.pid : -1;
    return parent.pid;
}

static int identify_harness(child_state *child) {
    proc_record parent, grandparent;
    if (!proc_lookup(getppid(), &parent)) return 0;
    int through_shell = is_shell(parent.comm) && proc_lookup(parent.ppid, &grandparent);
    const proc_record *chosen = NULL;
    if (!strcmp(child->harness, "codex")) {
        if (!strcmp(parent.comm, "codex")) chosen = &parent;
        else if (through_shell && !strcmp(grandparent.comm, "codex")) chosen = &grandparent;
    } else {
        /* Claude can start its hooks before it publishes the descriptor. */
        char descriptor_socket[PATH_MAX];
        for (int attempt = 0; attempt < 80 && !chosen; attempt++) {
            if (claude_descriptor_matches(child->session, &parent, descriptor_socket, sizeof(descriptor_socket))) chosen = &parent;
            else if (through_shell && claude_descriptor_matches(child->session, &grandparent, descriptor_socket, sizeof(descriptor_socket)))
                chosen = &grandparent;
            if (!chosen) {
                struct timespec pause = { 0, 250 * 1000000L };
                nanosleep(&pause, NULL);
                if (getppid() != parent.pid) return 0;
            }
        }
    }
    if (!chosen) return 0;
    child->harness_pid = chosen->pid;
    snprintf(child->harness_ticks, sizeof(child->harness_ticks), "%s", chosen->ticks);
    format_start(chosen->start, child->harness_start, sizeof(child->harness_start));
    normalize_spaces(child->harness_start);
    return child->harness_start[0] != 0;
}

static int read_input(char **out, size_t *length) {
    size_t capacity = 65536, n = 0;
    char *data = malloc(capacity + 1);
    if (!data) return 0;
    struct pollfd input = { 0, POLLIN, 0 };
    for (;;) {
        if (poll(&input, 1, 10000) != 1) break;
        if (n == capacity) {
            if (capacity >= CHILD_MAX_INPUT) { free(data); return 0; }
            capacity *= 2;
            char *grown = realloc(data, capacity + 1);
            if (!grown) { free(data); return 0; }
            data = grown;
        }
        ssize_t got = read(0, data + n, capacity - n);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) break;
        n += (size_t)got;
    }
    data[n] = 0;
    *out = data;
    *length = n;
    return 1;
}

static int harness_argument(int argc, char **argv, char *out, size_t size) {
    for (int i = 3; i < argc; i++) {
        const char *value = NULL;
        if (!strcmp(argv[i], "--harness") && i + 1 < argc) value = argv[i + 1];
        else if (!strncmp(argv[i], "--harness=", 10)) value = argv[i] + 10;
        if (value) return snprintf(out, size, "%s", value) < (int)size;
    }
    return 0;
}

/* Whether this invocation is a session child at all. */
static int session_child_requested(int argc, char **argv) {
    char harness[32];
    return argc >= 3 && !strcmp(argv[1], "hook") && !strcmp(argv[2], "attend") &&
        harness_argument(argc, argv, harness, sizeof(harness)) &&
        (!strcmp(harness, "claude-code") || !strcmp(harness, "codex"));
}

/* An existing child for this exact harness process already serves the
 * session: tell the hub a turn boundary passed, then leave. */
static void child_hint(child_state *child) {
    int fd = connect_unix(child->socket_path, 500);
    if (fd < 0) return;
    jbuf hint = {0};
    jb_text(&hint, "{");
    jb_field(&hint, "type", "hello");
    jb_number(&hint, "ipc_version", CHILD_IPC_VERSION);
    jb_field(&hint, "role", "hint");
    jb_number(&hint, "pid", getpid());
    jb_text(&hint, "}");
    jbuf body = {0};
    jb_text(&body, "{");
    jb_field(&body, "type", "hint");
    jb_field(&body, "session_id", child->session);
    jb_field(&body, "hook_event", child->event);
    /* The process this hook ran in: a SessionStart says it (re)opened the conversation. */
    if (child->harness_pid > 1) jb_number(&body, "harness_pid", child->harness_pid);
    jb_text(&body, "}");
    if (!hint.failed && !body.failed) { send_frame(fd, hint.data); send_frame(fd, body.data); }
    free(hint.data);
    free(body.data);
    close(fd);
}

static int session_child_main(int argc, char **argv, const char *self, const char *runtime) {
    static child_state child;
    memset(&child, 0, sizeof(child));
    child.hub = -1;
    child.lock = -1;
    child.writer = -1;
    child.stamp_wall = wall_ms();
    child.stamp_mono = monotonic_ns();
    signal(SIGPIPE, SIG_IGN);
    snprintf(child.self, sizeof(child.self), "%s", self);
    if (!harness_argument(argc, argv, child.harness, sizeof(child.harness))) return 0;
    char *input = NULL;
    size_t length = 0;
    if (!read_input(&input, &length)) return 0;
    char ignored[256];
    /* A subagent's callback names the child, never the session. */
    if (json_field(input, length, "agent_id", ignored, sizeof(ignored)) != 0 ||
        json_field(input, length, "agent_type", ignored, sizeof(ignored)) != 0 ||
        json_field(input, length, "session_id", child.session, sizeof(child.session)) != 1 || !child.session[0]) {
        free(input);
        return 0;
    }
    json_field(input, length, "hook_event_name", child.event, sizeof(child.event));
    json_field(input, length, "source", child.source, sizeof(child.source));
    json_field(input, length, "cwd", child.cwd, sizeof(child.cwd));
    json_field(input, length, "transcript_path", child.transcript, sizeof(child.transcript));
    free(input);
    if (!state_directory(child.state, sizeof(child.state)) ||
        !hub_paths(child.state, child.run, sizeof(child.run), child.socket_path, sizeof(child.socket_path))) return 0;

    /* One child per session and harness process: two processes can host one
     * conversation (two terminals, a terminal and the desktop app), and each
     * gets its own child, so the hub knows every live writer. The lock dies
     * with its holder, whatever kills it. The session lock that earlier
     * builds take alone is held too while it is free, so their children of
     * other processes still only hint. */
    char children[PATH_MAX], lock_path[PATH_MAX];
    pid_t expected = expected_harness();
    child.harness_pid = expected;
    if (expected <= 1 ||
        snprintf(children, sizeof(children), "%s/children", child.run) >= (int)sizeof(children) ||
        !private_directory(children) ||
        snprintf(lock_path, sizeof(lock_path), "%s/%016llx.lock", children, fnv64(child.session)) >= (int)sizeof(lock_path) ||
        snprintf(child.writer_lock, sizeof(child.writer_lock), "%s/%016llx-%ld.lock", children, fnv64(child.session), (long)expected)
            >= (int)sizeof(child.writer_lock)) return 0;
    child.writer = open(child.writer_lock, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (child.writer < 0) { child.writer_lock[0] = 0; return 0; }
    if (flock(child.writer, LOCK_EX | LOCK_NB)) {
        child.writer_lock[0] = 0;
        child_hint(&child);
        return 0;
    }
    child.lock = open(lock_path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (child.lock >= 0 && flock(child.lock, LOCK_EX | LOCK_NB)) {
        /* Another child holds the session. One from an earlier build that
         * serves this very process needs only a hint; any other serves
         * another process, and this child is one more writer. */
        char held[128];
        ssize_t n = pread(child.lock, held, sizeof(held) - 1, 0);
        held[n > 0 ? n : 0] = 0;
        char *space = strchr(held, ' ');
        close(child.lock);
        child.lock = -1;
        if (space && strtol(space + 1, NULL, 10) == (long)expected) {
            child.writer_lock[0] = 0;
            child_hint(&child);
            return 0;
        }
    }
    /* A Codex Interrupt hook lives three seconds: never a resident. */
    if (!strcmp(child.event, "Interrupt")) { child.writer_lock[0] = 0; child_hint(&child); return 0; }
    if (!identify_harness(&child) || child.harness_pid != expected) { child.writer_lock[0] = 0; return 0; }
    char record[128];
    int record_length = snprintf(record, sizeof(record), "%ld %ld\n", (long)getpid(), (long)child.harness_pid);
    if (ftruncate(child.writer, 0) == 0) write_all(child.writer, record, (size_t)record_length);
    if (child.lock >= 0 && ftruncate(child.lock, 0) == 0) write_all(child.lock, record, (size_t)record_length);
    boot_identity(child.boot, sizeof(child.boot));
    const char *socket = getenv("CLAUDE_CODE_MESSAGING_SOCKET"), *token = getenv("CLAUDE_CODE_MESSAGING_TOKEN");
    const char *exported = getenv("CLAUDE_CODE_SESSION_ID");
    if (!strcmp(child.harness, "claude-code") && socket && *socket && token && *token &&
        (!exported || !strcmp(exported, child.session))) {
        snprintf(child.inbox_socket, sizeof(child.inbox_socket), "%s", socket);
        snprintf(child.token, sizeof(child.token), "%s", token);
    }
    /* Leave the hook's stdio: the harness reads nothing from a resident. */
    int null = open("/dev/null", O_RDWR);
    if (null >= 0) { dup2(null, 0); dup2(null, 1); dup2(null, 2); if (null > 2) close(null); }

#ifdef __APPLE__
    int queue = kqueue();
    if (queue < 0) return 0;
    struct kevent change;
    EV_SET(&change, child.harness_pid, EVFILT_PROC, EV_ADD, NOTE_EXIT, 0, NULL);
    if (kevent(queue, &change, 1, NULL, 0, NULL)) { if (errno == ESRCH) child_ended(&child); return 0; }
    int stop_signals[] = { SIGTERM, SIGHUP, SIGINT };
    for (int i = 0; i < 3; i++) {
        signal(stop_signals[i], SIG_IGN);
        EV_SET(&change, stop_signals[i], EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
        kevent(queue, &change, 1, NULL, 0, NULL);
    }
#else
    /* pidfd_open needs Linux 5.3; before it, the child looks once a second. */
    int watch = (int)syscall(SYS_pidfd_open, child.harness_pid, 0);
    if (watch < 0 && errno == ESRCH) { child_ended(&child); return 0; }
    if (watch < 0 && errno != ENOSYS) return 0;
    sigset_t stops;
    sigemptyset(&stops);
    sigaddset(&stops, SIGTERM);
    sigaddset(&stops, SIGHUP);
    sigaddset(&stops, SIGINT);
    sigprocmask(SIG_BLOCK, &stops, NULL);
    int signals = signalfd(-1, &stops, SFD_CLOEXEC);
#endif
    /* The watch is armed: a PID reused before it would fail this check. */
    if (!harness_alive(&child)) { child_ended(&child); return 0; }

    static char buffer[CHILD_MAX_FRAME + 8];
    size_t buffered = 0;
    int backoff_ms = 1000, stopping = 0;
    unsigned long long next_connect = 0;
    if (!child_connect(&child, 1)) next_connect = monotonic_ns() + (unsigned long long)backoff_ms * 1000000ULL;
    for (;;) {
        int timeout = stopping ? 2000 : -1;
        if (child.hub < 0 && !stopping) {
            unsigned long long now = monotonic_ns();
            timeout = now >= next_connect ? 0 : (int)((next_connect - now) / 1000000ULL) + 1;
        }
#ifdef __APPLE__
        struct kevent events[4];
        int registered = child.hub >= 0;
        if (registered) {
            EV_SET(&change, child.hub, EVFILT_READ, EV_ADD, 0, 0, NULL);
            kevent(queue, &change, 1, NULL, 0, NULL);
        }
        struct timespec wait = { timeout / 1000, (long)(timeout % 1000) * 1000000L };
        int n = kevent(queue, NULL, 0, events, 4, timeout < 0 ? NULL : &wait);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) return 0;
        int exited = 0, readable = 0, signalled = 0;
        for (int i = 0; i < n; i++) {
            if (events[i].filter == EVFILT_PROC) exited = 1;
            else if (events[i].filter == EVFILT_SIGNAL) signalled = 1;
            else if (events[i].filter == EVFILT_READ) readable = 1;
        }
#else
        struct pollfd waits[3] = { { watch, POLLIN, 0 }, { signals, POLLIN, 0 }, { child.hub, POLLIN, 0 } };
        if (watch < 0 && (timeout < 0 || timeout > 1000)) timeout = 1000;
        int n = poll(waits, child.hub >= 0 ? 3 : 2, timeout);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) return 0;
        int exited = watch >= 0 ? waits[0].revents != 0 : !harness_alive(&child), signalled = waits[1].revents != 0;
        int readable = child.hub >= 0 && waits[2].revents != 0;
        if (signalled) { struct signalfd_siginfo info; if (read(signals, &info, sizeof(info)) < 0) { /* drained */ } }
#endif
        if (exited || (n == 0 && stopping && !harness_alive(&child))) { child_ended(&child); return 0; }
        if (n == 0 && stopping) return 0; /* signalled while the harness lives: leave quietly */
        if (signalled) { stopping = 1; continue; }
        if (readable) {
            int result = child_read(&child, buffer, &buffered);
            if (result == 0) return 0;
            if (result < 0) {
#ifdef __APPLE__
                EV_SET(&change, child.hub, EVFILT_READ, EV_DELETE, 0, 0, NULL);
                kevent(queue, &change, 1, NULL, 0, NULL);
#endif
                close(child.hub);
                child.hub = -1;
                buffered = 0;
                backoff_ms = 1000;
                for (int i = 0; i < child.refusals && backoff_ms < 60000; i++) backoff_ms *= 2;
                if (backoff_ms > 60000) backoff_ms = 60000;
                next_connect = monotonic_ns() + (unsigned long long)backoff_ms * 1000000ULL;
                continue;
            }
        }
        if (child.hub < 0 && !stopping && monotonic_ns() >= next_connect) {
            if (!harness_alive(&child)) { child_ended(&child); return 0; }
            /* An uninstall waits for this image to close; never start a hub into it. */
            if (uninstall_pending(runtime)) return 0;
            if (child_connect(&child, 1)) backoff_ms = 1000;
            else {
                backoff_ms = backoff_ms >= 60000 ? 60000 : backoff_ms * 2;
                next_connect = monotonic_ns() + (unsigned long long)backoff_ms * 1000000ULL;
            }
        }
    }
}

/* ---- peer credentials and boot identity for the hub ------------------------ */

static void json_process(jbuf *b, const char *key, pid_t pid) {
    proc_record record;
    jb_raw(b, ",", 1);
    jb_string(b, key);
    jb_raw(b, ":", 1);
    if (!proc_lookup(pid, &record)) { jb_text(b, "null"); return; }
    char start[64];
    format_start(record.start, start, sizeof(start));
    normalize_spaces(start);
    jbuf nested = {0};
    jb_text(&nested, "{");
    jb_number(&nested, "pid", record.pid);
    jb_number(&nested, "ppid", record.ppid);
    jb_field(&nested, "comm", record.comm);
    jb_field(&nested, "start", start);
    if (record.ticks[0]) jb_field(&nested, "ticks", record.ticks);
    jb_text(&nested, "}");
    if (nested.failed) b->failed = 1;
    else jb_raw(b, nested.data, nested.length);
    free(nested.data);
}

/* The connected peer of the Unix socket on stdin, as the kernel knows it. */
static int peer_credentials(void) {
    uid_t uid;
    pid_t pid = 0;
#ifdef __APPLE__
    gid_t gid;
    socklen_t length = sizeof(pid);
    if (getpeereid(0, &uid, &gid) || getsockopt(0, SOL_LOCAL, LOCAL_PEERPID, &pid, &length)) return 1;
#else
    struct notifai_peer_credentials credentials;
    socklen_t length = sizeof(credentials);
    if (getsockopt(0, SOL_SOCKET, SO_PEERCRED, &credentials, &length)) return 1;
    uid = credentials.uid;
    pid = credentials.pid;
#endif
    proc_record peer, parent;
    jbuf b = {0};
    jb_text(&b, "{");
    jb_number(&b, "uid", uid);
    jb_number(&b, "pid", pid);
    json_process(&b, "peer", pid);
    if (proc_lookup(pid, &peer)) {
        json_process(&b, "parent", peer.ppid);
        if (proc_lookup(peer.ppid, &parent)) json_process(&b, "grandparent", parent.ppid);
    }
    jb_text(&b, "}\n");
    int ok = !b.failed && write_all(1, b.data, b.length);
    free(b.data);
    return ok ? 0 : 1;
}

static int print_boot_identity(void) {
    char boot[128];
    boot_identity(boot, sizeof(boot));
    if (!boot[0]) return 1;
    return puts(boot) < 0 ? 1 : 0;
}
