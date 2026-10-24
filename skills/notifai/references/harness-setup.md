# Harness setup and recovery

Choose the branch for the reported gap: sign-in, hook installation and trust,
or bounded recovery. Settings follow the steps. Whatever the branch, talk to
the User with the scripts below.

## What to tell the User

The User may be new to Notifai and to agent tooling. At each moment that needs
them, send that moment's script in the conversation: fill the `{placeholders}`
from the `init --json` result, keep the words, and add nothing before or
after. One moment per message; when a script asks for something, end your turn
and continue from their reply. Scripts carry the approval link, so they stay in
the conversation and out of every Notification Request.

| Moment | When | Say | They |
| --- | --- | --- | --- |
| install | before the installer runs | I'll install Notifai on this computer so your agents can reach your phone. Your agent app may ask you to allow a download and a few commands; please allow them. | allow the harness prompts |
| approve | `credential` gap, `pairing_outcome: pending` | Show the QR, then send `technical.pairing.message` exactly as written. It names the code and a browser link. | scan, sign in, approve |
| approve-link | the same, where you cannot show the QR | To connect this computer to Notifai, open {approve_url} and sign in with your email if it asks. Check that the code shown is **{code}**, then approve it within a few minutes. Tell me when you've approved it. | open the link, approve |
| get-app | `devices` gap, `technical.devices` empty | Now get the Notifai app on your phone: open {companion_setup_url} on the phone and install it. Sign in with {account_email}, the same email you just used, and allow notifications when it asks. Tell me when it's in. | install, sign in, allow |
| allow-iphone | `devices` gap, an `ios` device listed | Open Notifai on your iPhone and tap Allow when it asks about notifications. If you said no before, turn them on in Settings → Notifai → Notifications. Tell me when that's done. | allow notifications |
| allow-android | `devices` gap, an `android` device listed | Open Notifai on your phone, tap Continue, then Allow. If you turned notifications off before, turn them on in Settings → Apps → Notifai → Notifications. Tell me when that's done. | allow notifications |
| choices | before `init --hooks`/`--no-hooks`, unless already chosen | Should your agents' questions also reach your phone, so you can answer them while you're away? And should I teach agents in every project on this computer how to use Notifai, only in this project, or skip that? | answer both |
| codex-hooks | a `hooks` gap whose `remedy.user_action` names Codex | Send `remedy.user_action.message` exactly as written. | approve in `/hooks` |
| claude-session | after hooks are installed for Claude Code | Notifai is connected to Claude Code. It starts working in new sessions, so the next Claude Code session you open will use it. | nothing now |
| done | `proof` ready, `question_routing_ready: true` | Notifai is set up: the Notifai app confirmed it got the test notification. Your agents can now notify you, and you can answer their questions from your phone. | nothing |
| done-no-questions | `proof` ready, questions not routed | Notifai is set up: the Notifai app confirmed it got the test notification. Your agents can now notify you; their questions still come to this conversation. | nothing |

`choices` adds one sentence for each harness whose command approval is still
open (`claude-commands`, `codex-commands`): "Can {Claude Code or Codex} run
Notifai's own commands without asking you each time? Otherwise a question can
sit waiting for your OK while you're away."

**When something goes wrong**, say the one line for it:

| Line | When | Say |
| --- | --- | --- |
| installer-needs-you | the installer reports a `user_action`, or the OS shows a permission prompt | Installing Notifai needs one thing from you: {user_action_message, or "please review the prompt on your screen"}. Tell me when it's done. |
| denied | `pairing_outcome: denied` | You declined connecting this computer, so I've stopped. Ask me again whenever you want to set it up. |
| expired | `pairing_outcome: expired` | That code expired before it was approved, so here's a new one. (Then `approve`.) |
| no-plan | `auth` gap: no plan yet | Your Notifai account needs a plan before this computer can connect. Choose one at {access_url}, then ask me to finish setting up. |
| unreachable | `server` or `not_started`, twice | I can't reach Notifai from this computer right now. I'll try again when you ask; nothing you set up so far is lost. |
| app-missing | `devices` still empty after they said done | I don't see the app yet. Check that you signed in with {account_email}, the same email you approved this computer with, then tell me. |
| proof-unconfirmed | `proof` unconfirmed after one recheck | I sent a test notification, but the Notifai app hasn't confirmed it yet. Open Notifai on your phone so it can check in, then tell me and I'll check again. |
| cloud | your commands run in a cloud or temporary session | I can't set up Notifai from here: my commands run on a temporary machine, not your computer. Run `curl -fsSL https://notifai.sh/install.sh \| sh` in a terminal on the computer where your agents run (Windows PowerShell: `irm https://notifai.sh/install.ps1 \| iex`), or ask an agent there to follow notifai.sh/setup. |
| which-computer | you cannot tell where your commands run | Notifai connects the computer where your agents run, and I can't tell if that's where my commands run. Is this the computer (or server) you want to connect? |
| stuck | anything else you cannot close | I couldn't finish setting up Notifai. It said: "{detail}". {remedy_summary} |

## Signing this machine in

Run `notifai init --json` yourself. An unapproved Machine starts one approval,
defaults to QR without asking for email, polls once, and returns. Progress is
on stderr and final readiness on stdout. The `credential` state's
`technical.pairing` holds protected local `qr_path` and `qr_text_path` artifacts,
the `approve_url`, the matching `code` and the prepared `message`. Present the
QR first: show the local image where supported, or read `qr_text_path` and
reproduce the library-generated QR verbatim in a fenced text block in a
terminal/text-only harness. Then send `message` in the conversation as written
(the `approve` script), and end your turn. Never include the QR, the message or
the proof-bearing link in any Notification Request field or media. Only the
User can approve; opening review never approves automatically. If the harness
cannot display the local QR, use the `approve-link` script rather than claiming
a QR was shown.

Only when the User chooses an approval notification, ask for their Account
email; never infer it from other services or files. Run `notifai init --approval notification --approval-email <email>
--json`. Requested delivery is not confirmed delivery. `--approval browser`
opens the approval page in this machine's browser: use it when the User is at
this machine. Every route resumes the same pending approval. When the User
says it is approved, run setup again. If it reports a new code, relay that code. A timeout or closed
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
conversation, or in your own question form, which stays in the terminal.
`doctor` reports that setting as the User's choice, not as a gap.

`NOTIFAI_NO_INPUT=1` is for scripts and CI: with it, no command ever prompts.
Run `notifai` without it: the CLI never prompts in a shell nobody is at, and
harness approval rules do not match a command that starts with a variable.

`NOTIFAI_CREDENTIALS=file` stores the machine credential in a plaintext file
rather than the OS keychain — only when the user has asked for it, and never on
a shared machine.
