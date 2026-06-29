import fs from "node:fs"
import path from "node:path"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const id = "bun-command-rewrite"

const bunLockfiles = ["bun.lock", "bun.lockb"]

const findBunProjectRoot = (start: string) => {
  let current = path.resolve(start)

  while (true) {
    if (bunLockfiles.some((lockfile) => fs.existsSync(path.join(current, lockfile)))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

const splitLeadingEnv = (command: string) => {
  const match = command.match(
    /^(\s*(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'`;|&<>]+)\s+)*)?(.*)$/s,
  )

  return {
    prefix: match?.[1] ?? "",
    body: match?.[2] ?? command,
  }
}

const rewriteBody = (body: string) => {
  if (/^npm\s+ci(?:\s|$)/.test(body)) {
    return body.replace(/^npm\s+ci\b/, "bun install --frozen-lockfile")
  }

  if (/^npm\s+(?:install|i)(?:\s|$)/.test(body)) {
    return body.replace(/^npm\s+(?:install|i)\b/, "bun install")
  }

  if (/^npm\s+run(?:-script)?\s+/.test(body)) {
    return body.replace(/^npm\s+run(?:-script)?\b/, "bun run")
  }

  if (/^npm\s+(?:start|test)(?:\s|$)/.test(body)) {
    return body.replace(/^npm\s+(start|test)\b/, "bun run $1")
  }

  if (/^npm\s+exec(?:\s|$)/.test(body)) {
    return body.replace(/^npm\s+exec\b/, "bunx")
  }

  if (/^npm\s+create(?:\s|$)/.test(body)) {
    return body.replace(/^npm\s+create\b/, "bun create")
  }

  if (/^npx(?:\s|$)/.test(body)) {
    return body.replace(/^npx\b/, "bunx")
  }

  if (/^node\s+(?!-)/.test(body)) {
    return body.replace(/^node\b/, "bun")
  }

  return body
}

export const BunCommandRewritePlugin: Plugin = async () => ({
  "tool.execute.before": async (input, output) => {
    const tool = String(input?.tool ?? "").toLowerCase()
    if (tool !== "bash" && tool !== "shell") return

    const args = output?.args
    if (!args || typeof args !== "object") return

    const command = (args as Record<string, unknown>).command
    if (typeof command !== "string" || !command) return

    const workdir = (args as Record<string, unknown>).workdir
    const startDir = typeof workdir === "string" && workdir ? workdir : process.cwd()
    if (!findBunProjectRoot(startDir)) return

    const { prefix, body } = splitLeadingEnv(command)
    const rewrittenBody = rewriteBody(body)
    if (rewrittenBody === body) return

    ;(args as Record<string, unknown>).command = `${prefix}${rewrittenBody}`
  },
})

const plugin: PluginModule & { id: string } = {
  id,
  server: BunCommandRewritePlugin,
}

export default plugin
