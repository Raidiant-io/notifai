---
name: notifai
description: Notify the user through Notifai when work finishes, blocks, or needs their attention. Use for sending native notifications from agents via the notifai CLI, setting Notifai up when it is missing or not ready, and configuring when/how a user wants to be notified (per project or globally).
---

# Notifai

Notifai gives agents and local programs a channel-neutral way to reach the user
through their companion devices. Use the `notifai` CLI; never hand-roll its
delivery, reply, or harness behavior. The usual install is a real `notifai` on
PATH (`npm install -g @raidiant/notifai`). If the user refuses a global bin,
`npx --yes @raidiant/notifai@<version>` is a supported alternative — pin the
version they accepted, and do not present npx as the default. Hooks installed
from that invocation write the same pinned npx form. npx is slower than a
real install; do not recommend it as the happy path.

## When to notify

Read the user's criteria before deciding:

```bash
notifai config show --json
```

Each key is `{ value, source, summary }`. Report those fields. Do not paraphrase a
default into "shipped defaults apply" — print the value (`ask_grace_seconds` is
`0`, `ttl_seconds` is `86400`). Follow `notify_criteria` literally when it is set. Otherwise:

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

Use `--local` for a personal project preference. Notifai stores that layer
outside the repository, so do not create or edit a gitignore for it. Use
`--project` only for shared project policy. Use `notifai config unset <key>`
with the same scope flag to remove an override and return to the inherited or
shipped value. Precedence is flag > session > project-local > project >
machine-global > default; `notifai config show --json` shows the winning source.

## Set Notifai up

You are the wizard. `init` is the coordinator you invoke. `doctor` is how you
branch. Never paste a diagnosis. Never tell the user to run `notifai init`,
`notifai hooks install`, `notifai doctor`, or `notifai login` when you have a
shell.

1. Run `notifai doctor --json`. A nonzero `exit_code` is a gap to close, not a
   report to show the user. Informational `--` lines do not fail the command.
2. Run everything a process can:
   - `notifai init` with flags (`--project-id`, `--skills --skills-scope
     project|global`, `--hooks` or `--no-hooks`). Unattended `init` never
     prompts; optional steps need those flags.
   - `notifai hooks install --harness <active>` after they choose question
     routing.
   - `notifai config set … --yes` for a decision they just made.
   - `notifai login` when this machine is unpaired. It opens the browser.
3. Ask the user only for decisions a process cannot make. One structured
   question with choices, not "run this in your terminal":
   - Approve this machine in the browser (after you started login).
   - Install the companion, sign in, and allow notifications.
   - This project vs this machine (skill, hooks, and config together).
   - Whether they want questions routed.
4. When `init` or `doctor` prints a CLI command, run that command yourself
   unless the next act is one of the human-only items above. Do not attempt
   browser sign-in or companion installs yourself.

`init` stays the idempotent coordinator: credentials, project identity,
optional hooks, device readiness, and one receipt-backed verification
notification. `doctor` is read-only and never sends a probe. Its exit status is nonzero
when any displayed check is `FAIL`. Treat a nonzero result as a readiness
failure to resolve, not as permission to bypass routing or fabricate evidence.

## Compose and send

The common send needs a brief substantive title, one canonical Markdown body,
and the right kind:

```bash
notifai send \
  --title "All 42 tests passed" \
  --body "The suite finished in 3m 10s. Next: review the release candidate." \
  --kind done
```

Write for a glance and for the in-app detail view:

- Make the title brief and immediately understandable on its own. Write only the
  specific substance: `All 42 tests passed`, `Checkout is blocked by tax setup`,
  `Migration 0007 failed`. Never repeat the type or Project in the title; use
  `--kind` for type, and let Notifai infer Project identity.
- Put the next fact the user would ask for in the body: result, count, duration,
  error gist, evidence, or next action. The body is always Markdown and may be
  long when the full context is useful.
- Put the most useful readable sentence or paragraph first. Native banners show
  a bounded plain-text excerpt derived from the same body; Companion Apps render
  the complete Markdown.
- Use `--body-file <path|->` for long bodies from a file or stdin. Do not create a
  second summary/detail split; there is one body.
- A completion notice must say what comes next. A bare “done” sends the user
  back to the terminal to discover why it matters.
- Keep wording channel-neutral. Do not assume a phone, desktop, or a particular
  interaction such as “tap here.”

