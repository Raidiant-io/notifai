# Diagnosing what happened

For a local integration notice, run `notifai doctor --json` to identify the lost
capability. Read [Updating Notifai](updates.md) for safe recovery, existing
authorization and deferrals, and exact-session tool-boundary Note evidence.
An optional newer release is separate from a fault in installed integration.

When something did not happen and you cannot see why — especially after `ask`,
which starts background submission immediately — inspect the local log.
Local registration alone proves neither submission nor Provider Acceptance:

```bash
notifai logs                     # recent record for this project
notifai logs --level error       # only what failed
notifai logs --request <id>      # everything about one notification
notifai logs --since 10m --json  # JSONL on stdout, for parsing
```

An empty record can mean `log_level` is `off` — check it before concluding a
hook never ran.

`hook.gate` records carry a fixed `reason` — `notifications-off`,
`claimed-elsewhere`, `no-question`, `no-session`, `answered`,
`acknowledgement-required`, `acknowledgement-abandoned`, `harness-cannot-continue`,
`continuation-limit`, `delivery-limit`, `proceeding` —
so filter on that, never on the wording of a message. `notifications-off` is
the one the user deliberately never sees, which is why it is worth ruling out
before concluding anything is broken.

When sign-in looks fine but nothing sends, `notifai auth status --json` and
`notifai auth access --json` separate a pairing problem from an account without
an active plan — report which one it is instead of calling it a delivery
failure.

The log never leaves the machine, and it contains the user's own answers. Treat
it like any other private file of theirs.
