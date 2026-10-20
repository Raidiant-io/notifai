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
Each model request receives the guidance resolved at the latest User prompt
when the Project is enabled, including after compaction. Disabled Projects add no context; enabling one
takes effect from the next User prompt in the same Agent Session.
OpenCode has no locally proven exactly-once continuation after `session.idle`,
so `notifai ask` fails closed instead of accepting an answer into a void.
Use a blocking `notifai send --reply` question when its answer must return to
the agent without another human prompt.

## Question form

OpenCode's own `question` tool reaches the User's devices by itself in an
enabled Project; do not also register it with `notifai ask` or `send --reply`,
or the User is asked twice. The form keeps your turn open and takes whichever
answer comes first:

- **A device answer** is the form's own result. The next system context names
  `notifai acknowledge req_…`; run it before the work the answer causes.
- **An answer in OpenCode** needs nothing from you. Notifai records it, so the
  devices stop asking.
- **A dismissed form** withdraws the device question. Ask again if you still
  need the answer.

Closing OpenCode or deleting the session withdraws the device question; a
later device answer reaches nobody. A worker session's form, a Project that is
not enabled, a signed-out machine, routing turned off, or a form the devices
cannot show stays in OpenCode only and still works there.