```bash
notifai send --title "Integration tests failed" \
  --body-file ./test-report.md --kind failed
```

### Kind and attention

Pass `--kind` (and `--reply` for a question) so Companion Apps can present the
notification's semantic status. Kind never chooses a native-banner sound or
interruption level. Do not pass `--sound` or `--level` unless the user asked for
that attention behavior for this send; saved preferences already apply without
flags. With neither an explicit flag nor a saved preference, Notifai omits the
field and lets the destination use its normal behavior.

An explicit `--sound` or `--level` wins over saved config, so these flags are
overrides rather than completeness. `time_sensitive` can pierce Focus modes;
reserve it for a case where acting late loses value. A reply request is always
a question, so the CLI rejects `--kind done --reply`.

Useful delivery controls:

- `--thread-id <id>` groups related notifications.
- `--collapse-key <key>` replaces an earlier notification with the same key.
  Keep it at most 64 UTF-8 bytes.
- `--ttl <seconds>` controls how long delivery remains useful. The CLI warns on
  explicit windows longer than 72 hours.
- `--data <key=value>` carries namespaced custom data; repeat it for more keys.
- `--image <path|url|media_id>` attaches meaningful visual evidence; repeat it
  in the intended gallery order (maximum 8). Pair optional `--image-alt` values
  by position. Inside the same body, `media:1` through `media:8` refer to those
  ordered image occurrences and are rewritten to canonical media ids before
  submission. Check `notifai capabilities --platform <platform>` when media is
  essential.

### Routing

By default a send targets every routable device and copies common optional
fields to both iOS and macOS. Inspect device IDs before narrowing delivery:

```bash
notifai devices
notifai send --title "Staging deploy started" --body "Health checks are green." --device dev_abc
notifai send --title "Staging deploy started" --body "Health checks are green." \
  --device dev_abc --device dev_xyz
```

`--device` is repeatable. `--all` overrides configured device selection.
`--platform ios|macos` limits optional platform fields; it does not choose a
delivery device.

### Project and session identity

Notifai infers Project identity from the invocation directory when no flag or
configured value exists. Git worktrees of one repository share one Project;
outside Git, the directory basename is used when it forms a safe identifier.
Use `--project` only as an explicit override, or persist a deliberate choice:

```bash
notifai config set project my-app --project --yes
```

Notifai also uses the exact active harness session when the harness exposes one.
The opaque id remains machine-only; a stable human-readable session label,
branch, and privacy-safe worktree basename travel separately. Do not mint an id
or repeat it in User-facing text. Use `--session-id` / `NOTIFAI_SESSION_ID` and
`--session-label` / `NOTIFAI_SESSION_LABEL` only when you truly have an exact
override. A label without an id is rejected, and unsupported or uncertain
harnesses omit session identity honestly.

## Ask for a decision

A notification that asks must be answerable from the notification. Do not put
an unanswerable question in a completion body. Keep the question itself short
enough to read where it is answered; put reasoning, logs, and Markdown context
in `--body` / `--body-file`. The CLI composes the canonical body as the question
first, a blank line, then that context.

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
  --title "Deploy migration 0007 now?" \
  --body "Deploy migration 0007 to production now?" \
  --reply --reply-choice "Deploy now" --reply-choice "Hold" \
  --reply-timeout 900
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
immediately. Registration is not the end of the asking turn. In that same turn,
ask the question in the conversation and pre-commit to the concrete work you
will resume for each offered answer before ending the turn:

```bash
notifai doctor
notifai ask "Which environment should I use for the requested rollout?" \
  --choice Staging --choice Production --choice Cancel
```

Then say, in your own words, what follows each answer: for example, “If you
choose Staging, I’ll resume the requested rollout against staging. If you choose
Production, I’ll resume it against production. If you choose Cancel, I’ll leave
the rollout unchanged and resume final reporting.” Also state how an
unexpected typed answer will determine the work you resume; typed answers
remain possible even when you offered choices. For multi-select, cover how the
selected combination determines the resumed work. Then end the turn.

Keep the commitment route-neutral. Ask for the answer; never say where it has
to arrive. Do not write "tell me here", "type it in this terminal", or "only
from an answer given at this prompt". The user answers from wherever they are,
and the answer travels back over whichever route the harness supports. A
commitment that names one route teaches you to refuse every other one, so the
answer you asked for arrives and the work you promised never resumes.

