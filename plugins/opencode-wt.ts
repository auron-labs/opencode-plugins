import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const id = "opencode-wt"
const execFileAsync = promisify(execFile)

const commandNames = ["wt", "wt-create", "wt-switch"] as const

const commandDescriptions: Record<(typeof commandNames)[number], string> = {
  wt: "Create or switch to a Worktrunk worktree, then move OpenCode there.",
  "wt-create": "Alias for /wt.",
  "wt-switch": "Alias for /wt.",
}

type TextPart = {
  type: "text"
  text: string
}

type CommandInput = {
  command?: string
  name?: string
  arguments?: string
  sessionID?: string
}

type CommandOutput = {
  parts?: TextPart[]
  noReply?: boolean
}

type Client = {
  session: {
    prompt(args: { path: { id: string }; body: { noReply?: boolean; parts: TextPart[] } }): Promise<void>
  }
  tui?: {
    showToast(args: { body: { message: string; variant: string } }): Promise<void>
  }
}

type ExecFileFailure = {
  code?: unknown
  stdout?: unknown
  stderr?: unknown
}

const textPart = (text: string): TextPart => ({ type: "text", text })

const usage = "Usage: /wt <branch>"

const splitArgs = (input: string) => input.match(/"[^"]*"|'[^']*'|\S+/g) || []

const stripQuotes = (input: string) => {
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    return input.slice(1, -1)
  }
  return input
}

const parseBranch = (rawArgs: string) => {
  const parts = splitArgs(rawArgs.trim())
  if (parts.length !== 1) {
    throw new Error(`${usage}\n\nPass exactly one branch name.`)
  }

  const branch = stripQuotes(parts[0]).trim()
  if (!branch) {
    throw new Error(`${usage}\n\nBranch name cannot be empty.`)
  }

  return branch
}

const switchWorktree = async (directory: string, branch: string) => {
  try {
    const { stdout, stderr } = await execFileAsync(
      "wt",
      ["switch", "--create", "--no-cd", "-x", "pwd", branch],
      { cwd: directory, env: process.env, maxBuffer: 1024 * 1024 },
    )

    const target = stdout.trim()
    if (!target) {
      const detail = stderr.trim()
      throw new Error(detail ? `wt returned no path: ${detail}` : "wt returned no path")
    }

    return target
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("wt CLI not found on PATH")
    }

    if (error && typeof error === "object" && "stderr" in error) {
      const failure = error as ExecFileFailure
      const detail =
        (typeof failure.stderr === "string" && failure.stderr.trim()) ||
        (typeof failure.stdout === "string" && failure.stdout.trim())
      throw new Error(detail || "wt switch failed")
    }

    throw error
  }
}

const moveSession = async (client: Client, sessionID: string, target: string) => {
  await client.session.prompt({
    path: { id: sessionID },
    body: { noReply: true, parts: [textPart(`/move ${JSON.stringify(target)}`)] },
  })
}

const showToast = async (client: Client, message: string, variant: "success" | "error") => {
  try {
    await client.tui?.showToast({ body: { message, variant } })
  } catch {}
}

export const OpencodeWtPlugin: Plugin = async ({ client, directory }: { client: Client; directory: string }) => ({
  config: async (input: { command?: Record<string, { description: string; template: string }> }) => {
    input.command ??= {}

    for (const commandName of commandNames) {
      if (input.command[commandName]) continue
      input.command[commandName] = {
        description: commandDescriptions[commandName],
        template: "$ARGUMENTS",
      }
    }
  },

  "command.execute.before": async (input: CommandInput, output: CommandOutput) => {
    const command = input.command ?? input.name
    if (!commandNames.includes(command as (typeof commandNames)[number])) return

    const sessionID = input.sessionID
    if (!sessionID) {
      throw new Error("/wt requires a session ID")
    }

    const branch = parseBranch(input.arguments ?? "")
    const target = await switchWorktree(directory, branch)

    await moveSession(client, sessionID, target)
    await showToast(client, `Moved to ${target}`, "success")

    output.parts = [textPart(`Moved to ${target}`)]
    output.noReply = true
  },
})

const plugin: PluginModule & { id: string } = {
  id,
  server: OpencodeWtPlugin,
}

export default plugin
