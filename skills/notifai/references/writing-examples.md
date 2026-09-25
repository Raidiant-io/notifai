# Writing examples

Examples for the shipped `titles`, `content`, and `acknowledgements` guidance.
The effective guidance printed by `notifai guidance` always wins over them.

## Titles

Good:

- `Users can now create accounts` — the capability, not the process behind it
- `Password reset emails aren't sending` — the failure as the user experiences it
- `Refund rollout awaits provider recovery` — what is stuck, not machinery
- `Found why checkout was flaky` — the finding they were waiting on
- `3 orders didn't import and need review` — a count that earns its place
  because acting on it is theirs to do

Bad:

- `All 42 tests passed` — machinery; say what work is done
- `Adversarial review found 3 issues` — process report; say what it means for
  what ships
- `Migration 0007 failed` — internal identifier; say what the user lost
- `Task complete` / `Build failed` / `Need input` — no substance, and the
  kind restated
- `Exit code 1` — mechanics, not meaning

## Content

Work finished:

> Account creation works end to end now: sign-up, email verification, and
> login are live on staging.
>
> Next I'll start on password reset unless you want something else first.

Work failed:

> The new pricing page isn't live. The deploy failed and I rolled it back, so
> the site still shows the old page — nothing is broken for users.
>
> The blocker is on my side and I'm fixing it; I'll retry and confirm when the
> page is up. Nothing needed from you.

Blocked:

> The refund flow is built, but the production rollout is waiting for the
> payment provider to recover. I am monitoring it and will resume automatically.
>
> There is nothing for you to answer; I will confirm when it is live.

## Acknowledgements

- A note: `Switching the migration to staging; I'll rerun it there.`
- An edit after irreversible work: `The email already went out with Monday;
  sending a correction for Friday now.` — say what already happened; never
  imply it was undone.
