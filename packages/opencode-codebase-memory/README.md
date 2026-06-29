# @auron-labs/opencode-codebase-memory

OpenCode plugin for `codebase-memory-mcp` that wires the MCP server into OpenCode and proactively indexes the active OpenCode project directory.

## Install

```bash
bun add @auron-labs/opencode-codebase-memory
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
      "autoIndex": true,
      "enabled": true
    }]
  ]
}
```

Restart OpenCode after changing plugin config.

## What it does

- Adds an OpenCode MCP config entry for `codebase-memory-mcp`.
- Enables upstream `auto_index` config best-effort.
- Checks whether the active OpenCode project directory is already indexed.
- If not, runs `codebase-memory-mcp cli index_repository ...` in the background.

The actual graph tools still come from the upstream MCP server after restart.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `binary` | string | `codebase-memory-mcp` | Path to the upstream CLI binary |
| `autoIndex` | boolean | `true` | Best-effort `config set auto_index true` on startup |
| `autoIndexLimit` | number | unset | Best-effort `config set auto_index_limit <N>` on startup |
| `indexOnStartup` | boolean | `true` | Check and index the active OpenCode directory in the background |
| `indexMode` | `full` \| `moderate` \| `fast` | `full` | Index mode for startup indexing |
| `enabled` | boolean | `true` | Disable the plugin without removing it from config |

## Tool

### `codebase_memory_project`

Returns the current plugin view of the active project:

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

## Notes

- This plugin works around upstream auto-index relying on the MCP server process CWD.
- It does not wrap all `codebase-memory-mcp` tools; use the upstream MCP tools directly once the server is connected.
