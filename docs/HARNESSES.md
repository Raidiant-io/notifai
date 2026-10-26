# Harness support

What Notifai supports on each harness and operating system, and how its hooks
deliver questions and answers. For commands and setup, see
[Using Notifai](USAGE.md).

## Platform support

| Surface | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Approved Machine CLI: login, configuration, send, ask, doctor | Supported | Supported | Supported |
| Claude Code hooks | Supported; live inbox wake | Supported; live inbox wake | Supported; live inbox wake through the session's named pipe; question pickers stay in the terminal |
| Codex hooks | Asynchronous Stop and durable session queue; CLI/app-server verified | Same queue implementation; live Codex verification pending | Same queue implementation; live Codex verification pending |
| Cursor hooks | Supported; `notifai ask --wait` waits for the answer inside the asking command, since no later answer can return | Supported; same limitation | Supported; same limitation |
| OpenCode hooks | Supported on OpenCode 1, and on OpenCode 2.1 and later; OpenCode's own question form (verified on 1.19.3 and 2.1.3) reaches devices and settles from either side; otherwise `notifai ask --wait` waits for the answer inside the asking command. `notifai doctor` reports OpenCode 2.0, which is unsupported | Same implementation; live OpenCode verification pending | Same implementation; live OpenCode verification pending |
| OpenClaw hooks | Asynchronous Question Routing, Session Presence, Session Notes, and post-consumption Answer Edits through the local Gateway service and exact-session followup queue | Lifecycle hooks; asynchronous Question Routing and Session Messages unproven, so `notifai ask --wait` waits inside the asking command | WSL2 lifecycle hooks only; native Windows Gateway unproven |
| Hermes plugin | v0.21.5 local classic CLI: managed Project activation, Source Context, Question Routing, Session Presence, Session Notes, and Answer Edits through its live plugin writer | Same implementation; live Hermes verification pending | Unverified |
| Grok hooks | Automatic guidance and Question Routing for main and delegated child sessions; live shared-leader sessions also receive Notes and Answer Edits | Same adapter; live Grok verification pending | Same adapter; live Grok verification pending |

Codex's optional native-question synchronization and exact queued-wake cleanup
have live evidence on macOS with Codex 0.160.0. Linux and native Windows do not
yet have live acceptance for those capabilities; the CLI platform support row
does not establish it. Discovery attaches only to a verified, already-loaded
session in an existing daemon. It never starts a replacement session or requires
`codex --remote`.

If optional control is unavailable before delivery, Notifai uses the ordinary
hook/queue route where that route is proven. If a native write may already have
been accepted, it retains recovery state instead of sending a second copy.
This can delay delivery until control recovers or a foreground hook runs.
Exact wake cleanup reduces stale prompts. A wake Codex starts with nothing
behind it, such as one left in a conversation that closed and was reopened
later, is blocked by the prompt hook: no turn runs and no model request is
made, and Codex shows one "Blocked by hook" line. Unsupported question shapes
retain ordinary delivery and do not suppress the native form.

“Fails closed” means Notifai keeps the accepted answer in the Agent Session
journal until an exact continuation path can prove ownership, rather than
starting an unproven or divergent agent turn.
Claude Code live inbox wake requires Claude Code 2.1.224 or newer on macOS and
Linux and 2.1.234 or newer on Windows; an older Claude Code receives the
accepted answer at the Agent Session's next turn. Cursor does not expose the conversation
identity needed to prove asynchronous return, and OpenCode has no proven
exactly-once continuation after `session.idle`; `notifai ask --wait` waits
inside the asking command there. OpenCode's own question form is the exception:
it holds its turn, so its device answer returns through the form itself. OpenClaw's advertised Windows cell is WSL2 only;
a native Windows Gateway plus native Notifai CLI in one process is unproven.

## The installed hooks

