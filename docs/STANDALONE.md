# Standalone CLI development

These commands build and inspect a candidate; they do not install it or
establish supported release targets. A native build becomes a release only
through the finalization and publication gates below, for its exact tag. The
GitHub Releases of this repository and the signed channel records say what is
actually published; this document does not restate it.

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
compilation. It embeds release identity and the skill, disables configuration
autoload, and writes a build receipt beside the executable. `self-check --json`
verifies build identity, process identity and skill integrity without service access or persistent
account/logging writes. It does not verify an OS signature or prove installation,
credentials, notification delivery, resident ownership, or update behavior.

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
reference. Updating the active pointer leaves the old owner running. A Claude
Code or Codex session open across an update hands its Session Attendant to the
installed runtime at the session's own next prompt or turn end; pending work
stays in session state, and the previous owner exits without ending the
session. A subagent's event never triggers that handoff. Native CI
exercises this ordering and continued execution with isolated fixture owners,
and executes a generated native hook command with a restricted PATH. These
checks do not establish real harness activation, provider delivery, complete
installer/update commands or legacy migration.

Compiled commands are admitted before configuration or logging writes. Portable
executables support installation, self-check, help, version and a read-only
installation diagnostic through `doctor`. Ordinary commands use the active
managed generation. A retired generation can enter only an existing retained
question owner or an exact Attendant recovery; ordinary invocations report the
active command to retry.

### Retired runtime cleanup

`notifai update --cleanup --json` explicitly inspects retired generations. It
preserves active, previous and stable-launcher builds, durable owners, builds
retired or resumed in the current boot, and uncertain ownership. Owner indexes
refer to the existing session files, including sessions using another state
directory. Session-file age cannot release those references. No hook takes a
per-process installation lease and cleanup does not stop a harness.

Linux uses the kernel's documented boot UUID. macOS and Windows currently report
`boot_identity_unknown` and retain old builds; file age and uptime never authorize
deletion. The JSON report gives each retained build's reason and verified byte
count. Long uptimes and uncertain owners can therefore retain several complete
runtime copies. Cleanup never forces a restart.

Deletion verifies the signed inventory and every remaining member. Modified or
additional files remain untouched. The inventory is removed last so an interrupted
deletion can be retried; an unverified or locked remainder is reported as
`cleanup_incomplete_or_unverified`. Unit checks exercise resumed owners and
separate state directories. The native runtime probe injects boot identities to
exercise real OS ownership and deletion adapters; it does not simulate a real
machine reboot or establish a boot-identity API on macOS or Windows.

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

`release-trust.ts` embeds the `notifai-release-2026-10` Ed25519 public key;
the private key is held only by the protected release environment.
Candidates fail closed; neither an environment override nor project configuration
can install a trust root. Focused tests use ephemeral signed inventories through
an explicit test seam. This does not establish live update or harness migration,
or publication readiness. Legacy npm cleanup requires an explicit package-manager action.

The uninstall preparation boundary inventories pending work across recorded
state roots and closes native launch admission with a recoverable journal.
It leaves questions, wiring and runtime files intact. The C launcher, direct
payload command admission and detached-owner path honor that barrier, and
Session Attendants withdraw through their existing lifecycle gate. The current
OpenClaw plugin also stops starting children and removes its readiness receipt
while admission is closed; it does not signal children during this drain.
Previously loaded plugins require separate proof before removal can finish.
`notifai uninstall --json` coordinates this lifecycle; `--cancel` can reopen
admission only before removal starts. Inspection includes orphan delivery/input sidecars and the
machine retirement queue in every discovered state root. Reported handoffs and
valid native acknowledgement receipts are history; unfinished work retains the
installation. No question is cancelled by inspection. The current native
OpenClaw adapter durably records actual host journal roots before publishing
journals, including custom host state directories and each writer host PID/start
identity. Source `hook-adapter` wrappers do not register as native hosts.
Inspection validates both
journal formats, pending pointer context, replay fences and interrupted writes;
it never replays, redacts or settles those journals. Inspection also inventories exact PID/start identities from resident claim files,
including orphan claims without a main session record. A claim guard or malformed
identity makes the inventory uncertain. Neither a clear work inventory nor a
missing claim proves resident absence; launch admission and native executable
observation must close that gap. Root discovery is not proof
that a host has drained. Previously loaded adapters without a root record still
require separate discovery and lifecycle proof before removal can proceed.

