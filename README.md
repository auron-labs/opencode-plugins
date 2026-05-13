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
- Optional: `ccc` on `PATH` when using the CocoIndex plugin.

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

## Release management

This repository uses `release-please` metadata for tag/changelog management with `vX.X.X` tags.

- Config: `release-please-config.json`
- Manifest: `.release-please-manifest.json`

If you later want fully automated GitHub releases, add a workflow that runs `release-please` using `${{ secrets.GITHUB_TOKEN }}`.

## OSS files

- License: MIT (`LICENSE`)
- Contributing guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
- Code of conduct: `CODE_OF_CONDUCT.md`
