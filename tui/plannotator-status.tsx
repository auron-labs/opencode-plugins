/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { basename } from "node:path"
import { createSignal } from "solid-js"
import { parseActivePlans, parseSessions, pickSession, type SessionInfo } from "./plannotator-status-lib"

const id = "plannotator-status"
const POLL_MS = 2000

type StatusView = {
  token: string
  stage: string
  detail: string
  url?: string
}

const projectKeys = (api: TuiPluginApi) => {
  const roots = [api.state.path.worktree, api.state.path.directory, process.cwd()]
  return Array.from(
    new Set(
      roots.flatMap((value) => {
        if (!value) return [] as string[]
        const parts = value
          .split(/[\\/]/)
          .map((part: string) => part.trim().toLowerCase())
          .filter(Boolean)
        return [basename(value).trim().toLowerCase(), ...parts]
      }),
    ),
  )
}

const formatAge = (startedAt: string) => {
  const started = new Date(startedAt).getTime()
  if (!Number.isFinite(started)) return "now"
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}

const modeView = (session: SessionInfo): StatusView => {
  const age = formatAge(session.startedAt)
  const detail = session.pid === 0 ? `draft ${age}` : `waiting ${age}`
  if (session.mode === "plan") {
    return { token: "PLAN", stage: "Plan review", detail, url: session.url || undefined }
  }
  if (session.mode === "review") {
    return { token: "REV", stage: "Code review", detail: `open ${age}`, url: session.url }
  }
  if (session.mode === "annotate") {
    return { token: "NOTE", stage: "Annotating", detail: `open ${age}`, url: session.url }
  }
  if (session.mode === "goal-setup") {
    return { token: "SET", stage: "Goal setup", detail: `open ${age}`, url: session.url }
  }
  return { token: "ARC", stage: "Archive", detail: `open ${age}`, url: session.url }
}

const tokenColor = (theme: TuiPluginApi["theme"]["current"], token: string) => {
  if (token === "PLAN") return theme.info
  if (token === "REV") return theme.warning
  if (token === "NOTE") return theme.success
  return theme.textMuted
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const [status, setStatus] = createSignal<StatusView | undefined>(undefined)

  let refreshing = false

  const refresh = async () => {
    if (refreshing) return
    refreshing = true

    try {
      const sessions = await parseSessions()
      const candidates = sessions.length > 0 ? sessions : await parseActivePlans()
      if (candidates.length === 0) {
        setStatus(undefined)
        return
      }

      const session = pickSession(candidates, projectKeys(api))
      setStatus(session ? modeView(session) : undefined)
    } finally {
      refreshing = false
    }
  }

  await refresh()

  const intervalID = setInterval(() => {
    void refresh()
  }, POLL_MS)

  api.lifecycle.onDispose(() => {
    clearInterval(intervalID)
  })

  api.slots.register({
    order: 710,
    slots: {
      home_bottom() {
        const value = status()
        if (!value) return null

        const theme = api.theme.current
        return (
          <box width="100%" maxWidth={90} alignItems="center" paddingTop={1} flexShrink={0}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>Plannotator:</span>{" "}
              <span style={{ fg: tokenColor(theme, value.token) }}>[{value.token}]</span> {value.stage.toLowerCase()} {value.detail}
              {value.url ? ` at ${value.url}` : ""}
            </text>
          </box>
        )
      },
      session_prompt_right() {
        const value = status()
        if (!value) return null

        const theme = api.theme.current
        return (
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>PN:</span>{" "}
            <span style={{ fg: tokenColor(theme, value.token) }}>[{value.token}]</span> {value.stage.toLowerCase()} {value.detail}
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
