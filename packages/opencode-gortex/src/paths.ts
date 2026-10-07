import path from "node:path"

type Repository = { name: string; path: string }

export function projectPaths(stdout: string, directory: string) {
  const repos: unknown = JSON.parse(stdout)
  if (!Array.isArray(repos) || !repos.every(repo =>
    typeof repo?.name === "string" && repo.name && typeof repo?.path === "string" && path.isAbsolute(repo.path))) {
    throw new Error("opencode-gortex: invalid repository list from gortex repos --json")
  }
  const repositories = repos as Repository[]
  const current = repositories.find(repo => path.relative(directory, repo.path) === "")
  if (!current) throw new Error("opencode-gortex: current project is missing from gortex repos --json")
  const prefix = current.name

  function qualify(value: unknown): unknown {
    if (typeof value !== "string" || !value) return value
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      repositories.some(repo => value.startsWith(`${repo.name}/`))) return value
    return `${prefix}/${value.replace(/^\.\//, "")}`
  }

  function selectors(value: unknown, batch = false) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    const input = value as Record<string, unknown>
    for (const key of ["path", "file", "file_path", "path_prefix", ...(batch ? ["source", "destination"] : [])]) {
      if (key in input) input[key] = qualify(input[key])
    }
    for (const key of ["paths", "files"]) {
      if (Array.isArray(input[key])) input[key] = input[key].map(qualify)
    }
  }

  return (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    const input = value as Record<string, unknown>
    const envelopes = [input, ...["target", "to", "source", "options", "arguments", "context"].map(key => input[key])]
    // Explicit scope/view selectors belong to the caller, not the opened project.
    if (input.view || envelopes.some(value => value && typeof value === "object" &&
      ["repo", "project", "workspace", "scope"].some(key => Boolean((value as Record<string, unknown>)[key])))) return
    for (const envelope of envelopes) selectors(envelope)
    if (Array.isArray(input.changes)) for (const change of input.changes) selectors(change, true)
  }
}
