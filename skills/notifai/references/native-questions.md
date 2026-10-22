# Native questions linked to Notifai

When your tools include Codex's `request_user_input_async`, the card is the
question: call it with the User's questions. Its hooks register the actual
structured input on the User's devices, including a multi-question card, and
return the question IDs and acknowledgement command in the tool context. No
copy or marker is needed. Without that tool, use `notifai ask`.

When the card cannot receive a device answer, its pre-tool hook registers an
ordinary question and prevents the card from appearing. Restate the printed
question and choices in plain conversation text and continue independent work.
An answer in the conversation uses the printed `notifai close` command: it
retires the device question without recording a native answer. A Project the
User disabled, a signed-out Machine, question notifications off, unsupported
shapes, and subagent cards stay terminal-only and are left untouched.

Native forms are optional; Question Routing still works without them. New linking requires
local eligibility, confirmed service support and, for Codex, a connection to
the session's app-server. Capability absence leaves the ordinary conversation
and app-answer flow available; follow `native_question_unavailable` when `ask`
returns it.

## Before emitting the form

On a Codex host without the card hook, `ask` may return `native_question`.
Only for that fallback, and only when your tools include the returned tool, use
it with the returned titles and options exactly, in the registration turn. The short title marker identifies a registered question;
wording alone does not. Preserve unrelated native forms, even when they
contain identical wording.

An unsupported form or missing binding stays ordinary.

## When the answer arrives

A terminal answer needs nothing from you: Notifai records it, so the devices
stop asking. An answer from the User's devices arrives in the card with its
own `notifai acknowledge req_…` command; run it before dependent work. If the
User answers in the conversation instead of a linked form, run the
`notifai close` command `ask` printed: it retires the device question.

Nothing you run reports a terminal answer, and nothing proves a native form
closed: native settlement depends on the harness capabilities and exact
binding. Describe only the result Notifai's own context confirms.
