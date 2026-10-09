# Notifai

`notifai` lets software agents and local programs send native device
notifications to their user — completion notices, answerable questions, and
status updates that land on a lock screen or desktop instead of an unwatched
terminal.

This repository is the public home of:

- **`apps/cli`** — the `notifai` command-line tool (`@raidiant/notifai`).
- **`packages/protocol`** — the client-visible wire contract
  (`@raidiant/notifai-protocol`): notification draft schemas, REST v1
  request/response types, the status vocabulary, and capability
  negotiation. The CLI validates drafts offline against the same bundled
  capability documents the service enforces.
- **`skills/notifai`** — the agent guidance skill: when to notify and how
  to write notifications that work on a lock screen.

The Notifai service, companion apps, and their deployment live in a private
repository. Everything the CLI sends and receives crosses the documented
`/api/v1` contract in `packages/protocol`; nothing in this repository
depends on private code. `docs/BOUNDARY.md` states the policy and
`pnpm check:boundary` enforces the mechanical part of it.

## Using it

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

Setup defaults to QR approval with your signed-in Companion App; notification
and browser approval are selectable alternatives. Run `notifai init` to resume.
See [installation and migration](skills/notifai/references/installation.md) for agent-safe script inspection,
platform prerequisites, channel selection and legacy npm migration.

Optional Node/npm launcher, once its replacement package and matching native
release are verified as published:

```sh
npx --yes @raidiant/notifai@latest init
# Or: npm install -g @raidiant/notifai, then notifai init
```

Requires Node.js 20.12 or newer for this launcher. Notifai installs its own native
runtime. Use `notifai update` for runtime updates. npm updates/removes only the
launcher; `notifai uninstall` removes the runtime after its safety checks.
Existing native versions and channels survive launcher changes. `@version`
selects launcher code, not a command to replace an existing runtime.

Run `notifai` with
no arguments later to open the interactive app: status at a glance, a test
notification, your devices, and every setting with an explanation of what it
does and where its current value came from.

```sh
notifai init                 # one setup flow; safe to resume
notifai                      # the interactive app
notifai config show          # every setting, explained
notifai config explain <key> # one setting, in full
notifai config unset <key>   # return a setting to its inherited/default value
notifai project status       # show lifecycle enablement for this Project
notifai project enable       # activate lifecycle guidance for this Project
notifai project disable      # stop future lifecycle guidance for this Project
notifai devices              # list Device Installations and delivery readiness
notifai doctor               # check every part of the setup
notifai update               # update the CLI this shell and the hooks use
```

The `project` group controls User-owned Project Enablement for lifecycle hooks;
it is separate from hook installation and is not permission to send. `devices`
accepts `--platform <ios|android|macos>` and `--json`; send routing still uses
the per-request device flags documented by `notifai send --help`.

Agents can ask for a reply, collect it directly, and send the required Agent
Acknowledgement without any interactive prompt:

```sh
# the Summary is the exact answerable question; Body is optional Markdown detail
notifai send --title "Migration 0007 is ready" --summary "Deploy migration 0007 to production now?" --reply
# after the user's reply, the CLI prints the exact follow-up command
notifai acknowledge req_example --text "I will deploy the approved build to staging now."

notifai replies req_example --json
notifai close req_example --json
```

Every presented answer submission is acknowledged, so the user learns that an agent
read their answer. `send --reply`, `replies`, and `close` expose
`agent_acknowledgement_required`, the current `agent_acknowledgement`, and
`acknowledgement_command` while it is still absent.

The one account setting governs the agent's brief written reply, not the
acknowledgement itself: when `agent_acknowledgement_text_required` is false the
printed command carries no `--text`, and `notifai acknowledge <request_id>`
records the receipt on its own.

When `ask` returns an optional `native_question`, follow its exact titles and
instructions. An answer read from that bound native form uses the printed
`acknowledge q_…` command to record its actual answers and authored
acknowledgement. Keep the original app answer window; distinct native and app
submissions remain separate in history. Native form closure is capability-dependent.

