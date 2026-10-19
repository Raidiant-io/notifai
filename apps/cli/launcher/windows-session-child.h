/* The Windows session child. UNVERIFIED: written without a Windows machine
 * and compiled only when NOTIFAI_WINDOWS_SESSION_CHILD is defined; `wmain`
 * does not dispatch to it, and Windows keeps the per-session runtime
 * attendant until W1-Win proves this path (and the hub's named-pipe server,
 * which still needs an owner-only DACL and PIPE_REJECT_REMOTE_CLIENTS that
 * the JavaScript runtime cannot set).
 *
 * Same job as the POSIX child: stay Claude Code's own child (exec form gives
 * no Git Bash in between; a shell grandparent is still accepted), wait on the
 * harness process handle, register with the hub over
 * \\.\pipe\notifai-hub-<fnv64 of the state directory>, write Claude's inbox
 * pipe (the session token is required on native Windows) when the hub asks,
 * and write a local end record first when the harness exits. No credential,
 * no network. */
#include "session-child-common.h"

#define WCHILD_PATH 32768

typedef struct {
    char session[512], event[64], source[64], cwd[4096], transcript[4096];
    char state_utf8[WCHILD_PATH * 3], harness_start[64], inbox[1024], token[1024], config[WCHILD_PATH * 3];
    wchar_t self[WCHILD_PATH], state[WCHILD_PATH], run[WCHILD_PATH], pipe[512];
    DWORD harness_pid;
    HANDLE harness, hub, lock;
} wchild_state;

static int wchild_utf8(const wchar_t *text, char *out, size_t size) {
    return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, -1, out, (int)size, NULL, NULL) > 0;
}

static int wchild_wide(const char *text, wchar_t *out, size_t size) {
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, out, (int)size) > 0;
}

static int wchild_write_all(HANDLE handle, const void *data, size_t length) {
    const char *p = data;
    while (length) {
        DWORD wrote = 0;
        if (!WriteFile(handle, p, (DWORD)(length > 1 << 20 ? 1 << 20 : length), &wrote, NULL) || !wrote) return 0;
        p += wrote;
        length -= wrote;
    }
    return 1;
}

static int wchild_send(HANDLE pipe, const char *json) {
    size_t length = strlen(json);
    unsigned char header[4] = { (unsigned char)(length >> 24), (unsigned char)(length >> 16),
                                (unsigned char)(length >> 8), (unsigned char)length };
    return wchild_write_all(pipe, header, 4) && wchild_write_all(pipe, json, length);
}

/* `stateDir` in config.ts on Windows: %XDG_STATE_HOME%\notifai, else %LOCALAPPDATA%\notifai. */
static int wchild_state_paths(wchild_state *child) {
    wchar_t base[WCHILD_PATH];
    DWORD n = GetEnvironmentVariableW(L"XDG_STATE_HOME", base, WCHILD_PATH);
    if (!n || n >= WCHILD_PATH) n = GetEnvironmentVariableW(L"LOCALAPPDATA", base, WCHILD_PATH);
    if (!n || n >= WCHILD_PATH) return 0;
    if (swprintf(child->state, WCHILD_PATH, L"%ls\\notifai", base) < 0 ||
        swprintf(child->run, WCHILD_PATH, L"%ls\\run", child->state) < 0) return 0;
    CreateDirectoryW(child->state, NULL);
    CreateDirectoryW(child->run, NULL);
    if (!wchild_utf8(child->state, child->state_utf8, sizeof(child->state_utf8))) return 0;
    return swprintf(child->pipe, 512, L"\\\\.\\pipe\\notifai-hub-%016llx", fnv64(child->state_utf8)) > 0;
}

static int wchild_parent(DWORD pid, DWORD *parent, wchar_t *image, size_t image_size) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry = {0};
    entry.dwSize = sizeof(entry);
    int found = 0;
    if (Process32FirstW(snapshot, &entry)) do {
        if (entry.th32ProcessID == pid) {
            *parent = entry.th32ParentProcessID;
            if (image) wcsncpy(image, entry.szExeFile, image_size - 1);
            found = 1;
            break;
        }
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    return found;
}

