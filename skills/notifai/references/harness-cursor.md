# Cursor

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**Cursor:** activation adds no turn. Cursor wiring is the lifecycle hooks plus
one always-applied rule, `~/.cursor/skills/notifai-activation/SKILL.md`, which
`notifai hooks install --harness cursor` writes and `notifai doctor` checks.

- The editor, the Agents Window and `cursor-agent` deliver SessionStart context,
  which activates Notifai. The rule tells you to follow that context when present.
- A host built on the Cursor SDK, such as T3 Code, drops hook context but loads
  the rule. So does a new editor chat whose SessionStart context arrives late.
  There, follow the rule: run `notifai project status` once when work first
  calls for a Notification Request, then `notifai guidance` if it is enabled.
- Standalone `cursor-agent` 2026.10.01 does not load the rule; its SessionStart
  context covers it.
- No activation reaches an SDK host that omits the `user` setting source, an
  ACP host (no lifecycle hooks) or a cloud agent (no machine configuration).

Start one fresh conversation and send one prompt, then run `notifai doctor`.
The agent shell does not create a separately activated context for delegated
work: it remains under the parent Agent Session and its explicit Notification
Request ownership. It does not expose the exact conversation id needed to prove
which concurrent Agent Session invoked `notifai ask`, so asynchronous ask fails
closed. Use blocking `notifai send --reply` for questions.
