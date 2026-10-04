import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tool, type Hooks, type ToolContext as V1ToolContext } from "@opencode-ai/plugin"
import { Plugin } from "@opencode/plugin"
import { COMMANDS, describeCommand, MENU_REFERENCE, type ImperfectableCommand } from "./commands.js"
import { warn } from "./logger.js"
import { defaultRuntimePaths, runHookScript, type ImpeccableRuntime } from "./runtime.js"
import { adaptReferenceText, buildTools, loadReferenceText } from "./tools.js"

const id = "opencode-impeccable"
// plugin format: both V1 and V2 from one default export ({ ...Plugin.define, server })

const z = tool.schema

// V2 registration adapter: reuse each V1 tool definition as the single schema
// source and expose it through the V2 transform editor. V2 `execute` returns
// structured content instead of a bare string, so wrap the V1 executor.

type V2ToolContext = {
  sessionID: string
  agent: string
  messageID: string
  id: string
  signal?: AbortSignal
}

function toV2Tool(name: string, definition: ReturnType<typeof tool>, directory: string) {
  return {
    name,
    description: definition.description,
    input: z.object(definition.args),
    execute: async (input: unknown, context: V2ToolContext) => {
      const result = await definition.execute(input as never, {
        sessionID: context.sessionID,
        messageID: context.messageID,
        agent: context.agent,
        directory,
        worktree: directory,
        abort: context.signal ?? new AbortController().signal,
        metadata: () => {},
        ask: async () => { throw new Error("V1 permission requests are unavailable in V2 tools") },
      } as V1ToolContext)
      return typeof result === "string" ? { content: result } : { content: result.output, metadata: result.metadata }
    },
  }
}
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
  binary?: string
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

type CommandExecuteBeforeInput = {
  command: string
  sessionID: string
  arguments: string
}

type CommandPart = {
  type?: string
  text?: string
  [key: string]: unknown
}

type CommandExecuteBeforeOutput = {
  parts: CommandPart[]
}

const ADAPTER_PROMPT = `
You are the Impeccable implementation agent inside the native OpenCode plugin.

OpenCode adapter rules:
- You are an implementation agent, not a read-only planner. Complete requested edits and verify them with the project's normal tools.
- The user's effective OpenCode permissions remain authoritative. Do not inspect global OpenCode configuration to diagnose a denied action.
- Call impeccable_context once at the beginning of an Impeccable workflow.
- Load playbooks with impeccable_reference. Pass the Markdown basename without .md.
- Playbook engine verbs map to impeccable_<verb> tools, with hyphens converted to underscores; signals uses impeccable_context_signals and hooks uses impeccable_hook_admin.
- Use impeccable_hooks_* tools for hook administration and impeccable_pin for shortcuts.
- Never invoke npx impeccable or a package-external Impeccable binary. The plugin's tools own the bundled runtime.
- Normal project editing, shell, browser, test, and build tools remain available when the user's permission policy allows them.
`.trim()

async function loadSkillPrompt(refsDirAbs: string): Promise<string> {
  const body = await readFile(join(refsDirAbs, "..", "SKILL.md"), "utf8")
  const upstream = adaptReferenceText(body)
    .replace(FRONTMATTER, "")
    .replaceAll("{{command_prefix}}", "/")

  return `${ADAPTER_PROMPT}\n\n${upstream}`
}

async function loadAuxiliaryAgentPrompt(agentsDirAbs: string, file: string): Promise<string> {
  const upstream = adaptReferenceText((await readFile(join(agentsDirAbs, file), "utf8")).replace(FRONTMATTER, ""))
  const adapter = [
    "OpenCode adapter rules:",
    "- The user's effective OpenCode permissions are authoritative; this plugin does not override them.",
    "- When an input names reference/<name>.md, load <name> with impeccable_reference instead of reading plugin package paths.",
    "- Use the plugin's impeccable_* tools for Impeccable runtime workflows; never invoke npx impeccable or a separate Impeccable binary.",
  ].join("\n")
  return `${adapter}\n\n${upstream}`
}

