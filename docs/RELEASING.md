# Releasing

`@raidiant/notifai` and `@raidiant/notifai-protocol` version independently
under [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) and
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

## SemVer mapping

| Commit | Bump |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `BREAKING CHANGE:` or `type!:` | major |

That is the Conventional Commits spec. It is not special-cased for 0.x: a
breaking change on `0.5.1` was `1.0.0`. A breaking change on `1.0.0` is
`2.0.0`. Pre-release labels (`1.0.0-rc.1`) exist if we need them later.

What is on npm right now is whatever npm says — `npm view @raidiant/notifai
version` and `npm view @raidiant/notifai-protocol version`. This document does
not restate it, because a copied version number is wrong from the next release
onward.

## Commits

```
<type>(<scope>)!: <description>
```

Validated by [commitlint](https://commitlint.js.org/) with
`@commitlint/config-conventional`. Types, scopes, and header length are
that config’s defaults — not a house list.

```
feat(cli): wake Claude sessions through the inbox socket
fix(protocol): reject an empty question set
feat(cli)!: remove the presence gate
```

`pnpm check:commit` runs `commitlint --last`. The `commit-msg` hook runs
commitlint. CI runs it on the pushed or PR range.

Write for a public audience: no internal tracker IDs.

Pull requests are squash-merged. Give every PR a Conventional Commit title;
CI lints it because GitHub uses it as the squash commit subject. This keeps
`main` linear and gives release-please one authoritative commit per change
instead of both a merge commit and the commits it contains.

## Cutting a release

[release-please](https://github.com/googleapis/release-please) opens and
updates one combined Release PR on every push to `main`. This is a repository
choice, not a release-please requirement: `separate-pull-requests: false` and
the `node-workspace` plugin's default merge behavior keep both candidate
releases in one branch while still calculating their versions independently.

The combined PR is required here because the packed CLI must depend on the
exact protocol version released beside it. Separate candidates can each be
internally plausible while neither is installable: one can pin an unpublished
protocol version and the other can leave the CLI pinned to the old version.
`pnpm check:packed` installs both tarballs outside the workspace and enforces
the exact-pair invariant that workspace linking otherwise hides.

The release workflow then repairs the generated branch after release-please
updates it:

- `scripts/sync-readme-markers.mjs` updates the root README's CLI and protocol
  version markers.
- `pnpm install --lockfile-only` records the bumped manifests and protocol pin
  in `pnpm-lock.yaml`.

release-please cannot perform those repository-wide repairs itself. Its
`extra-files` updater cannot address `../` from a package, the README contains
component-specific markers, and a manifest bump does not regenerate a pnpm
lockfile. The repository-scoped `GITHUB_TOKEN` does not recursively start
workflows when it pushes the repair commit, so a separate no-checkout job uses
the official `workflow_dispatch` API to start `ci.yml` at the repaired branch.
Both the dispatch response and CI verify the exact expected commit SHA. Wait
for those required checks, including `pnpm check:packed`, before considering
the Release PR ready.

The combined manifest deliberately has no root (`.`) package. Do not add a
`group-pull-request-title-pattern` that references `${component}` or
`${version}`: release-please sources those values from the root candidate, so
both are empty here and the generated title is malformed. The workflow instead
compares every manifest version change on `main` with the action's exact
package release, tag, and SHA outputs. A skipped or mismatched release therefore
fails the release job, which prevents the dispatch job from turning the skip
into a green workflow.

GitHub documents one narrower exception to the recursion rule: when
`GITHUB_TOKEN` creates or updates a pull request, its `pull_request` event can
create runs in an approval-required state. This release path does not depend on
those runs. The repair push still cannot recurse; the dispatch job creates one
explicit `workflow_dispatch` run at the repaired SHA; and `ci.yml` has only
`contents: read`, so it cannot dispatch another workflow, update the PR, or
push another commit. `release-please.yml` itself listens only to pushes on
`main`, so CI dispatched on a release branch cannot re-enter release automation.

**Do not merge a Release PR unless the maintainer asked for a release.** An
open or green Release PR is only a candidate. Once authorized, squash-merge
the combined PR. The next workflow run creates every applicable tag from that
same merged commit:

- CLI tag: `v<version>` (the skill pin is `Raidiant-io/notifai#v${version}`)
- Protocol tag: `protocol-v<version>`

release-please does not publish to npm. Tags created with `GITHUB_TOKEN` do not
start tag-push workflows, so the no-checkout dispatch job starts `publish.yml`
once per created tag and binds the run to release-please's exact tag SHA. Only
when the maintainer asked, the workflow waits at the protected `npm-release`
environment. A maintainer approves that deployment;
the workflow then validates a clean tag checkout, checks the packed install,
publishes through npm trusted publishing with provenance, and verifies the
registry bytes and resolution-shaping metadata. Protocol publishes before a
CLI that pins it exactly. Concurrent tag runs are serialized and publication
is idempotent: an already-published version is verified, never republished.
The verifier retries only a registry `E404` five times with exponential
backoff (15 seconds total); other failures remain immediate, and a version that
never appears still fails after the bounded attempt ceiling.

The workflow action is pinned to v4.4.1, which runs release-please 17.3.0;
`release-please-config.json` pins its schema to the same version. Upgrade the
action and schema together as maintenance work, never during a release.

## Release automation identity and permission envelope

Release automation uses only GitHub's ephemeral
[`GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token).
GitHub mints it per job, limits it to this repository, and expires it when the
job ends. There is no separately managed release token, App registration,
private key, client identifier, or installation identifier.

The exact non-secret permission envelope is:

| Job | Permission | Why |
| --- | --- | --- |
| `release-please` | `contents: write` | Create and update release branches, push the repository-wide repair commit, and create the exact release tags and GitHub Releases after an authorized Release PR merge. |
| `release-please` | `pull-requests: write` | Create and update the combined Release PR. |
| `dispatch` | `actions: write` | Call the official workflow-dispatch endpoint and read back each created run to verify its `head_sha`. |

Job-level permissions make every unlisted permission `none`. The `dispatch`
job has no checkout and no contents or pull-request access; the write-capable
release token is not retained by checkout (`persist-credentials: false`). CI
has only `contents: read`. The protected npm job has only `contents: read` and
`id-token: write` for trusted publishing.

This design follows GitHub's documented
[`GITHUB_TOKEN` recursion rule](https://docs.github.com/en/actions/concepts/security/github_token),
the [`workflow_dispatch` endpoint](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
and [least-privilege job permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions).
It deliberately does not use `repository_dispatch`, which would provide no
ref-bound `github.sha` for the target workflow to verify.

## One-time provider setup

The checked-in publication workflow is fail-closed until a repository
maintainer has completed the provider-side setup below. No token value or
provider identifier belongs in a tracked file, issue, log, or support message.

In GitHub repository **Settings → Actions → General → Workflow permissions**,
enable **Allow GitHub Actions to create and approve pull requests** and save.
GitHub documents that this setting controls whether `GITHUB_TOKEN` can create
pull requests. Keep the default workflow permission read-only; each job grants
only its explicit envelope above.

If GitHub refuses that repository change because the organization disallows
it, an organization owner must first open **Raidiant-io Settings → Actions →
General → Workflow permissions**, enable **Allow GitHub Actions to create and
approve pull requests**, and save. A repository owner must then repeat the
repository-level step above. Do not broaden the organization's or repository's
default `GITHUB_TOKEN` permission from read-only.

For npm trusted publishing, a maintainer of both npm packages must:

1. In GitHub repository Settings → Environments, create `npm-release`, add the
   maintainer as a required reviewer, and restrict deployments to the release
   tag patterns `v*` and `protocol-v*`.
2. On npmjs.com, open each package's Settings → Trusted Publisher, choose
   **GitHub Actions**, and enter organization `Raidiant-io`, repository
   `notifai`, workflow filename `publish.yml`, environment `npm-release`, and
   allowed action **npm publish** only. Each package needs its own configuration.
3. Approve and observe the first tag run. It must publish with provenance and
   finish the package-specific published-artifact verification before this path
   is considered live.
4. Only after both packages have passed that proof, open each package's
   Settings → Publishing access and disallow token-based publishing. Trusted
   publishing continues to work with short-lived OIDC credentials.

npm requires GitHub-hosted runners, Node 22.14 or newer, npm 11.5.1 or newer,
and `id-token: write`. `publish.yml` uses Node 24, checks the npm floor before
doing release work, and grants the OIDC permission only to the protected
publish job.

## Changelog and breaking-release policy

Squash-only history makes future generated changelog entries clean. Do not
rewrite changelogs, tags, or npm versions that were already published. If an
open Release PR still contains duplicates from earlier merge commits, it may
be deduplicated immediately before an authorized cut; that does not authorize
merging it.

Breaking changes still use `type!:` or a `BREAKING CHANGE:` footer and still
produce a major release. When practical, let related breaking changes
accumulate in the Release PR and cut them together. Batching changes reduces
avoidable major-version churn without weakening SemVer or misclassifying a
break.
