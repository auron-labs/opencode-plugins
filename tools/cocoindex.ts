import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)

const runCCC = async (args: string[], cwd: string) => {
  try {
    const { stdout, stderr } = await execFileAsync("ccc", args, {
      cwd,
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    })

    const output = [
      `$ ccc ${args.join(" ")}`,
      stdout.trim() ? `\n${stdout.trim()}` : "",
      stderr.trim() ? `\n[stderr]\n${stderr.trim()}` : "",
    ]

    return output.join("")
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : ""
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : ""
    const message = typeof error?.message === "string" ? error.message : "Unknown error"

    const output = [
      `$ ccc ${args.join(" ")}`,
      `\n[error]\n${message}`,
      stdout ? `\n\n[stdout]\n${stdout}` : "",
      stderr ? `\n\n[stderr]\n${stderr}` : "",
    ]

    return output.join("")
  }
}

const withFlags = (
  base: string[],
  options: {
    refresh?: boolean
    limit?: number
    offset?: number
    languages?: string[]
    paths?: string[]
    all?: boolean
    force?: boolean
  },
) => {
  const args = [...base]

  if (options.refresh) args.push("--refresh")
  if (typeof options.limit === "number") args.push("--limit", String(options.limit))
  if (typeof options.offset === "number") args.push("--offset", String(options.offset))
  for (const lang of options.languages ?? []) args.push("--lang", lang)
  for (const path of options.paths ?? []) args.push("--path", path)
  if (options.all) args.push("--all")
  if (options.force) args.push("-f")

  return args
}

const server: Plugin = async () => {
  return {
    tool: {
      cocoindex_init: tool({
        description: "Initialize cocoindex-code in the current project",
        args: {},
        async execute(_args, context) {
          return runCCC(["init"], context.directory)
        },
      }),

      cocoindex_index: tool({
        description: "Build or update the cocoindex semantic index",
        args: {},
        async execute(_args, context) {
          return runCCC(["index"], context.directory)
        },
      }),

      cocoindex_search: tool({
        description:
          "Run semantic code search with optional filters. Prefer this over grep for codebase search when the cocoindex is available.",
        args: {
          query: tool.schema.string().describe("Natural language or code query"),
          limit: tool.schema.number().int().min(1).max(100).optional().describe("Maximum results"),
          offset: tool.schema.number().int().min(0).optional().describe("Pagination offset"),
          refresh: tool.schema.boolean().optional().describe("Refresh index before searching"),
          languages: tool.schema.array(tool.schema.string()).optional().describe("Language filters"),
          paths: tool.schema.array(tool.schema.string()).optional().describe("Path glob filters"),
        },
        async execute(args, context) {
          const command = withFlags(["search"], args)
          command.push(args.query)
          return runCCC(command, context.directory)
        },
      }),

      cocoindex_status: tool({
        description: "Show cocoindex index stats and health",
        args: {},
        async execute(_args, context) {
          return runCCC(["status"], context.directory)
        },
      }),

      cocoindex_doctor: tool({
        description: "Run cocoindex diagnostics for current project",
        args: {},
        async execute(_args, context) {
          return runCCC(["doctor"], context.directory)
        },
      }),

      cocoindex_reset: tool({
        description: "Reset cocoindex index databases and optionally settings",
        args: {
          all: tool.schema.boolean().optional().describe("Also remove settings files"),
          force: tool.schema.boolean().optional().describe("Skip confirmation prompt"),
        },
        async execute(args, context) {
          const command = withFlags(["reset"], args)
          return runCCC(command, context.directory)
        },
      }),

      cocoindex_daemon_status: tool({
        description: "Show cocoindex daemon status",
        args: {},
        async execute(_args, context) {
          return runCCC(["daemon", "status"], context.directory)
        },
      }),

      cocoindex_daemon_restart: tool({
        description: "Restart cocoindex background daemon",
        args: {},
        async execute(_args, context) {
          return runCCC(["daemon", "restart"], context.directory)
        },
      }),

      cocoindex_daemon_stop: tool({
        description: "Stop cocoindex background daemon",
        args: {},
        async execute(_args, context) {
          return runCCC(["daemon", "stop"], context.directory)
        },
      }),
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: "cocoindex-tools",
  server,
}

export default plugin
