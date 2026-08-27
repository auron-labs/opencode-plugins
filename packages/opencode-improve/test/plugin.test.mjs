import test from 'node:test'
import assert from 'node:assert/strict'

import pluginModule from '../dist/index.js'

test('plugin injects improve agent and command', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })
  const config = {}

  await plugin.config(config)

  assert.equal(pluginModule.id, 'opencode-improve')
  assert.ok(config.agent.improve)
  assert.equal(config.agent.improve.hidden, undefined)
  assert.equal(config.agent.improve.mode, 'primary')
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
  assert.equal(config.command.improve.subtask, undefined)
  assert.equal(typeof config.command.improve.description, 'string')
  assert.ok(config.command.improve.description.includes('help'))
  // OpenCode's command config has no argHints field; autocomplete guidance belongs in the description/template.
  assert.equal(Object.hasOwn(config.command.improve, 'argHints'), false)
  assert.equal(config.command.improve.template, 'Improve request: $ARGUMENTS')
})

test('/improve command hook routes variants and composes modifiers', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })
  const config = {}

  await plugin.config(config)

  const before = plugin['command.execute.before']
  const run = async (argumentsText) => {
    const part = { type: 'text', text: 'original prompt' }
    await before({ command: 'improve', sessionID: 'session-1', arguments: argumentsText }, { parts: [part] })
    return part.text
  }

  const routes = [
    ['', 'Route: bare audit.'],
    ['quick', 'Route: bare audit.'],
    ['plan add caching', 'Route: plan.'],
    ['review-plan plans/cache.md', 'Route: review-plan.'],
    ['execute plans/cache.md', 'Route: execute.'],
    ['reconcile', 'Route: reconcile.'],
    ['branch deep', 'Route: branch audit.'],
    ['features', 'Route: direction audit.'],
    ['next', 'Route: direction audit.'],
    ['roadmap quick', 'Route: direction audit.'],
    ['security', 'Route: focused audit (security).'],
    ['not-a-command --issues', 'Route: plan (free-form request).'],
  ]
  const prompts = []
  for (const [argumentsText, route] of routes) {
    const prompt = await run(argumentsText)
    prompts.push(prompt)
    assert.ok(prompt.startsWith(route), `expected ${route} for ${argumentsText}`)
    assert.ok(prompt.includes(`Invocation arguments: ${argumentsText}`))
  }
  assert.equal(new Set(prompts).size, prompts.length)

  const composed = await run('deep security --issues')
  assert.ok(composed.startsWith('Route: focused audit (security).'))
  assert.ok(composed.includes('Effort modifier: deep'))
  assert.ok(composed.includes('Explicit --issues modifier'))
})

test('/improve command hook gives help precedence and preserves unrelated parts', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })
  await plugin.config({})
  const before = plugin['command.execute.before']
  const metadata = { id: 'part-1', metadata: { source: 'test' } }
  const part = { type: 'text', text: 'original prompt', ...metadata }
  const output = { parts: [part] }

  await before(
    { command: 'improve', sessionID: 'session-1', arguments: 'plan ship it --help' },
    output,
  )

  assert.equal(output.parts[0], part)
  assert.equal(part.id, 'part-1')
  assert.deepEqual(part.metadata, { source: 'test' })
  assert.ok(part.text.startsWith('Route: help.'))
  assert.ok(part.text.includes('Do not audit, inspect the repository, write plans, dispatch, or publish issues.'))

  const noTextOutput = { parts: [{ type: 'tool', id: 'tool-1' }] }
  await before(
    { command: 'improve', sessionID: 'session-1', arguments: '' },
    noTextOutput,
  )
  assert.deepEqual(noTextOutput.parts, [{ type: 'tool', id: 'tool-1' }])

  const unrelatedPart = { type: 'text', text: 'leave this alone', id: 'other' }
  const unrelatedOutput = { parts: [unrelatedPart] }
  await before(
    { command: 'other', sessionID: 'session-1', arguments: 'security' },
    unrelatedOutput,
  )
  assert.equal(unrelatedOutput.parts[0], unrelatedPart)
  assert.equal(unrelatedPart.text, 'leave this alone')
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

  const part = { type: 'text', text: 'custom command prompt', id: 'custom' }
  await plugin['command.execute.before'](
    { command: 'improve', sessionID: 'session-1', arguments: 'security' },
    { parts: [part] },
  )
  assert.equal(part.text, 'custom command prompt')
})
