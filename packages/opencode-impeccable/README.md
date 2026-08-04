# @auron-labs/opencode-impeccable

A self-contained OpenCode port of [pbakaus/impeccable](https://github.com/pbakaus/impeccable). It provides the `/impeccable` menu, 23 implementation commands, typed workflow tools, and automatic design checks after edits.

The plugin vendors a version-locked upstream snapshot. It does not install or invoke a separate `impeccable` executable, and its hidden implementation agent inherits the user's OpenCode permissions instead of forcing read-only access.

## Install

```bash
opencode plugin @auron-labs/opencode-impeccable [--global]
```

Add the plugin to OpenCode's configuration if your installation does not do so automatically:

```json
{
  "plugin": ["@auron-labs/opencode-impeccable"]
}
```

Restart OpenCode after changing plugin configuration.

## Requirements

- OpenCode with plugin support.
- Node.js 22.18 or newer, matching the locked upstream runtime. The bundled JavaScript is launched directly by the plugin.

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
/impeccable-optimize    /impeccable-live
```

Each command delegates to a hidden, capable Impeccable subagent. Four upstream specialist agents—asset production, finish review, design-system documentation, and live copy-edit application—are also registered for the playbooks that require independent handoffs. These agents use the permissions already configured by the user; the plugin does not force a read-only policy or inspect global OpenCode configuration to second-guess those permissions.

## Native tools

The plugin exposes 29 typed tools so upstream playbooks never need `npx impeccable` or raw `node .../scripts` commands. They cover:

- reference and project context loading;
- detection, doctor, CSP, and ignore workflows;
- safe project-local command pinning;
- hook status, configuration, and suppressions;
- concept seeds, critique storage, surface briefs, image prompts, and image generation;
- the complete live-design server, polling, resume, completion, insertion, and wrapping workflow.

Install, update, and version-check tools are intentionally absent. Updating the OpenCode plugin updates its coherent runtime snapshot.

## Post-edit detector

After `write`, `edit`, `multiedit`, `patch`, or `apply_patch`, the plugin passes every touched project file to the bundled upstream hook. The full detector pass runs against supported UI targets and appends its feedback directly to the current tool output as a `<system-reminder>`.

The hook is fail-open: runtime failures never turn a successful edit into a failed edit, and the user receives at most one warning per session until the session becomes idle. Upstream `.impeccable/config.json` and `.impeccable/config.local.json` settings—including `hook.enabled`, quiet mode, and ignore rules—remain authoritative. Use the `impeccable_hooks_*` and `impeccable_ignores` tools to manage them.

## Options

The plugin normally needs no options. A custom Node executable can be supplied when necessary:

```json
{
  "plugin": [
    ["@auron-labs/opencode-impeccable", {
      "nodePath": "/absolute/path/to/node"
    }]
  ]
}
```

`IMPECCABLE_NODE` is also honored when `nodePath` is not set.

## Upstream snapshot

[`upstream-lock.json`](./upstream-lock.json) records the exact Impeccable commit and skill version used by the package. The snapshot includes the upstream skill source, references, runtime scripts, CLI engine modules, and Apache license under `references/` and `vendor/impeccable/`.

From this package directory:

```bash
bun run sync        # update all managed files and the lock to upstream main
bun run sync:check  # compare all managed files with the immutable locked commit
```

Sync refuses truncated GitHub trees, downloads the snapshot as one coherent unit, and removes stale managed files.

## License

The plugin source is MIT licensed. Vendored Impeccable files retain the upstream Apache License 2.0 in `vendor/impeccable/LICENSE`.
