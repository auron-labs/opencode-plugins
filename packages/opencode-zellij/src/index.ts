import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import readline from "node:readline"
import { tool } from "@opencode-ai/plugin"
import { info, warn } from "./logger.js"
// plugin format: { id, server } direct object export

const execFileAsync = promisify(execFile)
const z = tool.schema

// Types

type PluginOptions = {
  session?: string
  binary?: string
  maxEvents?: number
  pollMs?: number
  closeOnExitCleanup?: boolean
  stateFile?: string
}

type ExitCondition = "any" | "zero" | "nonzero" | number

type Subscription = {
  type: "text_match" | "exit" | "closed"
  pattern?: string
  exit?: ExitCondition
}

type PaneEvent = {
  type: string
  timestamp: number
  data: unknown
}

type TrackedPane = {
  ref: string
  paneId: string
  command: string[]
  cwd?: string
  name?: string
  floating?: boolean
  direction?: string
  subscriptions: Subscription[]
  events: PaneEvent[]
  closed: boolean
  exited: boolean
  exitCode: number | null
}

type PaneListItem = {
  id?: unknown
  exited?: unknown
  exit_status?: unknown
}

type SubscribeEvent = {
  event?: unknown
  viewport?: unknown
  scrollback?: unknown
  pane_id?: unknown
  is_initial?: unknown
}

type PersistedState = {
  version: 1
  panes: Record<string, TrackedPane>
}

// Module state

const id = "opencode-zellij"
const DEFAULT_MAX_EVENTS = 200
const DEFAULT_POLL_MS = 3000
const DEFAULT_BINARY = "zellij"

const panes = new Map<string, TrackedPane>()
const watchers = new Map<string, ChildProcess>()
const pollTimers = new Map<string, ReturnType<typeof setInterval>>()
let stateFile = ""
let maxEvents = DEFAULT_MAX_EVENTS
let binary = DEFAULT_BINARY
let pollMs = DEFAULT_POLL_MS
let closeOnExitCleanup = true
let refCounter = 0
let initialized = false
let cleanupRegistered = false
let sessionName: string | undefined

// Zellij helpers

function zellijArgs(extra: string[]): string[] {
  const args = [...extra]
  if (sessionName) args.unshift("--session", sessionName)
  return args
}

function expandHome(input: string): string {
  const home = process.env.HOME || homedir()
  if (input === "~") return home || input
  if (input.startsWith("~/")) return home ? path.join(home, input.slice(2)) : input
  return input
}

async function execZellij(args: string[]): Promise<string> {
  const fullArgs = zellijArgs(args)
  try {
    const { stdout } = await execFileAsync(binary, fullArgs, { timeout: 15_000 })
    return stdout.trim()
  } catch (error: unknown) {
    const err = error as { code?: string; stderr?: string; message?: string }
    if (err.code === "ENOENT") throw new Error(`zellij binary not found at '${binary}'`)
    throw new Error(err.stderr?.trim() || err.message || "zellij command failed")
  }
}

function execZellijSync(args: string[]): void {
  try {
    execFileSync(binary, zellijArgs(args), { stdio: "ignore", timeout: 3000 })
  } catch {
    // cleanup only; pane may already be gone
  }
}

// State persistence

function serializablePane(pane: TrackedPane): TrackedPane {
  return { ...pane, events: pane.events.slice(-50) }
}

