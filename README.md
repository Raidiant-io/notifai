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

Run `notifai` with no arguments at a terminal to open the interactive app:
status at a glance, a test notification, your devices, and every setting with
an explanation of what it does and where its current value came from.

```sh
notifai                      # the interactive app
notifai init                 # set this project up, step by step
notifai config show          # every setting, explained
notifai config explain <key> # one setting, in full
notifai config unset <key>   # return a setting to its inherited/default value
notifai doctor               # check every part of the setup
```

Anywhere that is not a terminal — a script, a CI job, an agent — `notifai`
prints help instead of prompting, output stays uncoloured, and `--json` is
available on the commands that report. Nothing in the CLI ever waits on stdin
unless a human is demonstrably there.

## Companion App installation

Private Alpha Companion Apps are distributed only through controlled TestFlight
invitations. Open the invitation on the iPhone or Mac you want to use, install
Apple's TestFlight app, install Notifai, then open it once, sign in with the same
account as the CLI, and allow notifications. There is no public App Store link
or public TestFlight link for the Private Alpha.

## Status

Notifai is published under Apache-2.0. The current packages are
`@raidiant/notifai` <!--x-release-please-start-notifai-->1.0.1<!--x-release-please-end--> and `@raidiant/notifai-protocol` <!--x-release-please-start-protocol-->0.4.0<!--x-release-please-end-->; their
versions advance independently. Only the latest published version is
supported.

## Development

Requires Node >= 20 and pnpm.

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
installed by default. `notifai init` coordinates project configuration,
sign-in, optional harness hooks, and device readiness. `notifai init --skills`
delegates to the native `npx skills` flow, which lets a human choose project or
global scope and owns placement, links, provenance, and updates. The skill is
from the immutable public tag `v<!--x-release-please-start-notifai-->1.0.1<!--x-release-please-end-->`; the underlying installer source is
`Raidiant-io/notifai#v<!--x-release-please-start-notifai-->1.0.1<!--x-release-please-end-->` (`#` selects a Git ref). For unattended use,
choose the scope explicitly: `notifai init --skills --skills-scope project` or
`notifai init --skills --skills-scope global`.

## The installed hooks

`notifai hooks install` writes three hooks into the agent harness. After
install you will see `UserPromptSubmit`, `Stop`, and `SessionEnd` in that
harness's hook file. They are how a question reaches your devices and how the
answer comes back, without the agent keeping any of that in its context.

**UserPromptSubmit** (`user-prompt-submit`) runs when you send a prompt. That
is the proof you are at the keyboard, so Notifai retires any question still
waiting on your devices and remembers this session for later `notifai ask`
calls. It has to run here: only this moment can tell that you were present for
this turn.

**Stop** (`stop`) runs when the agent turn ends. If the agent registered a
question with `notifai ask`, this is when that question can leave for your
devices and when a device answer is handed back into the next turn. It has to
run at Stop because that is the first moment the turn is over and the agent is
waiting.

**SessionEnd** (`session-end`) runs when the session closes. It drops this
session's local state and queues any leftover questions for retirement so they
do not sit on your devices after the agent is gone. It has to run here because
no later hook for this session will fire.
