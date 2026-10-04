import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { buildTools, adaptReferenceText } from "../dist/tools.js"
import { defaultRuntimePaths } from "../dist/runtime.js"

const packageRoot = new URL("..", import.meta.url).pathname
const references = join(packageRoot, "vendor", "impeccable", "skill", "reference")

test("every agent-facing playbook invocation is adapted to a typed tool", () => {
  const tools = buildTools({ ...defaultRuntimePaths(packageRoot), directory: packageRoot, worktree: packageRoot })
  for (const name of readdirSync(references).filter((entry) => entry.endsWith(".md"))) {
    const adapted = adaptReferenceText(readFileSync(join(references, name), "utf8"))
    assert.doesNotMatch(adapted, /node \{\{scripts_path\}\}\/[a-z0-9-]+\.mjs/i, name)
    assert.doesNotMatch(adapted, /npx impeccable/i, name)
    assert.doesNotMatch(adapted, /\{\{scripts_path\}\}\/impeccable/i, name)
    const original = readFileSync(join(references, name), "utf8")
    for (const match of original.matchAll(/\{\{scripts_path\}\}\/impeccable\s+([a-z0-9-]+)/g)) {
      const adaptedCall = adaptReferenceText(match[0])
      assert.ok(tools[adaptedCall], `${name}: missing typed tool ${adaptedCall}`)
    }
  }
})

test("the pinned snapshot includes the scripts and detector entrypoints needed at runtime", () => {
  const required = [
    "skill/SKILL.md",
    "skill/scripts/impeccable",
    "skill/scripts/impeccable.cmd",
    "skill/scripts/command-metadata.json",
    "skill/scripts/live-browser.js",
    "skill/scripts/modern-screenshot.umd.js",
  ]
  for (const path of required) {
    const contents = readFileSync(join(packageRoot, "vendor", "impeccable", path), "utf8")
    assert.ok(contents.length > 100, `${path} is unexpectedly empty`)
  }
})

test("the pinned snapshot includes every specialist prompt referenced by upstream playbooks", () => {
  const agents = [
    "impeccable-asset-producer.md",
    "impeccable-documenter.md",
    "impeccable-finish-reviewer.md",
    "impeccable-manual-edit-applier.md",
  ]
  for (const agent of agents) {
    const contents = readFileSync(join(packageRoot, "vendor", "impeccable", "skill", "agents", agent), "utf8")
    assert.ok(contents.length > 500, `${agent} is unexpectedly empty`)
  }
})
