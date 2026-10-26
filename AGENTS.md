# Agent Instructions

This repository is the public client surface of Notifai: the `notifai` CLI
(`apps/cli`), the client-visible wire contract (`packages/protocol`), and the
agent guidance skill (`skills/notifai`). The service, companion apps, and
their operations live in a private repository. These instructions apply
whether you are working in a standalone clone or inside a private root that
mounts this repository as a submodule.

## The boundary is the security posture

Read `docs/BOUNDARY.md` before adding anything. The service must remain
secure when everything in this repository is fully known. Nothing
server-side, no deployment or infrastructure configuration, no signing
material, no credentials, and no private identifiers may enter this tree —
regardless of how harmless they look. Public code never imports private
packages; when a change seems to need one, the client-visible part belongs
in `packages/protocol` and the rest stays private.

Write commit messages for a public audience: no internal issue-tracker IDs,
decision-log references, or private project names. Use Conventional Commits
1.0.0. `pnpm check:commit` is commitlint (`@commitlint/config-conventional`).
The `commit-msg` hook runs it.

Authored GitHub PR Markdown goes through a UTF-8 file passed as
`gh pr create --body-file` or `gh pr edit --body-file`, then a read-back of
the stored body. The rule lives in `docs/RELEASING.md`. That is not the CLI
`--body` / `--body-file` Notification Request transport.

## Gates during ordinary work

Run the boundary and machine-path checks for every change:

```sh
pnpm check:boundary   # structural allowlist + forbidden-content scan
pnpm check:machine-paths # reject this machine's home path in files or history
```

For feature work, including a final feature candidate or PR, build,
typecheck, lint, and test only changed packages and affected consumers. Select
related Vitest files or methods; the CLI test wrapper forwards selectors, for
example `pnpm --filter @raidiant/notifai test -- src/trust-policy.test.ts`.
Run the boundary self-test when its scanner or allowlist changes. Commitlint
runs in the commit hook; `pnpm check:commit` checks the resulting HEAD when
needed. Keep the protected pre-push security scans below.

Complete `pnpm -r test`, `pnpm check:release`, `pnpm check:packed`, and other
whole-repository test suites are release-candidate gates, not ordinary commit
or PR gates. Run them for an actual release or the maintainer's explicit
full-suite request. The exact-SHA release workflow still owns its full gates.

GitHub-hosted CI is release evidence, not the development feedback loop. It
runs only when the maintainer dispatches a workflow at an exact SHA, and scans that candidate's current tree and full Git history after proving
redacted detection with ephemeral positive controls. Routine commits, pull
requests, and pushes do not start hosted workflows. The one clock is the daily
Codex card canary (`.github/workflows/codex-card-canary.yml`): it watches the
newest published Codex, an external dependency, rather than re-checking this
tree; `docs/CODEX-CARD-CANARY.md` owns what it proves. The hub runs a similar
local check of Codex's shared server, described in
`docs/CODEX-ATTACH-CANARY.md`. Local
`pnpm check:secrets` retains the same tree/history evidence for ordinary work.

Before pushing to the public `origin`, use the repository-owned `pre-push`
hook in `scripts/githooks`. It requires a clean checkout at the exact pushed
commit and runs the agent guidance review check, boundary self-test, boundary
scan, secret controls plus tree/history scans, and machine-path scan. A missing scanner blocks the push.
Set `core.hooksPath` to `scripts/githooks` in a standalone clone; the private
root bootstrap installs it in the canonical public clone. The hook is a local
gate, so review the public PR diff and its authored text before merge too.

If a change needs a new top-level entry, workspace package, or file kind,
extend the allowlist in `scripts/check-boundary.mjs` in the same commit and
justify it in the commit message. When in doubt, it stays private.

## Releasing is not yours to decide

This repository is published, and `@raidiant/notifai` and
`@raidiant/notifai-protocol` are on npm. That does not make the next release
routine.

Before choosing a channel, dispatching release automation, merging a Release
PR, or publishing, read `docs/RELEASING.md`: it owns the beta-first default,
the maintainer's immediate beta/public path, and the evidence for promotion.
Authorization must cover the release scope and channel. A version, once
published, cannot be taken back. Git pushes of ordinary commits are fine.

The CLI carries the complete reviewed skill and its digest manifest. Its
built-in installer verifies that bundle before writing. Every `notifai`
directory in a harness's skill location is Notifai's: refresh rewrites any copy
whose bytes differ from the bundle, and never touches other skills. The policy
is in `docs/TRUST.md`. No external skill manager is part of the runtime
installation path.

## Publishing must verify what actually shipped

`dist/` is generated and ignored, so nothing in Git records what a publish
sent. `prepack` rebuilds before packing and every build starts by clearing
`dist/`, which together make the packed tree a pure function of the source.
`check:release` then proves the repository `src/` and packed `dist/`
correspond module for module without shipping source or test files.

The npm `@raidiant/notifai` package is a bundled launcher with no
dependencies; it installs the signed native runtime. `pnpm check:packed`
installs the packed tarballs in an isolated directory outside the workspace
and checks the launcher route and the native product's bundled skill.

When the native skills adapter, placement logic, or packaged skill bundle
changes, run `pnpm check:packed-skill-smoke`. It proves placement from the
packed production adapter with an empty PATH, preserves user edits, and checks
owned update integration.

`publish.yml` verifies what it published: it downloads the tarball npm is
serving and compares it with the candidate (`scripts/verify-published.mjs`),
then installs it fresh on six targets. Pre-publish gates only vouch for the
tree they ran in; this is the check that vouches for the artifact users
install. Report the verified channel and any remaining validation, promotion
or communication work explicitly.

## npm credentials

No npm token, in any form, may ever appear in this repository: not in
`.npmrc`, not in `.env` files, not in scripts, docs, tests, or commit
messages. Agents never ask for, echo, or store a token, and never run
`npm login`, `npm adduser`, `npm token`, or credential-writing
`npm config set`. When the maintainer publishes, auth lives in their
user-level npm credential store or a run-time environment variable, and CI
uses OIDC trusted publishing or a workflow secret — never anything in-tree.

## Layout

- `apps/cli` — the `notifai` CLI: commands, harness hook adapters,
  config/credential-store handling, unit tests.
- `packages/protocol` — request/response schemas, status vocabulary,
  capability documents, offline draft validation.
- `skills/notifai` — the agent skill: when to notify, how to write for a
  lock-screen banner.
- `docs/BOUNDARY.md` — the boundary policy the gates enforce.
- `docs/RELEASING.md` — the CLI and protocol release procedure.
- `docs/STANDALONE.md` — building, installing and updating the native CLI.

`CLAUDE.md` is a symlink to this file; keep them one document.
