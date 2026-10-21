# Migrating an old npm installation

Read this when diagnosis identifies an old Node-based Notifai application or
a launcher that its native runtime cannot recognize.

An identified old Node-based `@raidiant/notifai` application is different from
the native launcher. Never update its package in place while residents still
use its files. The native installer's `--migrate-npm` / `-MigrateNpm` stages native
files while preserving that package; it does not complete the conversion.
Follow the reported repair assessment: establish the affected app's command and
state root, verify and back up the package, and prepare the selected signed npm
launcher. The agent owns replacement through a trusted compatible npm at the
same prefix, after pending work drains and any necessary User-approved producer
pause is observed. Tie each affected process to this package, its observed
command route or its recorded session state. Runtime names such as Node, Bun or
Deno do not establish that relationship. Leave unrelated applications running;
when safe replacement cannot be established, defer this replacement and preserve
the existing installation. Preserve unknown or modified files and unresolved readers.
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
   Include the applications observed to launch the old command, using exact
   process identities. Sharing a runtime executable is not a producer relationship.
   Embedded consumers,
   wrappers, remote storage and unestablished roots need separate assessment;
   do not label them direct CLI use to make the check pass.
2. Prepare with `--prepare --scope <file> --node <absolute-node.exe>
   --artifact <adapter.tgz>`. The selected signed inventory authenticates both
   the adapter and its paired native runtime. Preparation preserves the old
   package and dependencies, does not activate the new runtime, and reports the
   exact operation directory and confirmation digest.
3. Prefer the affected work finishing naturally. If interruption is necessary,
   arrange it through an answerable User question. Name the affected applications,
   the evidence connecting each to this package or state, and the exact replacement,
   including installed dependencies. Approval supplies consent, not proof that
   processes stopped or questions settled. Do the work for the User once that
   approval and readiness exist.
4. Resume the same candidate with `--resume <operation> --confirm <digest>`.
   The CLI rechecks the manager, named applications, direct readers and preloads
   of this package, state roots and pending work before npm runs. A process list
   is a scoped observation, not proof about arbitrary embedded imports or future
   launches. Unknown scope defers the replacement; it does not expand a pause
   to other applications or all JavaScript runtimes.
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

