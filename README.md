# opencode-plugins

Small, focused OpenCode plugins for local provider, tooling, and TUI extensions.

## What is included

- `provider/litellm.ts`: OpenCode provider plugin for LiteLLM (OpenAI-compatible) with dynamic model discovery.
- `tools/cocoindex.ts`: OpenCode tools wrapper for `ccc` (`cocoindex-code`) commands.
- `plugins/bun-command-rewrite.ts`: Rewrites npm/npx-style shell commands to Bun equivalents inside Bun projects.
- `plugins/git-commit-strip-attribution.ts`: Removes AI attribution trailers from git commit command strings.
- `tui/gsd-status.tsx`: TUI status component for `.planning/STATE.md` driven workflows.

## Requirements

- OpenCode installed and running.
- Bun available for running TypeScript scripts in this repo.
- Optional: `mise` for installing the recommended local toolchain.
- Optional: `ccc` on `PATH` when using the CocoIndex plugin.

## Tooling

If you use `mise`, install the recommended tools with:

```bash
mise install
```

This repo currently tracks:

- `bun` for running local scripts
- `kasetto` for optional agent-skill management

## Install into OpenCode config

Run:

```bash
bun run install.ts
```

This copies selected plugins into `~/.config/opencode`.

## Manual plugin wiring

You can also copy individual plugin files into either:

- Project scope: `.opencode/plugins/`
- Global scope: `~/.config/opencode/plugins/`

Example:

```bash
mkdir -p ~/.config/opencode/plugins
cp provider/litellm.ts ~/.config/opencode/plugins/litellm-provider.ts
```

## Development

- Keep plugins self-contained and dependency-light.
- Use TypeScript compatible with OpenCode plugin runtime expectations.
- Validate plugin behavior in a local OpenCode session.
- If you use `mise`, run `mise install` once before local development.

## OSS files

- License: MIT (`LICENSE`)
- Contributing guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
- Code of conduct: `CODE_OF_CONDUCT.md`
