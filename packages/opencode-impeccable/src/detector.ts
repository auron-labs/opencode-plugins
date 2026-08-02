import { runDetectorOnPaths, isDetectorCandidate } from "./tools.js"
import type { ImperfectableRuntime } from "./tools.js"
import type { EngineResult } from "./engine.js"
import { resolveHook } from "./config.js"

export type DetectorFinding = {
  rule: string
  message: string
  severity?: string
  file?: string
  line?: number
  value?: string
}

export type DetectorScanResult = {
  path: string
  ok: boolean
  findings: DetectorFinding[]
  raw: string
  error?: string
}

export type DetectorRunOptions = DetectorRunnerOptions

export type DetectorRunner = {
  scanPath(path: string): Promise<DetectorScanResult>
  scanPaths(paths: string[]): Promise<DetectorScanResult[]>
  collectFindings(paths: string[]): Promise<DetectorFinding[]>
}

const dedupeCache = new Map<string, string>()

export function buildDetectorRunner(
  runtime: ImperfectableRuntime,
  options: DetectorRunnerOptions = {},
): DetectorRunner {
  const hook = resolveHook(runtime.directory)

  async function scanPath(path: string): Promise<DetectorScanResult> {
    const result = await runDetectorOnPaths(runtime, [path])
    const findings = parseFindings(result)
    const summary: DetectorScanResult = {
      path,
      ok: result.ok,
      raw: result.stdout,
      findings,
    }
    if (!result.ok) summary.error = result.stderr || `exit ${result.code ?? "unknown"}`
    if (options.onFindings) options.onFindings(path, summary)
    return summary
  }

  async function scanPaths(paths: string[]): Promise<DetectorScanResult[]> {
    if (paths.length === 0) return []
    if (!hook.enabled) return []
    const result = await runDetectorOnPaths(runtime, paths)
    const byPath = new Map<string, DetectorFinding[]>()
    for (const finding of parseFindings(result)) {
      const key = finding.file ?? "(unknown)"
      const list = byPath.get(key) ?? (byPath.set(key, []).get(key)!)
      list.push(finding)
    }
    const summaries: DetectorScanResult[] = paths.map((path) => {
      const findings = byPath.get(path) ?? []
      const summary: DetectorScanResult = { path, ok: result.ok, findings, raw: result.stdout }
      if (!result.ok) summary.error = result.stderr || `exit ${result.code ?? "unknown"}`
      if (options.onFindings && findings.length > 0) options.onFindings(path, summary)
      return summary
    })
    return summaries
  }

  async function collectFindings(paths: string[]): Promise<DetectorFinding[]> {
    const summaries = await scanPaths(paths)
    return summaries.flatMap((summary) => summary.findings)
  }

  return { scanPath, scanPaths, collectFindings }
}

export type DetectorRunnerOptions = {
  onFindings?: (path: string, result: DetectorScanResult) => void
}

export function parseFindings(result: EngineResult): DetectorFinding[] {
  if (!result.ok && !result.stdout.trim()) return []
  const text = result.stdout.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as
      | { findings?: DetectorFinding[] }
      | DetectorFinding[]
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed.findings)) return parsed.findings
  } catch {}
  return [
    {
      rule: "detector-output",
      message: text.split("\n").slice(0, 8).join("\n"),
    },
  ]
}

export function filterFreshFindings(
  path: string,
  findings: DetectorFinding[],
): DetectorFinding[] {
  if (findings.length === 0) return findings
  const signature = serializeFindings(findings)
  const previous = dedupeCache.get(path)
  if (previous === signature) return []
  dedupeCache.set(path, signature)
  return findings
}

export function detectorCandidatesFromWrite(filePath: string): boolean {
  return isDetectorCandidate(filePath)
}

function serializeFindings(findings: DetectorFinding[]): string {
  return findings
    .map((finding) => [finding.rule, finding.message, finding.file ?? "", finding.line ?? ""].join("|"))
    .join("\n")
}
