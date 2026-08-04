import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync } from "node:fs"

import pluginModule from "../dist/index.js"

const EXPECTED_COMMANDS = [
  "craft", "shape", "init", "document", "extract", "critique", "audit", "polish",
  "bolder", "quieter", "distill", "harden", "onboard", "animate", "colorize",
  "typeset", "layout", "delight", "overdrive", "clarify", "adapt", "optimize", "live",
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

async function createPlugin(root, client) {
  return pluginModule.server(
    { directory: root, worktree: root, client },
    { nodePath: process.execPath },
  )
}

test("plugin exports its id and server", () => {
  assert.equal(pluginModule.id, "opencode-impeccable")
  assert.equal(typeof pluginModule.server, "function")
})

test("commands use a capable hidden subagent without overriding user permissions", async () => {
  const root = workspace()
  try {
    const plugin = await createPlugin(root)
    const config = {}
    await plugin.config(config)

    assert.equal(config.agent.impeccable.hidden, true)
    assert.equal(config.agent.impeccable.mode, "subagent")
    assert.equal("permission" in config.agent.impeccable, false)
    assert.match(config.agent.impeccable.description, /Implement/)
    assert.match(config.agent.impeccable.prompt, /implementation agent, not a read-only planner/)
    assert.match(config.agent.impeccable.prompt, /impeccable_reference/)
    assert.doesNotMatch(config.agent.impeccable.prompt, /Bash\(npx impeccable/)
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
      assert.equal(entry.subtask, true)
      assert.match(entry.template, /impeccable_reference/)
    }
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
