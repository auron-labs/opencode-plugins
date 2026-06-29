import test from 'node:test'
import assert from 'node:assert/strict'

import pluginModule from '../dist/index.js'

test('plugin injects improve agent and command', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })
  const config = {}

  await plugin.config(config)

  assert.equal(pluginModule.id, 'opencode-improve')
  assert.ok(config.agent.improve)
  assert.equal(config.agent.improve.hidden, true)
  assert.equal(config.agent.improve.mode, 'subagent')
  assert.equal(config.agent.improve.permission.edit['plans/**'], 'allow')
  assert.equal(config.agent.improve.permission.edit['**'], 'deny')
  assert.equal(typeof config.agent.improve.prompt, 'string')
  assert.ok(config.agent.improve.prompt.length > 100)
  assert.ok(config.agent.improve.prompt.includes('execute <plan>'))

  assert.ok(config.command.improve)
  assert.equal(config.command.improve.agent, 'improve')
  assert.equal(config.command.improve.subtask, true)
})

test('plugin preserves existing improve entries', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })
  const config = {
    agent: { improve: { description: 'existing' } },
    command: { improve: { description: 'existing command' } },
  }

  await plugin.config(config)

  assert.equal(config.agent.improve.description, 'existing')
  assert.equal(config.command.improve.description, 'existing command')
})
