# Codex

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

Run `notifai hooks install --harness codex`. If `hooks-trust` fails, open
`/hooks` in Codex and approve or enable the Notifai handlers, including the
`PostToolUse` handler that hands answers and notes into a working turn. Then
start one fresh Agent Session, send one prompt, and run `notifai doctor`. If
doctor finds no SessionStart, reinstall the current hooks and start a fresh
Agent Session; a prompt hook alone never activates Notifai.

A fresh install writes the Machine layer's `~/.codex/hooks.json`, or joins
inline `[hooks]` when the User already keeps their own hooks there. When it
moves Notifai's own inline handlers to `hooks.json`, Codex asks for `/hooks`
approval again, because it keys trust by file. The User's own inline hooks stay
where they are. One install covers every project and worktree, so there is
nothing to repeat in a new checkout.

An ordinary subagent receives worker context: it reports to its parent and does
not notify. A worker explicitly delegated Notification Requests in its prompt
loads the skill and guidance as their owner.

## Questions

When your tools include `request_user_input_async`, ask with that card: call
it with the User's questions and follow its tool context. Codex offers it only
with some models, in the terminal and the apps alike. The card hook registers
the questions after Codex accepts the call; a separate `ask` would duplicate
them. Report a terminal answer and handle the plain-question fallback as
[native questions](native-questions.md) says.

Without that tool, use `notifai ask`: it registers an ordinary question.
`request_user_input` (no `_async`) is not linked to Notifai: where Codex
accepts it, it waits in the terminal, where an away User never sees it. Use
`ask` for those questions too.

A card you open on your own is the Notifai question when its tool context
says Notifai registered it; then never also `ask` it. With question routing
off, or on a signed-out machine, the card stays in the terminal and still
works there. In a Project that is not enabled the card also stays on this
machine; enable the Project with `notifai project enable` only when the User
asked for Notifai here. Any other card without that context, such as one in a
shape the devices cannot show, stays on this machine: if it is still
unanswered, `ask` the question too.

The card closes on the first answer:

- **A device answer** arrives in the card with its own
  `notifai acknowledge req_…` command; run it before dependent work.
- **A terminal answer** you read from the card is reported with the
  `notifai acknowledge … --native-answers` command its tool context names.
- **A question that expired on the devices** closes the card unanswered:
  carry on without it.
- **A card that cannot receive a device answer** never opens. Notifai
  registers a plain question instead, and the tool context gives it: ask it in
  plain conversation text, and when the User answers there, run the
  `notifai close` command it names.

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
conversation is not archived (`reopen.codex_app`). When Notifai cannot
reproduce how a conversation started, or its permissions changed since, it
waits for the User instead. Do not ask the User to resume it.
`notifai config set reopen.terminal off` (or `reopen.automatic off` for every
place) makes it wait for the User; change these only when the User asks.

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
  matches and the command stays in the sandbox.
- Rules are experimental, and the most restrictive rule wins. When readiness
  says the rule check fails, or that your organization forbids it, approve
  Notifai commands when Codex asks; hooks keep working.

## Windows hooks

On Windows, Codex runs hooks through the session's own shell; Notifai's hook
command works under PowerShell and cmd.exe. A reinstall that changes the hook
definition needs the User's approval in `/hooks`; Notifai never grants hook
trust. Running sessions may keep the hooks they loaded: leave their work
running and check the new definition in a fresh session.

## After a Notifai update

Existing hook owners and approvals carry over. A changed handler can need the
User's `/hooks` approval. Follow the specific reload or stale-Stop remedy the
update reports, then confirm real hook calls, including the tool-boundary call
(`tool_boundary_notes` in [Updating Notifai](updates.md#local-integration-faults)).
