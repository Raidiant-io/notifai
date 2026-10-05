/* Explicit uninstall observation. Never signal a process. The launch barrier
 * must already be closed before a caller uses this bounded snapshot. This
 * per-account installation observes processes with its effective UID. Root and
 * other account execution are outside that installation ownership boundary. */
#include <dirent.h>
#include <signal.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/sysctl.h>
#endif

static int matches_executable(const struct stat *info, const struct stat *files, int count) {
    for (int i = 0; i < count; i++)
        if (info->st_dev == files[i].st_dev && info->st_ino == files[i].st_ino) return 1;
    return 0;
}

static int file_users(int count, char **names) {
    if (count < 1 || count > 8192) return 2;
    struct stat *files = calloc((size_t)count, sizeof(*files));
    if (!files) return 1;
    for (int i = 0; i < count; i++) {
        if (!owned_path(names[i], 0) || stat(names[i], &files[i])) { free(files); return 1; }
    }
    int result = 1, written = 0;
    /* Failed scans deliberately leave invalid/incomplete output and fail. */
    printf("{\"reboot_reasons\":0,\"processes\":[");
#ifdef __APPLE__
    /* sysctl supplies credentials without asking libproc to inspect foreign
     * processes. libproc is SDK SPI: any unavailable/changed result retains.
     * PID/start revalidation bounds reuse around the executable-path lookup. */
    int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
    struct kinfo_proc *processes = NULL;
    size_t size = 0;
    int complete = 0;
    for (int attempt = 0; attempt < 5; attempt++) {
        size_t needed = 0;
        if (sysctl(mib, 4, NULL, &needed, NULL, 0) || needed > 16 * 1024 * 1024) break;
        size = needed + 64 * sizeof(*processes);
        struct kinfo_proc *grown = realloc(processes, size);
        if (!grown) break;
        processes = grown;
        if (!sysctl(mib, 4, processes, &size, NULL, 0)) { complete = 1; break; }
        if (errno != ENOMEM) break;
    }
    if (!complete || size % sizeof(*processes)) goto done_macos;
    for (size_t i = 0; i < size / sizeof(*processes); i++) {
        struct kinfo_proc *snapshot = &processes[i];
        if (snapshot->kp_eproc.e_ucred.cr_uid != getuid()) continue;
        pid_t pid = snapshot->kp_proc.p_pid;
        if (pid <= 0) continue;
        struct proc_bsdinfo before, after;
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)) {
            if (kill(pid, 0) && errno == ESRCH) continue;
            fprintf(stderr, "notifai: cannot inspect process %d identity (%d)\n", pid, errno);
            goto done_macos;
        }
        /* A zombie has no mapped executable and cannot resume. */
        if (before.pbi_status == SZOMB) continue;
        if (before.pbi_uid != getuid())
            goto done_macos;
        char executable[PROC_PIDPATHINFO_MAXSIZE];
        struct stat image;
        int found = proc_pidpath(pid, executable, sizeof(executable));
        int inspected = found > 0 && !stat(executable, &image);
        int image_error = inspected ? 0 : errno;
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)) {
            if (kill(pid, 0) && errno == ESRCH) continue;
            fprintf(stderr, "notifai: cannot recheck process %d identity (%d)\n", pid, errno);
            goto done_macos;
        }
        if (after.pbi_status == SZOMB) continue;
        if (!inspected) { fprintf(stderr, "notifai: cannot inspect process %d image (%d)\n", pid, image_error); goto done_macos; }
        if (before.pbi_pid != after.pbi_pid || before.pbi_start_tvsec != after.pbi_start_tvsec ||
            before.pbi_start_tvusec != after.pbi_start_tvusec || before.pbi_uid != after.pbi_uid ||
            before.pbi_ruid != after.pbi_ruid || before.pbi_svuid != after.pbi_svuid) goto done_macos;
        if (matches_executable(&image, files, count)) printf("%s{\"pid\":%d}", written++ ? "," : "", pid);
    }
    result = 0;
done_macos:
    free(processes);
#else
    DIR *processes = opendir("/proc");
    if (!processes) goto done_linux;
    struct dirent *entry;
    for (;;) {
        errno = 0;
        entry = readdir(processes);
        if (!entry) { if (!errno) result = 0; break; }
        char *end;
        long pid = strtol(entry->d_name, &end, 10);
        if (!*entry->d_name || *end || pid <= 0 || pid > INT_MAX) continue;
        int process_fd = openat(dirfd(processes), entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (process_fd < 0) { if (errno == ENOENT || errno == ESRCH) continue; break; }
        int status_fd = openat(process_fd, "status", O_RDONLY | O_NOFOLLOW);
        if (status_fd < 0) {
            int gone = errno == ENOENT || errno == ESRCH;
            close(process_fd);
            if (gone) continue;
            break;
        }
        FILE *status = fdopen(status_fd, "r");
        if (!status) { close(status_fd); close(process_fd); break; }
        char line[4096], state = 0;
        unsigned int real_uid = 0, effective_uid = 0, saved_uid = 0, filesystem_uid = 0;
        int has_uids = 0;
        while (fgets(line, sizeof(line), status)) {
            if (!strncmp(line, "Uid:", 4)) has_uids = sscanf(line + 4, "%u%u%u%u", &real_uid, &effective_uid, &saved_uid, &filesystem_uid) == 4;
            if (!strncmp(line, "State:", 6)) (void)sscanf(line + 6, " %c", &state);
        }
        int failed = ferror(status);
        fclose(status);
        if (failed || !has_uids || !state) { close(process_fd); break; }
        if (state == 'Z' || effective_uid != getuid()) {
            close(process_fd); continue;
        }
        /* fstatat follows the proc exe magic link through the pinned proc FD;
         * it observes executable inode identity even after rename/unlink. */
        struct stat image;
        if (fstatat(process_fd, "exe", &image, 0)) {
            int error = errno;
            struct stat still_exists;
            int gone = fstatat(process_fd, "status", &still_exists, 0) && (errno == ENOENT || errno == ESRCH);
            close(process_fd);
            if (gone || error == ESRCH) continue;
            break;
        }
        close(process_fd);
        if (matches_executable(&image, files, count)) printf("%s{\"pid\":%ld}", written++ ? "," : "", pid);
    }
    closedir(processes);
done_linux:
#endif
    free(files);
    if (!result) puts("]}");
    else fprintf(stderr, "notifai: process inspection is incomplete; retain installation files\n");
    return result;
}