Anywhere that is not a terminal — a script, a CI job, an agent — `notifai`
prints help instead of prompting, output stays uncoloured, and `--json` is
available on the commands that report. Nothing in the CLI ever waits on stdin
unless a human is demonstrably there.

## Platform support

The sending CLI runs on macOS, Linux, and Windows. iPhone and Android are both
active Companion Apps. The public protocol and CLI model Android as a
first-class surface (`android:fcm`), including capability inspection, Device
Installation filtering, authoring, and offline validation.

Android support starts at Android 6/API 23 and requires Google Play services:
a physical supported device has the Google Play Store, while emulators use a
Google APIs image. There is no non-GMS compatibility promise. The Android app
is distributed as a directly downloadable signed APK while Google Play
publication is paused. Native Mac receiving remains explicitly deferred and is
not part of the current public support claim.

| Surface | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Approved Machine CLI: login, configuration, send, ask, doctor | Supported | Supported | Supported |
| Claude Code hooks | Supported; live inbox wake | Supported; live inbox wake | Supported; live inbox wake through the session's named pipe; question picker linking not yet available |
| Codex hooks | Asynchronous Stop and durable session queue; CLI/app-server verified | Same queue implementation; live Codex verification pending | Same queue implementation; live Codex verification pending |
| Cursor hooks | Supported; use full-window blocking `notifai send --reply` where a proven return is required | Supported; same limitation | Supported; same limitation |
| OpenCode hooks | Supported; use full-window blocking `notifai send --reply` where a proven return is required | Supported; same limitation | Supported; same limitation |
| OpenClaw hooks | Asynchronous Question Routing, Session Presence, Session Notes, and post-consumption Answer Edits through the local Gateway service and exact-session followup queue | Lifecycle hooks; asynchronous Question Routing and Session Messages unproven, use blocking reply | WSL2 lifecycle hooks only; native Windows Gateway unproven |
| Hermes plugin | v0.21.5 local classic CLI: managed Project activation, Source Context, Question Routing, Session Presence, Session Notes, and Answer Edits through its live plugin writer | Same implementation; live Hermes verification pending | Unverified |
| Grok hooks | Lifecycle observation, Source Context, and held Stop Question Routing; no Session Attendant | Same adapter; live Grok verification pending | Same adapter; live Grok verification pending |

Codex's optional native-question synchronization and exact queued-wake cleanup
have live evidence on macOS with Codex 0.160.0. Linux and native Windows do not
yet have live acceptance for those capabilities; the CLI platform support row
does not establish it. Discovery attaches only to a verified, already-loaded
session in an existing daemon. It never starts a replacement session or requires
`codex --remote`.

If optional control is unavailable before delivery, Notifai uses the ordinary
hook/queue route where that route is proven. If a native write may already have
been accepted, it retains recovery state instead of sending a second copy.
This can delay delivery until control recovers or a foreground hook runs.
Exact wake cleanup reduces stale prompts, but cannot prevent an empty turn when
Codex starts the wake before cancellation. Unsupported question shapes retain
ordinary delivery and do not suppress the native form.

Each `send --reply` fallback owns the complete answer window in its foreground
process: keep it alive and set `--reply-timeout` equal to `--reply-window`.
After a timeout, retain the request ID, inspect that original with `notifai
replies` and `notifai status`, and never send a duplicate.

“Fails closed” means Notifai keeps the accepted answer in the Agent Session
journal until an exact continuation path can prove ownership, rather than
starting an unproven or divergent agent turn.
Claude Code live inbox wake requires Claude Code 2.1.224 or newer on macOS and
Linux and 2.1.234 or newer on Windows; an older Claude Code receives the
accepted answer at the Agent Session's next turn. Cursor does not expose the conversation
identity needed to prove asynchronous return, and OpenCode has no proven
exactly-once continuation after `session.idle`; blocking reply mode provides
their reliable question path. OpenClaw's advertised Windows cell is WSL2 only;
a native Windows Gateway plus native Notifai CLI in one process is unproven.

