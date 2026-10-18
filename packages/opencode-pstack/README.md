# @auron-labs/opencode-pstack

PStack workflows for OpenCode v2: a primary orchestrator, role agents, bundled skills and playbooks, and durable project coordination tools. Use it to plan implementation, delegate scoped work, review changes, and collect evidence before shipping.

This is the initial development version, `0.1.0`. The installation instructions below apply once the package is published. OpenCode v2 is required; the plugin uses the v2 API from `@opencode/plugin` 2.0.22 or newer.

## Install and start

Add the package to your OpenCode v2 configuration:

```json
{
  "plugins": [{ "package": "@auron-labs/opencode-pstack", "options": {} }]
}
```

Restart OpenCode, then start a scoped task:

```text
/pstack Add a health endpoint, review the diff, and verify its behavior.
```

The command selects the `pstack` primary agent and supplies the master `poteto-mode` workflow. You can also select `pstack` in the agent picker. Expect a plan and verification criteria appropriate to your request. Use `pstack_status` to inspect any coordination state the agent records.

External actions still follow your authorization and OpenCode permissions. A playbook does not authorize publishing, messaging, deploying, deleting worktrees, or merging PRs.

## Commands and skills

Each bundled skill has a `/pstack-<skill-name>` command. Each master playbook also has a `/pstack-<playbook-name>` command. For example:

| Command | Purpose |
| --- | --- |
| `/pstack` or `/pstack-poteto-mode` | Start the master workflow and route the request. |
| `/pstack-setup-pstack` | Inspect model choices and prepare a configuration proposal. |
| `/pstack-architect` | Explore a design before implementation. |
| `/pstack-feature` | Follow the feature implementation playbook. |
| `/pstack-bug-fix` | Investigate and repair a reproduced bug. |
| `/pstack-orchestrate` | Coordinate units, standing orders, reports, and verification. |
| `/pstack-session-pickup` | Reconcile saved work with the current project and forge. |
| `/pstack-show-me-your-work` | Record and review the decision trail. |

Skills retain their original names in OpenCode's native skill catalog, including `poteto-mode`, `architect`, and `show-me-your-work`. The prefix applies to slash commands. Existing agents, skills, commands, and tools with the same names are preserved; explicit model bindings can update an existing agent's model.

The `pstack_reference` tool reads adapted bundled Markdown by its exact inventory path, such as `skills/poteto-mode/playbooks/feature.md`. References printed inside adapted content use these inventory paths. Arbitrary files and upstream scripts are unavailable through this tool.

## Choose agent models

Create `~/.config/opencode/pstack.json`, or `$XDG_CONFIG_HOME/opencode/pstack.json` when `XDG_CONFIG_HOME` is set:

```json
{
  "models": {
    "pstack": "provider/model",
    "poteto-agent": "provider/model#variant",
    "pstack-reviewer": "other-provider/other-model"
  }
}
```

Replace these placeholder references with models available through your OpenCode providers. Values accept `provider/model` or `provider/model#variant`; model IDs may contain additional `/` segments. The optional variant must exist for that model.

Only these seven agent names are accepted:

| Agent             | Role                                               |
| ----------------- | -------------------------------------------------- |
| `pstack`          | Primary orchestrator and master workflow.          |
| `poteto-agent`    | Scoped implementation delegate.                    |
| `comment-sicko`   | Comment cleanup.                                   |
| `pstack-explorer` | Investigation and source evidence.                 |
| `pstack-judgment` | Synthesis, prose, and candidate comparison.        |
| `pstack-reviewer` | Adversarial design and diff review.                |
| `pstack-verifier` | Independent verification at the assigned head SHA. |

Omitted roles inherit OpenCode's model when the plugin creates them. An existing same-name agent retains its configuration unless you provide a model override. A missing configuration file is valid. Unknown keys, unknown agent names, malformed JSON, and invalid model references fail startup with the configuration path in the error.

Model bindings load at startup; restart OpenCode after editing the file. Slash commands apply the selected agent's model to the current session. Delegation uses OpenCode's native `subagent` tool with `agent`, `description`, and `prompt`. It supports background execution and session continuation. The adapter preserves configured role models and permits an override only when the user explicitly requests one. Use distinct configured roles when model diversity matters. The setup skill prepares a proposal; apply configuration changes only within the user's authorized scope.

## Durable project state

