import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { warn } from "./logger.js"
// plugin format: { id, server } direct object export

const id = "opencode-improve"

type PluginContext = {
  directory: string
}

const frontmatterPattern = /^---\n[\s\S]*?\n---\n\n/

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

export default { id, server: async (_context: PluginContext) => {
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
            mode: "subagent",
            hidden: true,
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
            template: [
              "Run the improve workflow from your instructions. Invocation arguments: $ARGUMENTS",
              "If no arguments are provided, run the default full audit and planning flow.",
              "If the argument is \"help\" or \"--help\", print this usage guide and do not audit:",
              "",
              "/improve                        full audit: recon → findings → prioritized plans",
              "/improve quick                  cheap pass: hotspots, top findings only",
              "/improve deep                   exhaustive: every package, every category",
              "/improve security               focused audit (also: perf, tests, bugs)",
              "/improve branch                 audit only what the current branch changes",
              "/improve next                   feature suggestions — where to take the project",
              "/improve plan <description>     skip the audit, spec one thing",
              "/improve review-plan <file>     critique and tighten an existing plan",
              "/improve execute <plan>         dispatch a subagent, review its work",
              "/improve reconcile              refresh the backlog: verify, unblock, retire",
              "/improve ... --issues           also publish plans as GitHub issues",
              "/improve help                   show this message",
            ].join("\n"),
            description:
              "Audit the codebase and write implementation plans. Args: quick|deep|security|perf|tests|bugs|branch|next|plan <desc>|review-plan <file>|execute <plan>|reconcile|help",
            agent: "improve",
            subtask: true,
          }
        }
      },
    }
  }}
