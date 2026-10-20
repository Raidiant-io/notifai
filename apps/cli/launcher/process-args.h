/*
 * `--internal-process-args <pid>`: one of this account's processes' exact
 * command line, each word followed by a NUL byte. The hub reads it once when
 * a terminal conversation registers, so a later reopen can start the harness
 * with the same options. `ps` joins the words with spaces, which loses where
 * one ends; the kernel's own copy does not. macOS only: Linux reads
 * `/proc/<pid>/cmdline` directly. Exits 1 when the process cannot be read.
 */
#ifdef __APPLE__
static int process_args(const char *text) {
    char *end;
    errno = 0;
    long pid = strtol(text, &end, 10);
    if (errno || end == text || *end || pid <= 1 || pid > 0x7fffffff) return 2;
    int argmax = 0;
    size_t size = sizeof(argmax);
    int max_mib[2] = { CTL_KERN, KERN_ARGMAX };
    if (sysctl(max_mib, 2, &argmax, &size, NULL, 0) || argmax <= (int)sizeof(int)) return 1;
    char *buffer = malloc((size_t)argmax);
    if (!buffer) return 1;
    int mib[3] = { CTL_KERN, KERN_PROCARGS2, (int)pid };
    size = (size_t)argmax;
    if (sysctl(mib, 3, buffer, &size, NULL, 0) || size <= sizeof(int)) { free(buffer); return 1; }
    int count;
    memcpy(&count, buffer, sizeof(count));
    char *cursor = buffer + sizeof(int), *limit = buffer + size;
    /* The executable path, then NUL padding, then the arguments. */
    while (cursor < limit && *cursor) cursor++;
    while (cursor < limit && !*cursor) cursor++;
    if (count <= 0) { free(buffer); return 1; }
    for (int index = 0; index < count; index++) {
        char *word = cursor;
        while (cursor < limit && *cursor) cursor++;
        if (cursor >= limit) { free(buffer); return 1; }
        cursor++;
        if (fwrite(word, 1, (size_t)(cursor - word), stdout) != (size_t)(cursor - word)) { free(buffer); return 1; }
    }
    free(buffer);
    return fflush(stdout) ? 1 : 0;
}
#else
static int process_args(const char *text) {
    (void)text;
    return 2;
}
#endif
