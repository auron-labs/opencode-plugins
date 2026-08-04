import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  ensureNodeRuntime,
  ImpeccableRuntimeError,
  runRuntimeScript,
} from "../dist/runtime.js"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-impeccable-runtime-"))
  const scriptsDirAbs = join(root, "scripts")
  mkdirSync(scriptsDirAbs)
  return {
    root,
    runtime: {
      directory: root,
      worktree: root,
      refsDirAbs: join(root, "references"),
      scriptsDirAbs,
      cliPathAbs: join(root, "cli.js"),
      nodePath: process.execPath,
    },
  }
}

test("Node runtime version check accepts the current supported interpreter", async () => {
  await ensureNodeRuntime(process.execPath)
})

test("runtime captures stdout and preserves the requested cwd", async () => {
  const { root, runtime } = fixture()
  try {
    writeFileSync(join(runtime.scriptsDirAbs, "ok.mjs"), "console.log(JSON.stringify({ cwd: process.cwd() }))")
    const result = await runRuntimeScript(runtime, "ok.mjs")
    assert.equal(JSON.parse(result.stdout).cwd, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime rejects nonzero exits with diagnostics", async () => {
  const { root, runtime } = fixture()
  try {
    writeFileSync(join(runtime.scriptsDirAbs, "fail.mjs"), "console.error('broken'); process.exit(7)")
    await assert.rejects(
      runRuntimeScript(runtime, "fail.mjs"),
      (error) => error instanceof ImpeccableRuntimeError && error.code === 7 && /broken/.test(error.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime rejects timeouts and path traversal", async () => {
  const { root, runtime } = fixture()
  try {
    writeFileSync(join(runtime.scriptsDirAbs, "slow.mjs"), "setTimeout(() => {}, 60_000)")
    await assert.rejects(runRuntimeScript(runtime, "slow.mjs", [], { timeoutMs: 10 }), /timed out/)
    await assert.rejects(runRuntimeScript(runtime, "../outside.mjs"), /escapes the runtime directory/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
