# Agent Guidance review

Run `pnpm check:agent-guidance` before builds and unit tests. A stale record
fails closed and reports behavior input paths changed since the commit that
last changed the review record. A missing Git baseline is reported explicitly;
inspect all input roots in that case. Test files and generated README release
version values do not affect the review digest.

Review lifecycle hooks, the Notifai skill, harness setup, CLI readiness, and
domain terms against the changed behavior. Refresh any affected instruction
surfaces before recording the result. Then run:

```sh
node scripts/check-agent-guidance.mjs --print
```

Copy the printed digest to `behavior_digest` in `agent-guidance-review.json`.
Set `outcome` to `guidance-updated` or `reviewed-no-impact`, write a concrete
`reason`, and list all five surfaces in `surfaces_reviewed`. This is an explicit
review record; printing a digest does not approve it or edit the record.

Validate the refreshed record:

```sh
pnpm check:agent-guidance
```
