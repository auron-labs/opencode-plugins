import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, join, resolve } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { COMMANDS, describeCommand } from "./commands.js"
import {
  runImpeccableCli,
  runRuntimeScript,
  type ImpeccableRuntime,
  type RuntimeResult,
} from "./runtime.js"

const z = tool.schema
const PIN_MARKER = "<!-- opencode-impeccable-pinned-command -->"
const VALID_COMMANDS = new Set(COMMANDS.map((command) => command.name))

export function buildTools(runtime: ImpeccableRuntime) {
  return {
    impeccable_reference: referenceTool(runtime),
    impeccable_context: contextTool(runtime),
    impeccable_context_signals: contextSignalsTool(runtime),
    impeccable_detect: detectTool(runtime),
    impeccable_doctor: doctorTool(runtime),
    impeccable_pin: pinTool(runtime),
    impeccable_hook_admin: hookAdminTool(runtime),
    impeccable_hooks_status: hooksStatusTool(runtime),
    impeccable_hooks_toggle: hooksToggleTool(runtime),
    impeccable_hooks_ignore_value: hooksIgnoreValueTool(runtime),
    impeccable_hooks_ignore_rule: hooksIgnoreRuleTool(runtime),
    impeccable_hooks_ignore_file: hooksIgnoreFileTool(runtime),
    impeccable_hooks_reset: hooksResetTool(runtime),
    impeccable_ignores: ignoresTool(runtime),
    impeccable_concept_seed: conceptSeedTool(runtime),
    impeccable_critique_storage: critiqueStorageTool(runtime),
    impeccable_detect_csp: detectCspTool(runtime),
    impeccable_embed_prompt: embedPromptTool(runtime),
    impeccable_generate_image: generateImageTool(runtime),
    impeccable_surface_brief: surfaceBriefTool(runtime),
    impeccable_serve_question: serveQuestionTool(runtime),
    impeccable_live: liveTool(runtime),
    impeccable_live_server: liveServerTool(runtime),
    impeccable_live_poll: livePollTool(runtime),
    impeccable_live_status: liveStatusTool(runtime),
    impeccable_live_resume: liveResumeTool(runtime),
    impeccable_live_complete: liveCompleteTool(runtime),
    impeccable_live_insert: liveInsertTool(runtime),
    impeccable_live_wrap: liveWrapTool(runtime),
  }
}

function resultText(result: RuntimeResult): string {
  return result.stdout.trim() || "(no output)"
}

function referenceTool(runtime: ImpeccableRuntime) {
  const available = new Set(
    readdirSync(runtime.refsDirAbs)
      .filter((name) => name.endsWith(".md"))
      .map((name) => basename(name, ".md")),
  )
  return tool({
    description:
      "Load one bundled Impeccable playbook by name. Use this instead of reading plugin package files directly.",
    args: {
      name: z.string().describe("Reference name without .md, for example `polish` or `craft-floor`."),
    },
    async execute({ name }) {
      if (!available.has(name)) {
        throw new Error(`Unknown Impeccable reference: ${name}. Available: ${[...available].sort().join(", ")}`)
      }
      return adaptReferenceText(readFileSync(join(runtime.refsDirAbs, `${name}.md`), "utf8"))
    },
  })
}

function contextTool(runtime: ImpeccableRuntime) {
  return tool({
    description:
      "Load PRODUCT.md, DESIGN.md, the matching surface brief, native guidance, and current Impeccable project directives. Call once per session.",
    args: {
      target: z.string().optional().describe("Optional project-relative file, app, or route used to select a monorepo target."),
    },
    async execute({ target }) {
      const result = await runRuntimeScript(runtime, "context.mjs", target ? ["--target", target] : [], {
        timeoutMs: 30_000,
      })
      return markNativeHookActive(resultText(result))
    },
  })
}

function contextSignalsTool(runtime: ImpeccableRuntime) {
  return noArgScriptTool(
    runtime,
    "context-signals.mjs",
    "Gather context-aware routing signals for the no-argument Impeccable menu.",
  )
}

