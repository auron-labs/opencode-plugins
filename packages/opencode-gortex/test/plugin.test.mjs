import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import plugin from '../dist/index.js'

async function fixture(t, options = {}, fail = '') {
  const root = await mkdtemp(path.join(tmpdir(), 'gortex-plugin-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'project with spaces')
  await mkdir(directory)
  await writeFile(path.join(directory, 'package.json'), '{}')
  const log = path.join(root, 'calls.jsonl')
  const binary = path.join(root, 'fake gortex')
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME, config: process.env.OPENCODE_CONFIG, xdg: process.env.XDG_CONFIG_HOME }) + '\\n')
if (args[0] === ${JSON.stringify(fail)}) { console.error('simulated failure'); process.exit(1) }
if (args[0] === 'repos') console.log(${JSON.stringify(fail)} === 'repos-json' ? '{}' : JSON.stringify([
  { name: 'registered-project', path: process.cwd() },
  { name: 'other-project', path: ${JSON.stringify(path.join(root, 'other-project'))} },
].filter(repo => ${JSON.stringify(fail)} !== 'repos-missing' || repo.name !== 'registered-project')))
if (args[0] === 'install') {
  if (${JSON.stringify(fail)} === 'install-report') { console.log(JSON.stringify({ agents: [{ name: 'opencode', configured: false }] })); process.exit(0) }
  const config = path.join(process.env.HOME, '.config', 'opencode')
  mkdirSync(path.join(config, 'skills', 'gortex-explore'), { recursive: true })
  writeFileSync(path.join(config, 'skills', 'gortex-explore', 'SKILL.md'), '---\\nname: gortex-explore\\ndescription: Explore code\\n---\\nCurated skill')
  mkdirSync(path.join(config, 'commands'), { recursive: true })
  writeFileSync(path.join(config, 'commands', 'gortex-explore.md'), 'command')
  writeFileSync(process.env.OPENCODE_CONFIG, '{}')
  console.log(JSON.stringify({ agents: [{ name: 'opencode', configured: true }] }))
}
`)
  await chmod(binary, 0o755)
  const servers = new Map()
  const agents = [{ id: 'build', system: 'Existing instructions' }, { id: 'plan' }]
  let reloads = 0
  let transforms = 0
  const hooks = new Map()
  const ctx = {
    options: { binary, ...options }, location: { directory },
    mcp: { transform: async fn => fn({ get: name => servers.get(name), set: (name, config) => servers.set(name, config) }) },
    agent: { transform: async fn => { transforms++; fn({ list: () => agents, update: (id, fn) => fn(agents.find(agent => agent.id === id)) }) } },
    skill: { reload: async () => { reloads++ } },
    tool: { hook: async (name, fn) => { hooks.set(name, fn) } },
  }
  return { root, directory, binary, ctx, servers, agents, hooks, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), counts: () => ({ reloads, transforms }) }
}

test('v2 startup validates CLI, initializes and tracks only the current directory, and registers MCP', async t => {
  const f = await fixture(t)
  assert.equal(plugin.id, 'opencode-gortex')
  await plugin.setup(f.ctx)
  assert.deepEqual((await f.calls()).map(call => call.args), [['version'], ['track', f.directory], ['repos', '--json']])
  assert.equal(await readFile(path.join(f.directory, '.gortex', '.gitignore'), 'utf8'), '# Gortex-managed: local index state, do not commit\n*\n')
  assert.deepEqual(f.servers.get('gortex'), { type: 'local', command: [f.binary, 'mcp', '--index', f.directory], cwd: f.directory, disabled: false })
  assert.deepEqual(await readdir(f.directory), ['.gortex', 'package.json'])
  assert.deepEqual(f.counts(), { reloads: 0, transforms: 0 })
})

test('prefixes a bare read path with the registered name even when another repo has the same file', async t => {
  const f = await fixture(t)
  const other = path.join(f.root, 'other-project')
  await mkdir(other)
  await writeFile(path.join(other, 'mise.toml'), 'other repo')
  await writeFile(path.join(f.directory, 'mise.toml'), 'current repo')
  await plugin.setup(f.ctx)
  const event = { tool: 'gortex_read', input: { operation: 'file', target: { file: 'mise.toml' } } }
  const before = f.hooks.get('execute.before')
  await before(event)
  assert.equal(event.input.target.file, 'registered-project/mise.toml')
  const relative = event.input.target.file.slice('registered-project/'.length)
  assert.equal(await readFile(path.join(f.directory, relative), 'utf8'), 'current repo')
  await before(event)
  assert.equal(event.input.target.file, 'registered-project/mise.toml')
})

test('qualifies facade, legacy and batch file selectors without rewriting task text or file content', async t => {
  const f = await fixture(t)
  await plugin.setup(f.ctx)
  const input = {
    path: './src/', file_path: 'mise.toml', target: { file: '.scratch/PLAN.md' },
    source: { file: 'src/old.ts' }, to: { file: 'src/new.ts' },
    options: { path_prefix: 'src/', paths: ['src/a.ts', 'other-project/src/b.ts'] },
    arguments: { files: ['docs/testing.md'] },
    changes: [
      { op: 'edit_file', path: 'mise.toml', old_string: 'src/a.ts', new_string: 'other-project/b.ts' },
      { op: 'move_file', source: 'src/old.ts', destination: 'src/new.ts' },
      { op: 'delete_file', path: 'src/removed.ts' },
    ],
    task: 'Find mise.toml', query: 'src/old.ts', content: 'mise.toml',
    target_symbol: 'Type::method', context: { symbol: 'src/a.ts::foo' },
  }
  await f.hooks.get('execute.before')({ tool: 'gortex_edit', input })
  assert.deepEqual(input, {
    path: 'registered-project/src/', file_path: 'registered-project/mise.toml', target: { file: 'registered-project/.scratch/PLAN.md' },
    source: { file: 'registered-project/src/old.ts' }, to: { file: 'registered-project/src/new.ts' },
    options: { path_prefix: 'registered-project/src/', paths: ['registered-project/src/a.ts', 'other-project/src/b.ts'] },
    arguments: { files: ['registered-project/docs/testing.md'] },
    changes: [
      { op: 'edit_file', path: 'registered-project/mise.toml', old_string: 'src/a.ts', new_string: 'other-project/b.ts' },
      { op: 'move_file', source: 'registered-project/src/old.ts', destination: 'registered-project/src/new.ts' },
      { op: 'delete_file', path: 'registered-project/src/removed.ts' },
    ],
    task: 'Find mise.toml', query: 'src/old.ts', content: 'mise.toml',
    target_symbol: 'Type::method', context: { symbol: 'src/a.ts::foo' },
  })
})

test('preserves absolute paths, known prefixes, explicit scopes/views and non-Gortex tools', async t => {
  const f = await fixture(t)
  await plugin.setup(f.ctx)
  const before = f.hooks.get('execute.before')
  for (const file of [path.join(f.directory, 'mise.toml'), 'C:\\repo\\mise.toml', '\\\\server\\share\\mise.toml', 'registered-project/mise.toml', 'other-project/mise.toml', '']) {
    const event = { tool: 'gortex_read', input: { target: { file } } }
    await before(event)
    assert.equal(event.input.target.file, file)
  }
  for (const input of [
    { repo: 'other-project', path: 'mise.toml' },
    { target: { file: 'mise.toml' }, options: { repo: 'other-project' } },
    { target: { file: 'mise.toml' }, options: { project: 'other-project' } },
    { target: { file: 'mise.toml' }, workspace: 'another-workspace' },
    { target: { file: 'mise.toml' }, scope: 'workspace' },
    { target: { file: 'mise.toml' }, view: { ref: 'main' } },
  ]) {
    const original = structuredClone(input)
    await before({ tool: 'gortex_read', input })
    assert.deepEqual(input, original)
  }
  for (const tool of ['read', 'other_mcp_read', 'gortexish_read', 'execute', 'gortex_workspace_admin', 'gortex_track_repository', 'gortex_index_repository', 'gortex_reindex_repository']) {
    const input = { path: 'mise.toml', target: { file: 'mise.toml' } }
    const original = structuredClone(input)
    await before({ tool, input })
    assert.deepEqual(input, original)
  }
  for (const input of [undefined, null, [], 'mise.toml', { target: null, path: 1 }]) {
    await before({ tool: 'gortex_read', input })
  }
  const traversal = { target: { file: '../outside.txt' } }
  await before({ tool: 'gortex_read', input: traversal })
  assert.equal(traversal.target.file, 'registered-project/../outside.txt')
})

test('existing MCP settings and project ignore file survive repeated startups', async t => {
  const f = await fixture(t)
  const existing = { type: 'remote', url: 'https://example.com/mcp', disabled: true }
  f.servers.set('gortex', existing)
  await mkdir(path.join(f.directory, '.gortex'))
  await writeFile(path.join(f.directory, '.gortex', '.gitignore'), 'custom')
  await plugin.setup(f.ctx)
  await plugin.setup(f.ctx)
  assert.equal(f.servers.get('gortex'), existing)
  assert.equal(f.hooks.size, 0)
  assert.equal(await readFile(path.join(f.directory, '.gortex', '.gitignore'), 'utf8'), 'custom')
})

test('existing local MCP configuration is preserved while bare file paths are qualified', async t => {
  const f = await fixture(t)
  const existing = { type: 'local', command: [f.binary, 'mcp'], cwd: f.directory, disabled: false }
  f.servers.set('gortex', existing)
  await plugin.setup(f.ctx)
  assert.equal(f.servers.get('gortex'), existing)
  const input = { path: 'mise.toml' }
  await f.hooks.get('execute.before')({ tool: 'gortex_read_file', input })
  assert.equal(input.path, 'registered-project/mise.toml')
})

for (const communityRouting of [false, true]) {
  for (const installSkills of [false, true]) {
    test(`independent gates: installSkills=${installSkills}, communityRouting=${communityRouting}`, async t => {
      const f = await fixture(t, { installSkills, communityRouting })
      await plugin.setup(f.ctx)
      const calls = await f.calls()
      assert.equal(calls.some(call => call.args[0] === 'install'), installSkills)
      assert.deepEqual(f.counts(), { reloads: Number(installSkills), transforms: Number(communityRouting) })
      assert.ok(f.agents[0].system.startsWith('Existing instructions'))
      assert.equal(f.agents[0].system.includes('Gortex community routing'), communityRouting)
      assert.equal(f.agents[1].system?.includes('Gortex community routing') ?? false, communityRouting)
      await assert.rejects(readFile(path.join(f.directory, 'AGENTS.md')), { code: 'ENOENT' })
      await assert.rejects(readFile(path.join(f.directory, 'opencode.json')), { code: 'ENOENT' })
      if (installSkills) {
        const call = calls.find(call => call.args[0] === 'install')
        assert.ok(call.args.includes('--agents=opencode'))
        assert.ok(call.args.includes('--no-hooks'))
        assert.ok(call.args.includes('--no-claude-md'))
        assert.equal(call.cwd, call.home)
        assert.notEqual(call.home, process.env.HOME)
        assert.equal(call.xdg, path.join(call.home, '.config'))
        await assert.rejects(readdir(call.home), { code: 'ENOENT' })
        assert.match(await readFile(path.join(f.directory, '.opencode', 'skills', 'gortex-explore', 'SKILL.md'), 'utf8'), /Curated skill/)
        assert.deepEqual(await readdir(path.join(f.directory, '.opencode')), ['skills'])
      }
    })
  }
}

test('skill installation preserves customized skills; routing does not accumulate', async t => {
  const f = await fixture(t, { installSkills: true, communityRouting: true })
  const target = path.join(f.directory, '.opencode', 'skills', 'gortex-explore')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'SKILL.md'), 'my skill')
  await plugin.setup(f.ctx)
  await plugin.setup(f.ctx)
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), 'my skill')
  assert.equal(f.agents[0].system.split('Gortex community routing').length, 2)
})

for (const fail of ['version', 'track', 'repos', 'repos-json', 'repos-missing', 'install', 'install-report']) {
  test(`startup propagates ${fail} failure and registers no MCP`, async t => {
    const f = await fixture(t, { installSkills: true }, fail)
    await assert.rejects(plugin.setup(f.ctx), /opencode-gortex:/)
    assert.equal(f.servers.size, 0)
    if (fail === 'version') assert.deepEqual(await readdir(f.directory), ['package.json'])
    const install = (await f.calls()).find(call => call.args[0] === 'install')
    if (install) await assert.rejects(readdir(install.home), { code: 'ENOENT' })
  })
}

test('missing executable errors before project writes', async t => {
  const f = await fixture(t, { binary: path.join(tmpdir(), 'missing-gortex-cli-unique') })
  await assert.rejects(plugin.setup(f.ctx), /CLI is missing or unusable/)
  assert.deepEqual(await readdir(f.directory), ['package.json'])
})

test('relative binary paths work during isolated skill installation', async t => {
  const f = await fixture(t, { installSkills: true })
  f.ctx.options.binary = path.relative(f.directory, f.binary)
  await plugin.setup(f.ctx)
  assert.equal(f.servers.get('gortex').command[0], f.binary)
  assert.match(await readFile(path.join(f.directory, '.opencode', 'skills', 'gortex-explore', 'SKILL.md'), 'utf8'), /Curated skill/)
})

test('home, its ancestors, filesystem root and symlink aliases are rejected before any CLI call', async t => {
  const f = await fixture(t)
  const alias = path.join(f.root, 'home-alias')
  await symlink(homedir(), alias, 'junction')
  for (const directory of [homedir(), path.dirname(homedir()), path.parse(f.directory).root, alias]) {
    f.ctx.location.directory = directory
    await assert.rejects(plugin.setup(f.ctx), /refusing to track/)
  }
  await assert.rejects(f.calls(), { code: 'ENOENT' })
  assert.equal(f.servers.size, 0)
})

for (const options of [{ installSkills: 'false' }, { communityRouting: 1 }, { binary: '' }, { binary: 1 }]) {
  test(`invalid options are rejected: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options)
    await assert.rejects(plugin.setup(f.ctx), /must be/)
    assert.deepEqual(await readdir(f.directory), ['package.json'])
  })
}

