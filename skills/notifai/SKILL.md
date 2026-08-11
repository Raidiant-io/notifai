---
name: notifai
description: Notify the user through Notifai when work finishes, blocks, or needs their attention. Use for sending native notifications from agents via the notifai CLI and for configuring when/how a user wants to be notified (per project or globally).
---

# Notifai

Notifai gives agents and local programs a channel-neutral way to reach the user
through their companion devices. Use the `notifai` CLI; never hand-roll its
delivery, reply, presence, or harness behavior.

## When to notify

Read the user's criteria before deciding:

```bash
notifai config show --json
```

Follow `notify_criteria` literally when it is set. Otherwise:

- Notify when a long-running task finishes, succeeds, or fails.
- Notify when work is blocked on input only the user can provide.
- Notify for an error or finding that needs attention soon.
- Do not notify for routine progress, every file changed, or work the user will
  see in the terminal within a few seconds.
- Send once per event. Reuse a collapse key to replace stale status rather than
  creating noise.

When the user asks to change this policy, persist the requested wording at the
right layer:

```bash
notifai config set notify_criteria "Only when blocked or CI-length work finishes" --project --yes
notifai config set notify_criteria "Anything that needs me within the hour" --yes
```

Use `--local` for a personal project preference and keep
`.notifai/config.local.toml` ignored. Use `--project` only for shared project
policy. Use `notifai config unset <key>` with the same scope flag to remove an
override and return to the inherited or shipped value. Precedence is flag >
session > project-local > project > machine-global > default; `notifai config
show --explain` shows the winning source.

## Compose and send

The common send needs a concise title, a useful body, and the right kind:

```bash
notifai send \
  --title "Done · my-app" \
  --body "All 42 tests passed in 3m 10s. Next: review the release candidate." \
  --kind done \
  --project my-app
```

Write for a glance:

- Lead the title with the message type, then the project or subject: `Done ·
  api`, `Failed · web`, `Question · release`. This is guidance, not a hard
  limit. The CLI warns when a title runs beyond roughly 40 characters because
  shorter titles survive more native surfaces.
- Make the title carry the message on its own. Put the next fact the user would
  ask for in the body: result, count, duration, error gist, or next action.
- Keep the body to one or two short plain-text sentences. Native banners do not
  render Markdown.
- A completion notice must say what comes next. A bare “done” sends the user
  back to the terminal to discover why it matters.
- Keep wording channel-neutral. Do not assume a phone, desktop, or a particular
  interaction such as “tap here.”

Put long-form Markdown in `--detail` or `--detail-file`; detail is available in
the companion app and never appears on the banner:

```bash
notifai send --title "Failed · api" --body "Integration tests failed." \
  --detail-file ./test-report.md --kind done --project api
```

### Kind profiles

Kind profiles are the normal attention mechanism. Do not repeat sound and level
flags on ordinary sends:

| Effective kind | Default sound | Default level |
| --- | --- | --- |
| `update` (default) | `none` | `passive` |
| `done` | `done` | `passive` |
| question (`--reply`) | `attention` | `active` |

An explicit `--sound` or `--level` wins, followed by saved user config, then
the kind profile. Use those overrides only when the situation or user policy
really differs. `time_sensitive` is not a question default; reserve it for a
case where acting late loses value. A reply request is always a question, so
the CLI rejects `--kind done --reply`.

Useful delivery controls:

- `--thread-id <id>` groups related notifications.
- `--collapse-key <key>` replaces an earlier notification with the same key.
  Keep it at most 64 UTF-8 bytes.
- `--ttl <seconds>` controls how long delivery remains useful. The CLI warns on
  explicit windows longer than 72 hours.
- `--data <key=value>` carries namespaced custom data; repeat it for more keys.
- `--image <path|url|media_id>` attaches meaningful visual evidence. Check
  `notifai capabilities --platform <platform>` when the image is essential.

### Routing

By default a send targets every routable device and copies common optional
fields to both iOS and macOS. Inspect device IDs before narrowing delivery:

```bash
notifai devices
notifai send --title "Update · api" --body "Staging deploy started." --device dev_abc
notifai send --title "Update · api" --body "Staging deploy started." \
  --device dev_abc --device dev_xyz
```

`--device` is repeatable. `--all` overrides configured device selection.
`--platform ios|macos` limits optional platform fields; it does not choose a
delivery device.

### Project and session identity

Set the project once when possible:

```bash
notifai config set project my-app --project --yes
```

Use one stable opaque session ID for the whole agent run. Exporting it once is
less error-prone than repeating `--session`:

```bash
export NOTIFAI_SESSION="$(node -p "require('node:crypto').randomUUID()")"
```

Do not mint a new ID per send. Hooks normally learn their harness session from
the harness itself; never invent an ID to bypass a failed doctor check.

## Ask for a decision

A notification that asks must be answerable from the notification. Do not put
an unanswerable question in a completion body. Keep the question itself short
enough to read where it is answered; put reasoning, logs, and context in
`--detail` (markdown, shown only in the app) rather than stretching the
question.

Answering rules that hold for every question:

- **One flag, one answer.** `--choice`/`--reply-choice` never splits on
  commas or anything else — a comma in a label is just a comma. Repeat the
  flag once per answer (2-6).
- **A typed answer is always possible.** Choice buttons are the primary
  surface, but the user can always write their own answer instead (or in
  addition, on multi-select). Branch on choice ids when you get them, and be
  ready to read text where you offered buttons.
