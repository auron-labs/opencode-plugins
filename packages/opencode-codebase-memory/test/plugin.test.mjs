import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
