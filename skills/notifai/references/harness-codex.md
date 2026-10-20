# Codex

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**Codex:** run `notifai hooks install --harness codex`. If `hooks-trust`
fails, open `/hooks` in Codex and approve or enable the Notifai handlers.
The synchronous `PostToolUse` handler delivers pending answers, Session Notes and Answer Edits
after tools during an active turn. Install and approve that handler, then
start a fresh Agent Session to use the new session child and hook definitions.
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

Native cards use their own structured questions: call `request_user_input_async`
and follow its tool context. The card hook registers them after Codex accepts
the call; a separate `ask` would duplicate them. When the native route cannot
settle a card, the tool context gives a registered plain-conversation question
instead. Native answers and that fallback use the distinct flows in
[native questions](native-questions.md).

**Codex:** after submission Notifai waits in the background for the complete
answer window (the shared hub on macOS and Linux); Stop provides recovery. While a
trusted tool hook can hand input into a working turn, Notifai uses that hook.
Idle sessions, or sessions whose live input path cannot be established, use
a content-free wake for the exact Agent Session in the same Codex home.
Notifai does not cold-start or resume Codex to obtain a control connection.
Closing the Agent Session ends its questions. In the Codex app or IDE
extension, a conversation Codex unloads while the app still lists it stays
open: its questions stay answerable, and an answer waits in that conversation
until the User opens it again. Quitting the app, or archiving or deleting the
conversation, closes it.
Pending notes and answers remain in Notifai until
a trusted tool hook, prompt hook, or `notifai receive` drains a bounded batch.
A late wake-up cannot repeat an acknowledged answer: it contains no answer
text. Queue success proves wake storage, not input presentation. Inputs are
claimed immediately before presentation; uncertain writes are never replayed.
Verified queue control can remove a stale wake owned by Notifai; unavailable
control leaves the harmless wake in place and preserves human prompts. The
prompt hook skips a wake with nothing behind it, so it starts no turn. If a
Notifai wake still reaches you and `notifai receive` is empty, it asks for
nothing: end the turn without resuming earlier work.
Keep the original question and request identities when investigating a delay.

## Command approval

Codex's default sandbox has no network, and outside full-access mode Codex
asks before running a command outside it. A question, its wake-up and its
acknowledgement are all commands, so an away User's first question can wait
at a terminal approval nobody sees. Readiness reports this as
`codex-commands` once Codex is wired; it never blocks setup. On the User's yes:

```bash
notifai init --codex-commands --json
```

That writes `rules/notifai.rules` in the Codex home (`~/.codex`, or
`CODEX_HOME`) with an allow rule for `send`, `ask`, `receive`, `acknowledge`,
`status`, `replies`, `close`, `guidance` and `session rename` only. Setup,
configuration and guidance edits keep their prompt.
`notifai hooks uninstall --harness codex` removes the file. Never write it
unasked, and never edit Codex rules by hand.

The rule has three limits, and readiness names each:

- Codex loads rules at startup. A session that started before the rule keeps
  asking (`session_predates_rule`): approve when Codex asks; new sessions will
  not ask. Never suggest ending that session while one of its questions is
  waiting, because closing the session expires the question.
- Only a literal `notifai …` argument list matches. Call `notifai` by name,
  never by absolute path or `node …/main.js`, and never through redirection, a
  heredoc, `$()` or `VAR=…`: Codex cannot split such a script, so nothing
  matches and the command stays in the sandbox. Put a Markdown body in a file
  and pass `--body-file <path>`.
- Rules are experimental, and the most restrictive rule wins. When readiness
  says the rule check fails, or that your organization forbids it, approve
  Notifai commands when Codex asks; hooks keep working.

## Windows command execution

Codex runs hooks through the session's selected shell. Notifai generates one
PowerShell encoded invocation that works when that outer shell is PowerShell
or cmd.exe and preserves literal paths and hook input. Reinstall with the
current CLI to replace an older bare quoted command. Codex owns approval of
the changed definition: use its `/hooks` review when requested; Notifai does
not copy or grant hook trust. Active sessions may retain their loaded hooks;
leave ongoing work running and verify the new definition in a fresh session.
