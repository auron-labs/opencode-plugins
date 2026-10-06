import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
const root = fileURLToPath(new URL("../", import.meta.url))
const temporary = mkdtempSync(path.join(tmpdir(), "bashkit-pack-"))
try {
  const archive = path.join(temporary, "package.tgz")
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", archive], { cwd: root })
  const versions = execFileSync("readelf", ["--version-info", path.join(root, "dist/runtime.node")], { encoding: "utf8" })
  for (const [, major, minor] of versions.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    assert.ok(Number(major) < 2 || (Number(major) === 2 && Number(minor) <= 34), "artifact requires newer glibc than documented 2.34 minimum")
  }
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
  for (const file of ["dist/index.js", "dist/index.d.ts", "dist/runtime.node", "README.md", "CHANGELOG.md"]) {
    assert.ok(files.includes(`package/${file}`), `missing consumer artifact: ${file}`)
  }
  assert.ok(!files.some(file => file.startsWith("package/native/") || file.startsWith("package/src/")))
  console.log("Package includes its prebuilt native runtime and plugin entrypoint")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
