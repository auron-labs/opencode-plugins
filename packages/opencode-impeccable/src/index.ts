import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { COMMANDS, describeCommand, type ImperfectableCommand } from "./commands.js"
import { warn } from "./logger.js"
import { defaultRuntimePaths, runHookScript, type ImpeccableRuntime } from "./runtime.js"
import { buildTools } from "./tools.js"

const id = "opencode-impeccable"
const FRONTMATTER = /^---\n[\s\S]*?\n---\n\n/
const EDIT_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch"])
const AUXILIARY_AGENTS = {
  impeccable_asset_producer: {
    file: "impeccable-asset-producer.md",
    description: "Produce reusable raster assets from an approved Impeccable visual direction.",
  },
  impeccable_documenter: {
    file: "impeccable-documenter.md",
    description: "Record DESIGN.md and its sidecar from the finished implementation.",
  },
  impeccable_finish_reviewer: {
    file: "impeccable-finish-reviewer.md",
    description: "Review a finished implementation against its direction, comp, and quality bar.",
  },
  impeccable_manual_edit_applier: {
    file: "impeccable-manual-edit-applier.md",
    description: "Apply one leased live-design copy-edit batch to project source.",
  },
} as const

export type ImperfectablePluginOptions = {
  nodePath?: string
}

export type PluginContext = {
  client?: Client
  directory: string
  worktree?: string
}

export type Client = {
  app?: {
    log?: (input: {
      body: {
        service?: string
        level?: string
        message: string
        extra?: Record<string, unknown>
      }
    }) => Promise<unknown>
  }
  tui?: {
    showToast?: (input: {
      body: { message: string; variant: string }
      duration?: number
    }) => Promise<unknown>
  }
}

const ADAPTER_PROMPT = `
You are the Impeccable implementation agent inside the native OpenCode plugin.

OpenCode adapter rules:
- You are an implementation agent, not a read-only planner. Complete requested edits and verify them with the project's normal tools.
- The user's effective OpenCode permissions remain authoritative. Do not inspect global OpenCode configuration to diagnose a denied action.
- Call impeccable_context once at the beginning of an Impeccable workflow.
- Load playbooks with impeccable_reference. Pass the Markdown basename without .md.
- Any playbook command written as node {{scripts_path}}/<name>.mjs maps to the typed tool impeccable_<name>, with hyphens converted to underscores.
- Use impeccable_hooks_* tools for hook administration and impeccable_pin for shortcuts.
- Never invoke npx impeccable or a package-external Impeccable binary. The plugin's tools own the bundled runtime.
- Normal project editing, shell, browser, test, and build tools remain available when the user's permission policy allows them.
`.trim()

async function loadSkillPrompt(refsDirAbs: string): Promise<string> {
  const body = await readFile(join(refsDirAbs, "SKILL.md"), "utf8")
  const upstream = body
    .replace(FRONTMATTER, "")
    .replaceAll("{{command_prefix}}", "/")
    .replaceAll("node {{scripts_path}}/context.mjs", "the impeccable_context tool")
    .replaceAll("node {{scripts_path}}/pin.mjs <pin|unpin> <command>", "the impeccable_pin tool")
  return `${ADAPTER_PROMPT}\n\n${upstream}`
}

async function loadAuxiliaryAgentPrompt(agentsDirAbs: string, file: string): Promise<string> {
  const upstream = (await readFile(join(agentsDirAbs, file), "utf8")).replace(FRONTMATTER, "")
  const adapter = [
    "OpenCode adapter rules:",
    "- The user's effective OpenCode permissions are authoritative; this plugin does not override them.",
    "- When an input names reference/<name>.md, load <name> with impeccable_reference instead of reading plugin package paths.",
    "- Use the plugin's impeccable_* tools for Impeccable runtime workflows; never invoke npx impeccable or a separate Impeccable binary.",
  ].join("\n")
  return `${adapter}\n\n${upstream}`
}

function buildCommandRecord(command: ImperfectableCommand): Record<string, unknown> {
  const lines = [
    `Run /impeccable ${command.name}.${command.deprecated ? " This command is deprecated; handle it as ordinary new-work." : ""}`,
    `Load the ${command.reference.replace(/\.md$/, "")} playbook with impeccable_reference and follow it.`,
  ]
  if (command.nativeReference) {
    lines.push(
      `For ios/android/adaptive projects, also load ${command.nativeReference.replace(/\.md$/, "")} with impeccable_reference.`,
    )
  }
  lines.push("Invocation arguments: $ARGUMENTS")
  return {
    description: describeCommand(command),
    template: lines.join("\n"),
    agent: "impeccable",
    subtask: true,
  }
}

function buildMenuCommand(): Record<string, unknown> {
  return {
    description:
      "Route an Impeccable workflow or show the context-aware Impeccable command menu.",
    template: [
      "Dispatch this request through the Impeccable implementation agent.",
      "Call impeccable_context once before routing.",
      "With no arguments, load routing with impeccable_reference and present its menu without auto-running a command.",
      "With an explicit or clearly implied command, load its playbook with impeccable_reference and follow it.",
      "Invocation arguments: $ARGUMENTS",
    ].join("\n"),
    agent: "impeccable",
    subtask: true,
  }
}

