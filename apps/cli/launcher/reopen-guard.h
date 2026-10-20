/*
 * `--internal-reopen-guard <record>`: the last check inside a terminal window
 * Notifai opened to reopen a stopped conversation, run by the window's script
 * just before it becomes the harness. Local only: no network, no runtime.
 *
 * It refuses, with one line in the window, when the record is not one the hub
 * just wrote for this window, or when the conversation is already open
 * somewhere else: a live Claude Code process whose own session descriptor
 * names it, or a process holding the Codex thread's writer lock (other than
 * the shared server the hub found holding it with no terminal attached).
 * Otherwise it writes `<token>.pid` beside the record, naming the window's
 * shell, which then becomes the harness: the hub knows the exact process it
 * started. The record is used once.
 *
 * The record is one line in a fixed grammar the hub writes:
 *   {"v":1,"token":"<32 hex>","harness":"claude-code"|"codex","session_id":"<id>",
 *    "home":"<abs>","default_home":"<abs>","allow_holder":<pid>,"expires_at":<ms>}
 */
#include <sys/time.h>

#define GUARD_MAX_RECORD 8192
#define GUARD_MAX_DESCRIPTOR (64 * 1024)

static const char *const GUARD_LIVE_LINE = "Notifai did not reopen this conversation here: it is already open somewhere else.";
static const char *const GUARD_STALE_LINE = "Notifai did not reopen this conversation: this window is no longer needed.";

static long long guard_wall_ms(void) {
    struct timeval now;
    gettimeofday(&now, NULL);
    return (long long)now.tv_sec * 1000 + now.tv_usec / 1000;
}

/* Expect `prefix` then a string value up to the next quote, into `out`. */
static int guard_take_text(const char **cursor, const char *prefix, char *out, size_t size) {
    size_t length = strlen(prefix);
    if (strncmp(*cursor, prefix, length)) return 0;
    const char *start = *cursor + length, *end = strchr(start, '"');
    if (!end || (size_t)(end - start) >= size || end == start) return 0;
    for (const char *c = start; c < end; c++) if (*c == '\\' || (unsigned char)*c < 0x20) return 0;
    memcpy(out, start, (size_t)(end - start));
    out[end - start] = 0;
    *cursor = end + 1;
    return 1;
}

static int guard_take_number(const char **cursor, const char *prefix, long long *out) {
    size_t length = strlen(prefix);
    if (strncmp(*cursor, prefix, length)) return 0;
    char *end;
    errno = 0;
    long long value = strtoll(*cursor + length, &end, 10);
    if (errno || end == *cursor + length || value < 0) return 0;
    *out = value;
    *cursor = end;
    return 1;
}

typedef struct {
    char token[64], harness[16], session[160], home[PATH_MAX], default_home[PATH_MAX];
    long long allow_holder, expires_at;
} guard_record;

