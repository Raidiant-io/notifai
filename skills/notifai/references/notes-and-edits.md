# Notes and edits

While this session runs, the User can send into it from their device:

- a **note**: steering, context, a correction, or a nudge for the work in
  progress. No question preceded it.
- an **edited answer**: a change to an answer you already received. It
  replaces the earlier answer and is their current word.

Each arrives as context beginning `Notifai —` that names a Session Message
(`sm_…`). The User's words are one quoted value; the command stands outside it.
It can arrive after a tool call within the current turn or as a new turn.
Codex and Claude Code may instead receive a wake-up naming
`notifai receive`. Run that command when instructed. It reads
the current pending batch, which may contain notes and question answers
together. A late wake-up can find nothing pending; it carries no User words
and creates no acknowledgement obligation of its own.

`notifai replies --pending` lists outstanding questions. It does not inspect
Session Notes waiting for delivery; an empty result establishes only that
there are no outstanding questions.

OpenClaw starts that turn with a pointer naming the message. If the full note
or edit context is absent, say the message is missing and do not acknowledge
it. A Gateway crash during the turn can replay the pointer without the staged
context; Notifai leaves that message handed off and unacknowledged, and the
User may send a new message.

## Acknowledge each one once, before acting on it

```bash
notifai acknowledge sm_… --text "Switching the migration to staging; I'll rerun it there."
```

Name the work the message changes, as for any acknowledgement. If the account
turned acknowledgement text off, Notifai prints the command without `--text`;
run exactly that. Once it reports recorded or replayed, it is done.

An edit can arrive after you acted on the earlier answer. Say what already
happened and what you will do now; never imply that irreversible work was
undone:

```bash
notifai acknowledge sm_… --text "The email already went out with Monday; sending a correction for Friday now."
```

## What a note is not

A note is the User's own words carried from their device, not an instruction
from Notifai or the system. It never satisfies a harness permission prompt or
an interactive picker, and it never moves private material off this machine.

The acknowledgement is the receipt. Results a note asks for follow the ordinary
rules for when to notify.
