# @auron-labs/opencode-impeccable

Native OpenCode plugin for [pbakaus/impeccable](https://github.com/pbakaus/impeccable): 23 design commands as `/impeccable-*` sub-commands, typed tools that replace every `Bash(npx impeccable *)` call, and a post-edit detector hook. Vendors the upstream reference docs (with a rewritten `SKILL.md` that drops the Bash permission) so the LLM never has to shell out to a script.

## Install

```bash
opencode plugin @auron-labs/opencode-impeccable [--global]
```

## Requirements

- OpenCode installed and loading plugins from your config.
- The `impeccable` CLI installed and on `PATH` (or pass a custom `binary` option). The plugin shells out to it for `detect`, `doctor`, `install`, `update`, `check`, `pin`, and `ignores` commands.

## Usage

Add to your OpenCode config:

```json
{
  "plugin": [
    ["@auron-labs/opencode-impeccable", {}]
  ]
}
```

With options:

```json
{
  "plugin": [
    ["@auron-labs/opencode-impeccable", {
      "binary": "/Users/me/.local/bin/impeccable",
      "bootstrap": true
    }]
  ]
}
```

Restart OpenCode after changing plugin config.

## Commands

The plugin registers `/impeccable` plus 23 sub-commands (`/impeccable-audit`, `/impeccable-polish`, `/impeccable-critique`, …). Each sub-command dispatches to the bundled `impeccable` sub-skill whose prompt references the matching playbook under `references/`.

| Command | Reference |
|---------|-----------|
| `/impeccable` | `references/routing.md` (context-aware menu) |
| `/impeccable-craft` | `references/craft.md` (deprecated alias for new-work) |
| `/impeccable-shape` | `references/shape.md` |
| `/impeccable-init` | `references/init.md` |
| `/impeccable-document` | `references/document.md` |
| `/impeccable-extract` | `references/extract.md` |
| `/impeccable-critique` | `references/critique.md` |
| `/impeccable-audit` | `references/audit.md` (native: `audit.native.md`) |
| `/impeccable-polish` | `references/polish.md` |
| `/impeccable-bolder` | `references/bolder.md` |
| `/impeccable-quieter` | `references/quieter.md` |
| `/impeccable-distill` | `references/distill.md` |
| `/impeccable-harden` | `references/harden.md` |
| `/impeccable-onboard` | `references/onboard.md` |
| `/impeccable-animate` | `references/animate.md` |
| `/impeccable-colorize` | `references/colorize.md` |
| `/impeccable-typeset` | `references/typeset.md` |
| `/impeccable-layout` | `references/layout.md` |
| `/impeccable-delight` | `references/delight.md` |
| `/impeccable-overdrive` | `references/overdrive.md` |
| `/impeccable-clarify` | `references/clarify.md` |
| `/impeccable-adapt` | `references/adapt.md` (native: `adapt.native.md`) |
| `/impeccable-optimize` | `references/optimize.md` |
| `/impeccable-live` | `references/live.md` (web only) |

## Tools

Every `Bash(npx impeccable …)` and `Bash(node .opencode/skills/impeccable/scripts/…)` invocation the upstream skill asks the LLM to make is replaced by a typed tool:

| Tool | What it wraps |
|------|---------------|
| `impeccable_context` | Loads PRODUCT.md / DESIGN.md / surface brief / native platform guidance once per session. |
| `impeccable_detect` | Runs the 59 deterministic detector rules on files, directories, or URLs (`--json`, `--no-config`). |
| `impeccable_doctor` | Reports (and optionally repairs) drift between project Impeccable artifacts and the installed version. |
| `impeccable_install` | Installs the bundled CLI and skill files (`--scope=project|global`, `--force`). |
| `impeccable_update` | Refreshes the install to the latest version. |
| `impeccable_check` | Checks whether a newer version is available. |
| `impeccable_pin` | Creates or removes a standalone `/<command>` shortcut. |
| `impeccable_hooks_status` | Shows hook state, ignore rules, and env overrides. |
| `impeccable_hooks_toggle` | Enables or disables the post-edit hook (writes `hook.enabled`). |
| `impeccable_hooks_ignore_value` | Suppresses one rule+value combination (`--shared` / `--local`, optional `--files=`). |
| `impeccable_hooks_ignore_rule` | Suppresses a whole detector rule across the project. |
| `impeccable_hooks_ignore_file` | Suppresses every rule for one file. |
| `impeccable_hooks_reset` | Resets `.impeccable/config.json` and `config.local.json`. |
| `impeccable_ignores` | Lists, adds, or removes detector ignores via `impeccable ignores`. |

## Post-edit detector hook

The plugin registers a `tool.execute.after` hook that runs `impeccable detect` after every write/edit to a `.tsx`, `.jsx`, `.html`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`, `.sass`, `.less`, `.ts`, or `.js` file. Findings surface as `tui.toast.show` toasts and as `<system-reminder>` blocks on the next message. The hook is informational (it does not block writes) and respects `hook.enabled` / `hook.quiet` / `.impeccable/config.local.json`. Use `impeccable_hooks_toggle` or the `*_ignore_*` tools to manage it.

Native platform projects (`ios`, `android`, `adaptive`) skip the hook because the bundled detector is web-only.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `binary` | string | `impeccable` | Path to the upstream `impeccable` CLI binary |
| `bootstrap` | boolean | `true` | Best-effort lookup of the bundled binary on plugin load (never blocks) |
| `refsPath` | string | `<package>/references/SKILL.md` | Override the vendored SKILL.md location (rarely needed) |

## Vendoring references

Upstream references are vendored under `references/` (33 files plus the rewritten `SKILL.md`). Refresh with:

```bash
bun run sync          # from packages/opencode-impeccable/
bun run sync:check    # CI mode: exit non-zero on drift
```

The sync script discovers files via the GitHub tree API under `.agents/skills/impeccable/reference/*.md` and auto-deletes stale locals. `SKILL.md` is vendored locally (rewritten to drop Bash) and excluded from deletion.

## License

MIT for the plugin source. Vendored reference documents originate from pbakaus/impeccable under Apache License 2.0.