static int guard_parse(const char *text, guard_record *record) {
    const char *cursor = text;
    if (strncmp(cursor, "{\"v\":1,", 7)) return 0;
    cursor += 7;
    if (!guard_take_text(&cursor, "\"token\":\"", record->token, sizeof(record->token)) ||
        !guard_take_text(&cursor, ",\"harness\":\"", record->harness, sizeof(record->harness)) ||
        !guard_take_text(&cursor, ",\"session_id\":\"", record->session, sizeof(record->session)) ||
        !guard_take_text(&cursor, ",\"home\":\"", record->home, sizeof(record->home)) ||
        !guard_take_text(&cursor, ",\"default_home\":\"", record->default_home, sizeof(record->default_home)) ||
        !guard_take_number(&cursor, ",\"allow_holder\":", &record->allow_holder) ||
        !guard_take_number(&cursor, ",\"expires_at\":", &record->expires_at)) return 0;
    if (strcmp(cursor, "}\n") && strcmp(cursor, "}")) return 0;
    if (strlen(record->token) != 32) return 0;
    for (const char *c = record->token; *c; c++) if (!((*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'f'))) return 0;
    for (const char *c = record->session; *c; c++)
        if (!((*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || *c == '-' || *c == '_' || *c == '.')) return 0;
    if (record->home[0] != '/' || record->default_home[0] != '/') return 0;
    return !strcmp(record->harness, "claude-code") || !strcmp(record->harness, "codex");
}

static int guard_process_alive(long pid) {
    return pid > 1 && pid <= INT_MAX && (!kill((pid_t)pid, 0) || errno == EPERM);
}

/* `"sessionId"`, optional spaces, `:`, optional spaces, then the quoted id. */
static int guard_names_session(const char *text, const char *session) {
    size_t length = strlen(session);
    for (const char *at = strstr(text, "\"sessionId\""); at; at = strstr(at + 1, "\"sessionId\"")) {
        const char *c = at + 11;
        while (*c == ' ' || *c == '\t' || *c == '\n' || *c == '\r') c++;
        if (*c++ != ':') continue;
        while (*c == ' ' || *c == '\t' || *c == '\n' || *c == '\r') c++;
        if (*c++ != '"') continue;
        if (!strncmp(c, session, length) && c[length] == '"') return 1;
    }
    return 0;
}

/* A live Claude Code process whose `<home>/sessions/<pid>.json` names the conversation. */
static int guard_claude_live(const char *home, const char *session) {
    char directory[PATH_MAX];
    if (snprintf(directory, sizeof(directory), "%s/sessions", home) >= (int)sizeof(directory)) return 1;
    DIR *entries = opendir(directory);
    if (!entries) return errno == ENOENT ? 0 : 1;
    int live = 0;
    char *text = malloc(GUARD_MAX_DESCRIPTOR + 1);
    if (!text) { closedir(entries); return 1; }
    struct dirent *entry;
    while (!live && (entry = readdir(entries))) {
        char *end;
        long pid = strtol(entry->d_name, &end, 10);
        if (end == entry->d_name || strcmp(end, ".json") || !guard_process_alive(pid)) continue;
        int fd = openat(dirfd(entries), entry->d_name, O_RDONLY | O_NOFOLLOW);
        if (fd < 0) continue;
        ssize_t total = 0, got;
        while (total < GUARD_MAX_DESCRIPTOR && (got = read(fd, text + total, (size_t)(GUARD_MAX_DESCRIPTOR - total))) > 0) total += got;
        close(fd);
        text[total] = 0;
        if (guard_names_session(text, session)) live = 1;
    }
    free(text);
    closedir(entries);
    return live;
}

/* Some process other than `allowed` holds the Codex thread's writer lock open. */
static int guard_codex_held(const char *home, const char *session, long long allowed) {
    char lock[PATH_MAX], target[PATH_MAX];
    if (snprintf(lock, sizeof(lock), "%s/thread-writer-locks/%s.lock", home, session) >= (int)sizeof(lock)) return 1;
    if (!realpath(lock, target)) return errno == ENOENT ? 0 : 1;
#ifdef __APPLE__
    int count = proc_listallpids(NULL, 0);
    if (count <= 0) return 1;
    pid_t *pids = calloc((size_t)count + 64, sizeof(pid_t));
    if (!pids) return 1;
    count = proc_listallpids(pids, (int)(((size_t)count + 64) * sizeof(pid_t)));
    int held = count <= 0;
    for (int i = 0; !held && i < count; i++) {
        pid_t pid = pids[i];
        if (pid <= 1 || pid == getpid() || (long long)pid == allowed) continue;
        struct proc_bsdinfo info;
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != getuid()) continue;
        int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
        if (size <= 0) continue;
        struct proc_fdinfo *fds = malloc((size_t)size);
        if (!fds) { held = 1; break; }
        size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, size);
        for (int f = 0; size > 0 && f < size / (int)sizeof(struct proc_fdinfo); f++) {
            if (fds[f].proc_fdtype != PROX_FDTYPE_VNODE) continue;
            struct vnode_fdinfowithpath path;
            if (proc_pidfdinfo(pid, fds[f].proc_fd, PROC_PIDFDVNODEPATHINFO, &path, sizeof(path)) != sizeof(path)) continue;
            if (!strcmp(path.pvip.vip_path, target)) { held = 1; break; }
        }
        free(fds);
    }
    free(pids);
    return held;
