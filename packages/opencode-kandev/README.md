# @depkit/opencode-kandev

Kandev project-manager and backlog-ingest plugin for OpenCode.

The plugin adds two OpenCode slash commands:

- `/kandev-pm`: runs a lightweight project-manager loop against Kandev tasks in the current session.
- `/kandev-ingest`: turns a local PRD or implementation guide into a parent backlog task plus child tasks.

## Install

```bash
bun add @depkit/opencode-kandev
```

## Requirements

- OpenCode installed and loading plugins from your config.
- Kandev MCP tools configured in the OpenCode session where you want to use the commands.
- For `/kandev-ingest`, a local source file such as `PRD.md` or `docs/implementation-guide.md`.

This plugin does not talk to Kandev directly by itself. It prompts the active OpenCode session to use Kandev MCP tools such as `list_workspaces_kandev`, `create_task_kandev`, and `move_task_kandev`.

## Wire Into OpenCode

Reference the package from your OpenCode plugin config and load its default export.

The exact config shape depends on how you manage OpenCode plugins, but the module you want is:

- package: `@depkit/opencode-kandev`
- export: `default`

## Quick Start

1. Start an OpenCode session with Kandev MCP available.
2. Load this plugin in that session.
3. Use `/kandev-pm start` to supervise existing Kandev work, or `/kandev-ingest` to create new backlog tasks from a spec.

## `/kandev-pm`

The PM loop watches the current OpenCode session. On each idle event, it can prompt the session to audit visible Kandev work and take small safe actions such as moving tasks, updating task state, or reporting blockers.

Available commands:

- `/kandev-pm start [5m|0s] [--workspace-id ID] [--workflow-id ID] [--max-runs N] [extra instructions]`
- `/kandev-pm now`
- `/kandev-pm status`
- `/kandev-pm pause`
- `/kandev-pm resume`
- `/kandev-pm stop`

Examples:

```text
/kandev-pm start
/kandev-pm start 10m --workspace-id ws_123 --workflow-id wf_456
/kandev-pm start 0s --max-runs 1 only inspect blocked tasks in the backlog
/kandev-pm now
/kandev-pm status
```

Behavior notes:

- Default interval is `5m`.
- `0s` means run on every idle event.
- The loop pauses automatically after repeated prompt failures.
- The loop also pauses if the assistant ends with `[kandev-pm:blocked]`.
- By default, creating a file named `STOP_KANDEV_PM` in the project root pauses the loop.
- Per-session state is stored under `.opencode/kandev-project-manager/`.

Useful start flags:

- `--workspace-id ID`: limit audits to one Kandev workspace.
- `--workflow-id ID`: limit audits to one workflow.
- `--max-runs N`: stop after `N` PM iterations.
- `--max-runtime 1h`: stop after a wall-clock runtime limit.
- `--max-failures N`: pause after `N` prompt failures.
- `--stop-file PATH`: use a different pause file.
- trailing text: adds extra operator instructions to every PM iteration.

## `/kandev-ingest`

`/kandev-ingest` reads a local source file, asks the active session to build a task graph, and creates Kandev backlog tasks through the MCP tools. It creates one parent task first, then child tasks in prerequisite order.

Usage:

```text
/kandev-ingest <file> [flags] [extra instructions]
```

Supported flags:

- `--workspace-id ID`
- `--workflow-id ID`
- `--backlog-step-id ID`
- `--repository-id ID`
- `--local-path PATH`
- `--repository-url URL`
- `--base-branch BRANCH`
- `--agent-profile-id ID`
- `--executor-profile-id ID`
- `--parent-title TITLE`
- `--start-agent`

Examples:

```text
/kandev-ingest PRD.md --workspace-id ws_123 --workflow-id wf_456
/kandev-ingest docs/implementation-guide.md --repository-id repo_123 --base-branch main
/kandev-ingest PRD.md --local-path /repo/app --parent-title "Checkout rewrite" --start-agent
/kandev-ingest PRD.md focus on shipping an MVP first
```

Behavior notes:

- If IDs are omitted, the session will try to discover them and will stop if the destination is ambiguous.
- The plugin defaults to `start_agent=false`; pass `--start-agent` only when you want created tasks to start immediately.
- Large source files are truncated in the embedded prompt, and the session is instructed to read the full file before creating tasks.
- The ingest flow avoids partial task creation when required workspace, workflow, repository, or profile choices are ambiguous.

## Development

```bash
bun install
bun run build
```
