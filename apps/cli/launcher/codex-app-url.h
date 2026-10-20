/*
 * `--internal-codex-app-url <pid> <url>`: hands one `codex://threads/wake/…`
 * link to the running Codex app, addressed to exactly that process.
 *
 * macOS only. A get-URL Apple Event (`GURL`/`GURL`) addressed by process id
 * reaches that process or nothing: it can never launch the app, so a Codex
 * app that quit in the meantime is not started. Nothing is sent when macOS
 * would first ask the User to let Notifai control the app (an Automation
 * prompt): the hub then decides another way, and the User never sees a
 * prompt from this. CoreServices is loaded only here, at run time, so no
 * other launcher command pays for it.
 *
 * Exit status: 0 sent; 3 not sent, macOS would ask the User first (or the
 * User said no); 4 not sent, no such process; 2 bad arguments or not macOS;
 * 1 any other failure. Prints nothing.
 */
#ifdef __APPLE__
#include <dlfcn.h>
#include <stdint.h>

typedef uint32_t codex_ae_type;
typedef struct codex_ae_storage *codex_ae_handle;
#pragma pack(push, 2)
typedef struct { codex_ae_type descriptorType; codex_ae_handle dataHandle; } codex_ae_desc;
#pragma pack(pop)

#define CODEX_FOUR(a, b, c, d) (((uint32_t)(a) << 24) | ((uint32_t)(b) << 16) | ((uint32_t)(c) << 8) | (uint32_t)(d))

typedef int16_t (*codex_ae_create_desc)(codex_ae_type, const void *, long, codex_ae_desc *);
typedef int16_t (*codex_ae_create_event)(codex_ae_type, codex_ae_type, const codex_ae_desc *, int16_t, int32_t, codex_ae_desc *);
typedef int16_t (*codex_ae_put_param)(codex_ae_desc *, codex_ae_type, codex_ae_type, const void *, long);
typedef int32_t (*codex_ae_send)(const codex_ae_desc *, codex_ae_desc *, int32_t, long);
typedef int16_t (*codex_ae_dispose)(codex_ae_desc *);
typedef int32_t (*codex_ae_permission)(const codex_ae_desc *, codex_ae_type, codex_ae_type, unsigned char);

static int codex_app_url(const char *pid_text, const char *url) {
    char *end = NULL;
    long pid = strtol(pid_text, &end, 10);
    if (!end || *end || pid <= 1 || pid > INT32_MAX) return 2;
    if (strncmp(url, "codex://threads/wake/", 21) || strlen(url) > 200) return 2;
    for (const char *c = url; *c; c++) if ((unsigned char)*c <= 0x20 || (unsigned char)*c >= 0x7f) return 2;
    if (kill((pid_t)pid, 0) != 0 && errno == ESRCH) return 4;
    void *library = dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", RTLD_LAZY | RTLD_LOCAL);
    if (!library) return 1;
    codex_ae_create_desc create_desc = (codex_ae_create_desc)dlsym(library, "AECreateDesc");
    codex_ae_create_event create_event = (codex_ae_create_event)dlsym(library, "AECreateAppleEvent");
    codex_ae_put_param put_param = (codex_ae_put_param)dlsym(library, "AEPutParamPtr");
    codex_ae_send send = (codex_ae_send)dlsym(library, "AESendMessage");
    codex_ae_dispose dispose = (codex_ae_dispose)dlsym(library, "AEDisposeDesc");
    codex_ae_permission permission = (codex_ae_permission)dlsym(library, "AEDeterminePermissionToAutomateTarget");
    if (!create_desc || !create_event || !put_param || !send || !dispose || !permission) return 1;

    const codex_ae_type kpid = CODEX_FOUR('k', 'p', 'i', 'd'), gurl = CODEX_FOUR('G', 'U', 'R', 'L');
    const codex_ae_type direct = CODEX_FOUR('-', '-', '-', '-'), utf8 = CODEX_FOUR('u', 't', 'f', '8');
    int32_t target_pid = (int32_t)pid;
    codex_ae_desc target = {0, NULL}, event = {0, NULL}, reply = {0, NULL};
    if (create_desc(kpid, &target_pid, sizeof target_pid, &target) != 0) return 1;
    /* Never ask: a prompt the User did not expect is worse than no wake. */
    int32_t allowed = permission(&target, gurl, gurl, 0);
    int status = 1;
    if (allowed == -1744 || allowed == -1743) status = 3;      /* would ask / refused */
    else if (allowed == -600 || allowed == -609) status = 4;   /* no such process */
    else if (allowed == 0) {
        if (create_event(gurl, gurl, &target, -1, 0, &event) == 0 &&
            put_param(&event, direct, utf8, url, (long)strlen(url)) == 0) {
            /* kAENoReply | kAENeverInteract | kAEDontReconnect, 10 s. */
            int32_t sent = send(&event, &reply, 0x00000001 | 0x00000030 | 0x00000080, 600);
            status = sent == 0 ? 0 : (sent == -600 || sent == -609) ? 4 : (sent == -1743 || sent == -1744) ? 3 : 1;
        }
        if (event.dataHandle) dispose(&event);
        if (reply.dataHandle) dispose(&reply);
    }
    dispose(&target);
    return status;
}
#else
static int codex_app_url(const char *pid_text, const char *url) {
    (void)pid_text;
    (void)url;
    return 2;
}
#endif