function detectTool(runtime: ImpeccableRuntime) {
  return tool({
    description:
      "Run the bundled deterministic Impeccable detector on files, directories, or URLs without requiring an installed CLI.",
    args: {
      targets: z.array(z.string()).min(1).describe("Files, directories, or URLs to scan."),
      scope: z.enum(["layout", "type"]).optional().describe("Optional detector rule scope."),
      noConfig: z.boolean().optional().describe("Ignore project detector configuration."),
      jsonOutput: z.boolean().optional().describe("Return machine-readable JSON."),
    },
    async execute({ targets, scope, noConfig, jsonOutput }) {
      const args = []
      if (jsonOutput) args.push("--json")
      if (noConfig) args.push("--no-config")
      if (scope) args.push("--scope", scope)
      args.push(...targets)
      return resultText(await runRuntimeScript(runtime, "detect.mjs", args, { timeoutMs: 120_000 }))
    },
  })
}

function doctorTool(runtime: ImpeccableRuntime) {
  return tool({
    description:
      "Report or safely repair drift in Impeccable project artifacts using the bundled runtime.",
    args: {
      fix: z.boolean().optional().describe("Apply only upstream migrations classified as automatic."),
      target: z.string().optional().describe("Optional monorepo target path."),
    },
    async execute({ fix, target }) {
      const args = ["--json"]
      if (fix) args.push("--fix")
      if (target) args.push("--target", target)
      return resultText(await runRuntimeScript(runtime, "doctor.mjs", args, { timeoutMs: 60_000 }))
    },
  })
}

function pinTool(runtime: ImpeccableRuntime) {
  return tool({
    description:
      "Create or remove an explicit project-local OpenCode shortcut for an Impeccable command.",
    args: {
      command: z.string().describe("Impeccable command to pin, for example `audit` or `polish`."),
      remove: z.boolean().optional().describe("Remove the shortcut instead of creating it."),
    },
    async execute({ command, remove }) {
      if (!VALID_COMMANDS.has(command)) {
        throw new Error(`Unknown Impeccable command: ${command}`)
      }
      const target = join(runtime.directory, ".opencode", "commands", `${command}.md`)
      if (remove) {
        if (!existsSync(target)) return `No pinned /${command} shortcut found.`
        const existing = readFileSync(target, "utf8")
        if (!existing.includes(PIN_MARKER)) {
          throw new Error(`Refusing to remove ${target}: it is not managed by opencode-impeccable.`)
        }
        rmSync(target)
        return `Removed the project-local /${command} shortcut.`
      }
      if (existsSync(target) && !readFileSync(target, "utf8").includes(PIN_MARKER)) {
        throw new Error(`Refusing to overwrite existing command: ${target}`)
      }
      const metadata = COMMANDS.find((entry) => entry.name === command)!
      mkdirSync(join(runtime.directory, ".opencode", "commands"), { recursive: true })
      writeFileSync(
        target,
        [
          "---",
          `description: ${JSON.stringify(describeCommand(metadata))}`,
          "---",
          "",
          PIN_MARKER,
          `Run /impeccable-${command} with these arguments: $ARGUMENTS`,
          "",
        ].join("\n"),
        "utf8",
      )
      return `Pinned /${command} for this project. Restart OpenCode if it is already running.`
    },
  })
}

function hooksStatusTool(runtime: ImpeccableRuntime) {
  return noArgScriptTool(runtime, "hook-admin.mjs", "Show validated Impeccable hook and ignore configuration.", ["status"])
}

function hookAdminTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Run a validated Impeccable hook administration action from an upstream playbook.",
    args: {
      action: z.enum(["status", "on", "off", "ignore-rule", "ignore-file", "ignore-value", "reset"]),
      rule: z.string().optional(),
      path: z.string().optional(),
      value: z.string().optional(),
      allValues: z.boolean().optional(),
      local: z.boolean().optional(),
      reason: z.string().optional(),
      files: z.array(z.string()).optional(),
    },
    async execute({ action, rule, path, value, allValues, local, reason, files }) {
      const args: string[] = [action]
      if (action === "ignore-rule") {
        if (!rule) throw new Error("rule is required for ignore-rule")
        args.push(rule)
        if (allValues) args.push("--all-values")
      } else if (action === "ignore-file") {
        if (!path) throw new Error("path is required for ignore-file")
        args.push(path)
      } else if (action === "ignore-value") {
        if (!rule || value === undefined) throw new Error("rule and value are required for ignore-value")
        args.push(rule, value, local ? "--local" : "--shared")
        for (const file of files ?? []) args.push("--file", file)
      }
      if (reason) args.push("--reason", reason)
      return resultText(await runRuntimeScript(runtime, "hook-admin.mjs", args))
    },
  })
}

function hooksToggleTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Enable or disable the native Impeccable post-edit detector for this project.",
    args: { enabled: z.boolean().describe("Whether the hook should be enabled.") },
    async execute({ enabled }) {
      return resultText(await runRuntimeScript(runtime, "hook-admin.mjs", [enabled ? "on" : "off"]))
    },
  })
}

function hooksIgnoreValueTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Add a validated detector suppression for one rule/value combination.",
    args: {
      rule: z.string().describe("Detector rule id."),
      value: z.string().describe("Exact value, or `*` when paired with one or more files."),
      local: z.boolean().optional().describe("Store as a private per-developer exception."),
      reason: z.string().optional().describe("Reason the finding is intentional."),
      files: z.array(z.string()).optional().describe("Optional file globs limiting this suppression."),
    },
    async execute({ rule, value, local, reason, files }) {
      const args = ["ignore-value", rule, value, local ? "--local" : "--shared"]
      if (reason) args.push("--reason", reason)
      for (const file of files ?? []) args.push("--file", file)
      return resultText(await runRuntimeScript(runtime, "hook-admin.mjs", args))
    },
  })
}

function hooksIgnoreRuleTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Add a validated project-wide detector rule suppression.",
    args: {
      rule: z.string().describe("Detector rule id."),
      allValues: z.boolean().optional().describe("Confirm suppression of every parameterized value."),
      reason: z.string().optional().describe("Reason the rule is intentionally suppressed."),
    },
    async execute({ rule, allValues, reason }) {
      const args = ["ignore-rule", rule]
      if (allValues) args.push("--all-values")
      if (reason) args.push("--reason", reason)
      return resultText(await runRuntimeScript(runtime, "hook-admin.mjs", args))
    },
  })
}

function hooksIgnoreFileTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Add a validated whole-file detector suppression for generated or fixture UI files.",
    args: {
      path: z.string().describe("Project-relative file path or glob."),
      reason: z.string().optional().describe("Reason the file is outside design review."),
    },
    async execute({ path, reason }) {
      const args = ["ignore-file", path]
      if (reason) args.push("--reason", reason)
      return resultText(await runRuntimeScript(runtime, "hook-admin.mjs", args))
    },
  })
}

function hooksResetTool(runtime: ImpeccableRuntime) {
  return noArgScriptTool(runtime, "hook-admin.mjs", "Reset Impeccable hook configuration and detector caches.", ["reset"])
}

function ignoresTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "List, add, or remove detector ignores through the bundled Impeccable CLI implementation.",
    args: {
      action: z.enum(["list", "add", "remove"]).describe("Ignore operation."),
      rule: z.string().optional().describe("Rule id for add/remove."),
      value: z.string().optional().describe("Optional value for add/remove."),
      local: z.boolean().optional().describe("Use the private local configuration."),
      reason: z.string().optional().describe("Reason stored with an added suppression."),
    },
    async execute({ action, rule, value, local, reason }) {
      const args = ["ignores", action]
      if (rule) args.push(rule)
      if (value) args.push(value)
      if (local) args.push("--local")
      if (reason) args.push("--reason", reason)
      return resultText(await runImpeccableCli(runtime, args))
    },
  })
}

function conceptSeedTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Run the upstream direction/surface concept assignment and challenger deal.",
    args: {
      scope: z.enum(["surface", "direction"]).describe("Concept decision scope."),
      mode: z.string().optional().describe("Surface mode such as persuade, operate, read, or experience."),
      from: z.string().optional().describe("Seed key from a previous deal."),
      reroll: z.number().int().min(0).optional().describe("Re-roll round number."),
      grain: z.string().optional().describe("Requested composition grain."),
      platform: z.string().optional().describe("Platform context."),
      candidateCount: z.number().int().min(1).max(20).optional().describe("Grounded candidate count."),
      chosen: z.string().optional().describe("Record a chosen challenger id instead of dealing."),
    },
    async execute(args) {
      const argv = ["--scope", args.scope]
      pushFlag(argv, "--mode", args.mode)
      pushFlag(argv, "--from", args.from)
      pushFlag(argv, "--reroll", args.reroll)
      pushFlag(argv, "--grain", args.grain)
      pushFlag(argv, "--platform", args.platform)
      pushFlag(argv, "--candidate-count", args.candidateCount)
      pushFlag(argv, "--chosen", args.chosen)
      return resultText(await runRuntimeScript(runtime, "concept-seed.mjs", argv, { timeoutMs: 30_000 }))
    },
  })
}

function critiqueStorageTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Create slugs and persist or read deterministic Impeccable critique snapshots and trends.",
    args: {
      action: z.enum(["slug", "write", "latest", "trend"]).describe("Storage operation."),
      target: z.string().describe("Target path, URL, or existing slug."),
      bodyFile: z.string().optional().describe("Report body file for write."),
      limit: z.number().int().min(1).max(100).optional().describe("Trend entry limit."),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Optional snapshot frontmatter metadata."),
    },
    async execute({ action, target, bodyFile, limit, metadata }) {
      const args = [action, target]
      if (action === "write") {
        if (!bodyFile) throw new Error("bodyFile is required for critique storage write")
        args.push(bodyFile)
      }
      if (action === "trend" && limit) args.push(String(limit))
      return resultText(await runRuntimeScript(runtime, "critique-storage.mjs", args, {
        allowedExitCodes: action === "latest" ? [0, 2] : [0],
        env: metadata
          ? { ...process.env, IMPECCABLE_CRITIQUE_META: JSON.stringify(metadata) }
          : process.env,
      }))
    },
  })
}

function detectCspTool(runtime: ImpeccableRuntime) {
  return noArgScriptTool(runtime, "detect-csp.mjs", "Detect the project's development CSP configuration shape for live mode.")
}

function embedPromptTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Embed an image-generation prompt in an asset or read a previously embedded prompt.",
    args: {
      image: z.string().describe("Image path."),
      read: z.boolean().optional().describe("Read rather than write prompt metadata."),
      prompt: z.string().optional().describe("Prompt text to embed."),
      promptFile: z.string().optional().describe("File containing the prompt text."),
    },
    async execute({ image, read, prompt, promptFile }) {
      const args = [image]
      if (read) args.push("--read")
      else if (prompt) args.push("--prompt", prompt)
      else if (promptFile) args.push("--prompt-file", promptFile)
      else throw new Error("prompt or promptFile is required unless read is true")
      return resultText(await runRuntimeScript(runtime, "embed-prompt.mjs", args))
    },
  })
}

function generateImageTool(runtime: ImpeccableRuntime) {
  return tool({
    description:
      "Generate an Impeccable concept image through the user's OPENAI_API_KEY when no harness-native image tool is available.",
    args: {
      output: z.string().describe("Output image path."),
      prompt: z.string().optional().describe("Image prompt."),
      promptFile: z.string().optional().describe("File containing the image prompt."),
      size: z.string().optional().describe("Image dimensions, default 1536x1024."),
      quality: z.enum(["low", "medium", "high"]).optional().describe("Generation quality."),
    },
    async execute({ output, prompt, promptFile, size, quality }) {
      const args = ["--out", output]
      if (prompt) args.push("--prompt", prompt)
      else if (promptFile) args.push("--prompt-file", promptFile)
      else throw new Error("prompt or promptFile is required")
      pushFlag(args, "--size", size)
      pushFlag(args, "--quality", quality)
      return resultText(await runRuntimeScript(runtime, "generate-image.mjs", args, { timeoutMs: 300_000 }))
    },
  })
}

function surfaceBriefTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Resolve, list, read, or write Impeccable surface briefs through the bundled runtime.",
    args: {
      action: z.enum(["path", "list", "read", "write"]).describe("Surface brief operation."),
      target: z.string().optional().describe("Primary target path."),
      bodyFile: z.string().optional().describe("Brief body file for write."),
      relatedTargets: z.array(z.string()).optional().describe("Related target paths for write."),
    },
    async execute({ action, target, bodyFile, relatedTargets }) {
      const args: string[] = [action]
      if (target) args.push(target)
      if (action === "write") {
        if (!target || !bodyFile) throw new Error("target and bodyFile are required for surface brief write")
        args.push(bodyFile, ...(relatedTargets ?? []))
      }
      return resultText(await runRuntimeScript(runtime, "surface-brief.mjs", args, {
        allowedExitCodes: action === "read" ? [0, 2] : [0],
      }))
    },
  })
}

function serveQuestionTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Run the visual decision-page helper used by Impeccable new-work flows.",
    args: {
      action: z.enum(["schema", "start", "wait", "stop", "update"]).describe("Question-page operation."),
      payload: z.string().optional().describe("JSON payload file for start/update."),
      key: z.string().optional().describe("Question key for wait/stop/update."),
    },
    async execute({ action, payload, key }) {
      const args = [`--${action}`]
      if (payload) args.push("--payload", payload)
      if (key) args.push("--key", key)
      return resultText(await runRuntimeScript(runtime, "serve-question.mjs", args, {
        timeoutMs: action === "wait" ? 300_000 : 30_000,
        allowedExitCodes: action === "wait" ? [0, 3, 4] : action === "start" ? [0, 2] : [0],
      }))
    },
  })
}

function liveTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Prepare bundled Impeccable live variant mode and return its project/server context.",
    args: { target: z.string().optional().describe("Optional monorepo child app or source target.") },
    async execute({ target }) {
      return resultText(await runRuntimeScript(runtime, "live.mjs", target ? ["--target", target] : [], { timeoutMs: 60_000 }))
    },
  })
}

function liveServerTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Start or stop the bundled Impeccable live-mode helper server.",
    args: {
      action: z.enum(["start", "stop"]).optional().describe("Defaults to start."),
      background: z.boolean().optional().describe("Start detached and return connection JSON."),
      port: z.number().int().min(1).max(65535).optional().describe("Preferred server port."),
      keepInject: z.boolean().optional().describe("On stop, keep the injected browser script."),
    },
    async execute({ action, background, port, keepInject }) {
      const args = []
      if (action === "stop") args.push("stop")
      if (background) args.push("--background")
      if (port) args.push(`--port=${port}`)
      if (keepInject) args.push("--keep-inject")
      return resultText(await runRuntimeScript(runtime, "live-server.mjs", args, {
        timeoutMs: background || action === "stop" ? 30_000 : 24 * 60 * 60 * 1000,
      }))
    },
  })
}

function livePollTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Poll the Impeccable live server for an event or reply to a leased event.",
    args: {
      eventId: z.string().optional().describe("Event id when replying."),
      reply: z.enum(["done", "steer_done", "error"]).optional().describe("Reply status."),
      message: z.string().optional().describe("Optional error or toast message."),
      file: z.string().optional().describe("Source file attached to the reply."),
      data: z.record(z.string(), z.unknown()).optional().describe("Structured manual-edit result."),
      types: z.array(z.string()).optional().describe("Event types to lease."),
      timeoutMs: z.number().int().min(1).optional().describe("One-shot poll timeout."),
    },
    async execute({ eventId, reply, message, file, data, types, timeoutMs }) {
      const args = []
      if (reply) {
        if (!eventId) throw new Error("eventId is required for a live poll reply")
        args.push("--reply", eventId, reply)
        if (message) args.push(message)
      }
      if (file) args.push("--file", file)
      if (data) args.push("--data", JSON.stringify(data))
      if (types?.length) args.push(`--types=${types.join(",")}`)
      if (timeoutMs) args.push(`--timeout=${timeoutMs}`)
      return resultText(await runRuntimeScript(runtime, "live-poll.mjs", args, {
        timeoutMs: reply ? 30_000 : (timeoutMs ?? 600_000) + 10_000,
      }))
    },
  })
}

function liveStatusTool(runtime: ImpeccableRuntime) {
  return noArgScriptTool(runtime, "live-status.mjs", "Show durable Impeccable live server and session state.")
}

function liveResumeTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Read a durable Impeccable live session checkpoint and its next safe action.",
    args: { id: z.string().optional().describe("Optional session id.") },
    async execute({ id }) {
      return resultText(await runRuntimeScript(runtime, "live-resume.mjs", id ? ["--id", id] : []))
    },
  })
}

function liveCompleteTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Append the final durable acknowledgement for a cleaned-up Impeccable live session.",
    args: {
      id: z.string().describe("Session id."),
      discarded: z.boolean().optional().describe("Mark a discard completion."),
      error: z.string().optional().describe("Record a terminal error."),
      force: z.boolean().optional().describe("Override leftover-source checks only for a confirmed false positive."),
    },
    async execute({ id, discarded, error, force }) {
      const args = ["--id", id]
      if (discarded) args.push("--discarded")
      if (error) args.push("--error", error)
      if (force) args.push("--force")
      return resultText(await runRuntimeScript(runtime, "live-complete.mjs", args))
    },
  })
}

function liveInsertTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Insert an Impeccable live variant wrapper before or after a source element.",
    args: {
      id: z.string().describe("Event/session id."),
      count: z.number().int().min(1).max(8).describe("Variant count."),
      position: z.enum(["before", "after"]).describe("Insertion position."),
      file: z.string().optional(),
      elementId: z.string().optional(),
      classes: z.array(z.string()).optional(),
      tag: z.string().optional(),
      query: z.string().optional(),
      text: z.string().optional(),
    },
    async execute(args) {
      const argv = ["--id", args.id, "--count", String(args.count), "--position", args.position]
      addElementSelectorArgs(argv, args)
      return resultText(await runRuntimeScript(runtime, "live-insert.mjs", argv))
    },
  })
}

function liveWrapTool(runtime: ImpeccableRuntime) {
  return tool({
    description: "Wrap a source element in an Impeccable live variant container.",
    args: {
      id: z.string().describe("Event/session id."),
      count: z.number().int().min(1).max(8).describe("Variant count."),
      file: z.string().optional(),
      elementId: z.string().optional(),
      classes: z.array(z.string()).optional(),
      tag: z.string().optional(),
      query: z.string().optional(),
      text: z.string().optional(),
      pageUrl: z.string().optional(),
    },
    async execute(args) {
      const argv = ["--id", args.id, "--count", String(args.count)]
      addElementSelectorArgs(argv, args)
      pushFlag(argv, "--page-url", args.pageUrl)
      return resultText(await runRuntimeScript(runtime, "live-wrap.mjs", argv))
    },
  })
}

function noArgScriptTool(
  runtime: ImpeccableRuntime,
  script: string,
  description: string,
  args: string[] = [],
) {
  return tool({
    description,
    args: {},
    async execute() {
      return resultText(await runRuntimeScript(runtime, script, args))
    },
  })
}

function pushFlag(args: string[], flag: string, value: unknown) {
  if (value !== undefined && value !== null && value !== "") args.push(flag, String(value))
}

function addElementSelectorArgs(
  argv: string[],
  args: {
    file?: string
    elementId?: string
    classes?: string[]
    tag?: string
    query?: string
    text?: string
  },
) {
  pushFlag(argv, "--file", args.file)
  pushFlag(argv, "--element-id", args.elementId)
  if (args.classes?.length) argv.push("--classes", args.classes.join(","))
  pushFlag(argv, "--tag", args.tag)
  pushFlag(argv, "--query", args.query)
  pushFlag(argv, "--text", args.text)
}

function markNativeHookActive(output: string): string {
  const replacement = [
    "AUTOMATIC_DETECTOR_ACTIVE: The native OpenCode plugin runs the full bundled detector after each eligible edit and injects findings into that edit's tool output. Do not schedule an additional detector pass unless the hook reports a failure.",
    "",
  ].join("\n")
  return output.replace(
    /MANUAL_DETECTOR_REQUIRED:[\s\S]*?(?=\n\n---\n|$)/,
    replacement.trimEnd(),
  )
}

export function availableReferenceNames(refsDirAbs: string): string[] {
  return readdirSync(resolve(refsDirAbs))
    .filter((name) => name.endsWith(".md"))
    .map((name) => basename(name, ".md"))
    .sort()
}

export function adaptReferenceText(body: string): string {
  return body
    .replaceAll("Bash(npx impeccable *)", "impeccable_* typed tools")
    .replaceAll("Bash(node {{scripts_path}}/*)", "impeccable_* typed tools")
    .replace(
      /node \{\{scripts_path\}\}\/([a-z0-9-]+)\.mjs/g,
      (_match, name: string) => `impeccable_${name.replaceAll("-", "_")}`,
    )
    .replaceAll("npx impeccable detect", "impeccable_detect")
    .replaceAll("npx impeccable ignores", "impeccable_ignores")
    .replaceAll(
      "npx impeccable update",
      "update the @auron-labs/opencode-impeccable plugin through OpenCode",
    )
    .replaceAll("{{command_prefix}}", "/")
}
