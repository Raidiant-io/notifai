# Notifai for Claude Code, Codex & more

Your agents can reach you, and you can answer from your phone. The answer goes
back to the exact Agent Session that asked, in whichever harness it runs:
Claude Code, Codex, Cursor, OpenCode, OpenClaw, Hermes or Grok.

Know which one needs you. Notifications name the Project and Agent Session
they come from, so several agents at once never blur into one generic bell.

Your agent sets it up. Paste this into any agent:

```text
Set up Notifai: https://app.notifai.sh/setup.md
```

Prefer to do it yourself? Run the [native installer](#using-it)
(`curl -fsSL https://notifai.sh/install.sh | sh`), then get the Companion App
for [iPhone](https://app.notifai.sh/setup/companion?platform=iphone) or
[Android](https://app.notifai.sh/setup/companion?platform=android).

[Website](https://notifai.sh) · [Pricing](https://app.notifai.sh/pricing) ·
[Changelog](https://notifai.sh/changelog) · [Support](https://app.notifai.sh/support)

## What is in this repository

`notifai` lets software agents and local programs send native device
notifications to their User: completion notices, answerable questions, and
status updates that land on a lock screen instead of an unwatched terminal.

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
runtime and, on macOS and Linux, keeps it updated by itself (`notifai config set updates.automatic off --yes`
turns that off); `notifai update` updates it on demand. Updating never waits for
or drops a waiting question: the shared hub restarts seamlessly, and only an
update that would change Codex or Claude Code hooks waits. npm updates/removes only the
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

Anywhere that is not a terminal — a script, a CI job, an agent — `notifai`
prints help instead of prompting, output stays uncoloured, and `--json` is
available on the commands that report. Nothing in the CLI ever waits on stdin
unless a human is demonstrably there.

## Platform support

The sending CLI runs on macOS, Linux, and Windows. iPhone and Android are both
active Companion Apps. The public protocol and CLI model Android as a
first-class surface (`android:fcm`), including capability inspection, Device
Installation filtering, authoring, and offline validation.

The desktop Companion App (macOS, Windows, Linux) is in development and not
shipped. It presents requests in its own on-screen Edge rather than through
operating-system notifications, over its own connection to the service (the
`stream` provider and `GET /api/v1/companion/changes`), so desktop drafts take
only a `sound` option.

Android support starts at Android 6/API 23 and requires Google Play services:
a physical supported device has the Google Play Store, while emulators use a
Google APIs image. There is no non-GMS compatibility promise. The Android app
is distributed as a directly downloadable signed APK while Google Play
publication is paused. Native Mac receiving remains explicitly deferred and is
not part of the current public support claim.

| Surface | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Approved Machine CLI: login, configuration, send, ask, doctor | Supported | Supported | Supported |
| Claude Code hooks | Supported; live inbox wake | Supported; live inbox wake | Supported; live inbox wake through the session's named pipe; question pickers stay in the terminal |
| Codex hooks | Asynchronous Stop and durable session queue; CLI/app-server verified | Same queue implementation; live Codex verification pending | Same queue implementation; live Codex verification pending |
| Cursor hooks | Supported; `notifai ask --wait` waits for the answer inside the asking command, since no later answer can return | Supported; same limitation | Supported; same limitation |
| OpenCode hooks | Supported on OpenCode 1, and on OpenCode 2.1 and later; OpenCode's own question form (verified on 1.19.3 and 2.1.3) reaches devices and settles from either side; otherwise `notifai ask --wait` waits for the answer inside the asking command. `notifai doctor` reports OpenCode 2.0, which is unsupported | Same implementation; live OpenCode verification pending | Same implementation; live OpenCode verification pending |
| OpenClaw hooks | Asynchronous Question Routing, Session Presence, Session Notes, and post-consumption Answer Edits through the local Gateway service and exact-session followup queue | Lifecycle hooks; asynchronous Question Routing and Session Messages unproven, so `notifai ask --wait` waits inside the asking command | WSL2 lifecycle hooks only; native Windows Gateway unproven |
| Hermes plugin | v0.21.5 local classic CLI: managed Project activation, Source Context, Question Routing, Session Presence, Session Notes, and Answer Edits through its live plugin writer | Same implementation; live Hermes verification pending | Unverified |
| Grok hooks | Automatic guidance and Question Routing for main and delegated child sessions; live shared-leader sessions also receive Notes and Answer Edits | Same adapter; live Grok verification pending | Same adapter; live Grok verification pending |

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
Exact wake cleanup reduces stale prompts. A wake Codex starts with nothing
behind it, such as one left in a conversation that closed and was reopened
later, is blocked by the prompt hook: no turn runs and no model request is
made, and Codex shows one "Blocked by hook" line. Unsupported question shapes
retain ordinary delivery and do not suppress the native form.

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

“Fails closed” means Notifai keeps the accepted answer in the Agent Session
journal until an exact continuation path can prove ownership, rather than
starting an unproven or divergent agent turn.
Claude Code live inbox wake requires Claude Code 2.1.224 or newer on macOS and
Linux and 2.1.234 or newer on Windows; an older Claude Code receives the
accepted answer at the Agent Session's next turn. Cursor does not expose the conversation
identity needed to prove asynchronous return, and OpenCode has no proven
exactly-once continuation after `session.idle`; `notifai ask --wait` waits
inside the asking command there. OpenCode's own question form is the exception:
it holds its turn, so its device answer returns through the form itself. OpenClaw's advertised Windows cell is WSL2 only;
a native Windows Gateway plus native Notifai CLI in one process is unproven.

## Companion App installation

Install the Companion App on your phone, open it once, sign in with the same
Account as the CLI, and allow notifications.

- **iPhone:** from the App Store, linked from
  <https://app.notifai.sh/setup/companion?platform=iphone>.
- **Android:** a directly downloadable signed APK from
  <https://app.notifai.sh/download/android>, for a compatible device with
  Google Play services. Invited testers can use Google Play closed testing
  instead; the [installation instructions](https://app.notifai.sh/support)
  explain how to join with your invited Google account. Test enrollment is
  separate from Notifai Account access.

## Subscription

Notifai is a paid service. One individual subscription covers the dashboard,
this CLI, and the Companion Apps on a single Account, with a free trial offered
once per person. Subscribe from the dashboard or the iPhone Companion App; the
CLI never takes a payment. Prices, trial length, renewal, cancellation, and
where the service is sold are on the pricing page.

- Pricing — <https://app.notifai.sh/pricing>
- Terms of Service — <https://app.notifai.sh/terms>
- Privacy Policy — <https://app.notifai.sh/privacy>
- Support — <https://app.notifai.sh/support>

## Status

Notifai is published under Apache-2.0. The current packages are
`@raidiant/notifai` <!--x-release-please-start-notifai-->14.2.0-beta.2<!--x-release-please-end--> and `@raidiant/notifai-protocol` <!--x-release-please-start-protocol-->9.1.1<!--x-release-please-end-->; their
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
hooks, and device readiness. Project identity is inferred from the Agent
Session's activation checkout when available, otherwise from Git at the current
directory. A directory outside Git does not create an inferred Project; explicit
configuration and Project overrides still apply. Ordinary setup writes nothing
into the repository.
Machine settings live in the user's configuration directory; Project
Overrides live there too and are shared across linked worktrees. Only the
user's own settings and guidance customize Notifai: a repository cannot supply
either, and nothing committed to a checkout is read as configuration.
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
Directory presence and content verification do not override a harness’s trust,
profile, or skill-discovery settings.

## The installed hooks

`notifai hooks install` installs one owned lifecycle mechanism per harness, in the current user's
account and that harness's active home; whether Notifai acts in a project is
`notifai project enable` / `notifai project disable`, not a second install.
How they appear depends on the harness — Claude Code names them in
`~/.claude/settings.json`, Codex in `~/.codex/hooks.json` (or inline
`[hooks]` in that layer's `config.toml`, when the user's own hooks already live
there), Cursor uses its own hook shapes, OpenCode and OpenClaw get generated
plugins, and Hermes gets a native Python plugin through Hermes's own CLI.
Hermes's plugin supplies bounded system-prompt sections for an enabled
Project. In an attended local classic CLI session, its live writer also routes
question answers to that exact session. On other Hermes surfaces
`notifai ask --wait` waits for the answer inside the asking command. Other
harnesses have their own documented answer path, or wait the same way.

In its default permission mode Claude Code asks before each Bash command it has
no permission rule for. `notifai init --claude-commands` adds allow rules to
`~/.claude/settings.json` for the `send`, `ask`, `receive`, `acknowledge`,
`status`, `replies`, `close`, `guidance` and `session rename` commands, so a
question can leave while nobody is at the terminal. It is offered at a
terminal, or in a Claude Code session in default mode, and written only on a
yes. The session's mode comes from its hooks, the mode it was started with, or
`permissions.defaultMode` in the Claude Code settings, and is Claude Code's
default when none of them names one. In a session in any other mode (`auto`,
`acceptEdits`, `plan`, `bypassPermissions`) `notifai doctor` reports it as not
applicable, nothing is offered, and `--claude-commands` says why it added
nothing. Setup, configuration and sign-out commands keep their
prompt, and `notifai hooks uninstall` removes the rules with the wiring.

Codex's default sandbox has no network, and outside full-access mode Codex
asks before a command runs outside it. `notifai init --codex-commands` writes
`rules/notifai.rules` in the Codex home (`~/.codex`, or `CODEX_HOME`) with a
`prefix_rule` that lets the same commands run outside the sandbox without a
prompt. It is offered once Codex is wired and written only on a yes, and
`notifai hooks uninstall --harness codex` removes it. Codex loads rules at
startup, matches only a literal `notifai …` argument list, and applies the most
restrictive rule, so `notifai doctor` reports a session that predates the rule,
a rule the installed Codex rejects, and an organization rule that forbids it,
each as per-command approval rather than a fault.

**SessionStart** (`session-start`) gives the main owner the small model-visible
activation context that makes it evaluate Notifai proactively. It carries the
`when-to-notify` and `questions` guidance topics and names the wording topics
the owner reads with `notifai guidance` before its first Notification Request. **SubagentStart**
(`subagent-start`) gives ordinary Claude and Codex workers a reporting-only
context instead. The parent owns User-visible Notification Requests unless it
explicitly delegates that ownership in text; a delegated worker then loads the
Notifai skill and runs `notifai guidance`. An orchestrator that launches its
workers as separate top-level Agent Sessions leaves the harness no parent to
report, and their environment matches a session the User started, so those
workers receive the owner context. That context therefore says that an Agent
Session another agent started with a task brief belongs to that agent, which
keeps Notification Requests unless the brief delegates them. These contexts are local-only and run before project setup,
authentication, Device Installations, or network access, so those missing
prerequisites cannot make activation disappear. OpenCode uses its Agent Session
relationship data to give parent Agent Sessions owner context and child Agent
Sessions worker context; missing or unusable relationship data fails safe as
worker. OpenClaw uses the `sessionKey` the same way: a `:subagent:` or ACP
nested key is a worker, and missing identity fails safe as worker.
Hermes v0.21.5 freezes the root or delegated worker context into the local
classic CLI prompt. Its prompt budget holds no guidance topic, so it directs
the agent to run `notifai guidance` before deciding whether or how to notify.
Cursor activation adds no turn. The editor, the Agents Window and
`cursor-agent` deliver SessionStart context. Hosts built on the Cursor SDK,
such as T3 Code, discard it, so Cursor wiring also writes one short
always-applied rule, `~/.cursor/skills/notifai-activation/SKILL.md`. The
editor, the Agents Window and SDK hosts that load the `user` setting source
apply it to every conversation. The rule cannot know
whether this Project is enabled, so it tells the agent to follow SessionStart
context when present and otherwise to check `notifai project status` before
reading guidance. `notifai doctor` reports the rule missing or out of date, and
`notifai hooks uninstall --harness cursor` removes it with the hooks. Delegated
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
answer delivery. Claude Code and Codex observe answers out of band: on macOS
and Linux the hub waits for them, and the session child wakes the session.
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

**SessionEnd** (`session-end`) runs when the Agent Session closes. A closed
session's questions are closed too: it drops this Agent Session's local state
and queues any leftover questions for retirement so they do not sit on your
devices after the agent is gone. It has to run here because no later hook for
this Agent Session will fire. An answer you gave that the agent had not read
yet is dropped, never delivered later, and your devices show it as not
delivered. Acknowledgements the agent still owed are cancelled. If a hook is
still waiting for an answer when the session closes, it tells the Notifai
service right away, so the questions expire on your devices at once.

SessionEnd is not always a close, so on macOS and Linux the hub that attends
the session decides about ten seconds later (the end confirmation), and the
hook cleans up nothing meanwhile. The same applies when the session child sees
its harness exit or goes away. If the same conversation is back by then, it
was never closed: its questions stay open and what waits for it follows it.
That covers the shared Codex server reloading a thread in place when a
terminal runs `codex resume` (it runs SessionEnd first), the Claude desktop
app respawning a session, and a handoff that continues it at once in another
terminal or app (`/desktop`, `/app`, a resume in a new tab). A Claude Code
conversation can be open in two places at once; each has its own session
child, only the most recently opened receives answers and notes, and closing
one leaves the other. Anything else closed: exiting, closing the terminal, a
kill, `/clear` or `/resume` of another conversation in its place, quitting
the app, archiving or deleting it.

Without a hub to decide (on Windows, or for a session the hub never attended),
a SessionEnd that would expire questions or drop answers starts a short
background process instead, which waits the same ten seconds. The session
stays open if it started again in that time, another Claude Code process still
has the conversation open, or a Codex process holds the thread again;
otherwise it closes. A sign Notifai cannot read counts as no sign: on Windows
it cannot see which process holds a Codex thread, so only a restart keeps a
Codex session open there. A SessionEnd with nothing to lose closes at once.

Some stops are not closes. The Claude desktop app pauses or evicts a
conversation it still lists (an idle pause, its process limit, memory
pressure), and its own log names the pause; without that line, the stop counts
as a close (the Stop button looks the same). The Codex app and IDE extension
unload a conversation they still list while their own Codex server keeps
running. An Orca chat or T3 Code stops a conversation after 30 minutes idle
while the app keeps running; nothing else tells that from closing the tab, so
an earlier stop is a close. Orca loses a terminal pane's terminal host (and
resumes the conversation in that pane when you open the tab); closing the pane
leaves the host running and is a close. And the machine
shuts down, restarts, crashes or loses power: on macOS and Linux the hub
learns that a shutdown or restart has begun before the apps quit (from
loginwindow on macOS, from systemd-logind on Linux), holds every end until the
machine goes down, and the next hub, in a different boot, keeps those
conversations. A conversation that was attended when the power went keeps its
questions too. Such a stopped session shows as out of reach on your devices.
Its questions stay open for their own windows (a day by default), and an answer
you give meanwhile waits on this machine; the hub stays running while
something waits. It is handed to the agent when the conversation comes back
where it was or wherever you resume it (the desktop app reopening it,
`claude --resume <id>` in a terminal): a wake-up as usual, or at its next
prompt. A Codex conversation gets one content-free wake in its own queue
(written with `codex queue`, never through a connection to a Codex server),
which Codex runs only when the conversation loads again: when you open it in
the app, send in the Orca chat or T3 thread, or `codex resume` it. Nothing runs
while you are not looking, and a thread some process has loaded gets no wake.
A scripted run (`claude -p --resume`, an SDK script, `codex exec`) receives
nothing. If the conversation is deleted or archived while stopped (a Codex
rollout is found by its id in `sessions/` and `archived_sessions/`), or you
quit the app it was stopped in, it closes as above; when its last window ends,
it ends, and stops accepting notes. A fork that names the stopped
conversation (Codex records `forked_from_id`, Claude Code's `/branch` records
`forkedFrom`) means it continues there. Where the service supports it (an
older service only once the fork has sent a notification), its questions,
their answers and its notes move to the fork and arrive there; otherwise its
questions expire.
Where the service supports it, you can also send a note to a stopped
session: it waits up to a day and is delivered when the conversation comes
back. An answer still waiting when its question's window ends is not
delivered, and your devices say so. Otherwise a note cannot be sent to a
stopped session; one the service accepted just before the stop is delivered
if the session comes back within the hour. `notifai doctor` shows stopped
sessions and whether shutdowns are seen.

**Session child and hub** (`attend`, Claude Code and Codex on macOS and Linux).
The `attend` handler is a second, asynchronous handler on SessionStart,
UserPromptSubmit, and Stop. Claude Code runs every Notifai handler in exec form,
with no shell in between, when its version is known to support that (2.1.139 or
later, read from `claude --version` at install); otherwise in shell form, which
works the same way. `notifai doctor` shows the form and why, and `notifai update`
moves the hooks to exec form after Claude Code is upgraded. It runs the native launcher as a tiny **session
child**: one per Agent Session and process hosting it, staying the harness's own
child for the life of the session. It learns from the kernel when the harness exits, so it never polls
and has no timer, and it is the only process that writes into Claude Code's
inbox, opening each connection with the session's own token. It holds no
credential and makes no network connection. When a child already serves the
session, the UserPromptSubmit and Stop copies tell the hub a turn boundary
passed and exit at once.

The children register with one shared **hub** per OS user (`notifai hub`, started
on demand by the first child and gone 30 seconds after the last session ends;
there is no login item or startup task). The hub reads the machine credential
once, holds every session's presence lease behind one batched exchange with
the service, waits for answers to registered questions, and nudges Codex
through its queue. It makes no network call for a session until that session
has sent a Notification Request, so sessions that never notified are never
reported. When the harness exits or is killed, the hub reports the session
ended after the end confirmation, unless it continues elsewhere at once, so its
questions expire on your devices; when the hub was not running, it is reported
at the next Notifai activity. A Claude Code conversation the machine took down
stays open instead (see SessionEnd above). A hub crash is not a
close: children restart it and register again, and nothing expires. Only an
opaque id leaves the machine: never process ids, paths, or session files.
`notifai doctor` shows the hub and the sessions it attends.

While the hub runs it also answers the frequent hooks, so they start no
runtime: SessionStart, SubagentStart, UserPromptSubmit and Stop for Claude Code
and Codex, and Codex's PostToolUse. The native launcher reads the hook's input
and hands it to the hub, which runs the same handler with the hook's own
environment and directory and returns what the hook prints, activation
guidance included. Only a quiet session's hooks go this way: nothing asked,
answered, staged or owed. Every other hook, and every hook while no hub runs or
while the hub is an older build than the one installed, starts the runtime
with the same input, as before. Claude Code's inbox token never reaches the
hub. `notifai doctor --json` counts the hooks the hub answered and why it left
others to the runtime.

On Windows, Claude Code keeps the earlier per-session Session Attendant until the
hub is verified there.
OpenClaw's Gateway service also owns a current-generation attendant on macOS.
It reports Session Presence and accepts Session Notes and post-consumption
Answer Edits while its local writer is ready. It stores full message text in a
private local delivery journal and queues a pointer-only followup. The exact
pointer turn reads that text once, only while its native Gateway generation
still matches. The journal discards the text after that turn claims it, after
a generation change, or on Gateway restart; a plugin reload hands it to the
new plugin generation. Stopping the Gateway, or disabling or uninstalling the
plugin while it runs, ends its sessions for Notifai and their questions
expire. The agent acknowledges the
message after reading it. If a pointer reaches a turn without its full context,
the pointer tells the agent to report the missing message and leave it
unacknowledged. The User can send a new message if needed.

The hub also hands a note, or a change to an answer the agent already
received, from your devices into that running session. Claude Code gets a
content-free wake in its inbox, written by the session child. Codex uses its trusted synchronous `PostToolUse` hook during
active turns and also queues a content-free wake while input is pending,
whether working or idle. If no tool boundary occurs, the queued wake preserves
delivery at turn end. A plain `codex` terminal that joined Codex's shared
server is the exception: when that terminal closes, Codex keeps the
conversation loaded for about 30 minutes and says nothing, so a wake there
could start a turn nobody sees. There Notifai wakes an idle session only when
it can see that a terminal still shows the conversation, and treats a closed
terminal as the end of the session. It relies on Codex behaviour that Codex
does not promise, so the hub first checks, once per installed Codex build, in
a throwaway Codex home with a mock model, that Codex still behaves that way
([`docs/CODEX-ATTACH-CANARY.md`](docs/CODEX-ATTACH-CANARY.md)). Until
that check passes, the session is not woken while idle and the note or
answer waits for your next prompt there. Child callbacks cannot consume the parent session's input
or change its activity. Each hand-off is claimed first, so an edited answer can only follow
the answer it replaces, and nothing is written twice. The agent acknowledges
each one with `notifai acknowledge sm_…`, exactly as it acknowledges an
answered request. A Claude Code session without an inbox socket (for example
`--bare`), or a Codex session whose hooks cannot find the `codex` executable,
keeps presence only and accepts no notes.

If a wake fails, input stays queued for retry or the next prompt or trusted tool
callback. Transport failures retry with exponential backoff from 5 seconds up to
5 minutes. Environmental check-start failures use that cadence for seven retries,
then wait a day; permanent check failures use the daily cadence from the start.
The next foreground turn receives the fault, and `notifai doctor --json` records
it, including whether delivery has recovered; recovered diagnostics expire after
an hour. Queue acceptance alone never proves the agent read an answer.

On Codex the session child differs in three ways. Codex enforces every async
hook timeout, so the attend handler declares the complete answer window (about
72 hours) and the next prompt or turn end starts another child after that. Codex
publishes no session status, so the hub reads working or idle from this
thread's own transcript and hooks (a third attend copy on Interrupt only tells
the hub the turn ended). And Codex stops the child when the thread closes,
reloads or unloads, so SessionEnd hands the end to the hub, which decides it as
described above: a thread its Codex server holds again (its writer lock) was
reloaded in place and runs on until its next prompt brings a child back. Codex runs
no SessionEnd when a loaded conversation is archived, so the hub also watches
each Codex session's rollout and ends the session when it is archived or
deleted. Codex runs hooks
through your login shell; bash and zsh hand the hook straight to Codex's own
child, and the session child also accepts Codex as its grandparent through a
shell that keeps running in between. The Codex hook definitions are unchanged
from earlier releases, so updating needs no new `/hooks` review. Codex marks new or changed hooks for review: after
installing, open `/hooks` in Codex once and approve the Notifai handlers.
`notifai doctor` names any handler still waiting. Question Routing does not
wait for that approval.
