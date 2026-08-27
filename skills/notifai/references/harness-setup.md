# Harness setup and recovery

The mechanics behind installing Notifai, routing questions to devices, and
working out why either is not happening. Read it when you are installing,
diagnosing, or recovering — not before.

- [Signing this machine in](#signing-this-machine-in)
- [Install deliberately](#install-deliberately)
- [Activation by harness](#activation-by-harness)
- [How the answer gets back to the agent](#how-the-answer-gets-back-to-the-agent)
- [Bounded recovery](#bounded-recovery)
- [Reading the record](#reading-the-record)
- [Settings and environment](#settings-and-environment)

## Signing this machine in

Run `notifai login` yourself. It opens a browser page only the user can approve.

In a headless or remote shell, `notifai login --no-open` prints the approval URL
instead of trying to open a browser — hand the user that URL. `--name <name>`
sets what the machine is called in their dashboard; the hostname is the default.

`notifai auth status --json` says whether this machine is paired.
`notifai auth access --json` says whether the account has an active plan. They
fail differently and are worth separating before you report either as broken.
`notifai logout` removes the stored credential.

## Install deliberately

Ask setup scope and whether they want questions routed in the same structured
question. If they do, let init install and assess the hooks in their chosen
scope. Never tell the user to run setup commands themselves.

```bash
notifai init --hooks --setup-scope <project|global> --json
```

A machine-global Notifai skill is guidance, not routing evidence. The active
harness needs its own installed hook and a current session pointer.

Installed definitions call one stable user-level adapter at
`~/.notifai/bin/hook-adapter`. `hooks install` atomically retargets that adapter
to the current CLI while leaving definition bytes unchanged across Node/NVM,
package-manager, CLI-version, checkout, XDG directory, and Notifai preference
changes. Stop definitions differ by harness: Claude Code's runs asynchronously
with an explicit timeout above the longest answer window (POSIX hosts only — on
Windows it blocks like the others), and Codex declares the same full-window
timeout; prompt-submit and session-end retain fixed short limits on both.
Migrating an older Codex definition requires one unavoidable `/hooks` approval;
later upgrades must not require another.

`notifai ask --json` owns its admission check. On failure, branch on its stable
`code`, `check_id`, `exit_code`, and `remedy`; do not run a routine doctor pass
first. Historical UserPromptSubmit and Stop evidence remains part of that
fail-closed check. Ask exposes no `--session-id` override and will not guess one.

`hooks-wake-route` reports, without probing anything, whether an answer could
start a turn in this exact Agent Session on its own. It never blocks: when it
cannot, the answer is held and replayed at the Agent Session's next turn instead.

Notifai never writes trust approvals. If its diagnosis and Codex disagree,
`/hooks` is authoritative.

The prepared User message for this human-only action is:

> Open `/hooks` in Codex, approve or enable the Notifai handlers, then tell me
> when it is done. I will finish setup and verify a fresh session.

## Activation by harness

- **Claude Code:** run the installer if needed, start one fresh Agent Session,
  send one prompt, then run `notifai doctor`. An already-running Agent Session cannot
  receive newly installed `SessionStart` context. If SessionStart is absent,
  reinstall the current hooks and start a fresh Agent Session; UserPromptSubmit
  records presence and question lifecycle only and never substitutes for
  lifecycle activation. Claude's SubagentStart gives ordinary workers the
  reporting-only context; explicit textual delegation makes a worker load the
  skill and guidance as the new Notification Request owner.
- **Codex:** run `notifai hooks install --harness codex`. If `hooks-trust`
  fails, open `/hooks` in Codex and approve or enable the Notifai handlers.
  Then start one fresh Agent Session, send one prompt, and run `notifai doctor`. If
  SessionStart is absent, reinstall the current hooks and start a fresh Agent Session;
  UserPromptSubmit does not activate it. Codex SubagentStart uses the same
  reporting-only worker contract and explicit textual delegation rule as
  Claude. Codex resolves project hooks from the main repository. In a
  linked worktree, the installer writes the shared file to
  the main checkout and creates the project-layer `.codex` directory in the
  current worktree; run it once in each new worktree.
- **Cursor:** start one fresh conversation, send one prompt, and let the first
  completed or errored turn finish. Cursor's `SessionStart` context is currently
  lossy, so one visible synthetic follow-up activates Notifai through its native
  Stop contract; cancellation does not trigger it, and a live question
  continuation takes priority. Then run `notifai doctor`. The agent shell does
  not create a separately activated context for delegated work: it remains
  under the parent Agent Session and its explicit Notification Request ownership. It
  does not expose the exact conversation id needed to prove which concurrent Agent Session
  invoked `notifai ask`, so asynchronous ask fails closed. Use blocking
  `notifai send --reply` for questions.
- **OpenCode:** restart after installation because plugins load at startup,
  then start one fresh Agent Session, send one prompt, and run `notifai doctor`.
  Notifai owns its generated plugin file and will not overwrite a foreign one.
  The plugin treats a session with `parentID` as a worker. When relationship
  lookup fails or returns unusable data it also fails safe as a non-sending
  worker; only a proven parent Agent Session receives owner context. Explicit textual
  delegation promotes that worker through the same skill-and-guidance rule.
  OpenCode has no locally proven exactly-once continuation after `session.idle`,
  so `notifai ask` fails closed instead of accepting an answer into a void.
  Use a blocking `notifai send --reply` question when its answer must return to
  the agent without another human prompt.

Do not claim support for a harness that is absent from
`notifai hooks install --help`.

## How the answer gets back to the agent

The session that registered a question owns the answer's return. The last
meter differs per harness:

- **Claude Code:** the Stop hook is asynchronous. It returns at once, so the
  turn is never held and the terminal stays the user's, and the same process
  keeps waiting out of band for the complete answer window. When the answer
  arrives it is posted to that Agent Session's own inbox socket: an idle Agent
  Session starts a new turn with it, and a busy one receives it when its current
  turn ends. An Agent Session that is provably gone is cold-resumed instead —
  never one whose liveness probe cannot rule it out.
- **Codex:** the Stop hook is the waiter. It holds until the answer arrives or
  the complete answer window ends, then continues the session by returning
  `decision: block`.
- **Crash recovery:** the answer journal protects an accepted answer if an
  owner process or its route fails. It is not the normal last meter for an
  unexpired question.

An accepted answer is never dropped and never delivered twice, so a question
that has not come back yet is still coming: do not re-ask it.

At the `ask_grace_seconds` default of `0`, the question reaches devices as soon
as the asking turn ends. A positive value keeps it in the terminal for that
long first, so an answer typed there wins without a notification ever leaving.
`reply_window_seconds` then controls how long the answer is accepted and how
long Question Routing keeps an exact return path to this Agent Session. The
grace window is skipped when a question from this Agent Session is already
waiting on the user's devices: they have been interrupted already, and holding
the second question back would only delay it.

## Bounded recovery

Follow the exact `notifai doctor` diagnostic. Common recovery is one repair,
one fresh activation, and one new doctor check. Stop if the current pointer
belongs to another active session or if the hook still has not fired; ask the
user or coordinator instead of retrying indefinitely.

If a companion device is missing, ask the user to open a supported companion
build, sign in, and grant notification permission. Do not emulate that, and do
not treat Provider Acceptance as Companion Receipt proof.

To stop routing questions from this project, `notifai hooks uninstall`; add
`--global` to remove a machine-wide install, and `--harness <name>` to name one
when several are wired.

## Reading the record

`notifai logs` narrows several ways, and they compose:

- `--request <id>` · `--run <id>` · `--session <id>` — one notification, one
  invocation, one Agent Session
- `--event <name>` (repeatable) · `--grep <text>` · `--level error`
- `--since 10m|2h|1d|<ISO 8601>` · `-n <count>` · `--all` · `--project <id>` ·
  `--all-projects`
- `--json` for one record per line, `--path` for where the files are

`--clear` deletes the user's local record. It is theirs, and nothing else keeps
a copy — do not run it to tidy up.

## Settings and environment

`notifai config explain <key> [--json]` gives the full explanation of one
setting; `notifai config show --explain` includes advanced keys and the file
each value came from. Beyond the usual scopes, `--session <id>` writes a
preference that lasts only for one Agent Session.

`ask_notifications` is the setting that turns question routing off for a scope;
`ask_grace_seconds` is the terminal-first window described above;
`reply_window_seconds` is how long an answer is still accepted, a day by
default and up to three.

Those are three different controls and only the last one decides whether an
answer is still wanted. Question Routing owns that complete window: Claude Code
waits out of band and wakes the Agent Session, while Codex keeps the asking turn
held. The journal is crash recovery, not the ordinary delivery path.

`NOTIFAI_NO_INPUT=1` guarantees no command will ever prompt, which is what you
want in CI or any shell with nobody at it. `NOTIFAI_CREDENTIALS=file` stores the
machine credential in a plaintext file rather than the OS keychain — only when
the user has asked for it, and never on a shared machine.
