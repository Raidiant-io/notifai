# Diagnosing what happened

For a local integration notice, run `notifai doctor --json` to identify the lost
capability. Read [Updating Notifai](updates.md) for safe recovery, existing
authorization and deferrals, and exact-session tool-boundary Note evidence.
An optional newer release is separate from a fault in installed integration.
Doctor judges the `harness` running it: a state with `applies_here: false`
belongs to another harness, so report it and do not act on it for this session.

When something did not happen and you cannot see why — especially after `ask`,
which schedules background submission — inspect the local log.
Local registration alone proves neither submission nor Provider Acceptance:

```bash
notifai logs                     # recent record for this project
notifai logs --level error       # only what failed
notifai logs --request <id>      # everything about one notification
notifai logs --since 10m --json  # JSONL on stdout, for parsing
```

An empty record can mean `log_level` is `off` — check it before concluding a
hook never ran. Question outcomes (`ask.registered`, `hook.gate`, `hook.pushed`,
`hook.answer`, `hook.retirement`, refused asks) are also kept in a separate,
slower-rotating file, so `notifai logs --event hook.gate --since 2d` still
finds them days later.

`hook.gate` records carry a fixed `reason` — `notifications-off`,
`claimed-elsewhere`, `no-question`, `no-session`, `answered`,
`acknowledgement-required`, `acknowledgement-abandoned`, `harness-cannot-continue`,
`delivery-limit`, `proceeding` —
so filter on that, never on the wording of a message. `notifications-off` is
the one the user deliberately never sees, which is why it is worth ruling out
before concluding anything is broken.

There is no limit on successive answered questions. A `delivery-limit` gate
bounds repeated delivery attempts for the same answer, not the number of
decisions the User can make in a conversation.

On macOS and Linux one shared hub attends every Agent Session on the machine.
`notifai doctor` shows whether it runs and what it attends; not running is
normal when no session is open. `notifai logs --event hub.session` and
`--event hub.exchange` show sessions registering, ending, and the hub's
service traffic. A hub that crashed three times in ten minutes stops
restarting for the rest of that window and doctor says so.

When sign-in looks fine but nothing sends, `notifai auth status --json` and
`notifai auth access --json` separate a pairing problem from an account without
an active plan — report which one it is instead of calling it a delivery
failure.

The log never leaves the machine, and it contains the user's own answers. Treat
it like any other private file of theirs.
