# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## [Unreleased]

## [1.0.1] - 2026-08-13

### Fixed

- Codex hook installation writes inline `[hooks]` in `config.toml`. It does not create the legacy `hooks.json`.
- Hook installation is one scope: project or machine-global, not both. A project install is a no-op when global already covers the machine.

## [1.0.0] - 2026-08-13

### Removed

- **BREAKING** Service origin is no longer a user setting. The compiled default and the origin stored on the credential stay; override only with `--base-url` or `NOTIFAI_BASE_URL`.
- **BREAKING** Personal project preferences leave the project tree and live under the user config directory, keyed by project root.

### Added

- A bounded, consented slice of the local log can be packed for feedback.
- Test notifications are sent by kind rather than by inventing a sound.
- The agent skill walks setup itself and treats `--sound` / `--level` as overrides.
- Every detected harness is installed instead of picking one.
- The interactive app offers labeled hooks install and uninstall.

### Fixed

- Codex hooks are written in the layer's existing representation.
- Readiness work that cannot change the next action is skipped.
- Unfinished import changes from the skill rewrite are dropped.
- Setup closes are short.

## [0.5.1] - 2026-08-13

### Fixed

- Republished the 0.5.0 source. The previous tarball carried 0.4.0's compiled output, so agent-wake modules never reached npm.

## [0.5.0] - 2026-08-13

### Added

- Answers now reach the agent that asked without the user returning to the terminal.
- Asynchronous Claude Code Stop hook: it returns at once and posts the answer into the same session over its inbox socket.
- Codex Stop hook continues the turn directly, and resumes a stopped thread only behind a writer-lock probe.

### Removed

- **BREAKING** Presence gate and the held-turn budget. `require_idle`, `away_after_seconds`, and `hook_reply_timeout_seconds` are gone rather than deprecated.

### Changed

- A registered question must carry a commitment to the work each answer resumes, and that commitment must not name where the answer arrives.

## [0.4.0] - 2026-08-12

### Added

- Agent-facing local logs.
- Crash-safe question continuation.
- Additive submission protocol updates required by the current CLI.

## [0.3.0] - 2026-08-10

### Added

- Interactive app.
- Self-describing settings: a config schema that documents and validates itself, and a themed presentation layer for the banner, help, and config views.

## [0.2.1] - 2026-08-09

### Added

- Question queue: asks never supersede each other; only replies supersede replies.

### Fixed

- `init` no longer stops at a routing pointer that has not fired yet.

## [0.2.0] - 2026-08-09

### Changed

- **BREAKING** A reply request carries a set of 1–4 questions instead of a single kind/choices pair.
- **BREAKING** One `--choice` flag per answer. The comma delimiter is gone.

### Added

- Free-text or closed questions, multi-select, and typed answers beside choices.
- `--detail` / `--detail-file`, and `ask --form` for several questions as one form.

## [0.1.8] - 2026-08-08

### Changed

- Human-facing product spelling is Notifai.
- Protocol dependency advanced to 0.1.2.

## [0.1.7] - 2026-08-05

### Changed

- Release engineering and companion-install guidance.

## [0.1.6] - 2026-08-05

### Added

- Native skills setup composed into `init`.

## [0.1.5] - 2026-08-05

### Added

- Release pin verification.

## [0.1.4] - 2026-08-05

### Added

- Pinned skill installer source.

## [0.1.3] - 2026-08-05

### Changed

- Portable, time-bounded release checks.

## [0.1.2] - 2026-08-05

### Fixed

- CLI package installable from npm.

## [0.1.1] - 2026-08-05

### Added

- Receipt-backed setup.

## [0.1.0] - 2026-08-05

### Added

- First public release of the `notifai` CLI under Apache-2.0.

[unreleased]: https://github.com/Raidiant-io/notifai/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Raidiant-io/notifai/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Raidiant-io/notifai/compare/v0.5.1...v1.0.0
[0.5.1]: https://github.com/Raidiant-io/notifai/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Raidiant-io/notifai/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Raidiant-io/notifai/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Raidiant-io/notifai/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Raidiant-io/notifai/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Raidiant-io/notifai/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/Raidiant-io/notifai/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Raidiant-io/notifai/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Raidiant-io/notifai/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Raidiant-io/notifai/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Raidiant-io/notifai/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Raidiant-io/notifai/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Raidiant-io/notifai/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Raidiant-io/notifai/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Raidiant-io/notifai/releases/tag/v0.1.0
