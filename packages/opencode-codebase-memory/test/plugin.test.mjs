import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import pluginModule, { CodebaseMemoryPlugin } from '../dist/index.js'

function makeProject() {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-test-'))
  mkdirSync(join(directory, '.git'))
  return directory
}

function writeScript(directory, name, source) {
  writeFileSync(join(directory, name), `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 })
}

function cliScript() {
  return `
const { appendFileSync } = require('node:fs')

const mode = process.env.CBM_CLI_MODE
const logPath = process.env.CBM_TEST_LOG
const args = process.argv.slice(2)
if (logPath) appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }) + '\\n')

if (args.includes('index_repository')) {
  if (mode === 'nonzero') {
    process.stderr.write('index failed\\n')
    process.exit(7)
  }
  process.exit(0)
}

if (args.includes('list_projects')) {
  const toolArgs = args.slice(args.indexOf('list_projects') + 1)
  function respond() {
    if (mode === 'refresh-fail') {
      process.stderr.write('list_projects exploded\\n')
      process.exit(1)
    }
    const projects = mode === 'listed' ? [{ name: 'existing', root_path: process.cwd() }] : []
    const formatIndex = toolArgs.indexOf('--format')
    const format = formatIndex === -1 ? 'tree' : toolArgs[formatIndex + 1]
    const text = format === 'json' ? JSON.stringify({ projects }) : 'projects: ' + projects.length + '\\n'
    process.stdout.write(JSON.stringify({ content: [{ text }] }))
    process.exit(0)
  }
  if (toolArgs.length === 0) {
    process.stdin.resume()
    process.stdin.on('end', respond)
    // Bound the upstream stdin wait so a regression fails quickly.
    setTimeout(() => {
      process.stderr.write('list_projects timed out waiting for stdin\\n')
      process.exit(1)
    }, 1000)
  } else {
    respond()
  }
} else {
  process.exit(0)
}
`
}

async function withEnv(name, value, fn) {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

function entries(logPath) {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function entriesIfPresent(logPath) {
  try {
    return entries(logPath)
  } catch {
    return []
  }
}

function isAllowedStartupCommand({ args }) {
  return (args[0] === '--json' && args[1] === 'list_projects' && args[2] === '--format' && args[3] === 'json' && args.length === 4) ||
    (args[0] === '--progress' && args[1] === 'index_repository' && args.length === 3)
}

async function waitFor(fn, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function clientWithToasts(toasts) {
  return {
    tui: {
      async showToast({ body }) {
        toasts.push({ message: body.message, variant: body.variant })
      },
    },
  }
}

function v2Context(directory, options = {}, mcpConfig = {}) {
  const mcp = new Map(Object.entries(mcpConfig))
  const tools = new Map()
  return {
    mcp,
    tools,
    context: {
      location: { directory },
      options,
      mcp: {
        async transform(update) {
          update({
            get(name) { return mcp.get(name) },
            set(name, config) { mcp.set(name, config) },
          })
        },
      },
      tool: {
        async transform(update) {
          update({ add(definition) { tools.set(definition.name, definition) } })
        },
      },
    },
  }
}

test('v2 setup preserves the configured MCP and adds only the manual project tools', async () => {
  const directory = makeProject()
  const configuredServer = { type: 'local', command: ['custom-cbm', 'serve'], cwd: '/custom/root', enabled: true }
  const { context, mcp, tools } = v2Context(directory, { indexOnStartup: false }, { 'codebase-memory-mcp': configuredServer })

  try {
    await pluginModule.setup(context)

    assert.equal(mcp.get('codebase-memory-mcp'), configuredServer)
    assert.deepEqual([...tools.keys()].sort(), ['codebase_memory_index_project', 'codebase_memory_project'])
    assert.deepEqual(readdirSync(directory).sort(), ['.git'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('v1 server preserves configured MCP and does not inject agents or tool hooks', async () => {
  const directory = makeProject()
  const configuredServer = { type: 'local', command: ['custom-cbm', 'serve'], cwd: '/custom/root', enabled: true }

  try {
    const plugin = await CodebaseMemoryPlugin({ directory }, { enabled: true, indexOnStartup: false })
    const config = { mcp: { 'codebase-memory-mcp': configuredServer }, agent: {} }
    await plugin.config(config)

    assert.equal(config.mcp['codebase-memory-mcp'], configuredServer)
    assert.deepEqual(config.agent, {})
    assert.equal(plugin['tool.execute.after'], undefined)
    assert.deepEqual(Object.keys(plugin.tool).sort(), ['codebase_memory_index_project', 'codebase_memory_project'])

    const generated = {}
    await plugin.config(generated)
    assert.equal(generated.mcp['codebase-memory-mcp'].type, 'local')
    assert.equal(generated.agent, undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const version of ['v1', 'v2']) {
  test(`${version} project refresh requests JSON without waiting for stdin`, async () => {
    const directory = makeProject()

    try {
      writeScript(directory, 'cli', cliScript())
      await withEnv('CBM_CLI_MODE', 'listed', async () => {
        const options = { binary: process.execPath, indexOnStartup: false }
        let state
        if (version === 'v1') {
          const plugin = await CodebaseMemoryPlugin({ directory }, options)
          state = JSON.parse(await plugin.tool.codebase_memory_project.execute({ refresh: true }))
        } else {
          const { context, tools } = v2Context(directory, options)
          await pluginModule.setup(context)
          state = (await tools.get('codebase_memory_project').execute({ refresh: true })).output
        }

        assert.equal(state.status, 'ready')
        assert.equal(state.project, 'existing')
        assert.equal(state.indexed, true)
        assert.equal(state.error, undefined)
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test('startup indexes separate unindexed safe project roots without writing project instructions', async () => {
  const directories = [makeProject(), makeProject()]
  const logDirectory = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-log-'))
  const logPath = join(logDirectory, 'calls.jsonl')

  try {
    for (const directory of directories) writeScript(directory, 'cli', cliScript())
    await withEnv('CBM_TEST_LOG', logPath, async () => {
      const setups = directories.map((directory) => v2Context(directory, { binary: process.execPath }))
      await Promise.all(setups.map(({ context }) => pluginModule.setup(context)))
      for (let index = 0; index < directories.length; index++) {
        const server = setups[index].mcp.get('codebase-memory-mcp')
        assert.deepEqual(server.command, [process.execPath])
        assert.equal(server.cwd, directories[index])
      }

      await Promise.all(setups.map(({ tools }, index) => waitFor(async () => {
        const state = await tools.get('codebase_memory_project').execute({})
        const calls = entriesIfPresent(logPath)
        const rootCalls = calls.filter((call) => call.cwd === directories[index])
        return { state, rootCalls }
      }, ({ state, rootCalls }) =>
        state.output.status === 'idle' &&
        rootCalls.some((call) => call.args.includes('index_repository')) &&
        rootCalls.filter((call) => call.args.includes('list_projects')).length >= 2,
      )))

      const calls = entries(logPath)
      assert.equal(calls.filter((call) => call.args.includes('index_repository')).length, 2)
      assert.equal(calls.every(isAllowedStartupCommand), true)
      for (const directory of directories) {
        assert.deepEqual(readdirSync(directory).sort(), ['.git', 'cli'])
      }
    })
  } finally {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    rmSync(logDirectory, { recursive: true, force: true })
  }
})

test('startup skips an already indexed project', async () => {
  const directory = makeProject()
  const logDirectory = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-log-'))
  const logPath = join(logDirectory, 'calls.jsonl')

  try {
    writeScript(directory, 'cli', cliScript())
    await withEnv('CBM_TEST_LOG', logPath, async () => {
      await withEnv('CBM_CLI_MODE', 'listed', async () => {
        const { context, tools } = v2Context(directory, { binary: process.execPath })
        await pluginModule.setup(context)
        const result = await waitFor(
          () => tools.get('codebase_memory_project').execute({}),
          (state) => state.output.indexed,
        )

        assert.equal(result.output.status, 'ready')
        assert.equal(entriesIfPresent(logPath).some((call) => call.args.includes('index_repository')), false)
      })
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(logDirectory, { recursive: true, force: true })
  }
})

test('startup does not invoke codebase-memory in markerless or disallowed roots', async () => {
  const markerless = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-empty-'))
  const directory = makeProject()
  const allowedRoot = makeProject()
  const logDirectory = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-log-'))
  const logPath = join(logDirectory, 'calls.jsonl')

  try {
    writeScript(directory, 'cli', cliScript())
    for (const candidate of [markerless, directory]) {
      await withEnv('CBM_TEST_LOG', logPath, async () => {
        if (candidate === directory) {
          await withEnv('CBM_ALLOWED_ROOT', allowedRoot, async () => {
            const { context } = v2Context(candidate, { binary: process.execPath })
            await pluginModule.setup(context)
          })
        } else {
          const { context } = v2Context(candidate, { binary: process.execPath })
          await pluginModule.setup(context)
        }
      })
    }

    assert.deepEqual(entriesIfPresent(logPath), [])
  } finally {
    for (const candidate of [markerless, directory, allowedRoot]) rmSync(candidate, { recursive: true, force: true })
    rmSync(logDirectory, { recursive: true, force: true })
  }
})

test('index process failures are terminal once and refresh failures remain failed', async () => {
  const cases = [
    { mode: 'nonzero', expected: /index failed|exit 7/ },
    { mode: 'refresh-fail', expected: /Command failed|status refresh failed/ },
  ]

  for (const { mode, expected } of cases) {
    const directory = makeProject()
    const logPath = join(directory, 'process.log')
    writeScript(directory, 'cli', cliScript())
    writeScript(directory, 'config', cliScript())
    const toasts = []
    try {
      await withEnv('CBM_TEST_LOG', logPath, async () => {
        await withEnv('CBM_CLI_MODE', mode, async () => {
          const plugin = await CodebaseMemoryPlugin(
            { directory, client: clientWithToasts(toasts) },
            { enabled: true, binary: process.execPath, indexOnStartup: false },
          )
          await plugin.tool.codebase_memory_index_project.execute({ force: true })
          const state = await waitFor(
            () => plugin.tool.codebase_memory_project.execute({}),
            (value) => JSON.parse(value).status === 'failed',
          )
          const parsed = JSON.parse(state)
          assert.equal(parsed.status, 'failed')
          assert.equal(parsed.lock, undefined)
          assert.match(parsed.error, expected)
          assert.equal(toasts.filter((toast) => toast.variant === 'error').length, 1)
          const invocations = entries(logPath)
          assert.equal(invocations.filter((entry) => entry.args?.includes('index_repository')).length, 1)
          assert.equal(invocations.filter((entry) => entry.args?.includes('list_projects')).length, mode === 'refresh-fail' ? 1 : 0)
          const before = invocations.length
          await plugin.tool.codebase_memory_project.execute({})
          await plugin.tool.codebase_memory_project.execute({})
          assert.equal(entries(logPath).length, before)
        })
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('spawn error followed by close produces one terminal error', async () => {
  const directory = makeProject()
  const toasts = []

  try {
    const plugin = await CodebaseMemoryPlugin(
      { directory, client: clientWithToasts(toasts) },
      { enabled: true, binary: directory, indexOnStartup: false },
    )
    await plugin.tool.codebase_memory_index_project.execute({ force: true })
    const state = await waitFor(
      () => plugin.tool.codebase_memory_project.execute({}),
      (value) => JSON.parse(value).status === 'failed',
    )
    assert.equal(JSON.parse(state).lock, undefined)
    assert.equal(toasts.filter((toast) => toast.variant === 'error').length, 1)
    await plugin.tool.codebase_memory_project.execute({})
    assert.equal(toasts.filter((toast) => toast.variant === 'error').length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('exposes both the v1 server and v2 setup entrypoints', () => {
  assert.equal(pluginModule.id, 'opencode-codebase-memory')
  assert.equal(pluginModule.server, CodebaseMemoryPlugin)
  assert.equal(typeof pluginModule.setup, 'function')
})
