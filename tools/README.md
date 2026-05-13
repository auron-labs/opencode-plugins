# CocoIndex OpenCode Plugin

This directory contains a native OpenCode plugin that exposes `cocoindex-code` CLI commands as built-in OpenCode tools.

File: `tools/cocoindex.ts`

## What it provides

The plugin registers these tools:

- `cocoindex_init`
- `cocoindex_index`
- `cocoindex_search`
- `cocoindex_status`
- `cocoindex_doctor`
- `cocoindex_reset`
- `cocoindex_daemon_status`
- `cocoindex_daemon_restart`
- `cocoindex_daemon_stop`

`cocoindex_search` supports optional filters and paging:

- `query` (required)
- `limit` (1-100)
- `offset` (>= 0)
- `refresh` (boolean)
- `languages` (string[])
- `paths` (string[])

`cocoindex_reset` supports:

- `all` (boolean)
- `force` (boolean)

## Install / wire into OpenCode

Choose one of these approaches.

### 1) Project plugin directory (recommended)

Copy the plugin file into your project plugin folder:

```bash
mkdir -p .opencode/plugins
cp tools/cocoindex.ts .opencode/plugins/cocoindex.ts
```

OpenCode auto-loads local plugins from `.opencode/plugins/`.

### 2) Global plugin directory

Copy it to your global config plugin folder:

```bash
mkdir -p ~/.config/opencode/plugins
cp tools/cocoindex.ts ~/.config/opencode/plugins/cocoindex.ts
```

OpenCode auto-loads global plugins from `~/.config/opencode/plugins/`.

## Requirements

- `ccc` must be installed and available on `PATH`.
- Run commands inside a repository/worktree where you want CocoIndex to operate.

## Quick usage examples

Once loaded, OpenCode can call tools like:

- `cocoindex_init` to initialize settings
- `cocoindex_index` to build/update index
- `cocoindex_search` with a natural-language query
- `cocoindex_status` or `cocoindex_doctor` for health/debugging

Example tool-style payload for search:

```json
{
  "query": "where is session auth handled",
  "limit": 8,
  "refresh": true,
  "languages": ["typescript", "python"],
  "paths": ["src/**", "app/**"]
}
```

## Notes

- Commands are executed as `ccc ...` in the current project directory.
- Tool output includes command line, stdout, and stderr sections for easy debugging.
