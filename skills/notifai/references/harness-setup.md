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

Run `notifai init --json` yourself. An unapproved Machine starts one approval,
defaults to QR without asking for email, polls once, and returns. Progress is
on stderr and final readiness on stdout. The `credential` state's
`technical.pairing` holds protected local `qr_path` and `qr_text_path` artifacts,
the `approve_url`, and matching `code`. Present the QR before requesting a scan:
show the local image where supported, or read `qr_text_path` and reproduce the
library-generated QR verbatim in a fenced text block in a terminal/text-only harness.
Display the matching code beside it. Never include the QR
or proof-bearing link in any Notification Request field or media. Use T2 from
<https://app.notifai.sh/setup.md>: the User reviews their Account, computer, and
matching code in their signed-in Companion App before approving. A valid Auth
Session needs no additional email code merely to approve a Machine. Only the User can approve; opening review never approves automatically.
If the harness cannot display the local QR, present the browser alternative
truthfully rather than claiming a QR was shown.

Only when the User chooses an approval notification, ask for their Account
email; never infer it from other services or files. Run `notifai init --approval notification --approval-email <email>
--json`. Requested delivery is not confirmed delivery. For the browser
alternative use `--approval browser`; it opens no browser by default. Every
route resumes the same pending approval. When the User says it is approved,
run setup again. If it reports a new code, relay that code. A timeout or closed
shell does not strand an approval already given.

`--name <name>` sets the Machine name; the hostname is the default.
`notifai logout` discards the saved credential and any pending approval and QR.

`notifai auth status --json` says whether this machine is paired.
`notifai auth access --json` says whether the account has access, including
access already requested and waiting on a person — not something to ask them to
do again. They fail differently and are worth separating before you report
either as broken.
`notifai logout` removes the stored credential.

## Install deliberately

Flagless `notifai init --json` asks no terminal questions and advances the
required setup steps; its reported gap names any remaining User action. Hooks
place files, so this is where a question belongs: ask whether
they want questions routed. There is no scope to ask about — Notifai installs
one lifecycle mechanism per harness, for this machine, and whether it acts in a
project is `notifai project enable`. Never tell the user to run setup commands
themselves.

```bash
notifai init --hooks --json
```

Installing the agent guidance skill keeps its own independent placement choice,
which belongs to `npx skills` and says nothing about where hooks land:

```bash
notifai init --skills --skills-scope <project|global> --json
```

A machine-wide Notifai skill is guidance, not routing evidence. The active
harness needs its installed hook and a current session pointer.

Installed definitions call one stable user-level adapter at
`~/.notifai/bin/hook-adapter`. `hooks install` atomically retargets that adapter
to the current CLI while leaving definition bytes unchanged across Node/NVM,
package-manager, CLI-version, checkout, XDG directory, and Notifai preference
changes. Codex Stop runs asynchronously on every platform; Claude Code Stop
runs asynchronously on POSIX and blocks on Windows. Both declare a timeout
above the longest answer window so their waiters can own the complete window;
prompt-submit and session-end retain fixed short limits on both.
Codex SessionStart stays within the harness's built-in inline-context budget;
Notifai does not add an output-limit override that would create a second trust
identity. Upgrades preserve both the source file and the approved definition.
Migrating an older Codex definition requires one unavoidable `/hooks` approval;
later upgrades must not require another.

`notifai ask --json` owns its admission check. On failure, branch on its stable
`code`, `check_id`, `exit_code`, and `remedy`; do not run a routine doctor pass
first. The current Agent Session's UserPromptSubmit observation proves that the
exact session owns this turn. A historical Stop observation is diagnostic
telemetry, not an admission prerequisite: the installed, trusted, current,
singular Stop definition and its answer waiter establish that the asking
turn can route the question. Ask exposes no `--session-id` override and will
not guess one.
When the failure includes a User-owned trust or permission `user_action`, relay
the exact `remedy`, say the hooks need the User's trust or approval, and wait.
Never bypass that gap with `notifai send --reply`.

`hooks-wake-route` reports, without probing anything, whether an answer could
start a turn in this exact Agent Session after its ordinary continuation has
returned. It never blocks Question Routing. On Windows, Claude Code has no
direct inbox wake because upstream exposes no inbox socket: its blocking Stop
still holds the complete answer window and returns the answer to the same Agent
Session without another User prompt.

