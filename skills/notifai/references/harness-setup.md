# Harness setup and recovery

Run setup with the loop below and talk to the User as it says. Then come
sign-in, hook installation and trust, bounded recovery, and settings.

## What to tell the User

The User may be new to Notifai and to agent tooling. Send each message
exactly as written, as your whole reply: the same words, line breaks, blank
lines and Markdown (bold, links, numbered steps). Don't rephrase, shorten or
join its lines, don't put it in a quote or code block, and add nothing before
or after it except its QR. Never send the same message twice. Never ask the
User to tell you when a step is done: setup watches for it. Messages stay in
the conversation: never put a QR, link or code in a Notification Request.

Setup writes its own messages: `init --json` carries `message` when it has
something new to say. A gap with no `message` comes from an older Notifai: say
what `remedy.summary` asks, in plain words.

A few moments have no message from setup:

**install**, before you install Notifai:

> Installing Notifai so your agents can reach your phone.

**cloud**, when your commands run on a cloud or temporary machine:

> **I can't set up Notifai here:** this is a temporary machine.
>
> On your computer, run:
>
> `curl -fsSL https://notifai.sh/install.sh | sh`
>
> Or ask an agent there to follow **notifai.sh/setup**.

**which-computer**, when you can't tell where your commands run; carry on on
a yes, otherwise say **cloud**:

> Is this the computer your agents run on? That's the one Notifai connects.

**installer-needs-you**, when the installer reports a `user_action` or the OS
shows a permission prompt:

> **Installing Notifai needs you:** {the `user_action` message, or "check the prompt on your screen"}.

**done**, when setup is done and gave no message (an older Notifai):

> ✅ **Notifai is set up.** Your agents can notify you.

## Running setup

```bash
notifai init --json --wait 240
```

Run it in the foreground with a tool timeout of at least 5 minutes; if your
tool can't wait that long, lower `--wait` to fit. It never prompts. Progress
goes to stderr; stdout is one JSON object, and exit 1 with JSON is a normal
outcome. Setup opens the browser itself when the User has a step there.

After each run, send `message` unless you already sent it (with the QR,
below), then:

| Result | What you do |
| --- | --- |
| `waiting: true` | Send `message` if present, then rerun at once; say nothing else. |
| `stopped: true`, or the User declined this computer (`credential` gap, `technical.pairing_outcome` is `denied`) | End your turn. Run setup again only when the User asks. |
| `ready: true`, or no gap left | Setup is done: its message says so. If it gave none, say **done**. |
| first gap is `apps` | Ask which agent apps to connect (below). |
| first gap is `server`, or `credential` with `pairing_outcome` `not_started` or absent | Wait 10 seconds and rerun; if it repeats, send its `message` and stop. |
| first gap is `auth`, not about a plan | Rerun once; if it repeats, send its `message` and stop. |
| first gap is `contract`, `cli-bin` with status `gap`, or has `remedy.by` `cli` | Run `remedy.command`, then rerun. |
| any other gap | A step only the User can do: approve this computer, get the phone app, allow notifications, choose a plan. Rerun at once: setup watches for it. |

The first gap is the first `states` entry with `"status": "gap"`, skipping
`skill`, `question-routing-settings`, `claude-commands`, `codex-commands`,
any `hooks`/`hooks-*` entry with no `remedy.user_action`, and `proof` with no
`message`. `cli-bin` with status `optional-gap` is not a gap: keep using the
verified absolute command and the installer's PATH remedy.

If a rerun comes back at once with the same gap, no `waiting` and nothing new
to send, setup isn't watching that step: end your turn and rerun when the
User replies. A run cut off by your tool's timeout is harmless: rerun it. If
the User says they're done, rerun; if they say later or stop, end your turn.

**Which agent apps.** The first run asks it as the `apps` gap: its `message`
is the question, `technical.supported` lists every app (`id`, `name`) and
`technical.detected` the ids found on this computer. Ask it once, in your
harness's question tool as a multi-select with the found apps preselected if
it has one, otherwise as written. Then rerun with `--apps <ids>`
(comma-separated, or `detected`) and keep `--apps` on every later run. Setup
installs hooks, the skill (machine-wide) and command approval into those apps
without asking anything else. If the User wants none, rerun with
`--no-hooks --no-skills` instead.

