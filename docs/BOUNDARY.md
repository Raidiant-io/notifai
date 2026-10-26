# Public/private boundary policy

This repository contains only the Notifai client surface: the CLI and the
client-visible wire contract. The service implementation, companion apps,
and operations are private, and the boundary between the two is part of
this project's security posture: **the service must remain secure when
everything in this repository is fully known.**

## What belongs here

- `apps/cli` — CLI source, its native launcher (`apps/cli/launcher`), unit
  tests, hook adapters for agent harnesses, configuration and credential-store
  handling, and user-facing documentation.
- `apps/cli/npm` — the npm launcher. Its generated `dist/npm/notifai` package
  uses the existing `@raidiant/notifai` name, bundles only release verification
  and acquisition, and hands product commands to the native runtime. No npm
  lifecycle script runs.
- `packages/protocol` — client-visible request/response types and schemas
  for `/api/v1`, stable status vocabulary, capability documents and draft
  validation, and the small hashing helper shared with clients.
- `skills/notifai` — the agent skill.
- `distribution` — reviewed public redistribution materials for the native
  runtime, release material hashes, and the standalone Bun runtime entitlement
  profile. CLI signing workflows may reference protected CI secret names. They
  must never contain a certificate, private key, provisioning profile or
  credential.
- Public docs, fixtures, scripts, CI workflows, release configuration, and the
  boundary tooling itself.

`packages/protocol/src/apns.ts` and `packages/protocol/src/fcm.ts` model the
application-visible notification envelopes so offline validation can estimate
payload size against each provider limit. Their content is fully observable on
any device that receives a notification, so they reveal no server secret.

## What must never enter this repository

- Server, dashboard, or companion-app source; database schemas or
  migrations; queue, delivery-engine, or provider-transport code.
- Deployment and infrastructure configuration of any kind: Dockerfiles,
  platform manifests, CI deploy workflows, hosting/provider identifiers,
  regions, app names, sizing, or runbooks.
- Signing material and secrets: keys, certificates, provisioning profiles,
  tokens, credentials — regardless of whether they look expired or
  "not really secret". This includes npm registry auth in every form: a
  tracked `.npmrc` or `.env` carrying `_authToken`, a token pasted into a
  script, doc, test fixture, or commit message. Publishing auth lives in
  the maintainer's user-level credential store or CI OIDC/secrets, never
  in-tree (see `AGENTS.md`).
- Companion App Apple project configuration: `.xcconfig`, entitlements, team
  or bundle identifiers, App Store metadata. The public CLI's standalone Bun
  entitlement profile is client build source, not Companion App configuration.
  A public CLI publisher identity must be explicitly reviewed before it is
  committed; it must not be copied from private project configuration.
- Private product records: internal decision logs, incident evidence,
  roadmaps, user/device identifiers, cost data.
- Imports of private packages (`@raidiant/notifai-server`, `@raidiant/notifai-contracts`,
  `@raidiant/notifai-dashboard`) or relative imports that reach outside this
  repository.

## Enforcement

`pnpm check:boundary` fails the tree on:

1. Top-level entries outside the allowlist.
2. Workspace packages other than `apps/cli` and `packages/protocol`.
3. File names matching private-material patterns (key/profile/config
   extensions, platform manifests, dotenv files).
4. Source that imports private packages, private server modules or
   testcontainers, or that imports through a relative path into private
   workspace directories.

The release workflows run it too. They also scan the exact npm tarballs after
their generated `dist/` files exist (`scripts/check-packed-boundary.mjs`, with
gitleaks). That scan rejects private-package and hosting identifiers,
private-material filenames, owner-specific absolute home paths, links or unsafe
archive paths, source maps with embedded `sourcesContent`, and source-map paths
that are absolute URLs or resolve outside the package. Its tests include a
canary that exists only in generated packed output, so a clean source tree
cannot make this check silently disappear.

The private repository additionally scans this tree with patterns derived
from its own deployment configuration before advancing its submodule pointer.
That second check intentionally lives outside this repository so its patterns
do not become public.

Before a push to a remote named `origin`, `scripts/githooks/pre-push` runs the
agent guidance review check, the boundary self-test and scan, gitleaks positive
controls and current-tree/full-history scans, and `pnpm check:machine-paths`.
The last check rejects the current machine's absolute home path in the index,
worktree, or reachable Git history, including commit messages. The hook needs
`gitleaks` on `PATH`, fails closed when a required tool is unavailable, and
requires a clean checkout at the exact pushed commit. Install it with
`git config core.hooksPath scripts/githooks`. The hook is local, so PR review
still checks public wording and any machine details that automatic patterns
cannot recognize.

## Adding something new

If a change needs a new top-level entry or a new workspace package, extend the
allowlist in `scripts/check-boundary.mjs` in the same change and say in the
commit message why the addition is client-surface material. When in doubt, it
stays private.
