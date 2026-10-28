# Harness support

What Notifai does in each agent harness. For commands and setup, see
[Using Notifai](USAGE.md).

## Features by harness

| Harness | Notifications | Answer questions | Send notes | Shows who's running |
| --- | --- | --- | --- | --- |
| Claude Code | Yes | Yes | Yes | Yes |
| Codex (CLI, IDE, ChatGPT app) | Yes | Yes | Yes | Yes |
| Cursor | Yes | Yes | Partly | Partly |
| OpenCode | Yes | Yes | Coming soon | Coming soon |
| OpenClaw | Yes | Yes | Yes | Yes |
| Hermes | Yes | Yes | Yes | Yes |
| Grok | Yes | Yes | Partly | Coming soon |

**Send notes** means you can steer a running agent with a short message from
your phone. **Shows who's running** means your devices show whether each Agent
Session is working, idle or finished.

The CLI itself (sign-in, settings, `send`, `ask`, `doctor`) runs on macOS,
Linux and Windows. T3 Code and Orca work too, through the harnesses they run.

## What happens when an agent asks

In **Claude Code, Codex, OpenClaw and Hermes** the agent keeps working while
you decide. Your answer goes back to the exact Agent Session that asked, even
if it went idle in the meantime.

In **Cursor, OpenCode and Grok** the agent waits for your answer, then carries
on.

Closing an Agent Session ends its questions, so an answer that arrives after
that reaches nobody, and your devices say so.

## Each harness

**Claude Code.** Answers and notes arrive on their own: a busy session gets
them between steps, an idle one starts a new turn. This needs Claude Code
2.1.224 or newer on macOS and Linux, or 2.1.234 or newer on Windows; with an
older version the answer arrives at the session's next turn. Claude Code's own
question picker is linked too: answer it in the terminal or on your phone.

**Codex.** Answers and notes arrive on their own, like Claude Code. Codex's
question card is linked from Codex 0.163.0, with models that offer it. Codex
runs in the terminal (Codex CLI), in your editor (Codex IDE extension) and in
the ChatGPT desktop app. After installing or updating hooks, approve the
Notifai hooks once in Codex: in the ChatGPT app or your editor, click the
**Review hooks** icon by the message box; in the terminal, type `/hooks`.
Apps that run Codex for you, such as T3 Code and Orca, have no hook review of
their own; there your agent's reminder gives the terminal command that opens
Codex's review for the right Codex account, with no sign-in.
`notifai doctor` names any that still wait for approval.

**Cursor.** Questions wait in the asking command (`notifai ask --wait`). In
the Cursor terminal agent on macOS, notes reach a conversation between turns,
and your devices show it while it waits for you. Hosts built on the Cursor SDK,
such as T3 Code, are supported through an always-applied rule that setup
writes.

**OpenCode.** Supports OpenCode 1, and OpenCode 2.1 and later. OpenCode 2.0
is not supported; `notifai doctor` says so. OpenCode's own question form
reaches your devices, and you can answer it in either place. Notes are coming.

**OpenClaw.** On macOS, answers and notes come back through the OpenClaw
Gateway into the same session. On Linux and WSL2, the agent waits for your
answer in the asking command.

**Hermes.** Supports Hermes v0.21.5 in its local classic CLI, on macOS and
Linux, through a native plugin. Answers and notes come back into the running
session.

**Grok.** Grok holds the session at the end of its turn until your answer
arrives, then continues. Notes reach a session started with `grok --leader`,
except on Windows.

## What setup installs

`notifai init` (or `notifai hooks install`) wires each harness it finds, once
per machine:

| Harness | Where |
| --- | --- |
| Claude Code | Hooks in `~/.claude/settings.json` |
| Codex | Hooks in `~/.codex/hooks.json`, or in `config.toml` if your own hooks already live there |
| Cursor | Cursor hooks, plus the rule `~/.cursor/skills/notifai-activation/SKILL.md` |
| OpenCode | A generated plugin for the OpenCode version it finds |
| OpenClaw | A generated Gateway plugin |
| Hermes | A native plugin, installed through `hermes plugins` |
| Grok | `~/.grok/hooks/notifai.json` |

Installing hooks does not turn Notifai on for a Project. That is
`notifai project enable` and `notifai project disable`. Start a fresh Agent
Session after installing, then run `notifai doctor` to check everything.
`notifai hooks uninstall` removes them again.

The hooks give the agent Notifai's guidance at the start of each Agent Session,
remember which session asked each question, and hand answers and notes back
into it. Subagents get reporting-only guidance: the agent that started them
sends the notifications unless it hands that job over.

For Claude Code and Codex on macOS and Linux, one small background process
per user (`notifai hub`) waits for answers for every running session. It starts
when a session needs it and exits shortly after the last one ends. There is no
login item or startup task.

## When a session stops without closing

In Claude Code and Codex on macOS and Linux, a conversation stopped by its app
or by the machine (the desktop app pausing it, a shutdown, a power cut) can
come back. Until it does, its questions stay open for
their answer window and your devices show the session as out of reach. An
answer you give meanwhile waits on the computer and is handed over when the
conversation comes back. `notifai doctor` lists stopped sessions.

## More detail

The [agent skill's harness references](../skills/notifai/references/) are what
agents read about each harness. They cover setup, recovery and edge cases in
full.
