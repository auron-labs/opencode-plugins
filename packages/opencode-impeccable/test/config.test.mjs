import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  appendIgnoreFile,
  appendIgnoreRule,
  appendIgnoreValue,
  loadConfig,
  loadLocalConfig,
  resetHookConfig,
  resolveHook,
  setHookEnabled,
} from "../dist/config.js"
import { impeccableDir } from "../dist/paths.js"

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "impeccable-config-"))
  const root = join(dir, "project")
  mkdirSync(join(root, ".git"), { recursive: true })
  return { dir, root }
}

test("resolveHook returns defaults for a fresh project", () => {
  const { root, dir } = makeWorkspace()
  try {
    const cfg = resolveHook(root)
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.quiet, false)
    assert.deepEqual(cfg.ignoreRules, [])
    assert.deepEqual(cfg.ignoreFiles, [])
    assert.deepEqual(cfg.ignoreValues, [])
    assert.deepEqual(cfg.extensions, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("setHookEnabled persists hook.enabled and records per-developer consent", () => {
  const { root, dir } = makeWorkspace()
  try {
    setHookEnabled(root, false)
    const shared = loadConfig(root)
    const local = loadLocalConfig(root)
    assert.equal(shared.hook.enabled, false)
    assert.equal(local.hook.consent, false)
    assert.ok(existsSync(join(impeccableDir(root), "config.json")))
    assert.ok(existsSync(join(impeccableDir(root), "config.local.json")))

    setHookEnabled(root, true)
    const sharedAfter = loadConfig(root)
    assert.equal(sharedAfter.hook.enabled, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("appendIgnoreValue writes shared vs local configs based on scope", () => {
  const { root, dir } = makeWorkspace()
  try {
    appendIgnoreValue(root, { rule: "overused-font", value: "Inter" }, "shared")
    appendIgnoreValue(root, { rule: "bounce-easing", value: "bounce-ball" }, "local")

    const shared = loadConfig(root)
    const local = loadLocalConfig(root)
    assert.equal(shared.detector.ignoreValues.length, 1)
    assert.equal(shared.detector.ignoreValues[0].rule, "overused-font")
    assert.equal(shared.detector.ignoreValues[0].value, "Inter")
    assert.equal(local.detector.ignoreValues.length, 1)
    assert.equal(local.detector.ignoreValues[0].rule, "bounce-easing")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("appendIgnoreRule + appendIgnoreFile append entries to shared config", () => {
  const { root, dir } = makeWorkspace()
  try {
    appendIgnoreRule(root, { rule: "overused-font", allValues: true, reason: "user request" })
    appendIgnoreFile(root, { path: "src/fixtures/Card.tsx" })

    const cfg = loadConfig(root)
    assert.equal(cfg.detector.ignoreRules.length, 1)
    assert.equal(cfg.detector.ignoreRules[0].allValues, true)
    assert.equal(cfg.detector.ignoreFiles.length, 1)
    assert.equal(cfg.detector.ignoreFiles[0].path, "src/fixtures/Card.tsx")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveHook merges shared and local hooks, and applies env overrides", () => {
  const { root, dir } = makeWorkspace()
  try {
    mkdirSync(join(root, ".impeccable"), { recursive: true })
    writeFileSync(join(root, ".impeccable/config.json"), JSON.stringify({ hook: { quiet: true } }))
    writeFileSync(join(root, ".impeccable/config.local.json"), JSON.stringify({ hook: { enabled: false } }))

    const original = process.env.IMPECCABLE_HOOK_DISABLED
    delete process.env.IMPECCABLE_HOOK_DISABLED
    try {
      const cfg = resolveHook(root)
      assert.equal(cfg.quiet, true)
      assert.equal(cfg.enabled, false)
    } finally {
      if (original !== undefined) process.env.IMPECCABLE_HOOK_DISABLED = original
    }

    process.env.IMPECCABLE_HOOK_DISABLED = "1"
    const overridden = resolveHook(root)
    assert.equal(overridden.enabled, false)
    process.env.IMPECCABLE_HOOK_DISABLED = original ?? ""
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resetHookConfig clears both config files", () => {
  const { root, dir } = makeWorkspace()
  try {
    setHookEnabled(root, false)
    assert.ok(readFileSync(join(impeccableDir(root), "config.json"), "utf8").length > 2)

    resetHookConfig(root)
    assert.equal(readFileSync(join(impeccableDir(root), "config.json"), "utf8").trim(), "{}")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})