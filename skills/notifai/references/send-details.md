# Sending and asking: the less common controls

`--thread-id` groups; `--collapse-key` replaces your earlier matching
notification; `--ttl` bounds useful delivery. Use
`notifai capabilities --platform <platform>` for destination contracts.

Repeat `--image <path|url>` (up to 8), paired with `--image-alt`; all reach the
gallery. Reference any or all in Body with Markdown image syntax:
`- Bob: ![front](media:1) ![side](media:2)`. Bare `media:1`, `[…](media:1)`,
or a position with no `--image` is an error.

`--sound`, `--level`, and `--device` belong to the User: pass one only when the
User asked for it on this send. `--sound` takes a shipped name or a custom
name/id from `notifai sounds`.

`ask --form <path>` asks up to 10 questions decided together, answered as one
reply. The file is JSON:

```json
{
  "title": "Release plan",
  "summary": "Two decisions before the release.",
  "body": "Optional standalone Markdown.",
  "questions": [
    { "title": "Ship day", "text": "Ship on Friday?", "choices": [
      "Yes",
      { "label": "No", "description": "Moves the release to Monday.", "recommended": true }
    ] },
    { "title": "Release notes", "text": "Anything to add to the notes?" }
  ]
}
```

With several questions, each takes a `"title"` of a word or two naming its
own decision; a terminal form shows it as that question's tab. A choice is a
label or `{"label", "description"?, "recommended"?}`, a description being one
line of at most 160 characters; add `"multi": true` to a
question whose choices may combine. Mark at most one choice per question as
recommended.
