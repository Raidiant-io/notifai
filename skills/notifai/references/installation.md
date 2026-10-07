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
no Node, npm, Bun or Git. First execution trusts GitHub HTTPS; subsequent
updates verify signed release metadata. Read the downloaded script before
executing it. Preserve the User's channel choice; beta requires explicit
`--channel beta` (shell) or `-Channel beta` (PowerShell). If the chosen channel
is unavailable, report that and ask before selecting another channel.

macOS/Linux, from a temporary directory outside the repository:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://raw.githubusercontent.com/Raidiant-io/notifai/main/scripts/install.sh \
  --output install.sh
```

After inspection, run `sh install.sh --no-init --json`, adding the authorized
channel flag when needed. `--no-init` separates runtime installation from the
User-owned setup choices in the main skill.

Windows PowerShell, from a temporary directory outside the repository:

```powershell
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Raidiant-io/notifai/main/scripts/install.ps1' -OutFile install.ps1
```

After inspection, run `& ./install.ps1 -NoInit -Json`, adding the authorized
channel flag when needed. Preserve the User's execution policy; report an
execution-policy block instead of changing it.

Use the absolute command printed by the installer for `--version` and
`doctor --json`, then continue setup under the main skill. Future updates use
`notifai update`, which keeps the saved channel. An installer failure remains
incomplete; use its reported recovery rather than installing a second runtime.

The old `@raidiant/notifai` npm runtime is frozen. Installing it to repair PATH
can shadow the native CLI and restore old hook behavior. Existing npm users
need the native installer's explicit `--migrate-npm` / `-MigrateNpm` flow:
it preserves the old package and reports cleanup instructions. Finish pending
questions and acknowledgements and resolve its reported legacy owners before
removing that exact package. Do not kill sessions or delete data to force an
upgrade. The separate optional npm bootstrap is not a fallback unless its own
publication and prerequisites are verified.