## Companion App installation

The iPhone Companion App is distributed only through controlled TestFlight
invitations. Open the invitation on the iPhone you want to use, install Apple's
TestFlight app, install Notifai, then open it once, sign in with the same Account
as the CLI, and allow notifications. There is no public App Store link or public
TestFlight link yet.

The Android Companion App is distributed as a directly downloadable signed APK
from <https://app.notifai.sh/download/android>. Install it on a compatible
Google Play services device, open it, sign in with the same Account, and allow
notifications. There is no Google Play listing yet. A separate invitation-only
external-test lane continues through Firebase App Distribution for invited
testers; access to that lane is controlled separately from Notifai Account
access.

## Subscription

Notifai is launching as a paid service. When public purchase opens, one
individual subscription will cover the dashboard, this CLI, and the Companion
Apps on a single Account, with a free trial offered once per person.
Purchase is not open yet: access today is by invitation, and there is nothing
to buy. Prices, trial length, renewal, cancellation, and where the service is
sold are on the pricing page. Subscriptions will be sold and managed from the
dashboard and the iPhone Companion App; the CLI never takes a payment.

- Pricing — <https://app.notifai.sh/pricing>
- Terms of Service — <https://app.notifai.sh/terms>
- Privacy Policy — <https://app.notifai.sh/privacy>
- Support — <https://app.notifai.sh/support>

## Status

Notifai is published under Apache-2.0. The current packages are
`@raidiant/notifai` <!--x-release-please-start-notifai-->12.0.0-beta.2<!--x-release-please-end--> and `@raidiant/notifai-protocol` <!--x-release-please-start-protocol-->8.2.2<!--x-release-please-end-->; their
versions advance independently. Released clients keep ordinary notification
workflows during the documented compatibility window; newer work is negotiated
as named capabilities instead of making every version mismatch a product-wide
failure.

## Development

The CLI source builds both the native product and the optional same-name npm
launcher artifact. See [standalone distribution](docs/STANDALONE.md) for the
candidate lifecycle contract; candidate documentation does not prove publication.

Requires Node >= 20.12 and pnpm. Release evidence runs on Node 24.

```sh
pnpm install
pnpm build          # compile all packages
pnpm test           # unit tests (no Docker, no network)
pnpm typecheck
pnpm lint
pnpm check:boundary # verify no private imports or disallowed files
pnpm check:commit   # last commit is a conventional commit (commitlint)
pnpm check:release  # verify package contents, metadata, docs, and licenses
```

The CLI binary builds to `apps/cli/dist/main.js`.

## The agent skill

The Notifai agent guidance skill lives in `skills/notifai/` and is never
installed by default. `notifai init` coordinates sign-in, optional harness
hooks, and device readiness. Project identity is inferred from Git or the
current directory and ordinary setup writes nothing into the repository.
Machine settings live in the user's configuration directory; personal Project
Overrides live there too and are shared across linked worktrees. A repository
`.notifai/config.toml` is only an explicit, tracked shared override and is
authored in the active checkout so it can be reviewed and merged normally.
Harness hooks have no scope to ask about: they are installed once per harness
for this machine. Installing the skill does place files elsewhere, so at a
human terminal that — and only that — asks once whether it is for this project
or for this machine.

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

`notifai init --skills` installs the complete first-party skill bundled with
this CLI. It verifies the file list and content digest, copies only that skill
to the selected harnesses, and records which copies it owns. Refreshes retain
the selection. Modified files and unowned copies are preserved and reported;
installation does not run npm, npx, Git, or a separate skill manager.

For unattended setup, choose both scope and harnesses, for example:

```sh
notifai init --skills --skills-scope global --skills-harness claude-code,codex --json
```

The scope applies to guidance placement, independently of lifecycle wiring.
Subsequent `notifai update --refresh-skill` refreshes the existing selection. Directory
presence and content verification do not override a harness’s trust, profile,
or skill-discovery settings. Existing external-installer locks are migration
evidence and are never authority to overwrite user-edited guidance.