`notifai hooks install` installs one owned lifecycle mechanism per harness, in the current user's
account and that harness's active home; whether Notifai acts in a project is
`notifai project enable` / `notifai project disable`, not a second install.
How they appear depends on the harness — Claude Code names them in
`~/.claude/settings.json`, Codex in `~/.codex/hooks.json` (or inline
`[hooks]` in that layer's `config.toml`, when the user's own hooks already live
there), Cursor uses its own hook shapes, OpenCode and OpenClaw get generated
plugins, and Hermes gets a native Python plugin through Hermes's own CLI.
Hermes's plugin supplies bounded system-prompt sections for an enabled
Project. In an attended local classic CLI session, its live writer also routes
question answers to that exact session. On other Hermes surfaces
`notifai ask --wait` waits for the answer inside the asking command. Other
harnesses have their own documented answer path, or wait the same way.

Command approval for Claude Code (`--claude-commands`) and Codex
(`--codex-commands`) is described in
[the Claude Code reference](../skills/notifai/references/harness-claude-code.md)
and [the Codex reference](../skills/notifai/references/harness-codex.md).

**SessionStart** (`session-start`) gives the main owner the small model-visible
activation context that makes it evaluate Notifai proactively. It carries the
`when-to-notify` and `questions` guidance topics and names the wording topics
the owner reads with `notifai guidance` before its first Notification Request. **SubagentStart**
(`subagent-start`) gives ordinary Claude and Codex workers a reporting-only
context instead. The parent owns User-visible Notification Requests unless it
explicitly delegates that ownership in text; a delegated worker then loads the
Notifai skill and runs `notifai guidance`. An orchestrator that launches its
workers as separate top-level Agent Sessions leaves the harness no parent to
report, and their environment matches a session the User started, so those
workers receive the owner context. That context therefore says that an Agent
Session another agent started with a task brief belongs to that agent, which
keeps Notification Requests unless the brief delegates them. These contexts are local-only and run before project setup,
authentication, Device Installations, or network access, so those missing
prerequisites cannot make activation disappear. OpenCode uses its Agent Session
relationship data to give parent Agent Sessions owner context and child Agent
Sessions worker context; missing or unusable relationship data fails safe as
worker. OpenClaw uses the `sessionKey` the same way: a `:subagent:` or ACP
nested key is a worker, and missing identity fails safe as worker.
Hermes v0.21.5 freezes the root or delegated worker context into the local
classic CLI prompt. Its prompt budget holds no guidance topic, so it directs
the agent to run `notifai guidance` before deciding whether or how to notify.
Cursor activation adds no turn. The editor, the Agents Window and
`cursor-agent` deliver SessionStart context. Hosts built on the Cursor SDK,
such as T3 Code, discard it, so Cursor wiring also writes one short
always-applied rule, `~/.cursor/skills/notifai-activation/SKILL.md`. The
editor, the Agents Window and SDK hosts that load the `user` setting source
apply it to every conversation. The rule cannot know
whether this Project is enabled, so it tells the agent to follow SessionStart
context when present and otherwise to check `notifai project status` before
reading guidance. `notifai doctor` reports the rule missing or out of date, and
`notifai hooks uninstall --harness cursor` removes it with the hooks. Delegated
Cursor work stays under the parent Agent Session's explicit notification ownership
rather than pretending the worker received context its host cannot deliver.

**UserPromptSubmit** (`user-prompt-submit`) runs when you send a prompt. That
records presence for this turn and remembers this Agent Session for later
`notifai ask` calls. It retires only questions that the prompt plausibly answers;
unrelated questions remain outstanding. It never substitutes activation when SessionStart is missing; reinstall
the current hooks and begin a fresh Agent Session. It has to run here for presence:
only this moment can tell that you were present for this turn.

