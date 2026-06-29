# @auron-labs/opencode-improve

OpenCode plugin that injects an `improve` subagent for auditing codebases and writing self-contained implementation plans.

The idea: use your most capable model for the part where intelligence compounds — understanding the codebase, judging what's worth doing, writing the spec — and hand execution to cheaper models. The plugin never implements anything itself. The plan is the product.

```
you          →  /improve                    (expensive model, advises)
plans/       →  001-fix-n-plus-one.md       (self-contained specs)
other agent  →  implements, tests, ships    (cheap model, executes)
```

## Install

```bash
bun add @auron-labs/opencode-improve
```

## Requirements

- OpenCode installed and loading plugins from your config.

## Usage

Add to your OpenCode config:

```json
{
  "plugin": [
    ["@auron-labs/opencode-improve", {}]
  ]
}
```

Restart OpenCode. The plugin adds:

- An `improve` subagent (hidden, invoked via `/improve`)
- A `/improve` slash command

## What `/improve` does

Invoke in an OpenCode session:

```
/improve                        full audit → prioritized findings → plans
/improve quick                  cheap pass: hotspots, top findings only
/improve deep                   exhaustive: every package, every category
/improve security               focused audit (also: perf, tests, bugs, …)
/improve branch                 audit only what the current branch changes
/improve next                   feature suggestions — where to take the project
/improve plan <description>     skip the audit, spec one thing
/improve review-plan <file>     critique and tighten an existing plan
/improve execute <plan>         dispatch a cheaper subagent, review its work
/improve reconcile              refresh the backlog: verify, unblock, retire
/improve … --issues             also publish plans as GitHub issues
```

The advisor audits across nine categories (correctness, security, performance, tests, tech debt, dependencies, DX, docs, direction), vets every finding before showing it, and writes plans for the ones you select.

Plans land in `plans/` (or `advisor-plans/` if `plans/` already exists for another purpose). Each plan is self-contained — a different agent with zero context can execute it.

## Hard constraints

- **Never edits source code.** The advisor only writes to `plans/` and `advisor-plans/`. Permission rules enforce this: all edits outside those paths are denied.
- **Never mutates the working tree.** Read, search, and analysis commands only. No installs, builds, or commits.
- **Never reproduces secret values.** Credential locations are cited by `file:line` with a rotation recommendation.

## `execute` limitation

The `execute <plan>` variant dispatches a subagent to implement a plan in an isolated worktree. OpenCode subagent worktree isolation is not guaranteed. If true worktree isolation is unavailable, the advisor will tell you and hand the plan over for manual execution instead. The advisor never merges, pushes, or commits to your branch.

## Notes

- The `improve` agent is a subagent — it doesn't appear in the agent picker. Invoke it via `/improve`.
- The upstream `shadcn/improve` skill markdown is bundled in the package and read at runtime, along with the reference files it points to.
- Refresh from upstream by copying `.references/improve/skills/improve/SKILL.md` and `.references/improve/skills/improve/references/*.md` into this package's `references/` directory.