The native launcher also offers an internal, read-only executable-use probe for
explicit uninstall. Windows uses Restart Manager without shutdown or restart.
Linux compares executable device/inode through pinned `/proc` directory handles.
macOS uses a `sysctl` credential snapshot and the SDK's private `libproc` interface,
with process start-time revalidation around executable-path inspection. POSIX
scans cover this installation account's effective UID and the canonical
`notifai` / `notifai-runtime` kernel names. Supported entries resolve launcher
aliases and execute the canonical payload; the pinned Bun runtime preserves
that name. Device/inode comparison then establishes executable identity. This
is observation of supported native entries, not an inventory of arbitrary
renamed payloads or processes deliberately changing their kernel name. Other
accounts and root execution are outside the per-account installation boundary. Linux requires the
normal host process view; hidden or container-limited process views are not a
cross-host absence guarantee. macOS's private interface has no permanent API
stability guarantee. Unsupported, inaccessible or changed process evidence
for a matching candidate retains the installation. Unrelated process names
are excluded before executable inspection. These
bounded snapshots require closed launch admission. The removal-phase gate
rechecks pending work and recorded host/resident identities on both sides of
native file-use observation. It authenticates every installed runtime before
querying the OS and retains the installation on uncertain evidence. The
synchronous observation helper has exited before its PID is excluded; Windows
accepts only the Restart Manager detected-self flag (0x10) with that exact
helper PID present, while other restart flags remain uncertain; only the
foreground uninstaller itself and its exact Windows C parent are otherwise
exempt. Windows keeps their executing images for later external cleanup. Once
the journal enters removal, cancellation cannot reopen launch admission. A new
uninstaller can adopt an interrupted removal only after its previous PID/start
owner is proven gone. After repeating the absence gate, it releases only this
installation's durable runtime references under the existing session locks,
preserving all other Agent Session fields and checking the inspected bytes have
not changed. It never records SessionEnd as part of uninstall. Owned
teardown is supplied through the existing hook/skill integration boundary.
The completion operation removes owned PATH contributions and persists a
finite, hashed file plan before deleting any runtime files. POSIX deletes only
those verified files and empty directories, preserves unrelated entries and User
data, and can adopt an interrupted plan even after the active pointer is gone.
Modified files or a plan naming anything outside installation ownership retain
the installation. Windows stages an authenticated temporary launcher/runtime pair
and returns an inline PowerShell recovery command. Run it after the original
command exits. The copied runtime adopts the same finite plan and checks native
process absence before removing originals; PowerShell waits for that runtime to
exit before removing its verified temporary files. No scheduled task or execution
policy change is used. An interrupted cleanup retains its receipt and copies for
retry. This path is under native qualification; it is not publication evidence.

Session-state inspection on Windows accepts inherited ACLs only when the
current User owns the object and all write permissions belong to the User,
SYSTEM or Administrators. It never rewrites those ACLs. Managed installation
directories continue to require protected inheritance. Modified or unreadable
harness wiring and skill placements prevent runtime removal. Receipt-owned skills
are removed from all discovered state roots. Re-running the portable installer
authenticates its candidate first, then can cancel untouched preparation or
resume a persisted removal plan. Incomplete wiring teardown still needs the
uninstall command; Windows still returns its explicit cleanup command.

### Existing Windows directory permissions

Native filesystem operations use Windows extended paths, including UNC paths,
so deeply nested runtime-owner records do not depend on the machine's long-path
policy. The owner and access checks still apply to those paths.

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

