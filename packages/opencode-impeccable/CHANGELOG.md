# Changelog

## [0.4.0](https://github.com/auron-labs/opencode-plugins/compare/@auron-labs/opencode-impeccable-v0.3.0...@auron-labs/opencode-impeccable-v0.4.0) (2026-08-15)


### Features

* improve impeccable integration ([3530c76](https://github.com/auron-labs/opencode-plugins/commit/3530c76892dcd0aa618ac2a73e1f66eaeab0d5c6))
* update impeccable vendor ([989c61b](https://github.com/auron-labs/opencode-plugins/commit/989c61ba191b16d8041982eaf7ead5949e91c3dc))


### Bug Fixes

* ts errors due to zod ([303c27a](https://github.com/auron-labs/opencode-plugins/commit/303c27a22f92e58cc0115f047665c470bbeb51f2))

## [0.3.0](https://github.com/auron-labs/opencode-plugins/compare/@auron-labs/opencode-impeccable-v0.2.0...@auron-labs/opencode-impeccable-v0.3.0) (2026-08-04)


### Features

* **impeccable:** import upstream implementation to keep sync ([099925f](https://github.com/auron-labs/opencode-plugins/commit/099925fe09518c2f0a61a6e8a67f0eea3d136b1e))

## [0.2.0](https://github.com/auron-labs/opencode-plugins/compare/@auron-labs/opencode-impeccable-v0.1.0...@auron-labs/opencode-impeccable-v0.2.0) (2026-08-03)


### Features

* add impeccable ([e0d0e94](https://github.com/auron-labs/opencode-plugins/commit/e0d0e94be9eec35239e80fa150e4eff1c50b5f58))

## 0.1.0 (unreleased)

First public release of the native Impeccable plugin.

- Registers `/impeccable` and 23 `/impeccable-*` implementation commands, plus four upstream specialist agents, without overriding user permissions.
- Vendors a version-locked upstream Impeccable snapshot, including its scripts and detector engine, so no separately installed CLI is required.
- Exposes 29 typed tools covering the upstream context, detector, configuration, image, critique, and live-design workflows.
- Runs the bundled upstream detector after supported edit tools and injects feedback directly into the current edit result.
- Preserves upstream hook configuration and ignores, fails open on runtime errors, and deduplicates runtime warnings per session.
- Replaces partial reference-only syncing with coherent, immutable snapshot synchronization and drift checks.
