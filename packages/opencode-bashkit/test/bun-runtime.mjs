// Bun 1.2.23's node:test shim does not await these async tests reliably.
// Run direct assertions as well as the authoritative Node test suite.
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"

const { Runtime, Cancellation } = createRequire(import.meta.url)("../dist/runtime.node")
const directory = await mkdtemp(join(tmpdir(), "bashkit-bun-"))
let runtime
try {
  await writeFile(join(directory, "fixture"), "host")
  runtime = await Runtime.create(directory)
  const run = (command) => runtime.execute(command, "/workspace", 1000)
  assert.equal((await run("cat fixture")).stdout, "host")
  assert.equal((await run("echo virtual > fixture; cat fixture")).stdout, "virtual\n")
  assert.equal((await run("cat fixture")).stdout, "virtual\n")
  assert.equal(await readFile(join(directory, "fixture"), "utf8"), "host")
  const pending = run("sleep 0.05; while true; do :; done")
  await new Promise((resolve) => setTimeout(resolve, 5))
  runtime.cancel()
  assert.match((await pending).runtimeError, /cancel/i)
  assert.equal((await run("cat fixture")).stdout, "virtual\n")
  const cancellation = new Cancellation()
  const active = run("sleep .05; echo active > active")
  const queued = runtime.execute("echo cancelled > cancelled", "/workspace", 1000, cancellation)
  cancellation.cancel()
  await active
  assert.match((await queued).runtimeError, /cancel/i)
  assert.equal((await run("cat active; test ! -e cancelled")).stdout, "active\n")
  await runtime.dispose()
  await assert.rejects(run("pwd"), /disposed/)
  console.log(`Native loading, async overlay, cancellation and disposal pass under Bun ${Bun.version}`)
} finally {
  await runtime?.dispose()
  await rm(directory, { recursive: true, force: true })
}
