import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pathModule from "node:path";

const root = pathModule.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(pathModule.join(tmpdir(), "pstack-pack-"));
try {
  const archive = pathModule.join(temporary, "package.tgz");
  execFileSync(
    "bun",
    ["pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"],
    {
      cwd: root,
      encoding: "utf-8",
    }
  );
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf-8" });
  const paths = new Set(
    listing
      .trim()
      .split("\n")
      .map((path) => path.replace(/^package\//u, ""))
  );
  const lock = JSON.parse(
    await readFile(pathModule.join(root, "upstream-lock.json"), "utf-8")
  );
  const compiled = await readdir(pathModule.join(root, "dist"));
  const expected = [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "upstream-lock.json",
    "dist/index.js",
    "dist/index.d.ts",
    ...Object.keys(lock.files).map((path) => `vendor/pstack/${path}`),
    ...compiled.map((path) => `dist/${path}`),
  ];
  assert.deepEqual(
    expected.filter((path) => !paths.has(path)),
    [],
    "Published package is missing runtime files"
  );
  assert.equal(
    [...paths].some(
      (path) =>
        path.startsWith("src/") ||
        path.startsWith("test/") ||
        path.includes("/scripts/")
    ),
    false,
    "Published package must not include source-only files or upstream executables"
  );
  console.log(
    `Verified ${paths.size} published files, including every pinned reference and compiled module.`
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}
