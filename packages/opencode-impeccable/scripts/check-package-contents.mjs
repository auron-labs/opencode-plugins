import { execFileSync } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const PACKAGE_ROOT = resolve(import.meta.dirname, "..")

const REQUIRED = [
  "dist/index.js",
  "dist/index.d.ts",
  "references/SKILL.md",
  "upstream-lock.json",
  "vendor/impeccable/LICENSE",
  "vendor/impeccable/skill/agents/impeccable-asset-producer.md",
  "vendor/impeccable/skill/scripts/context.mjs",
  "vendor/impeccable/skill/scripts/hook.mjs",
  "vendor/impeccable/skill/scripts/live.mjs",
  "vendor/impeccable/cli/bin/cli.js",
  "vendor/impeccable/cli/bin/commands/ignores.mjs",
]

const PACKED_ROOTS = ["references", "vendor/impeccable"]

async function packPaths(root) {
  let output
  try {
    output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
    })
  } catch (error) {
    const detail = error.stderr ? `: ${error.stderr.trim()}` : ""
    throw new Error(`npm pack --dry-run failed${detail}`)
  }
  let data
  try {
    data = JSON.parse(output)
  } catch (error) {
    throw new Error(`npm pack --dry-run returned invalid JSON: ${error.message}`)
  }
  const entry = Array.isArray(data) ? data[0] : data[Object.keys(data)[0]]
  if (!entry || !Array.isArray(entry.files)) throw new Error("npm pack --dry-run returned no file list")
  return entry.files.map((file) => file.path)
}

async function listRegularFiles(root, subdir) {
  const out = []
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) out.push(relative(root, absolute).split("\\").join("/"))
    }
  }
  await walk(join(root, subdir))
  return out
}

export async function checkPackageContents(root = PACKAGE_ROOT) {
  const packed = new Set(await packPaths(root))
  const missing = REQUIRED.filter((path) => !packed.has(path))
  const dropped = []
  for (const subdir of PACKED_ROOTS) {
    for (const path of await listRegularFiles(root, subdir)) {
      if (!packed.has(path)) dropped.push(path)
    }
  }
  const problems = [...new Set([...missing, ...dropped])].sort()
  if (problems.length) {
    for (const path of problems) console.log(`missing ${path}`)
    return { ok: false, count: packed.size, problems }
  }
  return { ok: true, count: packed.size, problems }
}

export function isMainModule(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  if (!argvPath) return false
  return metaUrl === pathToFileURL(resolve(argvPath)).href
}

if (isMainModule()) {
  const rootArg = process.argv[2] === "--root" ? process.argv[3] : undefined
  try {
    const result = await checkPackageContents(rootArg)
    if (result.ok) console.log(`Package contents verified: ${result.count} files packed`)
    else process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
