# Native questions linked to Notifai

Codex's card is the question: call `request_user_input_async` with the User's
questions. Its hooks register the actual structured input on the User's
devices, including a multi-question card, and return the question IDs and
acknowledgement command in the tool context. No copy or marker is needed.

When the card cannot receive a device answer, its pre-tool hook registers an
ordinary question and prevents the card from appearing. Restate the printed
question and choices in plain conversation text and continue independent work.
An answer in the conversation uses the printed `notifai close` command: it
retires the device question without recording a native answer. A Project that
is not enabled, a signed-out Machine, disabled routing, unsupported shapes,
and subagent cards stay terminal-only and are left untouched.

Native forms are optional; Question Routing still works without them. New linking requires
local eligibility, confirmed service support and, for Codex, a connection to
the session's app-server. Capability absence leaves the ordinary conversation
and app-answer flow available; follow `native_question_unavailable` when `ask`
returns it.

## Before emitting the form

Claude Code never returns `native_question`: its picker is the question
itself. Read [the Claude Code file](harness-claude-code.md#question-picker).

On a Codex host without the card hook, `ask` may return `native_question`.
Only for that fallback, use the returned tool, titles and options exactly, in the
registration turn. The short title marker identifies a registered question;
wording alone does not. Preserve unrelated native forms, even when they
contain identical wording.

Keep the returned question and choice IDs for reporting its answer. An
unsupported form or missing binding stays ordinary.

## When the native answer arrives

Read the actual native answer. As the first command before work depending on
that answer, run the `notifai acknowledge q_…` command printed by `ask`, filling
in the actual answer IDs or typed text and an authored acknowledgement naming
the concrete work it causes. Report partial answers as partial: only include
questions the User answered. An app answer relayed through a native envelope
keeps its printed app acknowledgement command; do not report it as a new
native submission.

`--native-answers` accepts an array: a choice answer looks like
`[{"question_id":"q1","choice_ids":["staging"]}]`; a typed answer looks like
`[{"question_id":"q1","text":"Wait until tomorrow"}]`. Substitute the actual
returned question/choice IDs and the User's actual words.

Choose a distinct operation ID for each distinct native submission. Retrying
the same submission uses the same operation ID, answers and acknowledgement.
An identity-only retry is valid only after the command confirms it saved the
operation. Follow its recovery output when submission or acknowledgement is
unconfirmed; keep the original question instead of registering another one.

Success confirms that the native answer and authored acknowledgement were
recorded. Review `other_submissions` before acting. Preserve distinct app and
native answers; a conflict needs clarification before further dependent work.
An already acknowledged operation must not repeat work it previously caused.

Keep the original app answer watcher after native acknowledgement: a reply may
already be in flight, and the User can still answer within its original window.
Use `close` for explicit withdrawal, not as native-answer acknowledgement.
If no linked form asked it, an ordinary conversation answer still uses the
unlinked question's `close` flow.

Reporting an answer does not prove a native form closed. Native settlement
depends on the harness capabilities and exact binding; missing or uncertain
control must leave unrelated forms untouched. Describe only the result the
command actually confirms.
