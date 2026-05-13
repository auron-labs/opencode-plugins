/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createSignal } from "solid-js"

const id = "gsd-status"
const STATE_RELATIVE_PATH = ".planning/STATE.md"
const ROADMAP_RELATIVE_PATH = ".planning/ROADMAP.md"
const POLL_MS = 5000

type ParsedState = {
  current?: string
  next?: string
  status?: string
  phase?: string
  stage?: string
  command?: string
}

const clean = (value: string) => value.trim().replace(/^[-*]\s+/, "").replace(/^['\"]|['\"]$/g, "")

const section = (markdown: string, heading: string, level: 2 | 3) => {
  const marker = level === 2 ? "##" : "###"
  const lines = markdown.split("\n")
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `${marker} ${heading}`.toLowerCase())
  if (start < 0) return [] as string[]

  const output: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) break
    output.push(line)
  }
  return output
}

const fromCurrentPosition = (markdown: string) => {
  const lines = section(markdown, "Current Position", 2)
  if (lines.length === 0) return undefined

  const phase = lines.find((line) => /^\s*Phase:\s*/i.test(line))?.replace(/^\s*Phase:\s*/i, "")
  const plan = lines.find((line) => /^\s*Plan:\s*/i.test(line))?.replace(/^\s*Plan:\s*/i, "")
  if (!phase && !plan) return undefined

  if (phase && plan) return `${clean(phase)} | ${clean(plan)}`
  return clean(phase ?? plan ?? "")
}

const fromCurrentFocus = (markdown: string) => {
  const match = markdown.match(/^\*\*Current focus:\*\*\s*(.+)$/im)
  return match?.[1] ? clean(match[1]) : undefined
}

const fromPendingTodos = (markdown: string) => {
  const lines = section(markdown, "Pending Todos", 3)
  if (lines.length === 0) return undefined

  const firstTodo = lines
    .map((line) => line.trim())
    .find((line) => /^[-*]\s+/.test(line) && !/^[-*]\s+none\.?$/i.test(line))

  return firstTodo ? clean(firstTodo) : undefined
}

const fromResumeLine = (markdown: string) => {
  const resume = markdown.match(/^\s*Resume file:\s*(.+)$/im)?.[1]
  if (resume && !/^none\.?$/i.test(resume.trim())) return clean(resume)

  const stopped = markdown.match(/^\s*Stopped at:\s*(.+)$/im)?.[1]
  if (stopped && !/^none\.?$/i.test(stopped.trim())) return clean(stopped)

  return undefined
}

const fromFrontmatter = (markdown: string, field: string) => {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return undefined
  const match = fm[1].match(new RegExp(`^${field}:\\s*(.+)$`, "im"))
  return match?.[1] ? clean(match[1]) : undefined
}

const fromField = (markdown: string, field: string) => {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const bold = markdown.match(new RegExp(`^\\*\\*${escaped}:\\*\\*\\s*(.+)$`, "im"))
  if (bold?.[1]) return clean(bold[1])
  const plain = markdown.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"))
  return plain?.[1] ? clean(plain[1]) : undefined
}

const fromPhaseLine = (markdown: string) => {
  const value = markdown.match(/^\s*Phase:\s*(.+)$/im)?.[1]
  if (!value) return undefined
  return clean(value)
}

