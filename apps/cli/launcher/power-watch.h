/*
 * `--internal-power-watch`: tells the hub, one line per event, that the
 * machine is going down (or that a shutdown was cancelled), so a conversation
 * the shutdown stops is not taken for one the User closed.
 *
 * macOS: loginwindow posts these notify(3) names in the system namespace when
 * a shutdown, restart or logout begins and when one is cancelled. Any process
 * may register for them through libSystem: no AppKit, no window server. One
 * line per post: `event <name> <wall ms>`. Nothing else is read or written,
 * there is no timer and no network. The watcher exits when its standard
 * input closes (the hub went away).
 *
 * Elsewhere it says so and exits: the hub watches logind itself on Linux.
 */
#ifdef __APPLE__
#include <notify.h>
#include <poll.h>
#include <arpa/inet.h>
#include <sys/time.h>

static const char *const power_names[] = {
    "com.apple.system.loginwindow.shutdownInitiated",
    "com.apple.system.loginwindow.restartinitiated",
    "com.apple.system.loginwindow.logoutInitiated",
    "com.apple.system.loginwindow.logoutcancelled",
    "com.apple.system.loginwindow.likelyShutdown",
    "com.apple.system.loginwindow.likelyUserSessionExit",
    "com.apple.system.loginwindow.shutdownNoReturn",
    "com.apple.system.loginwindow.logoutNoReturn",
    "com.apple.system.loginwindow.sulogoutinitiated",
    NULL,
};

static long long power_wall_ms(void) {
    struct timeval now;
    gettimeofday(&now, NULL);
    return (long long)now.tv_sec * 1000 + now.tv_usec / 1000;
}

static int power_watch(void) {
    int fd = -1, tokens[16], count = 0;
    for (int i = 0; power_names[i] && count < 16; i++) {
        int token;
        if (notify_register_file_descriptor(power_names[i], &fd, fd < 0 ? 0 : NOTIFY_REUSE, &token) != NOTIFY_STATUS_OK) {
            fprintf(stderr, "notifai: cannot watch %s\n", power_names[i]);
            return 1;
        }
        tokens[count++] = token;
    }
    if (printf("ready %lld\n", power_wall_ms()) < 0 || fflush(stdout)) return 1;
    for (;;) {
        struct pollfd waits[2] = { { fd, POLLIN, 0 }, { 0, POLLIN, 0 } };
        int n = poll(waits, 2, -1);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) return 1;
        if (waits[1].revents) {
            char sink[64];
            ssize_t got = read(0, sink, sizeof(sink));
            if (got <= 0) return 0; /* the hub is gone */
        }
        if (waits[0].revents & POLLIN) {
            int posted;
            if (read(fd, &posted, sizeof(posted)) != (ssize_t)sizeof(posted)) return 1;
            posted = (int)ntohl((uint32_t)posted);
            for (int i = 0; i < count; i++) {
                if (tokens[i] != posted) continue;
                if (printf("event %s %lld\n", power_names[i], power_wall_ms()) < 0 || fflush(stdout)) return 0;
            }
        }
    }
}
#else
static int power_watch(void) {
    fputs("unsupported\n", stdout);
    return 2;
}
#endif
