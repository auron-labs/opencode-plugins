import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { tool, type Plugin as V1Plugin } from "@opencode-ai/plugin"
import { Plugin } from "@opencode/plugin"
import { info, warn } from "./logger.js"

const execFileAsync = promisify(execFile)
const z = tool.schema

const id = "opencode-codebase-memory"

type PluginOptions = {
  binary?: string
  indexOnStartup?: boolean
  indexMode?: "full" | "moderate" | "fast"
  enabled?: boolean
}

type Client = {
  tui?: {
    showToast(args: { body: { message: string; variant: string } }): Promise<void>
  }
}

async function showToast(client: Client | undefined, message: string, variant: string) {
  try {
    await client?.tui?.showToast({ body: { message, variant } })
  } catch {}
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

type RootPolicy = {
  rootPath: string
  reason: string | null
}

type StartupRecord = {
  indexAttempted: boolean
}

const indexing = new Set<string>()
const refreshing = new Set<string>()
const stateByRoot = new Map<string, ProjectState>()
const activeIndexes = new Map<string, ActiveIndex>()
const startupByRoot = new Map<string, StartupRecord>()
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
const credentialComponents = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube",
  ".docker",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".azure",
  ".gcloud",
  "Keychains",
  ".password-store",
  ".authinfo",
])
const credentialComponentsLower = new Set([...credentialComponents].map((component) => component.toLowerCase()))
const windowsSystemTrees = new Set(["windows", "programdata", "program files", "program files (x86)"])
let cleanupRegistered = false

function normalizeOptions(options?: PluginOptions): Required<PluginOptions> {
  return {
    binary: options?.binary?.trim() || "codebase-memory-mcp",
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

function startupFor(rootPath: string): StartupRecord {
  const existing = startupByRoot.get(rootPath)
  if (existing) return existing
  const created = { indexAttempted: false }
  startupByRoot.set(rootPath, created)
  return created
}

async function resolveProjectRoot(directory: string): Promise<string> {
  const resolved = lexicalPath(directory)
  const canonical = canonicalExistingPath(resolved)
  if (!canonical || !isDirectory(canonical)) return canonical || resolved
  if (unsafeRootReason(canonical)) return canonical

  try {
    const { stdout } = await execFileAsync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      env: process.env,
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    })
    const gitRoot = stdout.trim()
    const canonicalGitRoot = gitRoot && canonicalExistingPath(gitRoot)
    if (canonicalGitRoot && isDirectory(canonicalGitRoot)) return canonicalGitRoot
  } catch {}

  return findProjectMarkerRoot(canonical) || canonical
}

function lexicalPath(directory: string): string {
  try {
    return path.resolve(directory)
  } catch {
    return ""
  }
}

function canonicalExistingPath(directory: string): string | null {
  if (!directory) return null
  try {
    return realpathSync.native(directory)
  } catch {
    return null
  }
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory()
  } catch {
    return false
  }
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

function unsafeRootReason(directory: string): string | null {
  if (!directory) return "refusing to enable codebase-memory for an invalid directory"

  const pathApi = process.platform === "win32" ? path.win32 : path.posix
  const root = pathApi.parse(directory).root
  if (!root || pathApi.normalize(directory) === pathApi.normalize(root)) {
    return "refusing to enable codebase-memory for the filesystem root"
  }
  if (!isDirectory(directory)) return "refusing to enable codebase-memory for a path that is not a directory"

  const home = canonicalExistingPath(homedir())
  if (home && pathApi.normalize(directory) === pathApi.normalize(home)) {
    return "refusing to enable codebase-memory for the home directory"
  }

  const relative = pathApi.relative(root, directory)
  const components = relative.split(pathApi.sep).filter(Boolean)
  const caseInsensitive = process.platform === "win32"
  const normalizedComponents = components.map((component) => (caseInsensitive ? component.toLowerCase() : component))
  if (caseInsensitive) {
    if (normalizedComponents.length === 1 && normalizedComponents[0] === "users") {
      return "refusing to enable codebase-memory for the Windows Users tree"
    }
    if (normalizedComponents[0] && windowsSystemTrees.has(normalizedComponents[0])) {
      return "refusing to enable codebase-memory for a Windows system tree"
    }
  } else {
    const depth = normalizedComponents[0] === "private" ? normalizedComponents.length - 1 : normalizedComponents.length
    if (depth < 2) return "refusing to enable codebase-memory for a path that is too broad"
  }

  if (
    components.some(
      (component) =>
        credentialComponents.has(component) ||
        (caseInsensitive && credentialComponentsLower.has(component.toLowerCase())),
    )
  ) {
    return "refusing to enable codebase-memory for a credential directory"
  }

  const configuredRoot = process.env.CBM_ALLOWED_ROOT
  if (configuredRoot !== undefined) {
    if (!configuredRoot.trim()) return "refusing to enable codebase-memory because CBM_ALLOWED_ROOT is invalid"
    const canonicalAllowedRoot = canonicalExistingPath(lexicalPath(configuredRoot))
    if (!canonicalAllowedRoot || !isDirectory(canonicalAllowedRoot)) {
      return "refusing to enable codebase-memory because CBM_ALLOWED_ROOT is invalid"
    }
    const allowedRelative = path.relative(canonicalAllowedRoot, directory)
    if (
      allowedRelative === ".." ||
      allowedRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(allowedRelative)
    ) {
      return "refusing to enable codebase-memory outside CBM_ALLOWED_ROOT"
    }
  }

  return null
}

