import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync } from "node:fs"

import pluginModule from "../dist/index.js"
import { guardFsPath } from "../dist/tools.js"

const EXPECTED_COMMANDS = [
  "craft", "shape", "init", "document", "extract", "critique", "audit", "polish",
  "bolder", "quieter", "distill", "harden", "onboard", "animate", "colorize",
  "typeset", "layout", "delight", "overdrive", "clarify", "adapt", "optimize", "live", "generate",
]

const EXPECTED_TOOLS = [
  "impeccable_reference",
  "impeccable_context",
  "impeccable_context_signals",
  "impeccable_detect",
  "impeccable_doctor",
  "impeccable_pin",
  "impeccable_hook_admin",
  "impeccable_hooks_status",
  "impeccable_hooks_toggle",
  "impeccable_hooks_ignore_value",
  "impeccable_hooks_ignore_rule",
  "impeccable_hooks_ignore_file",
  "impeccable_hooks_reset",
  "impeccable_ignores",
  "impeccable_concept_seed",
  "impeccable_critique_storage",
  "impeccable_detect_csp",
  "impeccable_embed_prompt",
  "impeccable_generate_image",
  "impeccable_surface_brief",
  "impeccable_serve_question",
  "impeccable_live",
  "impeccable_live_server",
  "impeccable_live_poll",
  "impeccable_live_status",
  "impeccable_live_resume",
  "impeccable_live_complete",
  "impeccable_live_insert",
  "impeccable_live_wrap",
  "impeccable_live_generate",
  "impeccable_build_phase",
  "impeccable_comp_spec",
  "impeccable_comp_diff",
  "impeccable_component_review",
  "impeccable_font_match",
]

const EXPECTED_AUXILIARY_AGENTS = [
  "impeccable_asset_producer",
  "impeccable_documenter",
  "impeccable_finish_reviewer",
  "impeccable_manual_edit_applier",
]

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "opencode-impeccable-plugin-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  return root
}

async function createPlugin(root, client, options = {}) {
  return pluginModule.server(
    { directory: root, worktree: root, client },
    options,
  )
}

test("plugin exports its id and server", () => {
  assert.equal(pluginModule.id, "opencode-impeccable")
  assert.equal(typeof pluginModule.server, "function")
})

