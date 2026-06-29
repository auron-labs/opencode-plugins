import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const knownPermissionKeys = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill',
];

function toPath(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}

export function collectWorkspacePlugins(root = repoRoot) {
  const rootPath = resolve(toPath(root));
  const packagesDir = join(rootPath, 'packages');
  const plugins = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const packageDir = join(packagesDir, entry.name);
    const packageJsonPath = join(packageDir, 'package.json');

    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (!pkg.name) continue;
      plugins.push({
        name: pkg.name,
        packageDir,
        entryPath: join(packageDir, 'dist', 'index.js'),
      });
    } catch {
      // ponytail: skip folders that are not workspace packages
    }
  }

  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolvePluginSelection(selector, plugins, cwd = process.cwd()) {
  if (!selector) {
    throw new Error('Missing plugin selector. Pass a package name or package path.');
  }

  const cwdPath = resolve(toPath(cwd));
  const looksLikePath = selector.includes('/') || selector.includes('\\') || selector.startsWith('.');
  const resolvedInput = looksLikePath || isAbsolute(selector)
    ? resolve(cwdPath, selector)
    : null;

  const match = plugins.find((plugin) => {
    if (plugin.name === selector) return true;
    if (basename(plugin.packageDir) === selector) return true;
    if (!resolvedInput) return false;
    return resolvedInput === plugin.packageDir || resolvedInput === plugin.entryPath;
  });

  if (!match) {
    throw new Error(`Unknown plugin: ${selector}`);
  }

  return match;
}

export function buildSmokeConfig({ pluginPath }) {
  const permission = Object.fromEntries(knownPermissionKeys.map((key) => [key, 'deny']));

  return {
    $schema: 'https://opencode.ai/config.json',
    plugin: [[pluginPath, {}]],
    permission,
    formatter: false,
    lsp: false,
  };
}

export function ensurePluginBuilt(plugin) {
  if (existsSync(plugin.entryPath)) return plugin;
  throw new Error(`Plugin dist entry not found: ${plugin.entryPath}. Run bun run build first.`);
}

export function preparePluginForSmoke(selector, plugins, cwd = process.cwd()) {
  return ensurePluginBuilt(resolvePluginSelection(selector, plugins, cwd));
}

function parseArgs(argv) {
  const options = {
    selector: '',
    message: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--message') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --message');
      options.message = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (options.selector) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    options.selector = arg;
  }

  return options;
}

function ensureOpencodeAvailable() {
  const result = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error('opencode CLI not found on PATH. Install OpenCode or add it to PATH, then rerun this smoke script.');
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'opencode --version failed');
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll(`'`, `'\\''`)}'`;
}

export function buildSmokeCommand({ homeDir, configPath, message }) {
  const envParts = [
    `HOME=${shellQuote(homeDir)}`,
    `XDG_CONFIG_HOME=${shellQuote(dirname(configPath))}`,
    'OPENCODE_DISABLE_PROJECT_CONFIG=1',
    'OPENCODE_DISABLE_DEFAULT_PLUGINS=1',
    'OPENCODE_DISABLE_EXTERNAL_SKILLS=1',
    'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1',
    `OPENCODE_CONFIG=${shellQuote(configPath)}`,
  ];

  return `${envParts.join(' ')} opencode run --dir ${shellQuote(repoRoot)} ${shellQuote(message)}`;
}

function buildSmokeMessage(plugin) {
  return `Do not use tools. Confirm startup with only ${plugin.name} loaded from local dist/index.js, mention the isolated config path, then stop.`;
}

function createTempConfig(plugin) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencode-plugin-smoke-'));
  const configDir = join(tempRoot, 'config');
  const homeDir = join(tempRoot, 'home');
  const configPath = join(configDir, 'opencode.json');

  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(buildSmokeConfig({ pluginPath: plugin.entryPath }), null, 2)}\n`);

  return { tempRoot, configPath, homeDir };
}

function printUsage(plugins) {
  console.log('Usage:');
  console.log('  bun run smoke:plugin -- <package-name|package-path> [--message "..."]');
  console.log('');
  console.log('Available packages:');
  for (const plugin of plugins) {
    console.log(`  - ${plugin.name} (${plugin.packageDir.replace(`${repoRoot}/`, '')})`);
  }
}

function main() {
  const plugins = collectWorkspacePlugins();
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.selector) {
    printUsage(plugins);
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const plugin = preparePluginForSmoke(options.selector, plugins, process.cwd());
  ensureOpencodeAvailable();
  const { configPath, homeDir, tempRoot } = createTempConfig(plugin);
  const message = options.message || buildSmokeMessage(plugin);
  const command = buildSmokeCommand({ homeDir, configPath, message });

  console.log(`plugin: ${plugin.name}`);
  console.log(`dist: ${plugin.entryPath}`);
  console.log(`temp config: ${configPath}`);
  console.log(`temp home: ${homeDir}`);
  console.log(`temp root: ${tempRoot}`);
  console.log('');
  console.log('Smoke command (printed, not executed):');
  console.log(command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