/* The creation FILETIME as a decimal string: what Claude Code writes as procStart on Windows. */
static int wchild_start(DWORD pid, char *out, size_t size) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return 0;
    FILETIME created, exited, kernel, user;
    BOOL ok = GetProcessTimes(process, &created, &exited, &kernel, &user);
    CloseHandle(process);
    if (!ok) return 0;
    ULARGE_INTEGER ticks;
    ticks.LowPart = created.dwLowDateTime;
    ticks.HighPart = created.dwHighDateTime;
    return snprintf(out, size, "%llu", ticks.QuadPart) > 0;
}

static int wchild_descriptor_matches(wchild_state *child, DWORD pid, const char *start) {
    wchar_t config[WCHILD_PATH], file[WCHILD_PATH];
    DWORD n = GetEnvironmentVariableW(L"CLAUDE_CONFIG_DIR", config, WCHILD_PATH);
    if (!n || n >= WCHILD_PATH) {
        wchar_t profile[WCHILD_PATH];
        n = GetEnvironmentVariableW(L"USERPROFILE", profile, WCHILD_PATH);
        if (!n || n >= WCHILD_PATH || swprintf(config, WCHILD_PATH, L"%ls\\.claude", profile) < 0) return 0;
    }
    if (swprintf(file, WCHILD_PATH, L"%ls\\sessions\\%lu.json", config, (unsigned long)pid) < 0) return 0;
    HANDLE handle = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) return 0;
    char text[65536];
    DWORD got = 0;
    BOOL ok = ReadFile(handle, text, sizeof(text) - 1, &got, NULL);
    CloseHandle(handle);
    if (!ok || !got) return 0;
    char named[512], proc_start[128], number[32];
    if (json_field(text, got, "sessionId", named, sizeof(named)) != 1 ||
        json_field(text, got, "procStart", proc_start, sizeof(proc_start)) != 1 ||
        json_field(text, got, "pid", number, sizeof(number)) != 2) return 0;
    if (strcmp(named, child->session) || strtoul(number, NULL, 10) != pid || strcmp(proc_start, start)) return 0;
    wchild_utf8(config, child->config, sizeof(child->config));
    return 1;
}

static int wchild_is_shell(const wchar_t *image) {
    static const wchar_t *shells[] = { L"bash.exe", L"sh.exe", L"cmd.exe", L"powershell.exe", L"pwsh.exe", NULL };
    for (int i = 0; shells[i]; i++) if (!_wcsicmp(image, shells[i])) return 1;
    return 0;
}

static int wchild_identify(wchild_state *child) {
    DWORD parent = 0, grandparent = 0;
    wchar_t image[MAX_PATH] = {0}, ignored[MAX_PATH] = {0};
    if (!wchild_parent(GetCurrentProcessId(), &parent, NULL, 0) || !wchild_parent(parent, &grandparent, image, MAX_PATH)) return 0;
    for (int attempt = 0; attempt < 80; attempt++) {
        char start[64];
        if (wchild_start(parent, start, sizeof(start)) && wchild_descriptor_matches(child, parent, start)) {
            child->harness_pid = parent;
            snprintf(child->harness_start, sizeof(child->harness_start), "%s", start);
            return 1;
        }
        if (wchild_is_shell(image) && wchild_start(grandparent, start, sizeof(start)) &&
            wchild_descriptor_matches(child, grandparent, start)) {
            child->harness_pid = grandparent;
            snprintf(child->harness_start, sizeof(child->harness_start), "%s", start);
            return 1;
        }
        Sleep(250);
        (void)ignored;
    }
    return 0;
}