test("commands use a capable hidden primary agent without overriding user permissions", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    const config = {}
    await plugin.config(config)

    assert.equal(config.agent.impeccable.hidden, true)
    assert.equal(config.agent.impeccable.mode, "primary")
    assert.equal("permission" in config.agent.impeccable, false)
    assert.match(config.agent.impeccable.description, /Implement/)
    assert.match(config.agent.impeccable.prompt, /implementation agent, not a read-only planner/)
    assert.match(config.agent.impeccable.prompt, /impeccable_reference/)
    assert.doesNotMatch(config.agent.impeccable.prompt, /Bash\(npx impeccable/)
    assert.equal(config.command.impeccable.agent, "impeccable")
    assert.equal(config.command.impeccable.subtask, false)
    for (const name of EXPECTED_AUXILIARY_AGENTS) {
      assert.equal(config.agent[name].hidden, true)
      assert.equal(config.agent[name].mode, "subagent")
      assert.equal("permission" in config.agent[name], false)
      assert.match(config.agent[name].prompt, /OpenCode adapter rules/)
      assert.match(config.agent[name].prompt, /impeccable_reference/)
    }

    assert.ok(config.command.impeccable)
    for (const command of EXPECTED_COMMANDS) {
      const entry = config.command[`impeccable-${command}`]
      assert.ok(entry, `missing impeccable-${command}`)
      assert.equal(entry.agent, "impeccable")
      assert.equal(entry.subtask, false)
      assert.match(entry.template, /Follow this bundled playbook, already adapted for OpenCode:/)
      assert.match(entry.template, /Invocation arguments: \$ARGUMENTS/)
    }
    assert.doesNotMatch(config.command["impeccable-shape"].template, /impeccable_reference/)
    assert.match(config.command["impeccable-audit"].template, /load audit\.native with impeccable_reference/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("concrete command templates inject adapted reference content", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    const config = {}
    await plugin.config(config)

    const template = config.command["impeccable-layout"].template
    assert.match(template, /Layout turns product priority into reading order, grouping, rhythm, and usable space/)
    assert.match(template, /impeccable_detect --json --scope layout/)
    assert.doesNotMatch(template, /node \{\{scripts_path\}\}\/detect\.mjs/)
    assert.doesNotMatch(template, /npx impeccable/)
    assert.match(template, /Invocation arguments: \$ARGUMENTS/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("generic command hook injects the menu or selected adapted playbook", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    await plugin.config({})
    const before = plugin["command.execute.before"]

    const run = async (argumentsText) => {
      const part = { type: "text", text: "original prompt" }
      await before(
        { command: "impeccable", sessionID: "session-1", arguments: argumentsText },
        { parts: [part] },
      )
      return part.text
    }

    const menu = await run("")
    assert.match(menu, /Call impeccable_context once before presenting the menu/)
    assert.match(menu, /# No-argument routing: the context-aware menu/)
    assert.doesNotMatch(menu, /load routing with impeccable_reference/)

    const known = await run("polish src")
    assert.match(known, /Polish is refinement, never concealed redesign/)
    assert.match(known, /Invocation arguments: src/)
    assert.doesNotMatch(known, /Load the polish playbook with impeccable_reference/)

    const alias = await run("teach docs/product.md")
    assert.match(alias, /Run \/impeccable init\./)
    assert.match(alias, /captures durable product truth in PRODUCT\.md/)
    assert.match(alias, /Invocation arguments: docs\/product\.md/)

    const freeform = await run("make a dashboard")
    assert.match(freeform, /unrecognized or freeform request; do not guess a command/)
    assert.match(freeform, /# No-argument routing: the context-aware menu/)
    assert.match(freeform, /Invocation arguments: make a dashboard/)
    assert.doesNotMatch(freeform, /Run \/impeccable make/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("generic command hook leaves a user-owned command untouched", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    const config = { command: { impeccable: { template: "mine" } } }
    await plugin.config(config)

    const part = { type: "text", text: "user prompt" }
    await plugin["command.execute.before"](
      { command: "impeccable", sessionID: "session-1", arguments: "polish src" },
      { parts: [part] },
    )
    assert.equal(part.text, "user prompt")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("existing user agent and command entries are preserved", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    const config = {
      agent: { impeccable: { description: "mine" } },
      command: { impeccable: { description: "mine" } },
    }
    await plugin.config(config)
    assert.equal(config.agent.impeccable.description, "mine")
    assert.equal(config.command.impeccable.description, "mine")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("tool surface contains every native workflow helper and no install manager", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    assert.deepEqual(Object.keys(plugin.tool).sort(), EXPECTED_TOOLS.sort())
    assert.equal(plugin.tool.impeccable_install, undefined)
    assert.equal(plugin.tool.impeccable_update, undefined)
    assert.equal(plugin.tool.impeccable_check, undefined)
    for (const name of EXPECTED_TOOLS) {
      assert.equal(typeof plugin.tool[name].execute, "function", `${name} has no execute function`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference tool returns adapted playbooks without raw runtime commands", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    const hooks = await plugin.tool.impeccable_reference.execute({ name: "hooks" }, {})
    assert.match(hooks, /impeccable_hook_admin/)
    assert.doesNotMatch(hooks, /node \{\{scripts_path\}\}/)
    assert.doesNotMatch(hooks, /npx impeccable/)
    await assert.rejects(
      plugin.tool.impeccable_reference.execute({ name: "not-real" }, {}),
      /Unknown Impeccable reference/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("pin writes only a managed project-local OpenCode shortcut", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    const created = await plugin.tool.impeccable_pin.execute({ command: "polish" }, {})
    const target = join(root, ".opencode", "commands", "polish.md")
    assert.match(created, /Pinned/)
    assert.equal(existsSync(target), true)
    assert.match(readFileSync(target, "utf8"), /opencode-impeccable-pinned-command/)

    const removed = await plugin.tool.impeccable_pin.execute({ command: "polish", remove: true }, {})
    assert.match(removed, /Removed/)
    assert.equal(existsSync(target), false)

    mkdirSync(join(root, ".opencode", "commands"), { recursive: true })
    writeFileSync(target, "user-owned")
    await assert.rejects(
      plugin.tool.impeccable_pin.execute({ command: "polish" }, {}),
      /Refusing to overwrite/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("context uses the bundled runtime and recognizes the native detector hook", async () => {
  const root = workspace()
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }))
    const plugin = await createPlugin(root)
    const output = await plugin.tool.impeccable_context.execute({}, {})
    assert.match(output, /NO_PRODUCT_MD|RESOLVED_CONTEXT/)
    assert.match(output, /AUTOMATIC_DETECTOR_ACTIVE/)
    assert.doesNotMatch(output, /MANUAL_DETECTOR_REQUIRED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("path guard accepts relative and absolute in-worktree paths", () => {
  const root = workspace()
  try {
    const runtime = { worktree: root }
    const inside = join(root, "src", "ui.ts")
    mkdirSync(dirname(inside), { recursive: true })
    writeFileSync(inside, "")
    assert.equal(guardFsPath(runtime, "src/ui.ts", "target"), "src/ui.ts")
    assert.equal(guardFsPath(runtime, inside, "target"), inside)
    assert.equal(guardFsPath(runtime, root, "target"), root)
    assert.equal(guardFsPath(runtime, ".", "target"), ".")
    assert.throws(() => guardFsPath(runtime, "../outside", "target"), /outside the active worktree/)
    assert.throws(() => guardFsPath(runtime, "/etc/passwd", "target"), /outside the active worktree/)
    assert.throws(() => guardFsPath(runtime, "", "target"), /non-empty/)
    assert.throws(() => guardFsPath(runtime, "a\0b", "target"), /NUL/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("path guard rejects in-worktree symlinks escaping the worktree", (t) => {
  const root = workspace()
  const outside = mkdtempSync(join(tmpdir(), "opencode-impeccable-outside-"))
  try {
    const runtime = { worktree: root }
    try {
      symlinkSync(outside, join(root, "link"))
    } catch {
      t.skip("symlinks are not supported on this platform")
      return
    }
    assert.throws(() => guardFsPath(runtime, "link/file.png", "output"), /outside the active worktree/)
    assert.throws(
      () => guardFsPath(runtime, join(root, "link", "missing", "file.png"), "output"),
      /outside the active worktree/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test("path guard allows http(s) only with explicit URL support", () => {
  const root = workspace()
  try {
    const runtime = { worktree: root }
    assert.equal(
      guardFsPath(runtime, "https://example.com/page", "target", { allowUrl: true }),
      "https://example.com/page",
    )
    assert.equal(
      guardFsPath(runtime, "http://example.com/page", "target", { allowUrl: true }),
      "http://example.com/page",
    )
    assert.throws(
      () => guardFsPath(runtime, "file:///etc/passwd", "target", { allowUrl: true }),
      /only supports http\(s\)/,
    )
    assert.throws(
      () => guardFsPath(runtime, "data:text/plain,hi", "target", { allowUrl: true }),
      /only supports http\(s\)/,
    )
    assert.throws(() => guardFsPath(runtime, "https://example.com", "output"), /only supports http\(s\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("generate_image rejects external output before launching", async () => {
  const root = workspace()
  const outside = mkdtempSync(join(tmpdir(), "opencode-impeccable-image-"))
  try {
    const plugin = await createPlugin(root)
    await assert.rejects(
      plugin.tool.impeccable_generate_image.execute({ output: join(outside, "img.png"), prompt: "test" }, {}),
      /outside the active worktree/,
    )
    assert.equal(existsSync(join(outside, "img.png")), false)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test("detect returns JSON findings for a primary rule without throwing", async () => {
  const root = workspace()
  try {
    writeFileSync(join(root, "bad.css"), ".brand { font-family: Inter; }\n")
    const plugin = await createPlugin(root)
    const output = await plugin.tool.impeccable_detect.execute({ targets: ["bad.css"], jsonOutput: true }, {})
    const findings = JSON.parse(output)
    assert.equal(Array.isArray(findings), true)
    assert.ok(findings.length > 0)
    assert.equal(findings[0].antipattern, "overused-font")
    assert.match(findings[0].file, /bad\.css$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("detect returns text findings from stderr for a primary rule", async () => {
  const root = workspace()
  try {
    writeFileSync(join(root, "bad.css"), ".brand { font-family: Inter; }\n")
    const plugin = await createPlugin(root)
    const output = await plugin.tool.impeccable_detect.execute({ targets: ["bad.css"] }, {})
    assert.match(output, /overused-font/)
    assert.match(output, /font-family: Inter/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("detect resolves clean targets and rejects true launch failures", async () => {
  const root = workspace()
  try {
    writeFileSync(join(root, "clean.css"), ".clean { color: #333; }\n")
    const plugin = await createPlugin(root)
    const clean = await plugin.tool.impeccable_detect.execute({ targets: ["clean.css"], jsonOutput: true }, {})
    assert.deepEqual(JSON.parse(clean), [])
    const broken = await createPlugin(root, undefined, { binary: "/nonexistent/impeccable" })
    await assert.rejects(
      broken.tool.impeccable_detect.execute({ targets: ["clean.css"] }, {}),
      /Unable to launch|ENOENT/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('supports the v2 plugin shape with tools, agents, and commands', async () => {
  const root = workspace()
  try {
    assert.equal(typeof pluginModule.setup, 'function')

    const agents = {}
    const commands = []
    const tools = []
    const hooks = {}
    const prompts = []
    const switched = []
    let subscriptionSignal
    const ctx = {
      location: { directory: root, project: { canonical: root } },
      options: {},
      agent: {
        transform: async (callback) =>
          callback({
            get: (id) => agents[id],
            update: (id, update) => {
              const agent = (agents[id] = agents[id] ?? {})
              update(agent)
            },
          }),
      },
      command: {
        list: async () => ({ data: [] }),
        transform: async (callback) => callback({ add: (definition) => commands.push(definition) }),
      },
      tool: {
        transform: async (callback) => callback({ add: (tool) => tools.push(tool) }),
        hook: async (name, callback) => { hooks[name] = callback },
      },
      event: {
        subscribe: (options) => {
          subscriptionSignal = options.signal
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise((resolve) => options.signal.addEventListener('abort', () => resolve({ done: true }), { once: true })),
            }),
          }
        },
      },
    }

    ctx.session = {
      switchAgent: async (input) => switched.push(input),
      prompt: async (input) => prompts.push(input),
    }
    const cleanup = await pluginModule.setup(ctx)

    assert.equal(agents.impeccable.mode, 'primary')
    assert.match(agents.impeccable.system, /implementation agent, not a read-only planner/)
    for (const name of EXPECTED_AUXILIARY_AGENTS) {
      assert.ok(agents[name], `missing auxiliary agent ${name}`)
      assert.equal(agents[name].mode, 'subagent')
    }
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS.slice().sort())
    assert.ok(commands.find((command) => command.name === 'impeccable'))
    assert.ok(commands.find((command) => command.name === 'impeccable-audit'))
    const invocation = { sessionID: 's1', prompt: { text: 'polish src', attachments: [{ type: 'file', uri: 'file:///test' }] }, delivery: 'queue' }
    await commands.find((command) => command.name === 'impeccable').execute(invocation)
    assert.deepEqual(switched, [{ sessionID: 's1', agent: 'impeccable' }])
    assert.match(prompts[0].text, /Run \/impeccable polish/)
    assert.match(prompts[0].text, /Invocation arguments: src/)
    assert.equal(prompts[0].delivery, 'queue')
    assert.equal(prompts[0].attachments, invocation.prompt.attachments)

    writeFileSync(join(root, 'bad.css'), '.brand { font-family: Inter; }')
    const detect = tools.find((tool) => tool.name === 'impeccable_detect')
    const result = await detect.execute({ targets: ['bad.css'], jsonOutput: true }, { sessionID: 's1', messageID: 'm1', agent: 'impeccable', id: 'c1' })
    assert.equal(JSON.parse(result.content)[0].antipattern, 'overused-font')

    const edit = { status: 'completed', tool: 'write', sessionID: 's1', input: { filePath: join(root, 'bad.css') }, result: { content: [{ type: 'text', text: 'Done' }, { type: 'file', uri: 'file:///image', mime: 'image/png' }], metadata: { keep: true } } }
    await hooks['execute.after'](edit)
    assert.equal(edit.result.content[0].text, 'Done')
    assert.equal(edit.result.content[1].type, 'file')
    assert.match(edit.result.content.at(-1).text, /<system-reminder>/)
    assert.equal(edit.result.metadata.keep, true)
    const failed = { ...edit, status: 'error', error: new Error('failed') }
    const before = failed.result
    await hooks['execute.after'](failed)
    assert.equal(failed.result, before)
    cleanup()
    assert.equal(subscriptionSignal.aborted, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test("new Rust workflow helpers reject external paths before executing", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    for (const args of [["--comp", "/etc/passwd"], ["--regions=/etc/passwd"], ["--comp"]]) {
      await assert.rejects(plugin.tool.impeccable_comp_spec.execute({ args }, {}), /outside the active worktree|requires a path/)
    }
    const output = await plugin.tool.impeccable_comp_spec.execute({ args: ["--schema"] }, {})
    assert.ok(JSON.parse(output))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Rust ignores supports native actions and legacy add/remove aliases", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    const ignores = plugin.tool.impeccable_ignores
    await ignores.execute({ action: "add", rule: "overused-font", value: "Inter", reason: "Brand font" }, {})
    assert.match(await ignores.execute({ action: "list" }, {}), /inter/i)
    await ignores.execute({ action: "remove-value", rule: "overused-font", value: "Inter" }, {})
    assert.doesNotMatch(await ignores.execute({ action: "list" }, {}), /inter/i)
    await ignores.execute({ action: "add-file", path: "src/legacy/**" }, {})
    assert.match(await ignores.execute({ action: "list" }, {}), /legacy/)
    await ignores.execute({ action: "clear" }, {})
    assert.doesNotMatch(await ignores.execute({ action: "list" }, {}), /legacy/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Rust image helpers forward reference, background, and scan arguments", async () => {
  const root = workspace()
  try {
    const binary = join(root, "engine")
    writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 })
    const plugin = await createPlugin(root, undefined, { binary })
    const output = await plugin.tool.impeccable_generate_image.execute({ output: "plate.png", prompt: "cutout", referenceImages: ["comp.png"], background: "transparent" }, {})
    assert.deepEqual(JSON.parse(output), ["generate-image", "--out", "plate.png", "--prompt", "cutout", "--background", "transparent", "--ref", "comp.png"])
    const scan = await plugin.tool.impeccable_embed_prompt.execute({ scan: ["assets"] }, {})
    assert.deepEqual(JSON.parse(scan), ["embed-prompt", "--scan", "assets"])
    await assert.rejects(plugin.tool.impeccable_generate_image.execute({ output: "plate.png", prompt: "cutout", referenceImages: ["/etc/passwd"] }, {}), /outside the active worktree/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
