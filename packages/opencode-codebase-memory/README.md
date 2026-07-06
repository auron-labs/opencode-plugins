# @auron-labs/opencode-codebase-memory

OpenCode plugin for `codebase-memory-mcp` that wires the MCP server into OpenCode and proactively indexes the active OpenCode project directory.

## Install

```bash
opencode plugin @auron-labs/opencode-codebase-memory [--global]
```

## Requirements

- OpenCode installed and loading plugins from your config.
- `codebase-memory-mcp` installed and on `PATH`, or pass a custom `binary` option.

## Usage

Add to your OpenCode config:

```json
{
  "plugin": [
    ["@auron-labs/opencode-codebase-memory", {}]
  ]
}
```

With options:

```json
{
  "plugin": [
    ["@auron-labs/opencode-codebase-memory", {
      "binary": "/Users/me/.local/bin/codebase-memory-mcp",
      "indexMode": "fast",
      "autoIndexLimit": 25000,
      "indexOnStartup": true,
      "autoIndex": false,
      "enabled": true
    }]
  ]
}
```

Restart OpenCode after changing plugin config.

## What it does

- Adds an OpenCode MCP config entry for `codebase-memory-mcp`.
- Disables upstream `auto_index` config by default so the MCP server cannot index an unsafe process CWD.
- Resolves the active OpenCode directory to its Git root or nearest project marker root.
- Checks whether the resolved project root is already indexed.
- If not, runs `codebase-memory-mcp cli index_repository ...` in the background.
- Refuses to auto-index filesystem roots, home directories, and directories without project root markers.
- Uses a per-project lock so overlapping OpenCode processes do not start duplicate indexes.

The actual graph tools still come from the upstream MCP server after restart.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `binary` | string | `codebase-memory-mcp` | Path to the upstream CLI binary |
| `autoIndex` | boolean | `false` | Best-effort `config set auto_index <value>` on startup. Keep disabled unless you trust the MCP server process CWD. |
| `autoIndexLimit` | number | unset | Best-effort `config set auto_index_limit <N>` on startup |
| `indexOnStartup` | boolean | `true` | Check and index the active OpenCode directory in the background |
| `indexMode` | `full` \| `moderate` \| `fast` | `full` | Index mode for startup indexing |
| `enabled` | boolean | `true` | Disable the plugin without removing it from config |

## Tool

### `codebase_memory_project`

Returns the current plugin view of the resolved project root:

```json
{
  "rootPath": "/path/to/project",
  "project": "derived-project-name-or-null",
  "indexed": true,
  "status": "ready"
}
```

Arguments:

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `refresh` | boolean | no | Refresh project status from `list_projects` before returning |

When another OpenCode process is indexing the same project, the response includes lock details:

```json
{
  "status": "indexing",
  "lock": {
    "path": "/tmp/opencode-codebase-memory/...lock",
    "ownerPid": 12345,
    "childPid": 12346,
    "startedAt": 1710000000000,
    "active": true
  }
}
```

### `codebase_memory_index_project`

Starts indexing the resolved project root in the background.

Arguments:

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `mode` | `full` \| `moderate` \| `fast` | no | Index mode for this run. Defaults to `indexMode`. |
| `force` | boolean | no | Start indexing even if the project is already listed as indexed. |

## Notes

- This plugin works around upstream auto-index relying on the MCP server process CWD.
- Startup indexing is skipped when OpenCode resolves to `/`, your home directory, a non-directory path, or a directory without a project marker.
- It does not wrap all `codebase-memory-mcp` tools; use the upstream MCP tools directly once the server is connected.
