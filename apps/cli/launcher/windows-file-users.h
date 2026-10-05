/* Explicit uninstall observation only. Never call RmShutdown/RmRestart: the
 * installation coordinator withdraws only its own residents and preserves the
 * harness. PID and creation time come from the same RM_UNIQUE_PROCESS record. */
#include <restartmanager.h>
#pragma comment(lib, "Rstrtmgr.lib")

static int file_users(int count, wchar_t **files) {
    if (count < 1 || count > 8192) return 2;
    for (int i = 0; i < count; i++) if (!private_path(files[i], 0, 0)) return 1;
    DWORD session = 0;
    WCHAR key[CCH_RM_SESSION_KEY + 1] = {0};
    DWORD error = RmStartSession(&session, 0, key);
    if (error != ERROR_SUCCESS) { SetLastError(error); return 1; }
    error = RmRegisterResources(session, (UINT)count, (LPCWSTR *)files, 0, NULL, 0, NULL);
    RM_PROCESS_INFO *processes = NULL;
    UINT capacity = 0, used = 0, needed = 0;
    DWORD reasons = 0;
    if (error == ERROR_SUCCESS) {
        for (int attempt = 0; attempt < 8; attempt++) {
            used = capacity;
            error = RmGetList(session, &needed, &used, processes, &reasons);
            if (error != ERROR_MORE_DATA) break;
            if (needed <= capacity || needed > 8192) break;
            RM_PROCESS_INFO *grown = realloc(processes, (size_t)needed * sizeof(*processes));
            if (!grown) { error = ERROR_OUTOFMEMORY; break; }
            processes = grown;
            capacity = needed;
        }
    }
    DWORD ended = RmEndSession(session);
    if (error != ERROR_SUCCESS || ended != ERROR_SUCCESS || used > capacity) {
        free(processes);
        SetLastError(error != ERROR_SUCCESS ? error : ended);
        return 1;
    }
    printf("{\"reboot_reasons\":%lu,\"processes\":[", reasons);
    for (UINT i = 0; i < used; i++) {
        ULARGE_INTEGER start;
        start.LowPart = processes[i].Process.ProcessStartTime.dwLowDateTime;
        start.HighPart = processes[i].Process.ProcessStartTime.dwHighDateTime;
        printf("%s{\"pid\":%lu,\"start\":\"windows-filetime:%llu\",\"session\":%lu}",
            i ? "," : "", processes[i].Process.dwProcessId, start.QuadPart, processes[i].TSSessionId);
    }
    puts("]}");
    free(processes);
    return 0;
}