#else
    DIR *processes = opendir("/proc");
    if (!processes) return 1;
    int held = 0;
    struct dirent *entry;
    while (!held && (entry = readdir(processes))) {
        char *end;
        long pid = strtol(entry->d_name, &end, 10);
        if (!*entry->d_name || *end || pid <= 1 || pid == (long)getpid() || pid == allowed) continue;
        char directory[64];
        snprintf(directory, sizeof(directory), "/proc/%ld/fd", pid);
        DIR *fds = opendir(directory);
        if (!fds) continue;
        struct dirent *fd;
        while (!held && (fd = readdir(fds))) {
            if (fd->d_name[0] == '.') continue;
            char link[PATH_MAX];
            ssize_t length = readlinkat(dirfd(fds), fd->d_name, link, sizeof(link) - 1);
            if (length <= 0) continue;
            link[length] = 0;
            if (!strcmp(link, target)) held = 1;
        }
        closedir(fds);
    }
    closedir(processes);
    return held;
#endif
}

static int guard_refuse(const char *line) {
    printf("%s\n", line);
    fflush(stdout);
    return 1;
}

static int reopen_guard(const char *file) {
    /* `<dir>/<32 hex>.json`, a private regular file of this user. */
    const char *name = strrchr(file, '/');
    if (file[0] != '/' || !name || strlen(name + 1) != 37 || strcmp(name + 33, ".json")) return guard_refuse(GUARD_STALE_LINE);
    int fd = open(file, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return guard_refuse(GUARD_STALE_LINE);
    struct stat info;
    char text[GUARD_MAX_RECORD + 1];
    ssize_t total = 0, got;
    int ok = !fstat(fd, &info) && S_ISREG(info.st_mode) && info.st_uid == getuid() && !(info.st_mode & 0077) && info.st_size < GUARD_MAX_RECORD;
    while (ok && (got = read(fd, text + total, (size_t)(GUARD_MAX_RECORD - total))) > 0) total += got;
    close(fd);
    if (!ok) return guard_refuse(GUARD_STALE_LINE);
    text[total] = 0;
    guard_record record;
    memset(&record, 0, sizeof(record));
    if (!guard_parse(text, &record) || strncmp(name + 1, record.token, 32) || guard_wall_ms() >= record.expires_at)
        return guard_refuse(GUARD_STALE_LINE);
    int live = !strcmp(record.harness, "claude-code")
        ? guard_claude_live(record.home, record.session) || (strcmp(record.home, record.default_home) && guard_claude_live(record.default_home, record.session))
        : guard_codex_held(record.home, record.session, record.allow_holder);
    if (live) return guard_refuse(GUARD_LIVE_LINE);
    /* Used once: the pid file is created, never replaced. */
    char marker[PATH_MAX];
    size_t directory = (size_t)(name - file);
    if (directory + 1 + 32 + 5 >= sizeof(marker)) return guard_refuse(GUARD_STALE_LINE);
    snprintf(marker, sizeof(marker), "%.*s/%s.pid", (int)directory, file, record.token);
    int out = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (out < 0) return guard_refuse(GUARD_STALE_LINE);
    char pid[32];
    int length = snprintf(pid, sizeof(pid), "%ld\n", (long)getppid());
    int written = write(out, pid, (size_t)length) == length;
    close(out);
    if (!written) { unlink(marker); return guard_refuse(GUARD_STALE_LINE); }
    return 0;
}