export const ImperfectablePlugin = async (
  { client, directory, worktree }: PluginContext,
  options?: ImperfectablePluginOptions,
) => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const paths = defaultRuntimePaths(packageRoot)
  const runtime: ImpeccableRuntime = {
    directory,
    worktree: worktree || directory,
    ...paths,
    nodePath: options?.nodePath?.trim() || process.env.IMPECCABLE_NODE?.trim() || "node",
  }
  const tools = buildTools(runtime)

  const configHook = async (input: Record<string, unknown> = {}) => {
    const prompt = await loadSkillPrompt(runtime.refsDirAbs)
    const agents = (input.agent ?? (input.agent = {})) as Record<string, Record<string, unknown>>
    if (!agents.impeccable) {
      agents.impeccable = {
        description:
          "Implement and review Impeccable design workflows, including project edits and verification, using the bundled typed tools.",
        mode: "subagent",
        hidden: true,
        prompt,
      }
    }
    for (const [name, agent] of Object.entries(AUXILIARY_AGENTS)) {
      if (agents[name]) continue
      agents[name] = {
        description: agent.description,
        mode: "subagent",
        hidden: true,
        prompt: await loadAuxiliaryAgentPrompt(runtime.agentsDirAbs, agent.file),
      }
    }

    const commands = (input.command ?? (input.command = {})) as Record<string, Record<string, unknown>>
    for (const command of COMMANDS) {
      const key = `impeccable-${command.name}`
      if (!commands[key]) commands[key] = buildCommandRecord(command)
    }
    if (!commands.impeccable) commands.impeccable = buildMenuCommand()
  }

  const hooks = buildHooks(runtime, client)
  return {
    config: configHook,
    tool: tools,
    "tool.execute.after": hooks.after,
    event: hooks.event,
  }
}

function buildHooks(runtime: ImpeccableRuntime, client?: Client) {
  const warnedSessions = new Set<string>()
  return {
    after: async (
      input: { tool: string; sessionID?: string; args?: unknown },
      output?: { output?: string; title?: string; metadata?: unknown },
    ) => {
      if (!EDIT_TOOLS.has(input.tool) || !input.args || typeof input.args !== "object") return
      const sessionID = input.sessionID || "unknown"
      const toolInput = normalizeHookToolInput(input.tool, input.args as Record<string, unknown>)
      try {
        const result = await runHookScript(runtime, {
          hook_event_name: "PostToolUse",
          sessionId: sessionID,
          cwd: runtime.worktree,
          toolName: input.tool === "patch" ? "apply_patch" : input.tool,
          toolArgs: input.tool === "patch" || input.tool === "apply_patch"
            ? String(toolInput.command ?? "")
            : toolInput,
        })
        const reminder = extractAdditionalContext(result.stdout)
        if (!reminder) return
        if (output) {
          const block = `<system-reminder>\n${reminder}\n</system-reminder>`
          output.output = output.output ? `${output.output}\n\n${block}` : block
        }
        if (looksLikeFinding(reminder)) {
          await notify(client, compactReminder(reminder), "warning")
        }
      } catch (error) {
        warn("detector_failed", "Bundled detector hook failed after an edit", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
        if (!warnedSessions.has(sessionID)) {
          warnedSessions.add(sessionID)
          await notify(
            client,
            `Impeccable detector could not run: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          )
        }
      }
    },
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== "session.idle" && event.type !== "session.deleted") return
      const properties = event.properties as { sessionID?: string; id?: string } | undefined
      const sessionID = properties?.sessionID ?? properties?.id
      if (sessionID) warnedSessions.delete(sessionID)
    },
  }
}

function normalizeHookToolInput(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const output = { ...args }
  if (toolName === "patch" || toolName === "apply_patch") {
    output.command = args.command ?? args.patch ?? args.input ?? ""
  }
  if (typeof output.filePath === "string" && output.file_path === undefined) {
    output.file_path = output.filePath
  }
  return output
}

function extractAdditionalContext(stdout: string): string | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    const value = JSON.parse(text) as {
      additionalContext?: unknown
      hookSpecificOutput?: { additionalContext?: unknown }
    }
    const context = value.additionalContext ?? value.hookSpecificOutput?.additionalContext
    return typeof context === "string" && context.trim() ? context.trim() : null
  } catch {
    warn("hook_output_invalid", "Impeccable hook returned malformed JSON", { output: text.slice(0, 500) })
    return null
  }
}

function looksLikeFinding(message: string): boolean {
  return /finding|fix these|impeccable detected|still present/i.test(message)
}

function compactReminder(message: string): string {
  return message.split("\n").filter(Boolean).slice(0, 4).join("\n").slice(0, 800)
}

async function notify(client: Client | undefined, message: string, variant: string) {
  if (!client?.tui?.showToast) return
  try {
    await client.tui.showToast({ body: { message, variant }, duration: 6000 })
  } catch (error) {
    warn("toast_failed", "Failed to show Impeccable notification", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export default { id, server: ImperfectablePlugin }
