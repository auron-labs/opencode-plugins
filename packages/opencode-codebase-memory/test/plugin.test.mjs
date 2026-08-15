import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodebaseMemoryPlugin } from '../dist/index.js'

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
if (logPath) appendFileSync(logPath, JSON.stringify({ args }) + '\\n')

if (args.includes('index_repository')) {
  if (mode === 'nonzero') {
    process.stderr.write('index failed\\n')
    process.exit(7)
  }
  process.exit(0)
}

if (args.includes('list_projects')) {
  if (mode === 'refresh-fail') {
    process.stderr.write('list_projects exploded\\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({ content: [{ text: JSON.stringify({ projects: [] }) }] }))
  process.exit(0)
}

process.exit(0)
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

test('enabled plugin injects graph agents without overwriting a preexisting user agent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-codebase-memory-test-'))

  try {
    mkdirSync(join(directory, '.git'))
    const plugin = await CodebaseMemoryPlugin(
      { directory },
      { enabled: true, indexOnStartup: false, binary: 'codebase-memory-mcp-custom' },
    )
    const config = {
      agent: {
        'codebase-memory': {
          description: 'user agent',
          permission: { grep: 'allow', glob: 'allow' },
        },
      },
    }
    await plugin.config(config)

    for (const name of ['codebase-memory', 'codebase-memory-scout', 'codebase-memory-auditor']) {
      assert.equal(config.agent[name].permission.grep, 'allow')
      assert.equal(config.agent[name].permission.glob, 'allow')
    }
    assert.equal(config.agent['codebase-memory'].description, 'user agent')
    assert.equal(config.agent['codebase-memory-scout'].permission['codebase-memory-mcp_search_graph'], 'allow')
    assert.equal(config.agent['codebase-memory-scout'].permission['codebase-memory-mcp_query_graph'], undefined)

    const generated = {}
    await plugin.config(generated)
    assert.equal(generated.agent['codebase-memory'].permission['codebase-memory-mcp_query_graph'], 'allow')
    assert.equal(generated.agent['codebase-memory-auditor'].permission['codebase-memory-mcp_detect_changes'], 'allow')
  } finally {
    rmSync(directory, { recursive: true, force: true })
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
