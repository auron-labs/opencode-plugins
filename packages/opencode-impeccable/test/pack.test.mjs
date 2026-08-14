import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CHECKER = join(import.meta.dirname, "..", "scripts", "check-package-contents.mjs")

const REQUIRED = [
  "dist/index.js",
  "dist/index.d.ts",
  "references/SKILL.md",
  "upstream-lock.json",
  "vendor/impeccable/LICENSE",
  "vendor/impeccable/skill/agents/impeccable-asset-producer.md",
  "vendor/impeccable/skill/scripts/context.mjs",
  "vendor/impeccable/skill/scripts/hook.mjs",
  "vendor/impeccable/skill/scripts/live.mjs",
  "vendor/impeccable/cli/bin/cli.js",
  "vendor/impeccable/cli/bin/commands/ignores.mjs",
]

async function fixture(omitted = [], packRoots = ["dist", "references", "vendor", "upstream-lock.json"]) {
  const root = await mkdtemp(join(tmpdir(), "impeccable-pack-"))
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "impeccable-pack-fixture",
    version: "1.0.0",
    files: packRoots,
  }))
  for (const path of REQUIRED) {
    if (omitted.includes(path)) continue
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), "content\n")
  }
  return root
}

async function runChecker(root) {
  return execFileAsync(process.execPath, [CHECKER, "--root", root], { cwd: dirname(CHECKER) })
}

test("pack checker accepts a complete fixture", async () => {
  const root = await fixture()
  try {
    const { stdout } = await runChecker(root)
    assert.match(stdout, /verified/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("pack checker fails naming an omitted required file", async () => {
  const root = await fixture(["dist/index.d.ts"])
  try {
    await assert.rejects(() => runChecker(root), (error) => {
      assert.match(error.stdout, /dist\/index\.d\.ts/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("pack checker fails naming a dropped reference file", async () => {
  const root = await fixture([], ["dist", "vendor", "upstream-lock.json"])
  try {
    await writeFile(join(root, "references", "extra.md"), "content\n")
    await assert.rejects(() => runChecker(root), (error) => {
      assert.match(error.stdout, /references\/extra\.md/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
