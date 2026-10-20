# Grok

Read with [Harness setup and recovery](harness-setup.md).

## Activation and setup

`notifai hooks install --harness grok` owns one native file under
`GROK_HOME/hooks/notifai.json` (default `~/.grok/hooks/notifai.json`). Start a
fresh Agent Session after installation. On an enabled Project, the first tool
result carries effective guidance; failed tools also carry it. A turn without
tools gets one Stop continuation to load guidance. Resume and compaction re-arm
it. Ordinary subagents receive worker ownership guidance; explicit delegation
still decides who owns Notification Requests.

`GROK_SESSION_ID` supplies exact Source Context in tool subprocesses. Inherited
markers from another harness are ambiguous: follow the admission remedy rather
than choosing a session from history. Remote tools need the CLI, credentials,
and hooks on the execution host; local installation does not prove that setup.

If `/hooks` shows Cursor import errors, inspect `grok inspect --json`. Grok's
Cursor compatibility loader rejects Cursor's flat hook replies. With the User's
authorization, set `hooks = false` under `[compat.cursor]` in Grok's user config
(or `GROK_CURSOR_HOOKS_ENABLED=false` for one launch). This leaves Cursor's own
hooks intact. Native Notifai hooks do not need imported Claude or Cursor copies.
Keep unrelated hooks and trust decisions with their owner.

## Questions and replies

`notifai ask` schedules submission while independent work continues. At genuine
turn end, the native Stop hook waits for the answer. On a shared leader, it
claims delivery and queues an interjection into the exact resident session.
This supports successive questions without spending Grok's blocking-Stop
continuations. Start Grok with `--leader` for ongoing device conversations.

Without a leader, the answer returns as a native Stop continuation. An
explicitly delegated subagent uses its own SubagentStop gate. Grok permits eight
blocking continuations per turn; after that, a pending question needs another
User turn to resume. Notifai retains it rather than opening another session.
A long answer arrives as a `notifai replies <request_id>
--json` instruction: read the complete result and run its
`acknowledgement_command` before acting. A successor Stop confirms transport
delivery on the fallback route; the agent's acknowledgement confirms receipt
to the User on either route.

Keep the Grok process running while a question is pending: closing the
Agent Session ends its questions, and an answer that arrives later is dropped.
Cancellation can interrupt the held hook; a later turn can recover the durable
answer. Shutdown
observations neither submit questions nor consume answers. Headless runs use
the same Stop route. Grok's native question card has no linked Notifai reply
operation; ask in plain conversation and leave harness permissions in Grok.

## Session Notes and Answer Edits

A live session on Grok's shared leader can receive Session Notes and
post-delivery Answer Edits. Start Grok with `--leader` when you want those
features. Notifai discovers the exact resident session, then uses Grok's
interjection queue; idle sessions start a turn and busy sessions receive a
steer. Queue acceptance is not acknowledgement: acknowledge the message after
reading it. Closing the session stops delivery.

Ordinary local sessions, headless sessions and hidden subagents keep the Stop
question route without external Notes or Edits. Notifai never starts a leader
or reopens saved history to deliver a message. Remote execution needs a local
installation on that host. This leader route uses Unix sockets; Windows
support is unverified. If the leader is unavailable or its protocol changes,
message delivery stops instead of guessing another session.
