import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import pluginModule from '../dist/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const refsDirAbs = fileURLToPath(new URL('../references', import.meta.url))

test('plugin module exports id and server', () => {
  assert.equal(pluginModule.id, 'opencode-impeccable')
  assert.equal(typeof pluginModule.server, 'function')
})

test('plugin registers a hidden impeccable agent and every /impeccable-* command on first run', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })
  const config = {}

  await plugin.config(config)

  assert.ok(config.agent.impeccable)
  assert.equal(config.agent.impeccable.hidden, true)
  assert.equal(config.agent.impeccable.mode, 'subagent')
  assert.equal(config.agent.impeccable.permission.edit['**'], 'deny')
  assert.equal(typeof config.agent.impeccable.prompt, 'string')
  assert.ok(config.agent.impeccable.prompt.length > 200)
  // The vendored SKILL.md intentionally drops Bash(npx impeccable *) so the
  // LLM must reach for the plugin's tools instead.
  assert.doesNotMatch(config.agent.impeccable.prompt, /Bash\(npx impeccable/)
  assert.match(config.agent.impeccable.prompt, /impeccable_context/)
  assert.match(config.agent.impeccable.prompt, /impeccable_detect/)

  const refsGlob = Object.keys(config.agent.impeccable.permission.read)[0]
  assert.ok(refsGlob.endsWith('/references/**'), `expected refs glob, got ${refsGlob}`)
  assert.equal(config.agent.impeccable.permission.read[refsGlob], 'allow')
  assert.equal(config.agent.impeccable.permission.external_directory[refsGlob], 'allow')

  // Every skills command must produce a command entry.
  const commandNames = Object.keys(config.command)
  assert.ok(commandNames.includes('impeccable'), 'impeccable menu command missing')
  for (const expected of [
    'impeccable-craft',
    'impeccable-shape',
    'impeccable-init',
    'impeccable-document',
    'impeccable-extract',
    'impeccable-critique',
    'impeccable-audit',
    'impeccable-polish',
    'impeccable-bolder',
    'impeccable-quieter',
    'impeccable-distill',
    'impeccable-harden',
    'impeccable-onboard',
    'impeccable-animate',
    'impeccable-colorize',
    'impeccable-typeset',
    'impeccable-layout',
    'impeccable-delight',
    'impeccable-overdrive',
    'impeccable-clarify',
    'impeccable-adapt',
    'impeccable-optimize',
    'impeccable-live',
  ]) {
    assert.ok(commandNames.includes(expected), `expected command ${expected} to be registered`)
  }
})

test('every command template points at an existing reference file under references/', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })
  const config = {}
  await plugin.config(config)

  for (const [name, entry] of Object.entries(config.command)) {
    if (!entry.template) continue
    const matches = entry.template.match(/`([^\`]+\.md)`/g) ?? []
    for (const match of matches) {
      const absOrRel = match.slice(1, -1)
      // Ignore placeholder strings like `/<command>.md` used by the menu command.
      if (/<[^>]+>/.test(absOrRel)) continue
      const absolute = absOrRel.startsWith('/') || absOrRel.startsWith(repoRoot)
        ? absOrRel
        : join(refsDirAbs, absOrRel.split('/').pop())
      assert.ok(
        existsSync(absolute),
        `command ${name} references a non-existent file: ${absOrRel}`,
      )
    }
  }
})

test('plugin preserves existing agent/command entries (does not overwrite)', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })
  const config = {
    agent: { impeccable: { description: 'existing' } },
    command: { impeccable: { description: 'existing menu' } },
  }

  await plugin.config(config)

  assert.equal(config.agent.impeccable.description, 'existing')
  assert.equal(config.command.impeccable.description, 'existing menu')
})

test('plugin exposes the 14 impeccable_* tools', async () => {
  const plugin = await pluginModule.server({ directory: process.cwd() })

  const expectedTools = [
    'impeccable_context',
    'impeccable_detect',
    'impeccable_doctor',
    'impeccable_install',
    'impeccable_update',
    'impeccable_check',
    'impeccable_pin',
    'impeccable_hooks_status',
    'impeccable_hooks_toggle',
    'impeccable_hooks_ignore_value',
    'impeccable_hooks_ignore_rule',
    'impeccable_hooks_ignore_file',
    'impeccable_hooks_reset',
    'impeccable_ignores',
  ]

  for (const toolName of expectedTools) {
    assert.ok(plugin.tool[toolName], `expected tool ${toolName}`)
    assert.equal(typeof plugin.tool[toolName].description, 'string')
    assert.ok(plugin.tool[toolName].description.length > 10)
  }

  assert.equal(typeof plugin['tool.execute.after'], 'function')
  assert.equal(typeof plugin.event, 'function')
})

test('vendor references match the skill command table', () => {
  const files = readdirSync(refsDirAbs).filter((name) => name.endsWith('.md')).sort()
  assert.ok(files.includes('SKILL.md'), 'references/SKILL.md must exist')
  for (const expected of [
    'craft.md',
    'shape.md',
    'init.md',
    'document.md',
    'extract.md',
    'critique.md',
    'audit.md',
    'audit.native.md',
    'polish.md',
    'bolder.md',
    'quieter.md',
    'distill.md',
    'harden.md',
    'onboard.md',
    'animate.md',
    'colorize.md',
    'typeset.md',
    'layout.md',
    'delight.md',
    'overdrive.md',
    'clarify.md',
    'adapt.md',
    'adapt.native.md',
    'optimize.md',
    'live.md',
    'hooks.md',
    'doctor.md',
    'routing.md',
    'craft-floor.md',
    'new-work.md',
    'operate.md',
  ]) {
    assert.ok(files.includes(expected), `expected reference ${expected} to be vendored`)
  }
  // ensure vendored SKILL.md does not leak the Bash(...) allowed-tools line
  const skillBody = readFileSync(join(refsDirAbs, 'SKILL.md'), 'utf8')
  assert.doesNotMatch(skillBody, /allowed-tools:\s*\n\s*Bash\(npx impeccable/)
})
