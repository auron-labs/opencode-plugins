import { realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { Plugin } from "@opencode/plugin/effect"
import { Permission } from "@opencode/core/permission"
import { ShellParse } from "@opencode/core/shell/parse"
import { Tool } from "@opencode/schema/tool"
import { Effect, Option, Stream } from "effect"

interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode?: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  runtimeError?: string
}
interface Cancellation { cancel(): void }
interface Runtime {
  execute(command: string, cwd: string, timeout: number, cancellation: Cancellation): Promise<ExecutionResult>
  dispose(): Promise<void>
}
const native = createRequire(import.meta.url)("./runtime.node") as {
  Runtime: { create(directory: string): Promise<Runtime> }
  Cancellation: new () => Cancellation
}

function workdir(root: string, requested?: string): string {
  if (requested === undefined) return "/workspace"
  if (requested === "/workspace" || requested.startsWith("/workspace/")) {
    const normalized = path.posix.resolve(requested)
    if (normalized === "/workspace" || normalized.startsWith("/workspace/")) return normalized
    throw new Error("workdir escapes /workspace")
  }
  const relative = path.relative(root, path.resolve(root, requested))
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("workdir is outside the session directory")
  }
  return path.posix.join("/workspace", relative)
}

const failure = (error: unknown) => new Tool.Error({
  message: error instanceof Error ? error.message : String(error), error,
})

export default Plugin.define({
  id: "opencode-bashkit",
  effect: ctx => Effect.gen(function* () {
    if (ctx.options?.isolated !== undefined && typeof ctx.options.isolated !== "boolean") {
      return yield* Effect.die(new Error("isolated must be a boolean"))
    }
    const sessions = new Map<string, Promise<{ root: string; runtime: Runtime }>>()
    const deleted = new Set<string>()
    let closed = false

    async function dispose(sessionID: string) {
      deleted.add(sessionID)
      const pending = sessions.get(sessionID)
      sessions.delete(sessionID)
      if (pending) await pending.then(({ runtime }) => runtime.dispose(), () => {})
    }

    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      closed = true
      await Promise.all([...sessions.keys()].map(dispose))
    }))
    const events = ctx.event.subscribe()
    yield* Stream.runForEach(events, event => event.type === "session.deleted"
      ? Effect.promise(() => dispose(event.data.sessionID))
      : Effect.void).pipe(Effect.orDie, Effect.forkScoped)

    yield* ctx.tool.transform(editor => {
      const shell = editor.list().find(tool => tool.name === "shell")
      if (!shell) throw new Error("opencode-bashkit requires OpenCode 2.0.22's built-in shell tool")
      if (ctx.options?.isolated === true) {
        for (const tool of [...editor.list()]) {
          if (["read", "write", "edit", "patch", "apply_patch", "glob", "grep", "list"].includes(tool.name)) editor.remove(tool.id)
        }
      }
      editor.update(shell.id, tool => {
        tool.description = "Execute Bashkit commands in a temporary session filesystem. Project files are mounted at /workspace; all writes stay in memory. Use shell for file reads and edits. No host executables, network or background commands. Files persist within the session; shell variables and cwd do not. Timeout is capped at 120000ms."
        tool.execute = (input, context) => Effect.gen(function* () {
          if (typeof input !== "object" || input === null || !("command" in input)) {
            return yield* Effect.fail(failure("command is required"))
          }
          const args = input as { command: unknown; workdir?: unknown; timeout?: unknown; background?: unknown }
          if (typeof args.command !== "string" || Buffer.byteLength(args.command) > 1_000_000
            || (args.workdir !== undefined && typeof args.workdir !== "string")
            || (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isSafeInteger(args.timeout) || args.timeout < 0))
            || (args.background !== undefined && typeof args.background !== "boolean")) {
            return yield* Effect.fail(failure("invalid shell arguments (command limit: 1MB)"))
          }
          if (args.background === true) return yield* Effect.fail(failure("Bashkit background execution is unsupported"))
          const command = args.command
          const session = yield* ctx.session.get({ sessionID: context.sessionID }).pipe(Effect.mapError(failure))
          const root = yield* Effect.tryPromise({ try: () => realpath(session.location.directory), catch: failure })
          const cwd = yield* Effect.try({ try: () => workdir(root, args.workdir as string | undefined), catch: failure })
          const existing = sessions.get(context.sessionID)
          if (existing) {
            const state = yield* Effect.tryPromise({ try: () => existing, catch: failure })
            if (state.root !== root) return yield* Effect.fail(failure("session directory changed; overlay cannot be reused"))
          }
          // OpenCode exposes its core service in the tool execution scope, not plugin setup.
          // Fail closed on hosts that do not supply it. Never emulate permission rules.
          const permission = yield* Effect.serviceOption(Permission.Service)
          if (Option.isNone(permission)) return yield* Effect.fail(failure("OpenCode permission service unavailable"))
          const parsed = yield* ShellParse.scan(command, "/bin/bash", cwd).pipe(Effect.mapError(failure))
          yield* permission.value.assert({
            action: "shell", sessionID: context.sessionID, agent: context.agent,
            resources: parsed.commands.length ? parsed.commands.map(item => item.resource) : [command],
            save: parsed.commands.length ? parsed.commands.map(item => item.save) : [command],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          }).pipe(Effect.mapError(failure))
          const timeout = Math.min((args.timeout as number | undefined) || 120_000, 120_000)
          const result = yield* Effect.tryPromise({
            try: async signal => {
              if (closed || deleted.has(context.sessionID) || signal.aborted) throw new Error("session runtime disposed or call cancelled")
              let pending = sessions.get(context.sessionID)
              if (!pending) {
                pending = native.Runtime.create(root).then(runtime => ({ root, runtime }))
                sessions.set(context.sessionID, pending)
              }
              const state = await pending
              if (state.root !== root) throw new Error("session directory changed; overlay cannot be reused")
              if (closed || deleted.has(context.sessionID) || signal.aborted) throw new Error("session runtime disposed or call cancelled")
              const cancellation = new native.Cancellation()
              const cancel = () => cancellation.cancel()
              signal.addEventListener("abort", cancel, { once: true })
              try {
                return await state.runtime.execute(command, cwd, timeout, cancellation)
              } finally {
                signal.removeEventListener("abort", cancel)
              }
            }, catch: failure,
          })
          const text = result.stdout + result.stderr + (result.runtimeError ? `\nBashkit: ${result.runtimeError}` : "")
          const output = {
            output: text, status: "completed" as const,
            truncated: result.stdoutTruncated || result.stderrTruncated,
            ...(result.exitCode !== undefined ? { exit: result.exitCode } : {}),
            ...(result.runtimeError && /time(?:d)?[ -]?out|deadline/i.test(result.runtimeError) ? { timeout: true } : {}),
          }
          return { output, content: [{ type: "text" as const, text: text || `Exit code: ${result.exitCode}` }], metadata: result }
        })
      })
    })
  }),
})
