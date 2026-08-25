/**
 * The shipped notification-writing guidance: what agents follow when the user
 * has not said otherwise.
 *
 * Each topic is a small Markdown document named for the moment an agent
 * consults it. Users override a topic by placing a file with the same name in
 * a guidance directory — resolution and layering live in `guidance.ts`, and
 * the topics ship here as source rather than as packaged files so the packed
 * CLI cannot lose them.
 *
 * The governing principle, stated once: the user hired the outcome, not the
 * pipeline. Tests, coverage, review passes, hashes and exit codes are how the
 * work got done; a notification carries what the work means — what is now
 * finished, what went wrong, what needs them. A detail earns its place only
 * when it changes what the user does next.
 */

export interface GuidanceTopic {
  /** Topic name; also the override filename, `<name>.md`. */
  name: string
  /** One line for lists and JSON output. */
  summary: string
  /** The Markdown the agent reads. */
  content: string
}

const WHEN_TO_NOTIFY = `# When to notify

Notify when something changed for the user:

- Substantial autonomous work finished — succeeded or failed. Work is
  substantial when it required multiple meaningful investigation, editing,
  build, test, deployment, or coordination steps.
- Work cannot proceed: ask an answerable question when continuing needs a User
  response; send a one-way blocked notification only when no User reply would
  resume the work.
- You found something that needs their attention soon.

Never notify for:

- Routine progress: starting, still working, one more subtask done.
- A problem you hit and fixed yourself.

Completion of substantial work is an outcome, not routine progress.
A requested audit or diagnosis that resolves the user's uncertainty through
several distinct checks counts as substantial even when the result is clean
and needs no further action.

One notification per event. When a status changes, replace your stale
notification rather than stacking a new one.
`

const TITLES = `# Titles

The user hired the outcome, not the pipeline. A title says what the work means
to them — what is now finished, what went wrong, what needs them — in about 40
characters, understandable alone. Never put the kind or the project in it;
both travel as their own fields.

Good:

- \`Users can now create accounts\` — the capability, not the process behind it
- \`Password reset emails aren't sending\` — the failure as the user experiences it
- \`Refund rollout awaits provider recovery\` — what is stuck, not machinery
- \`Found why checkout was flaky\` — the finding they were waiting on
- \`3 orders didn't import and need review\` — a count that earns its place
  because acting on it is theirs to do

Bad:

- \`All 42 tests passed\` — machinery; say what work is done
- \`Adversarial review found 3 issues\` — process report; say what it means for
  what ships
- \`Migration 0007 failed\` — internal identifier; say what the user lost
- \`Task complete\` / \`Build failed\` / \`Need input\` — no substance, and the
  kind restated
- \`Exit code 1\` — mechanics, not meaning
`

const BODIES = `# Bodies

The first sentence is what the lock screen shows — make it say what this means
for the user. The rest is what changes for them and what is needed from them,
never how many tests ran, how long a step took, or which internal stage
produced it. Keep wording channel-neutral: no device names, no gestures.

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

Bad bodies: a build report (\`42/42 green, coverage 87%, rebased onto main\`)
where the news is "users can now create accounts"; the journey ("first I
tried…") instead of the result; a log with the conclusion at the bottom; "see
terminal for details".

Add a summary line only when the body is long enough that its first line is
not a fair summary of what is inside: one short line answering what the title
raises, such as \`Rolled back cleanly; production is untouched\` over a long
failure report.
`

const QUESTIONS = `# Questions

When work needs a User response before it can continue, ask an answerable
question. A one-way blocked Notification Request is only for work that no User
reply would resume. If the User must act and then tell you it is ready, that
readiness is an answer — ask for it.

A question is answerable from the notification alone, in the user's terms, not
the machinery's. One askable sentence; reasoning and stakes follow as context.
Offer closed choices whose wording carries its own consequence.

Good:

- \`The schema change is ready. It touches live order data — deploy now or
  wait for off-peak?\` with choices \`Deploy now\` / \`Wait for off-peak\`
- \`The API key in .env.example is live. Revoke it now, or wait until the
  replacement is provisioned?\` with \`Revoke now\` / \`Wait for the new key\`
- \`Is the test device unlocked and ready for the install?\` with
  \`Ready — install now\` / \`Not yet — wait\`

Bad:

- \`What should I do?\` — nothing to answer without the terminal
- \`Deploy to staging and notify the team?\` with \`Yes\` / \`No\` — two
  decisions, one answer
- \`Retry with --force-with-lease?\` — machinery; the real decision is
  \`Overwrite the remote branch, or keep both versions?\`
- Choices \`Option A\` / \`Option B\` — labels that point back into the body
- \`Reply here with your choice\` — never name where the answer must arrive
`

const ACKNOWLEDGEMENTS = `# Acknowledgements

An acknowledgement names the concrete work the reply sets in motion — only
work you will actually do, and nothing generic.

Good:

- \`Rolling out to staging now; I'll report the health checks.\`
- \`Holding the deploy. I'll re-raise it once staging is green.\`
- \`Shipping the fix; I'll confirm when password reset works again.\`

Bad:

- \`Acknowledged.\` / \`Got it!\` — a receipt that shows nothing was understood
- \`You chose "Deploy now".\` — echoes the reply instead of naming the work
- \`Deploying now, and I'll also refactor the retry logic.\` — promises work
  the reply did not cause
`

/**
 * Topic order is reading order: decide first, then each thing an agent writes,
 * in the order it writes them.
 */
export const SHIPPED_GUIDANCE: readonly GuidanceTopic[] = [
  {
    name: 'when-to-notify',
    summary: 'What is worth a notification at all',
    content: WHEN_TO_NOTIFY,
  },
  {
    name: 'titles',
    summary: 'What a title carries, with examples',
    content: TITLES,
  },
  {
    name: 'bodies',
    summary: 'What a body and its summary line carry, with examples',
    content: BODIES,
  },
  {
    name: 'questions',
    summary: 'How a question and its choices are worded',
    content: QUESTIONS,
  },
  {
    name: 'acknowledgements',
    summary: 'How an acknowledgement is worded',
    content: ACKNOWLEDGEMENTS,
  },
]

export function shippedGuidanceTopic(name: string): GuidanceTopic | undefined {
  return SHIPPED_GUIDANCE.find((topic) => topic.name === name)
}
