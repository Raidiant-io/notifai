# Using Notifai

The [README](../README.md) covers the quickest setup. This page has the
details: install options, setup, the Companion Apps, commands, questions and
the agent skill. For what works on each harness and how the hooks behave, see
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

Optional Node/npm launcher:

```sh
npx --yes @raidiant/notifai@latest init
# Or: npm install -g @raidiant/notifai, then notifai init
```

Requires Node.js 20.12 or newer for this launcher. npm updates/removes only the
launcher; `notifai uninstall` removes the runtime after its safety checks.
Existing native versions and channels survive launcher changes. `@version`
selects launcher code, not a command to replace an existing runtime.

## Updates

Notifai installs its own native runtime and, on macOS and Linux, keeps it
updated by itself (`notifai config set updates.automatic off --yes` turns that
off); `notifai update` updates it on demand. Updating never waits for or drops
a waiting question: the shared hub restarts seamlessly, and only an update that
would change hook definitions Codex would make you approve again waits.

## Setup and Machine approval

`notifai init` is one setup flow and is safe to resume. Setup defaults to QR
approval with your signed-in Companion App; notification and browser approval
are selectable alternatives.

On an unapproved machine, `notifai init` starts one Machine approval and shows
its QR and matching code. Scan it to review the Account and computer in a
signed-in Companion App; no additional email code is needed while its Auth
Session is valid. Approval is reusable until revoked. QR setup asks for no
email, opens no browser, and sends no invitation. Select
`--approval notification --approval-email <email>` for an Account-targeted
invitation, or `--approval browser` for browser approval. Each route requires
explicit review and approval of the same pairing.

At a human terminal the command waits until approval or expiry. An agent run
polls once and returns; the next run resumes the same approval, including an
approval given after the first run ended. `notifai init --json` never prompts:
progress goes to stderr, while stdout contains one final readiness object
whose `credential` state carries the local `qr_path`, code, and browser
alternative. The QR and approval link carry sensitive one-time proof: show them
locally, never include them in Notification Request fields or media. At a human terminal,
choosing iPhone or Android opens its setup steps and starts a bounded wait;
Ctrl-C stops the wait, and expiry offers more time.

## Companion Apps

Install the Companion App, open it once, sign in with the same Account as the
CLI, and allow notifications.

- iPhone: from the App Store, linked from
  <https://app.notifai.sh/setup/companion?platform=iphone>.
