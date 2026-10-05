/* Native pre-entry boundary. No network, credentials, update policy, or JS runtime. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
#include <errno.h>

static int failure(const char *message) {
    fprintf(stderr, "notifai: %s (Windows error %lu)\n", message, GetLastError());
    return 1;
}

/* Both processes share the console. Let the child consume Ctrl-C/Break; keeping
 * the launcher alive lets it return the child's status and retain the job. */
static BOOL WINAPI console_control(DWORD event) {
    return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
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
    if (argc == 3 && !wcscmp(argv[1], L"--internal-process-info"))
        return process_info(argv[2]);
    wchar_t executable[32768];
    DWORD length = GetModuleFileNameW(NULL, executable, 32768);
    if (!length || length >= 32768) return failure("cannot locate the launcher");
    wchar_t *separator = wcsrchr(executable, L'\\');
    if (!separator || (size_t)(separator - executable) + 22 >= 32768)
        return failure("invalid launcher directory");
    wcscpy(separator + 1, L"notifai-runtime.exe");

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
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
extern char **environ;

int main(int argc, char **argv) {
    (void)argc;
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
