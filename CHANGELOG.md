# [1.5.0](https://github.com/ayhid/claude-dev-workflow/compare/v1.4.0...v1.5.0) (2026-08-28)


### Features

* **ingest:** add dev.mjs assess and dev.mjs ingest ([#29](https://github.com/ayhid/claude-dev-workflow/issues/29)) ([2b82a4f](https://github.com/ayhid/claude-dev-workflow/commit/2b82a4f7d7bbd612abb876ce0999869786cbe9b8))
* **ingest:** assess a project's stage, and model documentation as claims ([#29](https://github.com/ayhid/claude-dev-workflow/issues/29)) ([b282548](https://github.com/ayhid/claude-dev-workflow/commit/b2825481534c3da0726f7f48234741ad806b860d))

# [1.4.0](https://github.com/ayhid/claude-dev-workflow/compare/v1.3.0...v1.4.0) (2026-08-28)


### Features

* **no-ticket:** ask which issue tracker before anything else ([c89f356](https://github.com/ayhid/claude-dev-workflow/commit/c89f356f2bda4b89271cdfc9473cae72eb1cf0db))

# [1.3.0](https://github.com/ayhid/claude-dev-workflow/compare/v1.2.0...v1.3.0) (2026-08-28)


### Features

* **metrics:** let /dev-done report whether the criteria passed first time ([#28](https://github.com/ayhid/claude-dev-workflow/issues/28)) ([933854f](https://github.com/ayhid/claude-dev-workflow/commit/933854ff6025d5dab3e7bc8a208bb965c0143bda))
* **metrics:** record every ticket transition to a local log ([#28](https://github.com/ayhid/claude-dev-workflow/issues/28)) ([a98891f](https://github.com/ayhid/claude-dev-workflow/commit/a98891f9ef670111bae8e460ed0fcef90a2fea34))
* **recovery:** add dev.mjs abandon and dev.mjs resume ([#28](https://github.com/ayhid/claude-dev-workflow/issues/28)) ([348eaf0](https://github.com/ayhid/claude-dev-workflow/commit/348eaf0056060256163c1228b97d0d2b0609de57))
* **recovery:** add the abandon rung and the git it needs ([#28](https://github.com/ayhid/claude-dev-workflow/issues/28)) ([d33e316](https://github.com/ayhid/claude-dev-workflow/commit/d33e3167ecc3312bc91185f8d617b465cbb2f234))
* **standup:** add dev.mjs standup ([#28](https://github.com/ayhid/claude-dev-workflow/issues/28)) ([b3f3d21](https://github.com/ayhid/claude-dev-workflow/commit/b3f3d2199f648656ad423b0e0f18b228dab8574d))
* **standup:** decide and render the board, and share one scanner ([#28](https://github.com/ayhid/claude-dev-workflow/issues/28)) ([9ffe207](https://github.com/ayhid/claude-dev-workflow/commit/9ffe207824aa657026096fdaa4226aebbad448ab))

# [1.2.0](https://github.com/ayhid/claude-dev-workflow/compare/v1.1.0...v1.2.0) (2026-08-17)


### Features

* **status:** report where the work stands ([#25](https://github.com/ayhid/claude-dev-workflow/issues/25)) ([b78937f](https://github.com/ayhid/claude-dev-workflow/commit/b78937fdb76c3baa40d3bcd2574b6b2a775b23ef))

# [1.1.0](https://github.com/ayhid/claude-dev-workflow/compare/v1.0.2...v1.1.0) (2026-08-17)


### Features

* **note:** save durable project knowledge while working ([#24](https://github.com/ayhid/claude-dev-workflow/issues/24)) ([55ae03b](https://github.com/ayhid/claude-dev-workflow/commit/55ae03b8ee93c895e2e51f59a04bfd84384710fe))

## [1.0.2](https://github.com/ayhid/claude-dev-workflow/compare/v1.0.1...v1.0.2) (2026-08-16)


### Bug Fixes

* **install:** show none rather than undefined for a blank answer ([#18](https://github.com/ayhid/claude-dev-workflow/issues/18)) ([68f4529](https://github.com/ayhid/claude-dev-workflow/commit/68f45290b22ee466d953d12c304d014c641d3ca2))

## [1.0.1](https://github.com/ayhid/claude-dev-workflow/compare/v1.0.0...v1.0.1) (2026-08-16)


### Bug Fixes

* **no-ticket:** authenticate npm publishes with trusted publishing ([3375a13](https://github.com/ayhid/claude-dev-workflow/commit/3375a132ed32c8af13475d5c3e97af38b7c9b996))

# 1.0.0 (2026-08-16)


### Bug Fixes

* brace only multi-word state values, and surface the real error ([bb96c4e](https://github.com/ayhid/claude-dev-workflow/commit/bb96c4eff33f36f635ddaaca6b44c27574c92733))
* **core:** let each backend own its project-identity check ([#1](https://github.com/ayhid/claude-dev-workflow/issues/1)) ([5b79ec7](https://github.com/ayhid/claude-dev-workflow/commit/5b79ec737b529e6ddfe96855c30f5799a9dabf54))
* **create:** warn when an explicit issue type cannot be stored ([#3](https://github.com/ayhid/claude-dev-workflow/issues/3)) ([ee8be26](https://github.com/ayhid/claude-dev-workflow/commit/ee8be262aba84fbe0aa06c4ffd8de9c8be571fcf))
* invoke the commit hook via bash and document it in the manifest ([7ff735a](https://github.com/ayhid/claude-dev-workflow/commit/7ff735a500f82143ecdde25a325d035399ef8e13))
* **sync:** report the issue-id shape, not a null project key ([#2](https://github.com/ayhid/claude-dev-workflow/issues/2)) ([9e2f243](https://github.com/ayhid/claude-dev-workflow/commit/9e2f243d1d6ef1ef690e06c70e0f19d9dafccf17)), closes [#123](https://github.com/ayhid/claude-dev-workflow/issues/123)


### Features

* add an interactive @clack/prompts installer ([1e8322e](https://github.com/ayhid/claude-dev-workflow/commit/1e8322e81e32e480cc121f4543ca5207e67d2ed4))
* add yt-sync.sh, a reconciler for issue state drift ([86dea86](https://github.com/ayhid/claude-dev-workflow/commit/86dea86678e7ce800a82d8e08597f7b531f6250f))
* extract the YouTrack ticket workflow into a portable plugin ([93b3de8](https://github.com/ayhid/claude-dev-workflow/commit/93b3de88bafdc405d2ba6894ed3307a44d5e6751))
* **land:** deliver onto a branch other than the fork point ([#6](https://github.com/ayhid/claude-dev-workflow/issues/6)) ([2df964c](https://github.com/ayhid/claude-dev-workflow/commit/2df964c8e34df92ccdf18f8c086c013c24acc685))
* **no-ticket:** add git delivery commands and repo release tooling ([2ec0baf](https://github.com/ayhid/claude-dev-workflow/commit/2ec0bafea8567c03755108ce0dd8da4df408540e))
* **no-ticket:** let an installed project update itself ([e9df455](https://github.com/ayhid/claude-dev-workflow/commit/e9df45592394e4b7ae3d044d6fc71fa588fc5f50))

# Changelog

Maintained by [semantic-release](https://semantic-release.gitbook.io) from the commit history —
edit the commits, not this file. Releases before 2.0.0 predate the automation and are not listed
here; see the git history for those.
