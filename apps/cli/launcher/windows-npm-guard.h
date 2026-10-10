/* Finite legacy-entry admission for an explicitly authorized npm conversion.
 * The manager inherits the guarded file objects. Killing this supervisor
 * closes its kill-on-close job; those objects remain guarded until the actual
 * writer terminates. This is not proof that earlier Node readers have exited,
 * nor a namespace lock against an unrelated package manager. */
#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")

static int guard_digest(HANDLE file, char output[65]) {
    BCRYPT_ALG_HANDLE algorithm = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    unsigned char buffer[8192], digest[32];
    DWORD count = 0, total = 0;
    int ok = 0;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0 ||
        BCryptCreateHash(algorithm, &hash, NULL, 0, NULL, 0, 0) < 0) goto done;
    for (;;) {
        if (!ReadFile(file, buffer, sizeof(buffer), &count, NULL)) goto done;
        if (!count) break;
        total += count;
        if (total > 16 * 1024 * 1024 || BCryptHashData(hash, buffer, count, 0) < 0) goto done;
    }
    if (BCryptFinishHash(hash, digest, sizeof(digest), 0) < 0) goto done;
    for (int i = 0; i < 32; i++) sprintf(output + i * 2, "%02x", digest[i]);
    output[64] = 0;
    ok = 1;
done:
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    return ok;
}

/* Quote one CRT argument, preserving empty values, quotes and trailing slashes. */
static int guard_argument(wchar_t command[32768], size_t *used, const wchar_t *argument) {
    if (*used + 2 >= 32768) return 0;
    if (*used) command[(*used)++] = L' ';
    command[(*used)++] = L'"';
    for (;;) {
        size_t slashes = 0;
        while (*argument == L'\\') { slashes++; argument++; }
        size_t escaped = (*argument == L'"' || !*argument) ? slashes * 2 : slashes;
        if (*argument == L'"') escaped++;
        if (*used + escaped + 3 >= 32768) return 0;
        while (escaped--) command[(*used)++] = L'\\';
        if (!*argument) break;
        command[(*used)++] = *argument++;
    }
    command[(*used)++] = L'"';
    command[*used] = 0;
    return 1;
}

/* Check the actual filesystem's admission behavior after inheritance. A
 * successful handle transfer alone must not be treated as sharing denial. */
