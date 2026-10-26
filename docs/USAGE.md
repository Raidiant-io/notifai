# Using Notifai

The [README](../README.md) covers the quickest setup. This page has the
details: installing, setup, the Companion Apps, commands, questions and the
agent skill. For what works in each harness, see
[Harness support](HARNESSES.md).

## Installing

Use the native installer for your computer; it installs Notifai and starts setup.
No Node.js or npm needed.

```sh
# macOS / Linux / WSL
curl -fsSL https://notifai.sh/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://notifai.sh/install.ps1 | iex
```

See [installation and migration](../skills/notifai/references/installation.md) for agent-safe script inspection,
platform prerequisites, channel selection and legacy npm migration.

You can also start from npm. This installs a small launcher (Node.js 20.12 or
newer), which then installs the same native runtime:

```sh
npx --yes @raidiant/notifai@latest init
# Or: npm install -g @raidiant/notifai, then notifai init
```

npm updates or removes only the launcher; `notifai uninstall` removes the
runtime after its safety checks.

## Updates

On macOS and Linux, Notifai checks for a new release once a day and installs it
by itself (`notifai config set updates.automatic off --yes` turns that off).
`notifai update` updates on demand. An update never drops a waiting question.
It waits only when it would change hook definitions that Codex would make you
approve again.

## Setup and Machine approval

`notifai init` is one setup flow and is safe to run again. It signs you in,
connects your harnesses, and checks that your devices can receive.

Setup approves this computer with a QR code: scan it with a signed-in Companion
App, check the Account and computer, and approve. No email or browser is
needed. Alternatives are `--approval browser`, or
`--approval notification --approval-email <email>` to get the approval request
as a notification. Approval lasts until you revoke the machine.

At a human terminal `init` waits for approval. An agent's run checks once and
returns; running it again picks up the same approval. `notifai init --json`
never prompts: progress goes to stderr and stdout holds one final readiness
object. The QR code and approval link are one-time proof, so show them only on
this computer.

## Companion Apps

Install the Companion App, open it once, sign in with the same Account as the
CLI, and allow notifications.

- **iPhone:** from the App Store, linked from
  <https://app.notifai.sh/setup/companion?platform=iphone>.
- **Android:** join the free test at <https://app.notifai.sh/test-android>.
  You ask to join with the Google account on your phone; once you're approved,
  that page shows how to opt in and install Notifai from Google Play. It needs
  Android 6 or newer with Google Play services.
- **Mac:** a signed, notarized app from <https://app.notifai.sh/download/mac>.
  It shows notifications and questions in its own Edge at the side of your
  screen rather than as system notifications. Windows and Linux versions are
  in development.

## Commands

Run `notifai` with no arguments to open the interactive app: status at a
glance, a test notification, your devices, and every setting with an
explanation of what it does and where its current value came from.

```sh
notifai init                 # one setup flow; safe to resume
notifai                      # the interactive app
notifai config show          # every setting, explained
notifai config explain <key> # one setting, in full
notifai config unset <key>   # return a setting to its inherited/default value
notifai project status       # show whether Notifai is on for this Project
notifai project enable       # turn Notifai on for this Project
notifai project disable      # turn it off: nothing from this Project reaches your devices
notifai guidance show        # how agents write notifications, and your overrides
notifai devices              # list Device Installations and delivery readiness
notifai logs                 # what this machine recorded, for this Project
notifai doctor               # check every part of the setup
notifai update               # update the CLI this shell and the hooks use
```

`notifai project` controls Project Enablement. An enabled Project gets
Notifai's guidance; nothing from a disabled one reaches your devices. The first
send, ask or setup in a Project with no decision enables it; only
`notifai project enable` turns a disabled one back on. Installing hooks does
not enable anything.

Anywhere that is not a terminal (a script, a CI job, an agent) `notifai`
prints help instead of prompting, and `--json` is available on the commands
that report. Every command takes `--help`.

## Questions and acknowledgements

Agents ask through `notifai ask`, read the answer, and acknowledge it:

```sh
# the positional question is the exact answerable question; --title names the decision
notifai ask "Deploy migration 0007 to production now?" --title "Production deploy" --choice Deploy --choice Hold
# add --wait to wait for the answer the way the agent would without Notifai
notifai ask "Deploy migration 0007 to production now?" --title "Production deploy" --choice Deploy --choice Hold --wait
# after the user's reply, the CLI prints the exact follow-up command
notifai acknowledge req_example --text "I will deploy the approved build to staging now."

notifai replies req_example --json
notifai close req_example --json
```

Every answer is acknowledged, so you learn that the agent read it and what it
will do. An Account setting decides whether the acknowledgement carries the
agent's short written reply; without it, `notifai acknowledge <request_id>`
records the receipt on its own.

Where the harness has its own question form (Claude Code's picker, Codex's
question card, OpenCode's question form), `ask` can hand that form back for the
agent to open. You can then answer in the terminal or on your phone, and both
close.

Where no later answer can reach the asking Agent Session, `notifai ask --wait`
waits in the command until the answer arrives or the wait ends. The wait is the
harness's command limit minus 10 seconds, or the question's answer window
outside a harness. It exits 0 with the answer, 3 when the question ended
unanswered (it is withdrawn from your devices), or 5 when the service was
unreachable at the end; then `notifai replies` may still find an answer.
Dismissing a question on a device ends it the same way.

## Projects and settings

Notifai infers the Project from the Agent Session's checkout, or from Git at
the current directory. A directory outside Git has no inferred Project.
Setup writes nothing into the repository. Machine settings and per-Project
settings (`--local`) live in your configuration directory, and per-Project
settings are shared across linked worktrees. Only your own settings and
guidance customize Notifai: a repository cannot supply either.

## The agent skill

The Notifai agent skill lives in [`skills/notifai/`](../skills/notifai/SKILL.md)
and is not installed by default. Hooks are installed once per machine;
the skill can go to one project or to the whole machine, so at a human terminal
setup asks which.

`notifai init --skills` installs the complete first-party skill bundled with
this CLI. It checks the skill's files against the bundled list and digest, then
copies it to the harnesses you choose. Any `notifai` skill directory a harness
loads belongs to Notifai: setup and `notifai update --refresh-skill` replace a
copy that differs. Customize guidance with `notifai guidance set`, not by
editing the skill.

For unattended setup, choose both scope and harnesses, for example:

```sh
notifai init --skills --skills-scope global --skills-harness claude-code,codex --json
```

## Subscription

Notifai is a paid subscription with a free trial. One plan covers the CLI and
every Companion App on one Account. Subscribe from the dashboard or the iPhone
app; the CLI never takes a payment.

- Pricing: <https://app.notifai.sh/pricing>
- Terms of Service: <https://app.notifai.sh/terms>
- Privacy Policy: <https://app.notifai.sh/privacy>
- Support: <https://app.notifai.sh/support>

## Versions

`@raidiant/notifai` and `@raidiant/notifai-protocol` version independently.
Older CLI releases keep working with the service for ordinary notifications;
newer features are negotiated as named capabilities.