The tools store state under the project root at `.opencode/pstack/state.json`. They create it on the first authorized write. Reads of a project without state return an empty state without creating files.

Use the tools to update this file. Plans, reports, verification notes, and working notes belong in native artifacts; manually editing the JSON bypasses validation and concurrency protection. State persists across sessions, but a saved unit does not prove its task is still running.

| Write tool | Actions and required input | Read tool |
| --- | --- | --- |
| `pstack_unit` | `add`: `id`, `track`, optional `brief`. `set`: `id`, `state`, optional `branch`, `pr`, `sha`. | `pstack_unit_read`: `get` by `id`, or `list` with optional `state`/`track`. |
| `pstack_ledger` | `record`: `pr`, full `sha`, `verdict`, `evidence`, optional `verifier`. | `pstack_ledger_read`: `check` by exact `pr`/`sha`, or `list` with optional `pr`. |
| `pstack_inbox` | `push`: `unit`, `status`, optional `report`. `drain` atomically removes and returns queued reports. | `pstack_inbox_read`: `peek`. |
| `pstack_gate` | `park`: `id`, `question`, `options`, `defaultAnswer`. `resolve`: `id`, `answer`. | `pstack_gate_read`: `list` open gates. |
| `pstack_frontier` | `set`: ordered `prs`, each with `pr`, `branch`, full `sha`, and `state` (`OPEN`, `MERGED`, or `CLOSED`). | `pstack_frontier_read`: `show`. |
| `pstack_standing` | `add`: `line`. | `pstack_standing_read`: `list` numbered standing orders. |
| `pstack_decision` | `append`: `phase`, `decision`, `why`, `evidence`, `result`. | `pstack_decision_read`: `list` the append-only trail. |
| `pstack_artifact` | `write`: `name`, `kind` (`plan`, `report`, `verification`, or `note`), `content` up to 64 KiB. Replaces a same-name artifact. | `pstack_artifact_read`: `read` by `name`, or `list` names and kinds. |

Each listed action is supplied in an `action` field. `pstack_status` takes `{}` and returns the state path, full saved state, and derived counts. Identifiers use 1–128 letters, digits, `.`, `_`, or `-`, starting with a letter or digit. PR numbers are positive integers. SHAs must be full 40- or 64-character hexadecimal values.

Mutation tools declare the `pstack_write` permission and assert it at execution against the canonical state-file path. Configure that action through OpenCode's permission rules to `ask`, `allow`, or `deny`. Read tools and `pstack_status` do not request mutation permission. Inbox draining is a write. The tools attach session and agent identity to receipts, reports, decisions, and artifacts.

Recording a gate's default answer grants no authority to take that action. The frontier records an observed PR order and derives the first `OPEN` entry; it does not query a forge, rebase branches, or merge PRs. Obtain current forge evidence before updating or acting on it.

### Verification receipts

Receipts are keyed by the exact PR number and full head SHA. The accepted verdicts are:

- `live-ui-verified`
- `unit-test-verified`
- `type-check-only`
- `verifier-blocked`
- `verifier-failed`

An exact ledger lookup reports `verified: true` only for the first two behavioral verdicts. A missing receipt returns `NOT-VERIFIED`. A new SHA requires new evidence; a passing receipt for an older SHA does not cover it. Recording again for the same PR/SHA replaces that receipt. The ledger records supplied evidence and does not run tests or query GitHub itself.

### Restart and lock recovery

For PStack agents, context and compaction hooks inject a compact checkpoint with unit statuses, artifact names, and summary counts. Read the full state through the native tools, then reconcile current branches, forge facts, and outstanding tasks before continuing.

Writes serialize through `.opencode/pstack/.lock` and replace state atomically. If the lock stays occupied for five seconds, the write fails. Inspect the lock's recorded PID and actor, confirm that the owning OpenCode process has exited and no writer remains, then remove only that stale lock and retry. The plugin never steals a lock based on its age. Preserve an invalid state file for diagnosis; the plugin refuses to silently reset it. State files, lock files, and their directories cannot be symlinks.

## OpenCode adaptation and limits

The package keeps the upstream snapshot intact and adapts content when registering native agents, skills, commands, and references. It replaces Cursor model rules, task flags, transcript discovery, and shell-managed coordination files with the OpenCode interfaces described above. Cursor bootstrap code, remote orchestration and PR-watcher scripts, and Benny automations are intentionally omitted from the runtime snapshot.

