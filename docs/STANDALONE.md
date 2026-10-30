# Standalone CLI development

How the native `notifai` command is built, installed and updated. Releases
follow [the release procedure](RELEASING.md); the GitHub Releases of this
repository and the signed channel records say what is actually published.

A local build is a candidate: building it does not install it, and only the
release workflow publishes a build.

## Build a candidate

Build tools require Node, pnpm, Bun **1.4.2**, and a native C compiler. The
delivered application does not require those tools. On Windows, run the build
from an MSVC developer environment matching the target architecture.

From a clean public checkout with dependencies installed:

```sh
node scripts/build-launcher.mjs /path/to/output
node scripts/build-standalone.mjs --out /path/to/output/notifai-runtime
node scripts/check-standalone.mjs /path/to/output/notifai
```

Use `.exe` on both executable names for Windows. Output belongs outside the
checkout. `--development` permits a dirty source tree and records that fact in
the embedded identity; such output is not release evidence. `--bun` selects an
explicit compiler executable. `--target` selects a Bun target; cross-compilation
alone does not demonstrate that target's native behavior.

For a locally rebuilt Bun/JavaScriptCore runtime, also pass
`--runtime-executable /absolute/path/to/rebuilt/bun --development`. This selects
the actual executable embedded by Bun, independently of `--bun`, which selects
the compiler. Such builds carry a `-relinked` runtime identity and cannot pass
official publication admission. Build the runtime for the chosen target first;
cross-compiling the application cannot build JavaScriptCore for that target.

The builder regenerates the protocol output and exact CLI skill bundle before
compilation. It embeds release identity, the skill and the canonical changelog,
disables configuration autoload, and writes a build receipt beside the executable.
`self-check --json` verifies build identity, process identity, skill integrity and
changelog availability without service access or persistent account/logging
writes. It does not verify an OS signature or prove installation, credentials,
notification delivery, resident ownership, or update behavior.

## Launch boundary

Always execute `notifai` with its sibling `notifai-runtime`. Bun's compiled
payload still honors `BUN_OPTIONS` and `BUN_BE_BUN` before JavaScript starts.
The native launcher removes Bun/JavaScriptCore environment controls before
dispatch. Direct payload execution does not provide that boundary and cannot
run mutating commands. A per-entry launcher marker is consumed at command
admission; it is a local launch protocol, not a credential or security boundary
against other programs running as the User.

On POSIX the launcher uses `exec`, preserving the process identity, arguments,
streams, and exit status. On Windows it assigns the child to a Job Object at
creation and retains ownership until child exit.

## Candidate CI

To check a branch on every native target without releasing it, dispatch
`ci.yml` at the branch with its full `expected_sha` and `standalone_only=true`.
This calls `standalone-candidate.yml` on six native runner targets and keeps the
unsigned executables and check receipt. No push, pull request or timer starts
it, and it never publishes assets or advances an update channel.

## Where it installs

`scripts/install.sh` and `scripts/install.ps1` install one per-user native
Installation under `~/.notifai` (the matching profile directory on Windows)
and continue with `notifai init`. Neither needs Node, npm, Bun or Git. Linux
requires glibc, and x64 builds require SSE4.2. macOS builds are Developer ID
signed and notarized; Windows executables are not yet Authenticode signed.

First installation trusts the HTTPS release channel: the bootstrap checks
metadata, archive paths and types, sizes and hashes before running anything.
Installed updates are verified against the release signing key embedded in
the CLI (`release-trust.ts`); its private key is held only by the protected
release environment.

On macOS and Linux the installer links `notifai` into `$XDG_BIN_HOME`, or
`~/.local/bin` when that is unset. Only when that directory is not on `PATH`
does it add one marked block to the login shell's startup files (zsh, bash, sh,
dash, or an owned `~/.config/fish/conf.d/notifai.fish` for fish); any other
shell gets the exact directory to add. On Windows it adds the directory to the
User `Path`. `--no-path` skips all of this. The installer never replaces another
program's `notifai`, and removal deletes only what it added.

A trusted compiled release also exposes `notifai install` for local release
files (`--directory`, `--inventory`) and pinning (`--version`, `--channel`);
`--no-init` installs without running setup. See `notifai install --help`.

## Updates

`notifai update` keeps the saved channel. `notifai channel [stable|beta]`
shows or saves the channel (`--json` for programs): a newer release on the
chosen channel is installed at once, and otherwise the active build stays until
the channel offers a newer one, so choosing stable while a newer beta is active
waits for the next stable release instead of downgrading. The JSON report always
carries `channel`, `active_version` and `waiting_for_stable`.
`notifai update --channel stable --allow-downgrade` returns from beta to the
signed stable release now, `--rollback` restores the previous verified build,
and `--repair` or `--abandon` recover an interrupted update. Each step reports
its own result, and partial work prints a recovery command.

On macOS and Linux the shared hub also updates automatically: at most once a
day it installs a newer release on the saved channel. Waiting questions,
answers and sessions carry over. It holds an update back when it would change
Notifai's Codex or Claude Code hook definitions, which you approve, or when a
running session cannot move to it yet. `notifai config set updates.automatic off --yes` turns
this off for the machine. Windows has no hub yet, so agents offer updates there
instead.

Old builds stay on disk while anything might still use them.
`notifai update --cleanup --json` removes retired builds it can prove are
unused, and reports why it keeps the rest. Only Linux exposes a boot identity
for that proof, so macOS and Windows keep old builds.

`notifai uninstall` removes the runtime and Notifai's own wiring after its
safety checks, and keeps your data.

## Optional npm launcher

The `@raidiant/notifai` npm package is a small launcher, not a second product.
It has no install scripts, so installing the package changes nothing by itself.
`notifai init` or `notifai install` through it verifies the exact signed native
release for that launcher version and runs the native installer. From then on
the runtime, updates, hooks and removal belong to the same native Installation
as the shell and PowerShell routes.

Node.js 20.12 or newer is required only for this launcher. `npm update` changes
only the launcher; `npm uninstall -g @raidiant/notifai` leaves the runtime in
place, and `notifai uninstall` names any leftover launcher. `@version` selects
launcher code, not the runtime version. Hooks always call the native command,
never an npm or NPX cache path.

## Moving from the old npm CLI

Releases before 12.0.0 were a Node application under the same package name. The
installer refuses to shadow it. To move one identified npm-global install, run
the installer with `--migrate-npm` (`-MigrateNpm` in PowerShell): it installs
the native runtime, keeps the old package, and reports the exact npm command
that removes it. Finish outstanding questions and acknowledgements first, then
remove the old package with that command and rerun the installer to finish
setup. Notifai never removes the old package itself. Skills it did not install
are kept and reported with their paths.

If you added a new npm launcher before updating an older native runtime, the
launcher reports the exact prefix: remove that launcher, update the native
command by its absolute path, then reinstall the launcher.
