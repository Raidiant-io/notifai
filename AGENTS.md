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

## Gates — run before every commit

```sh
pnpm check:boundary:self-test # prove boundary canaries still fail
pnpm check:boundary   # structural allowlist + forbidden-content scan
pnpm build            # protocol first — the CLI resolves its built exports
pnpm -r test          # unit tests; no Docker, no network
pnpm lint && pnpm -r typecheck
pnpm check:commit     # commitlint on HEAD
pnpm check:release    # packed files, metadata, docs, licenses, CLI version
pnpm check:packed     # isolated registry-shaped install of the packed CLI; needs registry access
```

CI runs checksum-pinned gitleaks against the current tree and the complete
changed commit range, after proving redacted detection with ephemeral positive
controls. The scheduled and manual Provider posture workflow scans full Git
history weekly. Local `pnpm check:secrets` retains the full tree/history form.

If a change needs a new top-level entry, workspace package, or file kind,
extend the allowlist in `scripts/check-boundary.mjs` in the same commit and
justify it in the commit message. When in doubt, it stays private.

## Releasing is not yours to decide

This repository is published, and `@raidiant/notifai` and
`@raidiant/notifai-protocol` are on npm as of 2026-08-05. That does not
make the next release routine.

Do not merge a release-please PR, do not `npm publish`, and do not create
tags, without the maintainer asking for a release in that instance. A
version, once published, cannot be taken back. Git pushes of ordinary
commits are fine. The machine is documented in `docs/RELEASING.md`.

The skill's human-readable release source (`SKILLS_SOURCE`) is derived at
runtime from the package version in `apps/cli/src/release.ts`. Installation
does not trust that tag: the npm package carries the complete reviewed skill
and its digest manifest; the CLI verifies and stages that package-bound copy at
a short-lived project-relative path for the pinned external installer. It then
deletes the staging copy and hashes the conventional installed directory for
readiness. Do not reintroduce a literal source, omit the packaged bundle, or
trust mutable lock-file source/ref metadata; `check:release` fails on bundle
drift.

## Publishing must verify what actually shipped

`dist/` is generated and ignored, so nothing in Git records what a publish
sent. `prepack` rebuilds before packing and every build starts by clearing
`dist/`, which together make the packed tree a pure function of the source in
whatever directory publishing runs from. `check:release` then proves the
repository `src/` and packed `dist/` correspond module for module without
shipping source or test files.

Before publishing, `pnpm check:packed` installs the packed tarballs in an
isolated directory outside the workspace, registry-shaped, and runs the
installed bin. Workspace linking always resolves the protocol sitting next to
the CLI, so it is the only pre-publish gate that can catch the packed manifest
pinning any other protocol version — a defect every workspace-bound gate
passes and every clean user install crashes on.

After publishing, run `pnpm check:published`. It downloads the tarball npm is
serving and compares it against the local checkout: the compiled files byte
for byte, and the manifest metadata installs resolve from (dependencies, bin,
exports, engines). Pre-publish gates can only ever vouch for the tree they ran
in; this is the only check that vouches for the artifact users install. A
release is not done until it passes.

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
- `docs/RELEASING.md` — SemVer, Conventional Commits, commitlint, release-please.

`CLAUDE.md` is a symlink to this file; keep them one document.
