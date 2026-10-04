import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('supports the v2 plugin shape', async () => {
  assert.equal(typeof pluginModule.setup, 'function')

  const added = []
  const ctx = {
    options: {},
    location: { directory: process.cwd() },
    tool: { transform: async (callback) => callback({ add: (tool) => added.push(tool) }) },
  }

  await pluginModule.setup(ctx)

  assert.deepEqual(added.map((tool) => tool.name).sort(), [
    'worktrunk_list',
    'worktrunk_merge',
    'worktrunk_remove',
    'worktrunk_run',
    'worktrunk_step',
    'worktrunk_switch',
  ])
  for (const tool of added) {
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.input)
  }
})


test('v1 and v2 instances preserve their own cwd and options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worktrunk-instances-'))
  try {
    const one = join(root, 'one')
    const two = join(root, 'two')
    mkdirSync(one)
    mkdirSync(two)
    const binary = join(root, 'wt')
    writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }))`, { mode: 0o755 })
    const v1 = await WorktrunkPlugin({ directory: one }, { binary, autoYes: false })
    const added = []
    await pluginModule.setup({ location: { directory: two }, options: { binary, autoYes: true }, tool: { transform: async (callback) => callback({ add: (tool) => added.push(tool) }) } })
    const second = await added.find((tool) => tool.name === 'worktrunk_list').execute({}, { sessionID: 's2', messageID: 'm2', agent: 'build', id: 'c2' })
    const first = JSON.parse(await v1.tool.worktrunk_list.execute({}, {}))
    assert.equal(first.cwd, one)
    assert.equal(first.args.includes('-y'), false)
    const data = JSON.parse(second.content)
    assert.equal(data.cwd, two)
    assert.equal(data.args.includes('-y'), true)
    await assert.rejects(added.find((tool) => tool.name === 'worktrunk_switch').input.parseAsync({ branch: 17 }), /branch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