function buildCommandPrompt(command: ImperfectableCommand, referenceText: string, argumentsText: string): string {
  const lines = [
    `Run /impeccable ${command.name}.${command.deprecated ? " This command is deprecated; handle it as ordinary new-work." : ""}`,
    "Follow this bundled playbook, already adapted for OpenCode:",
    referenceText,
  ]
  if (command.nativeReference) {
    lines.push(
      `For ios/android/adaptive projects, also load ${command.nativeReference.replace(/\.md$/, "")} with impeccable_reference.`,
    )
  }
  lines.push(`Invocation arguments: ${argumentsText || "(none)"}`)
  return lines.join("\n")
}

function buildCommandRecord(command: ImperfectableCommand, referenceText: string): Record<string, unknown> {
  return {
    description: describeCommand(command),
    template: buildCommandPrompt(command, referenceText, "$ARGUMENTS"),
    agent: "impeccable",
    subtask: false,
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
    subtask: false,
  }
}

function replaceCommandTextPart(parts: CommandPart[], prompt: string): void {
  const textPart = parts.find((part) => part.type === "text" && typeof part.text === "string")
  if (textPart) textPart.text = prompt
}

function splitCommandArguments(argumentsText: string): { command?: string; rest: string } {
  const trimmed = argumentsText.trim()
  if (!trimmed) return { rest: "" }
  const separator = trimmed.search(/\s/)
  if (separator === -1) return { command: trimmed, rest: "" }
  return { command: trimmed.slice(0, separator), rest: trimmed.slice(separator).trim() }
}

function findCommand(name: string | undefined): ImperfectableCommand | undefined {
  if (!name) return undefined
  return COMMANDS.find((command) => command.name === name || command.aliases?.includes(name))
}

function buildMenuRoutePrompt(
  argumentsText: string,
  routingReference: string,
  commandReferences: Map<string, string>,
): string {
  const invocation = splitCommandArguments(argumentsText)
  const command = findCommand(invocation.command)
  if (command) {
    return buildCommandPrompt(command, commandReferences.get(command.name)!, invocation.rest)
  }

  const trimmedArguments = argumentsText.trim()
  return [
    "Dispatch this request through the Impeccable implementation agent.",
    "Call impeccable_context once before presenting the menu.",
    trimmedArguments
      ? "This is an unrecognized or freeform request; do not guess a command. Use the routing playbook to choose a safe recommendation."
      : "With no command selected, present the context-aware menu without auto-running a command.",
    "Follow this bundled routing playbook, already adapted for OpenCode:",
    routingReference,
    `Invocation arguments: ${trimmedArguments || "(none)"}`,
  ].join("\n")
}

function createRuntime(directory: string, worktree?: string, binary?: string): ImpeccableRuntime {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const paths = defaultRuntimePaths(packageRoot)
  return {
    directory,
    worktree: worktree || directory,
    ...paths,
    binary: binary?.trim() || process.env.IMPECCABLE_BIN?.trim(),
  }
}

