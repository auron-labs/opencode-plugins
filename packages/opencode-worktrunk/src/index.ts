import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tool } from "@opencode-ai/plugin"
import { info, warn } from "./logger.js"
// plugin format: { id, server } direct object export

const execFileAsync = promisify(execFile)
const z = tool.schema

// Types

type PluginOptions = {
  binary?: string
  timeoutMs?: number
  defaultCwd?: string
  autoYes?: boolean
}

type RunOptions = {
  cwd?: string
  timeoutMs?: number
  yes?: boolean
}

type StepSubcommand =
  | "commit"
  | "squash"
  | "rebase"
  | "push"
  | "diff"
  | "copy-ignored"
  | "eval"
  | "for-each"
  | "promote"
  | "prune"
  | "relocate"
  | "tether"

// Module state

const id = "opencode-worktrunk"
const DEFAULT_BINARY = "wt"
const DEFAULT_TIMEOUT_MS = 120_000
const STEP_SUBCOMMANDS: readonly StepSubcommand[] = [
  "commit",
  "squash",
  "rebase",
  "push",
  "diff",
  "copy-ignored",
  "eval",
  "for-each",
  "promote",
  "prune",
  "relocate",
  "tether",
]
// Step subcommands that document `--format=json` structured output.
const STEP_JSON_SUBCOMMANDS: ReadonlySet<StepSubcommand> = new Set(["commit", "squash"])

let binary = DEFAULT_BINARY
let timeoutMs = DEFAULT_TIMEOUT_MS
let defaultCwd: string | undefined
let autoYes = true
let initialized = false

// wt helpers

async function execWt(args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const cwd = opts.cwd || defaultCwd
  const timeout = opts.timeoutMs ?? timeoutMs
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (error: unknown) {
    const err = error as {
      code?: string
      stderr?: string
      stdout?: string
      message?: string
      signal?: string
      killed?: boolean
    }
    if (err.code === "ENOENT") {
      throw new Error(`worktrunk binary not found at '${binary}'`)
    }
    if (err.killed && err.signal === "SIGTERM") {
      throw new Error(`worktrunk command timed out after ${timeout}ms`)
    }
    const stderrText = (err.stderr || "").trim()
    const stdoutText = (err.stdout || "").trim()
    const detail = stderrText || stdoutText || err.message || "worktrunk command failed"
    throw new Error(detail)
  }
}

function maybeYes(args: string[], opts: RunOptions): void {
  const wantYes = opts.yes ?? autoYes
  if (wantYes) args.push("-y")
}

function tryParseJson(text: string): { json: unknown; raw: string; parsed: boolean } {
  const trimmed = text.trim()
  if (!trimmed) return { json: null, raw: text, parsed: false }
  try {
    return { json: JSON.parse(trimmed), raw: text, parsed: true }
  } catch {
    return { json: null, raw: text, parsed: false }
  }
}

// Run `wt <args>` with `--format=json` appended and return parsed JSON when
// possible. Falls back to the raw stdout string when the output is not JSON.
async function runWtJson(baseArgs: string[], opts: RunOptions = {}): Promise<string> {
  const args = [...baseArgs, "--format", "json"]
  const { stdout } = await execWt(args, opts)
  const { json, raw, parsed } = tryParseJson(stdout)
  if (!parsed) return raw
  return JSON.stringify(json, null, 2)
}

// Run `wt <args>` and return raw stdout (used for passthrough / non-JSON cmds).
async function runWtRaw(baseArgs: string[], opts: RunOptions = {}): Promise<string> {
  const { stdout } = await execWt(baseArgs, opts)
  return stdout
}

// Init

async function ensureInit(options?: PluginOptions): Promise<void> {
  if (initialized) {
    // Allow live re-configuration on subsequent plugin loads.
    if (options) applyOptions(options)
    return
  }
  applyOptions(options)
  initialized = true
  info("init", "Worktrunk plugin initialized", {
    binary,
    timeoutMs,
    hasDefaultCwd: Boolean(defaultCwd),
    autoYes,
  })
}

function applyOptions(options?: PluginOptions): void {
  if (!options) return
  if (options.binary) binary = options.binary
  if (options.timeoutMs) timeoutMs = options.timeoutMs
  if (options.defaultCwd) defaultCwd = options.defaultCwd
  if (options.autoYes !== undefined) autoYes = options.autoYes
}

// Tools