**Questions** start background submission when the agent runs `notifai ask`.
The agent can keep working; only work that needs the answer waits. Registration
alone is not proof of Provider Acceptance. **Stop** (`stop`) and
**UserPromptSubmit** recover outstanding questions and own harness-specific
answer delivery. Claude Code and Codex observe answers out of band: on macOS
and Linux the hub waits for them, and the session child wakes the session.
Codex uses trusted tool hooks during working turns and a content-free wake when
idle or live input capability is unavailable. Current notes and answers drain
through a trusted tool hook, prompt hook, or `notifai receive` in the exact
Agent Session. Queue success proves wake storage, not presentation, and an
old wake-up cannot repeat an answer that has already been acknowledged.

OpenClaw's Gateway service keeps the complete answer window and queues a
pointer-only `followup` into the same `sessionKey` after the asking turn. The
agent reads the answer with `notifai replies` and persists its own
`notifai acknowledge`; queue admission alone does not prove consumption.

An `ask` success is a local registration, not a submitted Notification Request:
it has no Provider Acceptance until question settlement promotes its stable
`q_...` identity to a `req_...` identity. `notifai status <question_id>` reads
that local state and, after promotion, links the downstream request evidence.
Inspect or close the original identity when delivery is uncertain; registering
again creates a separate question.

**SessionEnd** (`session-end`) runs when the Agent Session closes. A closed
session's questions are closed too: it drops this Agent Session's local state
and queues any leftover questions for retirement so they do not sit on your
devices after the agent is gone. It has to run here because no later hook for
this Agent Session will fire. An answer you gave that the agent had not read
yet is dropped, never delivered later, and your devices show it as not
delivered. Acknowledgements the agent still owed are cancelled. If a hook is
still waiting for an answer when the session closes, it tells the Notifai
service right away, so the questions expire on your devices at once.

SessionEnd is not always a close, so on macOS and Linux the hub that attends
the session decides about ten seconds later (the end confirmation), and the
hook cleans up nothing meanwhile. The same applies when the session child sees
its harness exit or goes away. If the same conversation is back by then, it
was never closed: its questions stay open and what waits for it follows it.
That covers the shared Codex server reloading a thread in place when a
terminal runs `codex resume` (it runs SessionEnd first), the Claude desktop
app respawning a session, and a handoff that continues it at once in another
terminal or app (`/desktop`, `/app`, a resume in a new tab). A Claude Code
conversation can be open in two places at once; each has its own session
child, only the most recently opened receives answers and notes, and closing
one leaves the other. Anything else closed: exiting, closing the terminal, a
kill, `/clear` or `/resume` of another conversation in its place, quitting
the app, archiving or deleting it.

Without a hub to decide (on Windows, or for a session the hub never attended),
a SessionEnd that would expire questions or drop answers starts a short
background process instead, which waits the same ten seconds. The session
stays open if it started again in that time, another Claude Code process still
has the conversation open, or a Codex process holds the thread again;
otherwise it closes. A sign Notifai cannot read counts as no sign: on Windows
it cannot see which process holds a Codex thread, so only a restart keeps a
Codex session open there. A SessionEnd with nothing to lose closes at once.