const getPhaseNumber = (value?: string) => {
  if (!value) return undefined
  const match = value.match(/\b(\d+(?:\.\d+)?)\b/)
  return match?.[1]
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const toPhaseParts = (value: string) => value.split(".").map((part) => Number(part))

const comparePhase = (left: string, right: string) => {
  const a = toPhaseParts(left)
  const b = toPhaseParts(right)
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

const getNextPhaseFromRoadmap = async (projectRoot: string, currentPhase?: string): Promise<string | undefined> => {
  if (!currentPhase) return undefined

  try {
    const roadmap = await readFile(join(projectRoot, ROADMAP_RELATIVE_PATH), "utf8")
    const phaseNumbers = Array.from(roadmap.matchAll(/\bphase\s+(\d+(?:\.\d+)?)\b/gi))
      .map((match) => match[1])
      .filter((phase, index, all) => all.indexOf(phase) === index)
      .sort(comparePhase)

    return phaseNumbers.find((phase) => comparePhase(phase, currentPhase) > 0)
  } catch {
    return undefined
  }
}

const inferStage = (status: string) => {
  const normalized = status.toLowerCase()
  if (normalized.includes("ready to execute")) return "Ready to execute"
  if (normalized.includes("executing") || normalized.includes("in progress")) return "Executing"
  if (normalized.includes("ready to plan")) return "Ready to plan"
  if (normalized.includes("planning")) return "Planning"
  if (normalized.includes("discuss")) return "Discussing"
  if (normalized.includes("verif") || normalized.includes("phase complete")) return "Ready for verification"
  if (normalized.includes("paused") || normalized.includes("stopped")) return "Paused"
  if (normalized.includes("complete") || normalized.includes("done")) return "Completed"
  return clean(status)
}

const inferCommand = (status: string, phase?: string, markdown?: string) => {
  const normalized = status.toLowerCase()

  const stoppedAt = markdown?.match(/^\s*Stopped at:\s*(.+)$/im)?.[1]
  const nextPhase = stoppedAt?.match(/ready to plan phase\s+(\d+(?:\.\d+)?)/i)?.[1]
  if (nextPhase) return `/gsd-discuss-phase ${nextPhase}`

  if ((normalized.includes("ready to execute") || normalized.includes("executing") || normalized.includes("in progress")) && phase) {
    return `/gsd-execute-phase ${phase}`
  }

  if ((normalized.includes("ready to plan") || normalized.includes("planning")) && phase) {
    return `/gsd-plan-phase ${phase}`
  }

  if (normalized.includes("discuss") && phase) {
    return `/gsd-plan-phase ${phase}`
  }

  if ((normalized.includes("verif") || normalized.includes("phase complete")) && phase) {
    return `/gsd-next`
  }

  if ((normalized.includes("complete") || normalized.includes("done")) && phase) {
    return `/gsd-progress`
  }

  if ((normalized.includes("paused") || normalized.includes("stopped")) && phase) {
    return `/gsd-execute-phase ${phase}`
  }

  return undefined
}

type PhaseCounts = {
  plans: number
  summaries: number
  uats: number
}

const getPhaseCounts = async (projectRoot: string, phase?: string): Promise<PhaseCounts | undefined> => {
  if (!phase) return undefined

  const phasesPath = join(projectRoot, ".planning/phases")
  let phaseDirs: string[]

  try {
    const entries = await readdir(phasesPath, { withFileTypes: true })
    const phasePattern = new RegExp(`^0*${escapeRegex(phase)}(?:[^0-9]|$)`)
    phaseDirs = entries
      .filter((entry) => entry.isDirectory() && phasePattern.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return undefined
  }

  const phaseDir = phaseDirs[0]
  if (!phaseDir) return { plans: 0, summaries: 0, uats: 0 }

  try {
    const files = await readdir(join(phasesPath, phaseDir))
    return {
      plans: files.filter((file) => file.endsWith("-PLAN.md")).length,
      summaries: files.filter((file) => file.endsWith("-SUMMARY.md")).length,
      uats: files.filter((file) => file.endsWith("-UAT.md")).length,
    }
  } catch {
    return undefined
  }
}

const applyFilesystemRouting = async (projectRoot: string, parsed: ParsedState): Promise<ParsedState> => {
  const counts = await getPhaseCounts(projectRoot, parsed.phase)
  if (!counts || !parsed.phase) return parsed
  const nextPhase = await getNextPhaseFromRoadmap(projectRoot, parsed.phase)

  if (counts.plans === 0) {
    return {
      ...parsed,
      stage: "Discussing",
      command: `/gsd-discuss-phase ${parsed.phase}`,
    }
  }

  if (counts.summaries < counts.plans) {
    return {
      ...parsed,
      stage: "Executing",
      command: `/gsd-execute-phase ${parsed.phase}`,
    }
  }

  if (counts.plans > 0 && counts.summaries >= counts.plans && nextPhase) {
    return {
      ...parsed,
      stage: "Discussing",
      command: `/gsd-discuss-phase ${nextPhase}`,
    }
  }

  if (counts.plans > 0 && counts.summaries >= counts.plans && counts.uats > 0) {
    return {
      ...parsed,
      stage: "Completed",
      command: `/gsd-complete-milestone`,
    }
  }

  return parsed
}

const parseState = (markdown: string): ParsedState => {
  const status = fromField(markdown, "Status") ?? fromFrontmatter(markdown, "status")
  const phaseSource =
    fromField(markdown, "Current Phase") ?? fromFrontmatter(markdown, "current_phase") ?? fromPhaseLine(markdown)
  const phase = getPhaseNumber(phaseSource)

  const stage = status ? inferStage(status) : undefined
  const command = status ? inferCommand(status, phase, markdown) : undefined

  return {
    current: fromCurrentPosition(markdown) ?? fromCurrentFocus(markdown),
    next: fromPendingTodos(markdown) ?? fromResumeLine(markdown),
    status,
    phase,
    stage,
    command,
  }
}

const getProjectRoots = (api: TuiPluginApi) => {
  const roots = [api.state.path.worktree, api.state.path.directory, process.cwd()]
  const normalized = roots
    .map((value) => (value && value !== "/" ? value : undefined))
    .filter((value): value is string => Boolean(value))
  return Array.from(new Set(normalized))
}

const isTargetStatePath = (api: TuiPluginApi, file: string) => {
  const normalized = file.replace(/\\/g, "/")
  const fullPaths = getProjectRoots(api).map((root) => join(root, STATE_RELATIVE_PATH).replace(/\\/g, "/"))
  return (
    fullPaths.includes(normalized) ||
    normalized === STATE_RELATIVE_PATH ||
    normalized === `./${STATE_RELATIVE_PATH}` ||
    normalized.endsWith(`/${STATE_RELATIVE_PATH}`)
  )
}

const formatStatusText = (parsed: ParsedState) => {
  if (parsed.command) return parsed.command

  if (parsed.stage) return parsed.stage

  if (!parsed.current && !parsed.next) return undefined
  const current = parsed.current ?? "Unknown"
  const next = parsed.next ?? "n/a"
  return `${current} -> ${next}`
}

const stageToken = (stage?: string) => {
  if (!stage) return undefined
  const normalized = stage.toLowerCase()
  if (normalized.includes("verif")) return "VER"
  if (normalized.includes("discuss")) return "DISC"
  if (normalized.includes("plan")) return "PLAN"
  if (normalized.includes("execut")) return "EXE"
  if (normalized.includes("pause") || normalized.includes("stop")) return "HOLD"
  if (normalized.includes("complete") || normalized.includes("done")) return "DONE"
  return undefined
}

const stageColor = (theme: TuiPluginApi["theme"]["current"], stage?: string) => {
  if (!stage) return theme.textMuted
  const normalized = stage.toLowerCase()
  if (normalized.includes("pause") || normalized.includes("stop")) return theme.error
  if (normalized.includes("verif") || normalized.includes("complete") || normalized.includes("done")) return theme.success
  if (normalized.includes("execut")) return theme.warning
  return theme.info
}

const tui: TuiPlugin = async (api) => {
  const [statusText, setStatusText] = createSignal<string | undefined>(undefined)
  const [parsedState, setParsedState] = createSignal<ParsedState | undefined>(undefined)

  let lastStatePath = ""
  let lastStateContent = ""
  let refreshing = false

  const refresh = async () => {
    if (refreshing) return
    refreshing = true

    try {
      const statePaths = getProjectRoots(api).map((root) => ({
        root,
        statePath: join(root, STATE_RELATIVE_PATH),
      }))

      let selectedRoot: string | undefined
      let selectedPath: string | undefined
      let content: string | undefined

      for (const candidate of statePaths) {
        try {
          content = await readFile(candidate.statePath, "utf8")
          selectedRoot = candidate.root
          selectedPath = candidate.statePath
          break
        } catch {
          continue
        }
      }

      if (!selectedPath || content === undefined) {
        lastStatePath = ""
        lastStateContent = ""
        setParsedState(undefined)
        setStatusText(undefined)
        return
      }

      if (selectedPath === lastStatePath && content === lastStateContent) return

      lastStatePath = selectedPath
      lastStateContent = content

      const parsed = parseState(content)
      const routed = await applyFilesystemRouting(selectedRoot ?? process.cwd(), parsed)
      setParsedState(routed)
      setStatusText(formatStatusText(routed))
    } finally {
      refreshing = false
    }
  }

  await refresh()

  const offWatcher = api.event.on("file.watcher.updated", (event) => {
    if (!isTargetStatePath(api, event.properties.file)) return
    void refresh()
  })

  const intervalID = setInterval(() => {
    void refresh()
  }, POLL_MS)

  api.lifecycle.onDispose(() => {
    offWatcher()
    clearInterval(intervalID)
  })

  api.slots.register({
    order: 700,
    slots: {
      home_bottom() {
        const value = statusText()
        if (!value) return null

        const theme = api.theme.current
        const token = stageToken(parsedState()?.stage ?? parsedState()?.status)
        const color = stageColor(theme, parsedState()?.stage ?? parsedState()?.status)
        return (
          <box width="100%" maxWidth={75} alignItems="center" paddingTop={1} flexShrink={0}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>Next:</span>{" "}
              {token ? <span style={{ fg: color }}>[{token}]</span> : null}
              {token ? " " : ""}
              {value}
            </text>
          </box>
        )
      },
      session_prompt_right() {
        const value = statusText()
        if (!value) return null

        const theme = api.theme.current
        const token = stageToken(parsedState()?.stage ?? parsedState()?.status)
        const color = stageColor(theme, parsedState()?.stage ?? parsedState()?.status)
        return (
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>GSD:</span>{" "}
            {token ? <span style={{ fg: color }}>[{token}]</span> : null}
            {token ? " " : ""}
            {value}
          </text>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
