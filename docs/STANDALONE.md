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
verifies build identity, process identity and skill integrity without service access or persistent
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
an update channel. Signed release inventory, complete lifecycle validation,
and authorized promotion are still required for native distribution. Windows
Authenticode is deferred; Windows artifacts are unsigned. macOS publication
requires Developer ID signing and notarization of the final bytes.

## Managed hook and resident boundaries

Native harness definitions name the stable `bin/notifai[.exe]` directly. Windows
plugins omit a Notifai Node interpreter; a JavaScript-based harness may still
need its own runtime. Readiness resolves the active immutable payload through
local installation metadata, without executing PATH candidates or treating equal
version strings as native build identity. Those local facts do not replace
signed distribution admission or the launcher's OS access checks.

Detached native owners launch the current immutable build. Before child creation,
the existing session record retains that build; claims also carry the runtime
reference. Updating the active pointer leaves the old owner running. Native CI
exercises this ordering and continued execution with isolated fixture owners,
and executes a generated native hook command with a restricted PATH. These
checks do not establish real harness activation, provider delivery, complete
installer/update commands, legacy migration, or safe generation collection.

## Checked archive packaging

After the CLI build, `package-standalone.mjs` creates a tar.gz or Windows ZIP and
an unsigned `artifact.json` inventory from the checked executables. It requires
matching clean build/execution receipts and hashes the supplied distribution
materials. It rejects byte changes after checks, unsafe material paths and an
existing output directory. The runtime archive reader verifies these archive
formats in focused tests.

Candidate CI includes the project license and the exact pinned Bun license
index, with a visible candidate-materials marker. This is incomplete publication
material: Bun's index is not every dependency's license text. Final publication
also requires matching third-party notices and an established source/relink path
for JavaScriptCore, OS signing where required, a signed complete release inventory,
and validation of the final distributed bytes. Packaging success does not satisfy
those gates. The candidate workflow never publishes or advances discovery.

The native CI job also extracts its actual archive, stages it using the default
candidate self-check and real OS file-access adapter, activates a fresh managed
installation, and executes its installed command with a restricted runtime PATH.
This verification signs one inventory with an ephemeral CI-only key; it does not
create production release trust. The receipt records exact archive identity and
compressed/installed size. It establishes the fresh installation engine and
artifact identity, not the complete installer/setup journey or live Question Routing.


## Native update commands

Compiled builds route `update` through the owned Installation. Ordinary update
keeps the saved channel, explicit beta-to-stable downgrade requires
`--channel stable --allow-downgrade`, and `--rollback` selects only the retained
verified previous build. `--repair` recovers a journal and retries launcher
replacement; `--abandon` refuses committed activation and preserves payloads.
PATH collisions stop mutation. Installed owners retain immutable executables.

After activation, the updater invokes the verified new immutable launcher for
`update --resume`. Runtime activation, launcher replacement, file integration
and attendant migration are separate reported results; partial work provides a
recovery command and never counts as complete. Signed channel discovery also
backs native update checks, doctor recommendations and throttled agent notices.
No native update uses npm dist-tags or an npm global prefix.

Production release trust is deliberately unconfigured in candidate source.
`release-trust.ts` must contain the approved Ed25519 public key before native
publication, with the private key held only by the protected release environment.
Candidates fail closed; neither an environment override nor project configuration
can install a trust root. Focused tests use ephemeral signed inventories through
an explicit test seam. This does not establish live update or harness migration,
and complete uninstall remains separate work.

### Existing Windows directory permissions

The launcher has an explicit existing-directory migration operation for an
already User-owned directory whose writers satisfy the installation policy. It
preserves the accepted ACEs, makes inherited ACEs explicit and protects the DACL.
It refuses unsafe writers and reparse points instead of removing permissions to
make a foreign directory appear owned. Ordinary launch checks never migrate.

The migration uses one short-lived `MAXIMUM_ALLOWED` directory handle for
`SetSecurityInfo`; Microsoft documents that this form does not propagate ACEs to
children. It verifies the protected owner/policy and exact ACEs on the same handle.
The native Windows fixture checks that existing child descriptors and contents
remain unchanged, that retries converge and unsafe writers are refused. See
[SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo).
Explicit candidate installation invokes this operation only for existing runtime
root/bin directories after authenticating its candidate. It never recurses over
User data. Native installation, PATH and legacy wiring migration still
need their complete setup-journey proof.


