# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## [6.0.8](https://github.com/Raidiant-io/notifai/compare/protocol-v6.0.7...protocol-v6.0.8) (2026-08-31)

## [6.0.7](https://github.com/Raidiant-io/notifai/compare/protocol-v6.0.6...protocol-v6.0.7) (2026-08-31)

## [6.0.6](https://github.com/Raidiant-io/notifai/compare/protocol-v6.0.5...protocol-v6.0.6) (2026-08-31)


### Bug Fixes

* **protocol:** restore publish contract ordering ([#124](https://github.com/Raidiant-io/notifai/issues/124)) ([6426c64](https://github.com/Raidiant-io/notifai/commit/6426c644bc02fe9c6f68afb98f0be52b0133d9ce))

## [6.0.5](https://github.com/Raidiant-io/notifai/compare/protocol-v6.0.4...protocol-v6.0.5) (2026-08-31)


### Bug Fixes

* **cli:** prevent service contract skew ([458e817](https://github.com/Raidiant-io/notifai/commit/458e817c4e0a134a1febdb3d42606bced21fe112))

## [6.0.4](https://github.com/Raidiant-io/notifai/compare/protocol-v6.0.3...protocol-v6.0.4) (2026-08-30)


### Bug Fixes

* **cli:** resolve Codex session titles without Orca ([#118](https://github.com/Raidiant-io/notifai/issues/118)) ([aabaaf4](https://github.com/Raidiant-io/notifai/commit/aabaaf4b000b7427681d2f2ad878505ff608aeb1))

## [6.0.3](https://github.com/Raidiant-io/notifai/compare/protocol-v6.0.2...protocol-v6.0.3) (2026-08-30)


### Bug Fixes

* **cli:** support Node 20.12 and minimize package contents ([#108](https://github.com/Raidiant-io/notifai/issues/108)) ([316691b](https://github.com/Raidiant-io/notifai/commit/316691bac1e33562a6c95f76bed56a9d84201623))

## [6.0.2](https://github.com/Raidiant-io/notifai/compare/protocol-v6.0.1...protocol-v6.0.2) (2026-08-29)


### Bug Fixes

* **cli:** harden launch reliability ([dc34f5d](https://github.com/Raidiant-io/notifai/commit/dc34f5d20531bc8ea75b7f2cfcd884203bc4cefd))
* **cli:** stop pairing on the real no-access blocker ([#101](https://github.com/Raidiant-io/notifai/issues/101)) ([6a8f07d](https://github.com/Raidiant-io/notifai/commit/6a8f07d91d1e90553ae57725076973d9f6a605d8))

## [6.0.1](https://github.com/Raidiant-io/notifai/compare/protocol-v6.0.0...protocol-v6.0.1) (2026-08-29)

## [6.0.0](https://github.com/Raidiant-io/notifai/compare/protocol-v5.0.2...protocol-v6.0.0) (2026-08-28)


### ⚠ BREAKING CHANGES

* require Node 22 and defer Windows CI ([#90](https://github.com/Raidiant-io/notifai/issues/90))

### Features

* align Agent Session naming and avatar revisions ([#95](https://github.com/Raidiant-io/notifai/issues/95)) ([cc764b1](https://github.com/Raidiant-io/notifai/commit/cc764b195129c8a14eee6c49e043d055417c553f))
* custom notification sounds — catalog refs, canonical WAV, silent library sync ([#94](https://github.com/Raidiant-io/notifai/issues/94)) ([c0b072c](https://github.com/Raidiant-io/notifai/commit/c0b072ce8aced01bdef25444eab1f60785684da7))
* require Node 22 and defer Windows CI ([#90](https://github.com/Raidiant-io/notifai/issues/90)) ([30a8a22](https://github.com/Raidiant-io/notifai/commit/30a8a22b0cb7df8448cee61b55d8593d24c13fdf))


### Bug Fixes

* restore meaningful sessions and mobile sound contracts ([#96](https://github.com/Raidiant-io/notifai/issues/96)) ([764c040](https://github.com/Raidiant-io/notifai/commit/764c0408d9152676d8ec102532cb2d600313ec92))

## [5.0.2](https://github.com/Raidiant-io/notifai/compare/protocol-v5.0.1...protocol-v5.0.2) (2026-08-28)

## [5.0.1](https://github.com/Raidiant-io/notifai/compare/protocol-v5.0.0...protocol-v5.0.1) (2026-08-27)


### Bug Fixes

* publish canonical Project and Agent Session language ([e4a44b0](https://github.com/Raidiant-io/notifai/commit/e4a44b01520fdc35f9b1d31024a2ce4c9f1adbc1))

## [5.0.0](https://github.com/Raidiant-io/notifai/compare/protocol-v4.1.0...protocol-v5.0.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* **protocol:** begin-pairing requests must include confirmation_hash, and dashboard pairing actions require the full code and confirmation secret.
* notification drafts and evidence snapshots no longer carry an `event` field.

### Features

* **protocol:** require proof for pairing actions ([#69](https://github.com/Raidiant-io/notifai/issues/69)) ([ad3d5dc](https://github.com/Raidiant-io/notifai/commit/ad3d5dc593ae7248abb487a0574b5af9ada99506))
* remove send --event and the protocol event field ([#67](https://github.com/Raidiant-io/notifai/issues/67)) ([7dde05f](https://github.com/Raidiant-io/notifai/commit/7dde05f6161fc3474a637c71abe47d54aacf50a9))


### Bug Fixes

* **cli:** pin signed-in origin and redact sensitive local logs ([#59](https://github.com/Raidiant-io/notifai/issues/59)) ([7dffafb](https://github.com/Raidiant-io/notifai/commit/7dffafb1e2ebbc307adb99ab9638e8ad3787e776))
* make user-resumable blockers answerable ([#62](https://github.com/Raidiant-io/notifai/issues/62)) ([22e78b5](https://github.com/Raidiant-io/notifai/commit/22e78b5b66c7a1eb2a39ca78675e21a1e82459a9))
* name press-and-hold on closed-choice iPhone banners ([#68](https://github.com/Raidiant-io/notifai/issues/68)) ([419c7f8](https://github.com/Raidiant-io/notifai/commit/419c7f8d389889662fad45f516fd0cef33c3e344))

## [4.1.0](https://github.com/Raidiant-io/notifai/compare/protocol-v4.0.0...protocol-v4.1.0) (2026-08-24)


### Features

* add Android protocol and CLI support ([cccc3d1](https://github.com/Raidiant-io/notifai/commit/cccc3d185cbac499651709dbd34d61fd847e9570))
* add Android protocol and CLI support ([faf2e23](https://github.com/Raidiant-io/notifai/commit/faf2e234b393a2edfbad60cb50c1da18025309fd))

## [4.0.0](https://github.com/Raidiant-io/notifai/compare/protocol-v3.0.0...protocol-v4.0.0) (2026-08-20)


### ⚠ BREAKING CHANGES

* remove the sessionLabelFromId protocol export.

### Features

* use semantic session names ([4920cd3](https://github.com/Raidiant-io/notifai/commit/4920cd35acfdc101455d52e8502fe50df3845e79))


### Bug Fixes

* **cli:** harden frozen session labels ([cbb619f](https://github.com/Raidiant-io/notifai/commit/cbb619ff3e4a361ff0544c27b3d8b6101c9ecdda))

## [3.0.0](https://github.com/Raidiant-io/notifai/compare/protocol-v2.0.0...protocol-v3.0.0) (2026-08-18)


### ⚠ BREAKING CHANGES

* **compatibility:** the protocol lifecycle vocabulary no longer includes superseded.
* **protocol:** Device registration no longer accepts the reply protocol integer.

### Features

* **compatibility:** preserve baseline delivery across client skew ([f5fe1d1](https://github.com/Raidiant-io/notifai/commit/f5fe1d1c7c5c7b1f80906d01e3b23a1061ba7f1c))
* **protocol:** negotiate named client capabilities ([873973b](https://github.com/Raidiant-io/notifai/commit/873973b98c4d91ed585ac85b6ac8abd267573f01))

## [2.0.0](https://github.com/Raidiant-io/notifai/compare/protocol-v1.0.0...protocol-v2.0.0) (2026-08-16)


### ⚠ BREAKING CHANGES

* `notifai send` now requires --kind. The account preference `agent_acknowledgements_enabled` is renamed to `agent_acknowledgement_text_enabled` and governs only the written reply.

### Features

* make kind required and carry attention, and always acknowledge an answer ([07e7c21](https://github.com/Raidiant-io/notifai/commit/07e7c216d52f3041e50ce5c7ec1ce4a3f8491e64))

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
