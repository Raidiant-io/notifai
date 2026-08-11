# Harness setup and recovery

This reference contains per-harness mechanics for `notifai ask`. Read it only
when installing hooks, diagnosing activation, or recovering question routing.

## Install deliberately

Suggest hooks once; do not install them without being asked.

```bash
notifai hooks install
notifai doctor
```

A machine-global Notifai skill is guidance, not routing evidence. The active
harness needs its own installed hook and a current session pointer.

Installed definitions call one stable user-level adapter at
`~/.notifai/bin/hook-adapter`. `hooks install` atomically retargets that adapter
to the current CLI while leaving definition bytes unchanged across Node/NVM,
package-manager, CLI-version, checkout, XDG directory, and Notifai preference
changes. Codex's Stop definition uses the host timeout default; prompt-submit
and session-end retain fixed short limits. Migrating an older Codex definition
requires one unavoidable `/hooks` approval; later upgrades must not require
another.

Before the first `notifai ask` in a new harness session, `doctor` must name the
active harness under **Question routing** and report under **hooks (fired)**
that a session in this directory ran both UserPromptSubmit and Stop. For Codex,
**hooks (trust)** must also pass. The check is fail-closed against the exact
active session identity where the harness exports one. Do not invent `--session`
to bypass it.

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
- **Cursor:** send one prompt and run `notifai doctor`. If no hook has fired,
  start a new session and check again. A companion answer becomes one bounded
  native follow-up message.
- **OpenCode:** restart after installation because plugins load at startup.
  Notifai owns its generated plugin file and will not overwrite a foreign one.
  The idle event can push a question but cannot resume the idle turn; the next
  user prompt collects the answer. Use blocking `send --reply` when the answer
  must return before another prompt.

Do not claim support for a harness that is absent from
`notifai hooks install --help`.

## Presence and continuation

With `require_idle = false` (the default), local keyboard or mouse activity
does not hold a question back. With `ask_grace_seconds = 0` (also the default),
the question reaches devices immediately when the agent turn ends. A positive
grace adds an optional terminal-only answer window.

`require_idle = true` deliberately keeps a question in the terminal while the
user is working. Once the user is away, the terminal-first grace window may
complete before the push. If the OS idle signal is unavailable, prompt silence
is the conservative fallback. A remote answer proves reachability, not that
the user returned to the terminal.

The important timing settings are separate:

- `away_after_seconds`: how much local silence counts as absence.
- `ask_grace_seconds`: optional terminal-only delay; `0` sends immediately.
- `hook_reply_timeout_seconds`: how long a pushed hook waits for the answer.

The pushed question can remain answerable after the hook stops waiting. Recover
with `notifai replies --pending`; do not re-register it as a nag. Retire an
obsolete question with `notifai close <request_id>`.

## Bounded recovery

Follow the exact `notifai doctor` diagnostic. Common recovery is one install or
restart, one new prompt, and one new doctor check. Stop if the current pointer
belongs to another active session or if the hook still has not fired; ask the
user or coordinator instead of retrying indefinitely.

If credentials are missing, the user must run `notifai login`; it opens a
browser approval. If a companion device is missing, the user must open a
supported companion build, sign in, and grant notification permission. An
agent must not emulate either action or treat Provider Acceptance as Companion
Receipt proof.