test('unmarked folders and existing plugin markers never qualify as projects', async t => {
  const f = await fixture(t, { installSkills: true, communityRouting: true })
  await rm(path.join(f.directory, 'package.json'))
  for (const marker of ['', '.gortex', '.opencode']) {
    if (marker) await mkdir(path.join(f.directory, marker))
    await assert.rejects(plugin.setup(f.ctx), /without a project manifest or Git root/)
  }
  await assert.rejects(f.calls(), { code: 'ENOENT' })
  assert.equal(f.servers.size, 0)
  assert.deepEqual(f.counts(), { reloads: 0, transforms: 0 })
  assert.deepEqual(await readdir(path.join(f.directory, '.gortex')), [])
})

test('private directories are rejected even when they contain a project manifest', async t => {
  const f = await fixture(t)
  for (const name of ['.ssh', '.aws', '.config', '.cache', '.git', 'node_modules']) {
    const directory = path.join(f.root, name, 'project')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'package.json'), '{}')
    f.ctx.location.directory = directory
    await assert.rejects(plugin.setup(f.ctx), /private directory/)
    assert.deepEqual(await readdir(directory), ['package.json'])
  }
  await assert.rejects(f.calls(), { code: 'ENOENT' })
  assert.equal(f.servers.size, 0)
})

