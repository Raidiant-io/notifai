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

The `node-workspace` plugin therefore uses `updateAllPackages: true`. A change
to either package advances both packages by at least a patch and keeps the
candidate genuinely combined. This is also required by release-please 17.3.0:
with a rootless manifest and `include-component-in-tag: false`, a CLI-only
combined candidate is rendered as one componentless body entry. After merge,
release-please treats that shape as a standalone component branch, cannot
correlate it with `release-please--branches--main`, and silently creates no
`v<version>` release. Shipping the pair together avoids that invalid metadata
shape without changing the established CLI tag or bypassing verification.

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

Before merge, the required `commits` check also validates the Release PR's
GitHub title, body, and manifest delta through
`scripts/verify-release-pr-metadata.mjs`. This is the metadata release-please
reads after merge; editing only the eventual squash commit message cannot repair
an incompatible Release PR. In the combined no-root configuration, a lone
componentless release entry is rejected because release-please 17.3.0 treats it
as a standalone component branch and cannot correlate the branch back to the
configured package. Component-named single-package candidates and parseable
combined candidates remain valid. The workspace-wide bump above prevents the
CLI-only form during ordinary generation; this verifier remains the fail-closed
backstop if configuration or upstream behavior drifts. Keep the generated Release PR metadata
unchanged; if this check rejects a candidate, do not merge it.

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

- CLI tag: `v<version>` (the matching npm package embeds the exact reviewed
  skill and installs it through a verified short-lived local source)
- Protocol tag: `protocol-v<version>`

release-please does not publish to npm. Tags created with `GITHUB_TOKEN` do not
start tag-push workflows, so the no-checkout dispatch job starts `publish.yml`
once per created tag and binds the run to release-please's exact tag SHA. Only
when the maintainer asked, the workflow waits at the protected `npm-release`
environment. A maintainer approves that deployment;
the workflow then validates a clean tag checkout, checks the packed install,
and builds each npm tarball exactly once. Those two tarballs are scanned for
secrets and public/private boundary violations, including generated source-map
paths and embedded source, then installed together outside the workspace. The
workflow passes those same tarball paths to `npm publish` through trusted
publishing with provenance; it never asks npm to repack the package directory.
After publication it downloads the registry tarball and requires its complete
bytes to equal the staged, scanned tarball before checking compiled files and
resolution-shaping metadata. Protocol publishes before a CLI that pins it
exactly. Concurrent tag runs are serialized and publication is idempotent: an
already-published version is verified against the deterministically rebuilt
tarball, never republished.
The verifier retries only a registry `E404` five times with exponential
backoff (15 seconds total); other failures remain immediate, and a version that
never appears still fails after the bounded attempt ceiling.

`publish.yml` also reads the GitHub Release for the dispatched tag and refuses
to enter the protected npm job unless GitHub reports `immutable: true`. This is
deliberately separate from the tag/SHA comparison: an exact ref proves what the
tag means now, while immutable releases prevent that meaning and the release
assets from being changed later.

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

Before another release is cut, a repository administrator must enable GitHub
release immutability under **Settings → General → Releases → Enable release
immutability**. The equivalent authenticated operation and read-back are:

```sh
gh api --method PUT repos/Raidiant-io/notifai/immutable-releases
gh api repos/Raidiant-io/notifai/immutable-releases --jq '{enabled, enforced_by_owner}'
```

The read-back must say `enabled: true`. GitHub applies this setting only to
future releases. Protect the already-published `v*`, `protocol-v*`, and
`android-v*` tags with one active repository **tag ruleset** targeting those
three patterns, enabling
**Restrict updates** and **Restrict deletions**, with no human or application
bypass. Do not enable **Restrict creations**: release automation still has to
create each new version tag. The npm-bound skill verification does not rely on
historic tag mutability, but links and source archives still do.

The exact repository-ruleset operation is:

```sh
gh api --method POST repos/Raidiant-io/notifai/rulesets --input - <<'JSON'
{
  "name": "Protect immutable release tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": [
        "refs/tags/v*",
        "refs/tags/protocol-v*",
        "refs/tags/android-v*"
      ],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "update",
      "parameters": {"update_allows_fetch_and_merge": false}
    },
    {"type": "deletion"}
  ]
}
JSON
```

Verify the returned object (or `gh api repos/Raidiant-io/notifai/rulesets`)
names an active `tag` ruleset. Its detailed read-back must preserve all three ref
patterns, exactly zero excluded refs, an empty bypass list, and exactly the
`update` and `deletion` rules.

Ordinary CI runs `node scripts/check-public-provider-posture.mjs` with its
read-only `GITHUB_TOKEN`; that continuously proves private vulnerability
reporting remains enabled. Publication runs the same check with
`--release-tag` and `--expected-sha`, adding the exact tag/SHA and immutable
GitHub Release assertions without printing API response bodies. The
repository-wide immutability endpoint requires Administration (read), which a
least-privilege Actions token intentionally does not have. A separately owned
scheduled GitHub App posture check should grant that read permission only and
run:

```sh
node scripts/check-public-provider-posture.mjs --require-repository-immutability
```

Do not broaden the publication token to make this deeper scheduled check fit
inside the release workflow.

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
