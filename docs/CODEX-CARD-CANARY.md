# Codex card canary

Notifai can link a Codex question card (`request_user_input_async`) to a
question registered on the User's devices, so that an answer from a device
closes the card in the terminal. That link rests on an experimental Codex
surface: the app-server daemon, `thread/turns/list`, and `turn/steer` with an
exact `expectedTurnId`. Codex changes often, so a daily canary runs the whole
path against the newest published Codex and reports drift before a User meets
it.

The canary is `scripts/codex-card-canary.mjs`, scheduled by
`.github/workflows/codex-card-canary.yml` and runnable locally with
`pnpm check:codex-card-canary` after `pnpm build` (it needs `codex` on `PATH`
and runs on macOS or Linux). It uses no account, no model and no secret.

## Two gates in the shipped CLI

A card always reaches the User's devices as the question it asks, whether or
not a device answer can close it. These gates decide only whether a device
answer closes the card itself (by `turn/steer`) or reaches the agent at its
next tool call while Codex clears the card at turn end.

- **The version floor.** `CODEX_CARD_VERSION_FLOOR` in
  `apps/cli/src/codex-card-capability.ts` is the oldest app-server version a
  device answer is steered into. The answer transport reads the running
  daemon's version (`codex app-server daemon version`) and withholds the steer
  below the floor or when no version is reported. The answer then takes the
  ordinary route. The floor is raised only together with a reproduced card
  round trip on the new version.
- **The route.** A device answer is steered only when the owning app-server
  is reachable and shows the card's turn in progress. Notifai attaches to a
  shared server Codex already runs for the session's `CODEX_HOME`, including
  a deep one whose control socket Codex keeps behind a symlink; it never
  starts one. Without it, the answer takes the ordinary route. Withdrawing
  `harness_answers` from the service stops every shipped CLI from linking
  cards, without a release.

## What a green run proves

Against the `codex` on `PATH`, in a throwaway `CODEX_HOME`. The round trip
runs twice: in a short home, and in one shaped like an Orca account home (a
space in the path, Orca's `daemon_auto_start = false` guard, and a control
socket path longer than a Unix socket allows). In the second, Codex keeps the
socket in its own short directory with a symlink at the long path, and the
canary also checks that discovery resolves that symlink to a connectable
socket before the rest of the round trip runs through it:

1. `codex app-server generate-json-schema --experimental` still describes
   every method Notifai calls (`initialize`, `thread/loaded/list`,
   `thread/turns/list`, `turn/steer`, `thread/queue/{list,add,delete}`), the
   parameters and response fields Notifai reads (`expectedTurnId`, `turnId`,
   `status: inProgress`, `itemsView: notLoaded`, `sortDirection: desc`), and
   the card question shape (`title`, string `options`). Each check names the
   CLI module it guards.
2. The daemon starts, reports `appServerVersion`, and that version passes the
   shipped floor. Notifai's shipped control connection (`connectCodexControl`)
   then connects before any other client, initializes, and refuses a thread
   that is not loaded.
3. `initialize` with `experimentalApi` names the same `CODEX_HOME`, a thread
   starts, and a turn runs against a local mock of the Responses API whose
   first reply is one `request_user_input_async` call.
4. Codex accepts that call and emits the card as an async agent message with
   the questions the model gave, then returns the accepted result to the
   model; the mock holds that request open so the turn stays in progress.
5. Notifai's shipped transport, `connectCodexAnswerControl` from
   `apps/cli/dist`, discovers the daemon, verifies the namespace and the
   loaded thread, sees the turn in progress through `thread/turns/list`, and
   steers it with the expected turn id. The receipt names that turn, and the
   steer text arrives at the model as the next user input.
6. `turn/steer` on the idle thread afterwards is refused rather than starting
   a new turn.
7. Notifai's transcript reader (`readNativeQuestionSnapshot`) finds the
   accepted card in the rollout with the same turn id, call id, title and
   options.
8. Codex's `PreToolUse` and `PostToolUse` hooks for `request_user_input_async`
   run through the trust-hash scheme Notifai writes, and carry `session_id`,
   `turn_id`, `tool_use_id`, `tool_input.questions` and an accepted
   `tool_response`: the fields the card hook reads.
9. The canary's thread records the canary client as its originator, in the
   rollout's `session_meta` and in the `originator` header of every model
   request, although Notifai's control connection reached the daemon first.
   Codex lets the first client with an ordinary name label every thread an
   app-server creates; Notifai initializes with
   `CODEX_CONTROL_CLIENT_INFO`, a name Codex exempts, so it can never relabel a
   User's threads. A failure here means Codex stopped exempting that name.

## What it does not prove

- That a real model emits the card. The model is mocked; the canary covers
  Codex's handling of the call, not the model's choice to make it.
- That the Codex TUI clears the card when the steer is consumed, or that it
  still parses Notifai's reply envelope. No TUI runs here. Those are checked
  live by hand when the floor is raised.
- Anything about the Notifai service, devices, or Companion Apps.
- Windows: the control socket is Unix-only, and so is the canary. Notifai's
  connection to a Windows socket fails today (Node reaches AF_UNIX paths as
  named pipes), so there a device answer always takes the ordinary route.

## When it is red

A red run is a signal, not an automatic change. Read the step summary: each
failing row names the guarded CLI module. Then decide:

- Schema or protocol drift in a Codex release that Users will install: fix
  the transport, reproduce the round trip, and raise the floor in the same
  change so older Codex keeps the ordinary route.
- Drift that cannot be fixed quickly: withdraw `harness_answers` from the
  service capability document so every shipped CLI stops linking cards until
  a fix ships.
- A mock or environment problem (the model's default changed, the daemon did
  not start on the runner): fix the canary; the shipped CLI is not implicated.
