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
commands never acquire or recreate a missing runtime. Hooks and Session Attendants
use the stable native path, not an NPX cache; deleting that cache does not remove
the installed runtime.

## Migrate an old installation

An identified old Node-based `@raidiant/notifai` application is different from
the native launcher. Never update its package in place while residents still
use its files. Use the native installer's explicit `--migrate-npm` / `-MigrateNpm`
flow to stage native files while preserving the old package. Finish pending
questions and acknowledgements and resolve the reported legacy owners before
removing that exact package with the reported owning-prefix command. Rerun the
installer to finish setup. Do not kill sessions or delete data to force migration.

Upgrade an older native runtime through its existing native route before adding
a new global npm launcher. If the launcher was added first and the runtime cannot
recognize it, follow the verified exact-prefix remedy: remove only that launcher,
update the existing native command by absolute path, then reinstall the launcher.
Never remove an entire global bin directory or unrelated PATH entries. Verified
global and NPX launchers can lead to one runtime; unknown or modified commands
still need the diagnosis's explicit remedy.
