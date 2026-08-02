import {
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import process from "node:process"

export const REPO = "pbakaus/impeccable"
export const REF = "main"
export const SKILL_PATH = ".agents/skills/impeccable"
export const REFERENCES_SUBDIR = "reference"
export const SKILL_FILENAME = "SKILL.md"

export const treeUrl = (repo = REPO, ref = REF) =>
  `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`

export const rawUrl = (
  upstream,
  {
    repo = REPO,
    ref = REF,
    skillPath = SKILL_PATH,
    referencesSubdir = REFERENCES_SUBDIR,
  } = {},
) =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${skillPath}/${referencesSubdir}/${upstream}`

export function filterImpeccableReferences(tree, options = {}) {
  const skillPath = options.skillPath ?? SKILL_PATH
  const referencesSubdir = options.referencesSubdir ?? REFERENCES_SUBDIR
  const skillFilename = options.skillFilename ?? SKILL_FILENAME

  if (!tree || tree.truncated === true) {
    throw new Error(
      `Tree response for ${REPO}@${REF} was truncated; cannot reliably discover all files.`,
    )
  }
  const refPrefix = `${skillPath}/${referencesSubdir}/`
  const files = []
  for (const entry of tree.tree ?? []) {
    if (!entry || entry.type !== "blob") continue
    // Vendored SKILL.md is rewritten by the plugin (no Bash), so it is NOT
    // synced from upstream — we ship our own.
    if (entry.path === `${skillPath}/${skillFilename}`) continue
    if (!entry.path.startsWith(refPrefix)) continue
    if (!entry.path.endsWith(".md")) continue
    const rel = entry.path.slice(refPrefix.length)
    if (rel.length === 0 || rel.includes("/")) continue
    files.push({ local: rel, upstream: rel })
  }
  files.sort((a, b) => a.local.localeCompare(b.local))
  return files
}

export function findStaleLocals(files, localNames) {
  const upstream = new Set(files.map((f) => f.local))
  return [...new Set(localNames)]
    .filter((name) => !upstream.has(name))
    .sort()
}

export function diffLines(prefix, local, upstream) {
  const localLines = local.split("\n")
  const upstreamLines = upstream.split("\n")
  const max = Math.max(localLines.length, upstreamLines.length)
  const out = []
  for (let i = 0; i < max; i += 1) {
    const l = localLines[i] ?? ""
    const u = upstreamLines[i] ?? ""
    if (l !== u) {
      out.push(`${prefix}  ${String(i + 1).padStart(4, " ")} - ${l}`)
      out.push(`${prefix}  ${String(i + 1).padStart(4, " ")} + ${u}`)
    }
  }
  return out.join("\n")
}

function resolveTargetDir(argv) {
  const fromArgs = argv.find((a) => a.startsWith("--dir="))
  if (fromArgs) return resolve(process.cwd(), fromArgs.slice("--dir=".length))
  return resolve(
    import.meta.dirname,
    "..",
    "references",
  )
}

async function discoverFiles() {
  const res = await fetch(treeUrl(), {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!res.ok) {
    throw new Error(
      `Failed to list ${REPO}@${REF} tree: ${res.status} ${res.statusText}`,
    )
  }
  const tree = await res.json()
  const files = filterImpeccableReferences(tree)
  if (files.length === 0) {
    throw new Error(
      `No reference files discovered at ${SKILL_PATH}/${REFERENCES_SUBDIR}/ in ${REPO}@${REF}.`,
    )
  }
  return files
}

async function fetchAll(files) {
  const results = new Map()
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
      console.log(`  fetched ${local} (${body.length} bytes)`)
    }),
  )
  return results
}

async function readLocal(files, targetDir) {
  const out = new Map()
  await Promise.all(
    files.map(async ({ local }) => {
      try {
        out.set(local, await readFile(join(targetDir, local), "utf8"))
      } catch (error) {
        if (error.code === "ENOENT") out.set(local, null)
        else throw error
      }
    }),
  )
  return out
}

async function listLocal(targetDir, skillFilename = SKILL_FILENAME) {
  try {
    return (await readdir(targetDir))
      .filter((name) => name.endsWith(".md"))
      .filter((name) => name !== skillFilename)
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

async function writeAll(files, targetDir) {
  await Promise.all(
    [...files.entries()].map(async ([name, body]) => {
      const target = join(targetDir, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body, "utf8")
    }),
  )
}

async function deleteStale(paths, targetDir) {
  await Promise.all(
    paths.map(async (name) => {
      await unlink(join(targetDir, name))
    }),
  )
}

function printUsage(targetDir) {
  console.log(
    [
      `Usage: node scripts/sync-impeccable-upstream.mjs [command]`,
      ``,
      `Commands:`,
      `  (default)  Discover ${SKILL_PATH}/${REFERENCES_SUBDIR}/*.md in ${REPO}@${REF}, write them to the package's references/, and remove any local *.md files no longer present upstream. SKILL.md is vendored locally so it is NOT synced.`,
      `  check      Same discovery, but compare against local copies and exit non-zero on missing, changed, or stale-extra files (no writes).`,
      `  help       Show this message.`,
      ``,
      `Discovery:  ${REPO}@${REF} git tree (recursive) -> flat *.md under ${SKILL_PATH}/${REFERENCES_SUBDIR}/.`,
      `  Renames and additions are picked up automatically. Removed upstream files are deleted locally.`,
      `Target:     ${targetDir}`,
    ].join("\n"),
  )
}

async function runSync(targetDir) {
  console.log(`Syncing ${REPO}@${REF}/${SKILL_PATH}/${REFERENCES_SUBDIR} -> ${targetDir}`)
  const files = await discoverFiles()
  console.log(`Discovered ${files.length} file(s):`)
  for (const f of files) console.log(`  - ${f.local}`)

  const fetched = await fetchAll(files)
  const local = await readLocal(files, targetDir)
  const localNames = await listLocal(targetDir)
  const staleLocals = findStaleLocals(files, localNames)

  const changes = []
  const newFiles = []
  for (const [path, body] of fetched) {
    const existing = local.get(path)
    if (existing === null) newFiles.push(path)
    else if (existing !== body) changes.push(path)
  }

  await writeAll(fetched, targetDir)
  if (staleLocals.length > 0) {
    await deleteStale(staleLocals, targetDir)
  }

  for (const path of newFiles) console.log(`  added   ${path}`)
  for (const path of changes) console.log(`  updated ${path}`)
  for (const path of staleLocals) console.log(`  removed ${path}`)

  if (newFiles.length === 0 && changes.length === 0 && staleLocals.length === 0) {
    console.log("No changes.")
  }
  return 0
}

async function runCheck(targetDir) {
  console.log(`Checking ${REPO}@${REF}/${SKILL_PATH}/${REFERENCES_SUBDIR} against ${targetDir}`)
  const files = await discoverFiles()
  const fetched = await fetchAll(files)
  const local = await readLocal(files, targetDir)
  const localNames = await listLocal(targetDir)
  const staleLocals = findStaleLocals(files, localNames)

  const diffs = []
  for (const [path, body] of fetched) {
    const existing = local.get(path)
    if (existing === null) diffs.push(`missing local file: ${path}`)
    else if (existing !== body) {
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
  console.error(`\nRun \`bun run sync\` in packages/opencode-impeccable to refresh.`)
  return 1
}

const argv = process.argv.slice(2)
const command = argv[0] ?? "sync"
const targetDir = resolveTargetDir(argv.slice(1))

switch (command) {
  case "sync":
    process.exit(await runSync(targetDir))
  case "check":
    process.exit(await runCheck(targetDir))
  case "help":
  case "--help":
  case "-h":
    printUsage(targetDir)
    process.exit(0)
  default:
    console.error(`Unknown command: ${command}\n`)
    printUsage(targetDir)
    process.exit(2)
}
