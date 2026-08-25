# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## [9.0.0](https://github.com/Raidiant-io/notifai/compare/v8.0.0...v9.0.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* **cli:** publishing now requires a verified protocol release before the CLI is published, and npm >= 11.5.1.
* remote media and approval URLs must satisfy the stated trust policy; hosts outside it require an explicit User-owned origins exception.
* **protocol:** begin-pairing requests must include confirmation_hash, and dashboard pairing actions require the full code and confirmation secret.
* notification drafts and evidence snapshots no longer carry an `event` field.

### Features

* **cli:** ask one project-or-machine setup scope ([#66](https://github.com/Raidiant-io/notifai/issues/66)) ([bedc0ea](https://github.com/Raidiant-io/notifai/commit/bedc0ea82aa428b2fe63dd03cf8092d0d813bc6d))
* hold hostile repository input to a stated trust policy ([#70](https://github.com/Raidiant-io/notifai/issues/70)) ([1568768](https://github.com/Raidiant-io/notifai/commit/15687686eed3f74f5f0f6d4d8a9e49b50de4bebc))
* **protocol:** require proof for pairing actions ([#69](https://github.com/Raidiant-io/notifai/issues/69)) ([ad3d5dc](https://github.com/Raidiant-io/notifai/commit/ad3d5dc593ae7248abb487a0574b5af9ada99506))
* remove send --event and the protocol event field ([#67](https://github.com/Raidiant-io/notifai/issues/67)) ([7dde05f](https://github.com/Raidiant-io/notifai/commit/7dde05f6161fc3474a637c71abe47d54aacf50a9))


### Bug Fixes

* **cli:** default the service origin to https://api.notifai.sh ([#60](https://github.com/Raidiant-io/notifai/issues/60)) ([8063d20](https://github.com/Raidiant-io/notifai/commit/8063d2040caaa1c09fe7cdb2f5f7302f86221bad))
* **cli:** drop the terminal-timing rule from when-to-notify guidance ([d0a653b](https://github.com/Raidiant-io/notifai/commit/d0a653bdea43b9bc3872fb5beef3fdc434e0b444))
* **cli:** drop the terminal-timing rule from when-to-notify guidance ([0c1ed8e](https://github.com/Raidiant-io/notifai/commit/0c1ed8e40fe4470ebcab49d13663c704cf6056ed))
* **cli:** keep machine credentials out of argv and harden trusted publishing ([#71](https://github.com/Raidiant-io/notifai/issues/71)) ([a03d85c](https://github.com/Raidiant-io/notifai/commit/a03d85ccba6fc36d378168feeb5297103065e62e))
* **cli:** keep the bin runnable and harden doctor, send, and Codex hooks ([#64](https://github.com/Raidiant-io/notifai/issues/64)) ([d7f2d7b](https://github.com/Raidiant-io/notifai/commit/d7f2d7b612d27e426c328284e2f72d0723b0ae43))
* **cli:** pin signed-in origin and redact sensitive local logs ([#59](https://github.com/Raidiant-io/notifai/issues/59)) ([7dffafb](https://github.com/Raidiant-io/notifai/commit/7dffafb1e2ebbc307adb99ab9638e8ad3787e776))
* **cli:** restore question pushes after a spent Stop waiter ([9e5e43d](https://github.com/Raidiant-io/notifai/commit/9e5e43dd5f943eddc3cb3ca285b188e988903660))
* **cli:** restore question pushes after a spent Stop waiter ([89f6d76](https://github.com/Raidiant-io/notifai/commit/89f6d76e6569190cbd04120f922ecf284a89798c))
* harden proactive Notifai activation ([#63](https://github.com/Raidiant-io/notifai/issues/63)) ([e486d22](https://github.com/Raidiant-io/notifai/commit/e486d224a5261ba039ba26494a9fdf8b74711817))
* **hooks:** retire questions without reserved client events ([#65](https://github.com/Raidiant-io/notifai/issues/65)) ([154fd11](https://github.com/Raidiant-io/notifai/commit/154fd1116d7a5b79aeabc8cb1b897262e6953d9c))
* **hooks:** survive a node upgrade that moves the pinned runtime ([#61](https://github.com/Raidiant-io/notifai/issues/61)) ([0c19acb](https://github.com/Raidiant-io/notifai/commit/0c19acb62d42d3ae95ebe489e56839a5a3ad4ec4))
* make user-resumable blockers answerable ([#62](https://github.com/Raidiant-io/notifai/issues/62)) ([22e78b5](https://github.com/Raidiant-io/notifai/commit/22e78b5b66c7a1eb2a39ca78675e21a1e82459a9))
* name press-and-hold on closed-choice iPhone banners ([#68](https://github.com/Raidiant-io/notifai/issues/68)) ([419c7f8](https://github.com/Raidiant-io/notifai/commit/419c7f8d389889662fad45f516fd0cef33c3e344))
* trigger Notifai guidance consistently ([#58](https://github.com/Raidiant-io/notifai/issues/58)) ([ddf1f94](https://github.com/Raidiant-io/notifai/commit/ddf1f94db6a282b081302e03cd17b204d0231ed1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @raidiant/notifai-protocol bumped from 4.1.0 to 5.0.0

## [8.0.0](https://github.com/Raidiant-io/notifai/compare/v7.0.2...v8.0.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* **cli:** an explicit --session-label no longer overrides a session title supplied by the environment.
* **cli:** the canonical body of a registered question no longer begins with the question text when context is provided.
* **cli:** the notify_criteria config key is removed. Its role is now the when-to-notify guidance topic.
* **cli:** `send --reply --json` prints a single `reply_result` object with the receipt embedded; the standalone receipt line is gone. The `--no-block` flag is removed.
* **cli:** send no longer accepts --reply-choice or --reply-multi; use --choice and --multi.

### Features

* add Android protocol and CLI support ([cccc3d1](https://github.com/Raidiant-io/notifai/commit/cccc3d185cbac499651709dbd34d61fd847e9570))
* add Android protocol and CLI support ([faf2e23](https://github.com/Raidiant-io/notifai/commit/faf2e234b393a2edfbad60cb50c1da18025309fd))
* **cli:** make session labels environment-neutral for agents ([8df8198](https://github.com/Raidiant-io/notifai/commit/8df8198c658ff4c9ce1cee0354f5d966d902bb12))
* **cli:** one reply_result object from send --reply --json ([928a980](https://github.com/Raidiant-io/notifai/commit/928a9804e05605a6a6b1cb9098c356ccef678080))
* **cli:** replace generated fallback session names with later semantic ones ([66bd4a7](https://github.com/Raidiant-io/notifai/commit/66bd4a76bc947283d9dd3c4a807afc4b380c1d0c))
* **cli:** replace generated fallback session names with later semantic ones ([52fe546](https://github.com/Raidiant-io/notifai/commit/52fe54690f51ef17fab0c1d69da440a29332f6a9))
* **cli:** replace notify_criteria with layered guidance topics ([7d80708](https://github.com/Raidiant-io/notifai/commit/7d807089e02eba2f32a35fb6cad9eff8b75aaecc))
* **cli:** spell send's question flags --choice/--multi like ask ([5437816](https://github.com/Raidiant-io/notifai/commit/54378163994866f2239f033605bcf0041dce40fb))


### Bug Fixes

* **cli:** stop repeating a question in the notification body ([3e9acb7](https://github.com/Raidiant-io/notifai/commit/3e9acb76b65cae0d1f654657b38b53a4c8a23912))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @raidiant/notifai-protocol bumped from 4.0.0 to 4.1.0

## [7.0.2](https://github.com/Raidiant-io/notifai/compare/v7.0.1...v7.0.2) (2026-08-20)


### Bug Fixes

* stop a session instruction becoming persisted notify_criteria ([457d519](https://github.com/Raidiant-io/notifai/commit/457d519998230f7dd5623124305992e41048843f))
* stop a session instruction becoming persisted notify_criteria ([05cda30](https://github.com/Raidiant-io/notifai/commit/05cda30cbc81e35d81ba603b256312b3383ac49d))

## [7.0.1](https://github.com/Raidiant-io/notifai/compare/v7.0.0...v7.0.1) (2026-08-20)


### Bug Fixes

* **cli:** infer Orca session titles ([a4eb4fd](https://github.com/Raidiant-io/notifai/commit/a4eb4fd91f769291ff603918bb1fa33035a31918))
* **cli:** infer Orca session titles ([f0c7d06](https://github.com/Raidiant-io/notifai/commit/f0c7d0621ff6f5b6961d7dfaeaf12ddc6e968ada))
* **cli:** keep update recovery local and specific ([0bf4356](https://github.com/Raidiant-io/notifai/commit/0bf4356f8ced5e5296669e3b2165f62483c4a8b9))
* **cli:** keep update recovery local and specific ([e555d40](https://github.com/Raidiant-io/notifai/commit/e555d40d07ede4e1c0c9f45b702327d39730c51d))

## [7.0.0](https://github.com/Raidiant-io/notifai/compare/v6.0.0...v7.0.0) (2026-08-20)


### ⚠ BREAKING CHANGES

* remove the sessionLabelFromId protocol export.

### Features

* use semantic session names ([4920cd3](https://github.com/Raidiant-io/notifai/commit/4920cd35acfdc101455d52e8502fe50df3845e79))


### Bug Fixes

* **cli:** harden frozen session labels ([cbb619f](https://github.com/Raidiant-io/notifai/commit/cbb619ff3e4a361ff0544c27b3d8b6101c9ecdda))
* **cli:** restore generated session fallbacks ([74212e8](https://github.com/Raidiant-io/notifai/commit/74212e865cbb5af152399f691fc46a4713bacfdf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @raidiant/notifai-protocol bumped from 3.0.0 to 4.0.0

## [6.0.0](https://github.com/Raidiant-io/notifai/compare/v5.0.0...v6.0.0) (2026-08-18)


### ⚠ BREAKING CHANGES

* **compatibility:** the protocol lifecycle vocabulary no longer includes superseded.
* **protocol:** Device registration no longer accepts the reply protocol integer.

### Features

* **cli:** focus companion setup on iPhone ([77b9197](https://github.com/Raidiant-io/notifai/commit/77b91976182ded7e7722469c400ef2c238e738a2))
* **compatibility:** preserve baseline delivery across client skew ([f5fe1d1](https://github.com/Raidiant-io/notifai/commit/f5fe1d1c7c5c7b1f80906d01e3b23a1061ba7f1c))
* **protocol:** negotiate named client capabilities ([873973b](https://github.com/Raidiant-io/notifai/commit/873973b98c4d91ed585ac85b6ac8abd267573f01))


### Bug Fixes

* **cli:** preserve future session state on prompts ([2e18601](https://github.com/Raidiant-io/notifai/commit/2e186015e106a9559188e67230913fb25c56dfb5))
* **cli:** preserve future session state on prompts ([f70c885](https://github.com/Raidiant-io/notifai/commit/f70c88556539b13689c2669e43103056ef69b1c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @raidiant/notifai-protocol bumped from 2.0.0 to 3.0.0

## [5.0.0](https://github.com/Raidiant-io/notifai/compare/v4.0.0...v5.0.0) (2026-08-16)


### ⚠ BREAKING CHANGES

* `notifai send` now requires --kind. The account preference `agent_acknowledgements_enabled` is renamed to `agent_acknowledgement_text_enabled` and governs only the written reply.

### Features

* **cli:** report an ask registration as data, and stop init promising routing it lacks ([156159b](https://github.com/Raidiant-io/notifai/commit/156159b4d39b249a1be65ac86a9f7452ee9720d2))
* keep a question answerable for a day, and let the user choose ([ace207e](https://github.com/Raidiant-io/notifai/commit/ace207e04cfdc3a0ccda14dffc79a882a663034c))
* make kind required and carry attention, and always acknowledge an answer ([07e7c21](https://github.com/Raidiant-io/notifai/commit/07e7c216d52f3041e50ce5c7ec1ce4a3f8491e64))


### Bug Fixes

* clean up what the help, the README and a test comment were saying ([221ca6b](https://github.com/Raidiant-io/notifai/commit/221ca6b1d04a80cbd8473d54cd50a6024dcf6c50))
* **cli:** retire drafts the server rejects as invalid ([4023e42](https://github.com/Raidiant-io/notifai/commit/4023e42e3aeb9f8674239ab0516ccf2527b1428c))
* **cli:** retire drafts the server rejects as invalid ([d676726](https://github.com/Raidiant-io/notifai/commit/d6767265e4718102f7c97c6ee939073e79b038a2))
* **cli:** stop --reply-window advertising the default it no longer has ([b9eeabc](https://github.com/Raidiant-io/notifai/commit/b9eeabcbafd9a8e84d2aa86f44b04ca4ece237f2))
* give the detached waiter the wall clock its host already allows ([3d4b111](https://github.com/Raidiant-io/notifai/commit/3d4b111afb4d35bd8c04121deee82b849dd0ade1))
* **hooks:** never write a Codex hooks.json Notifai does not own ([8fdd00c](https://github.com/Raidiant-io/notifai/commit/8fdd00c6018915fe2164800c5797a9c3cb92da68))
* **hooks:** never write a Codex hooks.json Notifai does not own ([8948519](https://github.com/Raidiant-io/notifai/commit/894851942db6283ff856025e7f7d2dd86695013d))
* **hooks:** read the duplicate-representation warning as a sentence ([e0d041f](https://github.com/Raidiant-io/notifai/commit/e0d041f729e75a4c909f41c5dfafe6602f88edeb))
* **hooks:** read the duplicate-representation warning as a sentence ([936f068](https://github.com/Raidiant-io/notifai/commit/936f068d2587d56fc10a89a7d87c81c37ef50e2d))
* **hooks:** report a Codex dual representation only when Notifai is in both ([f4426dc](https://github.com/Raidiant-io/notifai/commit/f4426dc6e3876ac0a75f31ce5fb81c4ec2f4719d))
* **hooks:** report a Codex dual representation only when Notifai is in both ([2bab419](https://github.com/Raidiant-io/notifai/commit/2bab41987bf9fa251f71785b9881e3c8418be1bb))
* **hooks:** stop rewriting the whole of a user's Codex config.toml ([e037e22](https://github.com/Raidiant-io/notifai/commit/e037e227646178a0cbc08e7a00ab47129b3b435f))
* **hooks:** stop rewriting the whole of a user's Codex config.toml ([92ff189](https://github.com/Raidiant-io/notifai/commit/92ff1891c3f42092758af257ec3be8b68e51c0f1))
* let a question outlive the waiter that pushed it ([de242e7](https://github.com/Raidiant-io/notifai/commit/de242e753434dda87f665de6474491320fbc7365))
* **lock:** survive losing the rendezvous while registering ([2b5d46d](https://github.com/Raidiant-io/notifai/commit/2b5d46d5221b843fc2db5a803da561e3dbb3b7b0))
* **lock:** survive losing the rendezvous while registering ([efb8bd6](https://github.com/Raidiant-io/notifai/commit/efb8bd6f718f9f5e7e9bda1471cb88db0a77ef4c))
* reject an unknown --platform locally, the way send already does ([7ba7678](https://github.com/Raidiant-io/notifai/commit/7ba7678214cc3c98919ece2f533ed40f080951f3))
* report a failed image upload like every other API failure ([be76c48](https://github.com/Raidiant-io/notifai/commit/be76c4808e6c37bb97d64b14b018b148c4887d94))
* stop a busy session discarding the answer it was too busy to take ([13ce700](https://github.com/Raidiant-io/notifai/commit/13ce7003c393741b82886910cb51b18d0a9f1065))
* stop a turn-ending question expiring with the waiter that pushed it ([dd2cda6](https://github.com/Raidiant-io/notifai/commit/dd2cda6a339d711bc4c6723b93ccf940207565a7))
* stop a typed prompt erasing an outstanding acknowledgement ([ed15e18](https://github.com/Raidiant-io/notifai/commit/ed15e18fffd893ef0c5ad27bc17d4f78b0a88b6c))
* stop several surfaces stating things that are not true ([56402b9](https://github.com/Raidiant-io/notifai/commit/56402b98b763bdce2fb75c79f8502a92968a0abb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @raidiant/notifai-protocol bumped from 1.0.0 to 2.0.0

## [4.0.0](https://github.com/Raidiant-io/notifai/compare/v3.0.1...v4.0.0) (2026-08-15)


### ⚠ BREAKING CHANGES

* **cli:** `--detail` and `--detail-file` are removed; the one canonical Markdown body is `--body` / `--body-file`. `--session` is removed, replaced by `--session-id` and `--session-label`. `--image` is now a repeatable ordered collection (max 8) with `--image-alt` for alt text.

### Features

* add unified notification content and source context ([3e6479a](https://github.com/Raidiant-io/notifai/commit/3e6479ae22c64c6886c1e919ba3183486e408596))
* add unified notification content and source context ([2473ed5](https://github.com/Raidiant-io/notifai/commit/2473ed51df42b56652435c611a57f3751fa484f5))


### Bug Fixes

* attribute the unified-content break and propagate workspace dependency bumps ([cb438ce](https://github.com/Raidiant-io/notifai/commit/cb438cec76de9b393d7673554dc440a764887f76))
* **cli:** document replacements for the removed send flags ([44af905](https://github.com/Raidiant-io/notifai/commit/44af90536a1e6fa5af2ec6b58a19ea68f2d76b96))
* print server rejection details on command failures ([884fc78](https://github.com/Raidiant-io/notifai/commit/884fc78b62382ad23a49e1c5b92772dd1b8d574b))
* print server rejection details on command failures ([c9ec4e4](https://github.com/Raidiant-io/notifai/commit/c9ec4e45130784fff7b8ab4da560899eaddffcc5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @raidiant/notifai-protocol bumped from 0.6.0 to 1.0.0

## [3.0.1](https://github.com/Raidiant-io/notifai/compare/v3.0.0...v3.0.1) (2026-08-14)


### Bug Fixes

* **cli:** require protocol 0.6.0 ([fc0f956](https://github.com/Raidiant-io/notifai/commit/fc0f9565d5dff4d98829cfc4b468eb272e15ede1))
* **cli:** require protocol 0.6.0 ([afc60f1](https://github.com/Raidiant-io/notifai/commit/afc60f1b4f825fd12d24cc12a33abb002d8dc978))

## [3.0.0](https://github.com/Raidiant-io/notifai/compare/v2.0.2...v3.0.0) (2026-08-14)


### ⚠ BREAKING CHANGES

* **cli:** finalize media uploads before use

### Features

* **cli:** finalize media uploads before use ([6b6d334](https://github.com/Raidiant-io/notifai/commit/6b6d3344c9e997f0b66fb78274fab87692d9d92b))
* **protocol:** add billing error statuses ([f7cbca2](https://github.com/Raidiant-io/notifai/commit/f7cbca2663469776d079787fa3b608bcecd40f45))
* require authoritative media upload finalization ([1150ffe](https://github.com/Raidiant-io/notifai/commit/1150ffe18d004da4f9809be08f3b5875b31d3a21))

## [2.0.2](https://github.com/Raidiant-io/notifai/compare/v2.0.1...v2.0.2) (2026-08-14)


### Bug Fixes

* **cli:** preserve Codex hook representation ([0c03308](https://github.com/Raidiant-io/notifai/commit/0c03308cdc355bb1a84f8e5ef3daaeba51059fe6))

## [2.0.1](https://github.com/Raidiant-io/notifai/compare/v2.0.0...v2.0.1) (2026-08-14)


### Bug Fixes

* **cli:** require acknowledgement protocol at runtime ([bbec8ca](https://github.com/Raidiant-io/notifai/commit/bbec8ca386cd2a86c58a579daf70905d667865d5))
* **cli:** require acknowledgement protocol at runtime ([43f94cd](https://github.com/Raidiant-io/notifai/commit/43f94cde1a90b4ca4f5f0fce8356d4832c618216))

## [2.0.0](https://github.com/Raidiant-io/notifai/compare/v1.1.0...v2.0.0) (2026-08-13)


### ⚠ BREAKING CHANGES

* **cli:** hide the service URL, move personal prefs, and shorten setup closes

### Features

* **cli:** pack a bounded consented slice of the local log ([6fb3d68](https://github.com/Raidiant-io/notifai/commit/6fb3d68cd0057ab901c031c6012318fe464949a9))
* **cli:** send a test notification by kind, not by inventing a sound ([b90c8ed](https://github.com/Raidiant-io/notifai/commit/b90c8edcbf2ba98db09414701a309cef88aa1cc4))
* **cli:** support Windows and Linux harness workflows ([779ab6b](https://github.com/Raidiant-io/notifai/commit/779ab6b075900a7a431b809ddcb715fd80836688))
* compose native skills setup into init ([de6318a](https://github.com/Raidiant-io/notifai/commit/de6318a71166ef75774a217176f1e020116e177b))
* **skill:** make agents set Notifai up and skip sound/level unless overriding ([9ffd87c](https://github.com/Raidiant-io/notifai/commit/9ffd87c0c79e539f8b92e94ac453407d58bca30f))


### Bug Fixes

* **cli:** cover Windows terminal behavior ([cda7abd](https://github.com/Raidiant-io/notifai/commit/cda7abd134744b2cac44204dd3eb1b20b9038edc))
* **cli:** drop unfinished import changes from the skill rewrite ([2fd49b2](https://github.com/Raidiant-io/notifai/commit/2fd49b2ba4d4f218138da5dbc3455f1ac07adaf6))
* **cli:** hide the service URL, move personal prefs, and shorten setup closes ([5b9fe52](https://github.com/Raidiant-io/notifai/commit/5b9fe52d9dc5296e5c3b328a82682a36719d891b))
* **cli:** install hooks at one scope, not project and global ([f4cd237](https://github.com/Raidiant-io/notifai/commit/f4cd2376b57d9104fbcdcca83990ad9dfe09b296))
* **cli:** isolate Codex hooks and reply routing ([#1](https://github.com/Raidiant-io/notifai/issues/1)) ([d060b6a](https://github.com/Raidiant-io/notifai/commit/d060b6a18b5937d82f74619a6c1bc711243be26c))
* **cli:** keep Codex hook install on ~/.codex, ignore CODEX_HOME ([3f75f13](https://github.com/Raidiant-io/notifai/commit/3f75f131c24534d3813a336bb72422f78e24a972))
* **cli:** offer labeled hooks install and uninstall in the interactive app ([f93d0ae](https://github.com/Raidiant-io/notifai/commit/f93d0ae1c981694de6abb317f93f1647dd1d64fa))
* **cli:** preserve Codex hook trust on reinstall ([#3](https://github.com/Raidiant-io/notifai/issues/3)) ([5e2c2f4](https://github.com/Raidiant-io/notifai/commit/5e2c2f4d618276573f810a989f41a89ab1053564))
* **cli:** report observed setup receipts ([99d04bb](https://github.com/Raidiant-io/notifai/commit/99d04bbd487681db3023468fbd88b77a1ba13ceb))
* **cli:** skip readiness work that cannot change the next action ([7fc2295](https://github.com/Raidiant-io/notifai/commit/7fc2295e4a98b07f0116bad17ea93b8f98b265d1))
* **cli:** stabilize Linux portability checks ([1462693](https://github.com/Raidiant-io/notifai/commit/146269306ae3dfc91f3559cce802460d3e058925))
* **cli:** write Codex hooks in the layer's existing representation ([7589862](https://github.com/Raidiant-io/notifai/commit/758986296009c1d50bed66a79a5863ea977aa87e))
* **cli:** write Codex hooks to config.toml, not hooks.json ([3cc6bb8](https://github.com/Raidiant-io/notifai/commit/3cc6bb8bc9bb592ee4abce3f1421d7c0c6f56d32))
* make CLI package installable from npm ([67bd6be](https://github.com/Raidiant-io/notifai/commit/67bd6be77d648a12ff0d3036a5853b6a4391bebb))

## [1.1.0](https://github.com/Raidiant-io/notifai/compare/v1.0.1...v1.1.0) (2026-08-13)


### Features

* **cli:** support Windows and Linux harness workflows ([779ab6b](https://github.com/Raidiant-io/notifai/commit/779ab6b075900a7a431b809ddcb715fd80836688))


### Bug Fixes

* **cli:** cover Windows terminal behavior ([cda7abd](https://github.com/Raidiant-io/notifai/commit/cda7abd134744b2cac44204dd3eb1b20b9038edc))
* **cli:** isolate Codex hooks and reply routing ([#1](https://github.com/Raidiant-io/notifai/issues/1)) ([d060b6a](https://github.com/Raidiant-io/notifai/commit/d060b6a18b5937d82f74619a6c1bc711243be26c))
* **cli:** keep Codex hook install on ~/.codex, ignore CODEX_HOME ([3f75f13](https://github.com/Raidiant-io/notifai/commit/3f75f131c24534d3813a336bb72422f78e24a972))
* **cli:** preserve Codex hook trust on reinstall ([#3](https://github.com/Raidiant-io/notifai/issues/3)) ([5e2c2f4](https://github.com/Raidiant-io/notifai/commit/5e2c2f4d618276573f810a989f41a89ab1053564))
* **cli:** report observed setup receipts ([99d04bb](https://github.com/Raidiant-io/notifai/commit/99d04bbd487681db3023468fbd88b77a1ba13ceb))
* **cli:** stabilize Linux portability checks ([1462693](https://github.com/Raidiant-io/notifai/commit/146269306ae3dfc91f3559cce802460d3e058925))

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
