# Runtime source and local rebuilding

Notifai includes Bun, which statically links JavaScriptCore from its patched
WebKit tree. Full matching Bun, WebKit, TinyCC and MPL crate source archives are
available at the immutable source release in `CORRESPONDING-SOURCES.json`.
Check each archive's byte size and SHA-256 against that manifest. Notifai's
application source and build scripts are available from the exact `v<version>`
tag of <https://github.com/Raidiant-io/notifai>.

The application is Apache-2.0-licensed. You may modify it and its runtime and debug
those modifications under the respective licenses included in this archive.
Local rebuilding requires development tools even though the distributed CLI
does not require Node, pnpm, Bun, Git or a C compiler on its runtime PATH.

## Build a changed Bun/JavaScriptCore

Use the matching Bun source and its build prerequisites in
`docs/project/contributing.mdx`. Bun's `LICENSE.md` describes its WebKit
relink path. In a checkout of the pinned Bun commit:

```sh
git clone https://github.com/oven-sh/WebKit vendor/WebKit
bun sync-webkit-source
# Make the desired JavaScriptCore changes after the source sync.
bun run build:local
```

The pinned WebKit revision is
`2e2aa2290fac856d6f451ceacb58f7f5b44dd057`. The supplied archives also allow
inspection and modification without relying on the upstream repository's
continued availability. Follow the upstream build instructions for the target
OS and architecture; cross-compiling the application does not cross-compile
JavaScriptCore. Record the actual rebuilt Bun executable path.

## Run the application source with that runtime

Check out the desired Notifai release tag, install its locked dependencies,
and build its JavaScript:

```sh
pnpm install --frozen-lockfile
pnpm --filter @raidiant/notifai-protocol build
pnpm --filter @raidiant/notifai build
/absolute/path/to/rebuilt-bun apps/cli/dist/main.js --help
/absolute/path/to/rebuilt-bun apps/cli/dist/main.js --version
```

Use that same invocation with an ordinary CLI command to exercise the
application with the changed runtime. This is source/development execution;
it reads the ordinary CLI configuration when the selected command needs it.
Source-launched resident children use the same runtime executable. This route
does not replace the installed official binaries or their update trust.

## Embed the rebuilt runtime in a standalone candidate

With a Bun 1.4.2 compiler and a matching native C compiler:

```sh
node scripts/build-launcher.mjs /absolute/path/to/output
node scripts/build-standalone.mjs --bun /absolute/path/to/bun-1.4.2 \
  --runtime-executable /absolute/path/to/rebuilt-bun --development \
  --out /absolute/path/to/output/notifai-runtime
/absolute/path/to/output/notifai self-check --json
```

On Windows, use `.exe` on the executable filenames and an MSVC developer
environment for the target architecture. `--bun` selects the compiler;
`--runtime-executable` selects the runtime actually embedded by that compiler.
The compiled identity records `bun-1.4.2-relinked`. A clean source checkout
remains recorded as clean; changing source without committing records it as
dirty.

The standalone self-check verifies execution and embedded identity. An
uninstalled candidate supports diagnostics and installation entrypoints only;
ordinary compiled commands require an authenticated managed installation.
For local application execution with the changed runtime, use the source
invocation above. Building a separately managed fork requires changing the
fork's source-embedded public key and signing its own inventories. No official
private signing key is needed to build or run modified application source.

Official release tooling rejects relinked runtime identities. This protects
the official update channel and does not restrict source modification.