macOS and Linux follow the XDG Base Directory convention for User commands,
like Claude Code's native installer, uv and pipx. The installer links
`notifai` into `$XDG_BIN_HOME`, or `~/.local/bin` when that is unset, pointing
at the stable `~/.notifai/bin/notifai`. Debian, Ubuntu and Fedora login shells
already search that directory, as does any shell its User configured to, so
most installations edit no startup file at all. The installer never replaces
another program's `notifai` there; that is reported as a conflict.

Only when the installing environment's `PATH` does not include the directory,
the installer adds one marked block to the login shell's own startup files, as
rustup and uv do: `.zshrc` and `.zprofile` for zsh, `.bashrc` plus the login
file Bash actually reads for bash, `.profile` for sh and dash, and an owned
`~/.config/fish/conf.d/notifai.fish` for fish. Any other shell, or zsh with a
custom `ZDOTDIR`, gets the exact directory to add and setup continues.
`--no-path` skips all of this.

A private ownership receipt precedes the link and each startup-file edit, so
interrupted setup resumes without duplicating them. Removal deletes only the
owned link and the exact owned blocks; User edits, a replaced command entry and
unowned markers are preserved and reported as conflicts. Atomic writes also
check the original content digest, including same-file concurrent edits.

This operation is explicit, never run by hooks, and never changes the current
parent shell. Windows uses the User `Path` registry adapter below instead.

## Local native installer command

A trusted compiled release exposes `install`, defaulting to the executable's
directory and its sibling signed `inventory.json`. `--directory` and
`--inventory` support previously obtained local files without a runtime download.
`--version <exact>` checks the application version; `--channel` explicitly
selects a channel. `--source shell|powershell|npm|manual` records the bootstrap
route without changing runtime update ownership. Repeated installation reuses
the healthy managed runtime and preserves its original route and channel.

The command refuses known PATH collisions and current-session pending work,
authenticates candidate bytes, makes the command reachable on PATH (below), then invokes
`init` through the verified installed immutable launcher. `--no-path` explicitly
keeps absolute-command use; `--no-init` installs without choosing account, skill
scope or harness setup. JSON distinguishes runtime installation from setup
readiness and retains a local recovery command after partial setup. Runtime
activation is never undone because approval or setup is pending.

Release trust and reviewed runtime materials are configured in source. A
build is still only a candidate until finalization and publication pass for
its exact tag; advertise an installation route only once its release exists.

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

The native launcher resolves that home from the POSIX account record or the
Windows process token's profile, independently of `HOME` and `USERPROFILE`.
The shared-hook guard must not use Bun's environment-derived `os.userInfo()`
home. A different environment home is rejected for installation and shared
wiring; full-CLI isolated installation proof needs a disposable OS account.

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
`distribution/release-materials.json` policy. That policy binds the approved
runtime materials for every target and the reviewed macOS team; see
[`distribution/README.md`](../distribution/README.md) for what the review
covers. Candidate materials cannot be signed for publication. Tests use synthetic
receipts/material policies and ephemeral keys, not production release authority.

`sign-release-records.mjs` produces deterministic Ed25519 envelopes compatible
with the installed verifier. Channel retries preserve identical signed bytes;
new records advance the sequence, retain withdrawals and require explicit
rollback authorization before recommending an older release. The provider writer
must still compare-and-swap the metadata ref and verify immutable published
assets before advancing a channel. Assembly alone performs no provider mutation.

### Resumable native publication

The publisher reads the exact signed bundle and confirms the tag's commit and
the draft identity. A draft has no by-tag address, so it finds the tag's single
release in the release list and reads that release by ID from then on.
Repository-wide immutability and the tag ruleset's bypass list need
administration access the job's token deliberately lacks: the release owner
checks them beforehand with
`node scripts/check-public-provider-posture.mjs --require-repository-immutability`,
and the job proves the outcome by reading the published release back as
immutable. It reuses matching
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
asset mismatch, stale heads, initial-ref races and no-write retries. Fixtures
are not evidence of a live publication; each release records its own.