## The installed hooks

`notifai hooks install` installs one owned lifecycle mechanism per harness, in the current user's
account and that harness's active home; whether Notifai acts in a project is
`notifai project enable` / `notifai project disable`, not a second install.
How they appear depends on the harness — Claude Code names them in
`~/.claude/settings.json`, Codex in `~/.codex/hooks.json` (or inline
`[hooks]` in that layer's `config.toml`, when the user's own hooks already live
there), Cursor uses its own hook shapes, OpenCode and OpenClaw get generated
plugins, and Hermes gets a native Python plugin through Hermes's own CLI.
Hermes's plugin supplies a bounded system-prompt section for an enabled
Project. In an attended local classic CLI session, its live writer also routes
question answers to that exact session. Other Hermes surfaces require a
blocking `send --reply` question. Other harnesses have their own documented
answer path, or require a blocking `send --reply` question.

Claude Code asks before each Bash command it has no permission rule for, unless
the session skips permission prompts. `notifai init --claude-commands` adds
allow rules to `~/.claude/settings.json` for the `send`, `ask`, `receive`,
`acknowledge`, `status`, `replies`, `close`, `guidance` and `session rename`
commands, so a question can leave while nobody is at the terminal. It is
offered once Claude Code is wired and written only on a yes; setup,
configuration and sign-out commands keep their prompt, and
`notifai hooks uninstall` removes the rules with the wiring.

**SessionStart** (`session-start`) gives the main owner the small model-visible
activation context that makes it evaluate Notifai proactively. **SubagentStart**
(`subagent-start`) gives ordinary Claude and Codex workers a reporting-only
context instead. The parent owns User-visible Notification Requests unless it
explicitly delegates that ownership in text; a delegated worker then loads the
Notifai skill and runs `notifai guidance`. These contexts are local-only and run before project setup,
authentication, Device Installations, or network access, so those missing
prerequisites cannot make activation disappear. OpenCode uses its Agent Session
relationship data to give parent Agent Sessions owner context and child Agent
Sessions worker context; missing or unusable relationship data fails safe as
worker. OpenClaw uses the `sessionKey` the same way: a `:subagent:` or ACP
nested key is a worker, and missing identity fails safe as worker.
Hermes v0.21.5 freezes the root or delegated worker context into the local
classic CLI prompt. Its prompt budget can be smaller than the full guidance;
the bounded fallback directs the agent to run `notifai guidance` before a
Notification Request.
Cursor currently drops the context it
accepts at SessionStart, so after the first completed turn Notifai uses one
bounded native Stop follow-up: Cursor shows a synthetic follow-up turn, the
agent reads guidance and evaluates the just-finished Agent Event, and the next
Stop confirms that activation arrived. Cancelled turns do not trigger that
follow-up; errored turns do, because failure is itself an Agent Event. A live
question continuation takes priority. Delegated
Cursor work stays under the parent Agent Session's explicit notification ownership
rather than pretending the worker received context its host cannot deliver.

**UserPromptSubmit** (`user-prompt-submit`) runs when you send a prompt. That
records presence for this turn and remembers this Agent Session for later
`notifai ask` calls. It retires only questions that the prompt plausibly answers;
unrelated questions remain outstanding. It never substitutes activation when SessionStart is missing; reinstall
the current hooks and begin a fresh Agent Session. It has to run here for presence:
only this moment can tell that you were present for this turn.

**Questions** start background submission when the agent runs `notifai ask`.
The agent can keep working; only work that needs the answer waits. Registration
alone is not proof of Provider Acceptance. **Stop** (`stop`) and
**UserPromptSubmit** recover outstanding questions and own harness-specific
answer delivery. Claude Code and Codex observe answers out of band.
Codex uses trusted tool hooks during working turns and a content-free wake when
idle or live input capability is unavailable. Current notes and answers drain
through a trusted tool hook, prompt hook, or `notifai receive` in the exact
Agent Session. Queue success proves wake storage, not presentation, and an
old wake-up cannot repeat an answer that has already been acknowledged.