const worktrunkList = tool({
  description:
    "List git worktrees and their status via `wt list --format=json`. Returns parsed JSON (schema 1 or 2) or raw text if JSON is unavailable.",
  args: {
    full: z.boolean().optional().describe("Include CI status and LLM summaries (reaches off-machine)"),
    branches: z.boolean().optional().describe("Include local branches that have no worktree"),
    remotes: z.boolean().optional().describe("Include remote branches"),
    prs: z.boolean().optional().describe("Include open PRs/MRs"),
    cwd: z.string().optional().describe("Working directory for `wt` (defaults to the session directory)"),
    yes: z.boolean().optional().describe("Pass -y to skip approval prompts (default: true)"),
  },
  async execute(args) {
    await ensureInit()
    const wtArgs = ["list"]
    maybeYes(wtArgs, args)
    if (args.full) wtArgs.push("--full")
    if (args.branches) wtArgs.push("--branches")
    if (args.remotes) wtArgs.push("--remotes")
    if (args.prs) wtArgs.push("--prs")
    info("list", "Listed worktrees", { full: args.full === true, branches: args.branches === true })
    return await runWtJson(wtArgs, args)
  },
})

const worktrunkSwitch = tool({
  description:
    "Switch to a worktree (and create it if missing) via `wt switch --format=json`. Creates a new branch with `create`. Defaults to `--no-cd` because the tool process cannot change the agent's working directory; the worktree path is returned in the JSON so the agent can `cd` itself.",
  args: {
    branch: z
      .string()
      .optional()
      .describe("Branch name, shortcut (^, @, -), or pr:N / mr:N / PR URL. Omit only with an interactive picker (not useful from a tool)."),
    create: z.boolean().optional().describe("Create a new branch (like --create)"),
    base: z.string().optional().describe("Base branch for --create (supports the same shortcuts as branch)"),
    noCd: z.boolean().optional().describe("Skip directory change after switching (default: true)"),
    clobber: z.boolean().optional().describe("Remove stale paths at the target worktree location"),
    noHooks: z.boolean().optional().describe("Skip hooks"),
    cwd: z.string().optional().describe("Working directory for `wt` (defaults to the session directory)"),
    yes: z.boolean().optional().describe("Pass -y to skip approval prompts (default: true)"),
  },
  async execute(args) {
    await ensureInit()
    const wtArgs = ["switch"]
    if (args.noCd !== false) wtArgs.push("--no-cd")
    maybeYes(wtArgs, args)
    if (args.create) wtArgs.push("--create")
    if (args.base) wtArgs.push("--base", args.base)
    if (args.clobber) wtArgs.push("--clobber")
    if (args.noHooks) wtArgs.push("--no-hooks")
    if (args.branch) wtArgs.push(args.branch)
    info("switch", "Switched/created worktree", {
      branch: args.branch,
      create: args.create === true,
      hasBase: Boolean(args.base),
    })
    return await runWtJson(wtArgs, args)
  },
})

const worktrunkRemove = tool({
  description:
    "Remove worktree(s) and delete merged branches via `wt remove --format=json`. Defaults to the current worktree when no branches are given.",
  args: {
    branches: z
      .array(z.string())
      .optional()
      .describe("Branch names or worktree paths to remove (defaults to current worktree)"),
    noDeleteBranch: z.boolean().optional().describe("Keep the branch after removing the worktree"),
    forceDelete: z.boolean().optional().describe("Delete unmerged branches (-D)"),
    force: z.boolean().optional().describe("Force-remove a dirty worktree (-f)"),
    foreground: z.boolean().optional().describe("Run removal in the foreground (block until complete)"),
    reap: z.boolean().optional().describe("Kill processes started in the worktree before removal (Unix only)"),
    noHooks: z.boolean().optional().describe("Skip hooks"),
    cwd: z.string().optional().describe("Working directory for `wt` (defaults to the session directory)"),
    yes: z.boolean().optional().describe("Pass -y to skip approval prompts (default: true)"),
  },
  async execute(args) {
    await ensureInit()
    const wtArgs = ["remove"]
    maybeYes(wtArgs, args)
    if (args.noDeleteBranch) wtArgs.push("--no-delete-branch")
    if (args.forceDelete) wtArgs.push("-D")
    if (args.force) wtArgs.push("--force")
    if (args.foreground) wtArgs.push("--foreground")
    if (args.reap) wtArgs.push("--reap")
    if (args.noHooks) wtArgs.push("--no-hooks")
    if (args.branches && args.branches.length) wtArgs.push(...args.branches)
    info("remove", "Removed worktree(s)", { count: args.branches?.length ?? 0 })
    return await runWtJson(wtArgs, args)
  },
})

