# Finding or installing Notifai

A shell opened before installation can have an old PATH. First check the
existing per-user launcher: `~/.notifai/bin/notifai` on macOS/Linux, or
`$HOME\.notifai\bin\notifai.exe` in PowerShell. On POSIX,
`~/.local/bin/notifai` (or the configured `XDG_BIN_HOME` command directory)
is normally its command link. Use an existing launcher by absolute path and
run `doctor --json`; follow its diagnosis before changing the installation.
A missing PATH entry alone does not require reinstalling or restarting an
Agent Session. Never execute a repository-supplied binary as this launcher.

If there is no native installation, use the official OS bootstrap. It needs
no Node, npm, Bun or Git. Download the bootstrap only from `notifai.sh` over
HTTPS; native updates verify signed release metadata. Read the downloaded script
before executing it. Preserve the User's channel choice; beta requires explicit
`--channel beta` (shell) or `-Channel beta` (PowerShell). If the chosen channel
is unavailable, report that and ask before selecting another channel.

macOS/Linux, from a temporary directory outside the repository:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://notifai.sh/install.sh \
  --output install.sh
```

After inspection, run `sh install.sh --no-init --json`, adding the authorized
channel flag when needed. `--no-init` separates runtime installation from the
User-owned setup choices in the main skill.

Windows PowerShell, from a temporary directory outside the repository:

```powershell
Invoke-WebRequest -Uri 'https://notifai.sh/install.ps1' -OutFile install.ps1
```

After inspection, run `& ./install.ps1 -NoInit -Json`, adding the authorized
channel flag when needed. Preserve the User's execution policy; report an
execution-policy block instead of changing it.

Use the absolute command printed by the installer for `--version` and
`doctor --json`, then continue setup under the main skill. Future updates use
`notifai update`, which keeps the saved channel. An installer failure remains
incomplete; use its reported recovery rather than installing a second runtime.

## Optional Node/npm launcher

The existing-name `@raidiant/notifai` launcher is an optional route, only after
its replacement package and matching native artifacts are verified as published:

```sh
npx --yes @raidiant/notifai@latest init
# Or keep an npm launcher on PATH:
npm install -g @raidiant/notifai
notifai init
```

Requires Node.js 20.12 or newer for this launcher. Notifai installs its own native
runtime. Use `notifai update` for runtime updates. npm upgrades only the launcher;
`npm uninstall -g @raidiant/notifai` removes only that launcher. The runtime remains
until `notifai uninstall` completes its pending-work and owner checks.

A fresh explicit `init` or `install` acquires the signed native release matching
the launcher version/source, including a beta launcher's beta runtime. Existing
native installations keep their version and saved channel. `@version` pins
launcher code, not an existing runtime. Help, version, doctor and ordinary
commands never acquire or recreate a missing runtime. Hooks use the stable
native path; resident Session Attendants retain their immutable native runtime.
Neither depends on an NPX cache, so deleting that cache does not remove the
installed runtime or its retained owners.

## Migrate an old installation

An identified old Node-based `@raidiant/notifai` application is different from
the native launcher. Never update its package in place while residents still
use its files. The native installer's `--migrate-npm` / `-MigrateNpm` stages native
files while preserving that package; it does not complete the conversion.
Follow the reported repair assessment: establish the affected app's command and
state root, verify and back up the package, and prepare the selected signed npm
launcher. The agent owns replacement through a trusted compatible npm at the
same prefix, after pending work drains and any necessary User-approved producer
pause is observed. Preserve unknown or modified files and unresolved readers.
Do not uninstall first, kill sessions, or give the User an uninstall/reinstall
chore. Preparation and a successful npm exit do not prove runtime or hook readiness.

For an unchanged Windows global npm application, use the verified standalone
candidate's `install --migrate-npm` repair modes. Run `install --help` for flags.
The first supported manager is administrator-installed Node in Program Files
with npm 11; other toolchains remain diagnosed rather than implicitly trusted.

1. Observe the affected shell's ordinary command, including alias/function
   precedence, and its actual Notifai state roots. A fresh external shell does
   not establish those facts. Record a local JSON observation with `schema: 1`,
   `source: "affected-shell"`, `consumer: "windows-direct-cli"`, absolute
   `command` and `prefix`, `state_roots`, and `producers` containing each named
   producer's `executable`, `pid` and `start` (`windows-filetime:<integer>`).
   Use physical prefix/state roots. If a packaged app reports a different
   logical command path, retain it as `command` and record the physical mapping
   proved in that app as `physical_command`; do not infer the mapping externally.
   Include every producer that can launch the old command. Embedded consumers,
   wrappers, remote storage and unestablished roots need separate assessment;
   do not label them direct CLI use to make the check pass.
2. Prepare with `--prepare --scope <file> --node <absolute-node.exe>
   --artifact <adapter.tgz>`. The selected signed inventory authenticates both
   the adapter and its paired native runtime. Preparation preserves the old
   package and dependencies, does not activate the new runtime, and reports the
   exact operation directory and confirmation digest.
3. Arrange the necessary pause through an answerable User question. Name the
   producers that must remain stopped and the exact prepared replacement,
   including installed dependencies. Approval supplies consent, not proof that
   processes stopped or questions settled. Do the work for the User once that
   approval and readiness exist.
4. Resume the same candidate with `--resume <operation> --confirm <digest>`.
   The CLI rechecks the manager, named producers, possible JavaScript readers
   (including sandbox accounts), state roots and pending work before npm runs.
   Keep the approved pause through native activation and command verification.
   A pending result preserves the operation; resolve its named condition and
   resume it. Do not uninstall first, discard the backup, select another target
   during recovery or treat an empty process scan as the maintenance window.
5. Reopen producers only after `npm_repair_complete`. Verify their ordinary
   command and run `update --resume --json` for changed owned integrations.
   `doctor` and `update --resume` report pending npm operations but never execute
   them automatically.

Upgrade an older native runtime through its existing native route before adding
a new global npm launcher. If the launcher was added first and the runtime cannot
recognize it, follow the verified exact-prefix remedy: remove only that launcher,
update the existing native command by absolute path, then reinstall the launcher.
Never remove an entire global bin directory or unrelated PATH entries. Verified
global and NPX launchers can lead to one runtime; unknown or modified commands
still need the diagnosis's explicit remedy.
