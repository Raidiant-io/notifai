# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## [1.0.0](https://github.com/Raidiant-io/notifai/compare/protocol-v0.6.0...protocol-v1.0.0) (2026-08-15)


### ⚠ BREAKING CHANGES

* **protocol:** `presentation.detail` is removed; `presentation.image` is replaced by the ordered `presentation.media` collection; the top-level `session` field is replaced by the structured `source` context; the APNs custom payload replaces `has_detail` with `media_count`.

### Features

* add unified notification content and source context ([3e6479a](https://github.com/Raidiant-io/notifai/commit/3e6479ae22c64c6886c1e919ba3183486e408596))
* add unified notification content and source context ([2473ed5](https://github.com/Raidiant-io/notifai/commit/2473ed51df42b56652435c611a57f3751fa484f5))


### Bug Fixes

* attribute the unified-content break and propagate workspace dependency bumps ([cb438ce](https://github.com/Raidiant-io/notifai/commit/cb438cec76de9b393d7673554dc440a764887f76))
* **protocol:** document the unified wire contract ([99053b5](https://github.com/Raidiant-io/notifai/commit/99053b5c7e6f0755bbba45d06bad048cfb98812e))

## [0.6.0](https://github.com/Raidiant-io/notifai/compare/protocol-v0.5.0...protocol-v0.6.0) (2026-08-14)


### Features

* **protocol:** add billing error statuses ([f7cbca2](https://github.com/Raidiant-io/notifai/commit/f7cbca2663469776d079787fa3b608bcecd40f45))
* **protocol:** expose media upload finalization ([290f050](https://github.com/Raidiant-io/notifai/commit/290f0507442ab3ac87ed57380273f8f5419b3616))
* require authoritative media upload finalization ([1150ffe](https://github.com/Raidiant-io/notifai/commit/1150ffe18d004da4f9809be08f3b5875b31d3a21))

## [0.5.0](https://github.com/Raidiant-io/notifai/compare/protocol-v0.4.1...protocol-v0.5.0) (2026-08-13)


### Features

* **protocol:** add feedback submit request and response types ([2ad392d](https://github.com/Raidiant-io/notifai/commit/2ad392d4989e157be85b087950d31659224144f3))


### Bug Fixes

* **cli:** isolate Codex hooks and reply routing ([#1](https://github.com/Raidiant-io/notifai/issues/1)) ([d060b6a](https://github.com/Raidiant-io/notifai/commit/d060b6a18b5937d82f74619a6c1bc711243be26c))

## [0.4.1](https://github.com/Raidiant-io/notifai/compare/protocol-v0.4.0...protocol-v0.4.1) (2026-08-13)


### Bug Fixes

* **cli:** isolate Codex hooks and reply routing ([#1](https://github.com/Raidiant-io/notifai/issues/1)) ([d060b6a](https://github.com/Raidiant-io/notifai/commit/d060b6a18b5937d82f74619a6c1bc711243be26c))

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
