# notifai

Send native phone notifications from agents and local programs.

An agent working while you are away has no way to reach you, so it either
guesses or sits blocked in a terminal nobody is watching. `notifai` gives
it a way to tell you something finished, and a way to ask you a question
and get your answer back — as a banner on your phone, with buttons.

```sh
npm install -g @raidiant/notifai
notifai init
```

`init` walks the setup one step at a time and tells you the single next
thing to do. Run it again after each step; it works out what remains.

When `--skills` is selected at a human terminal, `init` runs the native
`npx skills` flow so that flow can ask whether the skill belongs to the
project or the machine. An unattended caller must select one explicitly:
`notifai init --skills --skills-scope project` or
`notifai init --skills --skills-scope global`.

## Telling you something happened

```sh
notifai send --title "Deploy finished" --body "staging, 2m14s" --kind done
```

Write for a lock screen. The title gets a couple of seconds of attention
and usually has to carry the whole message; assume the body may never be
read. Long-form content belongs in `--detail`, which never appears on the
banner and is shown in the companion app for when you sit down.

## Asking you a question

```sh
notifai ask "Deploy the migration to production?" --choice Yes --choice No
```

The agent registers the question, ends its turn, and your answer comes
back on its next turn. On iPhone the choices are buttons on the banner
itself.

By default a question reaches your devices when the agent turn ends, even if
you are at the keyboard (`require_idle = false`, `ask_grace_seconds = 0`). Turn
on `require_idle` if you want active keyboard or mouse use to keep questions in
the terminal, or set a positive grace period for a terminal-only answer window.

For a harness that cannot resume an idle agent turn, `notifai send
--reply` blocks and waits for the answer instead.

## Agent harnesses

```sh
notifai hooks install
```

Wires question routing into Claude Code, Codex, Cursor or OpenCode. This
is what lets an agent's question reach your phone without the agent
having to cooperate — no question detection, no state in a context window
that compaction will eat.

Every harness definition calls one stable user-level adapter at
`~/.notifai/bin/hook-adapter`. Node, package manager, CLI version, checkout,
XDG directories, and notification preferences are resolved behind it, so
upgrades and configuration changes do not rewrite trusted hook definitions.
The first migration may require one Codex `/hooks` approval; later repairs keep
the same identity. Codex definitions omit timeout fields so Codex's host
defaults remain authoritative.

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

Source, issues and the security policy:
<https://github.com/Raidiant-io/notifai>

Apache-2.0.
