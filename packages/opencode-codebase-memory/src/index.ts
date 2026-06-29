import { execFile, spawn } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { tool } from "@opencode-ai/plugin"
import { info, warn } from "./logger.js"
// plugin format: { id, server } direct object export

const execFileAsync = promisify(execFile)
const z = tool.schema

const id = "opencode-codebase-memory"

type PluginOptions = {
  binary?: string
  autoIndex?: boolean
  autoIndexLimit?: number
  indexOnStartup?: boolean
  indexMode?: "full" | "moderate" | "fast"
  enabled?: boolean
}

type PluginContext = {
  client?: Client
  directory: string
}

type Client = {
  tui?: {
    showToast(args: { body: { message: string; variant: string } }): Promise<void>
  }
}

type McpConfigEntry = {
  type: "local"
  command: string[]
  enabled: boolean
}

type ConfigShape = {
  mcp?: Record<string, McpConfigEntry>
}

type ProjectRecord = {
  name?: unknown
  root_path?: unknown
}

type ProjectListResult = {
  projects?: ProjectRecord[]
}

type ProjectState = {
  rootPath: string
  project: string | null
  indexed: boolean
  status: "idle" | "indexing" | "ready" | "failed"
  error?: string
}

const indexing = new Set<string>()
const startupAttempted = new Set<string>()
const stateByRoot = new Map<string, ProjectState>()

function normalizeOptions(options?: PluginOptions): Required<PluginOptions> {
  return {
    binary: options?.binary?.trim() || "codebase-memory-mcp",
    autoIndex: options?.autoIndex ?? true,
    autoIndexLimit: options?.autoIndexLimit ?? 0,
    indexOnStartup: options?.indexOnStartup ?? true,
    indexMode: options?.indexMode ?? "full",
    enabled: options?.enabled ?? true,
  }
}

function stateFor(rootPath: string): ProjectState {
  const existing = stateByRoot.get(rootPath)
  if (existing) return existing
  const created: ProjectState = {
    rootPath,
    project: null,
    indexed: false,
    status: "idle",
  }
  stateByRoot.set(rootPath, created)
  return created
}

async function showToast(client: Client | undefined, message: string, variant: string) {
  try {
    await client?.tui?.showToast({ body: { message, variant } })
  } catch {}
}

async function execCli(binary: string, directory: string, args: string[], timeout = 30_000) {
  return await execFileAsync(binary, args, {
    cwd: directory,
    env: process.env,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  })
}

