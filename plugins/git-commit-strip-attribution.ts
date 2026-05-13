import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const id = "git-commit-strip-attribution"

const agentLabelPattern = String.raw`(?:OpenCode|opencode|Claude Code|Codex)`
const trailerPattern = String.raw`(?:Co-Authored-By|Co-authored-by|Assisted-by)`
const identityPattern = String.raw`(?:OpenCode|opencode|Codex(?: [^<"'\n\r]*)?|Claude(?: [^<"'\n\r]*)?|noreply@opencode\.ai|noreply@openai\.com|noreply@anthropic\.com)`

const literalGeneratedFooterBlock = new RegExp(
  String.raw`(?:\r?\n){2}(?:🤖\s*)?Generated with \[${agentLabelPattern}\]\([^)]+\)`,
  "gi",
)

const literalAttributionBlock = new RegExp(
  String.raw`(?:\r?\n){2}${trailerPattern}:[^"'\n\r]*(?:${identityPattern})[^"'\n\r]*`,
  "gi",
)

const escapedGeneratedFooterBlock = new RegExp(
  String.raw`(?:\\n){2}(?:🤖\s*)?Generated with \[${agentLabelPattern}\]\([^)]+\)`,
  "gi",
)

const escapedAttributionBlock = new RegExp(
  String.raw`(?:\\n){2}${trailerPattern}:[^"']*(?:${identityPattern})[^"']*`,
  "gi",
)

const standaloneAttributionMessageArg = new RegExp(
  String.raw`\s(?:-m|--message)(?:=|\s+)(?:"${trailerPattern}:[^"\n\r]*(?:${identityPattern})[^"\n\r]*"|'${trailerPattern}:[^'\n\r]*(?:${identityPattern})[^'\n\r]*')`,
  "gi",
)

const hasGitCommitMessageFlag = (command: string) =>
  /\bgit\b[\s\S]{0,200}\bcommit\b[\s\S]*?(?:\s(?:-m|--message|-F|--file)(?:=|\s|["']))/i.test(command)

const hasSupportedAttribution = (command: string) =>
  /Generated with \[(?:OpenCode|opencode|Claude Code|Codex)\]|(?:Co-Authored-By|Co-authored-by|Assisted-by):.*(?:opencode|openai|anthropic|OpenCode|Codex|Claude)/i.test(
    command,
  )

const stripAttribution = (command: string) =>
  command
    .replace(literalGeneratedFooterBlock, "")
    .replace(literalAttributionBlock, "")
    .replace(escapedGeneratedFooterBlock, "")
    .replace(escapedAttributionBlock, "")
    .replace(standaloneAttributionMessageArg, "")

export const StripGitCommitAttributionPlugin: Plugin = async () => ({
  "tool.execute.before": async (input, output) => {
    const tool = String(input?.tool ?? "").toLowerCase()
    if (tool !== "bash" && tool !== "shell") return

    const args = output?.args
    if (!args || typeof args !== "object") return

    const command = (args as Record<string, unknown>).command
    if (typeof command !== "string" || !command) return
    if (!hasGitCommitMessageFlag(command) || !hasSupportedAttribution(command)) return

    const sanitized = stripAttribution(command)
    if (sanitized !== command) {
      ;(args as Record<string, unknown>).command = sanitized
    }
  },
})

const plugin: PluginModule & { id: string } = {
  id,
  server: StripGitCommitAttributionPlugin,
}

export default plugin