test('project manifest must be a regular file, not a directory or symlink', async t => {
  const f = await fixture(t)
  const manifest = path.join(f.directory, 'package.json')
  await rm(manifest)
  await mkdir(manifest)
  await assert.rejects(plugin.setup(f.ctx), /without a project manifest/)
  await rm(manifest, { recursive: true })
  const outside = path.join(f.root, 'package.json')
  await writeFile(outside, '{}')
  await symlink(outside, manifest)
  await assert.rejects(plugin.setup(f.ctx), /without a project manifest/)
  await assert.rejects(f.calls(), { code: 'ENOENT' })
})

test('Git repositories and linked worktrees qualify without a language manifest', async t => {
  const f = await fixture(t)
  const git = promisify(execFile)
  await rm(path.join(f.directory, 'package.json'))
  await git('git', ['init', f.directory])
  await git('git', ['-C', f.directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'])
  await plugin.setup(f.ctx)
  const worktree = path.join(f.root, 'worktree')
  await git('git', ['-C', f.directory, 'worktree', 'add', '-b', 'test', worktree])
  f.ctx.location.directory = worktree
  await plugin.setup(f.ctx)
  assert.deepEqual((await f.calls()).filter(call => call.args[0] === 'track').map(call => call.args[1]), [f.directory, worktree])
})

test('opening a child or parent folder does not widen indexing to an ancestor or sibling project', async t => {
  const f = await fixture(t)
  const child = path.join(f.directory, 'src')
  await mkdir(child)
  for (const directory of [child, f.root]) {
    f.ctx.location.directory = directory
    await assert.rejects(plugin.setup(f.ctx), /without a project manifest/)
    await assert.rejects(readFile(path.join(directory, '.gortex', '.gitignore')), { code: 'ENOENT' })
  }
  await assert.rejects(f.calls(), { code: 'ENOENT' })
})

test('project symlinks are tracked and registered using only the canonical project path', async t => {
  const f = await fixture(t)
  const alias = path.join(f.root, 'project-alias')
  await symlink(f.directory, alias, 'junction')
  f.ctx.location.directory = alias
  await plugin.setup(f.ctx)
  assert.deepEqual((await f.calls()).map(call => call.args), [['version'], ['track', f.directory], ['repos', '--json']])
  assert.equal(f.servers.get('gortex').cwd, f.directory)
  assert.equal(f.servers.get('gortex').command.at(-1), f.directory)
})

test('a home directory with project markers is still rejected on every instance', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.root, 'package.json'), '{}')
  await mkdir(path.join(f.root, '.git'))
  const script = `
    import assert from 'node:assert/strict'
    import plugin from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
    for (let instance = 0; instance < 3; instance++) {
      await assert.rejects(plugin.setup({ options: { binary: ${JSON.stringify(f.binary)} }, location: { directory: ${JSON.stringify(f.root)} } }), /home directory/)
    }
  `
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: f.root, USERPROFILE: f.root },
  })
  await assert.rejects(f.calls(), { code: 'ENOENT' })
  await assert.rejects(readdir(path.join(f.root, '.gortex')), { code: 'ENOENT' })
})

