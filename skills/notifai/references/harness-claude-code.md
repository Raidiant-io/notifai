# Claude Code

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**Claude Code:** run the installer if needed, start one fresh Agent Session,
send one prompt, then run `notifai doctor`. An already-running Agent Session cannot
receive newly installed `SessionStart` context. If SessionStart is absent,
reinstall the current hooks and start a fresh Agent Session; UserPromptSubmit
records presence and question lifecycle only and never substitutes for
lifecycle activation. Claude's SubagentStart gives ordinary workers the
reporting-only context; explicit textual delegation makes a worker load the
skill and guidance as the new Notification Request owner.

## How the answer gets back

**Claude Code:** after submission Notifai waits out of band for the complete
answer window: on macOS and Linux the shared hub waits, and a small session
child that stays the session's own child writes the wake-up, opening the inbox
with the session's token. On Windows a per-session resident does both. Stop
can recover answer ownership without holding the turn. When the
answer arrives it is stored with the session's pending inputs. Its own inbox
socket receives a wake-up: an idle Agent Session starts a new turn, and a busy
one receives it between tool calls or when its current turn ends. The wake-up
carries no answer; Claude Code shows it as a message from another session. The prompt hook or the named
`notifai receive` command drains the current notes and answers together.
Closing the Agent Session ends its questions within seconds: exiting, closing
its terminal, or replacing it there with `/clear` or another conversation's
`/resume`. Notifai never resumes it. When the same conversation continues at
once elsewhere (`/desktop`, the desktop app reopening it, a resume in another
terminal), its questions stay open and their answers follow it. Open in two
places at once, it receives answers and notes in the most recently opened one
only; closing one leaves the other. Stops the User did not make keep its
questions open for their window: the desktop app pausing a conversation it
still lists, an Orca chat stopping it after 30 idle minutes, Orca losing a
pane's terminal, and the machine shutting down or restarting. An answer given meanwhile arrives when
the conversation comes back (the app reopening it, `claude --resume`),
possibly hours later: check that the work it answers still applies. Notes
sent meanwhile wait and arrive the same way. A terminal conversation the
machine stopped reopens by itself when an answer or note arrives: a new
terminal window in its folder and config home runs `claude --resume` with the
options it was started with, in the permission mode it last ran in (never a
more permissive one). One that started before this Notifai version, or with
an option Notifai does not know, waits for the User instead. Do not ask the
User to resume it meanwhile. `notifai config set reopen.terminal off` (or `reopen.automatic off`
for every place) makes it wait for the User instead; change these only when
the User asks. A `/branch` of it continues it
under a new id: its questions and their answers move to the branch when the
service supports it (an older service only once the branch has sent a
notification), and expire otherwise. A scripted `claude -p --resume` of it receives nothing.

The inbox is a socket on macOS and Linux from Claude Code 2.1.224, and a
named pipe on Windows from 2.1.234. On an older Claude Code the answer is
still delivered, at the Agent Session's next turn rather than on its own.

## Question picker

In Claude Code, ask a question with two to four closed choices through the
`AskUserQuestion` picker, not `notifai ask`. The picker is the Notifai
question: Notifai turns it into a question on the User's devices by itself.
Do not register it, or a free-text version of it, with `ask` as well; the User
would be asked twice. `ask` refuses a question the picker can show, with exit 2,
code `use_question_picker` and the picker input to use. Keep `notifai ask` for
free-text questions and questions with more than four choices.

The picker's wording is yours. Put context in option descriptions or in your
message, and mark the option you recommend with Claude Code's own
"(Recommended)" label suffix. Devices show the question, shortened when it is
over 240 characters, each label with its description under it, and the
recommended option marked. Wording too long for a device stays whole in the
notification body.

The picker takes whichever answer comes first and closes:

- **A device answer** is the picker's own result, as the User gave it: a
  question they skipped is left out, and typed text can stand beside or
  instead of a choice. Its context names `notifai acknowledge req_…`; run that
  before dependent work.
- **A device answer the picker could not return** closes it unanswered, with
  Notifai context that says so. End your turn: the answer arrives as your next
  message, with its own acknowledgement command. Do not ask again.
- **A question the User dismissed on a device** closes the picker unanswered,
  with Notifai context that says so. They will not answer it: carry on
  without it.
- **A terminal answer** needs nothing from you. Notifai records it, so the
  devices stop asking.
- **Esc, "Chat about this", or a denied picker** withdraws the device question.
  Ask again if you still need the answer.

A picker that cannot reach devices still works in the terminal. This happens
when the Project is not enabled, the machine is not signed in, question routing
is off, or the picker belongs to a subagent. `notifai logs --event hook.gate` shows each outcome:
`picker-terminal-only` with its `reason`, `picker-waiting`, `picker-answered`,
`picker-dismissed` or `picker-closed`. Pickers reach devices on macOS and
Linux.

## Command approval

In its default permission mode Claude Code asks before each Bash command it has
no permission rule for. A question, its wake-up and its acknowledgement are all
commands, so an away User's first question can wait at a terminal approval
nobody sees. Readiness reports this as `claude-commands` once Claude Code is
wired; it never blocks setup.

The offer depends on the session's permission mode. Notifai learns it from
the session's own hooks, from the mode the session was started with, or from
`permissions.defaultMode` in the Claude Code settings; when none of them names
a mode, as in first-time setup before any hook has run, it is Claude Code's
default. Outside Claude Code or in `default` mode, `claude-commands` carries a
remedy. In `auto`, `acceptEdits`, `plan`, `bypassPermissions` or any other
known mode it reads `not applicable` with no remedy: do not offer the rules, do
not ask the User about them, and do not run the command. With the remedy
present, or during first-time setup before Claude Code is wired, on the User's
yes:

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
