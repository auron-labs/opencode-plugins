# @auron-labs/opencode-worktrunk

OpenCode plugin that wraps the [Worktrunk](https://worktrunk.dev/) CLI (`wt`) for git worktree management. Exposes `wt list`, `wt switch`, `wt remove`, `wt merge`, `wt step`, and an arbitrary `wt` passthrough as agent tools, returning structured JSON where Worktrunk supports it.

Designed for agents that need to manage parallel worktrees — create a worktree for a task, list status, merge it back, and clean up — without leaving the OpenCode session.

## Install

```bash
opencode plugin @auron-labs/opencode-worktrunk [--global]
```

## Requirements

- OpenCode installed and loading plugins from your config.
- The Worktrunk CLI (`wt`) installed and on `PATH` (or set the `binary` option). See the [Worktrunk install docs](https://worktrunk.dev/).
- `wt` operates on the current repository, so it runs from the OpenCode session directory by default. Override per-call with the `cwd` argument.

## Usage

Add to your OpenCode config:

```json
{
  "plugin": [
    ["@auron-labs/opencode-worktrunk", {}]
  ]
}
```

With options:

```json
{
  "plugin": [
    ["@auron-labs/opencode-worktrunk", {
      "binary": "wt",
      "timeoutMs": 120000,
      "defaultCwd": "/path/to/repo",
      "autoYes": true
    }]
  ]
}
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `binary` | string | `wt` | Path to the Worktrunk binary |
| `timeoutMs` | number | `120000` | Default per-command timeout in ms |
| `defaultCwd` | string | session directory | Working directory for `wt` when a tool does not pass `cwd` |
| `autoYes` | boolean | `true` | Pass `-y` to skip approval prompts on the structured tools (`worktrunk_run` never auto-adds `-y`) |

## Tools

### `worktrunk_list`

List worktrees and their status via `wt list --format=json`.

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `full` | boolean | false | Include CI status and LLM summaries (reaches off-machine) |
| `branches` | boolean | false | Include local branches without worktrees |
| `remotes` | boolean | false | Include remote branches |
| `prs` | boolean | false | Include open PRs/MRs |
| `cwd` | string | session dir | Working directory for `wt` |
| `yes` | boolean | true | Pass `-y` |

Returns parsed JSON (Worktrunk schema 1 or 2) or raw text if JSON is unavailable.

### `worktrunk_switch`

Switch to a worktree (creating it if missing) via `wt switch --format=json`.

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `branch` | string | — | Branch name, shortcut (`^`, `@`, `-`), `pr:N` / `mr:N`, or PR URL |
| `create` | boolean | false | Create a new branch |
| `base` | string | default branch | Base branch for `create` (supports the same shortcuts) |
| `noCd` | boolean | true | Skip the directory change after switching. The tool process cannot change the agent's cwd, so the worktree path is returned in the JSON for the agent to `cd` into itself. |
| `clobber` | boolean | false | Remove stale paths at the target worktree location |
| `noHooks` | boolean | false | Skip hooks |
| `cwd` | string | session dir | Working directory for `wt` |
| `yes` | boolean | true | Pass `-y` |

> Note: because `noCd` defaults to `true`, `worktrunk_switch` creates/switches worktrees but does not attempt to change the agent's working directory. Read `worktree.path` (schema 2) or `path` (schema 1) from the returned JSON and `cd` yourself, or pass the path to subsequent commands via `cwd`.

### `worktrunk_remove`

Remove worktree(s) and delete merged branches via `wt remove --format=json`.

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `branches` | string[] | current | Branch names or worktree paths to remove |
| `noDeleteBranch` | boolean | false | Keep the branch after removing the worktree |
| `forceDelete` | boolean | false | Delete unmerged branches (`-D`) |
| `force` | boolean | false | Force-remove a dirty worktree (`-f`) |
| `foreground` | boolean | false | Run removal in the foreground |
| `reap` | boolean | false | Kill processes started in the worktree before removal (Unix only) |
| `noHooks` | boolean | false | Skip hooks |
| `cwd` | string | session dir | Working directory for `wt` |
| `yes` | boolean | true | Pass `-y` |

### `worktrunk_merge`

Merge the current branch into a target branch via `wt merge --format=json`. Squashes, rebases, fast-forwards the target, and removes the worktree by default.

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `target` | string | default branch | Target branch |
| `noSquash` | boolean | false | Skip commit squashing |
| `noCommit` | boolean | false | Skip commit and squash (rebase still runs unless `noRebase`) |
| `noRebase` | boolean | false | Skip rebase; require the target to fast-forward to the tip |
| `noRemove` | boolean | false | Keep the worktree after merging |
| `noFF` | boolean | false | Create a merge commit instead of fast-forwarding |
| `stage` | `all` \| `tracked` \| `none` | `all` | What to stage before committing |
| `noHooks` | boolean | false | Skip hooks |
| `cwd` | string | session dir | Working directory for `wt` |
| `yes` | boolean | true | Pass `-y` |

### `worktrunk_step`

Run a `wt step` subcommand.

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `subcommand` | enum | required | `commit`, `squash`, `rebase`, `push`, `diff`, `copy-ignored`, `eval`, `for-each`, `promote`, `prune`, `relocate`, `tether` |
| `branch` | string | current | Branch to operate on |
| `stage` | `all` \| `tracked` \| `none` | `all` | What to stage (commit/squash) |
| `dryRun` | boolean | false | Preview without committing/squashing (commit/squash) |
| `noHooks` | boolean | false | Skip hooks |
| `args` | string[] | — | Extra arguments appended to the subcommand (e.g. for-each command, rebase target) |
| `json` | boolean | auto | Request `--format=json` and parse it. Defaults to true for `commit`/`squash`, false otherwise. |
| `cwd` | string | session dir | Working directory for `wt` |
| `yes` | boolean | true | Pass `-y` |

### `worktrunk_run`

Escape hatch: run an arbitrary `wt` command and return its stdout. Use for `wt config`, `wt hook`, aliases, `wt list statusline`, and anything else not covered by a dedicated tool. Does not auto-add `-y`; include it in `args` if needed.

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `args` | string[] | required | Arguments to pass to `wt` (e.g. `["config", "state", "marker", "clear"]`) |
| `cwd` | string | session dir | Working directory for `wt` |
| `timeoutMs` | number | plugin default | Per-call timeout in ms |

## Behavior

- **Structured output**: the dedicated tools append `--format=json` and parse the result. When Worktrunk emits non-JSON output (e.g. an older `wt` version, or a subcommand without JSON support), the raw stdout is returned instead.
- **Non-interactive by default**: `autoYes: true` passes `-y` so the structured tools don't block on approval prompts. Disable per-call with `yes: false`, or globally with `autoYes: false`.
- **No directory changes**: `worktrunk_switch` defaults to `--no-cd` because a tool subprocess cannot change the agent's working directory. The returned JSON includes the worktree path; the agent is responsible for `cd` or for passing `cwd` to subsequent tools.
- **Errors**: a missing `wt` binary raises a clear `worktrunk binary not found at '<binary>'` error. Nonzero exits surface the trimmed stderr (or stdout) as the error message. Timeouts raise after `timeoutMs`.

## Limitations

- Requires the `wt` CLI on `PATH` (or configured via `binary`).
- The plugin does not install or bootstrap Worktrunk; it only wraps an existing `wt`.
- Interactive `wt switch` (the fuzzy picker) is not useful from a tool — always pass `branch`.
- `wt step` JSON output is only parsed for subcommands that document `--format=json` (`commit`, `squash`); other subcommands return raw text unless `json: true` is set explicitly and the subcommand supports it.
