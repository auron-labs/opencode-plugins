import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { impeccableDir } from "./paths.js"

export type IgnoredRule = { rule: string; allValues?: boolean; reason?: string }
export type IgnoredValue = { rule: string; value: string; reason?: string; files?: string[] }
export type IgnoredFile = { path: string }

export type DetectorExtensions = Array<{ ext: string; engine?: "html" | "text" }>

export type HookConfig = {
  enabled?: boolean
  quiet?: boolean
  consent?: boolean
  perEditRules?: "tier1" | "all"
  extensions?: DetectorExtensions
}

export type DetectorConfig = {
  ignoreRules?: IgnoredRule[]
  ignoreFiles?: IgnoredFile[]
  ignoreValues?: IgnoredValue[]
  designSystem?: { enabled?: boolean }
}

export type ImpeccableConfig = {
  hook?: HookConfig
  detector?: DetectorConfig
  stalenessCheck?: boolean
}

export type ResolvedConfig = {
  enabled: boolean
  quiet: boolean
  perEditRules: "tier1" | "all"
  ignoreRules: IgnoredRule[]
  ignoreFiles: IgnoredFile[]
  ignoreValues: IgnoredValue[]
  extensions: DetectorExtensions
  designSystemEnabled: boolean
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  quiet: false,
  perEditRules: "tier1",
  ignoreRules: [],
  ignoreFiles: [],
  ignoreValues: [],
  extensions: [],
  designSystemEnabled: false,
}

export function configPath(directory: string): string {
  return join(impeccableDir(directory), "config.json")
}

export function localConfigPath(directory: string): string {
  return join(impeccableDir(directory), "config.local.json")
}

export function loadConfig(directory: string): ImpeccableConfig {
  return readConfigFile(configPath(directory))
}

export function loadLocalConfig(directory: string): ImpeccableConfig {
  return readConfigFile(localConfigPath(directory))
}

function readConfigFile(path: string): ImpeccableConfig {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ImpeccableConfig
  } catch {
    return {}
  }
}

export function writeConfig(directory: string, config: ImpeccableConfig): void {
  const path = configPath(directory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
}

export function writeLocalConfig(directory: string, config: ImpeccableConfig): void {
  const path = localConfigPath(directory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
}

export function resolveHook(directory: string): ResolvedConfig {
  const shared = loadConfig(directory)
  const local = loadLocalConfig(directory)
  const hook = { ...shared.hook, ...local.hook }
  const detector = { ...shared.detector, ...local.detector }
  const merged: ResolvedConfig = {
    enabled: hook.enabled ?? true,
    quiet: hook.quiet ?? false,
    perEditRules: hook.perEditRules ?? "tier1",
    ignoreRules: detector.ignoreRules ?? [],
    ignoreFiles: detector.ignoreFiles ?? [],
    ignoreValues: detector.ignoreValues ?? [],
    extensions: hook.extensions ?? [],
    designSystemEnabled: detector.designSystem?.enabled ?? false,
  }
  return applyEnvOverrides(merged)
}

function applyEnvOverrides(cfg: ResolvedConfig): ResolvedConfig {
  const disabled = process.env.IMPECCABLE_HOOK_DISABLED === "1"
  const quiet = process.env.IMPECCABLE_HOOK_QUIET === "1"
  return {
    ...cfg,
    enabled: disabled ? false : cfg.enabled,
    quiet: quiet ? true : cfg.quiet,
  }
}

export function setHookEnabled(directory: string, enabled: boolean): ResolvedConfig {
  const config = loadConfig(directory)
  config.hook = { ...config.hook, enabled }
  writeConfig(directory, config)
  // Record per-developer consent in the gitignored local file.
  const local = loadLocalConfig(directory)
  local.hook = { ...local.hook, consent: enabled }
  writeLocalConfig(directory, local)
  return resolveHook(directory)
}

export function appendIgnoreValue(
  directory: string,
  value: IgnoredValue,
  scope: "shared" | "local",
): ResolvedConfig {
  const path = scope === "local" ? localConfigPath(directory) : configPath(directory)
  const target = readConfigFile(path)
  const detector = target.detector ?? (target.detector = {})
  const list = detector.ignoreValues ?? (detector.ignoreValues = [])
  list.push(value)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(target, null, 2) + "\n")
  return resolveHook(directory)
}

export function appendIgnoreRule(
  directory: string,
  rule: IgnoredRule,
): ResolvedConfig {
  const config = loadConfig(directory)
  const detector = config.detector ?? (config.detector = {})
  const list = detector.ignoreRules ?? (detector.ignoreRules = [])
  list.push(rule)
  writeConfig(directory, config)
  return resolveHook(directory)
}

export function appendIgnoreFile(directory: string, file: IgnoredFile): ResolvedConfig {
  const config = loadConfig(directory)
  const detector = config.detector ?? (config.detector = {})
  const list = detector.ignoreFiles ?? (detector.ignoreFiles = [])
  list.push(file)
  writeConfig(directory, config)
  return resolveHook(directory)
}

export function resetHookConfig(directory: string): void {
  const root = impeccableDir(directory)
  mkdirSync(root, { recursive: true })
  for (const name of ["config.json", "config.local.json"]) {
    const path = join(root, name)
    if (existsSync(path)) {
      try {
        writeFileSync(path, "{}\n")
      } catch {}
    }
  }
}
