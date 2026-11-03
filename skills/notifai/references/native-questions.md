# Native questions linked to Notifai

Read [Codex questions](harness-codex.md#questions) for cards, or
[Claude Code questions](harness-claude-code.md#questions) for pickers.

Older installs may return `native_question`. Only when your tools include its
tool, open its exact titles and options unchanged in the registration turn.
Keep any returned title marker intact. Current installs return `open_form`
where a form can link, and an ordinary question elsewhere.

A terminal answer needs nothing from you: Notifai records it. A device answer
carries its own acknowledgement command; run it before dependent work. If the
User answers another way (in the conversation, elsewhere, or by doing it) or
the question stops being relevant (its work is done, superseded or cancelled,
or a newer question replaces it), close it with the printed `notifai close`
command. Follow a card denial's registered plain question without registering
it again.
