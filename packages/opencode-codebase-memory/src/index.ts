import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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
  status: "idle" | "indexing" | "ready" | "failed" | "skipped"
  error?: string
  lock?: IndexLockInfo
}

type IndexLock = {
  path: string
}

type IndexLockInfo = {
  path: string
  ownerPid?: number
  childPid?: number
  startedAt?: number
  active: boolean
}

type ActiveIndex = {
  child: ChildProcess
  lock: IndexLock
}

const indexing = new Set<string>()
const startupAttempted = new Set<string>()
const stateByRoot = new Map<string, ProjectState>()
const activeIndexes = new Map<string, ActiveIndex>()
const lockRoot = path.join(process.env.XDG_RUNTIME_DIR || tmpdir(), "opencode-codebase-memory")
const projectMarkers = [
  ".git",
  "package.json",
  "bun.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "deno.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "composer.json",
  "mix.exs",
  "gleam.toml",
  "pubspec.yaml",
  "Package.swift",
]
let cleanupRegistered = false

function normalizeOptions(options?: PluginOptions): Required<PluginOptions> {
  return {
    binary: options?.binary?.trim() || "codebase-memory-mcp",
    autoIndex: options?.autoIndex ?? false,
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

async function resolveProjectRoot(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  if (unsafeIndexReason(resolved)) return resolved

  try {
    if (!statSync(resolved).isDirectory()) return resolved
  } catch {
    return resolved
  }

  try {
    const { stdout } = await execFileAsync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], {
      env: process.env,
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    })
    const gitRoot = stdout.trim()
    if (gitRoot) return path.resolve(gitRoot)
  } catch {}

  return findProjectMarkerRoot(resolved) || resolved
}