function rootPolicy(rootPath: string): RootPolicy {
  const reason =
    unsafeRootReason(rootPath) ||
    (hasProjectMarker(rootPath) ? null : "refusing to enable codebase-memory for a directory without a project root marker")
  return { rootPath, reason }
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
  const hash = createHash("sha256").update(directory).digest("hex").slice(0, 24)
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
  } else if (state.status === "indexing" && !indexing.has(directory) && !refreshing.has(directory)) {
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
    refreshing.delete(directory)
  }
  activeIndexes.clear()
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

async function listProjects(binary: string, directory: string): Promise<ProjectListResult> {
  const { stdout } = await execCli(binary, directory, ["cli", "--json", "list_projects", "--format", "json"])
  return parseCliJson<ProjectListResult>(stdout) || { projects: [] }
}

function updateStateFromProjects(rootPath: string, payload: ProjectListResult): ProjectState {
  const state = stateFor(rootPath)
  const resolvedRoot = rootPath
  const match = payload.projects?.find((project) => {
    if (typeof project.root_path !== "string") return false
    return (canonicalExistingPath(project.root_path) || path.resolve(project.root_path)) === resolvedRoot
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

function startBackgroundIndex(
  binary: string,
  policy: RootPolicy,
  options: Required<PluginOptions>,
  client?: Client,
): ProjectState {
  const directory = policy.rootPath
  if (indexing.has(directory)) return syncLockState(directory)

  if (policy.reason) {
    const skipped = markSkipped(directory, policy.reason)
    warn("index_skipped_unsafe_directory", "Skipped background repository index", {
      directory,
      reason: policy.reason,
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

  let child: ChildProcess | undefined
  try {
    child = spawn(
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
  } catch (error) {
    if (child && !child.killed) child.kill()
    releaseIndexLock(lock)
    indexing.delete(directory)
    const message = error instanceof Error ? error.message : String(error)
    const current = stateFor(directory)
    current.status = "failed"
    current.error = message
    delete current.lock
    stateByRoot.set(directory, current)
    void showToast(client, `codebase-memory-mcp index failed: ${message}`, "error")
    return current
  }
  if (!child) return state

  let terminalHandled = false
  let lastError = ""
  const cleanup = () => {
    indexing.delete(directory)
    activeIndexes.delete(directory)
    releaseIndexLock(lock)
  }
  const fail = async (message: string, event: string, metadata: Record<string, unknown>) => {
    if (terminalHandled) return
    terminalHandled = true
    cleanup()
    const current = stateFor(directory)
    current.status = "failed"
    current.error = message
    delete current.lock
    stateByRoot.set(directory, current)
    warn(event, "Background repository index failed", { directory, ...metadata, error: message })
    await showToast(client, `codebase-memory-mcp index failed: ${message}`, "error")
  }

  child.stderr?.on("data", (chunk: Uint8Array | string) => {
    lastError = String(chunk).trim() || lastError
  })
  child.stdout?.on("data", () => {})
  child.on("error", (error: Error) => {
    void fail(error.message, "index_process_error", {})
  })
  child.on("close", (code: number | null) => {
    if (terminalHandled) return
    terminalHandled = true
    cleanup()
    if (code !== 0) {
      const message = lastError || `exit ${code ?? "unknown"}`
      const current = stateFor(directory)
      current.status = "failed"
      current.error = message
      delete current.lock
      stateByRoot.set(directory, current)
      warn("index_failed", "Background repository index failed", { directory, code, error: message })
      void showToast(client, `codebase-memory-mcp index failed: ${message}`, "error")
      return
    }

    refreshing.add(directory)
    void (async () => {
      try {
        const refreshed = await refreshProjectState(binary, directory)
        delete refreshed.lock
        stateByRoot.set(directory, refreshed)
        if (refreshed.status === "failed") {
          void showToast(client, `codebase-memory-mcp index failed: ${refreshed.error || "status refresh failed"}`, "error")
          return
        }
        refreshed.status = refreshed.indexed ? "ready" : "idle"
        stateByRoot.set(directory, refreshed)
        info("index_completed", "Background repository index finished", {
          directory,
          indexed: refreshed.indexed,
        })
        void showToast(client, "codebase-memory-mcp index ready", "success")
      } finally {
        refreshing.delete(directory)
      }
    })()
  })

  return state
}

async function ensureProjectIndex(
  binary: string,
  policy: RootPolicy,
  options: Required<PluginOptions>,
  client?: Client,
) {
  const directory = policy.rootPath
  if (!options.enabled || policy.reason) return
  const startup = startupFor(directory)
  const shouldIndexOnStartup = options.indexOnStartup && !startup.indexAttempted
  if (shouldIndexOnStartup) startup.indexAttempted = true

  if (!shouldIndexOnStartup) return

  const state = await refreshProjectState(binary, directory)
  if (!state.indexed && state.status === "idle") {
    startBackgroundIndex(binary, policy, options, client)
  }
}

type V1ConfigShape = {
  mcp?: Record<string, unknown>
}

const projectStateOutput = {
  type: "object",
  properties: {
    rootPath: { type: "string" },
    project: { type: ["string", "null"] },
    indexed: { type: "boolean" },
    status: { type: "string", enum: ["idle", "indexing", "ready", "failed", "skipped"] },
    error: { type: "string" },
    lock: {
      type: "object",
      properties: {
        path: { type: "string" },
        ownerPid: { type: "number" },
        childPid: { type: "number" },
        startedAt: { type: "number" },
        active: { type: "boolean" },
      },
      required: ["path", "active"],
    },
  },
  required: ["rootPath", "project", "indexed", "status"],
} as const

function projectStateResult(state: ProjectState) {
  return { output: state, content: JSON.stringify(state, null, 2) }
}

async function codebaseMemoryProject(
  binary: string,
  policy: RootPolicy,
  options: Required<PluginOptions>,
  args: { refresh?: boolean },
  client?: Client,
) {
      const directory = policy.rootPath
      if (!options.enabled) return projectStateResult(stateFor(directory))
      if (policy.reason) return projectStateResult(markSkipped(directory, policy.reason))
      const startup = startupFor(directory)

      if (args.refresh) {
        const refreshed = await refreshProjectState(binary, directory)
        if (
          options.indexOnStartup &&
          !startup.indexAttempted &&
          !refreshed.indexed &&
          refreshed.status === "idle"
        ) {
          startBackgroundIndex(binary, policy, options, client)
        }
      }

      const state = syncLockState(directory)
      if (options.indexOnStartup && !startup.indexAttempted && !state.indexed && state.status === "idle") {
        startBackgroundIndex(binary, policy, options, client)
      }

      return projectStateResult(syncLockState(directory, stateByRoot.get(directory) || state))
}

async function codebaseMemoryIndexProject(
  binary: string,
  policy: RootPolicy,
  options: Required<PluginOptions>,
  args: { mode?: "full" | "moderate" | "fast"; force?: boolean },
  client?: Client,
) {
      const directory = policy.rootPath
      if (!options.enabled) return projectStateResult(markSkipped(directory, "plugin disabled"))

      const runOptions = { ...options, indexMode: args.mode ?? options.indexMode }
      if (policy.reason) return projectStateResult(markSkipped(directory, policy.reason))
      if (!args.force) {
        const refreshed = await refreshProjectState(binary, directory)
        if (refreshed.indexed) return projectStateResult(refreshed)
      }

      return projectStateResult(startBackgroundIndex(binary, policy, runOptions, client))
}

const plugin = Plugin.define({
  id,
  async setup(ctx) {
    const options = normalizeOptions(ctx.options as PluginOptions)
    const binary = options.binary
    const rootPath = options.enabled ? await resolveProjectRoot(ctx.location.directory) : path.resolve(ctx.location.directory)
    const policy = options.enabled ? rootPolicy(rootPath) : { rootPath, reason: null }

    if (options.enabled && !policy.reason) {
      void ensureProjectIndex(binary, policy, options).catch((error) => {
        warn("startup_index_failed", "Failed to check or start startup repository index", {
          directory: rootPath,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }

    if (options.enabled && !policy.reason) {
      await ctx.mcp.transform((editor) => {
        if (!editor.get("codebase-memory-mcp")) {
          editor.set("codebase-memory-mcp", { type: "local", command: [binary], cwd: rootPath, disabled: false })
        }
      })
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "codebase_memory_project",
        description: "Report the current codebase-memory project state for the active OpenCode directory.",
        input: { type: "object", properties: { refresh: { type: "boolean", description: "Refresh project status from list_projects before returning" } } } as const,
        output: projectStateOutput,
        execute: (input) => codebaseMemoryProject(binary, policy, options, input as { refresh?: boolean }),
      })
      editor.add({
        name: "codebase_memory_index_project",
        description: "Start indexing the resolved codebase-memory project root in the background.",
        input: { type: "object", properties: { mode: { type: "string", enum: ["full", "moderate", "fast"], description: "Index mode for this run. Defaults to the plugin indexMode." }, force: { type: "boolean", description: "Start indexing even if the project is already listed as indexed." } } } as const,
        output: projectStateOutput,
        execute: (input) => codebaseMemoryIndexProject(binary, policy, options, input as { mode?: "full" | "moderate" | "fast"; force?: boolean }),
      })
    })
  },
})

// V1 entrypoint
export const CodebaseMemoryPlugin: V1Plugin = async ({ directory, client }, options) => {
  const normalized = normalizeOptions(options as PluginOptions)
  const binary = normalized.binary
  const v1Client = client as unknown as Client
  const rootPath = normalized.enabled ? await resolveProjectRoot(directory) : path.resolve(directory)
  const policy = normalized.enabled ? rootPolicy(rootPath) : { rootPath, reason: null }

  if (normalized.enabled && !policy.reason) {
    void ensureProjectIndex(binary, policy, normalized, v1Client).catch((error) => {
      warn("startup_index_failed", "Failed to check or start startup repository index", {
        directory: rootPath,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const projectTool = tool({
    description: "Report the current codebase-memory project state for the active OpenCode directory.",
    args: {
      refresh: z.boolean().optional().describe("Refresh project status from list_projects before returning"),
    },
    async execute(args) {
      return (await codebaseMemoryProject(binary, policy, normalized, args, v1Client)).content
    },
  })

  const indexTool = tool({
    description: "Start indexing the resolved codebase-memory project root in the background.",
    args: {
      mode: z.enum(["full", "moderate", "fast"]).optional().describe("Index mode for this run. Defaults to the plugin indexMode."),
      force: z.boolean().optional().describe("Start indexing even if the project is already listed as indexed."),
    },
    async execute(args) {
      return (await codebaseMemoryIndexProject(binary, policy, normalized, args, v1Client)).content
    },
  })

  return {
    config: async (input) => {
      if (!normalized.enabled || policy.reason) return
      const config = input as unknown as V1ConfigShape
      config.mcp ??= {}
      if (!config.mcp["codebase-memory-mcp"]) {
        config.mcp["codebase-memory-mcp"] = { type: "local", command: [binary], cwd: rootPath, enabled: true }
      }
    },
    tool: {
      codebase_memory_project: projectTool,
      codebase_memory_index_project: indexTool,
    },
  }
}

export default { ...plugin, server: CodebaseMemoryPlugin }
