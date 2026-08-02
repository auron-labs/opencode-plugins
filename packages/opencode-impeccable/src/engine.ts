import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type EngineResult = {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  parsed: unknown | null
}

export type EngineOptions = {
  cwd: string
  args: string[]
  json?: boolean
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export async function runEngine(binary: string, options: EngineOptions): Promise<EngineResult> {
  const { cwd, args, json, timeoutMs = 30_000, env = process.env } = options
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return {
      ok: true,
      code: 0,
      stdout,
      stderr,
      parsed: json ? parseJson(stdout) : null,
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: number | string
    }
    const stdout = typeof err.stdout === "string" ? err.stdout : ""
    const stderrText = typeof err.stderr === "string" ? err.stderr : ""
    const exitCode = typeof err.code === "number" ? err.code : null
    return {
      ok: false,
      code: exitCode,
      stdout,
      stderr: stderrText || err.message,
      parsed: json ? parseJson(stdout) : null,
    }
  }
}

function parseJson(stdout: string): unknown {
  if (!stdout.trim()) return null
  try {
    return JSON.parse(stdout)
  } catch {
    const envelopeMatch = stdout.match(/\{[\s\S]*\}/)
    if (envelopeMatch) {
      try {
        return JSON.parse(envelopeMatch[0])
      } catch {}
    }
    return null
  }
}

export function quoteForCmd(target: string): string {
  if (!/[^A-Za-z0-9_\-./:@]/.test(target)) return target
  return JSON.stringify(target)
}

export function joinArgs(args: string[]): string {
  return args.map(quoteForCmd).join(" ")
}
