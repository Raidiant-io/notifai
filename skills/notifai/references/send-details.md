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

`ask --form-json '{…}'` asks up to 10 questions decided together, answered as one
reply. Its questions and choice labels must also fit one phone notification of
about 4 KB, which is usually no more than 8 short questions. `ask` refuses a
larger form before registering anything and says how to split it; the Body and
choice descriptions do not count. Quote inline JSON for your shell as the skill's Send section explains,
line breaks and all. `--form <path>` reads a JSON file, and `--form -` reads
stdin; paths are always paths, even when their names start with `{`.
When creating a form file, write it in the system temp directory, never the repository.

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
own decision. A choice is a label or
`{"label", "description"?, "recommended"?}`, a description being one
line of at most 160 characters; add `"multi": true` to a
question whose choices may combine. Mark at most one choice per question as
recommended.

## Reading command results

`send --json` returns the service receipt when submission succeeds; failures
are explained on stderr and do not promise a JSON error object. `ask --json`
refusals instead return an object on stdout with `ok: false`, `code`, and
`remedy`.

Exit 3 depends on the command: a held `ask --wait` ended unanswered and withdrew
the question; `replies` found no reply in this read or bounded wait without
withdrawing anything; legacy `send --reply` ended its wait without a reply.

`replies --pending --json` keeps its shipped result shapes: no pushed question
returns `session_id`, `pending` and an empty `replies`; one pushed question
returns a `reply_result`; several return an array of `reply_result` objects. Check the shape
before reading the replies. Exit 3 means this read found none, and does not
withdraw a question. `receive` hands back actionable context and has no JSON mode.
`close --pending --json` with nothing to retire exits 0 with
`state: "nothing_pending"`, empty `withdrawn` and `closed` arrays, and the
Agent Session id if one is known.
