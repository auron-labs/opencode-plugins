# Contributing

Thanks for your interest in contributing to opencode-plugins. This repo is a Bun workspace containing focused OpenCode plugin packages under `packages/*`.

## Setup

```bash
mise install
bun install --frozen-lockfile
```

## Development commands

```bash
bun run build      # build all packages
bun run test       # run all package tests + smoke tests
mise run lint      # lint source with oxlint
mise run check     # lint + build + test
bun run readme     # regenerate README.md from scripts/update-readme.ts
```

## Making changes

1. Create a branch from `main`.
2. Make your change in the relevant `packages/<name>/` directory. Each package has its own `package.json`, `tsconfig.json`, `src/`, and `test/`.
3. Run `mise run check` before pushing. It runs lint, build, and test for the whole workspace.
4. If you add or rename a package, run `bun run readme` to update the package table in `README.md` (the README is generated — do not edit it by hand).
5. Open a pull request against `main`.

## Release flow

Releases are automated with [release-please](https://github.com/googleapis/release-please). Conventional commit messages (`feat:`, `fix:`, `chore:`, etc.) on `main` produce version bumps, changelogs, and tags automatically. Each package is released independently and published to npm.

To preview a release PR locally:

```bash
bunx release-please manifest-pr --config-file release-please-config.json --manifest-file .release-please-manifest.json --target-branch main
```

## Reporting issues

Use [GitHub Issues](https://github.com/php-depkit/opencode-plugins/issues) for bugs and feature requests. For security vulnerabilities, see [SECURITY.md](./SECURITY.md).
