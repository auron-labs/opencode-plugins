import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { defaultRuntimePaths, ImpeccableRuntimeError, runEngineVerb } from "../dist/runtime.js"

function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "opencode-impeccable-runtime-"))
  const binary = join(root, "engine")
  writeFileSync(binary, `#!${process.execPath}\n${body}`, { mode: 0o755 })
  return {
    root,
    runtime: { directory: root, worktree: root, ...defaultRuntimePaths(root), binary },
  }
}

test("installed native engine answers the engine handshake", async () => {
  const runtime = { directory: process.cwd(), worktree: process.cwd(), ...defaultRuntimePaths(process.cwd()) }
  const result = await runEngineVerb(runtime, "engine-probe")
  assert.match(result.stdout, /^impeccable-engine 0\.1\.11/)
})

test("runtime invokes engine verbs directly with cwd, stdin, and skill assets", async () => {
  const { root, runtime } = fixture(`
    console.log(JSON.stringify({
      args: process.argv.slice(2), cwd: process.cwd(),
      input: require('node:fs').readFileSync(0, 'utf8'),
      skill: process.env.IMPECCABLE_SKILL_DIR,
      custom: process.env.ENGINE_TEST,
    }))
  `)
  try {
    const result = await runEngineVerb(runtime, "context", ["--target", "a b"], { stdin: "{}", env: { ENGINE_TEST: "passed" } })
    const output = JSON.parse(result.stdout)
    assert.deepEqual(output.args, ["context", "--target", "a b"])
    assert.equal(output.cwd, realpathSync(root))
    assert.equal(output.input, "{}")
    assert.equal(output.skill, join(root, "vendor", "impeccable", "skill"))
    assert.equal(output.custom, "passed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime rejects nonzero exits with diagnostics and allows detector findings", async () => {
  const { root, runtime } = fixture("console.error('broken'); process.exit(2)")
  try {
    await assert.rejects(
      runEngineVerb(runtime, "detect"),
      (error) => error instanceof ImpeccableRuntimeError && error.code === 2 && /broken/.test(error.message),
    )
    assert.equal((await runEngineVerb(runtime, "detect", [], { allowedExitCodes: [0, 2] })).code, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime rejects timeouts and invalid engine verbs", async () => {
  const { root, runtime } = fixture("setTimeout(() => {}, 60_000)")
  try {
    await assert.rejects(runEngineVerb(runtime, "context", [], { timeoutMs: 10 }), /timed out/)
    await assert.rejects(runEngineVerb(runtime, "../outside"), /Invalid.*verb/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
