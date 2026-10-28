# CLI releases

Authorize the scope and channel once. The default is beta; stable always needs
explicit authorization (one authorization may cover beta then stable). A version
is immutable. Never move its tag, overwrite its assets, or republish its npm bytes.

## One Release PR, one execution

Use one Release PR for version, changelog, README markers and lockfile changes.
Dispatch `release-please.yml` by hand with `expected_sha` set to the exact
current `main` commit; it prepares the combined stable PR and creates its tags
after merge. It dispatches nothing else. Beta candidates use the same metadata
in one release branch/PR, with the stable manifest unchanged. Close a completed
beta PR without merging beta metadata into main. Ordinary product changes land
before the release. Review notes against the previous stable tag.

Freeze the candidate commit, create its exact `v<version>` tag, then dispatch
**publish.yml** on that tag. Native publication creates the tag's draft GitHub
Release from its CHANGELOG section when none exists, and keeps the oldest of
byte-identical empty duplicate drafts; edit the notes after publication if
needed. Any other ambiguity stops before upload:

- `expected_sha`: the full frozen commit;
- `mode: release`;
- `channel: beta` or `stable`, only as authorized;
- `channel: none` for a validation candidate that must never enter discovery.

The one resumable graph performs source checks, parallel six-target native
build/finalization, signed inventory assembly, immutable native publication,
OIDC npm candidate publication, six fresh npm/native installation checks, then
npm and native promotion with fresh service/pointer checks. `none` stops after
registry acceptance. It still publishes immutable candidate bytes; it is not a
local simulation. Valid CLI versions are `X.Y.Z` and `X.Y.Z-beta.N`.

## Evidence and retries

Source tests run once per input digest. A reusable receipt must come from a
successful source job in the first-party `publish.yml` workflow and match every
current source, test, dependency and build input. Documentation outside shipped
materials does not invalidate it. Exact tags, source revisions and final artifact
hashes remain mandatory; current main need not stay at the release commit.

Source boundaries are scanned once, package contents once. Native finalization
runs runtime/storage checks on final bytes. macOS remains Developer ID signed
and notarized, including the accepted-ticket retry. When a Mac's Gatekeeper
reports valid Developer ID code as unnotarized, the check asks Apple's ticket
store for the exact code hash: no ticket fails at once; a held ticket or an
unreachable store is a bounded retry, and only a later local check admits the
file. npm publication repeats only a Sigstore Rekor 409 conflict, after
proving the version never reached the registry. Each target then installs
one registry-verified npm adapter, acquires its exact signed native product,
and checks both process identity and skill refresh in that installation.

Use **Re-run failed jobs** (`gh run rerun <run-id> --failed`). Successful targets
and their immutable artifacts stay in the run. Do not start a new version or
rebuild successful signed bytes to recover an acquisition failure. The workflow
never replaces assets. Interrupted promotion resumes the same version and reads
back both providers; npm and GitHub are not an atomic transaction.

Stable embeds its own version and receives its own signatures and fresh installs.
Compare product/dependency/build inputs with the tested beta; new product changes
need another beta. Retain live integration evidence for changed behavior. Source
checks and version strings alone are not installed behavior proof.

## Integration and completion

Review changed shipped guidance and its behavior dependencies at integration.
Unchanged guidance needs no release-time approval. The release workflow does not
wait for unrelated application releases, store snapshots, or announcement drafts.
A CLI release completes when its authorized artifacts, six installations and
requested discovery pointers are verified. Record run URL, exact source and
artifact identities, timings and remaining live acceptance. Communication has
its own authorization and may proceed asynchronously.

## Provider contract

Keep the trusted publisher filename **publish.yml**, environment **npm-release**,
OIDC-only npm publication with provenance, and npm **11.21.0** or newer supporting
OIDC dist-tag operations. Both existing packages require independent publish and
dist-tag permission. Never use a long-lived npm token or agent npm login.

Keep immutable GitHub Releases and update/deletion protection on release tags.
`native-release` contains native signing credentials; both release environments
retain their release-tag restrictions. The authorized release owner progresses
exact-run environment gates without asking for repeated human approvals.

`candidate`, `promote` and `repair-beta` modes remain for already-started legacy
runs and protocol releases. Do not select a legacy mode for a new CLI release.
Protocol versions remain independent: dispatch `ci.yml` at the exact release
commit, then `publish.yml` on the `protocol-v*` tag with `mode: candidate` and
later `mode: promote`; both require that successful CI run at the same commit.
`repair-beta` changes only already-verified stable discovery, never artifact
bytes.

Authored PR text is UTF-8 via `gh pr create/edit --body-file`, followed by read-back.
Use Conventional Commits and SemVer. Changes to shipped guidance need an authored
note (`pnpm guidance:note --file <note-file>`); builds verify that catalog.
