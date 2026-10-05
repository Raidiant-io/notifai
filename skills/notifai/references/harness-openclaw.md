# OpenClaw

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**OpenClaw:** restart the Gateway after installation because plugins load at
startup, then start one fresh Agent Session, send one prompt, and run
`notifai doctor`. Notifai owns its generated Gateway plugin and will not
overwrite a foreign one. Exact Agent Session identity is the OpenClaw
`sessionKey`; the transcript `sessionId` can stay the same across `/new` and
`/reset`, while idle or daily rollover can change it. Notifai gives each
observed generation one activation on its first prompt, using the native
lifecycle revision and typed events to fence same-`sessionId` resets. A session key containing
`:subagent:` or an ACP nested context
is a worker. Missing identity fails safe as a non-sending worker; only a
proven parent Agent Session receives owner context. Explicit textual
delegation promotes that worker through the same skill-and-guidance rule.
On macOS, the loaded Gateway service can route an asynchronous `notifai ask` answer
into the same Agent Session after the asking turn ends. It queues a pointer
through OpenClaw's followup route; run `notifai replies <id>` from that
session to read the answer and `notifai acknowledge <id>` before acting on it.
Question Routing requires the current generation marker, an enabled Project,
and a local Gateway whose CLI version and process identity match the plugin.
If this Project is disabled, run `notifai project enable` before `notifai ask`.
On macOS, the same Gateway service attends the current generation and queues
Session Notes and post-consumption Answer Edits as followup turns. It keeps
the message in a private local delivery journal and sends only an opaque
pointer in the CLI call. The matching prompt receives the full context once,
only within its original native generation and Gateway instance. Journal
text is discarded after that prompt claims it, a generation change, or a
Gateway restart. The agent acknowledges each `sm_` message after reading it.
If a Gateway crash interrupts a turn, OpenClaw may replay its pointer after
the staged context was consumed. The pointer instructs the agent to say the
context is missing and leave that message unacknowledged; the User may send
a new message. Do not treat `/stop` as turn-end.

## Notes and edits

OpenClaw starts that turn with a pointer naming the message. If the full note
or edit context is absent, say the message is missing and do not acknowledge
it. A Gateway crash during the turn can replay the pointer without the staged
context; Notifai leaves that message handed off and unacknowledged, and the
User may send a new message.
