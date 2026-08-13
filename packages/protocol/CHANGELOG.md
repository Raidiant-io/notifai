# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## [Unreleased]

## [0.4.0] - 2026-08-13

### Added

- SubmitFeedbackRequest and SubmitFeedbackResponse for consented feedback, including an optional gzip+base64 log slice.

## [0.3.0] - 2026-08-12

### Added

- Additive submission protocol updates required by CLI 0.4.0.

## [0.2.0] - 2026-08-09

### Changed

- **BREAKING** A reply request carries a question set instead of a single kind/choices pair. The old reply shape is rejected.

## [0.1.2] - 2026-08-08

### Added

- Account-access status.
- Companion-device support bridge.
- Notification-defaults schema changes.

## [0.1.1] - 2026-08-05

### Added

- Receipt and setup contract fields needed by the first published CLI.

## [0.1.0] - 2026-08-05

### Added

- First public release of the client-visible wire contract.

[unreleased]: https://github.com/Raidiant-io/notifai/compare/protocol-v0.4.0...HEAD
[0.4.0]: https://github.com/Raidiant-io/notifai/compare/protocol-v0.3.0...protocol-v0.4.0
[0.3.0]: https://github.com/Raidiant-io/notifai/compare/protocol-v0.2.0...protocol-v0.3.0
[0.2.0]: https://github.com/Raidiant-io/notifai/compare/protocol-v0.1.2...protocol-v0.2.0
[0.1.2]: https://github.com/Raidiant-io/notifai/compare/protocol-v0.1.1...protocol-v0.1.2
[0.1.1]: https://github.com/Raidiant-io/notifai/compare/protocol-v0.1.0...protocol-v0.1.1
[0.1.0]: https://github.com/Raidiant-io/notifai/releases/tag/protocol-v0.1.0
