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

If you do not want a global bin, `npx --yes @raidiant/notifai@<version>` is
supported. Pin the version. `hooks install` then writes that same pinned npx
invocation into the harness adapter. This is slower than a real install and
is not the default path.

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

By default a question reaches your devices when the agent turn ends, whether or
not you are at the keyboard (`ask_grace_seconds = 0`). Set a positive grace
period for a terminal-only answer window first.

For a harness that cannot resume an idle agent turn, `notifai send
--reply` blocks and waits for the answer instead.

## Agent harnesses

The CLI and managed hook adapters support macOS, Linux, and Windows. Receiving
still requires the current iPhone or macOS Companion App; native Windows and
Linux Companion Apps are not shipped yet.

```sh
notifai hooks install
```

Wires question routing into every supported harness detected on this
machine (Claude Code, Codex, Cursor, OpenCode). `notifai init` does the
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
Codex's Stop definition omits its timeout so the host default remains
authoritative; prompt-submit and session-end retain fixed short limits.

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