`publish-native-release.mjs` is the protected-workflow entrypoint and requires
explicit `--publish` and/or `--promote` modes, an exact source/tag context, and
source-embedded trust keys. It preserves partial publication results if later
channel work fails.
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
full `candidate_run_id`. Admission also requires the immutable runtime source
release named by `distribution/runtime-sources.json` to be published with
every asset matching that manifest's size and SHA-256, so binaries are never
finalized before their corresponding source is available. Each native runner
restores its checked executable,
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

The source-embedded Ed25519 trust and shell bootstrap publisher are configured.
Production readiness also requires the matching protected private key and key
ID, reviewed runtime materials with the macOS Team ID, and the protected macOS
certificate/notary setup.
Environment protections and release metadata branch permissions must also be
verified. These workflows do not provision credentials, certify material
completeness, or authorize publication. Release-please creates the native CLI tag and a draft release, then dispatches
finalization using the successful full CI run ID. Native publication and channel
promotion remain explicit operations. The generated same-name npm adapter and
native artifacts share the CLI release version/source; publication tooling owns
their staged verification and promotion.

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

## Optional existing-name npm launcher

The generated `@raidiant/notifai` package exposes `notifai` as a small acquisition
and launch adapter, not a second Node product. There are no install lifecycle
scripts. Merely installing the package never installs or updates the runtime.
Explicit `init` or `install` authenticates the exact signed native release bound
to the adapter version/source, verifies the archive and admitted members, and
invokes the native installer. Fresh beta adapters acquire their matching beta
runtime; an existing installation retains its version and saved channel until
explicit native update or rollback.

Node.js 20.12 or newer is required only for this optional launcher. Runtime,
updates, retained generations, hooks and removal belong to the same native
Installation used by shell and PowerShell routes. `npm update` changes only the
launcher; `npm uninstall -g @raidiant/notifai` leaves the runtime intact.
`notifai uninstall` reports any remaining npm launcher and its exact cleanup
command. Pending transactions or unresolved owners block acquisition/removal.

Help, version, doctor and ordinary product commands never acquire missing native
files. Doctor reports adapter and runtime identity separately; equal versions
are not artifact proof. `@version` selects adapter code, not an existing runtime.
Hooks and resident work use the stable native command, never npm/NPX cache paths.
Do not advertise these candidate npm instructions until both the replacement
registry package and its matching native release have been verified.

## Moving from the npm CLI

The legacy Node-based `@raidiant/notifai` application is distinguished from the
new same-name native launcher by its artifact contract, not the package name.
An installer normally refuses another
`notifai` command on PATH. For one identified npm-global package, explicitly use
`--migrate-npm` (`-MigrateNpm` in PowerShell) to stage and authenticate the native
runtime while retaining the exact old package and shims. Multiple prefixes,
unknown shims and unrecognized package manifests require manual resolution.

This step reports `migration_pending_legacy_owners`, the exact prefix and npm
arguments, and exits nonzero. It does not run setup or claim the migration is
complete. Finish outstanding questions, answers and acknowledgements; resolve the
reported legacy owners without killing harnesses or faking acknowledgement; then
use that prefix's npm to
remove the legacy runtime package. Rerun the native installer to finish setup.
Older packages cannot prove all their resident owners are gone, so Notifai never
automatically removes them. An absent claim or an idle-looking process is not
that proof. This one-time package-manager action may require Node/npm; the new
runtime and its future updates do not.

Existing unreceipted or modified skills are preserved and reported with their
exact paths. Move those entries to a User-chosen backup before choosing new
bundled placements; the installer never guesses that an unrecorded directory is
safe to overwrite. Removing an npm package does not authorize erasing skills,
configuration, credentials or session history.

### Older native runtime with a new global launcher

Update the existing native runtime through its current native command before
adding a global npm launcher. If installed in the opposite order, the adapter
reports the exact verified prefix: remove only that new launcher, update the
native command by absolute path, then reinstall the launcher. NPX's verified
isolated command directory can be excluded for its child without dropping a
global directory containing other programs. Never treat a new verified adapter
as legacy Node migration or silently change the native version/channel.