function parseCliJson<T>(stdout: string): T | null {
  try {
    const envelope = JSON.parse(stdout) as {
      content?: Array<{ text?: unknown }>
    }
    const text = envelope.content?.[0]?.text
    if (typeof text !== "string") return null
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function configureUpstream(binary: string, directory: string, options: Required<PluginOptions>) {
  if (options.autoIndex) {
    try {
      await execCli(binary, directory, ["config", "set", "auto_index", "true"])
    } catch (error) {
      warn("configure_auto_index_failed", "Failed to enable upstream auto_index", {
        directory,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (options.autoIndexLimit > 0) {
    try {
      await execCli(binary, directory, [
        "config",
        "set",
        "auto_index_limit",
        String(options.autoIndexLimit),
      ])
    } catch (error) {
      warn("configure_auto_index_limit_failed", "Failed to set upstream auto_index_limit", {
        directory,
        autoIndexLimit: options.autoIndexLimit,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

async function listProjects(binary: string, directory: string): Promise<ProjectListResult> {
  const { stdout } = await execCli(binary, directory, ["cli", "--json", "list_projects"])
  return parseCliJson<ProjectListResult>(stdout) || { projects: [] }
}

function updateStateFromProjects(rootPath: string, payload: ProjectListResult): ProjectState {
  const state = stateFor(rootPath)
  const resolvedRoot = path.resolve(rootPath)
  const match = payload.projects?.find((project) => {
    if (typeof project.root_path !== "string") return false
    return path.resolve(project.root_path) === resolvedRoot
  })

  if (match && typeof match.name === "string") {
    state.project = match.name
    state.indexed = true
    state.status = "ready"
    delete state.error
  } else if (state.status !== "indexing") {
    state.indexed = false
    state.status = state.status === "failed" ? "failed" : "idle"
  }

  stateByRoot.set(rootPath, state)
  return state
}

async function refreshProjectState(binary: string, directory: string): Promise<ProjectState> {
  try {
    return updateStateFromProjects(directory, await listProjects(binary, directory))
  } catch (error) {
    const state = stateFor(directory)
    state.status = "failed"
    state.error = error instanceof Error ? error.message : String(error)
    stateByRoot.set(directory, state)
    return state
  }
}

function startBackgroundIndex(binary: string, directory: string, client: Client | undefined, options: Required<PluginOptions>) {
  if (indexing.has(directory)) return

  indexing.add(directory)
  const state = stateFor(directory)
  state.status = "indexing"
  state.indexed = false
  delete state.error
  stateByRoot.set(directory, state)
  info("index_started", "Starting background repository index", {
    directory,
    mode: options.indexMode,
  })
  void showToast(client, `codebase-memory-mcp indexing ${path.basename(directory) || directory}`, "info")

  const child = spawn(
    binary,
    [
      "cli",
      "--progress",
      "index_repository",
      JSON.stringify({ repo_path: directory, mode: options.indexMode }),
    ],
    {
      cwd: directory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let lastError = ""
  child.stderr.on("data", (chunk: Uint8Array | string) => {
    lastError = String(chunk).trim() || lastError
  })
  child.stdout.on("data", () => {})
  child.on("error", async (error: Error) => {
    indexing.delete(directory)
    const current = stateFor(directory)
    current.status = "failed"
    current.error = error.message
    stateByRoot.set(directory, current)
    warn("index_process_error", "Background index process failed", {
      directory,
      error: error.message,
    })
    await showToast(client, `codebase-memory-mcp index failed: ${error.message}`, "error")
  })
  child.on("close", async (code: number | null) => {
    indexing.delete(directory)
    if (code === 0) {
      const refreshed = await refreshProjectState(binary, directory)
      refreshed.status = refreshed.indexed ? "ready" : "idle"
      stateByRoot.set(directory, refreshed)
      info("index_completed", "Background repository index finished", {
        directory,
        indexed: refreshed.indexed,
      })
      await showToast(client, "codebase-memory-mcp index ready", "success")
      return
    }

    const current = stateFor(directory)
    current.status = "failed"
    current.error = lastError || `exit ${code ?? "unknown"}`
    stateByRoot.set(directory, current)
    warn("index_failed", "Background repository index exited nonzero", {
      directory,
      code,
      error: current.error,
    })
    await showToast(client, `codebase-memory-mcp index failed: ${current.error}`, "error")
  })
}

async function ensureProjectIndex(binary: string, directory: string, client: Client | undefined, options: Required<PluginOptions>) {
  if (!options.enabled || !options.indexOnStartup || startupAttempted.has(directory)) return
  startupAttempted.add(directory)

  await configureUpstream(binary, directory, options)
  const state = await refreshProjectState(binary, directory)
  if (!state.indexed) {
    startBackgroundIndex(binary, directory, client, options)
  }
}

const codebaseMemoryProject = (binary: string, directory: string, client: Client | undefined, options: Required<PluginOptions>) =>
  tool({
    description: "Report the current codebase-memory project state for the active OpenCode directory.",
    args: {
      refresh: z.boolean().optional().describe("Refresh project status from list_projects before returning"),
    },
    async execute(args: { refresh?: boolean }) {
      if (args.refresh) {
        await configureUpstream(binary, directory, options)
        const refreshed = await refreshProjectState(binary, directory)
        if (options.enabled && !refreshed.indexed && refreshed.status !== "indexing") {
          startBackgroundIndex(binary, directory, client, options)
        }
      }

      const state = stateFor(directory)
      if (options.enabled && !state.indexed && state.status !== "indexing") {
        startBackgroundIndex(binary, directory, client, options)
      }

      return JSON.stringify(stateByRoot.get(directory) || state, null, 2)
    },
  })

export const CodebaseMemoryPlugin = async ({ client, directory }: PluginContext, options?: PluginOptions) => {
  const normalized = normalizeOptions(options)
  const binary = normalized.binary

  if (normalized.enabled) {
    void ensureProjectIndex(binary, directory, client, normalized)
  }

  return {
    config: async (input: ConfigShape) => {
      if (!normalized.enabled) return
      input.mcp ??= {}
      input.mcp["codebase-memory-mcp"] = {
        type: "local",
        command: [binary],
        enabled: true,
      }
    },
    tool: {
      codebase_memory_project: codebaseMemoryProject(binary, directory, client, normalized),
    },
  }
}

export default { id, server: CodebaseMemoryPlugin }
