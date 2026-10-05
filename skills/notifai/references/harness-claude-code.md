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

**Claude Code on POSIX:** a detached observer starts after submission and
waits out of band for the complete answer window. The resident Session
Attendant sends wakes with Claude's required child-process ancestry. Stop
can recover answer ownership without holding the turn. When the
answer arrives it is stored with the session's pending inputs. Its own inbox
socket receives a wake-up: an idle Agent Session starts a new turn, and a busy
one receives it between tool calls or when its current turn ends. The prompt hook or the named
`notifai receive` command drains the current notes and answers together.
An Agent Session that is provably gone is cold-resumed with the wake-up
instead — never one whose liveness probe cannot rule it out.

**Claude Code on Windows:** the Stop hook stays held through the complete
answer window. When the answer arrives it returns `decision: block`, starting
the successor turn in the same Agent Session without another User prompt.
Direct inbox wake is unavailable, but it is not needed while this exact Stop
continuation owns the answer.

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
