/* Finite package-manager custody for a cooperative maintenance operation.
 * This does not prevent other programs from opening the legacy package.
 * The caller must establish and maintain its approved pause before GO. */
/* Quote one CRT argument, preserving empty values, quotes and trailing slashes. */
static int manager_argument(wchar_t command[32768], size_t *used, const wchar_t *argument) {
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

static int npm_manager(int argc, wchar_t **argv) {
    if (argc < 3) return 2; /* flag, executable, args */
    HANDLE inherited[3] = { INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE };
    HANDLE job = NULL;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    PROCESS_INFORMATION child = {0};
    SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    STARTUPINFOEXW startup = {0};
    wchar_t executable[32768], command[32768] = {0};
    size_t used = 0;
    SIZE_T bytes = 0;
    FILETIME created, exited, kernel, cpu;
    ULARGE_INTEGER birth;
    DWORD status = 1, count = 0;
    unsigned char permission = 0;
    int initialized = 0, finished = 0;
    const char *phase = "executable path";
    DWORD failure_error = 0;
    if (!filesystem_path(argv[2], executable)) goto done;
    phase = "child standard handles";
    inherited[0] = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, 0, NULL);
    if (inherited[0] == INVALID_HANDLE_VALUE) goto done;
    for (int i = 1; i < 3; i++) {
        HANDLE original = GetStdHandle(i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE);
        if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), &inherited[i],
            0, TRUE, DUPLICATE_SAME_ACCESS)) goto done;
    }
    phase = "argument bounds";
    for (int i = 2; i < argc; i++) if (!manager_argument(command, &used, argv[i])) goto done;
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
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = attributes;
    phase = "suspended manager creation";
    if (!CreateProcessW(executable, command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, NULL, NULL, &startup.StartupInfo, &child)) goto done;
    /* The manager enters the kill-on-close job atomically with creation. The
     * inherited handle list contains only NUL/stdout/stderr, never our GO pipe.
     * This controls the writer's lifetime, not admission of legacy readers. */
    phase = "manager identity";
    if (!GetProcessTimes(child.hProcess, &created, &exited, &kernel, &cpu)) goto done;
    birth.LowPart = created.dwLowDateTime; birth.HighPart = created.dwHighDateTime;
    if (printf("{\"pid\":%lu,\"start\":\"windows-filetime:%llu\"}\n",
        child.dwProcessId, birth.QuadPart) < 0 || fflush(stdout)) goto done;
    /* The caller persists this identity and rechecks its cooperative
     * maintenance scope before GO. EOF executes no manager instruction. */
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
    if (!finished) {
        fprintf(stderr, "notifai: npm conversion was not completed (%s; Windows error %lu; admission bytes %lu; manager state %lu)\n",
            phase, failure_error, count, child.hProcess ? WaitForSingleObject(child.hProcess, 0) : WAIT_FAILED);
        fflush(stderr);
    }
    if (child.hProcess && !finished) {
        BOOL terminated = TerminateJobObject(job, 1);
        DWORD termination_error = terminated ? ERROR_SUCCESS : GetLastError();
        fprintf(stderr, "notifai: npm manager termination requested (%d; Windows error %lu)\n", terminated, termination_error);
        fflush(stderr);
        if (terminated) WaitForSingleObject(child.hProcess, INFINITE);
        status = 1;
    }
    if (child.hThread) CloseHandle(child.hThread);
    if (child.hProcess) CloseHandle(child.hProcess);
    if (job) CloseHandle(job);
    if (initialized) DeleteProcThreadAttributeList(attributes);
    free(attributes);
    for (int i = 0; i < 3; i++) if (inherited[i] != INVALID_HANDLE_VALUE) CloseHandle(inherited[i]);
    return (int)status;
}
