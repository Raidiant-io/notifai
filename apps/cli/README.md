# notifai

Send native phone notifications from agents and local programs.

An agent working while you are away has no way to reach you, so it either
guesses or sits blocked in a terminal nobody is watching. `notifai` gives
it a way to tell you something finished, and a way to ask you a question
and get your answer back as a banner on your phone.

```sh
npm install -g @raidiant/notifai
notifai init
```

The `notifai` command is always a machine-wide install. Setup scope (this
project vs this machine) does not change that. If you do not want a global
bin, `npx --yes @raidiant/notifai@<version>` is supported. Pin the version.
`hooks install` then writes that same pinned npx invocation into the harness
adapter. This is slower than a real install and is not the default path.

Use `notifai update` for later global updates. It repairs the installation the
shell actually selects and keeps the stable hook adapter on that same CLI.

`init` walks the setup one step at a time and tells you the single next
thing to do. Run it again after each step; it works out what remains.

At a human terminal, `init` asks once whether this setup is for this project
or for every project on this machine. That answer is skill, hooks, and
config together. Pairing, devices, and credentials stay on this machine
either way. An unattended caller passes the same choice as a flag:
`notifai init --setup-scope project` or `notifai init --setup-scope global`.
`--skills-scope` is an alias of that flag when `--skills` is set. Shared
project config may live in the repo; personal project preferences live under
the user config directory and never require a `.gitignore` edit.

## Telling you something happened

```sh
notifai send --kind done \
  --title "Deploy finished" \
  --summary "The staging deployment is live." \
  --body "The staging deployment is live and ready for review."
```

Write a brief title whose substance is immediately understandable; type lives
in `--kind`, and Project identity is inferred from the invocation directory.
Every Notification Request has a purpose-written, one-line plain-text Summary
for native banners and list views. It is required and limited to 240 Unicode
characters. Body is optional standalone Markdown for focused detail; when it is
absent, the focused view shows Summary. Use `--body-file <path|->` for long
content. Repeat `--image` for an ordered image
collection (up to eight) and pair each with `--image-alt`. Every attached
image appears in the gallery; to place one where the words refer to it, write
Markdown image syntax with its 1-based position, `![what it shows](media:1)`.
A bare `media:1` or a link to it is refused before sending.

## Asking you a question

```sh
notifai ask "Deploy the migration to production?" \
  --title "Choose migration timing" \
  --choice Yes --choice No
```

The agent registers the question, ends its work, and your answer comes back on
its next turn. Question Routing keeps that exact session available for the
complete answer window: Claude Code waits out of band and wakes it on
macOS/Linux; on Windows its Stop stays held and returns the answer as the same
Agent Session's continuation, like Codex. On iPhone, press and hold the
collapsed banner to answer; the choices appear on the expanded card, not on
the lock screen.

By default a question reaches your devices when the agent turn ends, whether or
not you are at the keyboard (`ask_grace_seconds = 0`). Set a positive grace
period for a terminal-only answer window first.

When you answer, the agent acknowledges it before it does anything else, so you
find out your reply landed and what it set in motion — not just that you sent
it. Answering from your phone and wondering whether anything happened is the
whole problem this solves.

For a harness that cannot resume an idle agent turn, `notifai send --reply`
owns the complete answer window in the foreground: keep it alive and set
`--reply-timeout` equal to `--reply-window`. After a timeout, retain the request
ID and inspect that original with `notifai replies` and `notifai status`; never
send a duplicate.

## Agent harnesses

The CLI and managed hook adapters support macOS, Linux, and Windows. iPhone
and Android Companion Apps are both active: Android is distributed as a
directly downloadable signed APK (no Google Play listing yet), with a separate
invitation-only Firebase App Distribution test lane. Native desktop Companion
Apps are not shipped.

```sh
notifai hooks install
```

Wires question routing into every supported harness detected on this
machine (Claude Code, Codex, Cursor, OpenCode, OpenClaw). `notifai init` does the
same and, at a terminal, lets you keep the detected set, pick a subset,
or add one it did not see. This is what lets an agent's question reach
your phone without the agent having to cooperate — no question detection,
no state in a context window that compaction will eat.

Every harness definition calls one stable user-level adapter under the account
home (`~/.notifai/bin/hook-adapter` on macOS/Linux and the corresponding user
profile path on Windows). Node, package manager, CLI version, checkout,
configuration directories, and notification preferences are resolved behind
it, so upgrades and configuration changes do not rewrite trusted hook
definitions. Windows invokes its JavaScript adapter through the registered Node
executable; macOS/Linux retain the POSIX adapter and its stable command bytes.
Claude Code Stop returns immediately into the live inbox route on macOS/Linux;
on Windows, where upstream exposes no inbox socket, Stop stays open and returns
the accepted answer through the harness continuation. The first migration may
require one Codex `/hooks` approval; later repairs keep the same identity.
Codex's Stop definition declares the full-window timeout explicitly; that
one-time definition change is why the migration needs approval. Prompt-submit
and session-end retain fixed short limits.

`notifai doctor` compares Codex trust on a best-effort basis against Codex's
current persisted representation. Notifai never writes that trust store;
Codex's `/hooks` review is authoritative if the diagnostic and UI disagree.

Uninstall removes only the selected harness definition. It intentionally keeps
the shared adapter because definitions for other harnesses or projects may
still invoke it and cannot all be discovered from one working directory.

## Checking it works

```sh
notifai doctor
```

Reports every part of the setup and names where to start if something is
wrong. Any `FAIL` line makes the command exit nonzero; informational `--` lines
do not. `--json` emits the same result with an explicit `exit_code`.

## Reference

`notifai <command> --help` is the exhaustive and current flag surface.
Everything useful is possible non-interactively, so an agent never
reaches a prompt and hangs.

Source, issues and the public/private boundary policy:
<https://github.com/Raidiant-io/notifai>

The URL, self-host exception, guidance-authority and non-exfiltration policy is
documented in [`docs/TRUST.md`](https://github.com/Raidiant-io/notifai/blob/main/docs/TRUST.md).

Apache-2.0.
