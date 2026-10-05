/* Native integration fixture. Writes only a random disposable HKCU subkey;
 * never changes the actual User PATH or broadcasts a fixture environment. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include "windows-user-path.h"

static void value(user_path_value *result, DWORD type, const wchar_t *text) {
    result->type = type;
    result->bytes = (DWORD)((wcslen(text) + 1) * sizeof(wchar_t));
    memcpy(result->data, text, result->bytes);
}
#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "User PATH check failed at line %d\n", __LINE__); goto done; } } while (0)
int wmain(int argc, wchar_t **argv) {
    /* Compile the production command boundary too; explicit diagnostic only. */
    if (argc == 2 && !wcscmp(argv[1], L"read")) return user_path_command(0) ? 0 : 1;
    wchar_t name[256];
    swprintf(name, 256, L"Software\\NotifaiPathFixture-%lu-%llu", GetCurrentProcessId(), GetTickCount64());
    HKEY key = NULL;
    user_path_value *before = calloc(1, sizeof(*before)), *next = calloc(1, sizeof(*next)), *after = calloc(1, sizeof(*after));
    int result = 1, created = 0;
    CHECK(before && next && after);
    DWORD disposition = 0;
    CHECK(RegCreateKeyExW(HKEY_CURRENT_USER, name, 0, NULL, 0, KEY_ALL_ACCESS, NULL, &key, &disposition) == ERROR_SUCCESS);
    CHECK(disposition == REG_CREATED_NEW_KEY);
    created = 1;
    CHECK(user_path_read(key, before) && before->type == 0);
    value(next, REG_EXPAND_SZ, L"%USERPROFILE%\\Tools;C:\\Owned dir");
    CHECK(user_path_write(key, before, next));
    CHECK(user_path_read(key, after) && user_path_equal(after, next));
    /* A stale caller cannot overwrite an intervening edit. */
    CHECK(!user_path_write(key, before, next));
    memcpy(before, after, sizeof(*before));
    value(next, REG_SZ, L"C:\\User edit;;%UNCHANGED%");
    CHECK(user_path_write(key, before, next));
    CHECK(user_path_read(key, after) && user_path_equal(after, next));
    CHECK(after->type == REG_SZ);
    /* Wrong registry types and malformed nonterminated strings are refused. */
    DWORD number = 4;
    CHECK(RegSetValueExW(key, L"Path", 0, REG_DWORD, (const BYTE *)&number, sizeof(number)) == ERROR_SUCCESS);
    CHECK(!user_path_read(key, after));
    /* Do not rely on how Windows normalizes a malformed string supplied to
     * RegSetValueExW (its contract requires the terminator). Validate malformed
     * raw input before it reaches that API instead. */
    value(next, REG_SZ, L"abc");
    next->bytes -= (DWORD)sizeof(wchar_t);
    CHECK(!user_path_valid(next, 0));
    value(next, REG_SZ, L"abc");
    ((wchar_t *)next->data)[1] = 0;
    CHECK(!user_path_valid(next, 0));
    result = 0;
    puts("User PATH native storage checks passed (isolated registry key).");
done:
    if (key) { if (created) RegDeleteValueW(key, L"Path"); RegCloseKey(key); if (created) RegDeleteKeyW(HKEY_CURRENT_USER, name); }
    free(before); free(next); free(after);
    return result;
}
