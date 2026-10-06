import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const exec = promisify(execFile)
const binary = process.env.OPENCODE_BIN ?? "opencode"
const root = await mkdtemp(path.join(tmpdir(), "bashkit-opencode-"))
try {
  const project = path.join(root, "project"), probe = path.join(root, "probe")
  const config = path.join(root, "config", "opencode")
  await Promise.all([project, probe, config].map(directory => mkdir(directory, { recursive: true })))
  const env = { ...process.env, PWD: project, INIT_CWD: project, XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state") }
  const { stdout: version } = await exec(binary, ["--version"], { env })
  assert.ok(["2.0.22", "2.0.23"].includes(version.trim().replace(/^opencode v/, "")), "smoke test requires OpenCode 2.0.22 or 2.0.23")
  const packageRoot = fileURLToPath(new URL("../", import.meta.url))
  const fixture = (await readFile(new URL("smoke-model.mjs", import.meta.url), "utf8"))
    .replace('"@opencode/plugin/effect"', JSON.stringify(import.meta.resolve("@opencode/plugin/effect")))
    .replace('"effect"', JSON.stringify(import.meta.resolve("effect")))
  await writeFile(path.join(probe, "index.js"), fixture)
  await writeFile(path.join(probe, "package.json"), JSON.stringify({ type: "module", main: "index.js" }))
  const resultsFile = path.join(root, "results.jsonl"), toolsFile = path.join(root, "tools.json")
  await writeFile(path.join(config, "opencode.json"), JSON.stringify({
    model: "bashkit-test/fixture", lsp: false, formatter: false,
    permissions: [
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "echo denied > denied", effect: "deny" },
    ],
    plugins: [{ package: path.join(packageRoot, "dist"), options: { isolated: true } }, { package: probe, options: {
      resultsFile, toolsFile, commands: ["cat fixture; echo virtual > fixture; echo created > new", "echo denied > denied", "cat fixture new; test ! -e denied"],
    } }],
  }))
  await writeFile(path.join(project, "fixture"), "host-original\n")
  const running = exec(binary, ["run", "--standalone", "--print-logs", "--model", "bashkit-test/fixture", "Exercise shell then stop"], {
    cwd: project, env, timeout: 45_000, maxBuffer: 2_000_000,
  })
  running.child.stdin.end() // opencode run reads piped input until EOF.
  const { stdout, stderr } = await running
  const results = (await readFile(resultsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.equal(results.length, 3, stdout + stderr)
  assert.equal(results[0].result.metadata.stdout, "host-original\n")
  assert.equal(results[1].status, "error")
  assert.match(results[1].error.message, /Permission denied/)
  assert.equal(results[2].result.metadata.stdout, "virtual\ncreated\n")
  assert.equal(results[2].result.output.exit, 0)
  assert.equal(await readFile(path.join(project, "fixture"), "utf8"), "host-original\n")
  await assert.rejects(readFile(path.join(project, "new")), /ENOENT/)
  await assert.rejects(readFile(path.join(project, "denied")), /ENOENT/)
  const tools = JSON.parse(await readFile(toolsFile, "utf8"))
  assert.ok(tools.includes("shell"))
  for (const name of ["read", "write", "edit", "patch", "glob", "grep"]) assert.ok(!tools.includes(name), name)
  console.log(`${version.trim()}: real shell replacement, persistent overlay, permission denial, isolated tool inventory and unchanged host verified`)
} finally {
  if (process.env.BASHKIT_SMOKE_KEEP === "1") console.log(`Smoke artifacts: ${root}`)
  else await rm(root, { recursive: true, force: true })
}
