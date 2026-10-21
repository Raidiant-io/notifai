# Diagnosing what happened

For a local integration notice, run `notifai doctor --json` to identify the lost
capability. Read [Updating Notifai](updates.md) for safe recovery, existing
authorization and deferrals, and exact-session tool-boundary Note evidence.
An optional newer release is separate from a fault in installed integration.
Doctor judges the `harness` running it: a state with `applies_here: false`
belongs to another harness, so report it and do not act on it for this session.

When something did not happen and you cannot see why — especially after `ask`,
which schedules background submission — inspect the local log.
Local registration alone proves neither submission nor Provider Acceptance:

```bash
notifai logs                     # recent record for this project
notifai logs --level error       # only what failed
notifai logs --request <id>      # everything about one notification
notifai logs --since 10m --json  # JSONL on stdout, for parsing
```

An empty record can mean `log_level` is `off` — check it before concluding a
hook never ran. Question outcomes (`ask.registered`, `hook.gate`, `hook.pushed`,
`hook.answer`, `hook.retirement`, refused asks) are also kept in a separate,
slower-rotating file, so `notifai logs --event hook.gate --since 2d` still
finds them days later.

`hook.gate` records carry a fixed `reason` — `question-notifications-off`,
`claimed-elsewhere`, `no-question`, `no-session`, `answered`,
`acknowledgement-required`, `acknowledgement-abandoned`, `harness-cannot-continue`,
`delivery-limit`, `proceeding` —
so filter on that, never on the wording of a message. A Claude Code picker or
OpenCode form that stayed in the terminal logs the stage `picker-terminal-only`
or `form-terminal-only` with a `reason` of its own, such as `not-signed-in`.
`question-notifications-off` is the one the user deliberately never sees, which
is why it is worth ruling out before concluding anything is broken.

There is no limit on successive answered questions. A `delivery-limit` gate
bounds repeated delivery attempts for the same answer, not the number of
decisions the User can make in a conversation.

On macOS and Linux one shared hub attends every Agent Session on the machine.
These doctor lines and log events explain what it did:

| Doctor line or log event | What it tells you | What to do |
| --- | --- | --- |
| Doctor's hub line | Whether the hub runs and what it attends; whether an older hub is still handing over, or has stopped restarting after three crashes in ten minutes | Not running is normal with no session open. A handover needs nothing; never end sessions for it |
| `--event hub.session`, `--event hub.exchange` | Sessions registering and ending, and the hub's service traffic | Read before concluding a session was lost; a restarted hub takes its sessions back |
| `--event hub.handover` | An older hub handing over to the current build, or the one thing it finishes first | Nothing |
| `--event update.automatic` | Automatic updates staged, held back and why, or activated | Follow [Updating Notifai](updates.md) |
| Doctor's wake route; JSON `shared_server_check`; `hub.session` records `codex-check-…`, `wake-held`, `terminal-closed` | For a Codex terminal on Codex's shared server: whether an answer can start a turn or waits for the next prompt, and where a failed check stopped | Tell the User when answers will wait for their next prompt |
| Doctor's `Reopen:` line; JSON `reopen`; `--event hub.reopen` | Whether a stopped conversation was reopened in a new terminal window or continued in the Codex app, or the reason it was left waiting. While the machine shuts down nothing reopens until the next start | `stalled` means it came back but has not taken its answer, most likely held at a prompt in its window: tell the User |
| Doctor's `claude code hook form` check | Whether Claude Code's hooks run in exec or shell form, and why | On failure run `notifai hooks install --harness claude-code`. Shell form kept "while an older Notifai still attends a Claude Code session" needs nothing |

When sign-in looks fine but nothing sends, `notifai auth status --json` and
`notifai auth access --json` separate a pairing problem from an account without
an active plan — report which one it is instead of calling it a delivery
failure.

The log never leaves the machine, and it contains the user's own answers. Treat
it like any other private file of theirs.

## Log filters

`notifai logs` narrows several ways, and they compose:

- `--request <id>` · `--run <id>` · `--session <id>` — one notification, one
  invocation, one Agent Session
- `--event <name>` (repeatable) · `--grep <text>` · `--level error`
- `--since 10m|2h|1d|<ISO 8601>` · `-n <count>` · `--all` · `--project <id>` ·
  `--all-projects`
- `--json` for one record per line, `--path` for where the files are

`--clear` deletes the user's local record. It is theirs, and nothing else keeps
a copy — do not run it to tidy up.
