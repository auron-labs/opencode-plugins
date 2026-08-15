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