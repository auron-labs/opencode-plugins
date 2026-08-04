import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import pluginModule from "../dist/index.js"

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "opencode-impeccable-hook-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ui" }))
  return root
}

async function pluginFor(root, client) {
  return pluginModule.server(
    { directory: root, worktree: root, client },
    { nodePath: process.execPath },
  )
}

test("post-edit hook injects bundled detector context into the current tool output", async () => {
  const root = workspace()
  try {
    const file = join(root, "index.html")
    writeFileSync(file, "<!doctype html><html><body><main><h1>Hello</h1></main></body></html>")
    const plugin = await pluginFor(root)
    const output = { title: "write", output: "Wrote index.html", metadata: {} }
    await plugin["tool.execute.after"](
      { tool: "write", sessionID: "session-1", callID: "call-1", args: { filePath: file } },
      output,
    )
    assert.match(output.output, /<system-reminder>/)
    assert.match(output.output, /impeccable/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("disabled hook leaves edit output unchanged", async () => {
  const root = workspace()
  try {
    const file = join(root, "index.html")
    mkdirSync(join(root, ".impeccable"), { recursive: true })
    writeFileSync(join(root, ".impeccable", "config.json"), JSON.stringify({ hook: { enabled: false } }))
    writeFileSync(file, "<!doctype html><html><body>ok</body></html>")
    const plugin = await pluginFor(root)
    const output = { title: "write", output: "Wrote index.html", metadata: {} }
    await plugin["tool.execute.after"](
      { tool: "write", sessionID: "session-2", callID: "call-2", args: { filePath: file } },
      output,
    )
    assert.equal(output.output, "Wrote index.html")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("apply_patch payloads resolve multiple worktree-relative files", async () => {
  const root = workspace()
  try {
    writeFileSync(join(root, "one.css"), "body { color: #111; background: #fff; }")
    writeFileSync(join(root, "two.css"), ".card { padding: 1rem; }")
    const plugin = await pluginFor(root)
    const output = { title: "patch", output: "Done", metadata: {} }
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.css",
      "*** Update File: two.css",
      "*** End Patch",
    ].join("\n")
    await plugin["tool.execute.after"](
      { tool: "apply_patch", sessionID: "session-3", callID: "call-3", args: { patch } },
      output,
    )
    assert.match(output.output, /<system-reminder>/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("hook runtime failures are fail-open and notify only once per session", async () => {
  const root = workspace()
  const messages = []
  try {
    const file = join(root, "index.html")
    writeFileSync(file, "<main>ok</main>")
    const plugin = await pluginModule.server(
      {
        directory: root,
        worktree: root,
        client: { tui: { showToast: async ({ body }) => messages.push(body.message) } },
      },
      { nodePath: join(root, "missing-node") },
    )
    for (let index = 0; index < 2; index += 1) {
      const output = { title: "write", output: "Done", metadata: {} }
      await plugin["tool.execute.after"](
        { tool: "write", sessionID: "same-session", callID: `call-${index}`, args: { filePath: file } },
        output,
      )
      assert.equal(output.output, "Done")
    }
    assert.equal(messages.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
