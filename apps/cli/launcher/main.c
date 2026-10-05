/* Native pre-entry boundary. No network, credentials, update policy, or JS runtime. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

/* The installer writes this one canonical, bounded record atomically. This is
 * deliberately a fixed grammar, not a general JSON parser or a path language. */
static int take_build(const char **cursor, char *output) {
    if (strlen(*cursor) < 64) return 0;
    for (int i = 0; i < 64; i++) {
        char c = (*cursor)[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
        if (output) output[i] = c;
    }
    if (output) output[64] = 0;
    *cursor += 64;
    return 1;
}

static int active_build(const char *record, char *build) {
    const char *prefix = "{\"schema\":1,\"active\":\"";
    if (strncmp(record, prefix, strlen(prefix))) return 0;
    const char *cursor = record + strlen(prefix);
    if (!take_build(&cursor, build) || strncmp(cursor, "\",\"previous\":", 13)) return 0;
    cursor += 13;
    if (!strncmp(cursor, "null", 4)) cursor += 4;
    else {
        if (*cursor++ != '"' || !take_build(&cursor, NULL) || *cursor++ != '"') return 0;
    }
    if (strncmp(cursor, ",\"generation\":", 14)) return 0;
    cursor += 14;
    if (*cursor < '1' || *cursor > '9') return 0;
    char *end;
    errno = 0;
    unsigned long long generation = strtoull(cursor, &end, 10);
    if (errno || generation > 9007199254740991ULL || (*end != '}')) return 0;
    return !strcmp(end + 1, "\n") || !strcmp(end + 1, "");
}

#ifdef _WIN32
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>

static int failure(const char *message) {
    fprintf(stderr, "notifai: %s (Windows error %lu)\n", message, GetLastError());
    return 1;
}

/* Both processes share the console. Let the child consume Ctrl-C/Break; keeping
 * the launcher alive lets it return the child's status and retain the job. */
static BOOL WINAPI console_control(DWORD event) {
    return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

static int managed_runtime(wchar_t *executable) {
    wchar_t root[32768];
    wcscpy(root, executable);
    wchar_t *separator = wcsrchr(root, L'\\');
    if (!separator) return 0;
    *separator = 0;
    separator = wcsrchr(root, L'\\');
    if (!separator || wcscmp(separator + 1, L"bin")) return 0;
    *separator = 0;
    if (wcslen(root) + 105 >= 32768) return 0;
    wchar_t file[32768];
    swprintf(file, 32768, L"%ls\\active.json", root);
    HANDLE handle = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) return 0;
    BY_HANDLE_FILE_INFORMATION info;
    char record[256] = {0}, build[65];
    DWORD count = 0;
    BOOL ok = GetFileInformationByHandle(handle, &info) &&
        !(info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
        !info.nFileSizeHigh && info.nFileSizeLow < sizeof(record) &&
        ReadFile(handle, record, sizeof(record) - 1, &count, NULL) && count == info.nFileSizeLow;
    CloseHandle(handle);
    if (!ok || !active_build(record, build)) return 0;
    wchar_t wide_build[65];
    for (int i = 0; i < 65; i++) wide_build[i] = (wchar_t)build[i];
    swprintf(file, 32768, L"%ls\\versions", root);
    DWORD attributes = GetFileAttributesW(file);
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
    swprintf(file, 32768, L"%ls\\versions\\%ls", root, wide_build);
    attributes = GetFileAttributesW(file);
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
    swprintf(executable, 32768, L"%ls\\versions\\%ls\\notifai-runtime.exe", root, wide_build);
    attributes = GetFileAttributesW(executable);
    return attributes != INVALID_FILE_ATTRIBUTES &&
        !(attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY));
}

/* OS process identity is read from one open handle: a recycled PID cannot mix
 * a creation time from one process with the executable of another. */
static int process_info(const wchar_t *argument) {
    wchar_t *end;
    errno = 0;
    unsigned long pid = wcstoul(argument, &end, 10);
    if (errno || !pid || *end || argument == end) return 2;
    HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!handle) return 1;
    FILETIME created, exited, kernel, user;
    wchar_t executable[32768];
    DWORD length = 32768;
    BOOL ok = GetProcessTimes(handle, &created, &exited, &kernel, &user) &&
        QueryFullProcessImageNameW(handle, 0, executable, &length);
    CloseHandle(handle);
    if (!ok) return 1;
    wchar_t *name = wcsrchr(executable, L'\\');
    name = name ? name + 1 : executable;
    char utf8[32768 * 3];
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, -1,
                            utf8, sizeof(utf8), NULL, NULL)) return 1;
    ULARGE_INTEGER ticks;
    ticks.LowPart = created.dwLowDateTime;
    ticks.HighPart = created.dwHighDateTime;
    printf("windows-filetime:%llu\n%s\n", ticks.QuadPart, utf8);
    return 0;
}

