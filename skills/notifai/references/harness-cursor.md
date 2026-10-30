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
- When work first calls for a Notification Request, run `notifai guidance check`; before each later one, run `notifai guidance check <token>` with the token it returned in this conversation. After compaction, run it without a token.
- When it returns `context`, follow it, read `skill_file` when present, then run its `read_command`. Add its `request_flag` to `send` and `ask`.
- If it returns `disabled: true`, work without Notifai in this conversation. Otherwise follow its output, including for Projectless and first-use requests.
- Standalone `cursor-agent` 2026.10.01 does not load the rule; its SessionStart
  context covers it.
- No activation reaches an SDK host that omits the `user` setting source, an
  ACP host (no lifecycle hooks) or a cloud agent (no machine configuration).

Start one fresh conversation and send one prompt, then run `notifai doctor`.

## Questions

Delegated work stays under the parent Agent Session and its Notification
Request ownership; Cursor starts no separately activated context for it.
Current Cursor shells identify their conversation through
`CURSOR_CONVERSATION_ID`. Sends use that exact Agent Session, and
`--session-label` names it. Older shells without that marker remain
detection-only, and the CLI sets `--session-label` aside there.

On the macOS Cursor TUI, a completed turn holds its native Stop hook open for
up to one hour. After this conversation has sent a Notification Request, that
hook holds Session Presence and accepts Session Notes. A note resumes the same
conversation through Cursor's native follow-up message; acknowledge it as the
message instructs. Presence is withdrawn when that hook closes, including while
the next turn works, and returns at the next completed Stop. No synthetic turns
keep it alive. Print mode, ACP and other unverified surfaces have no promised
note continuation.

Asynchronous questions and native question forms remain unsupported. Ask
with `notifai ask --wait` in the foreground, and let it run until it returns
with the answer or says the question ended.
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
activation rule. A loaded current rule checks currency only when work calls for a Notification
Request, and asks for a reload when the installed text changes. A changed hook command
counts as loaded once a hook call shows it. A conversation still holding the older rule learns the new flow from the refusal `send` or `ask` prints; follow its remedy.
