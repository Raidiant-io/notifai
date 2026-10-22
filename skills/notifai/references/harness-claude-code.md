# Claude Code

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

Run the installer if needed, start one fresh Agent Session, send one prompt,
then run `notifai doctor`. A session that was already running cannot receive
newly installed `SessionStart` context. If doctor finds no SessionStart,
reinstall the current hooks and start a fresh Agent Session; a prompt hook
alone never activates Notifai.

An ordinary subagent receives worker context: it reports to its parent and does
not notify. A worker explicitly delegated Notification Requests in its prompt
loads the skill and guidance as their owner.

## What arrives and what to do

Answers and notes come back on their own for the whole answer window. A busy
session receives a wake-up between tool calls or when its turn ends; an idle
one starts a new turn. The wake-up carries no answer; Claude Code shows it as a
message from another session, though it comes from Notifai. Follow it as the
skill's "When the answer arrives" says. Before Claude Code 2.1.224 on macOS and
Linux, or 2.1.234 on Windows, the answer arrives at the session's next turn
instead.

Closing the Agent Session ends its questions within seconds: exiting, closing
its terminal, or replacing it there with `/clear` or another conversation's
`/resume`. Never suggest any of these while a question waits. Continuing the
same conversation at once elsewhere (`/desktop`, the desktop app reopening it,
a resume in another terminal) keeps its questions, and their answers follow it.
Open in two places, it receives answers and notes in the most recently opened
one only. A `/branch` takes its questions with it where the service can move
them; otherwise they expire. A scripted `claude -p --resume` of it receives
nothing.

Stops the User did not make keep its questions open for their window: the
desktop app pausing a conversation it still lists, an app that hosts the
conversation stopping it after it sits idle or losing its terminal, and the
machine shutting down or restarting. An answer or note given meanwhile arrives
when the conversation comes back (the app reopening it, `claude --resume`),
possibly hours later: check that the work it answers still applies.

A terminal conversation the machine stopped reopens by itself when an answer or
note arrives: a new terminal window runs `claude --resume` in its folder, in the
permission mode it last ran in and never a more permissive one. When Notifai
cannot reproduce how it started, it waits for the User instead. Do not ask the
User to resume it.
`notifai config set reopen.terminal off` (or `reopen.automatic off` for every
place) makes it wait for the User; change these only when the User asks.

## Questions

Ask every question with `notifai ask` or `notifai ask --wait`, closed choices
included; neither opens a picker.

An `AskUserQuestion` picker you open on your own also reaches the User's
devices, after the terminal-first delay, with its questions, option labels and
descriptions; never also `ask` it. Its heading, or else its headers, becomes
the title, so make them name the decision as the `titles` guidance says. Mark
the option you recommend with Claude Code's own "(Recommended)" label suffix;
devices show it as the recommended choice. Option previews stay in the
terminal.

The picker takes whichever answer comes first and closes:

- **A device answer** is the picker's own result, as the User gave it: a
  question they skipped is left out, and typed text can stand beside or
  instead of a choice. Its context names `notifai acknowledge req_…`; run that
  before dependent work.
- **A device answer the picker could not return** closes it unanswered, with
  Notifai context that says so. End your turn: the answer arrives as your next
  message, with its own acknowledgement command. Do not ask again.
- **A question that expired on the devices** closes the picker unanswered,
  with Notifai context that says so: carry on without it.
- **A terminal answer** needs nothing from you. Notifai records it, so the
  devices stop asking.
- **A picker Claude Code continued while the User was away** is not an
  answer: the question stays open on their devices, and their answer arrives
  as your next message.
- **Esc, "Chat about this", or a picker another hook denies** withdraws the
  device question: continue in the conversation.

A picker stays in the terminal when question notifications are off, the
machine is not signed in, the User disabled this project, Notifai cannot carry
its shape, or it runs on Windows; it still works there.
`notifai logs --event hook.gate` shows why a picker stayed in the terminal
(`picker-terminal-only` and its `reason`) and how it closed.

## Command approval

In its default permission mode Claude Code asks before each Bash command it has
no permission rule for. A question, its wake-up and its acknowledgement are all
commands, so an away User's first question can wait at a terminal approval
nobody sees. Readiness reports this as `claude-commands` once Claude Code is
wired; it never blocks setup.

The offer depends on the session's permission mode. In `default` mode, outside
Claude Code, or before any hook has reported a mode (as in first-time setup),
`claude-commands` carries a remedy. In `auto`, `acceptEdits`, `plan`,
`bypassPermissions` or any other known mode it reads `not applicable` with no
remedy: do not offer the rules, do not ask the User about them, and do not run
the command. With the remedy present, or during first-time setup before Claude
Code is wired, on the User's yes:

```bash
notifai init --claude-commands --json
```

That adds allow rules to the User's Claude Code settings for `send`, `ask`,
`receive`, `acknowledge`, `status`, `replies`, `close`, `guidance` and
`session rename` only. Setup, configuration, guidance edits, logs and sign-out
keep their prompt. `notifai hooks uninstall` removes the rules with the wiring.
Never add them unasked, and never edit Claude Code's permission settings by hand.
If setup reports that the rules were not added, it says why in one line: relay
that to the User and do not retry.

## After a Notifai update

The hooks call the updated CLI on their next run; reread changed guidance
yourself. A changed hook definition counts as loaded only once a natural hook
call shows it. A definition Claude Code holds in memory may need a fresh Agent
Session.
