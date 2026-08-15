# Harness setup and recovery

This reference contains per-harness mechanics for `notifai ask`. Read it only
when installing hooks, diagnosing activation, or recovering question routing.

## Install deliberately

Ask whether they want questions routed. If they do, install hooks yourself.
Never tell the user to run `notifai hooks install` or `notifai doctor`.

```bash
notifai hooks install
notifai doctor --json
```

A machine-global Notifai skill is guidance, not routing evidence. The active
harness needs its own installed hook and a current session pointer.

Installed definitions call one stable user-level adapter at
`~/.notifai/bin/hook-adapter`. `hooks install` atomically retargets that adapter
to the current CLI while leaving definition bytes unchanged across Node/NVM,
package-manager, CLI-version, checkout, XDG directory, and Notifai preference
changes. Stop definitions differ by harness: Claude Code's runs asynchronously
with an explicit timeout above the longest wait, Codex's uses the host timeout
default; prompt-submit and session-end retain fixed short limits on both.
Migrating an older Codex definition requires one unavoidable `/hooks` approval;
later upgrades must not require another.

Before the first `notifai ask` in a new harness session, `doctor` must name the
active harness under **Question routing**, report under **hooks (fired)** that a
session in this directory ran both UserPromptSubmit and Stop, and pass **hooks
(stop shape)** — which is where an older, blocking Claude Code definition or a
missing explicit timeout is caught. For Codex, **hooks (trust)** must also pass.
The check is fail-closed against the exact active session identity where the
harness exports one. An explicit `--session-id` cannot create missing routing evidence; do not invent one to bypass the check.

**hooks (wake route)** reports, without probing anything, whether an answer
could start a turn in this exact session on its own. It never blocks: when it
cannot, the answer is held and replayed at the session's next turn instead.

Codex trust diagnosis is a best-effort comparison with Codex's current
persisted representation, not a supported trust-store API. Notifai never
writes approvals; `/hooks` is authoritative if the two disagree.

## Activation by harness

- **Claude Code:** project hook files reload without a restart. Send one new
  prompt so the hook publishes the session pointer, then run `notifai doctor`.
- **Codex:** run `notifai hooks install --harness codex`, end one harmless turn,
  send one new prompt, then run `notifai doctor`. If **hooks (trust)** fails,
  open `/hooks` in Codex and approve or enable the Notifai handlers. Codex
  resolves project hooks from the main
  repository. In a linked worktree, the installer writes the shared file to
  the main checkout and creates the project-layer `.codex` directory in the
  current worktree; run it once in each new worktree.
- **Cursor:** its stop hook can return a native follow-up, but the agent shell
  does not expose the exact conversation id needed to prove which concurrent
  session invoked `notifai ask`. Asynchronous ask therefore fails closed. Use
  blocking `notifai send --reply` for questions.
- **OpenCode:** restart after installation because plugins load at startup.
  Notifai owns its generated plugin file and will not overwrite a foreign one.
  OpenCode has no locally proven exactly-once continuation after `session.idle`,
  so `notifai ask` fails closed instead of accepting an answer into a void.
  Use a blocking `notifai send --reply` question when its answer must return to
  the agent without another human prompt.

Do not claim support for a harness that is absent from
`notifai hooks install --help`.

## How the answer gets back to the agent

The session that registered a question owns the answer's return. The last
meter differs per harness:

- **Claude Code:** the Stop hook is asynchronous. It returns at once, so the
  turn is never held and the terminal stays the user's, and the same process
  keeps waiting out of band. When the answer arrives it is posted to that
  session's own inbox socket: an idle session starts a new turn with it, a busy
  one receives it when its current turn ends. A session that is provably gone
  is cold-resumed instead — never one whose liveness probe cannot rule it out.
- **Codex:** the Stop hook is the waiter. It holds until the answer arrives or
  its window ends, then continues the session by returning `decision: block`.
- **Where neither applies** — including an answer that lands after the Codex
  hook has already returned, and any session whose state cannot be proved — the
  answer is held in the session's journal and delivered at that session's next
  Stop. This is the floor under every route.

An accepted answer is never dropped because delivery could not be proved, and
never delivered twice: the journal is cleared only once a later hook shows the
continuation actually ran. Repeated continuations are capped, so a wake loop
cannot run away.

`ask_grace_seconds` is the only setting that changes any of this. At its
default of `0` the question reaches devices as soon as the asking turn ends. A
positive value keeps it in the terminal for that long first, so an answer typed
there wins without a notification ever leaving.

When the reply window closes — at its deadline, or early when the answer is
already in — Notifai asks the server to close it, and that transaction fence
returns every reply that committed first. Only a confirmed-silent request is
retired. If the fence is unreachable, the exact request is preserved for a
later hook rather than erased or reported closed.

## Bounded recovery

Follow the exact `notifai doctor` diagnostic. Common recovery is one install or
restart, one new prompt, and one new doctor check. Stop if the current pointer
belongs to another active session or if the hook still has not fired; ask the
user or coordinator instead of retrying indefinitely.

If credentials are missing, run `notifai login` yourself; it opens a browser
approval only the user can complete. If a companion device is missing, ask
them to open a supported companion build, sign in, and grant notification
permission. Do not emulate either human action or treat Provider Acceptance as
Companion Receipt proof.