int wmain(int argc, wchar_t **argv) {
    if (argc == 2 && !wcscmp(argv[1], L"--internal-launcher-version")) { puts("1"); return 0; }
    if (argc == 3 && !wcscmp(argv[1], L"--internal-process-info"))
        return process_info(argv[2]);
    wchar_t executable[32768];
    DWORD length = GetModuleFileNameW(NULL, executable, 32768);
    if (!length || length >= 32768) return failure("cannot locate the launcher");
    wchar_t *separator = wcsrchr(executable, L'\\');
    if (!separator || (size_t)(separator - executable) + 22 >= 32768)
        return failure("invalid launcher directory");
    wcscpy(separator + 1, L"notifai-runtime.exe");
    if (GetFileAttributesW(executable) == INVALID_FILE_ATTRIBUTES && !managed_runtime(executable))
        return failure("no valid active installation; run the installer to repair it");

    LPWCH environment = GetEnvironmentStringsW();
    if (!environment) return failure("cannot inspect runtime controls");
    for (wchar_t *entry = environment; *entry; entry += wcslen(entry) + 1) {
        wchar_t *equals = wcschr(entry, L'=');
        if (!equals || equals == entry) continue;
        size_t n = (size_t)(equals - entry);
        if (_wcsnicmp(entry, L"BUN_", 4) == 0 || _wcsnicmp(entry, L"JSC_", 4) == 0) {
            wchar_t name[32768];
            if (n >= 32768) { FreeEnvironmentStringsW(environment); return failure("invalid environment name"); }
            wmemcpy(name, entry, n); name[n] = 0;
            if (!SetEnvironmentVariableW(name, NULL)) {
                FreeEnvironmentStringsW(environment); return failure("cannot clear runtime controls");
            }
        }
    }
    FreeEnvironmentStringsW(environment);

    /* argv[0] has the special Windows executable-name grammar. Retain the
     * original argument tail verbatim, including empty/quoted Unicode values. */
    const wchar_t *tail = GetCommandLineW();
    int quoted = 0;
    while (*tail && (quoted || (*tail != L' ' && *tail != L'\t'))) {
        if (*tail == L'"') quoted = !quoted;
        tail++;
    }
    size_t command_length = wcslen(executable) + wcslen(tail) + 3;
    if (command_length > 32767) return failure("command line is too long");
    wchar_t *command = calloc(command_length, sizeof(wchar_t));
    if (!command) return failure("cannot allocate command line");
    swprintf(command, command_length, L"\"%ls\"%ls", executable, tail);

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) { free(command); return failure("cannot create foreground job"); }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        free(command); CloseHandle(job); return failure("cannot protect foreground process lifetime");
    }
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = malloc(size);
    if (!attributes || !InitializeProcThreadAttributeList(attributes, 1, 0, &size)) {
        free(attributes); free(command); CloseHandle(job); return failure("cannot initialize process attributes");
    }
    /* Assignment occurs at creation, before any child instructions run. */
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                  &job, sizeof(job), NULL, NULL)) {
        DeleteProcThreadAttributeList(attributes); free(attributes); free(command); CloseHandle(job);
        return failure("cannot set foreground job at creation");
    }
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process = {0};
    SetConsoleCtrlHandler(console_control, TRUE);
    BOOL created = CreateProcessW(executable, command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, &startup.StartupInfo, &process);
    DeleteProcThreadAttributeList(attributes); free(attributes); free(command);
    if (!created) { CloseHandle(job); return failure("cannot launch the runtime"); }
    CloseHandle(process.hThread);
    DWORD waited = WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    BOOL exited = waited == WAIT_OBJECT_0 && GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    if (!exited) return failure("cannot read runtime exit status");
    return (int)code;
}
#else
#include <unistd.h>
#include <limits.h>
#include <fcntl.h>
#include <sys/stat.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
extern char **environ;