The Installation candidate entrypoint reuses a healthy owned runtime on repeated
or mixed bootstrap invocation, preserves its original source and saved channel,
and rejects an exact version/channel change with an explicit update instruction.
It authenticates the candidate before permission migration or staging. Archive CI
exercises fresh installation and repeated reuse with the real native access policy.

## Owned POSIX PATH entries

The installation engine can configure the selected shell's interactive and
login profiles (zsh, bash, sh/dash). It preserves existing Bash login selection,
quotes the runtime directory, and avoids duplicate PATH entries. A private
ownership receipt precedes each profile edit so interrupted setup can resume.
Removal deletes only the exact owned block; User edits and unowned markers are
preserved and reported as conflicts. Atomic writes also check the original
content digest, including same-file concurrent edits.

This engine operation is explicit, never run by hooks. It does not change the
current parent shell, guess every installed shell, or change Windows User
PATH; that uses the registry adapter below. Public installer orchestration still
needs its complete journey proof.

## Local native installer command

A trusted compiled release exposes `install`, defaulting to the executable's
directory and its sibling signed `inventory.json`. `--directory` and
`--inventory` support previously obtained local files without a runtime download.
`--version <exact>` checks the application version; `--channel` explicitly
selects a channel. `--source shell|powershell|npm|manual` records the bootstrap
route without changing runtime update ownership. Repeated installation reuses
the healthy managed runtime and preserves its original route and channel.

The command refuses known PATH collisions and current-session pending work,
authenticates candidate bytes, configures the selected shell, then invokes
`init` through the verified installed immutable launcher. `--no-path` explicitly
keeps absolute-command use; `--no-init` installs without choosing account, skill
scope or harness setup. JSON distinguishes runtime installation from setup
readiness and retains a local recovery command after partial setup. Runtime
activation is never undone because approval or setup is pending. Custom zsh
profile roots need explicit manual PATH setup.

Production trust remains unconfigured. This command is candidate source,
not an advertised replacement for the published installation route.

### Windows User PATH

Explicit installation edits only `HKCU\Environment`'s `Path` value, preserving
raw UTF-16 content and `REG_SZ` / `REG_EXPAND_SZ` type. A private receipt owns
only the exact added directory; preexisting entries are not claimed. Interrupted
setup resumes, User-modified owned entries are reported as conflicts, and removal
preserves unrelated entries. The native adapter checks the expected value before
writing and verifies readback. It sends bounded `WM_SETTINGCHANGE` notification
and reports whether that succeeded. Existing terminals retain their process
environment; setup uses the installed executable's absolute path.