OpenClaw's Gateway service keeps the complete answer window and queues a
pointer-only `followup` into the same `sessionKey` after the asking turn. The
agent reads the answer with `notifai replies` and persists its own
`notifai acknowledge`; queue admission alone does not prove consumption.

An `ask` success is a local registration, not a submitted Notification Request:
it has no Provider Acceptance until question settlement promotes its stable
`q_...` identity to a `req_...` identity. `notifai status <question_id>` reads
that local state and, after promotion, links the downstream request evidence.
Inspect or close the original identity when delivery is uncertain; registering
again creates a separate question.

**SessionEnd** (`session-end`) runs when the Agent Session closes. It drops this
Agent Session's local state and queues any leftover questions for retirement so
they do not sit on your devices after the agent is gone. It has to run here
because no later hook for this Agent Session will fire.

**Session Attendant** (`attend`, Claude Code and Codex on macOS and Linux) is a second,
asynchronous handler on SessionStart, UserPromptSubmit, and Stop. It keeps one
small process per Agent Session running as that session's own hook child, so
your devices can show whether the session is still running, working, or idle.
It checks locally every two seconds that the exact harness process still hosts
this exact session, and makes no network call until the session has sent a
Notification Request, so sessions that never notified are never reported. It
ends itself when the session ends, including when the harness is killed or its
terminal closes, and withdraws when the Project is disabled or the hooks are
removed. Only an opaque id leaves the machine: never process ids, paths, or
session files. The UserPromptSubmit and Stop copies restart it if it died and
otherwise exit at once. `notifai doctor` shows each attendant's state.
OpenClaw's Gateway service also owns a current-generation attendant on macOS.
It reports Session Presence and accepts Session Notes and post-consumption
Answer Edits while its local writer is ready. It stores full message text in a
private local delivery journal and queues a pointer-only followup. The exact
pointer turn reads that text once, only while its native Gateway generation
still matches. The journal discards the text after that turn claims it, after
a generation change, or on Gateway restart. The agent acknowledges the
message after reading it. If a pointer reaches a turn without its full context,
the pointer tells the agent to report the missing message and leave it
unacknowledged. The User can send a new message if needed.

The attendant also hands a note, or a change to an answer the agent already
received, from your devices into that running session. Claude Code uses its
inbox socket. Codex uses its trusted synchronous `PostToolUse` hook during
active turns and also queues a content-free wake while input is pending,
whether working or idle. If no tool boundary occurs, the queued wake preserves
delivery at turn end. Child callbacks cannot consume the parent session's input
or change its activity. Each hand-off is claimed first, so an edited answer can only follow
the answer it replaces, and nothing is written twice. The agent acknowledges
each one with `notifai acknowledge sm_…`, exactly as it acknowledges an
answered request. A Claude Code session without an inbox socket (for example
`--bare`), or a Codex session whose hooks cannot find the `codex` executable,
keeps presence only and accepts no notes.

On Codex the attendant differs in three ways. Codex enforces every async hook
timeout, so the attend handler declares the complete answer window (about 72
hours) and the next prompt or turn end restarts it after that. Codex publishes
no session status, so working or idle comes from this thread's own prompt,
turn-end, and interrupt hooks (a third attend copy on Interrupt only records
that the turn ended). And Codex kills the attendant as soon as SessionEnd returns, so
SessionEnd itself reports the session ended. A Codex thread that is no longer
loaded has no attendant. Codex runs hooks through your login `$SHELL`; bash
and zsh hand the hook straight to Codex's own child, and a shell that keeps
running in between leaves the session's presence unknown rather than guessed. Codex marks new or changed hooks for review: after
installing, open `/hooks` in Codex once and approve the Notifai handlers.
`notifai doctor` names any handler still waiting. Question Routing does not
wait for that approval.
