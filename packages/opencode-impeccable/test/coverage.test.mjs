import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { adaptReferenceText } from "../dist/tools.js"

const packageRoot = new URL("..", import.meta.url).pathname
const references = join(packageRoot, "references")

test("every agent-facing playbook invocation is adapted to a typed tool", () => {
  for (const name of readdirSync(references).filter((entry) => entry.endsWith(".md"))) {
    const adapted = adaptReferenceText(readFileSync(join(references, name), "utf8"))
    assert.doesNotMatch(adapted, /node \{\{scripts_path\}\}\/[a-z0-9-]+\.mjs/i, name)
    assert.doesNotMatch(adapted, /npx impeccable/i, name)
  }
})

test("the pinned snapshot includes the scripts and detector entrypoints needed at runtime", () => {
  const required = [
    "skill/scripts/context.mjs",
    "skill/scripts/doctor.mjs",
    "skill/scripts/hook.mjs",
    "skill/scripts/hook-admin.mjs",
    "skill/scripts/live.mjs",
    "cli/engine/detect-antipatterns.mjs",
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
