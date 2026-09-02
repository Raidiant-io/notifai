# Public/private boundary policy

This repository contains only the Notifai client surface: the CLI and the
client-visible wire contract. The service implementation, companion apps,
and operations are private, and the boundary between the two is part of
this project's security posture: **the service must remain secure when
everything in this repository is fully known.**

## What belongs here

- `apps/cli` — CLI source, its unit tests, hook adapters for agent
  harnesses, configuration and credential-store handling, and user-facing
  documentation.
- `packages/protocol` — client-visible request/response types and schemas
  for `/api/v1`, stable status vocabulary, capability documents and draft
  validation, and the small hashing helper shared with clients.
- Public docs, fixtures, and the boundary tooling itself.

`packages/protocol/src/apns.ts` and `packages/protocol/src/fcm.ts` model the
application-visible notification envelopes so offline validation can estimate
payload size against each provider limit. Their content is fully observable on
any device that receives a notification, so they reveal no server secret. They
are exported so the service renders from the same code the estimate runs;
whether they should leave the public source entirely (at the cost of offline
size pre-flight) is an open decision tracked privately.

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
- Apple project configuration: `.xcconfig`, entitlements, team or bundle
  identifiers, App Store metadata.
- Private product records: internal decision logs, incident evidence,
  roadmaps, user/device identifiers, cost data.
- Imports of private packages (`@raidiant/notifai-server`, `@raidiant/notifai-contracts`,
  `@raidiant/notifai-dashboard`) or relative imports that reach outside this
  repository.

## Enforcement

`pnpm check:boundary` (also intended as a CI gate) fails the tree on:

1. Top-level entries outside the allowlist.
2. Workspace packages other than `apps/cli` and `packages/protocol`.
3. File names matching private-material patterns (key/profile/config
   extensions, platform manifests, dotenv files).
4. Source imports of private packages, testcontainers, or any relative
   path escaping the repository.

`pnpm check:packed` applies the boundary again to the exact npm tarballs after
their generated `dist/` files exist. It rejects private-package and hosting
identifiers, private-material filenames, owner-specific absolute home paths,
links or unsafe archive paths, source maps with embedded `sourcesContent`, and
source-map paths that are absolute URLs or resolve outside the package. Its
tests include a canary that exists only in generated packed output, so a clean
source tree cannot make this release path silently disappear.

The private repository additionally scans this tree with patterns derived
from its own deployment configuration before advancing its submodule pointer.
It scans the canonical remote's advertised HEAD, branches, and tags as well as
the local candidate. That second check intentionally lives outside this
repository so its patterns do not become public.

## Adding something new

If a change needs a new top-level directory, a new workspace package, or a
new kind of file, extend the allowlist in `scripts/check-boundary.mjs` in
the same change and say in the commit message why the addition is
client-surface material. When in doubt, it stays private.