const worktrunkMerge = tool({
  description:
    "Merge the current branch into a target branch via `wt merge --format=json`. Squashes, rebases, fast-forwards the target, and removes the worktree by default.",
  args: {
    target: z.string().optional().describe("Target branch (defaults to the default branch)"),
    noSquash: z.boolean().optional().describe("Skip commit squashing"),
    noCommit: z.boolean().optional().describe("Skip commit and squash (rebase still runs unless noRebase)"),
    noRebase: z.boolean().optional().describe("Skip rebase; require the target to fast-forward to the tip"),
    noRemove: z.boolean().optional().describe("Keep the worktree after merging"),
    noFF: z.boolean().optional().describe("Create a merge commit instead of fast-forwarding"),
    stage: z.enum(["all", "tracked", "none"]).optional().describe("What to stage before committing (default: all)"),
    noHooks: z.boolean().optional().describe("Skip hooks"),
    cwd: z.string().optional().describe("Working directory for `wt` (defaults to the session directory)"),
    yes: z.boolean().optional().describe("Pass -y to skip approval prompts (default: true)"),
  },
  async execute(args) {
    await ensureInit()
    const wtArgs = ["merge"]
    maybeYes(wtArgs, args)
    if (args.noSquash) wtArgs.push("--no-squash")
    if (args.noCommit) wtArgs.push("--no-commit")
    if (args.noRebase) wtArgs.push("--no-rebase")
    if (args.noRemove) wtArgs.push("--no-remove")
    if (args.noFF) wtArgs.push("--no-ff")
    if (args.stage) wtArgs.push("--stage", args.stage)
    if (args.noHooks) wtArgs.push("--no-hooks")
    if (args.target) wtArgs.push(args.target)
    info("merge", "Merged branch", { target: args.target, noSquash: args.noSquash === true })
    return await runWtJson(wtArgs, args)
  },
})

const worktrunkStep = tool({
  description:
    "Run a `wt step` subcommand (commit, squash, rebase, push, diff, copy-ignored, eval, for-each, promote, prune, relocate, tether). commit and squash return parsed JSON; others return raw text.",
  args: {
    subcommand: z.enum(STEP_SUBCOMMANDS as [StepSubcommand, ...StepSubcommand[]]).describe("wt step subcommand to run"),
    branch: z.string().optional().describe("Branch to operate on (defaults to current worktree)"),
    stage: z.enum(["all", "tracked", "none"]).optional().describe("What to stage (commit/squash; default: all)"),
    dryRun: z.boolean().optional().describe("Preview without committing/squashing (commit/squash)"),
    noHooks: z.boolean().optional().describe("Skip hooks"),
    args: z
      .array(z.string())
      .optional()
      .describe("Extra arguments appended to the subcommand (e.g. for-each command, rebase target)"),
    json: z
      .boolean()
      .optional()
      .describe("Request --format=json and parse it. Defaults to true for commit/squash, false otherwise."),
    cwd: z.string().optional().describe("Working directory for `wt` (defaults to the session directory)"),
    yes: z.boolean().optional().describe("Pass -y to skip approval prompts (default: true)"),
  },
  async execute(args) {
    await ensureInit()
    const wantJson = args.json ?? STEP_JSON_SUBCOMMANDS.has(args.subcommand)
    const wtArgs = ["step", args.subcommand]
    if (args.branch) wtArgs.push("--branch", args.branch)
    if (args.stage) wtArgs.push("--stage", args.stage)
    if (args.dryRun) wtArgs.push("--dry-run")
    if (args.noHooks) wtArgs.push("--no-hooks")
    if (args.args && args.args.length) wtArgs.push(...args.args)
    maybeYes(wtArgs, args)
    info("step", "Ran wt step", { subcommand: args.subcommand, json: wantJson })
    // runWtJson appends --format=json itself; avoid duplicating it here.
    if (wantJson) return await runWtJson(wtArgs, { cwd: args.cwd })
    return await runWtRaw(wtArgs, { cwd: args.cwd })
  },
})

const worktrunkRun = tool({
  description:
    "Escape hatch: run an arbitrary `wt` command and return its stdout. Use for `wt config`, `wt hook`, aliases, `wt list statusline`, and anything else not covered by a dedicated tool. Does not auto-add -y; include it in `args` if needed.",
  args: {
    args: z.array(z.string()).min(1).describe("Arguments to pass to `wt` (e.g. [\"config\", \"state\", \"marker\", \"clear\"])"),
    cwd: z.string().optional().describe("Working directory for `wt` (defaults to the session directory)"),
    timeoutMs: z.number().int().positive().optional().describe("Per-call timeout in ms (overrides plugin default)"),
  },
  async execute(args) {
    await ensureInit()
    info("run", "Ran raw wt command", { args: args.args })
    try {
      return await runWtRaw(args.args, { cwd: args.cwd, timeoutMs: args.timeoutMs })
    } catch (error) {
      warn("run_failed", "Raw wt command failed", {
        args: args.args,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },
})

// Plugin entry

export const WorktrunkPlugin = async (
  _input: { directory: string },
  options?: PluginOptions,
) => {
  await ensureInit(options)

  return {
    tool: {
      worktrunk_list: worktrunkList,
      worktrunk_switch: worktrunkSwitch,
      worktrunk_remove: worktrunkRemove,
      worktrunk_merge: worktrunkMerge,
      worktrunk_step: worktrunkStep,
      worktrunk_run: worktrunkRun,
    },
  }
}

export default { id, server: WorktrunkPlugin }
