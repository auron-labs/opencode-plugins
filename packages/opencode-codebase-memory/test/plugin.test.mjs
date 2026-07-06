import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import pluginModule, { CodebaseMemoryPlugin } from '../dist/index.js'

test('plugin exports default module metadata', () => {
  assert.equal(pluginModule.id, 'opencode-codebase-memory')
  assert.equal(pluginModule.server, CodebaseMemoryPlugin)
})

test('disabled plugin does not inject MCP config', async () => {
  const plugin = await CodebaseMemoryPlugin({ directory: process.cwd() }, { enabled: false })
  const config = {}

  await plugin.config(config)

  assert.deepEqual(config, {})
  assert.ok(plugin.tool.codebase_memory_project)
  assert.ok(plugin.tool.codebase_memory_index_project)
})

test('enabled plugin injects MCP config without startup indexing', async () => {
  const plugin = await CodebaseMemoryPlugin(
    { directory: process.cwd() },
    { enabled: true, indexOnStartup: false, binary: 'codebase-memory-mcp-custom' },
  )
  const config = {}

  await plugin.config(config)

  assert.deepEqual(config, {
    mcp: {
      'codebase-memory-mcp': {
        type: 'local',
        command: ['codebase-memory-mcp-custom'],
        enabled: true,
      },
    },
  })
})

test('disabled plugin reports idle project state without starting indexing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-test-'))

  try {
    const plugin = await CodebaseMemoryPlugin(
      { directory },
      { enabled: false, binary: 'definitely-missing-codebase-memory-mcp' },
    )

    const state = JSON.parse(await plugin.tool.codebase_memory_project.execute({}))

    assert.deepEqual(state, {
      rootPath: directory,
      project: null,
      indexed: false,
      status: 'idle',
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('enabled plugin skips filesystem root indexing', async () => {
  const plugin = await CodebaseMemoryPlugin(
    { directory: '/' },
    { enabled: true, binary: 'definitely-missing-codebase-memory-mcp' },
  )

  const state = JSON.parse(await plugin.tool.codebase_memory_project.execute({}))

  assert.equal(state.rootPath, '/')
  assert.equal(state.indexed, false)
  assert.equal(state.status, 'skipped')
  assert.match(state.error, /filesystem root/)
})

test('enabled plugin skips home directory indexing', async () => {
  const plugin = await CodebaseMemoryPlugin(
    { directory: homedir() },
    { enabled: true, binary: 'definitely-missing-codebase-memory-mcp' },
  )

  const state = JSON.parse(await plugin.tool.codebase_memory_project.execute({}))

  assert.equal(state.rootPath, homedir())
  assert.equal(state.indexed, false)
  assert.equal(state.status, 'skipped')
  assert.match(state.error, /home directory/)
})

test('enabled plugin resolves nested directory to nearest project marker root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-test-'))
  const nested = join(directory, 'packages', 'demo')

  try {
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(directory, 'package.json'), '{}')

    const plugin = await CodebaseMemoryPlugin(
      { directory: nested },
      { enabled: true, indexOnStartup: false, binary: 'definitely-missing-codebase-memory-mcp' },
    )

    const state = JSON.parse(await plugin.tool.codebase_memory_project.execute({}))

    assert.equal(state.rootPath, directory)
    assert.equal(state.indexed, false)
    assert.equal(state.status, 'idle')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('enabled plugin skips directories without project markers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-test-'))

  try {
    const plugin = await CodebaseMemoryPlugin(
      { directory },
      { enabled: true, indexOnStartup: false, binary: 'definitely-missing-codebase-memory-mcp' },
    )

    const state = JSON.parse(await plugin.tool.codebase_memory_project.execute({}))

    assert.equal(state.rootPath, directory)
    assert.equal(state.indexed, false)
    assert.equal(state.status, 'skipped')
    assert.match(state.error, /project root marker/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