async function saveState(): Promise<void> {
  if (!stateFile) return
  const data: PersistedState = {
    version: 1,
    panes: Object.fromEntries(
      [...panes.entries()].map(([k, v]) => [k, serializablePane(v)]),
    ),
  }
  try {
    await fs.mkdir(path.dirname(stateFile), { recursive: true })
    await fs.writeFile(stateFile, JSON.stringify(data, null, 2))
  } catch (error) {
    warn("state_save_failed", "Failed to persist zellij state", {
      stateFile,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function loadState(): Promise<PersistedState | null> {
  if (!stateFile) return null
  try {
    const raw = await fs.readFile(stateFile, "utf-8")
    return JSON.parse(raw) as PersistedState
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null
    warn("state_load_failed", "Failed to load persisted zellij state", {
      stateFile,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// Event helpers

function pushEvent(pane: TrackedPane, event: PaneEvent): PaneEvent {
  pane.events.push(event)
  if (pane.events.length > maxEvents) {
    pane.events.splice(0, pane.events.length - maxEvents)
  }
  return event
}

async function listPanes(): Promise<PaneListItem[]> {
  return JSON.parse(await execZellij(["action", "list-panes", "--json"])) as PaneListItem[]
}

async function getZellijStatus(): Promise<{ connected: boolean; livePanes: number; error?: string }> {
  try {
    return { connected: true, livePanes: (await listPanes()).length }
  } catch (error) {
    return { connected: false, livePanes: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

function samePane(pane: PaneListItem, paneId: string): boolean {
  const id = String(pane.id ?? "")
  return id === paneId || `terminal_${id}` === paneId
}

function exitMatches(condition: ExitCondition | undefined, exitCode: number | null): boolean {
  if (condition === undefined || condition === "nonzero") return exitCode !== 0
  if (condition === "any") return true
  if (condition === "zero") return exitCode === 0
  return exitCode === condition
}

function findPane(refOrId: string): TrackedPane | undefined {
  const byRef = panes.get(refOrId)
  if (byRef) return byRef
  for (const pane of panes.values()) {
    if (pane.paneId === refOrId) return pane
  }
  return undefined
}

function pushTextMatches(pane: TrackedPane, textLines: string[]): PaneEvent[] {
  const matched: PaneEvent[] = []
  for (const sub of pane.subscriptions) {
    if (sub.type === "text_match" && sub.pattern) {
      try {
        const regex = new RegExp(sub.pattern)
        for (const line of textLines) {
          if (regex.test(line)) {
            const duplicate = pane.events.some((event) => {
              if (event.type !== "text_match") return false
              const data = event.data as { pattern?: string; line?: string }
              return data.pattern === sub.pattern && data.line === line
            })
            if (duplicate) break

            const ev = pushEvent(pane, {
              type: "text_match",
              timestamp: Date.now(),
              data: { paneId: pane.paneId, ref: pane.ref, pattern: sub.pattern, line },
            })
            matched.push(ev)
            break
          }
        }
      } catch {
        // invalid regex, skip
      }
    }
  }
  return matched
}

function pushExitMatches(pane: TrackedPane): PaneEvent[] {
  const matched: PaneEvent[] = []
  for (const sub of pane.subscriptions) {
    if (sub.type !== "exit" || !exitMatches(sub.exit, pane.exitCode)) continue
    matched.push(
      pushEvent(pane, {
        type: "exit_match",
        timestamp: Date.now(),
        data: { paneId: pane.paneId, ref: pane.ref, exitCode: pane.exitCode, condition: sub.exit ?? "nonzero" },
      }),
    )
  }
  return matched
}

function parseExitCondition(input: unknown): ExitCondition {
  if (input === true || input === undefined) return "nonzero"
  if (input === "any" || input === "zero" || input === "nonzero") return input
  if (typeof input === "number" && Number.isInteger(input)) return input
  throw new Error("exit must be true, 'any', 'zero', 'nonzero', or an integer exit code")
}

function normalizeSubscription(input: { type: string; pattern?: string; exit?: unknown }): Subscription | null {
  if (input.type === "text_match") return { type: "text_match", pattern: input.pattern }
  if (input.type === "closed") return { type: "closed" }
  if (input.type === "exit_nonzero") return { type: "exit", exit: "nonzero" }
  if (input.type === "exit" && input.exit !== false) return { type: "exit", exit: parseExitCondition(input.exit) }
  return null
}

function markExited(pane: TrackedPane, exitCode: number | null): PaneEvent {
  pane.exited = true
  pane.exitCode = exitCode
  const event = pushEvent(pane, {
    type: "pane_exited",
    timestamp: Date.now(),
    data: { paneId: pane.paneId, ref: pane.ref, exitCode: pane.exitCode },
  })
  pushExitMatches(pane)
  return event
}

function markClosed(pane: TrackedPane): PaneEvent {
  pane.closed = true
  return pushEvent(pane, {
    type: "pane_closed",
    timestamp: Date.now(),
    data: { paneId: pane.paneId, ref: pane.ref },
  })
}

function refForName(name?: string): string {
  if (name) {
    if (panes.has(name)) throw new Error(`A tracked pane already uses ref '${name}'`)
    return name
  }
  do {
    refCounter += 1
  } while (panes.has(`pane-${refCounter}`))
  return `pane-${refCounter}`
}

function buildNewPaneArgs(input: {
  command: string[]
  name?: string
  cwd?: string
  floating?: boolean
  direction?: string
}): string[] {
  const spawnArgs = ["action", "new-pane"]
  if (input.name) spawnArgs.push("--name", input.name)
  if (input.floating) spawnArgs.push("--floating")
  if (input.direction && !input.floating) spawnArgs.push("--direction", input.direction)
  if (input.cwd) spawnArgs.push("--cwd", input.cwd)
  spawnArgs.push("--", ...input.command)
  return spawnArgs
}

// Watcher (subscribe + poll)

async function startWatcher(pane: TrackedPane): Promise<void> {
  stopWatcher(pane.ref)

  const args = zellijArgs([
    "subscribe",
    "--pane-id",
    pane.paneId,
    "--format",
    "json",
  ])

  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] })
  watchers.set(pane.ref, child)

  const rl = readline.createInterface({ input: child.stdout! })

  rl.on("line", (line: string) => {
    if (!line.trim()) return
    let data: SubscribeEvent
    try {
      data = JSON.parse(line)
    } catch {
      return
    }

    const event = typeof data.event === "string" ? data.event : undefined
    if (event === "pane_update") {
      const viewport = Array.isArray(data.viewport) ? data.viewport.filter((item): item is string => typeof item === "string") : []
      const scrollback = Array.isArray(data.scrollback) ? data.scrollback.filter((item): item is string => typeof item === "string") : []
      const newLines = [...scrollback, ...viewport]
      pushTextMatches(pane, newLines)

      pushEvent(pane, {
        type: "pane_update",
        timestamp: Date.now(),
        data: { paneId: pane.paneId, lines: newLines.length, isInitial: data.is_initial === true },
      })
    } else if (event === "pane_closed") {
      markClosed(pane)
      saveState()
    }
  })

  if (child.stderr) {
    const errLines = readline.createInterface({ input: child.stderr })
    errLines.on("line", (line: string) => {
      if (!line.trim()) return
      pushEvent(pane, {
        type: "error",
        timestamp: Date.now(),
        data: { paneId: pane.paneId, ref: pane.ref, message: line },
      })
      warn("watcher_stderr", "Zellij watcher emitted stderr", {
        ref: pane.ref,
        paneId: pane.paneId,
        message: line,
      })
      saveState()
    })
  }

  child.on("error", (error) => {
    pushEvent(pane, {
      type: "error",
      timestamp: Date.now(),
      data: { paneId: pane.paneId, ref: pane.ref, message: error.message },
    })
    warn("watcher_error", "Zellij watcher process failed", {
      ref: pane.ref,
      paneId: pane.paneId,
      error: error.message,
    })
    saveState()
  })

  child.on("close", () => {
    if (watchers.get(pane.ref) === child) {
      watchers.delete(pane.ref)
    }
  })

  // Poll for exit code (subscribe doesn't report it)
  const timer = setInterval(async () => {
    if (pane.closed || pane.exited) {
      clearInterval(timer)
      pollTimers.delete(pane.ref)
      return
    }
    try {
      const match = (await listPanes()).find((p) => samePane(p, pane.paneId))
      if (match && match.exited) {
        markExited(pane, typeof match.exit_status === "number" ? match.exit_status : null)
        clearInterval(timer)
        pollTimers.delete(pane.ref)
        saveState()
      }
    } catch {
      // non-fatal
    }
  }, pollMs)

  pollTimers.set(pane.ref, timer)
}

function stopWatcher(ref: string): void {
  const child = watchers.get(ref)
  if (child) {
    child.kill("SIGTERM")
    watchers.delete(ref)
  }
  const timer = pollTimers.get(ref)
  if (timer) {
    clearInterval(timer)
    pollTimers.delete(ref)
  }
}

function stopAllWatchers(): void {
  for (const ref of panes.keys()) {
    stopWatcher(ref)
  }
}

async function closePane(pane: TrackedPane): Promise<void> {
  stopWatcher(pane.ref)
  try {
    await execZellij(["action", "close-pane", "--pane-id", pane.paneId])
  } catch {
    // pane may already be closed
  }
  markClosed(pane)
}

// Cleanup

async function cleanup(): Promise<void> {
  if (!closeOnExitCleanup) return
  for (const pane of panes.values()) {
    await closePane(pane)
  }
  panes.clear()
  await saveState()
}

function cleanupSync(): void {
  if (!closeOnExitCleanup) return
  for (const pane of panes.values()) {
    stopWatcher(pane.ref)
    execZellijSync(["action", "close-pane", "--pane-id", pane.paneId])
  }
  panes.clear()
}

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true

  const doCleanup = () => {
    cleanup().catch((error) => {
      warn("cleanup_failed", "Async zellij cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  process.on("SIGINT", () => {
    cleanupSync()
    process.exit(130)
  })
  process.on("SIGTERM", () => {
    cleanupSync()
    process.exit(143)
  })
  process.on("beforeExit", doCleanup)
  process.on("exit", cleanupSync)
}

// State restore from previous runs

async function cleanStalePanes(): Promise<void> {
  const saved = await loadState()
  if (!saved?.panes) return

  let livePanes: PaneListItem[]
  try {
    livePanes = await listPanes()
  } catch {
    return
  }

  let changed = false

  // Restore still-live tracked panes from the previous plugin process.
  // Do NOT close panes not created by this plugin.
  for (const [ref, old] of Object.entries(saved.panes)) {
    if (old.closed || old.exited || !livePanes.some((pane) => samePane(pane, old.paneId))) {
      changed = true
      continue
    }

    panes.set(ref, { ...old, events: old.events || [], closed: false, exited: false })
    startWatcher(panes.get(ref)!).catch(() => {})
  }

  if (changed) await saveState()
}

// Initialization

function defaultStateFile(): string {
  const home = process.env.HOME || homedir()
  const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(home, ".config", "opencode")
  return expandHome(path.join(configDir, "zellij.json"))
}

async function ensureInit(options?: PluginOptions): Promise<void> {
  if (initialized) {
    // Apply per-call options on repeated plugin initialization, but skip no-options
    // calls from tool execute() to avoid overwriting the active config.
    if (options) {
      binary = options.binary || DEFAULT_BINARY
      maxEvents = options.maxEvents || DEFAULT_MAX_EVENTS
      pollMs = options.pollMs || DEFAULT_POLL_MS
      closeOnExitCleanup = options.closeOnExitCleanup !== false
      sessionName = options.session || process.env.ZELLIJ_SESSION_NAME
      const newStateFile = options.stateFile ? expandHome(options.stateFile) : defaultStateFile()
      if (newStateFile !== stateFile) {
        stopAllWatchers()
        panes.clear()
        stateFile = newStateFile
        await cleanStalePanes()
      }
    }
    return
  }
  initialized = true

  binary = options?.binary || DEFAULT_BINARY
  maxEvents = options?.maxEvents || DEFAULT_MAX_EVENTS
  pollMs = options?.pollMs || DEFAULT_POLL_MS
  closeOnExitCleanup = options?.closeOnExitCleanup !== false
  sessionName = options?.session || process.env.ZELLIJ_SESSION_NAME
  stateFile = options?.stateFile ? expandHome(options.stateFile) : defaultStateFile()

  registerCleanup()
  info("plugin_initialized", "Initialized zellij plugin runtime", {
    session: sessionName ?? null,
    stateFile,
  })
  await cleanStalePanes()
}

// Tool definitions

const zellijSpawn = tool({
  description:
    "Spawn a new Zellij pane, track it, and start a JSON event watcher. Returns a stable local ref and pane ID.",
  args: {
    command: z.array(z.string()).min(1).describe("Command to run as an array of strings"),
    name: z.string().optional().describe("Pane name (used as ref if not provided)"),
    cwd: z.string().optional().describe("Working directory for the pane"),
    floating: z.boolean().optional().describe("Open in floating mode"),
    direction: z.enum(["right", "left", "up", "down"]).optional().describe("Direction for tiled panes"),
    subscriptions: z
      .array(
        z.object({
          type: z.enum(["text_match", "exit", "exit_nonzero", "closed"]),
          pattern: z.string().optional().describe("Regex pattern for text_match"),
          exit: z.union([z.boolean(), z.enum(["any", "zero", "nonzero"]), z.number().int()]).optional(),
        }),
      )
      .optional()
      .describe("Additional subscriptions beyond the defaults (exit nonzero, closed)"),
  },
  async execute(args) {
    await ensureInit()

    const paneId = await execZellij(buildNewPaneArgs(args))

    const ref = refForName(args.name)
    const pane: TrackedPane = {
      ref,
      paneId,
      command: args.command,
      cwd: args.cwd,
      name: args.name,
      floating: args.floating,
      direction: args.direction,
      subscriptions: [
        { type: "exit", exit: "nonzero" },
        { type: "closed" },
        ...(args.subscriptions || []).map(normalizeSubscription).filter((sub): sub is Subscription => Boolean(sub)),
      ],
      events: [],
      closed: false,
      exited: false,
      exitCode: null,
    }
    panes.set(ref, pane)
    info("pane_spawned", "Spawned tracked zellij pane", {
      ref,
      paneId,
      floating: args.floating === true,
      hasCwd: Boolean(args.cwd),
      commandLength: args.command.length,
    })

    // Check if already exited
    try {
      const match = (await listPanes()).find((p) => samePane(p, paneId))
      if (match && match.exited) {
        markExited(pane, typeof match.exit_status === "number" ? match.exit_status : null)
      }
    } catch {
      // non-fatal
    }

    await startWatcher(pane)
    await saveState()

    return JSON.stringify({
      ref: pane.ref,
      paneId: pane.paneId,
      command: pane.command,
      subscriptions: pane.subscriptions.length,
      exited: pane.exited,
    })
  },
})

const zellijRead = tool({
  description: "Read current pane output as text via zellij dump-screen.",
  args: {
    ref: z.string().optional().describe("Tracked pane ref"),
    paneId: z.string().optional().describe("Zellij pane ID (e.g. terminal_0)"),
    full: z.boolean().optional().describe("Include full scrollback"),
    ansi: z.boolean().optional().describe("Preserve ANSI escape codes"),
  },
  async execute(args) {
    await ensureInit()

    let paneId: string
    if (args.ref) {
      const pane = findPane(args.ref)
      if (!pane) throw new Error(`No tracked pane with ref '${args.ref}'`)
      paneId = pane.paneId
    } else if (args.paneId) {
      paneId = args.paneId
    } else {
      throw new Error("Provide ref or paneId")
    }

    const dumpArgs = ["action", "dump-screen", "--pane-id", paneId]
    if (args.full) dumpArgs.push("--full")
    if (args.ansi) dumpArgs.push("--ansi")

    return await execZellij(dumpArgs)
  },
})

const zellijEvents = tool({
  description: "Return buffered events for a tracked pane as JSON.",
  args: {
    ref: z.string().optional().describe("Tracked pane ref"),
    paneId: z.string().optional().describe("Zellij pane ID"),
    clear: z.boolean().optional().describe("Clear event buffer after reading"),
    limit: z.number().optional().describe("Max events to return"),
  },
  async execute(args) {
    await ensureInit()

    const pane = findPane(args.ref || args.paneId || "")
    if (!pane) throw new Error(`No tracked pane with ref/id '${args.ref || args.paneId}'`)

    const events = args.limit ? pane.events.slice(-args.limit) : [...pane.events]
    if (args.clear) pane.events.length = 0

    return events.length ? JSON.stringify(events, null, 2) : "No events buffered."
  },
})

const zellijSubscribe = tool({
  description: "Add subscriptions to a tracked pane for text matching, exit, or close events.",
  args: {
    ref: z.string().optional().describe("Tracked pane ref"),
    paneId: z.string().optional().describe("Zellij pane ID"),
    text: z.string().optional().describe("Regex pattern to match in pane output"),
    exit: z.union([z.boolean(), z.enum(["any", "zero", "nonzero"]), z.number().int()]).optional()
      .describe("Subscribe to exit: true/nonzero, any, zero, or an exact integer code"),
    closed: z.boolean().optional().describe("Subscribe to pane closed"),
  },
  async execute(args) {
    await ensureInit()

    const pane = findPane(args.ref || args.paneId || "")
    if (!pane) throw new Error(`No tracked pane with ref/id '${args.ref || args.paneId}'`)

    if (args.text) {
      new RegExp(args.text) // validate
      pane.subscriptions.push({ type: "text_match", pattern: args.text })
    }
    if (args.exit !== undefined && args.exit !== false) {
      pane.subscriptions.push({ type: "exit", exit: parseExitCondition(args.exit) })
    }
    if (args.closed) pane.subscriptions.push({ type: "closed" })
    await saveState()

    return JSON.stringify({ ref: pane.ref, subscriptions: pane.subscriptions.length })
  },
})

const zellijWait = tool({
  description:
    "Wait for a matching buffered or future event on a tracked pane. Resolves when found or times out.",
  args: {
    ref: z.string().optional().describe("Tracked pane ref"),
    paneId: z.string().optional().describe("Zellij pane ID"),
    timeoutMs: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
    text: z.string().optional().describe("Wait for text matching this regex"),
    exit: z.union([z.boolean(), z.enum(["any", "zero", "nonzero"]), z.number().int()]).optional()
      .describe("Wait for exit: true/nonzero, any, zero, or an exact integer code"),
    closed: z.boolean().optional().describe("Wait for pane to close"),
  },
  async execute(args, context) {
    await ensureInit()

    const pane = findPane(args.ref || args.paneId || "")
    if (!pane) throw new Error(`No tracked pane with ref/id '${args.ref || args.paneId}'`)

    const timeoutMs = args.timeoutMs ?? 30_000
    const textRegex = args.text ? new RegExp(args.text) : null
    const exitCondition = args.exit !== undefined && args.exit !== false ? parseExitCondition(args.exit) : undefined

    if (args.text && !pane.subscriptions.some((sub) => sub.type === "text_match" && sub.pattern === args.text)) {
      pane.subscriptions.push({ type: "text_match", pattern: args.text })
      await saveState()
    }

    if (textRegex) {
      const currentOutput = await execZellij(["action", "dump-screen", "--pane-id", pane.paneId, "--full"])
      const line = currentOutput.split(/\r?\n/).find((item) => textRegex.test(item))
      if (line) {
        return JSON.stringify(pushEvent(pane, {
          type: "text_match",
          timestamp: Date.now(),
          data: { paneId: pane.paneId, ref: pane.ref, pattern: args.text, line },
        }))
      }
    }

    const matchesNow = (): PaneEvent | undefined => {
      if (args.closed && pane.closed) {
        for (let index = pane.events.length - 1; index >= 0; index -= 1) {
          if (pane.events[index].type === "pane_closed") return pane.events[index]
        }
        return markClosed(pane)
      }
      if (exitCondition !== undefined && pane.exited && exitMatches(exitCondition, pane.exitCode)) {
        for (let index = pane.events.length - 1; index >= 0; index -= 1) {
          if (pane.events[index].type === "pane_exited") return pane.events[index]
        }
        return markExited(pane, pane.exitCode)
      }
      for (const ev of pane.events) {
        if (exitCondition !== undefined && ev.type === "pane_exited") {
          const data = ev.data as { exitCode?: number | null }
          if (exitMatches(exitCondition, data.exitCode ?? null)) return ev
        }
        if (args.closed && ev.type === "pane_closed") return ev
        if (textRegex && ev.type === "text_match") {
          const data = ev.data as { line?: string }
          if (data.line && textRegex.test(data.line)) return ev
        }
      }
      return undefined
    }

    const existing = matchesNow()
    if (existing) return JSON.stringify(existing)

    const deadline = Date.now() + timeoutMs
    const interval = Math.min(200, timeoutMs / 10)

    return new Promise<string>((resolve, reject) => {
      const check = setInterval(() => {
        const ev = matchesNow()
        if (ev) {
          clearInterval(check)
          resolve(JSON.stringify(ev))
          return
        }
        if (Date.now() >= deadline) {
          clearInterval(check)
          reject(new Error(`Timeout after ${timeoutMs}ms waiting for event`))
        }
      }, interval)

      context.abort.addEventListener("abort", () => {
        clearInterval(check)
        reject(new Error("Aborted"))
      })
    })
  },
})

const zellijStop = tool({
  description: "Stop the watcher and close a tracked pane.",
  args: {
    ref: z.string().optional().describe("Tracked pane ref"),
    paneId: z.string().optional().describe("Zellij pane ID"),
  },
  async execute(args) {
    await ensureInit()

    const pane = findPane(args.ref || args.paneId || "")
    if (!pane) throw new Error(`No tracked pane with ref/id '${args.ref || args.paneId}'`)

    await closePane(pane)
    await saveState()
    info("pane_stopped", "Stopped tracked zellij pane", {
      ref: pane.ref,
      paneId: pane.paneId,
    })

    return JSON.stringify({ ref: pane.ref, paneId: pane.paneId, closed: true })
  },
})

const zellijRestart = tool({
  description: "Stop a tracked pane and recreate it with the same command, options, and subscriptions.",
  args: {
    ref: z.string().describe("Tracked pane ref to restart"),
  },
  async execute(args) {
    await ensureInit()

    const pane = panes.get(args.ref)
    if (!pane) throw new Error(`No tracked pane with ref '${args.ref}'`)

    await closePane(pane)

    const newPaneId = await execZellij(buildNewPaneArgs(pane))

    pane.paneId = newPaneId
    pane.events = []
    pane.closed = false
    pane.exited = false
    pane.exitCode = null

    try {
      const match = (await listPanes()).find((p) => samePane(p, newPaneId))
      if (match && match.exited) {
        markExited(pane, typeof match.exit_status === "number" ? match.exit_status : null)
      }
    } catch {
      // non-fatal
    }

    await startWatcher(pane)
    await saveState()
    info("pane_restarted", "Restarted tracked zellij pane", {
      ref: pane.ref,
      paneId: pane.paneId,
      commandLength: pane.command.length,
    })

    return JSON.stringify({
      ref: pane.ref,
      paneId: pane.paneId,
      command: pane.command,
      subscriptions: pane.subscriptions.length,
      restarted: true,
    })
  },
})

const zellijList = tool({
  description: "List tracked panes, target session, and Zellij connectivity status.",
  args: {},
  async execute() {
    await ensureInit()

    const status = await getZellijStatus()
    const tracked = [...panes.values()].map((p) => ({
      ref: p.ref,
      paneId: p.paneId,
      command: p.command,
      closed: p.closed,
      exited: p.exited,
      exitCode: p.exitCode,
      events: p.events.length,
      subscriptions: p.subscriptions.length,
    }))
    return JSON.stringify({
      session: sessionName ?? null,
      connected: status.connected,
      livePanes: status.livePanes,
      error: status.error,
      tracked,
    }, null, 2)
  },
})

// Plugin entry

export const ZellijPlugin = async (
  _input: { directory: string },
  options?: PluginOptions,
) => {
  await ensureInit(options)

  return {
    tool: {
      zellij_spawn: zellijSpawn,
      zellij_read: zellijRead,
      zellij_events: zellijEvents,
      zellij_subscribe: zellijSubscribe,
      zellij_wait: zellijWait,
      zellij_stop: zellijStop,
      zellij_restart: zellijRestart,
      zellij_list: zellijList,
    },
  }
}

export default { id, server: ZellijPlugin }
