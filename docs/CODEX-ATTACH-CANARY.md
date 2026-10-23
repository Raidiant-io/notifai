# Codex shared-server check

A plain `codex` terminal joins Codex's shared server (the managed app-server
daemon). When that terminal closes, Codex keeps the conversation loaded for
about 30 minutes and runs no hook and sends no notification. A content-free
wake queued there would start a turn nobody sees. So on the shared server
Notifai wakes an idle session only when it can see that a terminal still
shows the conversation, and treats a conversation no terminal shows as
closed by the User.

## The signal (`apps/cli/src/codex-attach-signal.ts`)

`codexThreadAttachState()` answers `attached`, `closed`, `not-loaded` or
`unknown` for one thread, with `confirmed` set when the confirming request
decided it.

1. **Passive check** (15–80 ms, no side effects). Each plain `codex` terminal
   runs a `codex_tui` MCP server on a localhost port, and
   `mcpServerStatus/list {threadId, serverName: "codex_tui"}` names that port
   for every thread the terminal loaded. The thread counts as shown when one
   `netstat` (macOS) or `ss` (Linux) call finds a live `codex` listening there,
   that process started before the thread's last load (the mtime of
   `thread-writer-locks/<id>.lock`, rewritten on every load and untouched by
   a join), and no newer-loaded thread names the same port.
2. **Confirming request.** `thread/resume {threadId, config: {}}` on an idle
   loaded thread joins the caller when another client is subscribed and
   reloads the thread when nobody is (the lock is rewritten and Codex runs
   SessionEnd). Notifai reads which from the lock, then unsubscribes. It is
   never sent to a thread outside `thread/loaded/list` (it would load it) or
   to a thread that is running a turn (it joins regardless).

The hub uses both before a wake (a confirmed `attached` lets one wake
through), and while a conversation has asked the User something it runs the
passive check every 10 seconds, confirming a "not shown" before ending the
session. The hub recognises the SessionEnd its own confirming request causes.
A terminal that only joined a conversation (`codex resume <id>` while another
terminal had it open) fails the passive check after the first terminal
closes; the confirming request then joins and the session is kept.

Side effects of the confirming request: on a conversation no terminal shows,
the reload runs the installed SessionEnd hooks and restarts that thread's MCP
servers; a join overwrites the thread's client name until its next turn.

## The behaviour check (`apps/cli/src/codex-attach-canary.ts`)

Both checks rest on Codex behaviour Codex does not promise, and Codex can
update at any time. Instead of a version gate, the hub runs
`runCodexAttachCanary()` against the exact binary that serves the shared
server, identified by its real path, size and modification time, and caches
the result in `<state>/notifai/codex-attach-canary.json`. It runs in the
background the first time a shared-server session needs it, again for each
new binary, and at most once a day after a behavioural failure. A check that
cannot start (step 0, including a failed private-server launch or disk error)
retries after 5 seconds, doubling the delay up to 5 minutes. Its consecutive
startup failures and retry timing survive a Hub restart. Until a binary passes,
nothing on that server is woken while idle (answers wait for the next prompt)
and nothing is ended by the watch.

It runs in a throwaway home under `/tmp` with its own private server, a plain
`codex` terminal in a pseudo-terminal (`script`), and a local mock of the
Responses API; every Codex process gets only `HOME`, `CODEX_HOME`, `PATH`,
`TERM`, `LANG` and a dummy key. It connects only to a control socket that is
named inside that home and held by the server it started from a binary inside
that home. Cleanup runs `daemon stop`, kills whatever still runs from the home
(the server's `pid-update-loop` survives `daemon stop`) and removes the home.

| Step | Pass when |
| --- | --- |
| 1 | A terminal loads a conversation on the private server and one mock turn writes its rollout and writer lock. |
| 2 | The passive check finds that terminal. |
| 3 | After `/new` in that terminal, the passive check reads the first conversation as moved on. |
| 4 | A second terminal `codex resume`s it; the passive check finds the new terminal and the confirming request joins. |
| 5 | Both terminals close (SIGHUP); the passive check reads it as not shown. |
| 6 | The confirming request reloads it. |
| 7 | After the server unloads it, the signal answers `not-loaded` and nothing loads it again. |
| 8 | `codex queue` into the unloaded conversation stores the wake without loading it or running a turn. |

A failure at any step, a timeout (90 s) or a check that cannot run keeps the
shared server on the no-idle-wake behaviour. `notifai doctor --json` names the
step under the wake route's `shared_server_check`; the human line only says
that answers arrive at the next turn. A Codex change the eight steps do not exercise would go
unnoticed; the steps are the shapes the signal relies on.

Wake failures preserve answers and notes in their existing durable input queue.
Transport failures retry with the same 5-second exponential backoff, capped at
5 minutes; the next prompt or trusted tool callback can consume input while a
wake is unavailable. A failed wake never proves the conversation closed and
never marks the answer delivered. The session records a `wake_fault` in
`notifai doctor --json`, and its next foreground turn receives a diagnostic
alongside the retained input. A fault is recovered only when a wake is observed
or input is handed in, not when a queue merely accepts it. Uncertain native
queue writes keep their existing identity-based reconciliation before retry,
so retrying cannot bypass an earlier possibly accepted write.