static int owned_path(const char *file, int directory) {
    struct stat info;
    return !lstat(file, &info) && info.st_uid == getuid() && !(info.st_mode & 0022) &&
        (directory ? S_ISDIR(info.st_mode) : S_ISREG(info.st_mode));
}

static int managed_runtime(char *executable) {
    char root[PATH_MAX];
    strcpy(root, executable);
    char *separator = strrchr(root, '/');
    if (!separator) return 0;
    *separator = 0;
    separator = strrchr(root, '/');
    if (!separator || strcmp(separator + 1, "bin")) return 0;
    *separator = 0;
    if (strlen(root) + 105 >= PATH_MAX) return 0;
    char file[PATH_MAX];
    snprintf(file, sizeof(file), "%s/active.json", root);
    int handle = open(file, O_RDONLY | O_NOFOLLOW);
    if (handle < 0) return 0;
    struct stat info;
    char record[256] = {0}, build[65];
    int ok = !fstat(handle, &info) && S_ISREG(info.st_mode) && info.st_uid == getuid() &&
        !(info.st_mode & 0022) && info.st_size > 0 && info.st_size < (off_t)sizeof(record) &&
        read(handle, record, sizeof(record) - 1) == info.st_size;
    close(handle);
    if (!ok || !active_build(record, build)) return 0;
    snprintf(file, sizeof(file), "%s/versions", root);
    if (!owned_path(file, 1)) return 0;
    snprintf(file, sizeof(file), "%s/versions/%s", root, build);
    if (!owned_path(file, 1)) return 0;
    snprintf(executable, PATH_MAX, "%s/versions/%s/notifai-runtime", root, build);
    return owned_path(executable, 0);
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--internal-launcher-version")) { puts("1"); return 0; }
    char executable[PATH_MAX];
#ifdef __APPLE__
    char unresolved[PATH_MAX];
    uint32_t size = sizeof(unresolved);
    if (_NSGetExecutablePath(unresolved, &size) || !realpath(unresolved, executable)) {
        perror("notifai: locate launcher"); return 1;
    }
#else
    ssize_t n = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (n < 0 || n >= (ssize_t)sizeof(executable) - 1) { perror("notifai: locate launcher"); return 1; }
    executable[n] = 0;
#endif
    char *separator = strrchr(executable, '/');
    if (!separator || (size_t)(separator - executable) + 18 >= sizeof(executable)) return 1;
    strcpy(separator + 1, "notifai-runtime");
    if (access(executable, F_OK) && !managed_runtime(executable)) {
        fprintf(stderr, "notifai: no valid active installation; run the installer to repair it\n"); return 1;
    }
    for (size_t i = 0; environ[i];) {
        char *entry = environ[i];
        if (!strncmp(entry, "BUN_", 4) || !strncmp(entry, "JSC_", 4) ||
            !strncmp(entry, "DYLD_", 5) ||
            !strncmp(entry, "LD_PRELOAD=", 11) || !strncmp(entry, "LD_LIBRARY_PATH=", 16)) {
            char *name = strdup(entry);
            if (!name) return 1;
            char *equals = strchr(name, '=');
            if (!equals) { free(name); return 1; }
            *equals = 0;
            int result = unsetenv(name);
            free(name);
            if (result) { perror("notifai: clear runtime controls"); return 1; }
        } else i++;
    }
    argv[0] = executable;
    execv(executable, argv);
    perror("notifai: launch runtime");
    return 1;
}
#endif
