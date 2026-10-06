# opencode-bashkit

Run OpenCode's `shell` tool in a temporary Bashkit filesystem. Project files appear at `/workspace`. Commands can create, overwrite, rename and delete files without changing the host project. Changes persist within one session and disappear when that session is deleted or the plugin shuts down.

This first milestone replaces the shell only. The `isolated` option removes OpenCode's remaining host filesystem tools so all agent file operations go through Bashkit. Loading the plugin alone does not sandbox OpenCode, other plugins, LSP, project discovery or background application processes.

## Requirements

- OpenCode **v2**, tested with **2.0.22 and 2.0.23**; the v1 plugin API is unsupported.
- **Linux x64 with glibc 2.34 or newer**. Other targets are not packaged.
- Bun **1.2.23** is verified for the native binding.

The package pins `@opencode/plugin` and `@opencode/core` to **2.0.22**. Command scanning and approval reuse OpenCode's core APIs. Permission checks run in the tool execution scope, before runtime creation. Hosts without the permission service fail closed. Check compatibility before upgrading OpenCode or those dependencies.

## Install and try it

The initial release is not published yet. To use this checkout, build from the workspace root:

```sh
mise install
bun install --frozen-lockfile
bun run --filter @auron-labs/opencode-bashkit build
```

Add the **absolute path to `packages/opencode-bashkit/dist`** to your OpenCode v2 `opencode.json`. Local plugin directories must contain `index.js`; the package root is not a local plugin entrypoint.

```json
{
  "plugins": [
    {
      "package": "/absolute/path/opencode-plugins/packages/opencode-bashkit/dist",
      "options": { "isolated": true }
    }
  ]
}
```

After the initial npm release, install with `bun add @auron-labs/opencode-bashkit` and use `"package": "@auron-labs/opencode-bashkit"` in that configuration. The release tarball includes `dist/runtime.node`; consumers do not need Rust or an installation build. Local development requires Rust **1.99.0**, a C linker and Node.

Restart OpenCode in a disposable project containing a file named `fixture`. Ask it:

> Use shell to read fixture, write “virtual” to fixture, create and reread new.txt, then read fixture in another shell call. Stop.

Approve the shell commands as needed. The later call should read “virtual”. Check `fixture` in your regular terminal: its original bytes should remain unchanged, and `new.txt` should not exist there.

`isolated: true` removes `read`, `write`, `edit`, `patch`, `apply_patch`, `glob`, `grep` and `list` when present. It preserves question, subagent and todo tools. The default is `false`, which leaves the host filesystem tools registered; they see host files rather than overlay edits. Other plugins can register host tools, so review the final tool inventory when combining plugins.

## Shell behavior

The replacement preserves v2's input schema, output schema and tool options. Its arguments are:

| Argument | Behavior |
| --- | --- |
| `command` | Bashkit script, limited to 1MB. Absolute paths inside the script refer to the virtual filesystem. |
| `workdir` | Defaults to `/workspace`. Virtual workspace paths, relative project paths and absolute host paths inside the canonical session directory are accepted. Outside paths are rejected. |
| `timeout` | Milliseconds, capped at 120,000. Omitted, zero and larger values use the hard 120,000ms maximum. |
| `background` | `true` fails explicitly; background execution is unsupported. |

Each call starts a fresh shell at the requested cwd. Filesystem edits persist; variables, functions, aliases and previous `cd` changes do not. Separate sessions and plugin instances have separate overlays. A session directory change is rejected instead of discarding edits. Idle or completed sessions retain their overlays.

The only host mount is the canonical project directory, read-only underneath an upstream `OverlayFs`. The virtual root and temporary files stay in memory. Unmodified lower files can reflect host changes; this is not a frozen snapshot. Host symlinks are inert or rejected by the pinned runtime's confinement checks.

Bashkit implements its own commands. Arbitrary host executables, including `git`, are unavailable; unsupported commands fail without host Bash fallback. Network and optional language runtimes are disabled. The shell receives virtual `HOME=/workspace` and `TMPDIR=/tmp`, without inheriting host environment variables.

Results retain stdout, stderr, exit status, truncation and runtime errors. Output preserves stdout followed by stderr; it does not preserve their interleaving. A runtime error may have no exit status. Output emitted before timeout or cancellation is retained within the output limits.

Cancellation is cooperative at command boundaries. A sleeping builtin waits until its boundary or the hard timeout. Cancelling a queued call does not cancel another active call. Rust serializes execution; recovery starts after the earlier execution finishes. Disposal cancels active work, rejects pending work and drops the overlay after execution settles. Internal interpreter errors close the runtime without silently recreating it.

Limits per call are 1MB input, 1MB stdout, 1MB stderr and 10,000 commands/loop iterations. The virtual root and workspace overlay each use Bashkit's defaults: 100MB total file bytes, 10MB per file, 10,000 files and 10,000 directories.

## Validate changes

```sh
bun run --filter @auron-labs/opencode-bashkit test
mise run check
bun install --frozen-lockfile
```

Package tests build and test the real Rust/N-API runtime, execute direct Bun assertions, check session ownership and permissions, and inspect the consumer tarball. CI and both release paths install the pinned Rust toolchain before building the artifact.

With OpenCode 2.0.22 or 2.0.23 installed:

```sh
bun run --filter @auron-labs/opencode-bashkit smoke:opencode
```

Set `OPENCODE_BIN` to an absolute binary path if necessary. The smoke test uses disposable XDG directories and a local mock model. It removes external providers, verifies the real tool registry, tests denied writes and persistent virtual edits, and checks host bytes. No model credentials are needed. The repository's generic `smoke:plugin` helper emits v1 configuration, so this v2 package uses its own smoke runner.

There is no writeback, export/apply operation, cross-restart persistence or shared VFS integration for the other filesystem tools in this milestone.
