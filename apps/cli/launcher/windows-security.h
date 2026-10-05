/* Per-user installation access policy. Handles never follow a final reparse
 * point; callers check each managed parent separately. No chmod claims on NTFS. */
#include <aclapi.h>
#include <sddl.h>
#pragma comment(lib, "advapi32.lib")

static TOKEN_USER *installation_user(void) {
    HANDLE token = NULL;
    DWORD bytes = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
    GetTokenInformation(token, TokenUser, NULL, 0, &bytes);
    if (!bytes || bytes > 65536) { CloseHandle(token); return NULL; }
    TOKEN_USER *user = malloc(bytes);
    if (!user || !GetTokenInformation(token, TokenUser, user, bytes, &bytes)) {
        free(user); CloseHandle(token); return NULL;
    }
    CloseHandle(token);
    return user;
}

static int approved_writer(PSID sid, PSID user) {
    return EqualSid(sid, user) || IsWellKnownSid(sid, WinLocalSystemSid) ||
        IsWellKnownSid(sid, WinBuiltinAdministratorsSid);
}

static int private_handle(HANDLE handle, int directory, PSID user, int created, int require_protected) {
    FILE_ATTRIBUTE_TAG_INFO info;
    if (GetFileType(handle) != FILE_TYPE_DISK ||
        !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) ||
        (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        !!(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != !!directory) return 0;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL;
    PACL dacl = NULL;
    DWORD error = GetSecurityInfo(handle, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &dacl, NULL, &descriptor);
    if (error != ERROR_SUCCESS) return 0;
    int ok = owner && IsValidSid(owner) &&
        (EqualSid(owner, user) || (created && IsWellKnownSid(owner, WinBuiltinAdministratorsSid))) &&
        dacl && IsValidAcl(dacl);
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    if (directory && require_protected && (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
        !(control & SE_DACL_PROTECTED))) ok = 0;
    const DWORD writes = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
        FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL;
    for (DWORD i = 0; ok && i < dacl->AceCount; i++) {
        ACE_HEADER *header = NULL;
        if (!GetAce(dacl, i, (LPVOID *)&header)) { ok = 0; break; }
        if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { ok = 0; break; }
        ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
        /* Inherit-only permissions are also checked: child files must not
         * acquire an unapproved writer through this directory. */
        DWORD mask = ace->Mask;
        GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
        MapGenericMask(&mask, &mapping);
        if ((mask & writes) && !approved_writer((PSID)&ace->SidStart, user)) ok = 0;
    }
    if (ok && created && !EqualSid(owner, user)) {
        ok = SetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
            user, NULL, NULL, NULL) == ERROR_SUCCESS;
    }
    LocalFree(descriptor);
    return ok && (!created || private_handle(handle, directory, user, 0, 1));
}

static int private_path(const wchar_t *input, int directory, int created) {
    wchar_t path[32768];
    if (!filesystem_path(input, path)) return 0;
    TOKEN_USER *user = installation_user();
    if (!user) return 0;
    HANDLE handle = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES | (created ? WRITE_OWNER : 0),
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
    int ok = handle != INVALID_HANDLE_VALUE && private_handle(handle, directory, user->User.Sid, created, 1);
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    free(user);
    return ok;
}

static int create_private_directory(const wchar_t *input) {
    wchar_t path[32768];
    if (!filesystem_path(input, path)) return 0;
    if (GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES) return private_path(path, 1, 0);
    TOKEN_USER *user = installation_user();
    if (!user) return 0;
    LPWSTR sid = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    int ok = 0;
    if (ConvertSidToStringSidW(user->User.Sid, &sid)) {
        wchar_t sddl[1024];
        int length = swprintf(sddl, 1024, L"O:%lsD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;%ls)", sid, sid);
        if (length > 0 && length < 1024 && ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, SDDL_REVISION_1, &descriptor, NULL)) {
            SECURITY_ATTRIBUTES attributes = { sizeof(attributes), descriptor, FALSE };
            ok = CreateDirectoryW(path, &attributes) || GetLastError() == ERROR_ALREADY_EXISTS;
        }
    }
    LocalFree(descriptor); LocalFree(sid); free(user);
    return ok && private_path(path, 1, 0);
}


/* Explicit migration only. Accept the existing owner and every ACE before
 * protecting inheritance. Never remove an unapproved principal to make an
 * unsafe directory appear safe. MAXIMUM_ALLOWED has a documented, intentional
 * SetSecurityInfo property: inheritable ACEs are NOT propagated to children.
 * https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo
 * This short-lived handle is used only for this object's read/set/readback. */
static int protect_existing_directory(const wchar_t *input) {
    wchar_t path[32768];
    if (!filesystem_path(input, path)) return 0;
    TOKEN_USER *user = installation_user();
    if (!user) return 0;
    HANDLE handle = CreateFileW(path, MAXIMUM_ALLOWED, FILE_SHARE_READ | FILE_SHARE_WRITE,
        NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
    PSECURITY_DESCRIPTOR before = NULL, after = NULL;
    PACL original = NULL, actual = NULL, expected = NULL;
    PSID owner = NULL;
    int ok = handle != INVALID_HANDLE_VALUE && private_handle(handle, 1, user->User.Sid, 0, 0);
    if (ok) ok = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &original, NULL, &before) == ERROR_SUCCESS && owner && EqualSid(owner, user->User.Sid) &&
        original && IsValidAcl(original);
    if (ok) {
        SECURITY_DESCRIPTOR_CONTROL control = 0;
        DWORD revision = 0;
        ok = GetSecurityDescriptorControl(before, &control, &revision);
        if (ok && (control & SE_DACL_PROTECTED)) goto finished;
    }
    if (ok) {
        expected = malloc(original->AclSize);
        ok = expected != NULL;
    }
    if (ok) {
        memcpy(expected, original, original->AclSize);
        for (DWORD i = 0; ok && i < expected->AceCount; i++) {
            ACE_HEADER *ace = NULL;
            ok = GetAce(expected, i, (LPVOID *)&ace);
            if (ok) ace->AceFlags &= (BYTE)~INHERITED_ACE;
        }
    }
    if (ok) ok = SetSecurityInfo(handle, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        NULL, NULL, expected, NULL) == ERROR_SUCCESS;
    if (ok) ok = private_handle(handle, 1, user->User.Sid, 0, 1) &&
        GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            NULL, NULL, &actual, NULL, &after) == ERROR_SUCCESS && actual && IsValidAcl(actual) &&
        actual->AceCount == expected->AceCount;
    for (DWORD i = 0; ok && i < expected->AceCount; i++) {
        ACE_HEADER *wanted = NULL, *got = NULL;
        ok = GetAce(expected, i, (LPVOID *)&wanted) && GetAce(actual, i, (LPVOID *)&got) &&
            wanted->AceSize == got->AceSize && !memcmp(wanted, got, wanted->AceSize);
    }
finished:
    LocalFree(before); LocalFree(after); free(expected);
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    free(user);
    return ok;
}
