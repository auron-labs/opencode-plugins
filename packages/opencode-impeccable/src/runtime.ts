import { spawn } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, normalize, relative, resolve } from "node:path"

const MINIMUM_NODE = [22, 18, 0] as const
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export type ImpeccableRuntime = {
  directory: string
  worktree: string
  agentsDirAbs: string
  refsDirAbs: string
  scriptsDirAbs: string
  cliPathAbs: string
  nodePath: string
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

const nodeChecks = new Map<string, Promise<void>>()

export async function ensureNodeRuntime(nodePath: string): Promise<void> {
  const cached = nodeChecks.get(nodePath)
  if (cached) return cached
  const check = (async () => {
    const result = await runExecutable(nodePath, ["--version"], { timeoutMs: 10_000 })
    const match = result.stdout.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
    if (!match) {
      throw new ImpeccableRuntimeError(
        `Unable to parse the Node version reported by ${nodePath}: ${result.stdout.trim() || "(no output)"}`,
        result,
      )
    }
    const version = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (compareVersions(version, MINIMUM_NODE) < 0) {
      throw new ImpeccableRuntimeError(
        `Impeccable requires Node >= ${MINIMUM_NODE.join(".")}; ${nodePath} reports ${version.join(".")}.`,
        result,
      )
    }
  })()
  nodeChecks.set(nodePath, check)
  try {
    await check
  } catch (error) {
    nodeChecks.delete(nodePath)
    throw error
  }
}

export async function runRuntimeScript(
  runtime: ImpeccableRuntime,
  script: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RuntimeResult> {
  await ensureNodeRuntime(runtime.nodePath)
  const scriptPath = resolveBundledPath(runtime.scriptsDirAbs, script)
  if (!existsSync(scriptPath)) {
    throw new ImpeccableRuntimeError(`Bundled Impeccable script is missing: ${script}`)
  }
  return runChecked(runtime.nodePath, [scriptPath, ...args], {
    ...options,
    cwd: options.cwd ?? runtime.worktree,
  })
}

export async function runImpeccableCli(
  runtime: ImpeccableRuntime,
  args: string[],
  options: RunOptions = {},
): Promise<RuntimeResult> {
  await ensureNodeRuntime(runtime.nodePath)
  if (!existsSync(runtime.cliPathAbs)) {
    throw new ImpeccableRuntimeError("Bundled Impeccable CLI entrypoint is missing.")
  }
  return runChecked(runtime.nodePath, [runtime.cliPathAbs, ...args], {
    ...options,
    cwd: options.cwd ?? runtime.worktree,
  })
}

export async function runHookScript(
  runtime: ImpeccableRuntime,
  event: Record<string, unknown>,
): Promise<RuntimeResult> {
  return runRuntimeScript(runtime, "hook.mjs", [], {
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

function resolveBundledPath(root: string, value: string): string {
  if (isAbsolute(value)) throw new ImpeccableRuntimeError(`Bundled script path must be relative: ${value}`)
  const target = resolve(root, normalize(value))
  const rel = relative(resolve(root), target)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ImpeccableRuntimeError(`Bundled script path escapes the runtime directory: ${value}`)
  }
  return target
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

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

export function defaultRuntimePaths(packageRoot: string) {
  const vendorRoot = join(packageRoot, "vendor", "impeccable")
  return {
    agentsDirAbs: join(vendorRoot, "skill", "agents"),
    refsDirAbs: join(packageRoot, "references"),
    // Preserve the upstream skill/scripts layout. The hook resolves its
    // detector relative to this directory, so flattening it breaks detection.
    scriptsDirAbs: join(vendorRoot, "skill", "scripts"),
    cliPathAbs: join(vendorRoot, "cli", "bin", "cli.js"),
  }
}