Notifai never writes trust approvals. If its diagnosis and Codex disagree,
`/hooks` is authoritative.

The prepared User message for this human-only action is:

> Open `/hooks` in Codex, approve or enable the Notifai handlers, then tell me
> when it is done. I will finish setup and verify a fresh session.

For a genuine unsupported-harness fallback, the blocking command is the
foreground owner. Keep it alive for the complete answer window and set
`--reply-timeout` equal to `--reply-window`. If it times out, preserve its
request ID, inspect the original with `notifai replies <request_id> --json` and
`notifai status <request_id> --json`, and never send a duplicate.

Conflicting inherited harness markers also require that foreground flow.
Historical hook timestamps cannot prove which nested Agent Session owns a
shell. Do not strip markers or borrow another Agent Session's identity to make
`ask` pass; basic sending remains available without guessed Source Context.

## Activation by harness

Activation and the answer's last meter differ per harness. Read only the file
for the harness you are in:

- [Claude Code](harness-claude-code.md)
- [Codex](harness-codex.md)
- [Cursor](harness-cursor.md)
- [OpenCode](harness-opencode.md)
- [OpenClaw](harness-openclaw.md)
- [Hermes](harness-hermes.md)
- [Grok](harness-grok.md)

Do not infer Question Routing from managed installation. `notifai doctor`
reports each harness's supported route separately.

## How the answer gets back to the agent

The session that registered a question owns the answer's return. The last
meter is in that harness's file above. Cursor, OpenCode, OpenClaw and Hermes
have no separate route beyond what their activation describes.

**Crash recovery:** the answer journal protects an accepted answer if an
owner process or its route fails. It is not the normal last meter for an
unexpired question.

`ask` durably registers the question and immediately launches submission. It
does not wait for Stop or hold the command for the answer window. Stop and
UserPromptSubmit recover outstanding work; they are not required to begin
normal submission. Registration is not evidence of Provider Acceptance.

Continue independent work and supervision while the question is outstanding.
Only answer-dependent work waits. Delivery into the agent still follows the
harness boundaries above; immediate submission does not make every harness
able to inject an answer during a running turn.

Keep the original identity when an answer has not arrived. Queue acceptance
does not prove consumption, and expiry, retirement, or recovery failure can
prevent resumption. Inspect `status` and `replies` instead of re-asking.

At the `ask_grace_seconds` default of `0`, the question reaches devices as soon
as registration starts background submission. A positive value keeps it in the terminal for that
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

To stop Notifai acting in one project while leaving other projects wired, run
`notifai project disable` — that is the per-project switch. `notifai hooks
uninstall` removes the machine's lifecycle wiring for every project; pass
`--harness <name>` to name one when several are wired. Uninstall also clears
any Project-scoped hook file an older Notifai left in this checkout.

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

With no scope flag, `notifai config set` writes Machine-Global Configuration.
`--local` writes a personal Project Override under the user's configuration
directory; one local Git checkout and all its linked worktrees resolve to the
same file. `--project` is deliberately different: it writes the tracked shared
`.notifai/config.toml` at the repository root. Do not create that repository
file during setup or to preserve personal state, and do not reach into another
worktree to write it—make the explicit shared change in the active checkout and
merge it through Git.

`ask_notifications` is the setting that turns question routing off for a scope;
`ask_grace_seconds` is the terminal-first window described above;
`reply_window_seconds` is how long an answer is still accepted, a day by
default and up to three.

Those are three different controls and only the last one decides whether an
answer is still wanted. Question Routing owns that complete window. Claude Code
waits out of band and wakes the Agent Session on POSIX; on Windows its Stop
stays held and returns the answer as the same Agent Session's continuation,
while Codex queues a wake-up into its Agent Session's durable inbox. Codex and
POSIX Claude keep pending input locally until a foreground drain; the native
wake never stores a second copy of the User's answer.

`NOTIFAI_NO_INPUT=1` guarantees no command will ever prompt, which is what you
want in CI or any shell with nobody at it. `NOTIFAI_CREDENTIALS=file` stores the
machine credential in a plaintext file rather than the OS keychain — only when
the user has asked for it, and never on a shared machine.

`notifai init` never creates `.notifai/config.toml`; that file is only for
tracked, shared overrides a Project chooses to commit.