static int guard_denies_access(const wchar_t *name) {
    wchar_t file[32768];
    if (!filesystem_path(name, file)) return 0;
    const DWORD modes[2] = { GENERIC_READ, GENERIC_WRITE };
    for (int i = 0; i < 2; i++) {
        HANDLE probe = CreateFileW(file, modes[i], FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        DWORD error = GetLastError();
        if (probe != INVALID_HANDLE_VALUE) { CloseHandle(probe); SetLastError(ERROR_INVALID_STATE); return 0; }
        if (error != ERROR_SHARING_VIOLATION) { SetLastError(error); return 0; }
    }
    return 1;
}

static int npm_guard(int argc, wchar_t **argv) {
    if (argc < 5) return 2; /* flag, two exact entrypoints, executable, args */
    HANDLE inherited[5] = { INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE,
        INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE };
    HANDLE job = NULL;
    TOKEN_USER *user = NULL;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    PROCESS_INFORMATION child = {0};
    SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    STARTUPINFOEXW startup = {0};
    wchar_t file[32768], executable[32768], command[32768] = {0};
    char digests[2][65];
    size_t used = 0;
    SIZE_T bytes = 0;
    FILETIME created, exited, kernel, cpu;
    ULARGE_INTEGER birth;
    DWORD status = 1, count = 0;
    unsigned char permission = 0;
    int initialized = 0, finished = 0;
    const char *phase = "entrypoint access";
    DWORD failure_error = 0;
    user = installation_user();
    if (!user || !filesystem_path(argv[4], executable)) goto done;
    for (int i = 0; i < 2; i++) {
        if (!filesystem_path(argv[i + 2], file)) goto done;
        inherited[i] = CreateFileW(file, GENERIC_READ | READ_CONTROL, FILE_SHARE_DELETE,
            &security, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        if (inherited[i] == INVALID_HANDLE_VALUE ||
            !private_handle(inherited[i], 0, user->User.Sid, 0, 0, NULL) ||
            !guard_digest(inherited[i], digests[i])) goto done;
    }
    phase = "child standard handles";
    inherited[2] = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, 0, NULL);
    if (inherited[2] == INVALID_HANDLE_VALUE) goto done;
    for (int i = 3; i < 5; i++) {
        HANDLE original = GetStdHandle(i == 3 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE);
        if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), &inherited[i],
            0, TRUE, DUPLICATE_SAME_ACCESS)) goto done;
    }
    phase = "argument bounds";
    for (int i = 4; i < argc; i++) if (!guard_argument(command, &used, argv[i])) goto done;
    phase = "child job";
    job = CreateJobObjectW(NULL, NULL);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto done;
    InitializeProcThreadAttributeList(NULL, 2, 0, &bytes);
    if (!bytes || bytes > 1024 * 1024 || !(attributes = malloc(bytes))) goto done;
    if (!InitializeProcThreadAttributeList(attributes, 2, 0, &bytes)) goto done;
    initialized = 1;
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited, sizeof(inherited), NULL, NULL) ||
        !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
            &job, sizeof(job), NULL, NULL)) goto done;
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[2];
    startup.StartupInfo.hStdOutput = inherited[3];
    startup.StartupInfo.hStdError = inherited[4];
    startup.lpAttributeList = attributes;
    phase = "suspended manager creation";
    if (!CreateProcessW(executable, command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, NULL, NULL, &startup.StartupInfo, &child)) goto done;
    /* The suspended manager now owns these file objects. Retire our copies so
     * the actual writer's lifetime, including forced termination, is the guard
     * lifetime. The explicit handle list excludes the supervisor's GO pipe. */
    for (int i = 0; i < 2; i++) { CloseHandle(inherited[i]); inherited[i] = INVALID_HANDLE_VALUE; }
    phase = "inherited entrypoint admission";
    for (int i = 0; i < 2; i++) if (!guard_denies_access(argv[i + 2])) goto done;
    phase = "manager identity";
    if (!GetProcessTimes(child.hProcess, &created, &exited, &kernel, &cpu)) goto done;
    birth.LowPart = created.dwLowDateTime; birth.HighPart = created.dwHighDateTime;
    if (printf("{\"pid\":%lu,\"start\":\"windows-filetime:%llu\",\"guard_sha256\":[\"%s\",\"%s\"]}\n",
        child.dwProcessId, birth.QuadPart, digests[0], digests[1]) < 0 || fflush(stdout)) goto done;
    /* The caller persists the exact child identity and proves old-reader
     * completion before GO. EOF never executes even one manager instruction. */
    phase = "caller admission";
    SetLastError(ERROR_SUCCESS);
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &permission, 1, &count, NULL) || count != 1 || permission != 'G') goto done;
    phase = "manager completion";
    if (ResumeThread(child.hThread) == (DWORD)-1) goto done;
    if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 ||
        !GetExitCodeProcess(child.hProcess, &status)) goto done;
    finished = 1;
done:
    failure_error = GetLastError();
    if (child.hProcess && !finished) {
        if (TerminateJobObject(job, 1)) WaitForSingleObject(child.hProcess, INFINITE);
        status = 1;
    }
    if (child.hThread) CloseHandle(child.hThread);
    if (child.hProcess) CloseHandle(child.hProcess);
    if (job) CloseHandle(job);
    if (initialized) DeleteProcThreadAttributeList(attributes);
    free(attributes); free(user);
    for (int i = 0; i < 5; i++) if (inherited[i] != INVALID_HANDLE_VALUE) CloseHandle(inherited[i]);
    if (!finished) fprintf(stderr, "notifai: npm conversion was not completed (%s; Windows error %lu)\n", phase, failure_error);
    return (int)status;
}
