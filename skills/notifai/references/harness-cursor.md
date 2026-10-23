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
- The rule checks `notifai guidance check` at each turn, carrying its returned
  digest in this conversation as the next call's optional argument. A new or
  changed receipt returns current activation and a working skill path; load
  them before the next Notification Request. After compaction, omit the old
  receipt. A disabled Project returns no guidance.
- Standalone `cursor-agent` 2026.10.01 does not load the rule; its SessionStart
  context covers it.
- No activation reaches an SDK host that omits the `user` setting source, an
  ACP host (no lifecycle hooks) or a cloud agent (no machine configuration).

Start one fresh conversation and send one prompt, then run `notifai doctor`.

## Questions

Delegated work stays under the parent Agent Session and its Notification
Request ownership; Cursor starts no separately activated context for it.
Cursor does not tell Notifai which conversation ran a command, so the Agent
Session has no name to set or rename (omit `--session-label`) and no answer
can come back later: ask with `notifai ask --wait` in the foreground, and let
it run until it returns with the answer or says the question ended.
`notifai doctor` reports that as a Cursor limit, not a fault to repair.

## Command approval

Cursor can hold a Notifai command for approval: Notifai needs the network,
which Cursor's sandbox blocks, so the command runs outside it, where Cursor's
run mode decides whether to ask; `cursor-agent` asks for each command not on
its allowlist. An away User never sees that approval. Notifai writes no
Cursor rules: the User can allow the Notifai commands in Cursor's approval
settings. Never change those yourself.

## After a Notifai update

The hooks call the updated CLI, and refreshing the hooks also rewrites the
activation rule. A loaded current rule checks content digests, not versions,
and asks for a reload only when the guidance changes. A changed hook command
counts as loaded once a hook call shows it. A host must actually load the new
rule; an older rule retained in a conversation gains no new callback merely
because its file changed.