- Android: a directly downloadable signed APK from
  <https://app.notifai.sh/download/android>, for a compatible device with
  Google Play services. Invited testers can use Google Play closed testing
  instead; the [installation instructions](https://app.notifai.sh/support)
  explain how to join with your invited Google account. Test enrollment is
  separate from Notifai Account access.
- Mac: a signed, notarized app from <https://app.notifai.sh/download/mac>.

The sending CLI runs on macOS, Linux, and Windows. The public protocol and CLI
model Android as a first-class surface (`android:fcm`), including capability
inspection, Device Installation filtering, authoring, and offline validation.

Android support starts at Android 6/API 23 and requires Google Play services:
a physical supported device has the Google Play Store, while emulators use a
Google APIs image. There is no non-GMS compatibility promise.

The desktop Companion App presents requests in its own on-screen Edge rather
than through operating-system notifications, over its own connection to the
service (the `stream` provider and `GET /api/v1/companion/changes`), so desktop
drafts take only a `sound` option. It ships for macOS; Windows and Linux
versions are in development.

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
notifai devices              # list Device Installations and delivery readiness
notifai doctor               # check every part of the setup
notifai update               # update the CLI this shell and the hooks use
```

The `project` group controls User-owned Project Enablement: an enabled Project
gets Notifai's guidance, and nothing from a disabled one reaches your devices.
The first send, ask or setup in a Project with no decision enables it; only
`notifai project enable` turns a disabled one back on. It is separate from
hook installation. `devices` accepts
`--platform <ios|android|macos|windows|linux>` and `--json`; send routing still uses
the per-request device flags documented by `notifai send --help`.

Anywhere that is not a terminal (a script, a CI job, an agent) `notifai`
prints help instead of prompting, output stays uncoloured, and `--json` is
available on the commands that report. Nothing in the CLI ever waits on stdin
unless a human is demonstrably there.

## Questions and acknowledgements

Agents ask through `notifai ask`, read the answer, and send the required Agent
Acknowledgement without any interactive prompt:

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

Every presented answer submission is acknowledged, so the user learns that an agent
read their answer. A held `ask --wait`, `replies`, and `close` expose
`agent_acknowledgement_required`, the current `agent_acknowledgement`, and
`acknowledgement_command` while it is still absent.

The one account setting governs the agent's brief written reply, not the
acknowledgement itself: when `agent_acknowledgement_text_required` is false the
printed command carries no `--text`, and `notifai acknowledge <request_id>`
records the receipt on its own.

When `ask` returns an optional `native_question`, follow its exact titles and
instructions. Notifai records an answer given in that bound native form
itself, so the devices stop asking. Keep the original app answer window;
distinct native and app submissions remain separate in history. Native form
closure is capability-dependent.

Where no later answer can reach the asking Agent Session, `notifai ask --wait`
holds the question in its foreground process and the service ends the
question's answer window at the wait's deadline, so a killed command leaves
nothing open on the devices. The wait is the harness's command limit minus
10 s, or the answer window outside any harness; no flag sets it. It exits 0
with the answer, 3 when it ended unanswered (the question is withdrawn), or
5 when the service was unreachable at the end, naming `notifai replies` for an
answer that may still be waiting. A question you dismiss on a device ends like
one whose window ran out: a held `ask --wait` stops waiting (exit 3), and a
registered question is retired, with no answer delivered.

## Projects and settings

Project identity is inferred from the Agent Session's activation checkout when
available, otherwise from Git at the current directory. A directory outside Git
does not create an inferred Project; explicit configuration and Project
overrides still apply. Ordinary setup writes nothing into the repository.
Machine settings live in the user's configuration directory; Project
Overrides live there too and are shared across linked worktrees. Only the
user's own settings and guidance customize Notifai: a repository cannot supply
either, and nothing committed to a checkout is read as configuration.

## The agent skill

The Notifai agent guidance skill lives in [`skills/notifai/`](../skills/notifai/SKILL.md)
and is never installed by default. `notifai init` coordinates sign-in, optional
harness hooks, and device readiness. Harness hooks have no scope to ask about:
they are installed once per harness for this machine. Installing the skill does
place files elsewhere, so at a human terminal that, and only that, asks once
whether it is for this project or for this machine.

`notifai init --skills` installs the complete first-party skill bundled with
this CLI. It verifies the file list and content digest and copies only that
skill to the selected harnesses. Every `notifai` skill directory a harness loads
is Notifai's: setup and refresh rewrite any copy that differs from the bundled
skill. Customise guidance with Guidance Topics, not by editing the skill.
Installation does not run npm, npx, Git, or a separate skill manager.

For unattended setup, choose both scope and harnesses, for example:

```sh
notifai init --skills --skills-scope global --skills-harness claude-code,codex --json
```

The scope applies to guidance placement, independently of lifecycle wiring.
Subsequent `notifai update --refresh-skill` rewrites every outdated copy in place.
Directory presence and content verification do not override a harness's trust,
profile, or skill-discovery settings.

## Subscription

Notifai is a paid service. One individual subscription covers the dashboard,
this CLI, and the Companion Apps on a single Account, with a free trial offered
once per person. Subscribe from the dashboard or the iPhone Companion App; the CLI never
takes a payment. Prices, renewal, cancellation, and where the service is sold
are on the pricing page.

- Pricing: <https://app.notifai.sh/pricing>
- Terms of Service: <https://app.notifai.sh/terms>
- Privacy Policy: <https://app.notifai.sh/privacy>
- Support: <https://app.notifai.sh/support>

## Versions

`@raidiant/notifai` and `@raidiant/notifai-protocol` version independently.
Released clients keep ordinary notification workflows during the documented
compatibility window; newer work is negotiated as named capabilities instead of
making every version mismatch a product-wide failure.