Some stops are not closes. The Claude desktop app pauses or evicts a
conversation it still lists (an idle pause, its process limit, memory
pressure), and its own log names the pause; without that line, the stop counts
as a close (the Stop button looks the same). The Codex app and IDE extension
unload a conversation they still list while their own Codex server keeps
running. An Orca chat or T3 Code stops a conversation after 30 minutes idle
while the app keeps running; nothing else tells that from closing the tab, so
an earlier stop is a close. Orca loses a terminal pane's terminal host (and
resumes the conversation in that pane when you open the tab); closing the pane
leaves the host running and is a close. And the machine
shuts down, restarts, crashes or loses power: on macOS and Linux the hub
learns that a shutdown or restart has begun before the apps quit (from
loginwindow on macOS, from systemd-logind on Linux), holds every end until the
machine goes down, and the next hub, in a different boot, keeps those
conversations. A conversation that was attended when the power went keeps its
questions too. Such a stopped session shows as out of reach on your devices.
Its questions stay open for their own windows (a day by default), and an answer
you give meanwhile waits on this machine; the hub stays running while
something waits. It is handed to the agent when the conversation comes back
where it was or wherever you resume it (the desktop app reopening it,
`claude --resume <id>` in a terminal): a wake-up as usual, or at its next
prompt. A Codex conversation gets one content-free wake in its own queue
(written with `codex queue`, never through a connection to a Codex server),
which Codex runs only when the conversation loads again: when you open it in
the app, send in the Orca chat or T3 thread, or `codex resume` it. Nothing runs
while you are not looking, and a thread some process has loaded gets no wake.
A scripted run (`claude -p --resume`, an SDK script, `codex exec`) receives
nothing. If the conversation is deleted or archived while stopped (a Codex
rollout is found by its id in `sessions/` and `archived_sessions/`), or you
quit the app it was stopped in, it closes as above; when its last window ends,
it ends, and stops accepting notes. A fork that names the stopped
conversation (Codex records `forked_from_id`, Claude Code's `/branch` records
`forkedFrom`) means it continues there. Where the service supports it (an
older service only once the fork has sent a notification), its questions,
their answers and its notes move to the fork and arrive there; otherwise its
questions expire.
Where the service supports it, you can also send a note to a stopped
session: it waits up to a day and is delivered when the conversation comes
back. An answer still waiting when its question's window ends is not
delivered, and your devices say so. Otherwise a note cannot be sent to a
stopped session; one the service accepted just before the stop is delivered
if the session comes back within the hour. `notifai doctor` shows stopped
sessions and whether shutdowns are seen.

**Session child and hub** (`attend`, Claude Code and Codex on macOS and Linux).
The `attend` handler is a second, asynchronous handler on SessionStart,
UserPromptSubmit, and Stop. Claude Code runs every Notifai handler in exec form,
with no shell in between, when its version is known to support that (2.1.139 or
later, read from `claude --version` at install); otherwise in shell form, which
works the same way. `notifai doctor` shows the form and why, and `notifai update`
moves the hooks to exec form after Claude Code is upgraded. It runs the native launcher as a tiny **session
child**: one per Agent Session and process hosting it, staying the harness's own
child for the life of the session. It learns from the kernel when the harness exits, so it never polls
and has no timer, and it is the only process that writes into Claude Code's
inbox, opening each connection with the session's own token. It holds no
credential and makes no network connection. When a child already serves the
session, the UserPromptSubmit and Stop copies tell the hub a turn boundary
passed and exit at once.

The children register with one shared **hub** per OS user (`notifai hub`, started
on demand by the first child and gone 30 seconds after the last session ends;
there is no login item or startup task). The hub reads the machine credential
once, holds every session's presence lease behind one batched exchange with
the service, waits for answers to registered questions, and nudges Codex
through its queue. It makes no network call for a session until that session
has sent a Notification Request, so sessions that never notified are never
reported. When the harness exits or is killed, the hub reports the session
ended after the end confirmation, unless it continues elsewhere at once, so its
questions expire on your devices; when the hub was not running, it is reported
at the next Notifai activity. A Claude Code conversation the machine took down
stays open instead (see SessionEnd above). A hub crash is not a
close: children restart it and register again, and nothing expires. Only an
opaque id leaves the machine: never process ids, paths, or session files.
`notifai doctor` shows the hub and the sessions it attends.

While the hub runs it also answers the frequent hooks, so they start no
runtime: SessionStart, SubagentStart, UserPromptSubmit and Stop for Claude Code
and Codex, and Codex's PostToolUse. The native launcher reads the hook's input
and hands it to the hub, which runs the same handler with the hook's own
environment and directory and returns what the hook prints, activation
guidance included. Only a quiet session's hooks go this way: nothing asked,
answered, staged or owed. Every other hook, and every hook while no hub runs or
while the hub is an older build than the one installed, starts the runtime
with the same input, as before. Claude Code's inbox token never reaches the
hub. `notifai doctor --json` counts the hooks the hub answered and why it left
others to the runtime.

