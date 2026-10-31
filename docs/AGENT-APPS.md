# Agent app detection and setup status

`notifai doctor --json` retains its existing readiness fields and exit codes,
and adds `agent_apps`. Consumers feature-detect this property rather than
inferring support from a CLI version. An older CLI omits it; that means unknown,
not an empty supported list. Accept new IDs and gap IDs without rejecting a
report. The app list is complete for this CLI's `supported_ids`.

```json
{
  "agent_apps": {
    "supported_ids": ["claude-code", "codex", "cursor", "opencode", "openclaw", "hermes", "grok"],
    "apps": [
      {
        "id": "codex",
        "supported": true,
        "detected": true,
        "connected": false,
        "gaps": [
          {
            "id": "hooks-trust",
            "detail": "Codex has not approved the Notifai handlers",
            "remedy": {
              "by": "user-here",
              "summary": "Review the Notifai hooks in Codex",
              "command": "notifai doctor codex"
            }
          }
        ]
      }
    ]
  }
}
```

The example abbreviates `apps` to one row. `supported` means this CLI has an
integration; it does not promise every version or feature of that harness.
`detected` means executable presence under the rules below. `connected` means
the machine integration has current hooks, native trust where required,
loadable plugins and current guidance coverage, with no remaining setup gaps.
Detection and connection are independent: a removed app can leave current
configuration behind. An offer to connect uses `detected && !connected`.

`gaps` contains stable diagnostic IDs, a detail, and an optional existing
readiness `remedy` (`by`, `summary`, and, where appropriate, `command` and
`user_action`). A missing integration has `hooks-missing`; remaining gaps
include `hooks-stale`, `hooks-adapter`, `hooks-trust`, `hooks-stop-shape`,
`hooks-codex-representation`, `claude-code-hook-form`,
`hooks-obsolete-native-plugin`, `hooks-openclaw-plugin`,
`hooks-opencode-plugin`, `hooks-hermes-plugin`, and `skill`.
One app's gaps affect only that app. A shared adapter failure affects every
wired app. Unverifiable or missing skill coverage is a gap even if another
app loads a current copy. Session attendance, first-prompt evidence, Account
approval and device readiness remain in the existing readiness report and
do not determine this machine integration field. Trust remains harness-owned;
reading this report does not approve anything.

## Presence evidence

Discovery performs bounded filesystem checks; it never launches an agent app.
A candidate must resolve to a regular file and be executable by the current
OS User on POSIX. Windows candidates use `.exe`, `.cmd`, or `.bat`. Live
symlinks are followed; dangling links, directories, inaccessible files,
configuration folders and session environment markers do not establish presence.
Executable presence is not proof of sign-in, successful startup, compatible
runtime dependencies or a proven Question Routing capability.

All harnesses search absolute PATH entries, `~/.local/bin`, `~/.bun/bin`,
`~/.npm-global/bin`, `~/.local/share/pnpm`, and `~/bin`. They also honor
`PNPM_HOME`, `VOLTA_HOME/bin`, `BUN_INSTALL/bin` and `NPM_CONFIG_PREFIX/bin`
(or `npm_config_prefix`; on Windows the prefix itself). POSIX adds
`/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin` and
`/home/linuxbrew/.linuxbrew/bin`. Windows adds `%APPDATA%/npm` and
`%LOCALAPPDATA%/pnpm`. Relative PATH entries are ignored so a checkout cannot
select machine-wide integrations. No recursive search or shell evaluation is
performed. An unrecognized install location remains undetected.

| Harness | Command names | Additional executable candidates |
| --- | --- | --- |
| Claude Code | `claude` | `${CLAUDE_CONFIG_DIR:-~/.claude}/local/node_modules/.bin/claude`; macOS `Claude.app/Contents/MacOS/Claude` |
| Codex | `codex` | macOS `Codex.app/Contents/Resources/codex` and `ChatGPT.app/Contents/Resources/codex-cli/bin/codex`; Windows `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe` |
| Cursor | `cursor`, `cursor-agent` | macOS `Cursor.app/Contents/MacOS/Cursor`; Windows `%LOCALAPPDATA%/Programs/cursor/Cursor.exe` and `%ProgramFiles%/Cursor/Cursor.exe` (also x86) |
| OpenCode | `opencode` | `~/.opencode/bin/opencode` |
| OpenClaw | `openclaw` | Common command locations above |
| Hermes | `hermes` | `${HERMES_HOME:-~/.hermes}/hermes-agent/venv/bin/hermes` (`Scripts/hermes.exe` on Windows) |
| Grok | `grok` | Common command locations above |

macOS bundle candidates are checked under `/Applications` and `~/Applications`;
a bundle directory alone is insufficient. Windows uses `claude.cmd` for the
legacy npm Claude path and `opencode.exe` for OpenCode. Home selection follows
the CLI's existing Windows HOME/USERPROFILE rules. Configuration diagnosis
continues to use the active `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HERMES_HOME`,
`GROK_HOME`, `OPENCODE_CONFIG_DIR`, and OpenClaw home settings; these values
alone never indicate installation.

The native CLI location for Claude Code is documented in the
[Claude install FAQ](https://support.claude.com/en/articles/14554922-claude-code-user-faq);
Cursor documents `cursor-agent` and `~/.local/bin` in its
[installation guide](https://docs.cursor.com/en/cli/installation).

The standalone Windows Codex command location is documented in OpenAI's
[Windows deployment guide](https://learn.chatgpt.com/docs/enterprise/windows-deployment).
**Known detection gap:** a Windows ChatGPT app whose bundled Codex is not
available through one of these command locations remains undetected. Its
[Windows app guide](https://learn.chatgpt.com/docs/app/windows) confirms a
native Codex agent, but does not provide a stable bundled-executable path.
Discovery does not guess versioned WindowsApps or extracted-cache locations;
a configuration or cache directory alone cannot establish installation.

## Repeated setup and cross-version callers

Without `--apps`, init retains wired apps and recorded choices. A newly
detected app not previously declined reopens the selection, with existing
choices and new apps preselected. JSON reports the `apps` gap with
`technical.supported`, `technical.detected`, and `technical.preselected`;
callers fall back to `detected` with older CLIs. Choosing none is retained.
New choice records remember declines for apps detected when the choice was
made, so an app installed later can be offered. Legacy records contain only
the selected IDs, not historical presence. Non-interactive runs preserve their
exclusions; interactive runs offer detected apps missing from that old record
so the User can confirm or decline them. An explicit `--apps` selection can
also change them. Identical choices
leave the choice record unchanged.

`--apps` skips unknown IDs individually, prints an explanation to stderr,
and adds `skipped_apps: [{"id":"future-app","status":"unsupported"}]` to
the JSON result. Supported IDs continue through setup; an unknown-only list
does not overwrite a remembered choice. An older CLI can still reject unknown
IDs: callers using its fallback contract must send only IDs it understands.