function findProjectMarkerRoot(directory: string): string | null {
  let current = path.resolve(directory)
  while (true) {
    if (hasProjectMarker(current)) return current

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function hasProjectMarker(directory: string): boolean {
  return projectMarkers.some((marker) => existsSync(path.join(directory, marker)))
}

function unsafeIndexReason(directory: string): string | null {
  const resolved = path.resolve(directory)
  if (resolved === path.parse(resolved).root) return "refusing to auto-index the filesystem root"
  if (resolved === path.resolve(homedir())) return "refusing to auto-index the home directory"

  try {
    if (!statSync(resolved).isDirectory()) return "refusing to auto-index a path that is not a directory"
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  return null
}

function indexSkipReason(directory: string): string | null {
  return (
    unsafeIndexReason(directory) ||
    (hasProjectMarker(directory) ? null : "refusing to auto-index a directory without a project root marker")
  )
}

function markSkipped(directory: string, reason: string): ProjectState {
  const state = stateFor(directory)
  state.indexed = false
  state.status = "skipped"
  state.error = reason
  delete state.lock
  stateByRoot.set(directory, state)
  return state
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

function lockPathFor(directory: string): string {
  const hash = createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 24)
  return path.join(lockRoot, `${hash}.lock`)
}

function readLockOwner(lockPath: string): { ownerPid?: unknown; childPid?: unknown; startedAt?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
      ownerPid?: unknown
      childPid?: unknown
      startedAt?: unknown
    }
  } catch {}

  return null
}

function readIndexLock(directory: string): IndexLockInfo | null {
  const lockPath = lockPathFor(directory)
  let stat
  try {
    stat = statSync(lockPath)
  } catch {
    return null
  }

  if (!stat.isDirectory()) return null

  const owner = readLockOwner(lockPath)
  const ownerPid = typeof owner?.ownerPid === "number" ? owner.ownerPid : undefined
  const childPid = typeof owner?.childPid === "number" ? owner.childPid : undefined
  const startedAt = typeof owner?.startedAt === "number" ? owner.startedAt : undefined

  return {
    path: lockPath,
    ownerPid,
    childPid,
    startedAt,
    active: isPidAlive(ownerPid) || isPidAlive(childPid) || Date.now() - stat.mtimeMs < 30_000,
  }
}

function lockIsActive(lockPath: string): boolean {
  const payload = readLockOwner(lockPath)
  if (payload && (isPidAlive(payload.ownerPid) || isPidAlive(payload.childPid))) return true

  try {
    // Avoid stealing a lock another process created but has not populated yet.
    return Date.now() - statSync(lockPath).mtimeMs < 30_000
  } catch {
    return false
  }
}

function acquireIndexLock(directory: string): IndexLock | null {
  mkdirSync(lockRoot, { recursive: true })
  const lockPath = lockPathFor(directory)

  try {
    mkdirSync(lockPath)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    if (lockIsActive(lockPath)) return null

    rmSync(lockPath, { recursive: true, force: true })
    try {
      mkdirSync(lockPath)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
      return null
    }
  }

  writeFileSync(
    path.join(lockPath, "owner.json"),
    JSON.stringify({ ownerPid: process.pid, directory, startedAt: Date.now() }),
  )
  return { path: lockPath }
}

function attachChildToLock(lock: IndexLock, directory: string, childPid: number | undefined) {
  writeFileSync(
    path.join(lock.path, "owner.json"),
    JSON.stringify({ ownerPid: process.pid, childPid, directory, startedAt: Date.now() }),
  )
}

function releaseIndexLock(lock: IndexLock) {
  try {
    rmSync(lock.path, { recursive: true, force: true })
  } catch {}
}

function syncLockState(directory: string, state = stateFor(directory)): ProjectState {
  const lock = readIndexLock(directory)
  if (lock?.active && !state.indexed) {
    state.status = "indexing"
    state.lock = lock
    state.error ??= "index already running in another OpenCode process"
  } else if (state.status === "indexing" && !indexing.has(directory)) {
    state.status = "idle"
    delete state.error
    delete state.lock
  } else if (!lock?.active) {
    delete state.lock
  }

  stateByRoot.set(directory, state)
  return state
}

function registerCleanupHandlers() {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.once("beforeExit", cleanupActiveIndexes)
  process.once("exit", cleanupActiveIndexes)
}

function cleanupActiveIndexes() {
  for (const [directory, active] of activeIndexes) {
    if (!active.child.killed) active.child.kill()
    releaseIndexLock(active.lock)
    indexing.delete(directory)
  }
  activeIndexes.clear()
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
  try {
    await execCli(binary, directory, ["config", "set", "auto_index", String(options.autoIndex)])
  } catch (error) {
    warn("configure_auto_index_failed", "Failed to configure upstream auto_index", {
      directory,
      autoIndex: options.autoIndex,
      error: error instanceof Error ? error.message : String(error),
    })
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
    delete state.lock
  } else if (state.status !== "indexing" && state.status !== "skipped") {
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

function startBackgroundIndex(binary: string, directory: string, client: Client | undefined, options: Required<PluginOptions>): ProjectState {
  if (indexing.has(directory)) return syncLockState(directory)

  const skipReason = indexSkipReason(directory)
  if (skipReason) {
    void configureUpstream(binary, directory, { ...options, autoIndex: false })
    const skipped = markSkipped(directory, skipReason)
    warn("index_skipped_unsafe_directory", "Skipped background repository index", {
      directory,
      reason: skipReason,
    })
    return skipped
  }

  const lock = acquireIndexLock(directory)
  if (!lock) {
    const state = stateFor(directory)
    const lockInfo = readIndexLock(directory)
    state.status = "indexing"
    state.indexed = false
    state.lock = lockInfo ?? undefined
    state.error = lockInfo?.childPid
      ? `index already running in another OpenCode process (pid ${lockInfo.childPid})`
      : "index already running in another OpenCode process"
    stateByRoot.set(directory, state)
    info("index_already_running", "Skipped duplicate background repository index", { directory, lock: lockInfo })
    return state
  }

  indexing.add(directory)
  registerCleanupHandlers()
  const state = stateFor(directory)
  state.status = "indexing"
  state.indexed = false
  state.lock = readIndexLock(directory) ?? undefined
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
  attachChildToLock(lock, directory, child.pid)
  activeIndexes.set(directory, { child, lock })
  state.lock = readIndexLock(directory) ?? undefined
  stateByRoot.set(directory, state)

  let lastError = ""
  child.stderr.on("data", (chunk: Uint8Array | string) => {
    lastError = String(chunk).trim() || lastError
  })
  child.stdout.on("data", () => {})
  child.on("error", async (error: Error) => {
    indexing.delete(directory)
    activeIndexes.delete(directory)
    releaseIndexLock(lock)
    const current = stateFor(directory)
    current.status = "failed"
    current.error = error.message
    delete current.lock
    stateByRoot.set(directory, current)
    warn("index_process_error", "Background index process failed", {
      directory,
      error: error.message,
    })
    await showToast(client, `codebase-memory-mcp index failed: ${error.message}`, "error")
  })
  child.on("close", async (code: number | null) => {
    indexing.delete(directory)
    activeIndexes.delete(directory)
    if (code === 0) {
      const refreshed = await refreshProjectState(binary, directory)
      releaseIndexLock(lock)
      refreshed.status = refreshed.indexed ? "ready" : "idle"
      delete refreshed.lock
      stateByRoot.set(directory, refreshed)
      info("index_completed", "Background repository index finished", {
        directory,
        indexed: refreshed.indexed,
      })
      await showToast(client, "codebase-memory-mcp index ready", "success")
      return
    }

    releaseIndexLock(lock)
    const current = stateFor(directory)
    current.status = "failed"
    current.error = lastError || `exit ${code ?? "unknown"}`
    delete current.lock
    stateByRoot.set(directory, current)
    warn("index_failed", "Background repository index exited nonzero", {
      directory,
      code,
      error: current.error,
    })
    await showToast(client, `codebase-memory-mcp index failed: ${current.error}`, "error")
  })

  return state
}

async function ensureProjectIndex(binary: string, directory: string, client: Client | undefined, options: Required<PluginOptions>) {
  if (!options.enabled || !options.indexOnStartup || startupAttempted.has(directory)) return
  startupAttempted.add(directory)

  const skipReason = indexSkipReason(directory)
  if (skipReason) {
    void configureUpstream(binary, directory, { ...options, autoIndex: false })
    markSkipped(directory, skipReason)
    warn("startup_index_skipped_unsafe_directory", "Skipped startup repository index", {
      directory,
      reason: skipReason,
    })
    void showToast(client, `codebase-memory-mcp skipped indexing: ${skipReason}`, "warning")
    return
  }

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
      if (options.enabled) {
        const skipReason = indexSkipReason(directory)
        if (skipReason) {
          void configureUpstream(binary, directory, { ...options, autoIndex: false })
          return JSON.stringify(markSkipped(directory, skipReason), null, 2)
        }
      }

      if (args.refresh) {
        await configureUpstream(binary, directory, options)
        const refreshed = await refreshProjectState(binary, directory)
        if (options.enabled && options.indexOnStartup && !refreshed.indexed && refreshed.status !== "indexing") {
          startBackgroundIndex(binary, directory, client, options)
        }
      }

      const state = syncLockState(directory)
      if (options.enabled && options.indexOnStartup && !state.indexed && state.status !== "indexing") {
        startBackgroundIndex(binary, directory, client, options)
      }

      return JSON.stringify(syncLockState(directory, stateByRoot.get(directory) || state), null, 2)
    },
  })

const codebaseMemoryIndexProject = (binary: string, directory: string, client: Client | undefined, options: Required<PluginOptions>) =>
  tool({
    description: "Start indexing the resolved codebase-memory project root in the background.",
    args: {
      mode: z.enum(["full", "moderate", "fast"]).optional().describe("Index mode for this run. Defaults to the plugin indexMode."),
      force: z.boolean().optional().describe("Start indexing even if the project is already listed as indexed."),
    },
    async execute(args: { mode?: "full" | "moderate" | "fast"; force?: boolean }) {
      if (!options.enabled) return JSON.stringify(markSkipped(directory, "plugin disabled"), null, 2)

      const runOptions = { ...options, indexMode: args.mode ?? options.indexMode }
      const skipReason = indexSkipReason(directory)
      if (skipReason) {
        void configureUpstream(binary, directory, { ...runOptions, autoIndex: false })
        return JSON.stringify(markSkipped(directory, skipReason), null, 2)
      }

      await configureUpstream(binary, directory, runOptions)
      if (!args.force) {
        const refreshed = await refreshProjectState(binary, directory)
        if (refreshed.indexed) return JSON.stringify(refreshed, null, 2)
      }

      return JSON.stringify(startBackgroundIndex(binary, directory, client, runOptions), null, 2)
    },
  })

export const CodebaseMemoryPlugin = async ({ client, directory }: PluginContext, options?: PluginOptions) => {
  const normalized = normalizeOptions(options)
  const binary = normalized.binary
  const rootPath = normalized.enabled ? await resolveProjectRoot(directory) : path.resolve(directory)

  if (normalized.enabled) {
    void ensureProjectIndex(binary, rootPath, client, normalized)
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
      codebase_memory_project: codebaseMemoryProject(binary, rootPath, client, normalized),
      codebase_memory_index_project: codebaseMemoryIndexProject(binary, rootPath, client, normalized),
    },
  }
}

export default { id, server: CodebaseMemoryPlugin }