test('an empty .git directory is not proof of a Git project', async t => {
  const f = await fixture(t)
  await rm(path.join(f.directory, 'package.json'))
  await mkdir(path.join(f.directory, '.git'))
  await assert.rejects(plugin.setup(f.ctx), /unverified Git root/)
  await assert.rejects(f.calls(), { code: 'ENOENT' })
  assert.equal(f.servers.size, 0)
})

for (const source of ['default-install', 'configured-name', 'custom-install', 'path-first']) {
  test(`discovers Gortex with a restricted server PATH: ${source}`, async t => {
    const f = await fixture(t)
    const homeBinary = path.join(f.root, '.local', 'bin', 'gortex')
    const pathDir = path.join(f.root, 'path-bin')
    const customDir = path.join(f.root, 'custom-bin')
    await mkdir(path.dirname(homeBinary), { recursive: true })
    await mkdir(pathDir)
    await mkdir(customDir)
    await copyFile(f.binary, homeBinary)
    const expected = source === 'path-first' ? path.join(pathDir, 'gortex')
      : source === 'custom-install' ? path.join(customDir, 'gortex') : homeBinary
    if (expected !== homeBinary) await copyFile(f.binary, expected)
    const options = { installSkills: true, ...(source === 'configured-name' ? { binary: 'gortex' } : {}) }
    const script = `
      import assert from 'node:assert/strict'
      import plugin from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
      let server
      await plugin.setup({
        options: ${JSON.stringify(options)}, location: { directory: ${JSON.stringify(f.directory)} },
        mcp: { transform: async fn => fn({ get: () => undefined, set: (name, value) => { server = value } }) },
        skill: { reload: async () => {} },
        tool: { hook: async () => {} },
      })
      assert.equal(server.command[0], ${JSON.stringify(expected)})
    `
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: f.root, USERPROFILE: f.root, PATH: pathDir,
        GORTEX_INSTALL_DIR: source === 'custom-install' ? customDir : '' },
    })
    assert.deepEqual((await f.calls()).map(call => call.args[0]), ['version', 'track', 'repos', 'install'])
    assert.match(await readFile(path.join(f.directory, '.opencode', 'skills', 'gortex-explore', 'SKILL.md'), 'utf8'), /Curated skill/)
  })
}
