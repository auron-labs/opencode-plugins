import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import pluginModule, { ZellijPlugin } from '../dist/index.js'

test('plugin exports default module metadata', () => {
  assert.equal(pluginModule.id, 'opencode-zellij')
  assert.equal(pluginModule.server, ZellijPlugin)
})

test('plugin exposes expected tools without contacting zellij', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opencode-zellij-test-'))

  try {
    const plugin = await ZellijPlugin(
      { directory: process.cwd() },
      { stateFile: join(tempDir, 'zellij.json'), closeOnExitCleanup: false },
    )

    assert.deepEqual(Object.keys(plugin.tool).sort(), [
      'zellij_events',
      'zellij_list',
      'zellij_read',
      'zellij_restart',
      'zellij_spawn',
      'zellij_stop',
      'zellij_subscribe',
      'zellij_wait',
    ])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('zellij_list reports disconnected status for a missing binary', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opencode-zellij-test-'))

  try {
    const plugin = await ZellijPlugin(
      { directory: process.cwd() },
      {
        binary: 'definitely-missing-zellij',
        session: 'test-session',
        stateFile: join(tempDir, 'zellij.json'),
        closeOnExitCleanup: false,
      },
    )

    const result = JSON.parse(await plugin.tool.zellij_list.execute({}))

    assert.equal(result.session, 'test-session')
    assert.equal(result.connected, false)
    assert.equal(result.livePanes, 0)
    assert.deepEqual(result.tracked, [])
    assert.match(result.error, /definitely-missing-zellij/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
