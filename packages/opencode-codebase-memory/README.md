# OpenCode Codebase Memory

An OpenCode plugin that connects the active project to the upstream `codebase-memory-mcp` MCP server and provides project status and indexing tools.

> **Release status:** The current workspace implementation is streamlined and not included in published version `0.3.0`. Build and load the local package below to use these changes; the version number is intentionally unchanged.

## Use the current workspace version

The upstream `codebase-memory-mcp` executable must be installed separately and available on `PATH`, or supplied with the `binary` option. The plugin does not install it or run its installer.

From the workspace root, build the package:

```sh
bun run --filter @auron-labs/opencode-codebase-memory build
```

The current workspace entrypoint supports OpenCode v1 and v2; add the built package path to an OpenCode v2 `plugins` list as follows:

```json
{
  "plugins": [
    {
      "package": "./packages/opencode-codebase-memory/dist/index.js",
      "options": {}
    }
  ]
}
```

Restart OpenCode after changing plugin configuration.

## What it does

- Resolves the active directory to its Git root, or the nearest recognized project-marker root when it is not in Git.
- Registers a local `codebase-memory-mcp` MCP server only if one is not already configured. Existing manual server configuration is left intact. The server runs at the resolved project root and retains codebase-memory-mcp's default stdio/shared-daemon behavior.
- Applies root-safety checks before registering the server or invoking the CLI. Filesystem roots, home directories, broad/system and credential directories, non-directories, markerless directories, symlink escapes, invalid `CBM_ALLOWED_ROOT` settings, and paths outside an allowed root are skipped.
- By default, checks the project with a one-shot `codebase-memory-mcp cli list_projects` command and starts a separate background CLI indexing process only when it is not already indexed. This startup work uses the CLI, not daemon RPC. A temporary lock prevents duplicate indexing across OpenCode processes.
- Adds `codebase_memory_project` and `codebase_memory_index_project` tools for status and manual indexing.

The plugin does not write OpenCode config files, agent instructions, project docs, hooks, or upstream global settings. In particular, it does not change the upstream `auto_index` setting. The upstream tool still writes its graph/index/cache data, and this plugin writes temporary coordination locks. It does not delete files written by any previously installed upstream tool or plugin.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `binary` | string | `codebase-memory-mcp` | Executable name or path for the upstream CLI and MCP server. |
| `enabled` | boolean | `true` | Enable MCP registration and startup indexing. |
| `indexOnStartup` | boolean | `true` | Check and index the active project on startup if it is not already indexed. |
| `indexMode` | `full` \| `moderate` \| `fast` | `full` | Mode used for startup indexing and as the manual tool's default. |

The former `autoIndex` and `autoIndexLimit` options are no longer supported; the plugin does not configure upstream global auto-index settings.

## Tool

### `codebase_memory_project`

Returns the resolved root, project name (or `null`), whether it is indexed, and a status (`idle`, `indexing`, `ready`, `failed`, or `skipped`). Pass `refresh: true` to refresh status from the CLI.

### `codebase_memory_index_project`

Starts indexing the resolved project in the background. Optional `mode` selects `full`, `moderate`, or `fast`; optional `force: true` starts indexing even if the project is already listed as indexed.

## Notes

- The upstream MCP server provides the graph tools; this plugin adds only project status and indexing tools.
- The plugin does not wrap MCP tools, augment search results, or create agents, hooks, or instruction files.
- Root resolution and safety checks apply to startup and manual indexing. A configured `CBM_ALLOWED_ROOT` further limits which roots are allowed.