// V1 entrypoint
export const ImperfectablePlugin = async (
  { client, directory, worktree }: PluginContext,
  options?: ImperfectablePluginOptions,
): Promise<Hooks> => {
  const runtime = createRuntime(directory, worktree, options?.binary)
  const tools = buildTools(runtime)
  const commandReferences = new Map<string, string>()
  let routingReference = ""
  let ownsMenuCommand = false

  const configHook = async (input: Record<string, unknown> = {}) => {
    const prompt = await loadSkillPrompt(runtime.refsDirAbs)
    const agents = (input.agent ?? (input.agent = {})) as Record<string, Record<string, unknown>>
    if (!agents.impeccable) {
      agents.impeccable = {
        description:
          "Implement and review Impeccable design workflows, including project edits and verification, using the bundled typed tools.",
        mode: "primary",
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
      const referenceText = loadReferenceText(runtime.refsDirAbs, command.reference.replace(/\.md$/, ""))
      commandReferences.set(command.name, referenceText)
      if (!commands[key]) {
        commands[key] = buildCommandRecord(command, referenceText)
      }
    }
    if (!commands.impeccable) {
      commands.impeccable = buildMenuCommand()
      routingReference = loadReferenceText(runtime.refsDirAbs, MENU_REFERENCE.replace(/\.md$/, ""))
      ownsMenuCommand = true
    }
  }

  const hooks = buildHooks(runtime, client)
  return {
    config: configHook,
    tool: tools,
    "command.execute.before": async (input: CommandExecuteBeforeInput, output: CommandExecuteBeforeOutput) => {
      if (!ownsMenuCommand || input.command !== "impeccable") return
      replaceCommandTextPart(output.parts, buildMenuRoutePrompt(input.arguments, routingReference, commandReferences))
    },
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
        if (!warnedSessions.has(sessionID)) {
          warnedSessions.add(sessionID)
          warn("detector_failed", "Bundled detector hook failed after an edit", {
            sessionID,
            error: error instanceof Error ? error.message : String(error),
          })
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

// V2 entrypoint
const plugin = Plugin.define({
  id,
  async setup(ctx) {
    const runtime = createRuntime(
      ctx.location.directory,
      ctx.location.directory,
      ctx.options.binary as string | undefined,
    )

    const skillPrompt = await loadSkillPrompt(runtime.refsDirAbs)
    const auxPrompts = new Map<string, string>()
    for (const [name, agent] of Object.entries(AUXILIARY_AGENTS)) {
      auxPrompts.set(name, await loadAuxiliaryAgentPrompt(runtime.agentsDirAbs, agent.file))
    }

    const commandReferences = new Map<string, string>()
    for (const command of COMMANDS) {
      commandReferences.set(
        command.name,
        loadReferenceText(runtime.refsDirAbs, command.reference.replace(/\.md$/, "")),
      )
    }
    const routingReference = loadReferenceText(runtime.refsDirAbs, MENU_REFERENCE.replace(/\.md$/, ""))

    const tools = buildTools(runtime)
    const existingCommands = new Set((await ctx.command.list()).data.map((entry) => entry.name))
    const hooks = buildHooks(runtime)

    await ctx.agent.transform((editor) => {
      if (!editor.get("impeccable")) {
        editor.update("impeccable", (agent) => {
          Object.assign(agent, {
            description:
              "Implement and review Impeccable design workflows, including project edits and verification, using the bundled typed tools.",
            mode: "primary",
            hidden: true,
            system: skillPrompt,
          })
        })
      }
      for (const [name, definition] of Object.entries(AUXILIARY_AGENTS)) {
        if (editor.get(name)) continue
        editor.update(name, (agent) => {
          Object.assign(agent, {
            description: definition.description,
            mode: "subagent",
            hidden: true,
            system: auxPrompts.get(name) ?? "",
          })
        })
      }
    })

    await ctx.command.transform((editor) => {
      for (const command of COMMANDS) {
        const name = `impeccable-${command.name}`
        if (existingCommands.has(name)) continue
        editor.add({
          name,
          description: describeCommand(command),
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.switchAgent({ sessionID, agent: "impeccable" })
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text: buildCommandPrompt(command, commandReferences.get(command.name)!, prompt.text),
              delivery,
            })
          },
        })
      }
      if (!existingCommands.has("impeccable")) {
        editor.add({
          name: "impeccable",
          description: "Route an Impeccable workflow or show the context-aware Impeccable command menu.",
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.switchAgent({ sessionID, agent: "impeccable" })
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text: buildMenuRoutePrompt(prompt.text, routingReference, commandReferences),
              delivery,
            })
          },
        })
      }
    })

    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(tools)) {
        editor.add(toV2Tool(name, definition, ctx.location.directory))
      }
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const output = { output: "" }
      await hooks.after({ tool: event.tool, sessionID: event.sessionID, args: event.input }, output)
      if (!output.output) return
      const result = event.result
      event.result = {
        ...result,
        content: typeof result.content === "string"
          ? `${result.content}\n\n${output.output}`
          : [...(result.content ?? []), { type: "text", text: output.output }],
      }
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted" || event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
            await hooks.event({ event: { type: "session.idle", properties: { sessionID: event.data.sessionID } } })
          }
        }
      } catch {
        // subscription ends when the plugin unloads and aborts the controller
      }
    })()

    return () => controller.abort()
  },
})

export default { ...plugin, server: ImperfectablePlugin }
