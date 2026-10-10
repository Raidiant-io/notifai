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

typedef enum { PACKAGE_ACCESS_NONE, PACKAGE_ACCESS_NPM, PACKAGE_ACCESS_STATE } package_access_scope;

/* A packaged app's npm and local state inherit its exact package-capability ACE.
 * Windows intersects that capability with ordinary User/group access. Scope
 * this accommodation to the registered current-User package's physical path
 * for the requested purpose. Native installation paths never accept it.
 * https://learn.microsoft.com/windows/win32/secauthz/implementing-an-appcontainer
 * https://github.com/microsoft/WindowsAppSDK/discussions/5368 */
static PSID scoped_package_capability(HANDLE handle, package_access_scope scope) {
    if (scope == PACKAGE_ACCESS_NONE) return NULL;
    wchar_t physical[32768], home[32768], prefix[32768];
    DWORD length = GetFinalPathNameByHandleW(handle, physical, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (!length || length >= 32768) return NULL;
    HANDLE token = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
    length = 32768;
    BOOL ok = GetUserProfileDirectoryW(token, home, &length);
    CloseHandle(token);
    if (!ok) return NULL;
    HANDLE profile = CreateFileW(home, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (profile == INVALID_HANDLE_VALUE) return NULL;
    length = GetFinalPathNameByHandleW(profile, prefix, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    CloseHandle(profile);
    if (!length || length > 32000) return NULL;
    wcscat(prefix, L"\\AppData\\Local\\Packages\\");
    size_t n = wcslen(prefix);
    if (_wcsnicmp(physical, prefix, n)) return NULL;
    const wchar_t *family = physical + n, *end = wcschr(family, L'\\');
    if (!end || end == family || end - family > 255) return NULL;
    const wchar_t *suffix = scope == PACKAGE_ACCESS_NPM ? L"\\LocalCache\\Roaming\\npm" : L"\\LocalCache\\Local\\notifai";
    size_t suffix_length = wcslen(suffix);
    if (_wcsnicmp(end, suffix, suffix_length) || (end[suffix_length] && end[suffix_length] != L'\\')) return NULL;
    wchar_t name[256];
    wmemcpy(name, family, (size_t)(end - family));
    name[end - family] = 0;
    UINT32 count = 0, bytes = 0;
    LONG status = GetPackagesByPackageFamily(name, &count, NULL, &bytes, NULL);
    if (status != ERROR_INSUFFICIENT_BUFFER || !count || !bytes) return NULL;
    PSID sid = NULL;
    if (FAILED(DeriveAppContainerSidFromAppContainerName(name, &sid))) return NULL;
    if (!sid || !IsValidSid(sid) || *GetSidSubAuthorityCount(sid) != 8 ||
        *GetSidSubAuthority(sid, 0) != SECURITY_APP_PACKAGE_BASE_RID) { FreeSid(sid); return NULL; }
    *GetSidSubAuthority(sid, 0) = SECURITY_CAPABILITY_BASE_RID;
    return sid;
}

static int private_handle(HANDLE handle, int directory, PSID user, int created, int require_protected, PSID package_owner, PSID capability) {
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
        (EqualSid(owner, user) || (created && IsWellKnownSid(owner, WinBuiltinAdministratorsSid)) ||
         (package_owner && EqualSid(owner, package_owner))) &&
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
        if ((mask & writes) && !approved_writer((PSID)&ace->SidStart, user) &&
            !(capability && EqualSid((PSID)&ace->SidStart, capability))) ok = 0;
    }
    if (ok && created && !EqualSid(owner, user)) {
        ok = SetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
            user, NULL, NULL, NULL) == ERROR_SUCCESS;
    }
    LocalFree(descriptor);
    return ok && (!created || private_handle(handle, directory, user, 0, 1, NULL, NULL));
}

static int checked_path(const wchar_t *input, int directory, int created, int require_protected, PSID package_owner, package_access_scope scope) {
    wchar_t path[32768];
    if (!filesystem_path(input, path)) return 0;
    TOKEN_USER *user = installation_user();
    if (!user) return 0;
    HANDLE handle = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES | (created ? WRITE_OWNER : 0),
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
    PSID capability = handle != INVALID_HANDLE_VALUE ? scoped_package_capability(handle, scope) : NULL;
    int ok = handle != INVALID_HANDLE_VALUE && private_handle(handle, directory, user->User.Sid, created, require_protected, package_owner, capability);
    if (capability) FreeSid(capability);
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    free(user);
    return ok;
}

static int private_path(const wchar_t *input, int directory, int created) {
    return checked_path(input, directory, created, 1, NULL, PACKAGE_ACCESS_NONE);
}

/* Existing shared session state need not use installation-style protected
 * inheritance. It must still have the exact User owner and no foreign writer.
 * Read-only inspection never changes that state's ACL. */
static int owned_state_path(const wchar_t *input, int directory) {
    return checked_path(input, directory, 0, 0, NULL, PACKAGE_ACCESS_STATE);
}

/* npm owns its directories and normally inherits safe ACLs. Inspection must
 * not protect or otherwise rewrite them. Elevated npm can create objects with
 * the token's default Administrators owner: admit that owner only when it is
 * this process token's actual default. All writer and reparse checks still
 * apply. This exception never applies to managed installations or state. */
static int owned_package_path(const wchar_t *input, int directory) {
    HANDLE token = NULL;
    DWORD bytes = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
    GetTokenInformation(token, TokenOwner, NULL, 0, &bytes);
    if (!bytes || bytes > 65536) { CloseHandle(token); return 0; }
    TOKEN_OWNER *owner = malloc(bytes);
    if (!owner || !GetTokenInformation(token, TokenOwner, owner, bytes, &bytes)) {
        free(owner); CloseHandle(token); return 0;
    }
    PSID alternate = owner->Owner && IsValidSid(owner->Owner) &&
        IsWellKnownSid(owner->Owner, WinBuiltinAdministratorsSid) ? owner->Owner : NULL;
    int ok = checked_path(input, directory, 0, 0, alternate, PACKAGE_ACCESS_NPM);
    free(owner); CloseHandle(token);
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
    int ok = handle != INVALID_HANDLE_VALUE && private_handle(handle, 1, user->User.Sid, 0, 0, NULL, NULL);
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
    if (ok) ok = private_handle(handle, 1, user->User.Sid, 0, 1, NULL, NULL) &&
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
