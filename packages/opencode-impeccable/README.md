# @auron-labs/opencode-impeccable

A self-contained OpenCode port of [pbakaus/impeccable](https://github.com/pbakaus/impeccable). It provides the `/impeccable` menu, 24 implementation commands, typed workflow tools, and automatic design checks after edits.

The plugin vendors a version-locked upstream snapshot. It runs upstream’s native Rust engine from a platform-specific optional dependency. Its hidden primary implementation agent inherits the user's OpenCode permissions instead of forcing read-only access.

## Install

```bash
bun add @auron-labs/opencode-impeccable
```

Add the plugin to OpenCode's configuration if your installation does not do so automatically:

```json
{
  "plugin": ["@auron-labs/opencode-impeccable"]
}
```

OpenCode v2 uses:

```json
{
  "plugins": ["@auron-labs/opencode-impeccable"]
}
```

Both versions load the same package. Restart OpenCode after changing plugin configuration.

## Requirements

- OpenCode v1 1.18.29 or newer, or OpenCode v2.
- Keep optional dependencies enabled so the native engine installs for Linux/macOS (x64 or arm64), or Windows (x64). On other platforms, provide a compatible Rust engine with `binary` or `IMPECCABLE_BIN`.

The Impeccable engine runs directly without Node or `npx`; the plugin itself uses OpenCode’s JavaScript runtime.

No standalone Impeccable CLI installation is required.

## Commands

`/impeccable` opens the context-aware router. The plugin also registers these implementation commands:

```text
/impeccable-craft       /impeccable-shape       /impeccable-init
/impeccable-document    /impeccable-extract     /impeccable-critique
/impeccable-audit       /impeccable-polish      /impeccable-bolder
/impeccable-quieter     /impeccable-distill     /impeccable-harden
/impeccable-onboard     /impeccable-animate     /impeccable-colorize
/impeccable-typeset     /impeccable-layout      /impeccable-delight
/impeccable-overdrive   /impeccable-clarify     /impeccable-adapt
/impeccable-optimize    /impeccable-live        /impeccable-generate
```

Each command runs through a hidden, capable primary Impeccable agent. Four upstream specialist agents—asset production, finish review, design-system documentation, and live copy-edit application—are also registered as subagents for the playbooks that require independent handoffs. These agents use the permissions already configured by the user; the plugin does not force a read-only policy or inspect global OpenCode configuration to second-guess those permissions.

## Native tools

The plugin exposes 35 typed tools so upstream playbooks never need `npx impeccable` or raw `node .../scripts` commands. They cover:

- reference and project context loading;
- detection, doctor, CSP, and ignore workflows;
- safe project-local command pinning;
- hook status, configuration, and suppressions;
- concept seeds, critique storage, surface briefs, image prompts, and image generation;
- the complete live-design server, polling, resume, completion, insertion, and wrapping workflow.

Install, update, and version-check tools are intentionally absent. Updating the OpenCode plugin updates its coherent runtime snapshot.

Filesystem-bearing `impeccable_*` arguments are confined to the active worktree: absolute paths, `../` traversal, and symlink escapes outside it are rejected before any Rust engine runs. Detector and critique-storage targets also accept `http:`/`https:` URLs where documented. For intentional operations on external paths, use OpenCode's own permission-aware file tools instead.

## Post-edit detector

After `write`, `edit`, `multiedit`, `patch`, or `apply_patch`, the plugin passes every touched project file to the bundled upstream hook. The full detector pass runs against supported UI targets and appends its feedback directly to the current tool output as a `<system-reminder>`.

The hook is fail-open: runtime failures never turn a successful edit into a failed edit, and the user receives at most one warning per session until the session becomes idle. Upstream `.impeccable/config.json` and `.impeccable/config.local.json` settings—including `hook.enabled`, quiet mode, and ignore rules—remain authoritative. Use the `impeccable_hooks_*` and `impeccable_ignores` tools to manage them.

## Options

The plugin normally needs no options. A custom native Rust engine executable can be supplied when necessary (OpenCode v1):

```json
{
  "plugin": [
    ["@auron-labs/opencode-impeccable", {
      "binary": "/absolute/path/to/impeccable"
    }]
  ]
}
```

For v2, use `"plugins": [{ "package": "@auron-labs/opencode-impeccable", "options": { "binary": "/absolute/path/to/impeccable" } }]`. `IMPECCABLE_BIN` is honored when `binary` is unset. The former `nodePath` / `IMPECCABLE_NODE` options no longer apply.

## Upstream snapshot

[`upstream-lock.json`](./upstream-lock.json) records the exact Impeccable commit, skill version, and native engine version used by the package. The snapshot includes the upstream skill source, references, launcher, browser assets, and Apache license under `vendor/impeccable/`. The engine is supplied by pinned `@impeccable/cli-*` optional dependencies.

From this package directory:

```bash
bun run sync        # update managed files, native dependency versions, and snapshot lock
bun install         # update the workspace dependency lockfile after syncing
bun run sync:check  # compare all managed files with the immutable locked commit
```

Sync refuses truncated GitHub trees, downloads the snapshot as one coherent unit, and removes stale managed files.

## License

The plugin source is MIT licensed. Vendored Impeccable files retain the upstream Apache License 2.0 in `vendor/impeccable/LICENSE`.
