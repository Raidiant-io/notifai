/* Extended Win32 paths avoid MAX_PATH without changing machine policy.
 * Callers supply absolute, normalized filesystem paths. Namespace paths do
 * not interpret slash, dot or dot-dot components like ordinary Win32 paths.
 * https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation */
static int filesystem_path(const wchar_t *input, wchar_t *output) {
    size_t length = wcslen(input);
    if (length < 3 || length > 32759 || wcschr(input, L'/')) return 0;
    const wchar_t *component = input;
    for (const wchar_t *cursor = input; ; cursor++) {
        if (*cursor == L'\\' || !*cursor) {
            size_t n = (size_t)(cursor - component);
            if ((n == 1 && component[0] == L'.') ||
                (n == 2 && component[0] == L'.' && component[1] == L'.')) return 0;
            component = cursor + 1;
        }
        if (!*cursor) break;
    }
    if (!wcsncmp(input, L"\\\\?\\", 4)) {
        wcscpy(output, input);
        return 1;
    }
    if (input[0] == L'\\' && input[1] == L'\\') {
        swprintf(output, 32768, L"\\\\?\\UNC\\%ls", input + 2);
        return 1;
    }
    if (((input[0] >= L'A' && input[0] <= L'Z') || (input[0] >= L'a' && input[0] <= L'z')) &&
        input[1] == L':' && input[2] == L'\\') {
        swprintf(output, 32768, L"\\\\?\\%ls", input);
        return 1;
    }
    return 0;
}