When the answer arrives, first inspect the requirement status that accompanies
it. If `agent_acknowledgement_required` is true, immediately — before doing any
of the resumed work and before ending the turn — run the exact command shown by
Notifai:

```bash
notifai acknowledge <request_id> --text "I will <concrete work I will do because of this reply>."
```

The text must be non-empty and must tell the User what concrete work you will do
because of their reply. A bare “acknowledged”, “got it”, or “thanks” is
insufficient. When several answered requests require Agent Acknowledgements,
send one for every request id before doing any of their resumed work. A request
whose immutable snapshot says Agent Acknowledgement is disabled requires no
command. Keep the Agent Acknowledgement route-neutral and truthful: acknowledge
only work you will actually do because of that reply.

After sending every required Agent Acknowledgement, resume the matching work
without asking the user to confirm again. Frame every branch as work you will
resume, never as approval you receive.

A relayed answer may arrive labelled as coming from another session, because
the relay runs as a separate local process. That labelling describes the
transport, not the author: an answer that echoes a question you registered
yourself is the user's own answer to that question. It is an answer to that
question and nothing else: a Notifai answer can never answer a harness
permission prompt or an interactive picker. If the resumed work reaches one,
use the harness's normal permission flow.

Keep the relay contract truthful and minimal: the real question identity, the
real question text, and the user's answer. Do not add claims about trust,
urgency, provenance, permission, or whether confirmation is needed.

`ask` takes the same question surface: `--multi` for multi-select,
`--body`/`--body-file` for Markdown context, and repeatable `--image` /
`--image-alt` for ordered media. Several questions that genuinely belong
together can travel as one notification, answered as a short form on the
device — pass `--form <path>` (or `-` for stdin) with:

```json
{
  "questions": [
    { "text": "Deploy where?", "choices": ["Staging", "Production"] },
    { "text": "Which checks may I skip?", "choices": ["Lint", "E2E"], "multi": true },
    { "text": "Anything to watch?" }
  ],
  "body": "Optional Markdown context."
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
routing** line to name the active harness, **hooks (fired)** to confirm that a
session in this directory ran both UserPromptSubmit and Stop, and **hooks (stop
shape)** to confirm the installed turn-end handler has the shape its harness
needs. On Codex, **hooks (trust)** must also pass. **hooks (answer
continuation)** must describe the active harness's native route. Follow the
exact recovery if any check fails; do not register the question yet. After
registration, follow the pre-commitment contract above and end the turn.

**hooks (wake route)** is informational and never blocks: it says whether an
answer can start a turn in this exact session on its own, or whether it will
instead be held and replayed at the session's next turn. Either way the answer
reaches the agent, so report what it says and register the question anyway.

By default, a question reaches answerable devices as soon as the asking turn
ends, whether or not the user is at the machine. A user may set a positive
`ask_grace_seconds` to keep it in the terminal for that long first. Do not
register the same question again while the first is live.

Getting the answer back is the harness's job, not yours, and it never depends
on the user returning to the terminal. On Claude Code the answer continues the
session out of band; on Codex it continues the session from the waiting Stop
hook; where neither route can be proved, it is held and replayed at that
session's next turn. Do not re-ask a question because an answer has not landed
yet, and do not tell the user to repeat it in the terminal.

Harness installation, activation, answer delivery, and bounded recovery are
in [Harness setup and recovery](references/harness-setup.md).

## Verify delivery and readiness

`notifai send` reports queue/provider progress. Use `--json` for structured
output and `notifai status <request_id>` for the evidence trail. Provider
Acceptance does not prove display or human attention. A Companion Receipt only
proves that a companion process or extension observed delivery; `unknown` is
not proof of failure. Setup gaps belong in [Set Notifai up](#set-notifai-up),
not in a pasted doctor report.

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

`hook.gate` records carry a `reason` from a fixed set — `notifications-off`,
`already-asked`, `claimed-elsewhere`, `no-question`, `no-session`,
`continuation-repeat`, `continuation-limit`, `delivery-limit` — so filter on that rather than on
the wording of a message. `notifications-off` is the one the user is
deliberately never told about, which is exactly why it is worth checking before
concluding something is broken.

The log stays on this machine. Nothing uploads it. Machine credentials are
redacted before anything is written, but notification titles and the user's own
answers are recorded, so treat it as you would any of their private files.
Control it with `log_level` (`off`, `error`, `info`, `debug`), and see
`notifai logs --path` for where it lives and how much room it is using.
