# Grok

Read with [Harness setup and recovery](harness-setup.md).

## Activation

`notifai hooks install --harness grok` owns one native file under
`GROK_HOME/hooks/notifai.json` (default `~/.grok/hooks/notifai.json`). Start a
fresh Agent Session after installation. When lifecycle guidance is on, the first tool
result carries session guidance and any due update or integration notice;
failed tools also carry it. A later integration notice arrives on a later tool
result. A turn without tools ends normally. After resume or compaction,
the next tool result carries guidance again. Ordinary subagents receive worker ownership guidance; explicit delegation
still decides who owns Notification Requests.

`GROK_SESSION_ID` supplies exact Source Context in tool subprocesses. Inherited
markers from another harness are ambiguous: follow the admission remedy rather
than choosing a session from history. Remote tools need the CLI, credentials,
and hooks on the execution host; local installation does not prove that setup.

Cursor import errors in `/hooks` come from Grok's Cursor compatibility loader,
which rejects Cursor's flat hook replies; Notifai's native hooks work without
imported Claude or Cursor copies. Leave the User's config as it is. Only when
the User asks to silence the errors, set `hooks = false` under
`[compat.cursor]` in Grok's user config (or `GROK_CURSOR_HOOKS_ENABLED=false`
for one launch); Cursor's own hooks stay intact. Keep unrelated hooks and trust
decisions with their owner.

## Questions and replies

`notifai ask` schedules submission while independent work continues. After
`notifai ask --wait`, end your turn; Grok's Stop hook keeps the session
waiting and continues it with the answer. On Grok's shared leader, which the
User chooses by starting Grok with `--leader` (a running session cannot
switch), the answer arrives in the exact running session, however many
questions follow.

Without a leader, including headless runs, the Stop hook holds the session at
the end of the turn until the answer arrives, after `ask` as after
`ask --wait`, and continues it with the answer. Grok permits eight such
continuations per turn; after that, tell the User the remaining answers wait
for their next prompt. An explicitly delegated subagent waits at its own
SubagentStop. A long answer arrives as a `notifai replies <request_id> --json`
instruction: read the complete result and run its `acknowledgement_command`
before acting.

Keep the Grok process running while a question is pending: closing the Agent
Session ends its questions, and an answer that arrives later is dropped. A
cancelled turn can interrupt the wait; a later turn recovers the answer.
Harness permission prompts stay in Grok.

## Session Notes and Answer Edits

A live session on Grok's shared leader receives Session Notes and
post-delivery Answer Edits directly. An idle session starts a turn and a busy
one receives a steer.

On macOS, a session a regular Orca chat or a T3 Code thread runs without the leader
receives a Notifai wake through that app instead; in Orca it arrives as mail
from the chat itself. The wake carries no note, answer or approval: run
`notifai receive` once and follow what it prints. Never reply to the wake's
mail. A busy session gets the wake after its current turn. If `notifai
receive` says nothing is pending, the input was already read: end that turn.

Acknowledge each message after reading it. Closing the session stops
delivery.

On macOS, Orca bot chats and standalone terminal sessions can use Grok's
native persistent monitor when no other wake route is qualified. Follow the
tool-result instructions to start it once and leave it running. If Grok asks
for permission, let the User decide there. When it wakes the session, run
`notifai receive` once and follow the result. If the User ends the monitor,
leave it stopped. The app offers notes while the monitor is running.
In Orca, stop the monitor before clearing the bot conversation with
`/clear`. Closing the bot's tab leaves its conversation running in Activity.

One-shot sessions and hidden subagents get answers through Stop. Remote
execution needs a local installation on that host. Notifai cannot use the
leader on Windows. When there is no live route, a running session shows
that it does not take notes.

## Command approval

In its default permission mode Grok asks before each shell command it has no
rule for, so an away User's question can wait at an approval nobody sees.
Grok also applies the allow rules in the User's Claude Code settings, so once
the User has granted Claude Code command approval (`notifai init
--claude-commands`), Grok runs Notifai commands written as the skill's Send
section shows without asking. Notifai writes no Grok rules; never change
Grok's permission mode or rules yourself.

## After a Notifai update

The native hooks call the updated CLI. When the guidance this Agent Session read
has changed, its next tool result carries the guidance again and says so, as it
does after a compaction. Changed hooks count as loaded once a natural callback
shows them.

## Question cards

Notifai refuses an unregistered Grok question card before it opens. Use
`notifai ask` and ask the question in the conversation. An exact question
already registered in this Agent Session may open locally; never register
it again. If the User answers another way (in the conversation, elsewhere, or
by doing it) or the question stops being relevant (its work is done,
superseded or cancelled, or a newer question replaces it), close it with
`notifai close <question_id>`. Cards on a signed-out machine, with questions
off, or in a disabled Project stay local.
