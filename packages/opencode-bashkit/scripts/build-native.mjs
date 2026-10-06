import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "linux" || process.arch !== "x64" || !process.report.getReport().header.glibcVersionRuntime) {
  throw new Error("opencode-bashkit currently supports Linux x64 glibc only")
}
const root = fileURLToPath(new URL("../", import.meta.url))
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "native/target")
const build = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", "native/Cargo.toml"], {
  cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target },
})
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
mkdirSync(resolve(root, "dist"), { recursive: true })
copyFileSync(resolve(target, "release/libopencode_bashkit_native.so"), resolve(root, "dist/runtime.node"))
