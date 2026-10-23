# Cursor

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

Activation adds no turn. Cursor wiring is the lifecycle hooks plus one
always-applied rule, `~/.cursor/skills/notifai-activation/SKILL.md`, which
`notifai hooks install --harness cursor` writes and `notifai doctor` checks.

- The editor, the Agents Window and `cursor-agent` deliver SessionStart context,
  which activates Notifai.
- A host built on the Cursor SDK, such as T3 Code, drops hook context but loads
  the rule. So does a new editor chat whose SessionStart context arrives late.
- The rule asks the CLI, never the conversation: run `notifai project status`
  once when work first calls for a Notification Request, then
  `notifai guidance` if it is enabled.
- Standalone `cursor-agent` 2026.10.01 does not load the rule; its SessionStart
  context covers it.
- No activation reaches an SDK host that omits the `user` setting source, an
  ACP host (no lifecycle hooks) or a cloud agent (no machine configuration).

Start one fresh conversation and send one prompt, then run `notifai doctor`.

## Questions

Delegated work stays under the parent Agent Session and its Notification
Request ownership; Cursor starts no separately activated context for it.
Cursor does not tell Notifai which conversation ran a command, so no answer
can come back later: ask with `notifai ask --wait` in the foreground, and let
it run until it returns with the answer or says the question ended.

## After a Notifai update

The hooks call the updated CLI, and refreshing the hooks also rewrites the
activation rule; reread guidance in the current conversation. A changed hook command
counts as loaded once a hook call in this conversation shows it. Changed
SessionStart context and a changed rule load when a new conversation starts.
