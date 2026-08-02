import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { COMMANDS, describeCommand, type ImperfectableCommand } from "./commands.js"
import type { ImperfectableRuntime } from "./tools.js"
import { buildTools } from "./tools.js"
import { buildDetectorRunner, detectorCandidatesFromWrite, type DetectorScanResult } from "./detector.js"
import { resolveHook } from "./config.js"
import { info, warn } from "./logger.js"

const id = "opencode-impeccable"

export type ImperfectablePluginOptions = {
  binary?: string
  bootstrap?: boolean
  refsPath?: string
}

export type PluginContext = {
  client?: unknown
  directory: string
  worktree?: string
  project?: { worktree?: string }
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

const FRONTMATTER = /^---\n[\s\S]*?\n---\n\n/

function normalizeOptions(options?: ImperfectablePluginOptions) {
  return {
    binary: options?.binary?.trim() || "impeccable",
    bootstrap: options?.bootstrap ?? true,
    refsPath: options?.refsPath ?? fileURLToPath(new URL("../references/SKILL.md", import.meta.url)),
  }
}

async function loadSkillPrompt(refsDirAbs: string): Promise<string> {
  const skillPath = join(refsDirAbs, "SKILL.md")
  const body = await readFile(skillPath, "utf8")
  return body.replace(FRONTMATTER, "")
}

function rewriteReferences(prompt: string, refsDirAbs: string): string {
  return prompt.replaceAll("`references/", `\`${refsDirAbs}/`).replaceAll("references/", `${refsDirAbs}/`)
}

function buildRuntime(directory: string, worktree: string, binary: string, refsDirAbs: string): ImperfectableRuntime {
  return {
    binary,
    directory,
    refsDirAbs,
    worktree,
    isNativePlatform: (platform: string) => platform === "ios" || platform === "android" || platform === "adaptive",
  }
}

function buildCommandRecord(cmd: ImperfectableCommand, refsDirAbs: string): Record<string, unknown> {
  const refsNote = cmd.nativeReference
    ? `\nIf the project platform is native (ios/android/adaptive), also load \`${refsDirAbs}/${cmd.nativeReference}\`.`
    : ""
  const template = [
    `Run /impeccable ${cmd.name} per \`${refsDirAbs}/SKILL.md\`.${cmd.deprecated ? " This command is deprecated; behave as ordinary new-work." : ""}`,
    `Load \`${refsDirAbs}/${cmd.reference}\` and follow it.${refsNote}`,
    `Invocation arguments: $ARGUMENTS`,
  ].join("\n")
  return {
    description: describeCommand(cmd),
    template,
    agent: "impeccable",
    subtask: true,
  }
}

function buildMenuCommand(refsDirAbs: string): Record<string, unknown> {
  return {
    description:
      "Route an impeccable workflow (no-argument menu, draft commands, design tasks). Default name keeps the upstream `/impeccable` namespace intact.",
    template: [
      "Dispatch via the impeccable agent. Invocation arguments: $ARGUMENTS",
      "With no arguments, load `references/routing.md` for the context-aware menu; never auto-run a command.",
      "With an explicit or clearly implied command, load its reference at `${refsDirAbs}/<command>.md` and follow it.",
      "With a `hooks` or `doctor` argument, use the matching tool from the toolkit rather than re-implementing the flow.",
    ]
      .join("\n")
      .replace("${refsDirAbs}", refsDirAbs),
    agent: "impeccable",
    subtask: true,
  }
}

export const ImperfectablePlugin = async (
  { client, directory, worktree }: PluginContext,
  options?: ImperfectablePluginOptions,
) => {
  const opts = normalizeOptions(options)
  const refsDirAbs = dirname(opts.refsPath)
  const effectiveWorktree = worktree || directory
  const runtime = buildRuntime(directory, effectiveWorktree, opts.binary, refsDirAbs)
  const tools = buildTools(runtime)

  // Bootstrap a missing/older installation lazily, but never block plugin load.
  void (async () => {
    if (!opts.bootstrap) return
    if (opts.binary !== "impeccable" && !existsSync(opts.binary)) {
      info("binary_missing", "impeccable binary not found at the configured path", {
        binary: opts.binary,
      })
    }
  })()

  const configHook = async (input: Record<string, unknown> = {}) => {
    const promptBody = await loadSkillPrompt(refsDirAbs).catch(() => "")
    const finalPrompt = promptBody ? rewriteReferences(promptBody, refsDirAbs) : ""

    const agents = (input.agent ?? (input.agent = {})) as Record<string, Record<string, unknown>>
    if (!agents.impeccable && finalPrompt) {
      agents.impeccable = {
        description:
          "Plan, execute, and review Impeccable design commands (audit, polish, critique, init, document, extract, etc.). Always call impeccable_context once per session first; never invoke Bash.",
        mode: "subagent",
        hidden: true,
        prompt: finalPrompt,
        permission: {
          edit: { "**": "deny" },
          read: { [`${refsDirAbs}/**`]: "allow" },
          external_directory: { [`${refsDirAbs}/**`]: "allow" },
        },
      }
    }

    const commands = (input.command ?? (input.command = {})) as Record<string, Record<string, unknown>>
    for (const cmd of COMMANDS) {
      const key = `impeccable-${cmd.name}`
      const payload = buildCommandRecord(cmd, refsDirAbs)
      if (!commands[key]) {
        commands[key] = payload
      }
    }
    if (!commands.impeccable) {
      commands.impeccable = buildMenuCommand(refsDirAbs)
    }
  }

  const hooks = buildHooks(runtime, client as Client | undefined, refsDirAbs)

  return {
    config: configHook,
    tool: tools,
    "tool.execute.after": hooks.after,
    event: hooks.event,
  }
}

function buildHooks(runtime: ImperfectableRuntime, client: Client | undefined, refsDirAbs: string) {
  const detector = buildDetectorRunner(runtime, {
    onFindings: (path, result) => {
      if (result.findings.length === 0) return
      const summary = formatFindingsSummary(result)
      void notify(client, summary, "warning", refsDirAbs)
    },
  })

  function extractWritePaths(toolName: string, args: unknown): string[] {
    if (!args || typeof args !== "object") return []
    const obj = args as Record<string, unknown>
    const candidates: unknown[] = []
    if (toolName === "write") candidates.push(obj.filePath, obj.path)
    else if (toolName === "edit" || toolName === "multiedit" || toolName === "patch") candidates.push(obj.filePath, obj.path)
    else if (toolName === "bash") {
      const command = typeof obj.command === "string" ? obj.command : ""
      if (/\b(write|edit)\b/.test(command)) {
        // surface a curl/tee/etc wrote-a-file case by letting detector handle it via the watcher
      }
      return []
    }
    return candidates
      .filter((value): value is string => typeof value === "string")
      .filter((value) => detectorCandidatesFromWrite(value))
  }

  return {
    after: async (input: { tool: string; args: unknown }) => {
      const paths = extractWritePaths(input.tool, input.args)
      if (paths.length === 0) return
      const hook = resolveHook(runtime.directory)
      if (!hook.enabled) return
      // ponytail: scanner is shared across calls; concurrent edits get serialized
      for (const path of paths) {
        try {
          await detector.scanPath(path)
        } catch (error) {
          warn("detector_failed", "Detector scan failed for post-edit path", {
            path,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    },
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type === "session.idle") {
        // ponytail: session-scoped deep scan is intentionally not implemented yet
        // — the upstream Stop hook equivalent surfaces a deduplicated set across
        // touched files. Sub-skill can call impeccable_detect with the session's
        // touched file list directly.
      }
    },
  }
}

async function notify(client: Client | undefined, message: string, variant: string, refsDirAbs: string) {
  if (!client?.tui?.showToast) return
  try {
    await client.tui.showToast({ body: { message, variant }, duration: 6000 })
  } catch (error) {
    warn("toast_failed", "Failed to show detector finding toast", {
      refsDirAbs,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function formatFindingsSummary(result: DetectorScanResult): string {
  const count = result.findings.length
  const first = result.findings
    .slice(0, 3)
    .map((finding) => `• ${finding.rule}: ${finding.message.split("\n")[0]}`)
    .join("\n")
  const extra = count > 3 ? `\n…and ${count - 3} more` : ""
  return `impeccable: ${count} finding(s) in ${result.path}\n${first}${extra}`
}

export default { id, server: ImperfectablePlugin }