Native task execution follows the capabilities and permissions of your configured OpenCode agents. This plugin does not provide detached workers, a background scheduler, remote Cloud agents, automatic process recovery, or a merge engine. Long workflows use bounded loops in the current session. Forge operations require an available CLI or integration and the authorization required by your session. Optional third-party skills, providers, and MCP integrations must already be installed.

Reflection uses current session messages or a user-supplied scoped transcript export. The adapter does not search private Cursor chat stores. Investigation and review roles receive scope instructions; those instructions do not establish a filesystem sandbox or a read-only tool policy.

## Develop and sync upstream

From the repository root, install the workspace dependencies with `bun install --frozen-lockfile`. Then run these commands from `packages/opencode-pstack`:

```bash
bun run sync:check
bun run build
bun run test
bun run check:pack
```

`sync:check` checks the local snapshot's file inventory and hashes without fetching upstream. `bun run sync:check --remote` also fetches the pinned commit and verifies the snapshot and lock against its original source. `check:pack` validates the distributable package contents. To review a new upstream snapshot, run `bun run sync`, inspect the snapshot and adapter changes, then repeat the checks. Do not edit the vendored files to implement OpenCode behavior; put adaptations in `src/adapter.ts`.

To try the development build before publication, add its absolute `dist` directory to your OpenCode configuration and restart:

```json
{
  "plugins": [
    "file:///absolute/path/to/opencode-plugins/packages/opencode-pstack/dist"
  ]
}
```

Replace the checkout path with yours. OpenCode's local plugin loader expects this directory, which contains the compiled `index.js`.

The current snapshot is PStack `0.15.25` from [`cursor/plugins` commit `101b274dd991f694e1f7024be2157e5f3adf07de`](https://github.com/cursor/plugins/tree/101b274dd991f694e1f7024be2157e5f3adf07de/pstack). [upstream-lock.json](upstream-lock.json) records the immutable revision, retained-file hashes, and omitted upstream paths for auditing. Sync fetches files from the resolved commit rather than mixing mutable branch revisions.

### Automatic upstream updates

The [sync workflow](../../.github/workflows/sync-pstack.yaml) runs daily at 07:23 UTC and supports manual dispatch on the default branch. It proposes an update PR only after snapshot, build, test, package, and changed-file lint checks pass. Failed updates retain a patch and log artifact for seven days.

Optional repair uses the [official Codex GitHub Action](https://learn.chatgpt.com/docs/github-action). Enable it with repository variable `PSTACK_CODEX_REPAIR=true` and secret `OPENAI_API_KEY`. This consumes OpenAI API access, independently of a ChatGPT subscription. The repair job has read-only GitHub permissions and a 20-minute action timeout. Initial verification includes remote snapshot verification and changed-file lint, so those failures also reach repair. Repair may update the runtime adapter, snapshot, lock, README, sync script, and regression tests, including explicit classification of new upstream paths. It must not weaken existing validation or tests. A separate job restricts changed paths, rejects symlinks and submodules, and reruns verification before opening a PR. Repair cannot modify the package-contents check, dependencies, or workflows. Review sync-script and test changes especially carefully because they affect the verification itself.

For a manual [Codex cloud handoff](https://developers.openai.com/codex/third-party/github), connect the repository to Codex, apply the failed artifact to a branch, and open a draft PR. A maintainer can then comment `@codex fix the pstack upstream sync and CI failures; add regression tests and push the fix to this branch`. Include the workflow run URL and failure log. A non-review mention starts a cloud task with the PR as context; `@codex review` requests review instead. GitHub issue assignment is not the documented trigger for this flow. If sync failed before producing a patch, start a task in Codex Cloud with the repository and workflow run URL and request an implementation PR. The workflow does not assume bot-authored comments trigger cloud work.

Update PRs use `GITHUB_TOKEN`, so their creation does not trigger other GitHub workflows. The sync workflow performs its own checks before opening the PR. A maintainer may need to reopen or push to the PR to start required branch checks, or configure an approved alternative token.

## License

The adapter is [MIT licensed](LICENSE). The bundled PStack snapshot is also [MIT licensed](vendor/pstack/LICENSE), copyright 2026 Lauren Tan. Its license and upstream provenance are included in the package.
