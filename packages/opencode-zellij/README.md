# @auron-labs/opencode-zellij

OpenCode plugin for managing Zellij terminal panes. Spawn, read, watch, and control Zellij panes from agent tools with event subscriptions and automatic cleanup.

## Install

```bash
bun add @auron-labs/opencode-zellij
```

## Requirements

- OpenCode installed and loading plugins from your config.
- Zellij installed and on `PATH` (or set the `binary` option).
- A running Zellij session (`$ZELLIJ_SESSION_NAME` detected automatically, or set `session` in options).

## Usage

Add to your OpenCode config:

```json
{
  "plugin": [
    ["@auron-labs/opencode-zellij", {}]
  ]
}
```

With options:

```json
{
  "plugin": [
    ["@auron-labs/opencode-zellij", {
      "session": "my-session",
      "binary": "/usr/local/bin/zellij",
      "maxEvents": 500,
      "pollMs": 2000,
      "closeOnExitCleanup": true,
      "stateFile": "~/.config/opencode/zellij.json"
    }]
  ]
}
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `session` | string | `$ZELLIJ_SESSION_NAME` | Zellij session name to target |
| `binary` | string | `zellij` | Path to the zellij binary |
| `maxEvents` | number | `200` | Max events kept in the ring buffer per pane |
| `pollMs` | number | `3000` | Polling interval (ms) for exit status detection |
| `closeOnExitCleanup` | boolean | `true` | Close tracked panes when OpenCode exits |
| `stateFile` | string | `$OPENCODE_CONFIG_DIR/zellij.json`, then `~/.config/opencode/zellij.json` | Path to the persisted state file. `~/` is expanded. |

## Tools

### `zellij_spawn`

Spawn a new Zellij pane, track it, and start a JSON event watcher.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `command` | string[] | yes | Command to run |
| `name` | string | no | Pane name (also used as the ref) |
| `cwd` | string | no | Working directory |
| `floating` | boolean | no | Open in floating mode |
| `direction` | string | no | Direction for tiled panes: `right`, `left`, `up`, `down` |
| `subscriptions` | array | no | Additional subscriptions |

Returns: `{ ref, paneId, command, subscriptions, exited }`

Default subscriptions: exit `nonzero`, `closed`.

### `zellij_read`

Read pane output as text.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `ref` | string | no | Tracked pane ref |
| `paneId` | string | no | Zellij pane ID (one of ref/paneId required) |
| `full` | boolean | no | Include full scrollback |
| `ansi` | boolean | no | Preserve ANSI escape codes |

### `zellij_events`

Return buffered events for a tracked pane.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `ref` | string | no | Tracked pane ref |
| `paneId` | string | no | Zellij pane ID |
| `clear` | boolean | no | Clear buffer after reading |
| `limit` | number | no | Max events to return |

### `zellij_subscribe`

Add subscriptions to a tracked pane.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `ref` | string | no | Tracked pane ref |
| `paneId` | string | no | Zellij pane ID |
| `text` | string | no | Regex pattern to match in output |
| `exit` | boolean/string/number | no | Subscribe to exit. `true` means `nonzero`; also accepts `any`, `zero`, `nonzero`, or an exact exit code like `1`. |
| `closed` | boolean | no | Subscribe to pane closed |

### `zellij_wait`

Wait for a matching event or timeout.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `ref` | string | no | Tracked pane ref |
| `paneId` | string | no | Zellij pane ID |
| `timeoutMs` | number | no | Timeout in ms (default 30000) |
| `text` | string | no | Wait for text matching this regex |
| `exit` | boolean/string/number | no | Wait for exit. `true` means `nonzero`; also accepts `any`, `zero`, `nonzero`, or an exact exit code like `1`. |
| `closed` | boolean | no | Wait for pane to close |

### `zellij_stop`

Stop the watcher and close a tracked pane.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `ref` | string | no | Tracked pane ref |
| `paneId` | string | no | Zellij pane ID |

### `zellij_restart`

Stop and recreate a pane with the same command and options.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `ref` | string | yes | Tracked pane ref |

### `zellij_list`

List the target session, Zellij connectivity, live pane count, and tracked pane status. Takes no arguments.

Returns: `{ session, connected, livePanes, error, tracked }`

## Event model

Events are buffered in a bounded ring buffer per pane (default 200 events). Event types:

| Type | Source | Description |
|------|--------|-------------|
| `pane_update` | subscribe | Viewport content changed |
| `text_match` | subscription | A line matched a text regex |
| `pane_closed` | subscribe | Pane was closed in Zellij |
| `pane_exited` | poll | Pane command exited (includes exit code) |
| `exit_match` | subscription | Pane exit matched a subscribed exit condition |
| `error` | internal | Watcher or command error |

## Behavior

- **Live output**: uses `zellij subscribe --pane-id <id> --format json` to stream NDJSON events.
- **Exit detection**: polls `zellij action list-panes --json` at `pollMs` intervals because subscribe does not report exit codes.
- **Text matching**: rendered viewport updates from subscribe are checked against text regex subscriptions, with duplicate pattern/line matches suppressed while the event remains buffered.
- **Cleanup**: tracked panes are closed and watcher processes killed on SIGINT, SIGTERM, beforeExit, and exit. Only panes created/tracked by this plugin are closed.
- **State restore**: on startup, persisted state is loaded and cross-checked against the live session. Still-live tracked panes are restored and watched again; panes that no longer exist are removed from tracking.

## State file

A small JSON file persists tracked pane refs and metadata across restarts. Default location:

1. `stateFile` plugin option, if provided
2. `$OPENCODE_CONFIG_DIR/zellij.json`
3. `$HOME/.config/opencode/zellij.json`

The state file is written on pane changes and loaded on plugin init. It lets refs survive an OpenCode restart and lets the plugin remove stale tracking entries without touching panes it did not create.

## Limitations

- Requires a running Zellij session; does not start one.
- Exit code detection is poll-based, not instant.
- The `zellij subscribe` stream may have brief gaps during rapid output bursts.
- Pane IDs are session-scoped; reusing a ref across sessions requires manual coordination.
- The plugin does not manage Zellij layouts, tabs, or floating window positions.
