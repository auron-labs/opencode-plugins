import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const REPO = "pbakaus/impeccable"
export const BRANCH = "main"
export const SKILL_PATH = "skill"
export const REFERENCES_SUBDIR = "reference"

const PACKAGE_ROOT = resolve(import.meta.dirname, "..")
const LOCK_PATH = join(PACKAGE_ROOT, "upstream-lock.json")
const MANAGED_ROOTS = [
  "references",
  "vendor/impeccable/skill/agents",
  "vendor/impeccable/skill/scripts",
  "vendor/impeccable/cli",
]

export const treeUrl = (ref, repo = REPO) =>
  `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`

export const commitUrl = (branch = BRANCH, repo = REPO) =>
  `https://api.github.com/repos/${repo}/commits/${branch}`

export const rawUrl = (path, ref, repo = REPO) =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${path}`

export function filterImpeccableFiles(tree) {
  if (!tree || tree.truncated === true) {
    throw new Error(`Tree response for ${REPO} was truncated; refusing to sync a partial runtime.`)
  }
  const files = []
  for (const entry of tree.tree ?? []) {
    if (!entry || entry.type !== "blob" || typeof entry.path !== "string") continue
    const local = localPathForUpstream(entry.path)
    if (local) files.push({ upstream: entry.path, local })
  }
  return files.sort((left, right) => left.local < right.local ? -1 : left.local > right.local ? 1 : 0)
}

export function localPathForUpstream(path) {
  if (path === "skill/SKILL.src.md") return "references/SKILL.md"
  if (path === "LICENSE") return "vendor/impeccable/LICENSE"
  if (path.startsWith("skill/reference/")) {
    return `references/${path.slice("skill/reference/".length)}`
  }
  if (path.startsWith("skill/agents/")) {
    return `vendor/impeccable/skill/agents/${path.slice("skill/agents/".length)}`
  }
  if (path.startsWith("skill/scripts/")) {
    return `vendor/impeccable/skill/scripts/${path.slice("skill/scripts/".length)}`
  }
  if (path.startsWith("cli/")) {
    return `vendor/impeccable/cli/${path.slice("cli/".length)}`
  }
  return null
}

export function findStaleLocals(files, localPaths) {
  const expected = new Set(files.map((file) => file.local))
  return [...new Set(localPaths)]
    .filter((path) => !expected.has(path))
    .sort()
}

export function diffLines(prefix, local, upstream) {
  const left = local.split("\n")
  const right = upstream.split("\n")
  const out = []
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? "") === (right[index] ?? "")) continue
    out.push(`${prefix}${String(index + 1).padStart(5, " ")} - ${left[index] ?? ""}`)
    out.push(`${prefix}${String(index + 1).padStart(5, " ")} + ${right[index] ?? ""}`)
  }
  return out.join("\n")
}

async function loadLock() {
  return JSON.parse(await readFile(LOCK_PATH, "utf8"))
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-impeccable-sync",
    },
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
  return response.json()
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "opencode-impeccable-sync" },
    redirect: "follow",
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
  return response.text()
}

async function resolveLatestLock(current) {
  const commit = await fetchJson(commitUrl())
  const sha = commit.sha
  const builtSkill = await fetchText(rawUrl(".agents/skills/impeccable/SKILL.md", sha))
  const version = builtSkill.match(/^version:\s*(.+)$/m)?.[1]?.trim()
  if (!sha || !version) throw new Error("Unable to resolve upstream commit or skill version")
  return {
    ...current,
    commit: sha,
    committedAt: commit.commit?.committer?.date ?? commit.commit?.author?.date ?? null,
    skillVersion: version,
  }
}

async function discoverFiles(ref) {
  const tree = await fetchJson(treeUrl(ref))
  const files = filterImpeccableFiles(tree)
  if (files.length < 20) {
    throw new Error(`Only ${files.length} managed files discovered at ${REPO}@${ref}; refusing partial sync.`)
  }
  return files
}

async function fetchFiles(files, ref) {
  const out = new Map()
  const queue = [...files]
  const workers = Array.from({ length: Math.min(12, queue.length) }, async () => {
    while (queue.length) {
      const file = queue.shift()
      out.set(file.local, await fetchText(rawUrl(file.upstream, ref)))
    }
  })
  await Promise.all(workers)
  return out
}

async function listManagedFiles() {
  const out = []
  for (const root of MANAGED_ROOTS) {
    const absolute = join(PACKAGE_ROOT, root)
    await walk(absolute, async (path) => out.push(relative(PACKAGE_ROOT, path).split("\\").join("/")))
  }
  const license = join(PACKAGE_ROOT, "vendor/impeccable/LICENSE")
  try {
    await readFile(license)
    out.push("vendor/impeccable/LICENSE")
  } catch {}
  return out
}

async function walk(directory, visit) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, visit)
    else if (entry.isFile()) await visit(path)
  }
}

async function readLocal(files) {
  const out = new Map()
  await Promise.all(files.map(async ({ local }) => {
    try {
      out.set(local, await readFile(join(PACKAGE_ROOT, local), "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") out.set(local, null)
      else throw error
    }
  }))
  return out
}

async function writeAll(contents) {
  await Promise.all([...contents].map(async ([local, body]) => {
    const target = join(PACKAGE_ROOT, local)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, "utf8")
  }))
}

async function prune(paths) {
  await Promise.all(paths.map((path) => rm(join(PACKAGE_ROOT, path), { force: true })))
}

function compare(files, upstream, local, stale) {
  const missing = []
  const changed = []
  for (const { local: path } of files) {
    const current = local.get(path)
    if (current === null) missing.push(path)
    else if (current !== upstream.get(path)) changed.push(path)
  }
  return { missing, changed, stale }
}

async function sync() {
  const current = await loadLock()
  const lock = await resolveLatestLock(current)
  const files = await discoverFiles(lock.commit)
  const upstream = await fetchFiles(files, lock.commit)
  const localPaths = await listManagedFiles()
  const stale = findStaleLocals(files, localPaths)
  const local = await readLocal(files)
  const report = compare(files, upstream, local, stale)
  await writeAll(upstream)
  await prune(stale)
  await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8")
  printReport(`Synced ${REPO}@${lock.commit}`, report)
}

async function check() {
  const lock = await loadLock()
  const files = await discoverFiles(lock.commit)
  const upstream = await fetchFiles(files, lock.commit)
  const localPaths = await listManagedFiles()
  const stale = findStaleLocals(files, localPaths)
  const local = await readLocal(files)
  const report = compare(files, upstream, local, stale)
  printReport(`Checked ${REPO}@${lock.commit}`, report)
  if (report.missing.length || report.changed.length || report.stale.length) process.exitCode = 1
}

function printReport(heading, report) {
  console.log(heading)
  for (const path of report.missing) console.log(`  missing ${path}`)
  for (const path of report.changed) console.log(`  changed ${path}`)
  for (const path of report.stale) console.log(`  stale   ${path}`)
  if (!report.missing.length && !report.changed.length && !report.stale.length) console.log("  up to date")
}

function usage() {
  console.log("Usage: node scripts/sync-impeccable-upstream.mjs [sync|check|help]")
  console.log("  sync   Resolve upstream main, vendor one coherent snapshot, and update upstream-lock.json")
  console.log("  check  Compare local assets with the commit already recorded in upstream-lock.json")
}

export function isMainModule(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  if (!argvPath) return false
  return metaUrl === pathToFileURL(resolve(argvPath)).href
}

if (isMainModule()) {
  const command = process.argv[2] ?? "sync"
  try {
    if (command === "sync") await sync()
    else if (command === "check") await check()
    else if (["help", "--help", "-h"].includes(command)) usage()
    else {
      usage()
      process.exitCode = 2
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
