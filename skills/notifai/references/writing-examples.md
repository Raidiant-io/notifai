# Writing examples

Worked examples for the shipped `titles` and `content` guidance; the guidance
printed by `notifai guidance` always wins over them. Each shows the Title, the
Summary a banner shows, and the Body the focused view shows instead of the
Summary, so the Body carries everything the Summary says, then the detail.

## Work finished

Title: `Users can now create accounts`

Summary: `Sign-up, email verification and login now work on staging.`

Body:

```markdown
Sign-up, email verification and login **now work on staging**.

- New accounts get a verification email within a minute.
- Unverified accounts can sign in, but can't post until they verify.

Next: password reset. Nothing needed from you.
```

## Work failed

Title: `New prices aren't live`

Summary: `The new prices didn't go live: the payment provider rejected the euro prices, so customers still see the old ones.`

Body:

```markdown
The new prices **didn't go live**, so customers still see the old ones.
Checkout works as before.

**Why:** your payment provider account doesn't accept euros yet, so it
rejected the euro prices. Only you can change that setting.

**To launch them:** turn on euros in the provider's *currency settings*,
then ask me to deploy the new prices again.
```

## A question with steps

Title: `Test phone readiness`

Summary: `Is the test phone connected and unlocked so I can install the new build?`

Choices: `Ready — install now` / `Not yet — wait`

Body:

```markdown
Is the test phone **connected and unlocked**, so I can install the new build?

Before you answer:

1. Connect it to this computer with a cable.
2. Unlock it and keep the screen on.
3. If it asks whether to trust this computer, choose *Trust*.
```

## Waiting on an outside change, Summary only

Title: `Refund rollout waits on the payment provider`

Summary: `Refunds are ready, but going live waits for the payment provider's outage to end; I'll finish and confirm then.`

A Summary that says everything needs no Body.

## Too long (bad)

Title: `PR #482 merged after CI`

Summary: `Merged PR #482 (feat/checkout-v2) after 214 tests passed in 6m12s and migration 0042 ran.`

Body:

```markdown
I started by profiling the checkout flow and found that the order summary
query was doing a sequential scan, so I added migration 0042 with a composite
index, rewrote the cart serializer, fixed two flaky tests in
checkout.spec.ts, reran CI three times (214 tests, 6m12s), opened PR #482,
addressed review comments and merged it into main.
```

It narrates the work and names a PR, a branch, a test file, a migration and a
test count the User never saw. What changed for them fits in one line:

Title: `Checkout is faster`

Summary: `Checkout pages now load in about half the time; nothing needed from you.`
