# opencode-plugins

[![License](https://img.shields.io/github/license/aaronflorey/opencode-plugins?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/aaronflorey/opencode-plugins/ci.yaml?branch=main&style=flat-square&label=CI)](https://github.com/aaronflorey/opencode-plugins/actions/workflows/ci.yaml)
[![Release](https://img.shields.io/github/v/release/aaronflorey/opencode-plugins?display_name=tag&sort=semver&style=flat-square)](https://github.com/aaronflorey/opencode-plugins/releases)

Small, focused OpenCode plugins for local provider, tooling, and TUI extensions.

This repository is published as source, not as an npm package or standalone CLI binary.

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

Local validation commands:

```bash
mise run lint
mise run test
mise run check
```

## Install into OpenCode config

Run:

```bash
bun run install.ts
```

This copies selected plugins into `~/.config/opencode`.

## Usage

- Copy or install the plugin file you want to use.
- Reference the installed plugin from your OpenCode config as needed.
- Validate behavior in a local OpenCode session before publishing changes.

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

## Releases

- GitHub Actions runs source lint and Bun bundle checks on pushes and pull requests.
- `release-please` manages changelog updates, `vX.X.X` tags, and GitHub releases.
- This repo does not publish to npm, Homebrew, Docker, or other package registries by default.

## OSS files

- License: MIT (`LICENSE`)
- Contributing guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
- Code of conduct: `CODE_OF_CONDUCT.md`
