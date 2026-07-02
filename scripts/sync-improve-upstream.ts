import {
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import process from "node:process"

import {
  REPO,
  REF,
  SKILL_PATH,
  diffLines,
  filterSkillFiles,
  findStaleLocals,
  rawUrl,
  treeUrl,
} from "./sync-improve-upstream.lib.mjs"

const TARGET_DIR = resolve(
  import.meta.dirname,
  "..",
  "packages",
  "opencode-improve",
  "references",
)

type DiscoveredFile = { local: string; upstream: string }
type FetchResult = { upstream: string; bytes: number; status: number }
type TreeResponse = {
  truncated: boolean
  tree: Array<{ path: string; type: string }>
}

async function discoverFiles(): Promise<DiscoveredFile[]> {
  const res = await fetch(treeUrl(), {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!res.ok) {
    throw new Error(
      `Failed to list ${REPO}@${REF} tree: ${res.status} ${res.statusText}`,
    )
  }
  const tree = (await res.json()) as TreeResponse
  const files = filterSkillFiles(tree)
  if (files.length === 0) {
    throw new Error(
      `No skill files discovered at ${SKILL_PATH}/ in ${REPO}@${REF} (expected at least ${SKILL_PATH}/SKILL.md).`,
    )
  }
  if (!files.some((f) => f.local === "SKILL.md")) {
    throw new Error(
      `Discovery in ${REPO}@${REF} did not find ${SKILL_PATH}/SKILL.md; refusing to delete local SKILL.md.`,
    )
  }
  return files
}

async function fetchAll(
  files: DiscoveredFile[],
): Promise<Map<string, string>> {
  const results = new Map<string, string>()
  const summary: FetchResult[] = []
  await Promise.all(
    files.map(async ({ local, upstream }) => {
      const res = await fetch(rawUrl(upstream), { redirect: "follow" })
      if (!res.ok) {
        throw new Error(
          `Failed to fetch ${upstream} from ${REPO}@${REF}: ${res.status} ${res.statusText}`,
        )
      }
      const body = await res.text()
      results.set(local, body)
      summary.push({ upstream, bytes: body.length, status: res.status })
    }),
  )
  for (const { upstream, bytes, status } of summary) {
    console.log(`  fetched ${upstream} (${bytes} bytes, HTTP ${status})`)
  }
  return results
}

async function readLocal(
  files: DiscoveredFile[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  await Promise.all(
    files.map(async ({ local }) => {
      try {
        out.set(local, await readFile(join(TARGET_DIR, local), "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          out.set(local, null)
        } else {
          throw error
        }
      }
    }),
  )
  return out
}

async function listLocal(): Promise<string[]> {
  try {
    return (await readdir(TARGET_DIR)).filter((name) => name.endsWith(".md"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function writeAll(files: Map<string, string>): Promise<void> {
  await Promise.all(
    [...files.entries()].map(async ([path, body]) => {
      const target = join(TARGET_DIR, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body, "utf8")
    }),
  )
}

async function deleteStale(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (name) => {
      await unlink(join(TARGET_DIR, name))
    }),
  )
}

function printUsage(): void {
  console.log(
    [
      `Usage: bun run scripts/sync-improve-upstream.ts [command]`,
      ``,
      `Commands:`,
      `  (default)  Discover ${SKILL_PATH} files in ${REPO}@${REF}, write them to packages/opencode-improve/references/, and remove any local *.md files no longer present upstream.`,
      `  check      Same discovery, but compare against local copies and exit non-zero on missing, changed, or stale-extra files (no writes).`,
      `  help       Show this message.`,
      ``,
      `Discovery:  ${REPO}@${REF} git tree (recursive) -> SKILL.md and references/*.md under ${SKILL_PATH}/.`,
      `  Renames and additions are picked up automatically. Removed upstream files are deleted locally.`,
      `Target:     ${TARGET_DIR}`,
    ].join("\n"),
  )
}

async function runSync(): Promise<number> {
  console.log(`Syncing ${REPO}@${REF}/${SKILL_PATH} -> ${TARGET_DIR}`)
  const files = await discoverFiles()
  console.log(`Discovered ${files.length} file(s):`)
  for (const f of files) console.log(`  - ${f.local} <- ${f.upstream}`)

  const fetched = await fetchAll(files)
  const local = await readLocal(files)
  const localNames = await listLocal()
  const staleLocals = findStaleLocals(files, localNames)

  const changes: string[] = []
  const newFiles: string[] = []
  for (const [path, body] of fetched) {
    const existing = local.get(path)
    if (existing === null) {
      newFiles.push(path)
    } else if (existing !== body) {
      changes.push(path)
    }
  }

  await writeAll(fetched)
  if (staleLocals.length > 0) {
    await deleteStale(staleLocals)
  }

  for (const path of newFiles) console.log(`  added   ${path}`)
  for (const path of changes) console.log(`  updated ${path}`)
  for (const path of staleLocals) console.log(`  removed ${path}`)

  if (
    newFiles.length === 0 &&
    changes.length === 0 &&
    staleLocals.length === 0
  ) {
    console.log("No changes.")
  }
  return 0
}

async function runCheck(): Promise<number> {
  console.log(`Checking ${REPO}@${REF}/${SKILL_PATH} against ${TARGET_DIR}`)
  const files = await discoverFiles()
  const fetched = await fetchAll(files)
  const local = await readLocal(files)
  const localNames = await listLocal()
  const staleLocals = findStaleLocals(files, localNames)

  const diffs: string[] = []
  for (const [path, body] of fetched) {
    const existing = local.get(path)
    if (existing === null) {
      diffs.push(`missing local file: ${path}`)
    } else if (existing !== body) {
      diffs.push(`differs: ${path}`)
      diffs.push(diffLines("    ", existing, body))
    }
  }
  for (const path of staleLocals) {
    diffs.push(`stale local file (not in upstream): ${path}`)
  }

  if (diffs.length === 0) {
    console.log("Up to date.")
    return 0
  }
  console.error("Local copies are out of date with upstream:")
  for (const line of diffs) console.error(line)
  console.error(`\nRun \`bun run sync:improve\` to refresh.`)
  return 1
}

const args = process.argv.slice(2)
const command = args[0] ?? "sync"

switch (command) {
  case "sync":
    process.exit(await runSync())
  case "check":
    process.exit(await runCheck())
  case "help":
  case "--help":
  case "-h":
    printUsage()
    process.exit(0)
  default:
    console.error(`Unknown command: ${command}\n`)
    printUsage()
    process.exit(2)
}
