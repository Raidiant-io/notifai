/* Explicit installer adapter only. No ordinary launcher path reads or writes
 * the registry. Raw UTF-16 bytes preserve REG_EXPAND_SZ without expansion. */
#include <winreg.h>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "user32.lib")
#define USER_PATH_BYTES 65536

typedef struct { DWORD type; DWORD bytes; BYTE data[USER_PATH_BYTES]; } user_path_value;

static int user_path_valid(const user_path_value *value, int allow_absent) {
    if (!value->type) return allow_absent && !value->bytes;
    if ((value->type != REG_SZ && value->type != REG_EXPAND_SZ) ||
        value->bytes < sizeof(wchar_t) || value->bytes > USER_PATH_BYTES || value->bytes % sizeof(wchar_t)) return 0;
    const wchar_t *text = (const wchar_t *)value->data;
    size_t count = value->bytes / sizeof(wchar_t);
    if (text[count - 1] != 0) return 0;
    for (size_t i = 0; i + 1 < count; i++) if (!text[i]) return 0;
    return 1;
}
static int user_path_read(HKEY key, user_path_value *value) {
    value->type = 0; value->bytes = USER_PATH_BYTES;
    LSTATUS status = RegQueryValueExW(key, L"Path", NULL, &value->type, value->data, &value->bytes);
    if (status == ERROR_FILE_NOT_FOUND) { value->type = 0; value->bytes = 0; return 1; }
    return status == ERROR_SUCCESS && user_path_valid(value, 0);
}
static int user_path_equal(const user_path_value *left, const user_path_value *right) {
    return left->type == right->type && left->bytes == right->bytes && !memcmp(left->data, right->data, left->bytes);
}
static int user_path_write(HKEY key, const user_path_value *expected, const user_path_value *next) {
    if (!user_path_valid(expected, 1) || !user_path_valid(next, 0)) return 0;
    user_path_value *current = malloc(sizeof(*current));
    if (!current) return 0;
    /* Optimistic guard, not an OS compare-and-swap. Registry values cannot be
     * locked against unrelated editors. Installation serializes its own writers. */
    int ok = user_path_read(key, current) && user_path_equal(expected, current);
    if (ok) ok = RegSetValueExW(key, L"Path", 0, next->type, next->data, next->bytes) == ERROR_SUCCESS;
    if (ok) ok = user_path_read(key, current) && user_path_equal(next, current);
    free(current);
    return ok;
}
static int user_path_hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}
static int user_path_input(user_path_value *value) {
    char *line = malloc(USER_PATH_BYTES * 2 + 16);
    if (!line) return 0;
    int ok = 0;
    if (!fgets(line, USER_PATH_BYTES * 2 + 16, stdin)) goto done;
    size_t length = strlen(line);
    if (length < 3 || line[length - 1] != '\n' || line[1] != ' ' ||
        (line[0] != '0' && line[0] != '1' && line[0] != '2')) goto done;
    value->type = (DWORD)(line[0] - '0');
    size_t hex_length = length - 3;
    if (hex_length % 2 || hex_length > USER_PATH_BYTES * 2) goto done;
    value->bytes = (DWORD)(hex_length / 2);
    for (DWORD i = 0; i < value->bytes; i++) {
        int high = user_path_hex(line[2 + i * 2]), low = user_path_hex(line[3 + i * 2]);
        if (high < 0 || low < 0) goto done;
        value->data[i] = (BYTE)((high << 4) | low);
    }
    ok = user_path_valid(value, 1);
done:
    free(line);
    return ok;
}
static int user_path_command(int write) {
    user_path_value *current = malloc(sizeof(*current)), *next = malloc(sizeof(*next));
    HKEY key = NULL;
    int ok = 0;
    if (!current || !next) goto done;
    if (write && (!user_path_input(current) || !user_path_input(next) || fgetc(stdin) != EOF)) goto done;
    LSTATUS opened = write
        ? RegCreateKeyExW(HKEY_CURRENT_USER, L"Environment", 0, NULL, 0, KEY_QUERY_VALUE | KEY_SET_VALUE, NULL, &key, NULL)
        : RegOpenKeyExW(HKEY_CURRENT_USER, L"Environment", 0, KEY_QUERY_VALUE, &key);
    if (!write && opened == ERROR_FILE_NOT_FOUND) { current->type = 0; current->bytes = 0; ok = 1; }
    else if (opened != ERROR_SUCCESS) goto done;
    else ok = write ? user_path_write(key, current, next) : user_path_read(key, current);
    if (!ok) goto done;
    if (write) {
        DWORD_PTR result = 0;
        int notified = SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)L"Environment",
            SMTO_ABORTIFHUNG | SMTO_BLOCK, 100, &result) != 0;
        printf("{\"ok\":true,\"notified\":%s}\n", notified ? "true" : "false");
    } else {
        printf("{\"type\":%lu,\"hex\":\"", current->type);
        for (DWORD i = 0; i < current->bytes; i++) printf("%02x", (unsigned int)current->data[i]);
        puts("\"}");
    }
done:
    if (key) RegCloseKey(key);
    free(current); free(next);
    return ok;
}
