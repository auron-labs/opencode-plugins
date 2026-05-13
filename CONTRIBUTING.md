# Contributing

Thanks for contributing.

## Scope

This repository contains OpenCode plugins and related helper scripts. Keep changes small, focused, and aligned with existing plugin patterns.

## Development notes

1. Prefer minimal changes over broad refactors.
2. Keep plugin IDs stable unless there is a clear migration plan.
3. Avoid adding dependencies unless they materially simplify maintenance.
4. Test changes in a local OpenCode session.

## Pull requests

1. Describe what changed and why.
2. Note any behavior changes for plugin users.
3. Include manual validation steps you ran.

## Commit style

Use conventional commits where practical (for release-please compatibility), for example:

- `feat: add header metadata to litellm provider`
- `fix: handle missing model info payload`
- `docs: update plugin installation instructions`
