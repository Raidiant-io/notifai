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
`technical.pairing` holds the protected local `qr_path`, `approve_url`, and
matching `code`. Display the QR locally in the harness; never attach the QR
or proof-bearing link to a Notification Request. Use T2 from
<https://app.notifai.sh/setup.md>: the User reviews their Account, computer, and
matching code in their signed-in Companion App before approving. A valid Auth
Session needs no additional email code merely to approve a Machine.

Only when the User chooses an approval notification, ask for their Account
email and run `notifai init --approval notification --approval-email <email>
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
  The synchronous `PostToolUse` handler delivers pending answers, Session Notes and Answer Edits
  after tools during an active turn. Install and approve that handler, then
  start a fresh Agent Session to use the new attendant and hook definitions.
  Pending input also queues one coalesced wake-up, whether the session is
  working or idle. It carries no note or answer text. A trusted hook can drain
  the input first; a late wake-up may then find nothing pending. A running tool
  must return before its hook runs.
  Automatic goal continuations are observed at their first trusted tool
  callback even when the harness emits no prompt hook. Notes still need an
  available callback; a long tool or uninterrupted reasoning cannot be cut
  short by this route.
  Then start one fresh Agent Session, send one prompt, and run `notifai doctor`. If
  SessionStart is absent, reinstall the current hooks and start a fresh Agent Session;
  UserPromptSubmit does not activate it. Codex SubagentStart uses the same
  reporting-only worker contract and explicit textual delegation rule as
  Claude. Child callbacks cannot consume the parent's input or change its
  activity. A fresh install writes the Machine layer's `~/.codex/hooks.json`, or
  joins inline `[hooks]` when the User already keeps their own hooks there.
  Notifai-owned inline handlers with no foreign inline neighbours are moved to
  `hooks.json`; Codex will ask for `/hooks` approval because it keys trust by
  source path. Foreign inline configuration is left in place. Later upgrades
  keep the default SessionStart output-limit identity so they do not mint a
  second trust identity. One install covers every project and every worktree, so there is
  nothing to repeat in a new checkout; a Project-scoped `.codex` hook file from
  an older Notifai is removed once the Machine copy is proven current.
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
  Each model request receives current guidance when the Project is enabled,
  including after compaction. Disabled Projects add no context; enabling one
  takes effect on a subsequent request in the same Agent Session.
  OpenCode has no locally proven exactly-once continuation after `session.idle`,
  so `notifai ask` fails closed instead of accepting an answer into a void.
  Use a blocking `notifai send --reply` question when its answer must return to
  the agent without another human prompt.
- **OpenClaw:** restart the Gateway after installation because plugins load at
  startup, then start one fresh Agent Session, send one prompt, and run
  `notifai doctor`. Notifai owns its generated Gateway plugin and will not
  overwrite a foreign one. Exact Agent Session identity is the OpenClaw
  `sessionKey`; the transcript `sessionId` can stay the same across `/new` and
  `/reset`, while idle or daily rollover can change it. Notifai gives each
  observed generation one activation on its first prompt, using the native
  lifecycle revision and typed events to fence same-`sessionId` resets. A session key containing
  `:subagent:` or an ACP nested context
  is a worker. Missing identity fails safe as a non-sending worker; only a
  proven parent Agent Session receives owner context. Explicit textual
  delegation promotes that worker through the same skill-and-guidance rule.
  On macOS, the loaded Gateway service can route an asynchronous `notifai ask` answer
  into the same Agent Session after the asking turn ends. It queues a pointer
  through OpenClaw's followup route; run `notifai replies <id>` from that
  session to read the answer and `notifai acknowledge <id>` before acting on it.
  Question Routing requires the current generation marker, an enabled Project,
  and a local Gateway whose CLI version and process identity match the plugin.
  If this Project is disabled, run `notifai project enable` before `notifai ask`.
  On macOS, the same Gateway service attends the current generation and queues
  Session Notes and post-consumption Answer Edits as followup turns. It keeps
  the message in a private local delivery journal and sends only an opaque
  pointer in the CLI call. The matching prompt receives the full context once,
  only within its original native generation and Gateway instance. Journal
  text is discarded after that prompt claims it, a generation change, or a
  Gateway restart. The agent acknowledges each `sm_` message after reading it.
  If a Gateway crash interrupts a turn, OpenClaw may replay its pointer after
  the staged context was consumed. The pointer instructs the agent to say the
  context is missing and leave that message unacknowledged; the User may send
  a new message. Do not treat `/stop` as turn-end.
- **Hermes:** with Hermes v0.21.5, `notifai hooks install --harness hermes`
  installs and enables Notifai's native plugin through `hermes plugins`. Start a
  fresh local classic CLI Agent Session after installation. Its bounded system
  prompt section checks Project Enablement and gives root or delegated worker
  guidance. Hermes's prompt budget cannot hold every effective guidance topic;
  when the full set exceeds it, the section directs the agent to run
  `notifai guidance` before deciding whether or how to notify. Notifai reads
  exact `HERMES_SESSION_ID` for Source Context and derives git branch and
  worktree from the actual invocation cwd. Install the Notifai skill through
  `npx skills`; the Hermes plugin does not include a copy. On local classic CLI
  sessions the plugin supervises a Session Attendant for that exact session.
  After the first Notification Request, it reports Session Presence and hands
  Session Notes and post-consumption Answer Edits into the attached CLI;
  a Note may interrupt a working turn. The plugin checks the current session
  before each write, and the agent must acknowledge the message. An attended
  classic CLI session can route an `ask` answer into that same live session;
  keep Hermes running for the answer window. Submission starts immediately;
  the plugin owns answer delivery. If the
  process exits first, it does not cold-resume and the answer is not delivered.
  TUI, gateway, API, ACP, remote terminal backends, and Windows remain outside
  this proven cell.
  Nested inherited harness markers fail closed.
- **Grok:** `notifai hooks install --harness grok` writes only the Notifai-owned
  Machine hook file under `~/.grok/hooks/` (or `GROK_HOME/hooks/`). Start a fresh
  Grok Agent Session and send one prompt to observe lifecycle state. Grok
  discards SessionStart and allowed UserPromptSubmit output, so these hooks do
  not activate model-visible guidance; load the Notifai skill from
  `~/.agents/skills` directly. `GROK_SESSION_ID` supplies exact Source Context
  in an uncontested tool subprocess. Grok's Stop hook holds the complete answer
  window, then returns a decision block to continue this same Agent Session;
  its successor Stop confirms consumption. Grok has no Session Attendant,
  Session Notes, or post-consumption Answer Edits.

Do not infer Question Routing from managed installation. `notifai doctor`
reports each harness's supported route separately.

## How the answer gets back to the agent

The session that registered a question owns the answer's return. The last
meter differs per harness:

- **Claude Code on POSIX:** a detached observer starts after submission and
  waits out of band for the complete answer window. The resident Session
  Attendant sends wakes with Claude's required child-process ancestry. Stop
  can recover answer ownership without holding the turn. When the
  answer arrives it is stored with the session's pending inputs. Its own inbox
  socket receives a wake-up: an idle Agent Session starts a new turn, and a busy
  one receives it when its current turn ends. The prompt hook or the named
  `notifai receive` command drains the current notes and answers together.
  An Agent Session that is provably gone is cold-resumed with the wake-up
  instead — never one whose liveness probe cannot rule it out.
- **Claude Code on Windows:** the Stop hook stays held through the complete
  answer window. When the answer arrives it returns `decision: block`, starting
  the successor turn in the same Agent Session without another User prompt.
  Direct inbox wake is unavailable, but it is not needed while this exact Stop
  continuation owns the answer.
- **Codex:** a detached observer starts after submission and waits in the
  background for the complete answer window; Stop provides recovery. When an answer arrives, Notifai
  invokes `codex queue` for the exact Agent Session in the same Codex home.
  Only a wake-up is queued. Pending notes and answers remain in Notifai until
  a trusted tool hook, prompt hook, or `notifai receive` drains a bounded batch.
  A late wake-up cannot repeat an acknowledged answer: it contains no answer
  text. Queue success proves wake storage, not input presentation. Inputs are
  claimed immediately before presentation; uncertain writes are never replayed.
  Keep the original question and request identities when investigating a delay.
- **Grok:** the Stop hook stays held through the complete answer window and
  returns the answer as a decision block to the same Agent Session. Its native
  `stopHookActive` flag on the successor Stop confirms consumption. There is no
  out-of-band wake route or Session Attendant.
- **Crash recovery:** the answer journal protects an accepted answer if an
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
