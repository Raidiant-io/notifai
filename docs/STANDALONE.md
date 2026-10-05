# Standalone CLI development

The native distribution is under development. These commands build and inspect
a candidate; they do not install it or establish supported release targets.
The existing npm installation remains the published distribution.

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

The builder regenerates the protocol output and exact CLI skill bundle before
compilation. It embeds release identity and the skill, disables configuration
autoload, and writes a build receipt beside the executable. `self-check --json`
verifies build identity and skill integrity without service access or persistent
account/logging writes. It does not verify an OS signature or prove installation,
credentials, notification delivery, resident ownership, or update behavior.

## Launch boundary

Always execute `notifai` with its sibling `notifai-runtime`. Bun's compiled
payload still honors `BUN_OPTIONS` and `BUN_BE_BUN` before JavaScript starts.
The native launcher removes Bun/JavaScriptCore environment controls before
dispatch. Direct payload execution does not provide that boundary.

On POSIX the launcher uses `exec`, preserving the process identity, arguments,
streams, and exit status. On Windows it assigns the child to a Job Object at
creation and retains ownership until child exit. Native cancellation, signals,
and intentionally detached owners require their own evidence before release.

## Candidate CI

Dispatch `ci.yml` at the candidate branch with its full `expected_sha` and
`standalone_only=true`. This calls `standalone-candidate.yml` on six native
runner targets and retains the unsigned executables and check receipt. No push,
pull-request, or timer starts this workflow. All actions are pinned by commit.

This mode skips the npm `gates` job, so its successful result cannot satisfy the
existing npm publication evidence gate. It neither publishes assets nor advances
an update channel. OS signing, signed inventory, complete lifecycle validation,
and authorized promotion are still required for native distribution.
