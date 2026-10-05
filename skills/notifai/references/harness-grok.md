# Grok

Read with [Harness setup and recovery](harness-setup.md), which holds what every
harness shares.

## Activation

**Grok:** `notifai hooks install --harness grok` writes only the Notifai-owned
Machine hook file under `~/.grok/hooks/` (or `GROK_HOME/hooks/`). Start a fresh
Grok Agent Session and send one prompt to observe lifecycle state. Grok
discards SessionStart and allowed UserPromptSubmit output, so these hooks do
not activate model-visible guidance; load the Notifai skill from
`~/.agents/skills` directly. `GROK_SESSION_ID` supplies exact Source Context
in an uncontested tool subprocess. Grok's Stop hook holds the complete answer
window, then returns a decision block to continue this same Agent Session;
its successor Stop confirms consumption. Grok has no Session Attendant,
Session Notes, or post-consumption Answer Edits.

## How the answer gets back

**Grok:** the Stop hook stays held through the complete answer window and
returns the answer as a decision block to the same Agent Session. Its native
`stopHookActive` flag on the successor Stop confirms consumption. There is no
out-of-band wake route or Session Attendant.
