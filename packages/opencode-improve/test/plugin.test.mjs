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

  // bundled references live outside the project root when installed from a
  // package cache, so the agent must pre-approve reads/external_directory for
  // its own refs dir to avoid prompting on every audit
  const refsGlob = Object.keys(config.agent.improve.permission.read)[0]
  assert.ok(refsGlob.endsWith('/references/**'), `expected refs glob, got ${refsGlob}`)
  assert.equal(config.agent.improve.permission.read[refsGlob], 'allow')
  assert.equal(config.agent.improve.permission.external_directory[refsGlob], 'allow')
  assert.equal(typeof config.agent.improve.prompt, 'string')
  assert.ok(config.agent.improve.prompt.length > 100)
  assert.ok(config.agent.improve.prompt.includes('execute <plan>'))

  assert.ok(config.command.improve)
  assert.equal(config.command.improve.agent, 'improve')
  assert.equal(config.command.improve.subtask, true)
  assert.equal(typeof config.command.improve.description, 'string')
  assert.ok(config.command.improve.description.includes('help'))
  assert.ok(config.command.improve.template.includes('$ARGUMENTS'))
  assert.ok(config.command.improve.template.includes('help'))
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