On Windows, Claude Code keeps the earlier per-session Session Attendant until the
hub is verified there.
OpenClaw's Gateway service also owns a current-generation attendant on macOS.
It reports Session Presence and accepts Session Notes and post-consumption
Answer Edits while its local writer is ready. It stores full message text in a
private local delivery journal and queues a pointer-only followup. The exact
pointer turn reads that text once, only while its native Gateway generation
still matches. The journal discards the text after that turn claims it, after
a generation change, or on Gateway restart; a plugin reload hands it to the
new plugin generation. Stopping the Gateway, or disabling or uninstalling the
plugin while it runs, ends its sessions for Notifai and their questions
expire. The agent acknowledges the
message after reading it. If a pointer reaches a turn without its full context,
the pointer tells the agent to report the missing message and leave it
unacknowledged. The User can send a new message if needed.

The hub also hands a note, or a change to an answer the agent already
received, from your devices into that running session. Claude Code gets a
content-free wake in its inbox, written by the session child. Codex uses its trusted synchronous `PostToolUse` hook during
active turns and also queues a content-free wake while input is pending,
whether working or idle. If no tool boundary occurs, the queued wake preserves
delivery at turn end. A plain `codex` terminal that joined Codex's shared
server is the exception: when that terminal closes, Codex keeps the
conversation loaded for about 30 minutes and says nothing, so a wake there
could start a turn nobody sees. There Notifai wakes an idle session only when
it can see that a terminal still shows the conversation, and treats a closed
terminal as the end of the session. It relies on Codex behaviour that Codex
does not promise, so the hub first checks, once per installed Codex build, in
a throwaway Codex home with a mock model, that Codex still behaves that way
([`docs/CODEX-ATTACH-CANARY.md`](CODEX-ATTACH-CANARY.md)). Until
that check passes, the session is not woken while idle and the note or
answer waits for your next prompt there. Child callbacks cannot consume the parent session's input
or change its activity. Each hand-off is claimed first, so an edited answer can only follow
the answer it replaces, and nothing is written twice. The agent acknowledges
each one with `notifai acknowledge sm_…`, exactly as it acknowledges an
answered request. A Claude Code session without an inbox socket (for example
`--bare`), or a Codex session whose hooks cannot find the `codex` executable,
keeps presence only and accepts no notes.

If a wake fails, input stays queued for retry or the next prompt or trusted tool
callback. Transport failures retry with exponential backoff from 5 seconds up to
5 minutes. Environmental check-start failures use that cadence for seven retries,
then wait a day; permanent check failures use the daily cadence from the start.
The next foreground turn receives the fault, and `notifai doctor --json` records
it, including whether delivery has recovered; recovered diagnostics expire after
an hour. Queue acceptance alone never proves the agent read an answer.

On Codex the session child differs in three ways. Codex enforces every async
hook timeout, so the attend handler declares the complete answer window (about
72 hours) and the next prompt or turn end starts another child after that. Codex
publishes no session status, so the hub reads working or idle from this
thread's own transcript and hooks (a third attend copy on Interrupt only tells
the hub the turn ended). And Codex stops the child when the thread closes,
reloads or unloads, so SessionEnd hands the end to the hub, which decides it as
described above: a thread its Codex server holds again (its writer lock) was
reloaded in place and runs on until its next prompt brings a child back. Codex runs
no SessionEnd when a loaded conversation is archived, so the hub also watches
each Codex session's rollout and ends the session when it is archived or
deleted. Codex runs hooks
through your login shell; bash and zsh hand the hook straight to Codex's own
child, and the session child also accepts Codex as its grandparent through a
shell that keeps running in between. The Codex hook definitions are unchanged
from earlier releases, so updating needs no new `/hooks` review. Codex marks new or changed hooks for review: after
installing, open `/hooks` in Codex once and approve the Notifai handlers.
`notifai doctor` names any handler still waiting. Question Routing does not
wait for that approval.
