# Hermes

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

With Hermes v0.21.5, `notifai hooks install --harness hermes`
installs and enables Notifai's native plugin through `hermes plugins`. Start a
fresh local classic CLI Agent Session after installation. Install the Notifai skill through
the built-in Notifai skill installer; the Hermes plugin does not include a copy.

The plugin's bounded system prompt section checks Project Enablement and gives
root or worker guidance. Hermes's prompt budget holds the trust text and terms
but no guidance topic, so the section directs you to run `notifai guidance`
before deciding whether or how to notify; on Hermes that output also carries
any update notice. Notifai
reads exact `HERMES_SESSION_ID` for Source Context and takes git branch and
worktree from the directory each command runs in. Nested inherited harness
markers fail closed.

Only local classic CLI sessions are supported. TUI, gateway, API, ACP, remote
terminal backends and Windows are not.

## Questions, notes and edits

A classic CLI session receives an `ask` answer back into the same live
session. On other Hermes surfaces `ask` refuses: use a blocking
`notifai send --reply` question, as the skill's "Bounded foreground wait" says.
Keep Hermes running for the answer window: closing the session ends its
questions, and an answer that arrives after the process exits is not
delivered.

After the session's first Notification Request, Session Notes and
post-consumption Answer Edits also arrive in it; a note may interrupt a working
turn. Hermes accepting one means it is the session's next input, not that you
read it: acknowledge each message after reading it. Notifai holds messages
while Hermes waits on an approval prompt or a session-switching slash command
such as `/new` or `/resume`, so a message never answers a prompt or lands in
another session.

## After a Notifai update

A compatible plugin keeps the session's answer route while its files are
refreshed; reread guidance yourself. Changed plugin code counts as loaded only
once a loaded plugin shows it. An older plugin may need its old file kept until
its work finishes: follow the update's continuity diagnosis.
