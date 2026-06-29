import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSmokeConfig,
  buildSmokeCommand,
  collectWorkspacePlugins,
  ensurePluginBuilt,
  preparePluginForSmoke,
  resolvePluginSelection,
} from './opencode-smoke.mjs';

const repoRoot = new URL('..', import.meta.url);

test('collectWorkspacePlugins finds workspace packages with dist entry paths', () => {
  const plugins = collectWorkspacePlugins(repoRoot);
  const improve = plugins.find((plugin) => plugin.name === '@auron-labs/opencode-improve');

  assert.ok(improve);
  assert.match(improve.packageDir, /packages\/opencode-improve$/);
  assert.match(improve.entryPath, /packages\/opencode-improve\/dist\/index\.js$/);
});

test('resolvePluginSelection accepts package names and package-relative paths', () => {
  const plugins = collectWorkspacePlugins(repoRoot);
  const byName = resolvePluginSelection('@auron-labs/opencode-zellij', plugins, repoRoot);
  const byPath = resolvePluginSelection('packages/opencode-zellij', plugins, repoRoot);

  assert.equal(byName.name, '@auron-labs/opencode-zellij');
  assert.equal(byPath.entryPath, byName.entryPath);
});

test('buildSmokeConfig isolates a single plugin with deny-by-default permissions', () => {
  const config = buildSmokeConfig({
    pluginPath: '/tmp/plugin/dist/index.js',
  });

  assert.deepEqual(config.plugin, [['/tmp/plugin/dist/index.js', {}]]);
  assert.equal(config.permission.bash, 'deny');
  assert.equal(config.permission.edit, 'deny');
  assert.equal(config.permission.task, 'deny');
  assert.equal(config.permission.read, 'deny');
  assert.equal(config.permission.external_directory, 'deny');
});

test('buildSmokeCommand includes isolation env so only the target plugin is loaded', () => {
  const command = buildSmokeCommand({
    homeDir: '/tmp/home',
    configPath: '/tmp/config/opencode.json',
    message: 'smoke message',
  });

  assert.match(command, /HOME='\/tmp\/home'/);
  assert.match(command, /OPENCODE_DISABLE_PROJECT_CONFIG=1/);
  assert.match(command, /OPENCODE_DISABLE_DEFAULT_PLUGINS=1/);
  assert.doesNotMatch(command, /OPENCODE_PURE=1/);
  assert.match(command, /OPENCODE_DISABLE_EXTERNAL_SKILLS=1/);
  assert.match(command, /OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1/);
  assert.match(command, /OPENCODE_CONFIG='\/tmp\/config\/opencode\.json'/);
});

test('ensurePluginBuilt fails with an actionable build message when dist is missing', () => {
  assert.throws(
    () => ensurePluginBuilt({
      name: '@auron-labs/example',
      entryPath: '/tmp/missing-plugin/dist/index.js',
    }),
    /Plugin dist entry not found: \/tmp\/missing-plugin\/dist\/index\.js\. Run bun run build first\./,
  );
});

test('preparePluginForSmoke fails on missing dist before any CLI check would run', () => {
  assert.throws(
    () => preparePluginForSmoke('@auron-labs/example', [{
      name: '@auron-labs/example',
      packageDir: '/tmp/missing-plugin',
      entryPath: '/tmp/missing-plugin/dist/index.js',
    }], '/tmp'),
    /Plugin dist entry not found: \/tmp\/missing-plugin\/dist\/index\.js\. Run bun run build first\./,
  );
});