Windows does not provide a registry value lock for this read/modify/write.
The installation lock serializes Notifai writers; expected-value checks detect
observed concurrent edits, but cannot exclude an external editor between check
and write. This is an optimistic update, not an operating-system compare-and-swap.
See [registry writes](https://learn.microsoft.com/en-us/windows/win32/sysinfo/writing-and-deleting-registry-data)
and [environment change notification](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange).
Native CI compiles and runs the storage fixture against a disposable registry
key; it never changes the runner's actual User PATH. That fixture proves raw
storage behavior, not receipt of the broadcast by every application.

### Bootstrap metadata views

`generate-bootstrap-metadata.mjs` derives data-only tab-separated views from
verified signed records: immutable release `bootstrap.tsv`, and the selected
channel's `<channel>.bootstrap.tsv`. A release view carries the signed inventory
digest and each archive/executable identity. A channel view carries its sequence,
version, inventory digest and withdrawals. Generation refuses invalid signatures,
channel/inventory mismatch and a withdrawn recommended version.

These views let OS bootstraps inspect fixed fields without an installed JSON
runtime. They are not a second release authority or independent authenticity:
first execution uses the documented HTTPS trust boundary, with macOS publisher
checks additionally required. Publication must upload the immutable view with its
release and advance the channel view in the same metadata-ref commit as the
signed channel record. Installed update verification continues to use signed JSON.
Promotion wiring remains under implementation.

## OS bootstraps

`scripts/install.sh` and `scripts/install.ps1` install the same per-user native
Installation and continue with `notifai init`. Neither needs Node, npm, Bun or
Git installed. Windows uses an unsigned executable; Authenticode is deferred.
The shell route requires the OS account lookup, HTTPS, SHA-256 and archive tools;
Linux currently requires glibc and x64 requires SSE4.2. macOS first installation
fails closed until the reviewed Developer ID team is configured, and requires
signature and execution assessment of both executables.

A repeat invocation checks the fixed command beneath the OS account home, its
ownership and access permissions, then asks it to resume installation/setup.
It does not query a new release or change the saved source/channel. An explicit
incompatible version or channel is refused with instructions to use `update`.
A relocated home, symbolic link/reparse point or other writable principal must
not select an executable. Native Installation remains the authority for signed
inventory verification, active runtime health and transaction recovery.

First installation on Windows/Linux trusts the HTTPS release channel. The
bootstrap checks bounded metadata, archive paths/types, download sizes and
hashes before execution. These hashes detect changed bytes; they are not a
separate trust root for first execution. Installed updates use embedded Ed25519
release keys. The npm bootstrap has its own pre-execution signature requirement.

### Bootstrap verification

The standalone candidate workflow runs shell bootstrap fixtures on macOS/Linux,
and PowerShell fixtures on both Windows architectures with Windows PowerShell
5.1 and modern PowerShell. These use local transport fixtures, including altered
archives, unsafe paths and existing-installation reuse. They do not constitute
published-channel, notarization, or end-to-end account setup evidence.

The separate native runtime and packaged-archive checks execute real compiled
launchers/runtimes, install signed test inventories and exercise update,
rollback, ownership and process lifetime boundaries. The isolated Windows
environment keeps standard `PATHEXT` so PowerShell waits for `.exe` commands as
native processes while Node/Bun remain absent from its executable search path.

## Final release assembly

`assemble-native-release.mjs` requires all six target directories, each containing
its exact checked archive, executable receipt, and native installation receipt.
It rechecks source/build identity, final archive contents and reviewed material
hashes before emitting a new exclusive release bundle. macOS additionally needs
final-byte publisher and raw-code notarization evidence. A failed assembly removes
only its newly created output; an existing bundle is never replaced.

The production command uses only source-embedded public keys and the protected
`NOTIFAI_RELEASE_SIGNING_KEY`, and reads the source-owned
`distribution/release-materials.json` policy. That policy is not provisioned yet:
it must bind approved runtime materials for every target and the reviewed macOS
team. Candidate materials cannot be signed for publication. Tests use synthetic
receipts/material policies and ephemeral keys, not production release authority.

`sign-release-records.mjs` produces deterministic Ed25519 envelopes compatible
with the installed verifier. Channel retries preserve identical signed bytes;
new records advance the sequence, retain withdrawals and require explicit
rollback authorization before recommending an older release. The provider writer
must still compare-and-swap the metadata ref and verify immutable published
assets before advancing a channel. Assembly alone performs no provider mutation.

### Resumable native publication

The publisher reads the exact signed bundle and confirms repository immutability,
protected release tags, the tag's commit and the draft identity. It reuses matching
completed assets, uploads missing assets and refuses any completed mismatch.
Only an expected empty `starter` upload in an unpublished draft may be removed.
All expected assets must be verified before the draft is published, and the
published release must read back as immutable before discovery can advance.
An interrupted upload or lost publication response resumes from provider state.

Channel promotion rereads the immutable assets, then uses GitHub's
`createCommitOnBranch` with `expectedHeadOid` to atomically commit the signed JSON
and bootstrap TSV while preserving other metadata. A moved head is a conflict,
never a force update. Missing channels require explicit initialization; initial
branch creation cannot replace an existing ref. Post-write readback checks both
files at one commit. Focused API fixtures cover interrupted responses, completed
asset mismatch, stale heads, initial-ref races and no-write retries; no live
publication has been performed.

`publish-native-release.mjs` is the protected-workflow entrypoint and requires
explicit `--publish` and/or `--promote` modes, an exact source/tag context, and
source-embedded trust keys. It preserves partial publication results if later
channel work fails. Workflow cutover and production configuration remain pending.
See GitHub's [immutable release sequence](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases),
[release asset API](https://docs.github.com/en/rest/releases/assets), and
[atomic branch commit mutation](https://docs.github.com/en/graphql/reference/commits).

### Hosted finalization and publication

Full `ci.yml` runs now include all six native targets. The `standalone_only`
option remains useful for focused development, but cannot qualify a production
candidate: publication also requires the generic `gates` job. Admission binds
the first-party workflow path, event, source SHA, successful jobs, unexpired
artifact IDs and digests to one run. Evidence cannot be assembled from several
partially successful runs.

`prepare-native-release.yml` takes the exact release tag/SHA and a successful
full `candidate_run_id`. Each native runner restores its checked executable,
verifies the original byte hashes, restores executable permissions lost by
Actions artifact transport, and removes only the downloaded candidate packaging.
It never recompiles the application or launcher. Reviewed materials come from
`distribution/materials/<target>/` and must match every path, byte count and
hash in `distribution/release-materials.json` before they are copied.

The protected `native-release` environment owns finalization credentials.
Windows receives no Authenticode signing operation. macOS signs the C launcher
without runtime exceptions and the Bun executable with Bun 1.4.2's documented
entitlements, using Developer ID Application, hardened runtime and timestamps.
An isolated temporary keychain is removed after signing. The lane submits a ZIP
of the signed executables to Apple, retains the submission/log and hashes, and
requires Accepted status. It then verifies the raw-code notarization tickets.
Fresh native checks, final packaging and an actual archive installation follow;
macOS also rechecks the extracted signatures, Team ID and notarization tickets.
Final artifacts are retained for 90 days.

`publish-native-release.yml` separately takes the tag/SHA and successful
`final_run_id`. It requires all six retained final artifacts before the protected
publication job can start. Assembly and signing are deterministic; retries use
the same finalization run, never a new macOS signing pass. The deployed service
contract must accept the candidate before any release mutation. Publication
defaults to no discovery promotion; `beta` or `stable` must be selected explicitly.
Creating a missing channel requires the additional initialization input.
Expired final artifacts require a new reviewed preparation; if assets already
exist, mismatched replacements are refused. Retention expiry is not authority
to overwrite an existing release.

Production readiness still requires source-embedded Ed25519 trust, its protected
private key and key ID, reviewed runtime materials, the macOS Team ID in the
policy and shell bootstrap, and the protected macOS certificate/notary setup.
Environment protections and release metadata branch permissions must also be
verified. These workflows do not provision credentials, certify material
completeness, or authorize publication. Release-please creates the native CLI tag and a draft release, then dispatches
finalization using the successful full CI run ID. Native publication and channel
promotion remain explicit operations. npm publication accepts only protocol and
installer tags; it cannot publish the Node-based CLI package.

Apple's documented raw-code check is `codesign -vvvv -R=notarized
--check-notarization`. `spctl` execution assessment targets app bundles and can
reject a valid standalone CLI as not app-like. Neither a notarization receipt
nor an ordinary CI execution proves a fresh quarantined download launches on a
User's Mac. That separate acceptance check uses the shipped archive on a clean
Mac and the documented Terminal invocation. Raw executables and ZIPs cannot be
stapled; this distribution needs Apple's online ticket lookup on first use.
Sources: [Apple DTS testing guide](https://developer.apple.com/forums/thread/130560),
[Apple Gatekeeper guidance](https://developer.apple.com/forums/thread/706379),
[Bun 1.4.2 signing guide](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/guides/runtime/codesign-macos-executable.mdx),
[Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

## Optional npm bootstrap

The separate `@raidiant/notifai-install` package exposes `notifai-install` and has
no install lifecycle scripts. Installing the package alone never installs or
updates the runtime. Explicit invocation resolves the OS account's owned
installation first. A fresh installation verifies Ed25519 release metadata,
archive digests and admitted members before executing the native installer;
macOS also requires Apple's raw-code notarization check. The native CLI owns
PATH, initialization, runtime updates and rollback for every bootstrap route.

Node 20.12 or later is required only to run this optional bootstrap. The installed
CLI does not need Node. `npm update` updates the bootstrap package; `notifai update`
updates the runtime. Removing the bootstrap package leaves the runtime intact.
The bootstrap's version is independent of the runtime version, and `--version`
selects an exact runtime version. A prerelease needs `--channel beta` explicitly.

Candidate CI verifies the packed bootstrap on all six native runners and checks
the minimum Node version on Linux x64. Publication refuses an empty embedded trust
map and requires a resolvable signed stable default on all supported targets.
`installer-v*` tags use the protected `npm-release` environment and package-specific
npm trusted publishing. First configure that package's publisher; do not reuse
an npm token or assume another package's trust configuration covers it.
