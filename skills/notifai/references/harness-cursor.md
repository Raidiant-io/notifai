# Cursor

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**Cursor:** start one fresh conversation, send one prompt, and let the first
completed or errored turn finish. Cursor's `SessionStart` context is currently
lossy, so one visible synthetic follow-up activates Notifai through its native
Stop contract; cancellation does not trigger it, and a live question
continuation takes priority. Then run `notifai doctor`. The agent shell does
not create a separately activated context for delegated work: it remains
under the parent Agent Session and its explicit Notification Request ownership. It
does not expose the exact conversation id needed to prove which concurrent Agent Session
invoked `notifai ask`, so asynchronous ask fails closed. Use blocking
`notifai send --reply` for questions.
