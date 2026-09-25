# Notes and edits

While this session runs, the User can send into it from their device:

- a **note**: steering, context, a correction, or a nudge for the work in
  progress. No question preceded it.
- an **edited answer**: a change to an answer you already received. It
  replaces the earlier answer and is their current word.

Each arrives as a turn beginning `Notifai —` that names a Session Message
(`sm_…`). The User's words are one quoted value; the command stands outside it.

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
