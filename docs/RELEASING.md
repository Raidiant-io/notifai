# Releasing

`@raidiant/notifai` and `@raidiant/notifai-protocol` version independently.
A version number is a compatibility promise, not a name for a story.

## The promise

Until 1.0.0:

| Change | Bump |
| --- | --- |
| Breaking | minor (`0.y+1.0`) |
| Compatible feature or fix | patch |
| Docs, chore, test, ci, refactor | none |

After 1.0.0 the SemVer 2.0.0 / Conventional Commits mapping applies: breaking
→ major, `feat` → minor, `fix` → patch.

`^0.5.1` on npm is `>=0.5.1 <0.6.0`. A 0.x minor ejects every caret
installer, so it is reserved for breaks.

## Commits

```
<type>(<scope>)!: <description>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `revert`.
Scopes: `cli`, `protocol`, `skill`, `repo`. Scope is optional — the release
command infers it from the paths you touched. `skill` bumps the CLI (the
skill ships in the CLI tag).

Description is the public-audience sentence this repository already writes.
No tracker IDs, no trailing period.

```
feat(cli): wake Claude sessions through the inbox socket
fix(protocol): reject an empty question set
feat(cli)!: remove the presence gate
```

`pnpm check:commit` lints HEAD, a message, or a range. The `commit-msg` hook
calls it. CI calls it on every push and pull request. A prose commit in a
release range is a hard failure, not a skip.

## Cut a release

Never publishes. Never pushes. Never prompts.

```
pnpm release              # print the plan
pnpm release --write      # bump package.json, CHANGELOG.md, README
pnpm release --cut        # write, commit, annotated tags
pnpm release --github     # --cut plus `gh release create`
pnpm release --package cli
pnpm release --json
```

Tags: `v0.5.2` for the CLI (the skill pin is `Raidiant-io/notifai#v0.5.2`),
`protocol-v0.3.1` for the protocol.

Then, and only when the maintainer asked for a publish: push the commit and
tags from the canonical clone, `npm publish` only the packages that changed,
and `pnpm check:published`.
