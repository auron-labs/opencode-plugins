import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export type SessionMode = "plan" | "review" | "annotate" | "archive" | "goal-setup"

export type SessionInfo = {
  pid: number
  port: number
  url: string
  mode: SessionMode
  project: string
  startedAt: string
  label: string
}

export const getPlannotatorDataDir = () => {
  const configured = process.env.PLANNOTATOR_DATA_DIR?.trim()
  if (!configured) return join(homedir(), ".plannotator")
  if (configured === "~") return homedir()
  if (configured.startsWith("~/") || configured.startsWith("~\\")) return join(homedir(), configured.slice(2))
  return resolve(configured)
}

export const getSessionsDir = () => join(getPlannotatorDataDir(), "sessions")

export const getActivePlansDir = () => join(getPlannotatorDataDir(), "active")

export const isSessionInfo = (value: unknown): value is SessionInfo => {
  if (!value || typeof value !== "object") return false
  const session = value as Record<string, unknown>
  return (
    typeof session.pid === "number" &&
    typeof session.port === "number" &&
    typeof session.url === "string" &&
    typeof session.mode === "string" &&
    typeof session.project === "string" &&
    typeof session.startedAt === "string" &&
    typeof session.label === "string"
  )
}

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const sortNewestFirst = (sessions: SessionInfo[]) =>
  sessions.sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())

export const pickSession = (sessions: SessionInfo[], keys: string[]) => {
  const normalized = keys.map((value) => value.toLowerCase())
  return (
    sessions.find((session) => {
      const project = session.project.toLowerCase()
      const label = session.label.toLowerCase()
      return normalized.some((key) => project === key || label.includes(key))
    }) ?? sessions[0]
  )
}

export const parseSessions = async () => {
  try {
    const entries = await readdir(getSessionsDir(), { withFileTypes: true })
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            const content = await readFile(join(getSessionsDir(), entry.name), "utf8")
            const parsed = JSON.parse(content) as unknown
            if (!isSessionInfo(parsed) || !isAlive(parsed.pid)) return undefined
            return parsed
          } catch {
            return undefined
          }
        }),
    )
    return sortNewestFirst(sessions.filter((session): session is SessionInfo => Boolean(session)))
  } catch {
    return [] as SessionInfo[]
  }
}

export const parseActivePlans = async () => {
  try {
    const projects = await readdir(getActivePlansDir(), { withFileTypes: true })
    const plans: Array<SessionInfo | undefined> = await Promise.all(
      projects
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const planPath = join(getActivePlansDir(), entry.name, "_active-plan.md")
          try {
            const [planStat, content] = await Promise.all([stat(planPath), readFile(planPath, "utf8")])
            if (!content.trim()) return undefined
            return {
              pid: 0,
              port: 0,
              url: "",
              mode: "plan" as const,
              project: entry.name,
              startedAt: planStat.mtime.toISOString(),
              label: `active-${entry.name}`,
            }
          } catch {
            return undefined
          }
        }),
    )

    return sortNewestFirst(plans.filter((plan): plan is SessionInfo => plan !== undefined))
  } catch {
    return [] as SessionInfo[]
  }
}
