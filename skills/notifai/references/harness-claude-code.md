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

**Claude Code:** a detached observer starts after submission and
waits out of band for the complete answer window. The resident Session
Attendant sends wakes as the sender Claude Code accepts: its own child on
macOS and Linux, and the holder of the session's inbox token on Windows. Stop
can recover answer ownership without holding the turn. When the
answer arrives it is stored with the session's pending inputs. Its own inbox
socket receives a wake-up: an idle Agent Session starts a new turn, and a busy
one receives it between tool calls or when its current turn ends. The prompt hook or the named
`notifai receive` command drains the current notes and answers together.
Closing the Agent Session ends its questions; Notifai never resumes it.

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
message. Devices show the question, shortened when it is over 240 characters
with the whole wording in the notification body, plus every label and option
description.

The picker takes whichever answer comes first and closes:

- **A device answer** is the picker's own result. Its context names
  `notifai acknowledge req_…`; run that before dependent work.
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

Claude Code asks before each Bash command it has no permission rule for, unless
the session skips permission prompts. A question, its wake-up and its
acknowledgement are all commands, so an away User's first question can wait at
a terminal approval nobody sees. Readiness reports this as `claude-commands`
once Claude Code is wired; it never blocks setup. On the User's yes:

```bash
notifai init --claude-commands --json
```

That adds allow rules to the User's Claude Code settings for `send`, `ask`,
`receive`, `acknowledge`, `status`, `replies`, `close`, `guidance` and
`session rename` only. Setup, configuration, guidance edits, logs and sign-out
keep their prompt. `notifai hooks uninstall` removes the rules with the wiring.
Never add them unasked, and never edit Claude Code's permission settings by hand.
