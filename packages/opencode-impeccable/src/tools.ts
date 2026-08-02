import { existsSync } from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { runEngine, type EngineResult } from "./engine.js"
import {
  appendIgnoreFile,
  appendIgnoreRule,
  appendIgnoreValue,
  loadConfig,
  loadLocalConfig,
  resetHookConfig,
  resolveHook,
  setHookEnabled,
  type DetectorExtensions,
  type IgnoredRule,
  type IgnoredValue,
} from "./config.js"
import { impeccableDir } from "./paths.js"

const z = tool.schema

export type ImperfectableRuntime = {
  binary: string
  directory: string
  refsDirAbs: string
  worktree: string
  isNativePlatform: (platform: string) => boolean
}

const TIER1_EXTENSIONS = new Set([
  ".tsx",
  ".jsx",
  ".html",
  ".vue",
  ".svelte",
  ".astro",
  ".css",
  ".scss",
  ".sass",
  ".less",
])
const QUIET_EXTENSIONS = new Set([".ts", ".js"])
const DETECTOR_SCAN_EXTENSIONS = new Set([
  ...TIER1_EXTENSIONS,
  ...QUIET_EXTENSIONS,
])
const URL_PATTERN = /^https?:\/\//i

export function buildTools(runtime: ImperfectableRuntime) {
  return {
    impeccable_context: contextTool(runtime),
    impeccable_detect: detectTool(runtime),
    impeccable_doctor: doctorTool(runtime),
    impeccable_install: installTool(runtime),
    impeccable_update: updateTool(runtime),
    impeccable_check: checkTool(runtime),
    impeccable_pin: pinTool(runtime),
    impeccable_hooks_status: hooksStatusTool(runtime),
    impeccable_hooks_toggle: hooksToggleTool(runtime),
    impeccable_hooks_ignore_value: hooksIgnoreValueTool(runtime),
    impeccable_hooks_ignore_rule: hooksIgnoreRuleTool(runtime),
    impeccable_hooks_ignore_file: hooksIgnoreFileTool(runtime),
    impeccable_hooks_reset: hooksResetTool(runtime),
    impeccable_ignores: ignoresTool(runtime),
  }
}

function formatResult(result: EngineResult): string {
  if (result.ok) {
    return result.stdout.trim() || "(no output)"
  }
  const stderr = result.stderr.trim()
  const stdout = result.stdout.trim()
  const lines = ["impeccable command failed"]
  if (stderr) lines.push(`stderr:\n${stderr}`)
  if (stdout) lines.push(`stdout:\n${stdout}`)
  lines.push(`exit: ${result.code ?? "unknown"}`)
  return lines.join("\n")
}

function contextTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Load Impeccable context (PRODUCT.md, DESIGN.md, surface brief, native platform guidance) for the active project. Call once per session before invoking any /impeccable command.",
    args: {
      target: z
        .string()
        .optional()
        .describe("Optional named source file or route to scope the context load."),
    },
    async execute({ target }) {
      const args = ["context"]
      if (target) args.push("--target", target)
      const result = await runEngine(runtime.binary, {
        cwd: runtime.worktree,
        args,
        timeoutMs: 30_000,
      })
      return formatResult(result)
    },
  })
}

function detectTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Run the 59 deterministic Impeccable detector rules on the given files, directories, or URLs. No LLM, no API key; reads HTML/CSS/JS for design anti-patterns.",
    args: {
      targets: z
        .array(z.string())
        .min(1)
        .describe("Files, directories, or URLs to scan."),
      noConfig: z
        .boolean()
        .optional()
        .describe("Skip project .impeccable/config.json ignores."),
      jsonOutput: z
        .boolean()
        .optional()
        .describe("Emit JSON output instead of human-readable findings."),
    },
    async execute({ targets, noConfig, jsonOutput }) {
      const args = ["detect", ...targets]
      if (noConfig) args.push("--no-config")
      if (jsonOutput) args.push("--json")
      const result = await runEngine(runtime.binary, {
        cwd: runtime.worktree,
        args,
        timeoutMs: 60_000,
        json: jsonOutput,
      })
      return formatResult(result)
    },
  })
}

function doctorTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Report (and optionally repair) drift between this project's Impeccable artifacts and the installed version.",
    args: {
      fix: z
        .boolean()
        .optional()
        .describe("Apply safe auto-repair fixes for findings marked `auto`."),
      target: z
        .string()
        .optional()
        .describe("Named workspace, file, or route to scope the doctor pass."),
    },
    async execute({ fix, target }) {
      const args = ["doctor"]
      if (fix) args.push("--fix")
      if (target) args.push("--target", target)
      const result = await runEngine(runtime.binary, {
        cwd: runtime.worktree,
        args,
        timeoutMs: 30_000,
      })
      return formatResult(result)
    },
  })
}

function installTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Install the bundled impeccable CLI and skill files for the active project (or globally). Defaults to project scope with the opencode provider.",
    args: {
      scope: z
        .enum(["project", "global"])
        .optional()
        .describe("Install scope. Defaults to `project`."),
      force: z
        .boolean()
        .optional()
        .describe("Overwrite existing skill files even if directories are non-empty."),
    },
    async execute({ scope, force }) {
      const args = ["install", "--providers=opencode"]
      args.push(`--scope=${scope ?? "project"}`)
      if (force) args.push("--force")
      const result = await runEngine(runtime.binary, {
        cwd: runtime.worktree,
        args,
        timeoutMs: 60_000,
      })
      return formatResult(result)
    },
  })
}

function updateTool(runtime: ImperfectableRuntime) {
  return tool({
    description: "Refresh an existing Impeccable install to the latest version.",
    args: {},
    async execute() {
      const result = await runEngine(runtime.binary, {
        cwd: runtime.worktree,
        args: ["update"],
        timeoutMs: 60_000,
      })
      return formatResult(result)
    },
  })
}

function checkTool(runtime: ImperfectableRuntime) {
  return tool({
    description: "Check whether a newer Impeccable version is available.",
    args: {},
    async execute() {
      const result = await runEngine(runtime.binary, {
        cwd: runtime.worktree,
        args: ["check"],
        timeoutMs: 15_000,
      })
      return formatResult(result)
    },
  })
}

function pinTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Create or remove a standalone /<command> shortcut for an Impeccable sub-command (e.g. `pin audit` creates `/audit`).",
    args: {
      command: z
        .string()
        .min(1)
        .describe("Impeccable sub-command to pin or unpin."),
      remove: z
        .boolean()
        .optional()
        .describe("Remove an existing pin instead of creating one."),
    },
    async execute({ command, remove }) {
      const verb = remove ? "unpin" : "pin"
      const result = await runEngine(runtime.binary, {
        cwd: runtime.worktree,
        args: [verb, command],
        timeoutMs: 15_000,
      })
      return formatResult(result)
    },
  })
}

function hooksStatusTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Show the current state of the Impeccable detector hook (enabled, quiet, ignores, config paths, env overrides).",
    args: {},
    async execute() {
      const resolved = resolveHook(runtime.directory)
      const shared = loadConfig(runtime.directory)
      const local = loadLocalConfig(runtime.directory)
      return JSON.stringify(
        {
          hook: resolved,
          sharedConfigPath: `${impeccableDir(runtime.directory)}/config.json`,
          localConfigPath: `${impeccableDir(runtime.directory)}/config.local.json`,
          envOverrides: {
            IMPECCABLE_HOOK_DISABLED: process.env.IMPECCABLE_HOOK_DISABLED ?? null,
            IMPECCABLE_HOOK_QUIET: process.env.IMPECCABLE_HOOK_QUIET ?? null,
            IMPECCABLE_HOOK_LOG: process.env.IMPECCABLE_HOOK_LOG ?? null,
          },
          shared,
          local,
        },
        null,
        2,
      )
    },
  })
}

function hooksToggleTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Enable or disable the Impeccable detector hook for this project. Writes `hook.enabled` to .impeccable/config.json and records per-developer consent in the gitignored config.local.json.",
    args: {
      enabled: z
        .boolean()
        .describe("New value for `hook.enabled` (true = on, false = off)."),
    },
    async execute({ enabled }) {
      const resolved = setHookEnabled(runtime.directory, enabled)
      return JSON.stringify({ ok: true, hook: resolved }, null, 2)
    },
  })
}

function hooksIgnoreValueTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Suppress one detector rule+value combination across the project (default), scoped to specific files, or as a per-developer private exception.",
    args: {
      rule: z.string().describe("Detector rule id (e.g. `overused-font`)."),
      value: z
        .string()
        .describe("Specific value to suppress (e.g. `Inter`). Use `*` for whole-file scoping."),
      scope: z
        .enum(["shared", "local"])
        .optional()
        .describe("Where to write the suppression. Defaults to `shared`."),
      reason: z.string().optional().describe("Why the suppression is intentional."),
      files: z
        .array(z.string())
        .optional()
        .describe("Restrict the suppression to matching files (overrides project-wide)."),
    },
    async execute({ rule, value, scope, reason, files }) {
      const entry: IgnoredValue = { rule, value }
      if (reason) entry.reason = reason
      if (files?.length) entry.files = files
      const resolved = appendIgnoreValue(runtime.directory, entry, scope ?? "shared")
      return JSON.stringify({ ok: true, hook: resolved }, null, 2)
    },
  })
}

function hooksIgnoreRuleTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Suppress a whole detector rule across the project (e.g. ignore every overused-font finding).",
    args: {
      rule: z.string().describe("Detector rule id (e.g. `bounce-easing`)."),
      allValues: z
        .boolean()
        .optional()
        .describe("Required when ignoring every possible value of a parameterized rule (e.g. `overused-font`)."),
      reason: z.string().optional().describe("Why the suppression is intentional."),
    },
    async execute({ rule, allValues, reason }) {
      const entry: IgnoredRule = { rule }
      if (allValues) entry.allValues = true
      if (reason) entry.reason = reason
      const resolved = appendIgnoreRule(runtime.directory, entry)
      return JSON.stringify({ ok: true, hook: resolved }, null, 2)
    },
  })
}

function hooksIgnoreFileTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "Suppress every detector rule for one file (use sparingly, e.g. for fixtures or generated artifacts).",
    args: {
      path: z.string().describe("Repo-relative or absolute file path to ignore."),
    },
    async execute({ path }) {
      const resolved = appendIgnoreFile(runtime.directory, { path })
      return JSON.stringify({ ok: true, hook: resolved }, null, 2)
    },
  })
}

function hooksResetTool(runtime: ImperfectableRuntime) {
  return tool({
    description: "Reset .impeccable/config.json and .impeccable/config.local.json to empty objects.",
    args: {},
    async execute() {
      resetHookConfig(runtime.directory)
      return JSON.stringify({ ok: true, hook: resolveHook(runtime.directory) }, null, 2)
    },
  })
}

function ignoresTool(runtime: ImperfectableRuntime) {
  return tool({
    description:
      "List, add, or remove detector ignore rules and values via the bundled `impeccable ignores` admin script.",
    args: {
      action: z.enum(["list", "add", "remove"]).describe("Which ignore action to run."),
      rule: z.string().optional().describe("Rule id (required for add/remove)."),
      value: z.string().optional().describe("Value to suppress (for `add` or `remove`)."),
      local: z
        .boolean()
        .optional()
        .describe("Use the gitignored .impeccable/config.local.json instead of the shared config."),
      reason: z.string().optional().describe("Reason stored with the suppression."),
    },
    async execute({ action, rule, value, local, reason }) {
      const args = ["ignores", action]
      if (rule) args.push(rule)
      if (value) args.push(value)
      if (local) args.push("--local")
      if (reason) args.push("--reason", reason)
      const result = await runEngine(runtime.binary, {
        cwd: runtime.worktree,
        args,
        timeoutMs: 15_000,
      })
      return formatResult(result)
    },
  })
}

export const DETECTOR_SCAN_SET = DETECTOR_SCAN_EXTENSIONS
export const TIER1_SCAN_SET = TIER1_EXTENSIONS
export const QUIET_SCAN_SET = QUIET_EXTENSIONS

export function isDetectorCandidate(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return false
  const ext = path.slice(dot).toLowerCase()
  return DETECTOR_SCAN_EXTENSIONS.has(ext)
}

export function isTier1Candidate(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return false
  const ext = path.slice(dot).toLowerCase()
  return TIER1_EXTENSIONS.has(ext)
}

export function isQuietCandidate(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return false
  const ext = path.slice(dot).toLowerCase()
  return QUIET_EXTENSIONS.has(ext)
}

// ponytail: this is what the watcher and per-edit hook reach into

export function runDetectorOnPaths(runtime: ImperfectableRuntime, paths: string[]): Promise<EngineResult> {
  if (paths.length === 0) {
    return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "", parsed: null })
  }
  const inputs = paths.filter((path) => !URL_PATTERN.test(path) && existsSync(path))
  if (inputs.length === 0) {
    return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "", parsed: null })
  }
  return runEngine(runtime.binary, {
    cwd: runtime.worktree,
    args: ["detect", "--json", ...inputs],
    timeoutMs: 60_000,
    json: true,
  })
}

export function detectorExtensionsFor(runtime: ImperfectableRuntime): DetectorExtensions {
  return resolveHook(runtime.directory).extensions
}