static HANDLE wchild_connect(wchild_state *child) {
    HANDLE pipe = CreateFileW(child->pipe, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE && GetLastError() == ERROR_PIPE_BUSY && WaitNamedPipeW(child->pipe, 1000))
        pipe = CreateFileW(child->pipe, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    return pipe;
}

/* Start the hub outside the harness's job when the job allows it; a job that
 * forbids breakaway keeps the hub inside it (it dies with that harness and the
 * next child restarts it). */
static void wchild_start_hub(wchild_state *child) {
    wchar_t command[WCHILD_PATH + 64];
    if (swprintf(command, WCHILD_PATH + 64, L"\"%ls\" hub --owner notifai", child->self) < 0) return;
    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process = {0};
    DWORD flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    if (!CreateProcessW(child->self, command, NULL, NULL, FALSE, flags | CREATE_BREAKAWAY_FROM_JOB, NULL, NULL, &startup, &process) &&
        !CreateProcessW(child->self, command, NULL, NULL, FALSE, flags, NULL, NULL, &startup, &process)) return;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
}

static int wchild_register(wchild_state *child) {
    jbuf hello = {0}, reg = {0};
    jb_text(&hello, "{");
    jb_field(&hello, "type", "hello");
    jb_number(&hello, "ipc_version", CHILD_IPC_VERSION);
    jb_field(&hello, "role", "child");
    jb_number(&hello, "pid", (long long)GetCurrentProcessId());
    jb_text(&hello, "}");
    LARGE_INTEGER counter, frequency;
    QueryPerformanceCounter(&counter);
    QueryPerformanceFrequency(&frequency);
    char mono[32];
    snprintf(mono, sizeof(mono), "%llu", (unsigned long long)(counter.QuadPart * 1000000000LL / frequency.QuadPart));
    FILETIME now;
    GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER wall;
    wall.LowPart = now.dwLowDateTime;
    wall.HighPart = now.dwHighDateTime;
    jb_text(&reg, "{");
    jb_field(&reg, "type", "register");
    jb_field(&reg, "session_id", child->session);
    jb_field(&reg, "harness", "claude-code");
    jb_number(&reg, "harness_pid", (long long)child->harness_pid);
    jb_field(&reg, "harness_start", child->harness_start);
    jb_number(&reg, "stamp_wall", (long long)((wall.QuadPart - 116444736000000000ULL) / 10000ULL));
    jb_field(&reg, "stamp_mono", mono);
    jb_field(&reg, "hook_event", child->event);
    if (child->source[0]) jb_field(&reg, "source", child->source);
    if (child->cwd[0]) jb_field(&reg, "cwd", child->cwd);
    if (child->inbox[0]) jb_field(&reg, "inbox_socket", child->inbox);
    jb_field(&reg, "inbox_token", child->token[0] ? "present" : "absent");
    if (child->config[0]) jb_field(&reg, "claude_config_dir", child->config);
    jb_text(&reg, "}");
    int ok = !hello.failed && !reg.failed && wchild_send(child->hub, hello.data) && wchild_send(child->hub, reg.data);
    free(hello.data);
    free(reg.data);
    return ok;
}

static void wchild_end_record(wchild_state *child) {
    wchar_t directory[WCHILD_PATH], file[WCHILD_PATH];
    if (swprintf(directory, WCHILD_PATH, L"%ls\\ended", child->run) < 0) return;
    CreateDirectoryW(directory, NULL);
    if (swprintf(file, WCHILD_PATH, L"%ls\\%016llx-%lu.json", directory, fnv64(child->session), (unsigned long)child->harness_pid) < 0) return;
    jbuf record = {0};
    jb_text(&record, "{");
    jb_field(&record, "session_id", child->session);
    jb_field(&record, "harness", "claude-code");
    jb_number(&record, "harness_pid", (long long)child->harness_pid);
    jb_field(&record, "harness_start", child->harness_start);
    jb_field(&record, "reason", "harness-gone");
    jb_text(&record, "}\n");
    HANDLE handle = record.failed ? INVALID_HANDLE_VALUE : CreateFileW(file, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle != INVALID_HANDLE_VALUE) {
        wchild_write_all(handle, record.data, record.length);
        FlushFileBuffers(handle);
        CloseHandle(handle);
    }
    free(record.data);
}

/* Native Windows accepts an inbox connection only after the session's token. */
static void wchild_write_inbox(wchild_state *child, const char *frame, size_t length) {
    static char line_b64[CHILD_MAX_FRAME];
    static unsigned char line[CHILD_MAX_FRAME];
    char id[32] = "0", socket_b64[4096];
    unsigned char socket_raw[3072];
    size_t line_length = 0, socket_length = 0;
    const char *stage = "before-write", *error = NULL;
    json_field(frame, length, "id", id, sizeof(id));
    if (json_field(frame, length, "socket_b64", socket_b64, sizeof(socket_b64)) != 1 ||
        !base64_decode(socket_b64, socket_raw, sizeof(socket_raw) - 1, &socket_length) ||
        json_field(frame, length, "line_b64", line_b64, sizeof(line_b64)) != 1 ||
        !base64_decode(line_b64, line, sizeof(line), &line_length)) error = "malformed write request";
    socket_raw[socket_length] = 0;
    if (!error && (!child->token[0] || strcmp((char *)socket_raw, child->inbox))) error = "no inbox token for this pipe";
    wchar_t pipe[1024];
    HANDLE inbox = INVALID_HANDLE_VALUE;
    if (!error && (!wchild_wide((char *)socket_raw, pipe, 1024) ||
        (inbox = CreateFileW(pipe, GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL)) == INVALID_HANDLE_VALUE))
        error = "the inbox pipe refused the connection";
    if (!error) {
        stage = "during-write";
        jbuf auth = {0};
        jb_text(&auth, "{");
        jb_field(&auth, "type", "auth");
        jb_field(&auth, "token", child->token);
        jb_text(&auth, "}\n");
        if (auth.failed || !wchild_write_all(inbox, auth.data, auth.length) || !wchild_write_all(inbox, line, line_length))
            error = "the inbox write failed";
        free(auth.data);
    }
    if (inbox != INVALID_HANDLE_VALUE) CloseHandle(inbox);
    jbuf reply = {0};
    jb_text(&reply, "{");
    jb_field(&reply, "type", "written");
    jb_field(&reply, "id", id);
    jb_field(&reply, "result", error ? "failed" : "ok");
    if (error) { jb_field(&reply, "stage", stage); jb_field(&reply, "error", error); }
    jb_text(&reply, "}");
    if (!reply.failed) wchild_send(child->hub, reply.data);
    free(reply.data);
}

/* A reader thread turns the pipe into frames; the main thread waits on the
 * harness handle and the reader's exit together. */
static DWORD WINAPI wchild_reader(LPVOID parameter) {
    wchild_state *child = parameter;
    static char buffer[CHILD_MAX_FRAME + 8];
    size_t buffered = 0;
    for (;;) {
        DWORD got = 0;
        if (!ReadFile(child->hub, buffer + buffered, (DWORD)(sizeof(buffer) - buffered), &got, NULL) || !got) return 1;
        buffered += got;
        while (buffered >= 4) {
            unsigned char *h = (unsigned char *)buffer;
            size_t length = ((size_t)h[0] << 24) | ((size_t)h[1] << 16) | ((size_t)h[2] << 8) | h[3];
            if (length > CHILD_MAX_FRAME) return 1;
            if (buffered < length + 4) break;
            char type[32];
            if (json_field(buffer + 4, length, "type", type, sizeof(type)) == 1) {
                if (!strcmp(type, "bye") || !strcmp(type, "refused")) return 0;
                if (!strcmp(type, "write")) wchild_write_inbox(child, buffer + 4, length);
            }
            memmove(buffer, buffer + 4 + length, buffered - 4 - length);
            buffered -= 4 + length;
        }
    }
}

static int win_session_child_main(int argc, wchar_t **argv, const wchar_t *self) {
    static wchild_state child;
    memset(&child, 0, sizeof(child));
    wcsncpy(child.self, self, WCHILD_PATH - 1);
    int harness = 0;
    for (int i = 3; i + 1 < argc; i++) if (!wcscmp(argv[i], L"--harness") && !wcscmp(argv[i + 1], L"claude-code")) harness = 1;
    if (!harness) return 0;
    static char input[CHILD_MAX_INPUT];
    DWORD total = 0, got = 0;
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    while (total < sizeof(input) - 1 && ReadFile(in, input + total, (DWORD)(sizeof(input) - 1 - total), &got, NULL) && got) total += got;
    input[total] = 0;
    char ignored[256];
    if (json_field(input, total, "agent_id", ignored, sizeof(ignored)) != 0 ||
        json_field(input, total, "session_id", child.session, sizeof(child.session)) != 1) return 0;
    json_field(input, total, "hook_event_name", child.event, sizeof(child.event));
    json_field(input, total, "source", child.source, sizeof(child.source));
    json_field(input, total, "cwd", child.cwd, sizeof(child.cwd));
    if (!wchild_state_paths(&child)) return 0;
    wchar_t children[WCHILD_PATH], lock[WCHILD_PATH];
    if (swprintf(children, WCHILD_PATH, L"%ls\\children", child.run) < 0) return 0;
    CreateDirectoryW(children, NULL);
    if (swprintf(lock, WCHILD_PATH, L"%ls\\%016llx.lock", children, fnv64(child.session)) < 0) return 0;
    /* No sharing: a second child for this session cannot open it while this one lives. */
    child.lock = CreateFileW(lock, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (child.lock == INVALID_HANDLE_VALUE) {
        HANDLE hint = wchild_connect(&child);
        if (hint != INVALID_HANDLE_VALUE) {
            char message[768];
            snprintf(message, sizeof(message), "{\"type\":\"hello\",\"ipc_version\":%d,\"role\":\"hint\",\"pid\":%lu}", CHILD_IPC_VERSION,
                (unsigned long)GetCurrentProcessId());
            wchild_send(hint, message);
            jbuf body = {0};
            jb_text(&body, "{");
            jb_field(&body, "type", "hint");
            jb_field(&body, "session_id", child.session);
            jb_field(&body, "hook_event", child.event);
            jb_text(&body, "}");
            if (!body.failed) wchild_send(hint, body.data);
            free(body.data);
            CloseHandle(hint);
        }
        return 0;
    }
    if (!wchild_identify(&child)) return 0;
    char value[1024];
    DWORD n = GetEnvironmentVariableA("CLAUDE_CODE_MESSAGING_SOCKET", value, sizeof(value));
    if (n && n < sizeof(value)) snprintf(child.inbox, sizeof(child.inbox), "%s", value);
    n = GetEnvironmentVariableA("CLAUDE_CODE_MESSAGING_TOKEN", value, sizeof(value));
    if (n && n < sizeof(value)) snprintf(child.token, sizeof(child.token), "%s", value);
    child.harness = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child.harness_pid);
    char start[64];
    if (!child.harness || !wchild_start(child.harness_pid, start, sizeof(start)) || strcmp(start, child.harness_start)) {
        wchild_end_record(&child);
        return 0;
    }
    DWORD backoff = 1000;
    for (;;) {
        child.hub = wchild_connect(&child);
        if (child.hub == INVALID_HANDLE_VALUE) {
            wchild_start_hub(&child);
            for (int attempt = 0; attempt < 20 && child.hub == INVALID_HANDLE_VALUE; attempt++) {
                if (WaitForSingleObject(child.harness, 250) == WAIT_OBJECT_0) { wchild_end_record(&child); return 0; }
                child.hub = wchild_connect(&child);
            }
        }
        if (child.hub != INVALID_HANDLE_VALUE && wchild_register(&child)) {
            backoff = 1000;
            HANDLE reader = CreateThread(NULL, 0, wchild_reader, &child, 0, NULL);
            HANDLE waits[2] = { child.harness, reader };
            DWORD which = reader ? WaitForMultipleObjects(2, waits, FALSE, INFINITE) : WaitForSingleObject(child.harness, INFINITE);
            if (which == WAIT_OBJECT_0) {
                wchild_end_record(&child);
                jbuf ended = {0};
                jb_text(&ended, "{");
                jb_field(&ended, "type", "ended");
                jb_field(&ended, "session_id", child.session);
                jb_field(&ended, "reason", "harness-gone");
                jb_text(&ended, "}");
                if (!ended.failed) wchild_send(child.hub, ended.data);
                free(ended.data);
                return 0;
            }
            DWORD code = 1;
            if (reader) { GetExitCodeThread(reader, &code); CloseHandle(reader); }
            CloseHandle(child.hub);
            child.hub = INVALID_HANDLE_VALUE;
            if (code == 0) return 0; /* bye or refused */
        } else if (child.hub != INVALID_HANDLE_VALUE) {
            CloseHandle(child.hub);
            child.hub = INVALID_HANDLE_VALUE;
        }
        if (WaitForSingleObject(child.harness, backoff) == WAIT_OBJECT_0) { wchild_end_record(&child); return 0; }
        backoff = backoff >= 60000 ? 60000 : backoff * 2;
    }
}
