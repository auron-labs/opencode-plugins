import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export type ImpeccableRuntime = {
  directory: string
  worktree: string
  agentsDirAbs: string
  refsDirAbs: string
  scriptsDirAbs: string
  binary?: string
}

export type RuntimeResult = {
  code: number
  stdout: string
  stderr: string
}

export type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
  allowedExitCodes?: number[]
}

export class ImpeccableRuntimeError extends Error {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string

  constructor(message: string, result?: Partial<RuntimeResult> & { code?: number | null }) {
    super(message)
    this.name = "ImpeccableRuntimeError"
    this.code = result?.code ?? null
    this.stdout = result?.stdout ?? ""
    this.stderr = result?.stderr ?? ""
  }
}

function engineBinary(runtime: ImpeccableRuntime): string {
  if (runtime.binary) return runtime.binary
  const os = process.platform === "win32" ? "windows" : process.platform
  const packageName = `@impeccable/cli-${os}-${process.arch}`
  try {
    const manifest = createRequire(import.meta.url).resolve(`${packageName}/package.json`)
    return join(dirname(manifest), "bin", os === "windows" ? "impeccable.exe" : "impeccable")
  } catch {
    throw new ImpeccableRuntimeError(
      `Impeccable Rust engine is unavailable. Install optional dependency ${packageName}, or set the binary option / IMPECCABLE_BIN to a native engine executable.`,
    )
  }
}

export async function runEngineVerb(
  runtime: ImpeccableRuntime,
  verb: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RuntimeResult> {
  if (!/^[a-z][a-z0-9-]*$/.test(verb)) {
    throw new ImpeccableRuntimeError(`Invalid Impeccable engine verb: ${verb}`)
  }
  return runImpeccableCli(runtime, [verb, ...args], options)
}

export async function runImpeccableCli(
  runtime: ImpeccableRuntime,
  args: string[],
  options: RunOptions = {},
): Promise<RuntimeResult> {
  return runChecked(engineBinary(runtime), args, {
    ...options,
    cwd: options.cwd ?? runtime.worktree,
    env: {
      ...process.env,
      ...options.env,
      IMPECCABLE_SKILL_DIR: dirname(runtime.refsDirAbs),
      IMPECCABLE_SELF: join(runtime.scriptsDirAbs, "impeccable"),
    },
  })
}

export async function runHookScript(
  runtime: ImpeccableRuntime,
  event: Record<string, unknown>,
): Promise<RuntimeResult> {
  return runEngineVerb(runtime, "hook", [], {
    stdin: JSON.stringify(event),
    timeoutMs: 60_000,
    env: {
      ...process.env,
      // OpenCode has no Stop-hook result channel, so use the upstream GitHub
      // contract: it intentionally runs the full rule set on every edit.
      IMPECCABLE_HOOK_HARNESS: "github",
    },
  })
}

async function runChecked(
  executable: string,
  args: string[],
  options: RunOptions,
): Promise<RuntimeResult> {
  let result: RuntimeResult
  try {
    result = await runExecutable(executable, args, options)
  } catch (error) {
    if (error instanceof ImpeccableRuntimeError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ImpeccableRuntimeError(`Unable to launch Impeccable runtime: ${message}`)
  }
  const allowed = options.allowedExitCodes ?? [0]
  if (!allowed.includes(result.code)) {
    const details = result.stderr.trim() || result.stdout.trim() || "no diagnostic output"
    throw new ImpeccableRuntimeError(
      `Impeccable command failed with exit ${result.code}: ${details}`,
      result,
    )
  }
  return result
}

function runExecutable(executable: string, args: string[], options: RunOptions): Promise<RuntimeResult> {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const captureDir = mkdtempSync(join(tmpdir(), "opencode-impeccable-runtime-"))
    const stdinPath = join(captureDir, "stdin")
    const stdoutPath = join(captureDir, "stdout")
    const stderrPath = join(captureDir, "stderr")
    writeFileSync(stdinPath, options.stdin ?? "", "utf8")
    const stdinFd = openSync(stdinPath, "r")
    const stdoutFd = openSync(stdoutPath, "w")
    const stderrFd = openSync(stderrPath, "w")
    let closed = false
    let settled = false
    const closeDescriptors = () => {
      if (closed) return
      closed = true
      for (const fd of [stdinFd, stdoutFd, stderrFd]) {
        try { closeSync(fd) } catch {}
      }
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: [stdinFd, stdoutFd, stderrFd],
      windowsHide: true,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeDescriptors()
      rmSync(captureDir, { recursive: true, force: true })
      reject(error)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeDescriptors()
      const tooLarge = [stdoutPath, stderrPath].some((path) => {
        try { return statSync(path).size > MAX_OUTPUT_BYTES } catch { return false }
      })
      const result = {
        code: code ?? 1,
        stdout: readFileSync(stdoutPath, "utf8").slice(0, MAX_OUTPUT_BYTES),
        stderr: readFileSync(stderrPath, "utf8").slice(0, MAX_OUTPUT_BYTES),
      }
      rmSync(captureDir, { recursive: true, force: true })
      if (timedOut) {
        reject(new ImpeccableRuntimeError(
          `Impeccable command timed out after ${timeoutMs}ms.`,
          result,
        ))
        return
      }
      if (tooLarge) {
        reject(new ImpeccableRuntimeError(
          `Impeccable command exceeded the ${MAX_OUTPUT_BYTES} byte output limit.`,
          result,
        ))
        return
      }
      resolvePromise(result)
    })
  })
}

export function defaultRuntimePaths(packageRoot: string) {
  const vendorRoot = join(packageRoot, "vendor", "impeccable")
  return {
    agentsDirAbs: join(vendorRoot, "skill", "agents"),
    refsDirAbs: join(vendorRoot, "skill", "reference"),
    // The Rust engine resolves native references and browser assets here.
    scriptsDirAbs: join(vendorRoot, "skill", "scripts"),
  }
}
