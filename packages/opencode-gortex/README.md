# @auron-labs/opencode-gortex

OpenCode v2 integration for [Gortex](https://github.com/zzet/gortex). Checks the CLI at startup, initializes the current project, tracks it, and registers its MCP server.

## Setup

Install the [Gortex CLI](https://github.com/zzet/gortex/blob/main/docs/installation.md) separately. The plugin searches PATH, `GORTEX_INSTALL_DIR`, and standard installation locations, including `~/.local/bin`, Homebrew prefixes, and Windows `%LOCALAPPDATA%/Programs/gortex`. OpenCode v2 is required.

This package is under development in this workspace. To try it locally:

```bash
bun install --frozen-lockfile
bun run --filter @auron-labs/opencode-gortex build
```

Add the built plugin to your OpenCode v2 configuration, replacing the absolute path:

```json
{
  "plugins": [
    {
      "package": "file:///absolute/path/to/packages/opencode-gortex/dist/index.js",
      "options": {
        "binary": "gortex",
        "installSkills": false,
        "communityRouting": false
      }
    }
  ]
}
```

Restart OpenCode. The `gortex` MCP server should appear in its MCP list. Run `gortex repos --json` from the project to verify tracking.

## Options

| Option | Default | Behavior |
| --- | --- | --- |
| `binary` | `"gortex"` | Automatically discover Gortex, or override with another executable name or path. The resolved path is used for startup, tracking, skill installation, and MCP. |
| `installSkills` | `false` | Install Gortex's curated OpenCode skills in this project's `.opencode/skills/` and reload skills. Existing skill files are preserved. |
| `communityRouting` | `false` | Add guidance to agent system prompts to discover communities through Gortex MCP and route each task to relevant community members and files. |

The two switches are independent. Community routing queries the current graph at task time; it does not generate community skill files or edit `AGENTS.md`.

## Startup behavior

Before running any Gortex command, the plugin resolves symlinks and validates the opened directory. It must contain a recognized project manifest (for example, `package.json`, `Cargo.toml`, `go.mod`, or `pyproject.toml`) or be a verified Git root, including a linked worktree. A manifest must be a regular file. Open the project root; the plugin does not search parent or child folders for projects.

Home, its ancestors, filesystem root, broad top-level folders, system directories, and private directories such as `.ssh`, `.aws`, and `.config` are rejected even if they contain project markers. Symlinks to those directories are also rejected. `.gortex/` and `.opencode/` alone never qualify a folder as a project. Rejection stops startup before CLI calls, project writes, skills, routing, or MCP registration.

For an accepted project, the plugin runs `gortex version`, creates the `.gortex/` marker with a self-scoping `.gitignore`, and runs the idempotent `gortex track <directory>`. Tracking and MCP use the same validated canonical path. Tracking updates Gortex's user-level workspace and may auto-start its shared daemon. Indexing can continue in the background; agents must check graph readiness.

These checks govern what this plugin starts or registers. They do not remove repositories already tracked in Gortex's shared workspace or change an existing user-configured MCP server. A previously tracked home directory needs separate cleanup before starting that daemon.

MCP registration uses the v2 API with `gortex mcp --index <directory>` and the current directory as its working directory. An existing `gortex` MCP entry, including a disabled entry, is preserved.

Skill installation runs `gortex install` for the OpenCode adapter in a temporary home and copies only its `SKILL.md` files into the project. Hooks, commands, machine-wide OpenCode configuration and telemetry changes from that setup remain in the temporary directory, which is removed afterward. CLI setup requires support for `--agents`, `--no-hooks`, `--no-claude-md`, `--no-telemetry`, and `--json`.

Disabling either option prevents future installation or prompt injection. It does not remove previously installed skills or undo prior Gortex setup. Missing or unusable CLI, tracking failures, and requested skill installation failures stop plugin startup with an error.
