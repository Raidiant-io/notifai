# OpenCode

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**OpenCode:** restart after installation because plugins load at startup,
then start one fresh Agent Session, send one prompt, and run `notifai doctor`.
Notifai owns its generated plugin file and will not overwrite a foreign one.
The plugin treats a session with `parentID` as a worker. When relationship
lookup fails or returns unusable data it also fails safe as a non-sending
worker; only a proven parent Agent Session receives owner context. Explicit textual
delegation promotes that worker through the same skill-and-guidance rule.
Each model request receives current guidance when the Project is enabled,
including after compaction. Disabled Projects add no context; enabling one
takes effect on a subsequent request in the same Agent Session.
OpenCode has no locally proven exactly-once continuation after `session.idle`,
so `notifai ask` fails closed instead of accepting an answer into a void.
Use a blocking `notifai send --reply` question when its answer must return to
the agent without another human prompt.
