# Hermes

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

Notifai's native plugin supports stable Hermes releases from v0.21.5 through
v0.23.3. `notifai hooks install --harness hermes` installs and enables it
through `hermes plugins`. For a release outside that range, `notifai doctor`
shows the installed version and the supported range. Leave the User's Hermes
as it is unless they ask to change it. If the version cannot be read, follow
doctor's diagnostic and remedy. Start a fresh local classic CLI Agent Session
after installation. The Hermes plugin carries no copy of the Notifai skill: setup
installs it when the User picks Hermes among the agent apps to connect, and
`notifai init --skills --skills-scope global --skills-harness hermes --json`
installs it otherwise.

The plugin checks whether lifecycle guidance is on and gives root or worker guidance, the
same session guidance other harnesses receive, in two system prompt sections:
the activation and notices, then the trust text, terms and topics. If the
second is missing, the first says to run `notifai guidance`. When the classic
CLI itself runs the turn, Notifai reads the exact `HERMES_SESSION_ID` for
Source Context and takes the git branch and worktree from the command's
directory. With inherited markers from another agent app, the one whose process
is nearest owns the command. If the process tree cannot tell, the command omits
the ambiguous Source Context.

Plugin activation applies to the local classic CLI, including when the gateway
runs its turns. It is unavailable on TUI, messaging gateways, API, ACP, remote
terminal backends and Windows.

## Questions, notes and edits

When the classic CLI itself runs your turn, the plugin can return an `ask`
answer as the same session's next input. `notifai ask --wait` tells you to end
your turn for it. Keep Hermes running for the answer window. Closing the
session expires its questions.

When the gateway runs your turn, as in Hermes v0.23, use
`notifai ask --wait`. The command stays open and returns the answer in its
tool result. This also works on other Hermes surfaces that can run the local
CLI. Session Notes and Answer Edits require the attached classic CLI route.

On the attached route, after the session's first Notification Request, Session Notes and
post-consumption Answer Edits also arrive in it; a note may interrupt a working
turn. Hermes accepting one means it is the session's next input, not that you
read it: acknowledge each message after reading it. Notifai holds messages
while Hermes waits on an approval prompt or a session-switching slash command
such as `/new` or `/resume`, so a message never answers a prompt or lands in
another session.

## After a Notifai update

A compatible plugin keeps the session's answer route while its files are
refreshed. Hermes keeps a session's first guidance in its system prompt, so when
that guidance has changed, Notifai says so once with the next turn, as it does
after a compaction. Changed plugin code counts as loaded only once a loaded
plugin shows it. An older plugin may need its old file kept until its work
finishes: follow the update's continuity diagnosis.
