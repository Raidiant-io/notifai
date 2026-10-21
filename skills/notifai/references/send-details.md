# Sending: the less common controls

A closed choice carries its own consequence. When its label alone does not
say what choosing it does, put `--choice-description "<one line, at most 160
characters>"` right after that `--choice`; Companion Apps show it on the
choice, so never restate the choices in the Body. Name the answer you
recommend, if any, with `--recommended "<exact label>"`. In an `ask --form`
document a choice is a label or
`{"label": "...", "description": "...", "recommended": true}`.

```bash
notifai ask "Deploy migration 0007 to production now?" \
  --choice "Deploy now" --choice-description "About two minutes of downtime." \
  --choice "Wait for off-peak" --choice-description "Deploys at 02:00 UTC, no downtime." \
  --recommended "Wait for off-peak"
```

Write a long Body to a file and pass `--body-file <path>`. Call `notifai` by
name as a plain argument list: a heredoc, pipe, redirection or `$()` around it
stops harness command approval from matching, so the command waits for a
terminal.

`--thread-id` groups; `--collapse-key` replaces your earlier matching
notification; `--ttl` bounds useful delivery. Use
`notifai capabilities --platform <platform>` for destination contracts.

Repeat `--image <path|url>` (up to 8), paired with `--image-alt`; all reach the
gallery. Reference any or all in Body with Markdown image syntax:
`- Bob: ![front](media:1) ![side](media:2)`. Bare `media:1`, `[…](media:1)`,
or a position with no `--image` is an error.

`--sound`, `--level`, and `--device` belong to the User: never choose them
yourself. `--sound` takes a shipped name or a custom name/id from
`notifai sounds`.
