# Hermes

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**Hermes:** with Hermes v0.21.5, `notifai hooks install --harness hermes`
installs and enables Notifai's native plugin through `hermes plugins`. Start a
fresh local classic CLI Agent Session after installation. Its bounded system
prompt section checks Project Enablement and gives root or delegated worker
guidance. Hermes's prompt budget cannot hold every effective guidance topic;
when the full set exceeds it, the section directs the agent to run
`notifai guidance` before deciding whether or how to notify. Notifai reads
exact `HERMES_SESSION_ID` for Source Context and derives git branch and
worktree from the actual invocation cwd. Install the Notifai skill through
the built-in Notifai skill installer; the Hermes plugin does not include a copy.
On local classic CLI sessions the plugin supervises a Session Attendant for that exact session.
After the first Notification Request, it reports Session Presence and hands
Session Notes and post-consumption Answer Edits into that session through
Hermes's public plugin API; a Note may interrupt a working turn. Hermes
accepting a write means the text was admitted as the session's next input,
not that the agent read it, so the agent must acknowledge the message. The
plugin holds writes while Hermes waits on an approval prompt or while a slash
command such as `/new` or `/resume` may switch sessions, so a write never
answers a prompt and never lands in a different session. An attended
classic CLI session can route an `ask` answer into that same live session;
keep Hermes running for the answer window. Registration schedules background submission;
the plugin owns answer delivery. Closing the session ends its questions: if
the process exits first, the answer is not delivered.
TUI, gateway, API, ACP, remote terminal backends, and Windows remain outside
this proven cell.
Nested inherited harness markers fail closed.
