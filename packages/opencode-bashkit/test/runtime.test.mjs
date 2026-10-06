import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, stat, symlink, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"

assert.equal(process.versions.bun, undefined, "Run the integration suite under Node; use bun-runtime.mjs for Bun")

const { Runtime } = createRequire(import.meta.url)("../dist/runtime.node")
const run = (runtime, command, cwd = "/workspace", timeout = 1000) => runtime.execute(command, cwd, timeout)

async function fixture(t) {
  const host = await mkdtemp(join(tmpdir(), "bashkit-"))
  t.after(() => rm(host, { recursive: true, force: true }))
  await writeFile(join(host, "fixture"), "original\n")
  const runtime = await Runtime.create(host)
  t.after(() => runtime.dispose())
  return { host, runtime }
}

test("real overlay preserves host create, overwrite, append, rename and delete", async (t) => {
  const { host, runtime } = await fixture(t)
  assert.equal((await run(runtime, "cat fixture")).stdout, "original\n")
  assert.equal((await run(runtime, "echo changed > fixture; echo appended >> fixture; mv fixture renamed; echo created > new; cat renamed")).stdout, "changed\nappended\n")
  assert.equal((await run(runtime, "cat renamed; cat new; test ! -e fixture")).exitCode, 0)
  assert.equal((await run(runtime, "rm renamed; test ! -e renamed")).exitCode, 0)
  assert.equal(await readFile(join(host, "fixture"), "utf8"), "original\n")
  for (const name of ["new", "renamed"]) await assert.rejects(stat(join(host, name)), { code: "ENOENT" })
})

test("live lower reads and independent runtimes", async (t) => {
  const { host, runtime } = await fixture(t)
  const second = await Runtime.create(host)
  t.after(() => second.dispose())
  await run(runtime, "echo virtual > fixture")
  await writeFile(join(host, "fixture"), "host changed\n")
  assert.equal((await run(runtime, "cat fixture")).stdout, "virtual\n")
  assert.equal((await run(second, "cat fixture")).stdout, "host changed\n")
  await writeFile(join(host, "later"), "live")
  assert.equal((await run(runtime, "cat later")).stdout, "live")
})

test("confinement includes symlinks, traversal and missing descendants", async (t) => {
  const { host, runtime } = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), "bashkit-outside-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, "secret"), "outside-secret")
  await symlink(outside, join(host, "escape"))
  await symlink(join(outside, "secret"), join(host, "leaf"))
  for (const command of ["cat escape/secret", "cat leaf", "cat escape/missing/../secret", "cat /workspace/../secret", "cat /etc/passwd"]) {
    const result = await run(runtime, command)
    assert.notEqual(result.exitCode, 0, command)
    assert.ok(!result.stdout.includes("outside-secret"), command)
  }
  await run(runtime, "mkdir -p escape/missing; echo virtual > escape/missing/file")
  await assert.rejects(stat(join(outside, "missing")), { code: "ENOENT" })
})

test("output, failure, cwd reset, quoted paths, no inherited host environment", async (t) => {
  const { runtime } = await fixture(t)
  const result = await run(runtime, "echo out; echo err >&2; exit 7")
  assert.equal(result.stdout, "out\n")
  assert.equal(result.stderr, "err\n")
  assert.equal(result.exitCode, 7)
  assert.equal((await run(runtime, "git status")).exitCode, 127)
  assert.notEqual((await run(runtime, "curl https://example.com")).exitCode, 0)
  await run(runtime, "mkdir -p \"space's dir\"; cd \"space's dir\"; SECRET=local")
  assert.equal((await run(runtime, "pwd; echo ${SECRET-unset}")).stdout, "/workspace\nunset\n")
  assert.equal((await run(runtime, "pwd", "/workspace/space's dir")).stdout, "/workspace/space's dir\n")
  assert.equal((await run(runtime, "echo ${AWS_SECRET_ACCESS_KEY-unset}")).stdout, "unset\n")
  await assert.rejects(run(runtime, "pwd", "/missing"))
  assert.ok((await run(runtime, "if")).runtimeError)
})

test("timeout and cancellation recover without losing edits; dispose cancels", async (t) => {
  const { runtime } = await fixture(t)
  await run(runtime, "echo retained > new")
  const timeout = await run(runtime, "echo before; sleep 10", "/workspace", 20)
  assert.match(timeout.runtimeError, /time|deadline/i)
  assert.ok(timeout.stdout.includes("before"))
  const pending = run(runtime, "sleep 0.05; while true; do :; done")
  await new Promise((resolve) => setTimeout(resolve, 25))
  runtime.cancel()
  assert.match((await pending).runtimeError, /cancel/i)
  assert.equal((await run(runtime, "cat new")).stdout, "retained\n")
  const active = run(runtime, "sleep 0.05; while true; do :; done")
  await new Promise((resolve) => setTimeout(resolve, 25))
  await runtime.dispose()
  assert.match((await active).runtimeError, /cancel/i)
  await assert.rejects(run(runtime, "pwd"), /disposed/)
})

test("Rust serializes commands and enforces output/filesystem limits", async (t) => {
  const { runtime } = await fixture(t)
  const [first, second] = await Promise.all([run(runtime, "sleep 0.02; echo first > new"), run(runtime, "cat new")])
  assert.equal(first.exitCode, 0)
  assert.equal(second.stdout, "first\n")
  const output = await run(runtime, "for ((i=0;i<200;i++)); do printf '%10000s' x; done")
  assert.ok(output.stdoutTruncated || output.runtimeError)
  assert.ok(Buffer.byteLength(output.stdout) <= 1_000_000)
  const large = await run(runtime, "for ((i=0;i<1100;i++)); do printf '%10000s' x >> huge; done")
  assert.notEqual(large.exitCode, 0)
  assert.match(large.stderr + (large.runtimeError ?? ""), /file too large|byte limit/)
})
