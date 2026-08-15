
Restart OpenCode after changing plugin config.

## What it does

- Adds an OpenCode MCP config entry for `codebase-memory-mcp` only after the resolved root passes the safety policy.
- Sets the MCP server process CWD to the canonical resolved project root.
- Refuses unsafe roots before any codebase-memory helper process starts. Unsafe includes filesystem/drive roots, home and broad/system trees, credential paths, invalid or non-directory paths, markerless directories, symlink escapes, and roots outside an invalid or configured `CBM_ALLOWED_ROOT`.
- Leaves MCP config untouched and exposes only skipped project/index tools for unsafe roots. It does not run `config set`, `list_projects`, `hook-augment`, or `index_repository` there.
- Does not write upstream global `auto_index` by default. `autoIndex: true` is an explicit opt-in and writes its global settings once during safe plugin initialization; refreshes and tools do not write them.
- Resolves the active OpenCode directory to its Git root or nearest project marker root.
- Checks whether the resolved project root is already indexed.
- If not, runs `codebase-memory-mcp cli index_repository ...` in the background.
- Refuses to enable or auto-index filesystem roots, home directories, broad/system trees, credential paths, and directories without project root markers.
- Uses a per-project lock so overlapping OpenCode processes do not start duplicate indexes.
- Adds hidden read-only `codebase-memory-scout`, `codebase-memory`, and `codebase-memory-auditor` subagents on safe roots without replacing same-name user agents.
- Augments safe-root `grep` and `glob` results with best-effort graph context through the bounded `hook-augment` helper; hook failures are ignored.

The actual graph tools still come from the upstream MCP server after restart.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `binary` | string | `codebase-memory-mcp` | Path to the upstream CLI binary |
| `autoIndex` | boolean | `false` | Explicit opt-in for one safe-initialization write of upstream global `config set auto_index true`. |
| `autoIndexLimit` | number | unset | With `autoIndex: true`, also write upstream global `auto_index_limit` once during safe initialization. Otherwise ignored. |
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
- Unsafe roots start with no MCP server or helper process. This includes `/`, your home directory, broad/system or credential trees, non-directories, markerless directories, symlink escapes, invalid `CBM_ALLOWED_ROOT`, and roots outside `CBM_ALLOWED_ROOT`.
- It does not wrap all `codebase-memory-mcp` tools; use the upstream MCP tools directly once the server is connected.