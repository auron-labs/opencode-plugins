import test from 'node:test'
import assert from 'node:assert/strict'

import pluginModule, { WorktrunkPlugin } from '../dist/index.js'

test('plugin exports default module metadata', () => {
  assert.equal(pluginModule.id, 'opencode-worktrunk')
  assert.equal(pluginModule.server, WorktrunkPlugin)
})

test('plugin exposes the expected worktrunk tools', async () => {
  const plugin = await WorktrunkPlugin({ directory: process.cwd() }, { autoYes: true })

  assert.deepEqual(Object.keys(plugin.tool).sort(), [
    'worktrunk_list',
    'worktrunk_merge',
    'worktrunk_remove',
    'worktrunk_run',
    'worktrunk_step',
    'worktrunk_switch',
  ])
})

test('worktrunk_run surfaces a missing binary as a clear error', async () => {
  const plugin = await WorktrunkPlugin(
    { directory: process.cwd() },
    { binary: 'definitely-missing-wt', autoYes: false },
  )

  await assert.rejects(
    plugin.tool.worktrunk_run.execute({ args: ['--version'] }),
    /definitely-missing-wt/,
  )
})

test('worktrunk_list reports a missing binary as a clear error', async () => {
  const plugin = await WorktrunkPlugin(
    { directory: process.cwd() },
    { binary: 'definitely-missing-wt', autoYes: false },
  )

  await assert.rejects(
    plugin.tool.worktrunk_list.execute({}),
    /definitely-missing-wt/,
  )
})
