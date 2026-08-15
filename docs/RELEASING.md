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

The packages on npm today are `1.0.1` and `0.4.0`. Those numbers stay until
the next cut.

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

## Cutting a release

[release-please](https://github.com/googleapis/release-please) opens and
updates a Release PR on every push to `main`. Merging that PR is the cut:
it bumps `package.json`, writes `CHANGELOG.md`, and creates the annotated
tags.

- CLI tag: `v1.0.2` (the skill pin is `Raidiant-io/notifai#v${version}`)
- Protocol tag: `protocol-v0.4.1`

**Do not merge a Release PR unless the maintainer asked for a release.**
The PR existing is not a release.

The root `README.md` version markers are updated in the release commit.
release-please cannot climb out of a package directory to edit them
(`extra-files` rejects `../`).

When a release changes both packages, the cut must also carry the CLI's
`@raidiant/notifai-protocol` dependency pin forward to the protocol version
being released. The workspace always links the local protocol, so a stale pin
passes every workspace gate and crashes every clean registry install at
startup. `pnpm check:packed` exists to catch exactly this: it installs the
packed tarballs in an isolated directory using their packed dependency
metadata and runs the installed bin. Run it before publishing; CI runs it on
every push.

release-please does not publish to npm. After the tags exist, and only when
the maintainer asked: publish the packages that changed, then
`pnpm check:published` — it verifies both the compiled files and the
resolution-shaping manifest metadata against the registry.
