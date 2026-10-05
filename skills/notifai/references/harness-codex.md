# Codex

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**Codex:** run `notifai hooks install --harness codex`. If `hooks-trust`
fails, open `/hooks` in Codex and approve or enable the Notifai handlers.
The synchronous `PostToolUse` handler delivers pending answers, Session Notes and Answer Edits
after tools during an active turn. Install and approve that handler, then
start a fresh Agent Session to use the new attendant and hook definitions.
Pending input also queues one coalesced wake-up, whether the session is
working or idle. It carries no note or answer text. A trusted hook can drain
the input first; a late wake-up may then find nothing pending. A running tool
must return before its hook runs.
Automatic goal continuations are observed at their first trusted tool
callback even when the harness emits no prompt hook. Notes still need an
available callback; a long tool or uninterrupted reasoning cannot be cut
short by this route.
Then start one fresh Agent Session, send one prompt, and run `notifai doctor`. If
SessionStart is absent, reinstall the current hooks and start a fresh Agent Session;
UserPromptSubmit does not activate it. Codex SubagentStart uses the same
reporting-only worker contract and explicit textual delegation rule as
Claude. Child callbacks cannot consume the parent's input or change its
activity. A fresh install writes the Machine layer's `~/.codex/hooks.json`, or
joins inline `[hooks]` when the User already keeps their own hooks there.
Notifai-owned inline handlers with no foreign inline neighbours are moved to
`hooks.json`; Codex will ask for `/hooks` approval because it keys trust by
source path. Foreign inline configuration is left in place. Later upgrades
keep the default SessionStart output-limit identity so they do not mint a
second trust identity. One install covers every project and every worktree, so there is
nothing to repeat in a new checkout; a Project-scoped `.codex` hook file from
an older Notifai is removed once the Machine copy is proven current.

## How the answer gets back

**Codex:** a detached observer starts after submission and waits in the
background for the complete answer window; Stop provides recovery. While a
trusted tool hook can hand input into a working turn, Notifai uses that hook.
Idle sessions, or sessions whose live input path cannot be established, use
a content-free wake for the exact Agent Session in the same Codex home.
Notifai does not cold-start or resume Codex to obtain a control connection.
Pending notes and answers remain in Notifai until
a trusted tool hook, prompt hook, or `notifai receive` drains a bounded batch.
A late wake-up cannot repeat an acknowledged answer: it contains no answer
text. Queue success proves wake storage, not input presentation. Inputs are
claimed immediately before presentation; uncertain writes are never replayed.
Verified queue control can remove a stale wake owned by Notifai; unavailable
control leaves the harmless wake in place and preserves human prompts.
Keep the original question and request identities when investigating a delay.
