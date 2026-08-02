import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"

export const REFS_FILENAME = "SKILL.md"

export function refsDir(fileUrl: string | URL): string {
  return resolve(dirname(fileUrlFromString(fileUrl)), "..", "references")
}

export function skillPathFromRefs(refsDirAbs: string): string {
  return resolve(refsDirAbs, "..")
}

export function refsFile(fileUrl: string | URL, name: string): string {
  return resolve(refsDir(fileUrl), name)
}

export function fileUrlFromString(value: string | URL): string {
  if (value instanceof URL) return fileURLToPath(value)
  return value.startsWith("file://") ? fileURLToPath(value) : value
}

export function fileURLToPath(value: string | URL): string {
  return new URL(value instanceof URL ? value : `file://${value}`).pathname
}

export function projectRoot(directory: string): string {
  let current = resolve(directory)
  while (true) {
    if (hasRootMarker(current)) return current
    const parent = dirname(current)
    if (parent === current) return resolve(directory)
    current = parent
  }
}

const rootMarkers = [".impeccable", ".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"]

function hasRootMarker(directory: string): boolean {
  return rootMarkers.some((marker) => existsSync(resolve(directory, marker)))
}

export function impeccableDir(directory: string): string {
  return resolve(projectRoot(directory), ".impeccable")
}

export function resolveWorkspaceDirectory(directory: string): string {
  return resolve(directory)
}
