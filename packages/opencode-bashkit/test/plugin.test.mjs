import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Effect, Scope, Exit, Stream, Queue, Fiber } from "effect"
import { Permission } from "@opencode/core/permission"
import plugin from "../dist/index.js"

async function host(root) {
  const events = await Effect.runPromise(Queue.unbounded())
  const scope = await Effect.runPromise(Scope.make())
  const input = {}, output = {}, options = { codemode: false, permission: "shell" }
  const shell = { id: "shell", name: "shell", input, output, options, execute: () => Effect.void }
  const tools = [shell, ...["read", "write", "edit", "patch", "glob", "grep", "question", "subagent", "todo"].map(name => ({ id: name, name }))]
  const approval = []
  let directory = root, deny = false
  const ctx = { options: { isolated: true },
    event: { subscribe: () => Stream.fromQueue(events) },
    session: { get: () => Effect.succeed({ location: { directory } }) },
    tool: { transform: callback => Effect.sync(() => callback({
      list: () => tools, remove: id => { tools.splice(tools.findIndex(tool => tool.id === id), 1) }, update: (_id, update) => update(shell),
    })) },
  }
  await Effect.runPromise(plugin.effect(ctx).pipe(Effect.provideService(Scope.Scope, scope)))
  assert.deepEqual(tools.map(tool => tool.name), ["shell", "question", "subagent", "todo"])
  assert.equal(shell.input, input)
  assert.equal(shell.output, output)
  assert.equal(shell.options, options)
  const service = { assert: request => Effect.sync(() => {
    approval.push(request)
    if (deny) throw new Error("Permission denied")
  }) }
  const effect = (command, sessionID = "session-a", extra = {}) => shell.execute({ command, ...extra }, {
    sessionID, messageID: "message", agent: "build", id: "call", progress: () => Effect.void,
  }).pipe(Effect.provideService(Permission.Service, service))
  return {
    effect, run: (...args) => Effect.runPromise(effect(...args)), approval,
    deny: value => { deny = value }, directory: value => { directory = value },
    delete: async sessionID => { await Effect.runPromise(Queue.offer(events, { type: "session.deleted", data: { sessionID } })); await new Promise(resolve => setTimeout(resolve, 20)) },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    shell,
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "bashkit-plugin-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "fixture"), "host-original\n")
  await mkdir(path.join(root, "space ' dir"))
  const instance = await host(root)
  t.after(instance.close)
  return { root, instance }
}

test("preserves schema/options, permissions precede writes, session and plugin isolation", async t => {
  const { root, instance: a } = await fixture(t)
  a.deny(true)
  await assert.rejects(a.run("echo denied > fixture"), /Permission denied/)
  a.deny(false)
  assert.equal((await a.run("cat fixture")).output.output, "host-original\n")
  await a.run("echo overlay > fixture; echo created > new")
  assert.equal((await a.run("cat fixture; cat new")).output.output, "overlay\ncreated\n")
  assert.equal((await a.run("cat fixture", "session-b")).output.output, "host-original\n")
  const b = await host(root)
  t.after(b.close)
  assert.equal((await b.run("cat fixture")).output.output, "host-original\n")
  assert.equal(await readFile(path.join(root, "fixture"), "utf8"), "host-original\n")
  await assert.rejects(readFile(path.join(root, "new")), /ENOENT/)
  assert.equal(a.approval[0].action, "shell")
  assert.deepEqual(a.approval[0].resources, ["echo denied > fixture"])
  assert.equal(a.approval[0].source.type, "tool")
})

test("concurrent initialization, cwd translation/reset, deletion and shutdown", async t => {
  const { root, instance } = await fixture(t)
  await Promise.all([instance.run("echo one > one"), instance.run("echo two > two")])
  assert.equal((await instance.run("cat one two")).output.output, "one\ntwo\n")
  const directory = path.join(root, "space ' dir")
  assert.equal((await instance.run("pwd; cd /", "session-a", { workdir: directory })).output.output, "/workspace/space ' dir\n")
  assert.equal((await instance.run("pwd")).output.output, "/workspace\n")
  for (const workdir of [path.dirname(root), root + "-sibling", "/workspace/../etc"]) {
    await assert.rejects(instance.run("true", "session-a", { workdir }), /outside|escapes/)
  }
  instance.directory(path.dirname(root))
  await assert.rejects(instance.run("true"), /directory changed/)
  instance.directory(root)
  await instance.delete("session-a")
  await assert.rejects(instance.run("true"), /disposed/)
  await instance.close()
  await assert.rejects(instance.run("true", "new-session"), /disposed/)
})

test("results, finite timeout, cancellation and queued-call cancellation", async t => {
  const { instance } = await fixture(t)
  const result = await instance.run("echo out; echo err >&2; exit 7")
  assert.equal(result.output.exit, 7)
  assert.equal(result.metadata.stdout, "out\n")
  assert.equal(result.metadata.stderr, "err\n")
  assert.notEqual((await instance.run("git status")).output.exit, 0)
  assert.match((await instance.run("echo partial; sleep 1", "session-a", { timeout: 10 })).output.output, /partial/)
  await assert.rejects(instance.run("true", "session-a", { background: true }), /background/)
  await assert.rejects(instance.run("true", "session-a", { timeout: -1 }), /invalid/)
  const active = Effect.runFork(instance.effect("sleep .15; echo active > active"))
  await new Promise(resolve => setTimeout(resolve, 20))
  const queued = Effect.runFork(instance.effect("echo cancelled > cancelled"))
  await new Promise(resolve => setTimeout(resolve, 20))
  await Effect.runPromise(Fiber.interrupt(queued))
  await Effect.runPromise(Fiber.join(active))
  assert.equal((await instance.run("cat active; test ! -e cancelled")).output.output, "active\n")
  const looping = Effect.runFork(instance.effect("sleep .05; while true; do :; done"))
  await new Promise(resolve => setTimeout(resolve, 10))
  await Effect.runPromise(Fiber.interrupt(looping))
  assert.equal((await instance.run("echo recovered")).output.output, "recovered\n")
})

test("missing shell and missing permission service fail closed", async t => {
  const scope = await Effect.runPromise(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  await assert.rejects(Effect.runPromise(plugin.effect({ event: { subscribe: () => Stream.never }, tool: {
    transform: callback => Effect.sync(() => callback({ list: () => [] })),
  } }).pipe(Effect.provideService(Scope.Scope, scope))), /built-in shell/)
  const { instance } = await fixture(t)
  await assert.rejects(Effect.runPromise(instance.shell.execute({ command: "true" }, {
    sessionID: "session-a", messageID: "message", agent: "build", id: "call",
  })), /permission service unavailable/)
})
