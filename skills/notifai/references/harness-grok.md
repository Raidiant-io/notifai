# Grok

Read with [Harness setup and recovery](harness-setup.md).

## Activation

`notifai hooks install --harness grok` owns one native file under
`GROK_HOME/hooks/notifai.json` (default `~/.grok/hooks/notifai.json`). Start a
fresh Agent Session after installation. On an enabled Project, the first tool
result carries session guidance and any due update or integration notice;
failed tools also carry it. A later integration notice arrives on a later tool
result. A turn without
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

`notifai ask` schedules submission while independent work continues. After
`notifai ask --wait`, end your turn; Grok's Stop hook keeps the session
waiting and continues it with the answer. Start
Grok with `--leader` for ongoing device conversations: on Grok's shared leader
the answer arrives in the exact running session, however many questions
follow.

Without a leader, including headless runs, the answer returns when the turn
ends, as a Stop continuation. Grok permits eight of those per turn; after that,
a pending question needs another User turn, and Notifai keeps it rather than
opening another session. An explicitly delegated subagent waits at its own
SubagentStop. A long answer arrives as a `notifai replies <request_id> --json`
instruction: read the complete result and run its `acknowledgement_command`
before acting.

Keep the Grok process running while a question is pending: closing the Agent
Session ends its questions, and an answer that arrives later is dropped. A
cancelled turn can interrupt the wait; a later turn recovers the answer.

Grok's own question card is not linked to Notifai, so an away User never sees
it: ask with `notifai ask` and in plain conversation instead. Harness
permission prompts stay in Grok.

## Session Notes and Answer Edits

Only a live session on Grok's shared leader receives Session Notes and
post-delivery Answer Edits; start Grok with `--leader` for them. An idle
session starts a turn and a busy one receives a steer. Acknowledge each message
after reading it. Closing the session stops delivery.

Ordinary local sessions, headless sessions and hidden subagents get answers
through Stop but no Notes or Edits. Notifai never starts a leader or reopens
saved history to deliver a message. Remote execution needs a local installation
on that host. On Windows the leader route is unverified. If the leader is
unavailable or its protocol changes, message delivery stops rather than guess
another session.

## Command approval

In its default permission mode Grok asks before each shell command it has no
rule for, so an away User's question can wait at an approval nobody sees.
Grok also applies the allow rules in the User's Claude Code settings, so once
the User has granted Claude Code command approval (`notifai init
--claude-commands`), Grok runs Notifai commands written as the skill's Send
section shows without asking. Notifai writes no Grok rules; never change
Grok's permission mode or rules yourself.

## After a Notifai update

The native hooks call the updated CLI; reread guidance in the current Agent
Session. Changed hooks count as loaded once a natural callback shows them.

## Question cards

Notifai refuses an unregistered Grok question card before it opens. Use
`notifai ask` and ask the question in the conversation. An exact question
already registered in this Agent Session may open locally; never register
it again. If it is answered in the conversation, close the registered question
with `notifai close <question_id>`. Cards on a signed-out machine, with
questions off, or in a disabled Project stay local.
