# Contributing

Contributions are welcome. There is no CLA and no DCO — open a pull
request and that is the whole process. By contributing you agree your
work is licensed under Apache-2.0, the same as the rest of the
repository.

## What lives here

This repository is the **client surface** of Notifai: the `notifai` CLI,
the wire contract it speaks, and the agent skill. The service and the
Companion Apps are developed separately and are not part of this tree.

- **`apps/cli`** — the `notifai` command-line tool (`@raidiant/notifai`),
  its native launcher, and the npm launcher.
- **`packages/protocol`** — the client-visible wire contract
  (`@raidiant/notifai-protocol`): notification draft schemas, REST v1
  request/response types, the status vocabulary, and capability
  negotiation. The CLI validates drafts offline against the same bundled
  capability documents the service enforces.
- **`skills/notifai`** — the agent skill: when to notify, how to write
  notifications and questions, and how to set up and check each harness.

Everything the CLI exchanges with the Notifai service crosses the documented
`/api/v1` contract in `packages/protocol`; nothing in this repository depends
on private code.

That split is a security posture, not an accident, so it is the one
thing a pull request cannot negotiate. The service must stay secure when
everything here is fully known. Read [`docs/BOUNDARY.md`](docs/BOUNDARY.md)
before adding anything — it is enforced by a gate, and the gate is not
advisory.

## Getting set up

Requires Node >= 20.12 and pnpm. Release checks run on Node 24. The pre-push
hook also needs [gitleaks](https://github.com/gitleaks/gitleaks) on `PATH`.

```sh
pnpm install
pnpm build         # protocol first; the CLI resolves its built exports
git config core.hooksPath scripts/githooks
```

`pnpm build` produces the development CLI at `apps/cli/dist/main.js`. The
shipped product is a native build; see
[standalone CLI development](docs/STANDALONE.md) to build and check one.

## Before you open a pull request

Build, typecheck, lint and test the packages you changed and their consumers.
Run the related tests rather than the whole suite; the CLI test wrapper
forwards selectors:

```sh
pnpm check:boundary
pnpm build
pnpm --filter @raidiant/notifai test -- src/trust-policy.test.ts
pnpm lint && pnpm -r typecheck
```

Run `pnpm check:boundary:self-test` when you change the boundary scanner or
its allowlist. Changes to shipped agent guidance (the skill, hooks, setup
output, or the README, `docs/USAGE.md`, `docs/HARNESSES.md` and
`docs/TRUST.md`) need a refreshed review record: see
[`docs/AGENT-GUIDANCE-REVIEW.md`](docs/AGENT-GUIDANCE-REVIEW.md).

The complete suite (`pnpm -r test`, `pnpm check:release`, `pnpm check:packed`)
runs for releases. Pull requests don't start hosted CI; the maintainer runs
the release checks.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/),
public audience. Validated by commitlint with
`@commitlint/config-conventional`.

```
feat(cli): wake Claude sessions through the inbox socket
fix(protocol): reject an empty question set
```

With `core.hooksPath` set to `scripts/githooks`, the `commit-msg` hook runs
commitlint and the `pre-push` hook checks the boundary, secrets, machine paths
and the guidance review record before a push to `origin`. The pre-push hook
requires a clean checkout of the exact commit being pushed.

Use a Conventional Commit for the pull request title too. Pull requests are
squash-merged, so the title becomes the commit subject on `main` and the input
to release-please.

## What makes a change easy to accept

**Say why, not what.** The diff already shows what changed. Comments and
commit messages that explain the reasoning — especially the option you
rejected and why — are what survive being read in a year.

**Cover the failure, not the feature.** A test that demonstrates the bug
before the fix is worth more than three that exercise the happy path.

**A flag combination that parses but does nothing is a bug.** If an
option can be passed in a way that silently has no effect, make it a
usage error instead.

**Keep the CLI silent unless it has something to say.** It runs inside
agent harnesses where every line competes with the user's actual work.

## Reporting a security issue

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).
