# Harness setup and recovery

Choose the branch for the reported gap: sign-in, hook installation and trust,
or bounded recovery. Settings follow the steps.

## Signing this machine in

Run `notifai init --json` yourself. An unapproved Machine starts one approval,
defaults to QR without asking for email, polls once, and returns. Progress is
on stderr and final readiness on stdout. The `credential` state's
`technical.pairing` holds protected local `qr_path` and `qr_text_path` artifacts,
the `approve_url`, the matching `code` and the prepared `message`. Present the
QR first: show the local image where supported, or read `qr_text_path` and
reproduce the library-generated QR verbatim in a fenced text block in a
terminal/text-only harness. Then send `message` in the conversation as written,
and end your turn. Never include the QR, the message or the proof-bearing link
in any Notification Request field or media. Only the User can approve; opening
review never approves automatically. If the harness cannot display the local
QR, send the `approve_url` as the way to approve rather than claiming a QR was
shown.

Only when the User chooses an approval notification, ask for their Account
email; never infer it from other services or files. Run `notifai init --approval notification --approval-email <email>
--json`. Requested delivery is not confirmed delivery. For the browser
alternative use `--approval browser`; it opens no browser by default. Every
route resumes the same pending approval. When the User says it is approved,
run setup again. If it reports a new code, relay that code. A timeout or closed
shell does not strand an approval already given.

`--name <name>` sets the Machine name; the hostname is the default.
`notifai logout` discards the saved credential and any pending approval and QR;
`notifai logout --revoke` first revokes this computer on the service.

`notifai auth status --json` says whether this machine is paired.
`notifai auth access --json` says whether the account has access, including
access already requested and waiting on a person — not something to ask them to
do again. They fail differently and are worth separating before you report
either as broken.

## Installing hooks and trust

After the User chooses hooks, install the lifecycle wiring.
There is no scope to ask about: Notifai installs
one lifecycle mechanism per harness, for this machine.

```bash
notifai init --hooks --json
```

Installing the agent guidance skill keeps its own independent placement choice,
which belongs to the User and says nothing about where hooks land:

```bash
notifai init --skills --skills-scope <project|global> --skills-harness <comma-separated-harnesses> --json
```

Choose only the intended harnesses; without `--skills-harness`, the harnesses
that already load the skill keep it. Placing in one scope removes those
harnesses' copies from the other, and every other Notifai skill copy is brought
current. Project placement for OpenClaw requires a single, concrete configured
agent workspace that matches the command directory. Use global scope when that
workspace is ambiguous.

A machine-wide Notifai skill is guidance, not routing evidence. The active
harness needs its installed hook and a current session pointer.

In the `init --json` result, `question_routing_ready` says whether questions
can come back to this Agent Session. Where the harness has no later answer route
(Cursor, OpenCode, OpenClaw off macOS) it judges the route that harness has,
`notifai ask --wait`; the missing later route is `informational`, not a gap. `direct_wake_ready` says whether an
answer can start a turn on its own; it is optional when a held turn or
recovery owns the answer, and `null` when nothing assessed it.

`notifai ask --json` checks its own admission: branch on `code`, `check_id`,
`exit_code` and `remedy` instead of running doctor first. It never guesses an
Agent Session and has no `--session-id` override.

Notifai never writes trust approvals. If its diagnosis and Codex disagree,
`/hooks` is authoritative.

The prepared User message for this human-only action is:

> Open `/hooks` in Codex, approve or enable the Notifai handlers, then tell me
> when it is done. I will finish setup and verify a fresh session.

### Your harness

Read only the file for the harness you are in: when installing or verifying
its activation, when you need how its questions, answers and notes arrive or
how it approves Notifai commands, or after a Notifai update. Claude Code,
Codex, Cursor and Grok each say how they approve Notifai commands.

- [Claude Code](harness-claude-code.md)
- [Codex](harness-codex.md)
- [Cursor](harness-cursor.md)
- [OpenCode](harness-opencode.md)
- [OpenClaw](harness-openclaw.md)
- [Hermes](harness-hermes.md)
- [Grok](harness-grok.md)

Do not infer Question Routing from managed installation. `notifai doctor`
reports each harness's supported route separately.

## Bounded recovery

Follow the exact `notifai doctor` diagnostic. Repair the affected owned scope,
verify the capability it changed with one fresh activation when needed, and
recheck once. Preserve healthy compatible owners. A changed definition may need
reload or approval; unchanged files do not require a fresh session. Stop if the current pointer
belongs to another active session or if the hook still has not fired; ask the
user or coordinator instead of retrying indefinitely.

If a companion device is missing, ask the user to open a supported companion
build, sign in, and grant notification permission. Do not emulate that, and do
not treat Provider Acceptance as Companion Receipt proof.

To turn Notifai off in one project while leaving other projects wired, run
`notifai project disable`: nothing from that project reaches the User's
devices until `notifai project enable`.
`notifai hooks uninstall` removes the machine's lifecycle wiring for every
project; pass `--harness <name>` to name one when several are wired. Uninstall
also clears any Project-scoped hook file an older Notifai left in this
checkout.

Where no answer can come back to this Agent Session later, including a shell
that several harness sessions could own, `ask` refuses and names
`notifai ask --wait`: the command itself waits for the answer, so give it no
command timeout shorter than your harness's default. Never strip inherited
harness markers or borrow another Agent Session's identity to make `ask` pass;
basic sending remains available without guessed Source Context.

For a missing answer to an open question, keep its IDs and inspect
`notifai status <request_id> --json` and `notifai replies <request_id> --json`
instead of asking again. Queue acceptance does not prove consumption.
Read [Diagnostics](diagnostics.md#log-filters) before concluding a hook failed.

## Settings and environment

`notifai config explain <key> [--json]` gives the full explanation of one
setting; `notifai config show --explain` includes advanced keys and the file
each value came from.

With no scope flag, `notifai config set` writes Machine-Global Configuration.
`--local` writes a Project Override under the user's configuration directory;
one local Git checkout and all its linked worktrees resolve to the same file.
Nothing in the repository configures Notifai.

With “Send questions to my devices” (`ask_notifications`) off, ask in the
conversation, or in your own question form, which stays in the terminal.
`doctor` reports that setting as the User's choice, not as a gap.

`NOTIFAI_NO_INPUT=1` is for scripts and CI: with it, no command ever prompts.
Run `notifai` without it: the CLI never prompts in a shell nobody is at, and
harness approval rules do not match a command that starts with a variable.

`NOTIFAI_CREDENTIALS=file` stores the machine credential in a plaintext file
rather than the OS keychain — only when the user has asked for it, and never on
a shared machine.
