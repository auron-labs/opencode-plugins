# Changelog

## [0.2.0](https://github.com/auron-labs/opencode-plugins/compare/@auron-labs/opencode-impeccable-v0.1.0...@auron-labs/opencode-impeccable-v0.2.0) (2026-08-03)


### Features

* add impeccable ([e0d0e94](https://github.com/auron-labs/opencode-plugins/commit/e0d0e94be9eec35239e80fa150e4eff1c50b5f58))

## 0.1.0 (unreleased)

First public release of the Impeccable native plugin.

- Registers 23 `/impeccable-*` commands plus a `/impeccable` router menu.
- Exposes 14 typed tools (`impeccable_context`, `impeccable_detect`, `impeccable_doctor`, `impeccable_install`, `impeccable_update`, `impeccable_check`, `impeccable_pin`, `impeccable_hooks_*`, `impeccable_ignores`) that replace every `Bash(npx impeccable *)` and `Bash(node …/scripts/…)` call the upstream skill used to make.
- Wires a post-edit detector hook via `tool.execute.after` that runs `impeccable detect` on `.tsx`, `.jsx`, `.html`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`, `.sass`, `.less`, `.ts`, and `.js` writes and surfaces findings as `tui.toast.show` toasts.
- Vendors 33 reference playbooks (plus a rewritten `SKILL.md`) under `references/`. Reference sync is automated via `scripts/sync-impeccable-upstream.mjs`.
- Tracks the canonical upstream skill path (`.agents/skills/impeccable/reference/*.md`) so the plugin does not depend on the OpenCode-specific dist branch.
