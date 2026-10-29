# Codex

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

Codex's internal `$CODEX_HOME/memories` and `memories_v2` workspaces (default `~/.codex`) intentionally receive no Notifai lifecycle context; requests there fail with `codex_memory_workspace`, so do not repair or re-enable them.

Codex runs in the Codex CLI, the Codex IDE extension and the ChatGPT desktop
app. Call it Codex; the ChatGPT app is the window the User sees.

Run `notifai hooks install --harness codex`. If `hooks-trust` fails, only the
User can approve or turn on the Notifai handlers, in Codex with the same
`CODEX_HOME`: the **Review hooks** icon in the message box of the ChatGPT app or
the IDE extension (Settings → Hooks for handlers that are off), `/hooks` in
the CLI, or `notifai doctor codex` in a terminal, which opens Codex's own
review in each Codex home that needs it. Never run that command for the User:
run by an agent it only prints what the User should run. That includes the `PostToolUse` handler that hands answers and notes
into a working turn. Codex's own list is authoritative when it disagrees with
doctor.

Never wait for that approval or ask the User to tell you when it's done: carry
on, and end your reply with the gap's `message` as written. It is a short
reminder worded for the Codex surface you run in. During setup the done message
carries it instead ([What to tell the User](harness-setup.md#what-to-tell-the-user)).

Then start one fresh Agent Session, send one prompt, and run `notifai doctor`. If
doctor finds no SessionStart, reinstall the current hooks and start a fresh
Agent Session; a prompt hook alone never activates Notifai.

A fresh install writes the active Machine layer's `$CODEX_HOME/hooks.json`
(default `~/.codex/hooks.json`), or joins inline `[hooks]` when the User already
keeps their own hooks there. Shared configuration symlinks are preserved, but
a distinct Codex home needs its own `/hooks` approval even when the files are
shared. Run installation from that home; approval in the default home alone
does not configure another account's home. When it
moves Notifai's own inline handlers to `hooks.json`, Codex asks for `/hooks`
approval again, because it keys trust by file. The User's own inline hooks stay
where they are. One install covers every project and worktree, so there is
nothing to repeat in a new checkout.

An ordinary subagent receives worker context: it reports to its parent and does
not notify. A worker explicitly delegated Notification Requests in its prompt
loads the skill and guidance as their owner. Notifai cannot read the prompt, so
only that delegation decides whether a worker asks, as on Claude Code.

A subagent's question registers on the root Agent Session, and its answer arrives there; follow what `ask` prints.

## Questions

To keep working while the User decides, run `notifai ask`. When your tools
include `request_user_input_async` and Notifai can link it, `ask` hands back
the exact card to open: the question is already registered locally with your title,
Body, images and choice descriptions, and Notifai matches the card by its exact
text. Local registration does not confirm submission to devices; follow the
status the tool reports. Open it unchanged. A card whose text no longer matches is refused, and
its tool context gives the registered question to ask in plain conversation
instead. Codex offers the card only with some models, in the terminal and the
apps alike.

`request_user_input` (no `_async`) is not linked to Notifai: where Codex
accepts it, it waits in Codex, where an away User never sees it. Use
`ask` for those questions too.

If `ask` is refused with `codex_hook_approval_required`, nothing was
registered: ask the question in the conversation instead and carry on with
work that doesn't depend on the answer. End your reply with the line for the
User (`user_action.message`) as written. Later questions try `ask` again.

To wait, run `notifai ask --wait`. It never opens a card, because Codex drops
open cards when your turn ends: end your turn, and the answer arrives as your
next message.

A card you open on your own is queued for device registration after Codex
accepts it, when Notifai can carry its shape and reach its answer control.
Queued means delivery is not confirmed yet; keep using the card and never
also `ask` the same question. Long wording is shortened for devices with the
full wording in the Body. Choices stay distinct, including localized labels.

With question notifications off, a disabled Project, a signed-out machine,
an unsupported shape or an unavailable device route, the card stays native
and still works there. A failed capability or control probe does not replace
it with another question. If you need to switch to `notifai ask`, close the
unanswered native card first so the User cannot answer two copies.

The card closes on the first answer:

- **A device answer** arrives in the card with its own
  `notifai acknowledge req_…` command; run it before dependent work.
- **A terminal answer** needs nothing from you. Notifai records it, so the
  devices stop asking.
- **A question that expired on the devices** closes the card unanswered:
  carry on without it.
- **An existing `ask` hand-back that cannot link** retains its registered
  question. Follow the tool context's conversation and `notifai close`
  instructions; opening a competing card is refused to prevent two answers.

## What arrives and what to do

Answers, Session Notes and Answer Edits come back on their own for the whole
answer window. In a working turn they arrive after a tool call returns, so a
long tool or uninterrupted reasoning delays them. Otherwise a wake-up starts
the next turn, after the current one ends if the session is working; it carries
no note or answer text. Follow it as the skill's "When the answer arrives"
says. A late wake-up may find nothing pending: if a Notifai wake starts a turn
and `notifai receive` finds nothing pending, end the turn; never resume
finished work for it.

A plain `codex` terminal on Codex's shared server is woken while idle only
after Notifai's check of the installed Codex build has passed, and only while a
terminal still shows the conversation. Until then an answer or note there waits
for the User's next prompt in that session. Doctor's wake route says which
applies; tell the User when answers will wait.

Closing the Agent Session ends its questions within seconds: exiting, closing
its terminal, quitting its app, archiving or deleting it. Never suggest ending
a session while one of its questions waits. A `codex resume` that reloads the
same conversation in place, or continues it at once elsewhere, keeps them, and
their answers follow it. A fork takes its questions with it where the service
can move them; otherwise they expire. A `codex exec` run of it receives
nothing.

Stops the User did not make keep its questions open for their window: the
Codex app or IDE extension unloading a conversation it still lists, an app that
hosts the conversation stopping it after it sits idle or losing its terminal,
and the machine shutting down or restarting. An answer or note given meanwhile
waits in the conversation and arrives when it comes back (opened in the app,
the next send in the chat, `codex resume`), possibly hours later: check that
the work it answers still applies.

Notifai brings some stopped conversations back by itself when an answer or
note arrives. A terminal conversation the machine stopped reopens in a new
terminal window running `codex resume` in its folder and Codex home, with the
approval, sandbox and config options it ran with and never more permissive
ones. A conversation the Codex app started and then unloaded continues inside
the app, without opening on screen, while the app is running and the
conversation is not archived (`reopen.codex_app`). A conversation T3 Code
started and then let go continues in its own T3 Code thread while T3 Code
runs: Notifai sends that thread a Notifai wake (`reopen.t3`). When Notifai cannot
reproduce how a conversation started, or its permissions changed since, it
waits for the User instead. Do not ask the User to resume it.
`notifai config set reopen.terminal off --yes` (or `notifai config set reopen.automatic off --yes` for every
place) makes it wait for the User; change these only when the User asks.

## Command approval

Codex's default sandbox has no network, and outside full-access mode Codex
asks before running a command outside it. A question, its wake-up and its
acknowledgement are all commands, so an away User's first question can wait
at a terminal approval nobody sees. Readiness reports this as
`codex-commands` once Codex is wired; it never blocks setup. Setup writes the
rule when the User picks Codex among the agent apps to connect. Otherwise, on
the User's yes:

```bash
notifai init --codex-commands --json
```

That writes `rules/notifai.rules` in the Codex home (`~/.codex`, or
`CODEX_HOME`) with an allow rule for `send`, `ask`, `receive`, `acknowledge`,
`status`, `replies`, `close`, `guidance` and `session rename` only. Setup,
configuration and guidance edits keep their prompt.
`notifai hooks uninstall --harness codex` removes the file. Never write it
without one of those, and never edit Codex rules by hand.

The rule has three limits, and readiness names each:

- Codex loads rules at startup. A session that started before the rule keeps
  asking (`session_predates_rule`): approve when Codex asks; new sessions will
  not ask. Never suggest ending that session while one of its questions is
  waiting, because closing the session expires the question.
- Only a literal `notifai …` argument list matches. Call `notifai` by name,
  never by absolute path or `node …/main.js`. Use the skill's POSIX rule:
  single-quote each value and join literal pieces around each apostrophe,
  as in `'SELECT '"'"'ready'"'"';'`. This preserves the exact text and matches
  `notifai.rules`, including multiline Bodies and `--form-json` forms.
  The backslash variant `'it'\''s'` is lossless in the shell but prevents
  matching. Redirection, a heredoc, pipe, `VAR=…` or expansion can also leave
  the command in the sandbox. For a Body or form already in a file, use
  `--body-file <path>` or `--form <path>`; write it in the system temp directory,
  never the repository. Preparing the file has its own
  permission gate. On Windows, use the
  [PowerShell rule and native argument limits](shell-quoting.md); matching
  the Windows harness's command rules has not been verified.
- Rules are experimental, and the most restrictive rule wins. When readiness
  says the rule check fails, or that your organization forbids it, approve
  Notifai commands when Codex asks; hooks keep working.

## Windows hooks

On Windows, Codex runs hooks through the session's own shell; Notifai's hook
command works under PowerShell and cmd.exe, and cards link there as they do on
macOS and Linux. A reinstall that adds or changes a handler needs the User's
approval of that handler in Codex; Notifai never grants hook trust. Running sessions may keep the hooks they loaded: leave their work
running and check the new definition in a fresh session.

## After a Notifai update

Existing hook owners and approvals carry over. When the guidance this Agent
Session read has changed, Notifai says so once, at its next prompt or tool call,
as it does after a compaction: load the skill again and run `notifai guidance`
before the next Notification Request. A changed handler can need the User's
approval in Codex, as in [Activation](#activation). Approval does not reach a
running session: Codex keeps the handlers a session loaded when it started, so
`update --resume` and `doctor` name any Notifai handler this session lacks and
say a new Codex session picks it up. Only a handler a feature needs (turn end,
the tool boundary, question cards) blocks; keep working otherwise and tell the
User. Follow the specific reload or stale-Stop remedy the update
reports, then confirm real hook calls, including the tool-boundary call
(`tool_boundary_notes` in [Updating
Notifai](updates.md#local-integration-faults)).
