# OpenCode

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

This covers OpenCode 1, and OpenCode 2.1 and later. The two lines load
different plugins, so Notifai writes the one for the OpenCode it finds. After
switching between them, run `notifai hooks install --harness opencode`;
`notifai update` does it too. `notifai doctor` reports a plugin for the other
line, and OpenCode 2.0, which is unsupported: upgrade it.

## Activation

Restart OpenCode after installation, because plugins load at startup; on
OpenCode 2, `opencode service restart` restarts the background service its
terminals share. Then start one fresh Agent Session, send one prompt, and run
`notifai doctor`. Notifai owns its generated plugin file and will not
overwrite a foreign one.

A session with a parent is a worker: it reports to its parent and does not
notify. When the plugin cannot tell, it treats the session as a worker. A
worker explicitly delegated Notification Requests in its prompt loads the skill
and guidance as their owner.

In an enabled Project every model request carries the guidance resolved at the
latest User prompt, including after compaction. A disabled Project adds no
context; enabling one takes effect from the next User prompt in the same Agent
Session.

Nothing can yet bring an answer back once an OpenCode session goes idle, so
ask in a way that waits; `notifai doctor` reports that as an OpenCode limit,
not a fault to repair. To wait, run `notifai ask --wait`: it hands back the
`question` form with your title, Body and images; open it unchanged. In a
worker, or with a plugin that cannot prove a root session or hand back the
form, or with `--projectless` in a Project that is not disabled or outside a
Project, it waits in the command instead, for at most
110 seconds, then withdraws
an unanswered question (exit 3). Keep the command running until it returns.
The OpenCode 1 form carries free text and up to 10 questions. Notifai accepts
at most one recommended choice per question; its label ends in
`(Recommended)`. Several recommendations within one question are refused by
Notifai's protocol before any form opens; offer one recommendation instead.

Session Notes and Answer Edits are not supported yet.

## Question form

A `question` form you open yourself reaches the User's devices by itself;
never also register it with `notifai ask`, or the User is asked twice. The
form keeps your turn open and takes whichever answer comes first:

- **A device answer** is the form's own result. The next system context names
  `notifai acknowledge req_…`; run it before the work the answer causes.
- **An answer in OpenCode** needs nothing from you. Notifai records it, so the
  devices stop asking.
- **A form dismissed in OpenCode** withdraws the device question: continue in
  the conversation.
- **A question that expired on the devices** closes the form unanswered, with
  Notifai context that says so: carry on without it.

Closing OpenCode or deleting the session withdraws the device question; a
later device answer reaches nobody. A form on a signed-out machine, with
question notifications off, or in a project the User disabled stays in
OpenCode only and still works there.

## After a Notifai update

The loaded plugin calls the updated CLI on each event and reads guidance once
per User prompt. OpenCode 1 loads changed plugin code only at startup, and
OpenCode 2 when the file changes: arrange a restart only when the update's
diagnosis says that scope still needs one, then confirm a natural callback.
