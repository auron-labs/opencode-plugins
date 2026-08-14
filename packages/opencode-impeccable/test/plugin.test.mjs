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

async function createPlugin(root, client, options = {}) {
  return pluginModule.server(
    { directory: root, worktree: root, client },
    { nodePath: process.execPath, ...options },
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
    const broken = await createPlugin(root, undefined, { nodePath: "/nonexistent/node" })
    await assert.rejects(
      broken.tool.impeccable_detect.execute({ targets: ["clean.css"] }, {}),
      /Unable to launch|ENOENT/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
