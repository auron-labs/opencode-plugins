import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { warn } from "./logger.js"
// plugin format: { id, server } direct object export

const id = "opencode-improve"

type PluginContext = {
  directory: string
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

const frontmatterPattern = /^---\n[\s\S]*?\n---\n\n/
const invocationModifiers = new Set(["quick", "deep", "--issues"])
const focusCategories = new Set([
  "correctness",
  "security",
  "performance",
  "perf",
  "tests",
  "bugs",
  "tech-debt",
  "dependencies",
  "dx",
  "docs",
  "direction",
])

function rewritePromptReferences(prompt: string, refsDir: string): string {
  return prompt
    .replaceAll("[references/audit-playbook.md](references/audit-playbook.md)", `\`${refsDir}/audit-playbook.md\``)
    .replaceAll("[references/plan-template.md](references/plan-template.md)", `\`${refsDir}/plan-template.md\``)
    .replaceAll("[references/closing-the-loop.md](references/closing-the-loop.md)", `\`${refsDir}/closing-the-loop.md\``)
    .replaceAll("this skill's `references/audit-playbook.md`", `\`${refsDir}/audit-playbook.md\``)
}

async function buildPrompt(refsDir: string): Promise<string> {
  const skillPath = fileURLToPath(new URL("../references/SKILL.md", import.meta.url))
  const prompt = await readFile(skillPath, "utf8")
  return rewritePromptReferences(prompt.replace(frontmatterPattern, ""), refsDir)
}

function invocationTokens(argumentsText: string): string[] {
  const trimmed = argumentsText.trim()
  return trimmed ? trimmed.split(/\s+/) : []
}

function buildImproveRoutePrompt(argumentsText: string): string {
  const tokens = invocationTokens(argumentsText)
  if (tokens.includes("help") || tokens.includes("--help")) {
    return [
      "Route: help.",
      "Print the /improve usage from the bundled improve skill's \"Invocation variants\" section.",
      "Do not audit, inspect the repository, write plans, dispatch, or publish issues.",
      `Invocation arguments: ${argumentsText}`,
    ].join("\n")
  }

  const effort = tokens.find((token) => token === "quick" || token === "deep")
  const primary = tokens.find((token) => !invocationModifiers.has(token))
  let route: string

  switch (primary) {
    case undefined:
      route = "bare audit"
      break
    case "plan":
      route = "plan"
      break
    case "review-plan":
      route = "review-plan"
      break
    case "execute":
      route = "execute"
      break
    case "reconcile":
      route = "reconcile"
      break
    case "branch":
      route = "branch audit"
      break
    case "next":
    case "features":
    case "roadmap":
      route = "direction audit"
      break
    default:
      route = focusCategories.has(primary) ? `focused audit (${primary})` : "plan (free-form request)"
  }

  const prompt = [
    `Route: ${route}.`,
    "Use the bundled improve skill for the selected workflow details; do not choose a different route.",
    effort ? `Effort modifier: ${effort}; apply it to the selected audit route.` : undefined,
    tokens.includes("--issues")
      ? "Explicit --issues modifier: publish plans as GitHub issues only after following the skill's safety checks."
      : undefined,
    route === "plan (free-form request)"
      ? "Route unknown/free-form input to plan <description>; treat non-modifier text as the description for one plan."
      : undefined,
    `Invocation arguments: ${argumentsText}`,
  ]

  return prompt.filter((line): line is string => line !== undefined).join("\n")
}

function replaceCommandTextPart(parts: CommandPart[], prompt: string): void {
  const textPart = parts.find((part) => part.type === "text" && typeof part.text === "string")
  if (textPart) textPart.text = prompt
}

export default { id, server: async (_context: PluginContext) => {
    let ownsImproveCommand = false

    return {
      // ponytail: config hook types intentionally loose — these exact keys exist on the runtime Config
      config: async (input: Record<string, unknown>) => {
        const refsDir = path.resolve(fileURLToPath(new URL("../references", import.meta.url)))
        let prompt: string
        try {
          prompt = await buildPrompt(refsDir)
        } catch (error) {
          warn("build_prompt_failed", "Failed to build improve prompt", {
            refsDir,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }

        const agents = (input.agent ?? (input.agent = {})) as Record<string, Record<string, unknown>>
        if (!agents.improve) {
          agents.improve = {
            description:
              "Surveys a codebase and writes prioritized, self-contained implementation plans without editing source files.",
            mode: "primary",
            prompt,
            permission: {
              edit: {
                "plans/**": "allow",
                "advisor-plans/**": "allow",
                "**": "deny",
              },
              read: {
                [`${refsDir}/**`]: "allow",
              },
              external_directory: {
                [`${refsDir}/**`]: "allow",
              },
            },
          }
        }

        const commands = (input.command ?? (input.command = {})) as Record<string, Record<string, unknown>>
        if (!commands.improve) {
          commands.improve = {
            template: "Improve request: $ARGUMENTS",
            description:
              "Route audits and plans. Args: quick|deep|focus|branch|next|plan|review-plan|execute|reconcile|help [--issues]",
            agent: "improve",
          }
          ownsImproveCommand = true
        }
      },
      "command.execute.before": async (input: CommandExecuteBeforeInput, output: CommandExecuteBeforeOutput) => {
        if (!ownsImproveCommand || input.command !== "improve") return
        replaceCommandTextPart(output.parts, buildImproveRoutePrompt(input.arguments))
      },
    }
  }}
