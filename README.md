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

Install the CLI once, then let `init` coordinate the setup. Run `notifai` with
no arguments later to open the interactive app: status at a glance, a test
notification, your devices, and every setting with an explanation of what it
does and where its current value came from.

```sh
npm install -g @raidiant/notifai
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

Every answered request is acknowledged, so the user always learns that an agent
read their answer. `send --reply`, `replies`, and `close` expose
`agent_acknowledgement_required`, the current `agent_acknowledgement`, and
`acknowledgement_command` while it is still absent.

The one account setting governs the agent's brief written reply, not the
acknowledgement itself: when `agent_acknowledgement_text_required` is false the
printed command carries no `--text`, and `notifai acknowledge <request_id>`
records the receipt on its own.

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
| Claude Code hooks | Supported; live inbox wake | Supported; live inbox wake | Supported; blocking Stop continuation because no live inbox socket exists |
| Codex hooks | Supported; held Stop continuation, with guarded cold resume | Supported; held Stop continuation; cold resume fails closed | Supported; held Stop continuation; cold resume fails closed |
| Cursor hooks | Supported; use full-window blocking `notifai send --reply` where a proven return is required | Supported; same limitation | Supported; same limitation |
| OpenCode hooks | Supported; use full-window blocking `notifai send --reply` where a proven return is required | Supported; same limitation | Supported; same limitation |
| OpenClaw hooks | Supported; use full-window blocking `notifai send --reply` where a proven return is required | Supported; same limitation | WSL2 only; native Windows Gateway unproven |

Each `send --reply` fallback owns the complete answer window in its foreground
process: keep it alive and set `--reply-timeout` equal to `--reply-window`.
After a timeout, retain the request ID, inspect that original with `notifai
replies` and `notifai status`, and never send a duplicate.

“Fails closed” means Notifai keeps the accepted answer in the Agent Session
journal
for the next hook rather than starting an unproven or divergent agent turn.
Claude Code live inbox wake requires Claude Code 2.1.224 or newer and is an
upstream macOS/Linux capability; on Windows, Notifai keeps Stop open and returns
the accepted answer through Claude Code's ordinary continuation channel. Cursor does not expose the conversation
identity needed to prove asynchronous return, OpenCode has no proven
exactly-once continuation after `session.idle`, and OpenClaw has no proven
exactly-once continuation after `agent_end`; their hooks still support
lifecycle cleanup and routing diagnostics, while blocking reply mode provides
the reliable question path. OpenClaw's advertised Windows cell is WSL2 only;
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
`@raidiant/notifai` <!--x-release-please-start-notifai-->11.0.4<!--x-release-please-end--> and `@raidiant/notifai-protocol` <!--x-release-please-start-protocol-->6.1.4<!--x-release-please-end-->; their
versions advance independently. Released clients keep ordinary notification
workflows during the documented compatibility window; newer work is negotiated
as named capabilities instead of making every version mismatch a product-wide
failure.

## Development

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

On an unapproved machine, `notifai init` opens the trusted approval page and
waits until approval or its expiry, including when an agent runs it. The User
still signs in and approves the machine in their browser. `notifai init --json`
never prompts: approval progress goes to stderr while stdout contains one final
readiness object. A later run uses the saved approval and resumes setup. At a
human terminal, choosing iPhone or Android opens its setup steps and starts a
bounded wait; Ctrl-C stops the wait, and expiry offers more time.

`notifai init --skills` verifies the complete first-party skill against the
copy and digest manifest shipped inside the installed npm package, stages that
verified copy at a short-lived project-relative path, and delegates placement
to the pinned native `npx skills` flow using the chosen scope. The staging copy
is removed afterward; readiness hashes the conventional installed directory.
The `notifai` CLI binary is always a global install (`npm install -g
@raidiant/notifai`); the skill scope does not change it. The human-readable release
identity is `v<!--x-release-please-start-notifai-->11.0.4<!--x-release-please-end-->`,
written as `Raidiant-io/notifai#v<!--x-release-please-start-notifai-->11.0.4<!--x-release-please-end-->`
in installer source grammar.
The tag is human-readable release identity, never the install-time trust
object. A different, extra, or missing packaged file is refused before
installation, and changed installed content fails readiness regardless of the
mutable source/ref metadata in the installer's lock file.
For unattended use, pass `--skills-scope project` or `--skills-scope global`.

## The installed hooks

`notifai hooks install` wires Agent Session activation, the prompt the user
submits, the end of the agent's turn, and the end of the Agent Session into the
harness. It installs one owned mechanism per harness, in the current user's
account and that harness's active home; whether Notifai acts in a project is
`notifai project enable` / `notifai project disable`, not a second install.
How they appear depends on the harness — Claude Code names them in
`~/.claude/settings.json`, Codex in `~/.codex/hooks.json` (or inline
`[hooks]` in that layer's `config.toml`, when the user's own hooks already live
there), Cursor uses its own hook shapes, and OpenCode and OpenClaw get a
generated plugin. They are how a question reaches your devices and how the
answer comes back, without the agent keeping any of that in its context.

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
is the proof you are at the keyboard, so Notifai retires any question still
waiting on your devices and remembers this Agent Session for later `notifai ask`
calls. It never substitutes activation when SessionStart is missing; reinstall
the current hooks and begin a fresh Agent Session. It has to run here for presence:
only this moment can tell that you were present for this turn.

**Stop** (`stop`) runs when the agent turn ends. If the agent registered a
question with `notifai ask`, this is when that question can leave for your
devices and when a device answer is handed back into the next turn. Question
Routing keeps that exact return path alive for the complete answer window:
Claude Code waits out of band and wakes the session on macOS/Linux; on Windows
its Stop stays held and returns the answer as the same Agent Session's
continuation, like Codex. It has to run at Stop because that is the first
moment the agent has finished its current work and is waiting for the answer.

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
