import { describe, expect, test } from "bun:test"
import { pickSession, type SessionInfo } from "./plannotator-status-lib"

describe("pickSession", () => {
  test("prefers current project match", () => {
    const sessions: SessionInfo[] = [
      {
        pid: 1,
        port: 9999,
        url: "http://localhost:9999",
        mode: "review",
        project: "other",
        startedAt: "2026-06-22T12:00:00.000Z",
        label: "review-other",
      },
      {
        pid: 2,
        port: 9998,
        url: "http://localhost:9998",
        mode: "plan",
        project: "pteropod",
        startedAt: "2026-06-22T11:00:00.000Z",
        label: "plan-pteropod",
      },
    ]

    expect(pickSession(sessions, ["pteropod"])?.pid).toBe(2)
  })

  test("matches on any project path segment", () => {
    const sessions: SessionInfo[] = [
      {
        pid: 0,
        port: 0,
        url: "",
        mode: "plan",
        project: "opencode-plugins",
        startedAt: "2026-06-22T11:00:00.000Z",
        label: "active-opencode-plugins",
      },
    ]

    expect(pickSession(sessions, ["pteropod", "opencode-plugins"])?.project).toBe("opencode-plugins")
  })

  test("falls back to newest session", () => {
    const sessions: SessionInfo[] = [
      {
        pid: 10,
        port: 9999,
        url: "http://localhost:9999",
        mode: "review",
        project: "other",
        startedAt: "2026-06-22T12:00:00.000Z",
        label: "review-other",
      },
      {
        pid: 11,
        port: 9998,
        url: "http://localhost:9998",
        mode: "plan",
        project: "another",
        startedAt: "2026-06-22T11:00:00.000Z",
        label: "plan-another",
      },
    ]

    expect(pickSession(sessions, ["pteropod"])?.pid).toBe(10)
  })
})
