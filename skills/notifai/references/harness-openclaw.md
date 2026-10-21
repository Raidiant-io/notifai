# OpenClaw

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

Installation applies a changed plugin to a running Gateway through
`openclaw plugins reload notifai` and names the applied generation; with no
Gateway running it loads at the next start. If it says the previous generation
kept serving, run `openclaw plugins reload notifai --wait` (or restart the
Gateway). Then start one fresh Agent Session, send one prompt, and run
`notifai doctor`. Notifai owns its generated Gateway plugin and will not
overwrite a foreign one.

The Agent Session is the OpenClaw `sessionKey`. Each conversation is activated
on its first prompt, and again after `/new`, `/reset` or a daily or idle
rollover starts a new one. A session key containing `:subagent:`, or an ACP
nested context, is a worker: it reports to its parent and does not notify.
A session whose identity is missing is treated as a worker. A worker explicitly
delegated Notification Requests in its prompt loads the skill and guidance as
their owner.

## Questions

On macOS, an asynchronous `notifai ask` answer comes back into the same Agent
Session after the asking turn ends, as a followup turn carrying a pointer. Run
`notifai replies <id>` from that session to read the answer and
`notifai acknowledge <id>` before acting on it. This needs an enabled Project
and a local Gateway that has loaded the currently installed plugin and runs a
matching CLI version. Off macOS, `ask` refuses: use a blocking
`notifai send --reply` question, as the skill's "Bounded foreground wait" says.

Stopping the Gateway, or disabling or uninstalling the Notifai plugin while it
runs, ends the Gateway's sessions for Notifai: their questions expire and a
later answer is dropped. Never suggest either while a question waits. A plugin
reload keeps them open. Do not treat `/stop` as turn-end.

## Notes and edits

On macOS the Gateway hands Session Notes and post-consumption Answer Edits in as
followup turns. Each turn starts with a pointer naming the message, and the
full note or edit context arrives with it once; a plugin reload keeps a message
that is still waiting. Acknowledge each `sm_` message after reading it.

If the full context is absent, say the message is missing and do not
acknowledge it; the User may send a new message. This happens when a Gateway
crash replays the pointer after its context was used, or when the conversation
changed (`/new`, `/reset`, rollover) or the Gateway restarted before the turn
ran.

## After a Notifai update

The loaded plugin checks before each prompt and injects guidance once per
conversation. Changed plugin code needs a Gateway reload: keep existing routes
until a safe reload, then confirm a prompt served by the reloaded plugin.
