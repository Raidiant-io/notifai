# OpenCode

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

Restart OpenCode after installation, because plugins load at startup. Then
start one fresh Agent Session, send one prompt, and run `notifai doctor`.
Notifai owns its generated plugin file and will not overwrite a foreign one.

A session with a parent is a worker: it reports to its parent and does not
notify. When the plugin cannot tell, it treats the session as a worker. A
worker explicitly delegated Notification Requests in its prompt loads the skill
and guidance as their owner.

In an enabled Project every model request carries the guidance resolved at the
latest User prompt, including after compaction. A disabled Project adds no
context; enabling one takes effect from the next User prompt in the same Agent
Session.

Nothing can yet bring an answer back once an OpenCode session goes idle, so
`notifai ask` fails closed. Ask in a way that waits: OpenCode's own `question`
tool, or a blocking `notifai send --reply` question when it needs a Body or
images.

## Question form

OpenCode's own `question` tool reaches the User's devices by itself; never
also register it with `notifai ask` or `send --reply`, or the User is asked
twice. The form keeps
your turn open and takes whichever answer comes first:

- **A device answer** is the form's own result. The next system context names
  `notifai acknowledge req_…`; run it before the work the answer causes.
- **An answer in OpenCode** needs nothing from you. Notifai records it, so the
  devices stop asking.
- **A form dismissed in OpenCode** withdraws the device question: continue in
  the conversation.

Closing OpenCode or deleting the session withdraws the device question; a
later device answer reaches nobody. A form on a signed-out machine, with
question notifications off, in a project the User disabled, or in a shape the
devices cannot show stays in OpenCode only and still works there.

## After a Notifai update

The loaded plugin calls the updated CLI on each event and reads guidance once
per User prompt. Changed plugin code loads only at startup: arrange a restart
only when the update's diagnosis says that scope still needs one, then confirm
a natural callback.