- **The latest answer counts.** A later reply corrects an earlier one. A
  free-text answer may arrive in parts; you receive every part in the order
  written — read them together.

### Block for the answer now

Use `send --reply` when the current command must wait. Prefer closed choices so
the result is machine-checkable:

```bash
notifai send \
  --title "Question · release" \
  --body "Deploy migration 0007 to production now?" \
  --reply --reply-choice "Deploy now" --reply-choice "Hold" \
  --reply-timeout 900 --project release
```

Add `--reply-multi` when several of the offered answers may be chosen at
once; the reply then carries every chosen id. Exit code 3 means no reply
yet, not delivery failure. Retrieve a late answer with
`notifai replies <request_id>`, or retire a question that is no longer useful:

```bash
notifai close <request_id>
```

State a safe default in the body when silence has meaning. Do not combine a
reply request with `--no-block` or `--reply-timeout 0`; the CLI rejects a
question nobody is waiting to hear.

### Register a turn-ending question

On a configured harness, `notifai ask` records the decision and returns
immediately so the agent can end its turn:

```bash
notifai doctor
notifai ask "Which environment should I deploy to?" \
  --choice Staging --choice Production --choice Cancel
```

`ask` takes the same question surface: `--multi` for multi-select,
`--detail`/`--detail-file` for long-form context. Several questions that
genuinely belong together can travel as one notification, answered as a
short form on the device — pass `--form <path>` (or `-` for stdin) with:

```json
{
  "questions": [
    { "text": "Deploy where?", "choices": ["Staging", "Production"] },
    { "text": "Which checks may I skip?", "choices": ["Lint", "E2E"], "multi": true },
    { "text": "Anything to watch?" }
  ],
  "detail": "Optional markdown context."
}
```

Prefer one question per notification; reach for `--form` only when the
questions must be decided together (at most 4).

Independent questions may be registered as separate `ask` calls — each
becomes its own notification, answerable in any order, and registering a new
question never cancels an earlier one (superseding is what a later *reply*
does to an earlier reply of the same question). At most four may be waiting
at once; past that, consolidate with `--form`.

Before the first `ask` in a harness session, require `doctor`'s **Question
routing** line to name the active harness and **hooks (fired)** to confirm that
a session in this directory ran both UserPromptSubmit and Stop. On Codex,
**hooks (trust)** must also pass. Follow the exact recovery if any check fails;
do not register the question yet. Then ask the same question in the conversation
and stop working so the user can decide.

By default, a question reaches answerable devices immediately when the agent
turn ends, whether or not the user is active at the machine. A user may set a
positive `ask_grace_seconds` for a terminal-only answer window, or turn on
`require_idle` to keep questions local while they are active. Do not register
the same question again while the first is live.
Use `notifai replies --pending` to recover a late hook answer and `notifai close
<request_id>` to retire a stale request.

Harness installation, activation, presence behavior, and bounded recovery are
in [Harness setup and recovery](references/harness-setup.md).

## Verify delivery and readiness

`notifai send` reports queue/provider progress. Use `--json` for structured
output and `notifai status <request_id>` for the evidence trail. Provider
Acceptance does not prove display or human attention. A Companion Receipt only
proves that a companion process or extension observed delivery; `unknown` is
not proof of failure.

```bash
notifai init
notifai doctor
```

`init` is the idempotent setup coordinator. It covers credentials, project
identity, optional hooks, device readiness, and one receipt-backed verification
notification. Agents must not attempt browser sign-in or optional installs
without the user's explicit choice; relay the exact action `init` reports.

`doctor` is read-only and never sends a probe. Its exit status is nonzero when
any displayed check is `FAIL`; JSON output reports the same value as
`exit_code`. Informational `--` lines do not fail the command. Treat a
nonzero result as a readiness failure to resolve, not as permission to bypass
routing or fabricate evidence.

## Find out what already happened

`notifai logs` is the local record of what this machine did: every command,
every notification, and every decision a harness hook made about whether a
registered question could leave the terminal.

Reach for it whenever something did not happen and you cannot see why — most of
all after `ask`. `ask` returns immediately and the push happens later inside a
hook, whose output the harness swallows, so the log is the only account of
whether the question travelled and what stopped it.

```bash
notifai logs                       # the recent record for this project
notifai logs --level error         # only what failed
notifai logs --request <id>        # everything about one notification
notifai logs --run <id>            # everything one invocation did
notifai logs --since 10m --json    # JSONL on stdout, for parsing
```

It is bounded and scoped to this project by default, because an unbounded dump
is not an answer. Widen it deliberately with `-n`, `--all`, `--since`, and
`--all-projects`.

`hook.gate` records carry a `reason` from a fixed set — `user-present`,
`notifications-off`, `already-asked`, `claimed-elsewhere`, `user-returned`,
`no-question` — so filter on that rather than on the wording of a message.
`notifications-off` and `user-present` are the two the user is deliberately
never told about, which is exactly why they are worth checking before
concluding something is broken.

The log stays on this machine. Nothing uploads it. Machine credentials are
redacted before anything is written, but notification titles and the user's own
answers are recorded, so treat it as you would any of their private files.
Control it with `log_level` (`off`, `error`, `info`, `debug`), and see
`notifai logs --path` for where it lives and how much room it is using.