The `proof` state is the test notification. It confirms that setup worked and
is never a setup step: never wait for it, run setup again for it, or ask the
User about it. Only a test notification that could not be sent or was
rejected is a `proof` gap with a `message`. Sending and Question Routing
(`question_routing_ready`) are separate; claim only what the JSON shows.

**An older Notifai.** If `init` exits 2 with `unknown option '--wait'` (or
`'--apps'`) and no JSON, run `notifai update --json`, which keeps the saved
channel, and start again. If it still doesn't know them, ask which agent apps
to connect yourself, then run
`notifai init --json --hooks --skills --skills-scope global --skills-harness <ids>`,
adding `--claude-commands` and `--codex-commands` when those apps are chosen.
It doesn't wait: send the first gap's `message`, end your turn, and rerun when
the User replies.

## Signing this machine in

Setup starts one approval for an unapproved Machine and opens the approval
page in this computer's browser, except over SSH. Its `message` carries the
code to compare and the link. The `credential` state's `technical.pairing`
holds protected local `qr_path` and `qr_text_path` artifacts, the
`approve_url` and the `code`.

Show the QR with each new approval `message`, where the message points (after
"scan this with the Notifai app:"). In a terminal or text-only harness, read
`qr_text_path` and reproduce the library-generated QR verbatim in a fenced
text block; where the harness displays local images, show `qr_path`. A file
path alone shows nothing; if you cannot show it, send the message alone and
never claim a QR was shown. Never include the QR, the message or the
proof-bearing link in any Notification Request field or media. Only the User
can approve; opening review never approves automatically.

While setup waits, an expiring code is extended, so the open page and the QR
keep working; a new code comes with a new `message`. A timeout or closed shell
does not strand an approval already given.

Only when the User asks for an approval notification instead, ask for their
Account email; never infer it from other services or files. Add
`--approval notification --approval-email <email>` to the setup command.
Requested delivery is not confirmed delivery. Every route resumes the same
pending approval.

`--name <name>` sets the Machine name; the hostname is the default.
`notifai logout` discards the saved credential and any pending approval and QR;
`notifai logout --revoke` first revokes this computer on the service.

`notifai auth status --json` says whether this machine is paired.
`notifai auth access --json` says whether the account has an active plan.
Setup needs no plan; delivering notifications does. They fail differently and
are worth separating before you report either as broken.

## Installing hooks and trust

Setup installs hooks, the skill and command approval into the agent apps the
User chose with `--apps`. There is no scope to ask about: Notifai installs one
lifecycle mechanism per harness, for this machine, and the skill machine-wide.
To connect another app later, rerun setup with the new `--apps` list. Codex
also needs the User to approve the Notifai hooks: setup's done message says
how, for the Codex surface it runs in, and never waits for it.

Only when the User asks for the skill in this project alone:

```bash
notifai init --skills --skills-scope project --skills-harness <comma-separated-harnesses> --json
```

Placing in one scope removes those harnesses' copies from the other, and every
other Notifai skill copy is brought current. Project placement for OpenClaw
requires a single, concrete configured agent workspace that matches the
command directory.

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

Notifai never writes trust approvals: the User grants them in the harness,
whose own trust view is authoritative over Notifai's diagnosis.

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

Output from an older Notifai that contains `native_question`:
[Native questions](native-questions.md).

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
conversation, or in your own question form, which stays in the conversation.
`doctor` reports that setting as the User's choice, not as a gap.

`NOTIFAI_NO_INPUT=1` is for scripts and CI: with it, no command ever prompts.
Run `notifai` without it: the CLI never prompts in a shell nobody is at, and
harness approval rules do not match a command that starts with a variable.

`NOTIFAI_CREDENTIALS=file` stores the machine credential in a plaintext file
rather than the OS keychain — only when the user has asked for it, and never on
a shared machine.

Node-based hook installations skip optional Notifai callbacks silently when
Node is below the CLI's runtime minimum. Native prompts and tools continue.
An explicit `notifai` command still reports the required Node upgrade.
